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
 *   - update pb_accounts.status / effective_tier / cell (listing columns)
 *   - write pb_runs with counts {scored, parked, unclassified, overridden, ranked, errors}
 * A per-account failure is collected into errors and the run continues.
 *
 * ?preview=1 scores under the named (draft) rubric, writes NOTHING — no reads, no run — and
 * returns {diff: [{account_id, name, from_tier, to_tier, from_status, to_status}], counts}
 * against the current reads: the preview-before-activate pattern. A non-active rubric can only
 * be scored with preview=1; reads are the record and carry the active version only.
 *
 * The engine never reads a clock; as_of is this handler's clock (or body.as_of for a replay).
 * Deploy with verify_jwt = false: the bearer is our own token, not a Supabase JWT.
 */

import { serviceClient, insertBatches, selectAll, selectIn } from "../_shared/db.ts";
import { bearerOk, getSecret, SECRET_NOT_CONFIGURED } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { loadRubric } from "../_shared/rubric.ts";
import { errorMessage, isRec, json, queryParams, sha256Hex, toStr, truthyParam } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  buildReadRow,
  diffEntry,
  groupBy,
  listingPatch,
  scorecardJson,
  tallyScorecards,
  toResolveAccount,
} from "../_shared/score_pure.ts";
import type { CurrentRead, DiffEntry } from "../_shared/score_pure.ts";
import { grade } from "../_shared/core/engine.ts";
import { resolveFeatures } from "../_shared/ingest/resolve_features.ts";
import type { DealRow, FactRow, RegisterRow, SignalRow } from "../_shared/ingest/resolve_features.ts";
import type { ProspectScorecard } from "../_shared/core/prospect_types.ts";

const ACCOUNT_COLS = "id,key,name,relationship_type,roster_source,roster_certified,lineage,book";

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
    const deals = await selectIn(db, "pb_deals", "account_id", ids, "*");
    const overrides = await selectIn(db, "pb_register", "account_id", ids, "*");

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
      const current = await selectIn(db, "pb_current_reads", "account_id", ids, "account_id,effective_tier,status");
      currentBy = new Map();
      for (const r of current) {
        currentBy.set(String(r.account_id), {
          account_id: String(r.account_id),
          effective_tier: toStr(r.effective_tier),
          status: toStr(r.status),
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
  for (const a of accounts) {
    const id = String(a.id);
    try {
      const resolved = resolveFeatures({
        account: toResolveAccount(a),
        facts: factsBy.get(id) ?? [],
        signals: signalsBy.get(id) ?? [],
        deals: dealsBy.get(id) ?? [],
        override_rows: overridesBy.get(id) ?? [],
        as_of: asOf,
        rubric: rubric.spec,
      });
      const sc = grade(resolved.features, rubric.spec, { override: resolved.override });
      cards.push(sc);
      for (const n of resolved.notes) notes.push(`${sc.name}: ${n}`);
    } catch (e) {
      errors.push({ account_id: id, name: toStr(a.name) ?? "", error: errorMessage(e) });
    }
  }
  const counts = tallyScorecards(cards, errors.length);

  /* ---- preview: nothing written ---- */
  if (preview) {
    const diff: DiffEntry[] = cards
      .map((sc) => diffEntry(sc, currentBy.get(sc.account_id) ?? null))
      .sort((x, y) => Number(y.changed) - Number(x.changed) || x.name.localeCompare(y.name));
    return json({
      ok: errors.length === 0,
      preview: true,
      rubric_version: rubric.version,
      rubric_status: rubric.status,
      as_of: asOf,
      counts,
      changed: diff.filter((d) => d.changed).length,
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
  try {
    const readRows: Rec[] = [];
    for (const sc of cards) readRows.push(buildReadRow(sc, runId, await sha256Hex(scorecardJson(sc))));
    const ins = await insertBatches(db, "pb_reads", readRows);
    writeErrors.push(...ins.errors);

    for (const sc of cards) {
      const { error } = await db.from("pb_accounts").update(listingPatch(sc)).eq("id", sc.account_id);
      if (error) writeErrors.push(`pb_accounts ${sc.account_id}: ${error.message}`);
    }
  } catch (e) {
    writeErrors.push(errorMessage(e));
  }

  const allErrors: unknown[] = [...errors, ...writeErrors.map((m) => ({ error: m }))];
  const status = runStatus(cards.length, allErrors.length);
  try {
    await finishRun(db, runId, status, { ...counts, errors: allErrors.length, rubric_version: rubric.version, as_of: asOf }, allErrors);
  } catch (e) {
    writeErrors.push(errorMessage(e));
  }
  return json({
    ok: allErrors.length === 0,
    run_id: runId,
    status,
    rubric_version: rubric.version,
    as_of: asOf,
    counts,
    errors: allErrors,
    notes: notes.length > 200 ? [...notes.slice(0, 200), `… ${notes.length - 200} more`] : notes,
  }, allErrors.length === 0 ? 200 : 500);
});
