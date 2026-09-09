/**
 * pb-sync — bearer-token bulk ingest of packs (DESIGN.md §4f).
 *
 *   POST /functions/v1/pb-sync
 *   Authorization: Bearer <PB_SYNC_TOKEN>           (Vault, read through pb_secret())
 *   { run: {kind, source, triggered_by},
 *     accounts?, contacts?, facts?, signals?, deals?, calls?, identity_candidates?,
 *     rubric?: {version, spec, activate?} }
 *
 * Writes, in this order, in batches of 200:
 *   accounts             upsert on key
 *   contacts             insert
 *   facts                insert (append-only; entered_by defaults to system:<run.source>)
 *   signals              insert (append-only; type must be in the rubric catalog — else 400 with
 *                        the bad types; weight / lifespan_days / decays / expires_at filled from
 *                        the catalog when absent)
 *   deals                upsert on pipedrive_deal_id (close_date_push folded into close_date_pushes)
 *   calls                upsert on fathom_recording_id
 *   identity_candidates  insert
 *   rubric               upsert pb_rubric_versions (spec_sha256 over JSON.stringify(spec));
 *                        activate → every other version retired, this one active
 *
 * Rows in contacts / facts / signals may carry `account_key` (pb_accounts.key) instead of
 * `account_id`; keys are resolved after the accounts pack lands. Rows that cannot be placed
 * are refused and listed in `errors`, never guessed at.
 *
 * Returns {ok, run_id, wrote, errors, notes} and writes a pb_runs row. Refuses everything
 * (503) while PB_SYNC_TOKEN is unset — never defaults open.
 *
 * Deploy with verify_jwt = false: the bearer is our own token, not a Supabase JWT.
 */

import { serviceClient, insertBatches, upsertBatches, selectIn } from "../_shared/db.ts";
import { bearerOk, getSecret, SECRET_NOT_CONFIGURED } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { loadRubric } from "../_shared/rubric.ts";
import { errorMessage, json, sha256Hex, tally, toStr } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  accountKeys,
  prepareAccounts,
  prepareCalls,
  prepareCandidates,
  prepareContacts,
  prepareDeals,
  prepareFacts,
  prepareSignals,
  validateSyncBody,
  WROTE_KEYS,
} from "../_shared/sync_pure.ts";
import type { RubricUpsertRequest } from "../_shared/sync_pure.ts";

async function upsertRubric(db: DbLike, req: RubricUpsertRequest, triggeredBy: string): Promise<{ wrote: number; notes: string[] }> {
  const notes: string[] = [];
  const spec_sha256 = await sha256Hex(JSON.stringify(req.spec));
  const { data: existing, error: selErr } = await db.from("pb_rubric_versions").select("version,status").eq("version", req.version).maybeSingle();
  if (selErr) throw new Error(`pb_rubric_versions select: ${selErr.message}`);

  const now = new Date().toISOString();
  const row: Rec = {
    version: req.version,
    spec: req.spec,
    spec_sha256,
    status: existing ? existing.status : "draft",
  };
  if (req.activate) {
    row.status = "active";
    row.activated_by = triggeredBy;
    row.activated_at = now;
  }
  const { error: upErr } = await db.from("pb_rubric_versions").upsert(row, { onConflict: "version" });
  if (upErr) throw new Error(`pb_rubric_versions upsert: ${upErr.message}`);
  notes.push(`rubric ${req.version}: ${existing ? "updated" : "inserted"} (status ${row.status}, sha256 ${spec_sha256.slice(0, 12)}…)`);

  if (req.activate) {
    const { error: retErr } = await db
      .from("pb_rubric_versions")
      .update({ status: "retired" })
      .neq("version", req.version)
      .eq("status", "active");
    if (retErr) throw new Error(`pb_rubric_versions retire: ${retErr.message}`);
    notes.push(`rubric ${req.version} activated; every other active version retired`);
  }
  return { wrote: 1, notes };
}

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const v = validateSyncBody(raw);
  if (!v.ok) return json({ error: v.error }, 400);
  const { run, packs, rubric: rubricReq } = v.body;

  // Signals need the catalog before anything is written, so a bad type is a clean 400.
  let catalogRubric: Rec | null = null;
  if ((packs.signals ?? []).length > 0) {
    try {
      const r = await loadRubric(db, null);
      catalogRubric = r ? r.spec : null;
    } catch (e) {
      return json({ error: errorMessage(e) }, 500);
    }
    if (catalogRubric === null) {
      return json({ error: "no active rubric in pb_rubric_versions; signals cannot be typed — load the rubric first" }, 503);
    }
  }

  const wrote: Record<string, number> = tally(WROTE_KEYS, {});
  const errors: string[] = [];
  const notes: string[] = [];

  let runId: string;
  try {
    runId = await startRun(db, run.kind, run.source, run.triggered_by);
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  try {
    /* ---- accounts: upsert on key ---- */
    const acc = prepareAccounts(packs.accounts ?? []);
    errors.push(...acc.errors);
    notes.push(...acc.notes);
    if (acc.rows.length) {
      const r = await upsertBatches(db, "pb_accounts", acc.rows, "key");
      wrote.accounts += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- key → id for every account the packs name ---- */
    const keys = accountKeys(packs);
    const keyToId: Record<string, string> = {};
    if (keys.length) {
      const rows = await selectIn(db, "pb_accounts", "key", keys, "id,key");
      for (const r of rows) {
        const k = toStr(r.key);
        if (k !== null) keyToId[k] = String(r.id);
      }
    }

    /* ---- contacts: insert ---- */
    const con = prepareContacts(packs.contacts ?? [], keyToId);
    errors.push(...con.errors);
    notes.push(...con.notes);
    if (con.rows.length) {
      const r = await insertBatches(db, "pb_contacts", con.rows);
      wrote.contacts += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- facts: insert, append-only ---- */
    const fac = prepareFacts(packs.facts ?? [], run, keyToId);
    errors.push(...fac.errors);
    notes.push(...fac.notes);
    if (fac.rows.length) {
      const r = await insertBatches(db, "pb_facts", fac.rows);
      wrote.facts += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- signals: insert, append-only, typed by the catalog ---- */
    if ((packs.signals ?? []).length > 0 && catalogRubric !== null) {
      const sig = prepareSignals(packs.signals ?? [], run, catalogRubric, keyToId);
      if (sig.bad_types.length) {
        // A bad type is a caller error: refuse the whole request here so the collector fixes its map.
        const counts = { ...wrote, errors: errors.length + sig.errors.length };
        await finishRun(db, runId, "failed", counts, [...errors, ...sig.errors]);
        return json({ error: "signal types not in the rubric catalog", bad_types: sig.bad_types, run_id: runId, wrote, errors: [...errors, ...sig.errors] }, 400);
      }
      errors.push(...sig.errors);
      notes.push(...sig.notes);
      if (sig.rows.length) {
        const r = await insertBatches(db, "pb_signals", sig.rows);
        wrote.signals += r.wrote;
        errors.push(...r.errors);
      }
    }

    /* ---- deals: upsert on pipedrive_deal_id ---- */
    const dea = prepareDeals(packs.deals ?? []);
    errors.push(...dea.errors);
    notes.push(...dea.notes);
    if (dea.rows.length) {
      const r = await upsertBatches(db, "pb_deals", dea.rows, "pipedrive_deal_id");
      wrote.deals += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- calls: upsert on fathom_recording_id ---- */
    const cal = prepareCalls(packs.calls ?? []);
    errors.push(...cal.errors);
    notes.push(...cal.notes);
    if (cal.rows.length) {
      const r = await upsertBatches(db, "pb_calls", cal.rows, "fathom_recording_id");
      wrote.calls += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- identity candidates: insert ---- */
    const can = prepareCandidates(packs.identity_candidates ?? []);
    errors.push(...can.errors);
    notes.push(...can.notes);
    if (can.rows.length) {
      const r = await insertBatches(db, "pb_identity_candidates", can.rows);
      wrote.identity_candidates += r.wrote;
      errors.push(...r.errors);
    }

    /* ---- rubric version ---- */
    if (rubricReq) {
      try {
        const r = await upsertRubric(db, rubricReq, run.triggered_by);
        wrote.rubric += r.wrote;
        notes.push(...r.notes);
      } catch (e) {
        errors.push(errorMessage(e));
      }
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }

  const written = Object.values(wrote).reduce((a, b) => a + b, 0);
  const status = runStatus(written, errors.length);
  try {
    await finishRun(db, runId, status, { ...wrote, errors: errors.length, notes: notes.length }, errors);
  } catch (e) {
    errors.push(errorMessage(e));
  }
  return json({ ok: errors.length === 0, run_id: runId, status, wrote, errors, notes }, errors.length === 0 ? 200 : 500);
});
