/**
 * pb-score — score every account under the active rubric (DESIGN.md §4g).
 *
 *   POST /functions/v1/pb-score[?account=<uuid>][&rubric=<version>&preview=1]
 *   Authorization: Bearer <PB_SYNC_TOKEN>            (Vault; the same bearer pg_cron sends)
 *   body (optional): { triggered_by?, as_of? }
 *
 * Loads: the active pb_rubric_versions row (or ?rubric=<version>), every pb_accounts row with
 * book in (prospect, parked) (or the one ?account), current facts (pb_current_facts), signals
 * not yet expired, open non-CJ deals, and register overrides. Per account:
 * resolveFeatures → grade. Then, unless preview:
 *   - insert pb_reads (scorecard_sha256 over JSON.stringify(scorecard))
 *   - upsert pb_potential_snapshots, one per ranked account per day per estimator (DECISIONS §36)
 *   - update pb_accounts.status / effective_tier / cell (listing columns) where they changed,
 *     one call per patch (listingUpdates; RUNBOOK §15, 10 Nov 2026)
 *   - write pb_runs with counts {scored, parked, unclassified, overridden, ranked, errors,
 *     snapshots, listing_updated}
 * A per-account failure is collected into errors and the run continues. The answer is decided
 * after the run row is finished (scoreAnswer): if that last write fails, the response says so
 * with a 500, rather than ok: true over a row left at running.
 *
 * ?preview=1 scores under the named (draft) rubric, writes NOTHING — no reads, no run — and
 * returns {diff: [{account_id, name, from_tier, to_tier, from_status, to_status, from_rank,
 * to_rank, order_changed}], counts, changed, reordered} against the current reads: the
 * preview-before-activate pattern. Since 18 Sep the diff reports ORDER as well as tier — a rubric
 * that reorders the whole book without moving a tier previewed as "0 changed" before (DECISIONS
 * §10, §52). A non-active rubric can only be scored with preview=1; reads are the record and
 * carry the active version only.
 *
 * Also loads pb_engagement (recorded contact, DECISIONS §24) per account and hands it to the
 * resolver: from rubric 0.1.7 readiness reads it. It never touches the tier.
 *
 * The engine never reads a clock; as_of is this handler's clock (or body.as_of for a replay).
 * Deploy with verify_jwt = false: the bearer is our own token, not a Supabase JWT.
 */

import { serviceClient, insertBatches, selectAll, selectIn, upsertBatches } from "../_shared/db.ts";
import { bearerOk, getSecret, SECRET_NOT_CONFIGURED } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { loadRubric } from "../_shared/rubric.ts";
import { errorMessage, isRec, json, queryParams, sha256Hex, toStr, truthyParam } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  buildReadRow,
  buildSnapshotRow,
  diffEntry,
  groupBy,
  listingUpdates,
  rankDiff,
  scoreAnswer,
  scorecardJson,
  tallyScorecards,
  toListing,
  toResolveAccount,
} from "../_shared/score_pure.ts";
import type { CurrentRead, DiffEntry, Listing } from "../_shared/score_pure.ts";
import { fingerprint, grade } from "../_shared/core/engine.ts";
import { resolveFeatures } from "../_shared/ingest/resolve_features.ts";
import type { DealRow, EngagementRow, FactRow, RegisterRow, SignalRow } from "../_shared/ingest/resolve_features.ts";
import type { ProspectScorecard } from "../_shared/core/prospect_types.ts";

// status / effective_tier / cell are read back so the listing write can skip what has not moved.
const ACCOUNT_COLS = "id,key,name,relationship_type,roster_source,roster_certified,lineage,book,status,effective_tier,cell";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let db: DbLike;
  try {
    db = serviceClient();
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  let secret: string | null;
  try {
    secret = await getSecret(db, "PB_SYNC_TOKEN");
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
  if (secret === null) return json({ error: `PB_SYNC_TOKEN ${SECRET_NOT_CONFIGURED}` }, 503);
  if (!bearerOk(req, secret)) return json({ error: "unauthorized" }, 401);

  const params = queryParams(req.url);
  const onlyAccount = toStr(params.account);
  const rubricVersion = toStr(params.rubric);
  const preview = truthyParam(params.preview);

  let body: Rec = {};
  try {
    const text = await req.text();
    if (text.trim().length) {
      const parsed = JSON.parse(text);
      if (isRec(parsed)) body = parsed;
    }
  } catch {
    return json({ error: "body must be JSON when present" }, 400);
  }
  const triggeredBy = toStr(body.triggered_by) ?? "pb-score";
  const asOf = toStr(body.as_of) ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) return json({ error: `as_of ${JSON.stringify(asOf)} is not a date` }, 400);

  /* ---- rubric ---- */
  let rubric;
  try {
    rubric = await loadRubric(db, rubricVersion);
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
  if (rubric === null) {
    return rubricVersion === null
      ? json({ error: "no active rubric in pb_rubric_versions; refusing to score" }, 503)
      : json({ error: `rubric version '${rubricVersion}' not found` }, 404);
  }
  if (rubric.status !== "active" && !preview) {
    return json({ error: `rubric '${rubric.version}' is ${rubric.status}; a non-active rubric can only be scored with preview=1` }, 400);
  }

  /* ---- inputs ---- */
  let accounts: Rec[];
  let factsBy: Map<string, FactRow[]>;
  let signalsBy: Map<string, SignalRow[]>;
  let dealsBy: Map<string, DealRow[]>;
  let overridesBy: Map<string, RegisterRow[]>;
  let engagementBy: Map<string, EngagementRow> = new Map();
  let currentBy: Map<string, CurrentRead> = new Map();
  try {
    accounts = await selectAll(db, "pb_accounts", ACCOUNT_COLS, (q: DbLike) => {
      let qq = q.in("book", ["prospect", "parked"]).order("id");
      if (onlyAccount !== null) qq = qq.eq("id", onlyAccount);
      return qq;
    });
    const ids = accounts.map((a) => String(a.id));
    if (ids.length === 0) {
      return json({ ok: true, preview, rubric_version: rubric.version, counts: tallyScorecards([], 0), diff: [], note: onlyAccount ? "account not found or not scorable" : "no scorable accounts" });
    }

    const facts = await selectIn(db, "pb_current_facts", "account_id", ids, "*");
    const signals = await selectIn(db, "pb_signals", "account_id", ids, "*");
    // pb_deals is keyed on pipedrive_deal_id, not id — selectIn pages, and paging needs a
    // unique order column. Passing the wrong one is a loud 500, not a silent truncation.
    const deals = await selectIn(db, "pb_deals", "account_id", ids, "*", 100, "pipedrive_deal_id");
    const overrides = await selectIn(db, "pb_register", "account_id", ids, "*");
    // Recorded contact, one row per account (a view; account_id is its natural order column).
    const engagement = await selectIn(db, "pb_engagement", "account_id", ids, "account_id,engagement,days_since_engaged,last_engaged", 100, "account_id");
    engagementBy = new Map();
    for (const r of engagement) {
      const id = toStr(r.account_id);
      if (id !== null && !engagementBy.has(id)) engagementBy.set(id, r as unknown as EngagementRow);
    }

    factsBy = groupBy(facts as unknown as FactRow[], "account_id");
    // Expiry is judged against as_of by the resolver; pre-filter only what can never be live.
    const asOfMs = Date.parse(asOf);
    signalsBy = groupBy(
      (signals as unknown as SignalRow[]).filter((s) => {
        if (s.expires_at === null || s.expires_at === undefined) return true;
        const ms = Date.parse(String(s.expires_at));
        return !Number.isFinite(ms) || ms >= asOfMs;
      }),
      "account_id",
    );
    dealsBy = groupBy(
      (deals as unknown as DealRow[]).filter((d) => d.status === "open" && d.is_cj !== true),
      "account_id",
    );
    overridesBy = groupBy(
      (overrides as unknown as RegisterRow[]).filter((r) => r.kind === "override"),
      "account_id",
    );

    if (preview) {
      // distinct on (account_id), so account_id is unique here — and it is already selected.
      const current = await selectIn(db, "pb_current_reads", "account_id", ids, "account_id,effective_tier,status,confidence_grade,chase_rank_key:scorecard->chase_rank_key", 100, "account_id");
      currentBy = new Map();
      for (const r of current) {
        currentBy.set(String(r.account_id), {
          account_id: String(r.account_id),
          effective_tier: toStr(r.effective_tier),
          status: toStr(r.status),
          confidence_grade: toStr(r.confidence_grade),
          chase_rank_key: r.chase_rank_key ?? null,
        });
      }
    }
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  /* ---- score ---- */
  const cards: ProspectScorecard[] = [];
  const errors: Array<{ account_id: string; name: string; error: string }> = [];
  const notes: string[] = [];
  // Hashed once for the whole book, not once per account inside grade() (RUNBOOK §15): the same
  // value grade() would compute, from the same object, for a fraction of the CPU.
  const rubricFingerprint = fingerprint(rubric.spec);
  for (const a of accounts) {
    const id = String(a.id);
    try {
      const resolved = resolveFeatures({
        account: toResolveAccount(a),
        facts: factsBy.get(id) ?? [],
        signals: signalsBy.get(id) ?? [],
        deals: dealsBy.get(id) ?? [],
        override_rows: overridesBy.get(id) ?? [],
        engagement: engagementBy.get(id) ?? null,
        as_of: asOf,
        rubric: rubric.spec,
      });
      const sc = grade(resolved.features, rubric.spec, { override: resolved.override, confidence_override: resolved.confidence_override, rubric_fingerprint: rubricFingerprint });
      cards.push(sc);
      for (const n of resolved.notes) notes.push(`${sc.name}: ${n}`);
    } catch (e) {
      errors.push({ account_id: id, name: toStr(a.name) ?? "", error: errorMessage(e) });
    }
  }
  const counts = tallyScorecards(cards, errors.length);

  /* ---- preview: nothing written ---- */
  if (preview) {
    const ranks = rankDiff(cards, currentBy);
    const diff: DiffEntry[] = cards
      .map((sc) => diffEntry(sc, currentBy.get(sc.account_id) ?? null, ranks.get(sc.account_id) ?? null))
      .sort((x, y) => Number(y.changed) - Number(x.changed) || Number(y.order_changed) - Number(x.order_changed) || x.name.localeCompare(y.name));
    return json({
      ok: errors.length === 0,
      preview: true,
      rubric_version: rubric.version,
      rubric_status: rubric.status,
      as_of: asOf,
      counts,
      changed: diff.filter((d) => d.changed).length,
      reordered: diff.filter((d) => d.order_changed).length,
      diff,
      errors,
    });
  }

  /* ---- write: reads, listing columns, run ---- */
  let runId: string;
  try {
    runId = await startRun(db, "score", "pb-score", triggeredBy);
  } catch (e) {
    return json({ error: errorMessage(e), counts, errors }, 500);
  }
  const writeErrors: string[] = [];
  let snapshotsWritten = 0;
  let listingUpdated = 0;
  try {
    const readRows: Rec[] = [];
    for (const sc of cards) readRows.push(buildReadRow(sc, runId, await sha256Hex(scorecardJson(sc))));
    const ins = await insertBatches(db, "pb_reads", readRows);
    writeErrors.push(...ins.errors);

    // The calibration loop starts here (R4): what the book claimed today, kept so it can be
    // scored against actuals later. A re-run the same day replaces the day's row, never doubles it.
    // Written before the listing: on ten of the eleven killed nights (RUNBOOK §15) the kill came in
    // the old per-account listing loop and no snapshot landed. The order alone is no guarantee —
    // on 29 Oct the kill came inside this upsert — the small listing step below is what protects it.
    const snapRows: Rec[] = [];
    for (const sc of cards) {
      const row = buildSnapshotRow(sc, rubric.spec, runId);
      if (row) snapRows.push(row);
    }
    const snaps = await upsertBatches(db, "pb_potential_snapshots", snapRows, "account_id,taken_at,estimator");
    writeErrors.push(...snaps.errors);
    snapshotsWritten = snaps.wrote;
    notes.push(`potential snapshots: ${snaps.wrote} written for ${snapRows.length} ranked of ${cards.length} scored`);

    // Only the accounts whose listing moved, one call per patch — never one call per account.
    const listingNow = new Map<string, Listing>();
    for (const a of accounts) listingNow.set(String(a.id), toListing(a));
    const updates = listingUpdates(cards, listingNow);
    for (const u of updates) {
      const { error } = await db.from("pb_accounts").update(u.patch).in("id", u.ids);
      if (error) writeErrors.push(`pb_accounts listing (${u.ids.length} accounts): ${error.message}`);
      else listingUpdated += u.ids.length;
    }
    notes.push(`listing: ${listingUpdated} of ${cards.length} accounts changed, written in ${updates.length} call(s)`);
  } catch (e) {
    writeErrors.push(errorMessage(e));
  }

  const allErrors: unknown[] = [...errors, ...writeErrors.map((m) => ({ error: m }))];
  const status = runStatus(cards.length, allErrors.length);
  // snapshots and listing_updated go into counts, not only notes: the response truncates notes
  // past 200 and pb_runs is the record. The response carries them too, for the night pb_runs can't.
  const runCounts = { ...counts, snapshots: snapshotsWritten, listing_updated: listingUpdated };
  let finishError: string | null = null;
  try {
    await finishRun(db, runId, status, { ...runCounts, errors: allErrors.length, rubric_version: rubric.version, as_of: asOf }, allErrors);
  } catch (e) {
    finishError = errorMessage(e);
  }
  // Decided after finishRun, so a run row that could not be closed is a 500, never ok: true.
  const answer = scoreAnswer(cards.length, allErrors, finishError);
  return json({
    ok: answer.ok,
    run_id: runId,
    status: answer.status,
    rubric_version: rubric.version,
    as_of: asOf,
    counts: runCounts,
    errors: answer.errors,
    notes: notes.length > 200 ? [...notes.slice(0, 200), `… ${notes.length - 200} more`] : notes,
  }, answer.http);
});
