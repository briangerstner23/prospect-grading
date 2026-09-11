/**
 * pb-notes — the nightly Pipedrive notes sweep.
 *
 *   POST /functions/v1/pb-notes
 *   Authorization: Bearer <PB_SYNC_TOKEN>        (Vault, read through pb_secret())
 *   { as_of?: "YYYY-MM-DD", max_notes?: number, since?: string|null, dry_run?: boolean }
 *
 * Sales writes the best data in the business into Pipedrive notes. This function reads them.
 *
 *   1. Where did we get to        pb_source_watermarks('pipedrive_note').last_seen_at
 *   2. Pull                       Pipedrive /v1/notes, newest-touched first, until past it
 *   3. Plan                       planSweep — known org, real prose, not already read, capped
 *   4. Read                       one model call per note, asking for claims with quotes
 *   5. Verify                     verifyClaims — whitelist, and THE QUOTE MUST BE IN THE NOTE
 *   6. Decide                     mapPipedriveNotes — quote-backed and high → fact, else queue
 *   7. Write                      pb_facts, pb_fact_candidates (fingerprint dedupes), watermark
 *
 * Nothing here decides what is true. Steps 5 and 6 are the whole safety story: a sentence the
 * model invented is stripped, which drops the claim to the review queue, so an unattended run
 * can add work for a person but can never put an unsourced claim into the book. And a fact a
 * PERSON entered is never overwritten — see pipedrive_notes.ts.
 *
 * Costs one model call per unread note with real prose in it. A re-run over the same notes
 * costs nothing: the watermark skips them, and the fingerprint would refuse them anyway.
 *
 * Deploy with verify_jwt = false: the bearer is our own token, which pg_cron sends.
 */

import { serviceClient, insertBatches, selectAll } from "../_shared/db.ts";
import { bearerOk, getSecret, SECRET_NOT_CONFIGURED } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { errorMessage, isRec, json, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  EXTRACTOR_VERSION,
  extractionPrompt,
  planSweep,
  verifyClaims,
} from "../_shared/ingest/notes_sweep.ts";
import type { PlannedNote } from "../_shared/ingest/notes_sweep.ts";
import { mapPipedriveNotes } from "../_shared/ingest/pipedrive_notes.ts";
import type { ExistingFact, NoteExtraction, PipedriveNote } from "../_shared/ingest/pipedrive_notes.ts";

const SOURCE = "pipedrive_note";
const MODEL = "claude-haiku-4-5-20251001";
const PIPEDRIVE_PAGE = 100;
/** Pipedrive paging stops here even if the watermark is never reached — a first run is finite. */
const MAX_PAGES = 40;

interface Body {
  as_of?: unknown;
  max_notes?: unknown;
  since?: unknown;
  dry_run?: unknown;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Pipedrive
 * ------------------------------------------------------------------ */

/**
 * Notes touched since `since`, newest first, stopping as soon as we are past it. Pipedrive has
 * no "updated since" filter on notes, so the sort order is the filter.
 */
async function pullNotes(token: string, since: string | null, notes: string[]): Promise<PipedriveNote[]> {
  const out: PipedriveNote[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.pipedrive.com/v1/notes?api_token=${encodeURIComponent(token)}` +
      `&start=${page * PIPEDRIVE_PAGE}&limit=${PIPEDRIVE_PAGE}&sort=${encodeURIComponent("update_time DESC")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pipedrive /notes returned ${res.status}`);
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length === 0) break;

    let pastWatermark = false;
    for (const row of data) {
      if (!isRec(row)) continue;
      const touched = String(row.update_time ?? row.add_time ?? "");
      if (since !== null && touched !== "" && touched <= since) { pastWatermark = true; continue; }
      out.push({
        id: row.id as number,
        org_id: (row.org_id ?? null) as number | null,
        content: String(row.content ?? ""),
        add_time: String(row.add_time ?? ""),
        update_time: row.update_time == null ? null : String(row.update_time),
        user_name: isRec(row.user) ? String((row.user as Rec).name ?? "") || null : null,
      });
    }
    if (pastWatermark) break;
    if (!body?.additional_data?.pagination?.more_items_in_collection) break;
    if (page === MAX_PAGES - 1) notes.push(`Stopped after ${MAX_PAGES} Pipedrive pages; run again to continue.`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the extractor
 * ------------------------------------------------------------------ */

/** One note, one model call. Returns whatever came back; verifyClaims decides what it is worth. */
async function readNote(apiKey: string, planned: PlannedNote): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0,
      system: extractionPrompt(),
      messages: [{ role: "user", content: `<note>\n${planned.text}\n</note>` }],
    }),
  });
  if (!res.ok) throw new Error(`extractor returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = Array.isArray(body?.content)
    ? body.content.map((b: Rec) => (b?.type === "text" ? String(b.text ?? "") : "")).join("")
    : "";
  // The model is asked for JSON; take the outermost object and refuse anything else.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = safeJsonParse(text.slice(start, end + 1));
  return parsed.ok ? parsed.value : null;
}

/* ------------------------------------------------------------------ *
 * the handler
 * ------------------------------------------------------------------ */

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const db: DbLike = serviceClient();
  const syncToken = await getSecret(db, "PB_SYNC_TOKEN");
  if (syncToken === null) return json({ ok: false, error: SECRET_NOT_CONFIGURED }, 503);
  if (!bearerOk(req, syncToken)) return json({ ok: false, error: "unauthorized" }, 401);

  let body: Body = {};
  const raw = await req.text();
  if (raw.trim() !== "") {
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) return json({ ok: false, error: `body is not JSON: ${parsed.error}` }, 400);
    if (isRec(parsed.value)) body = parsed.value as Body;
  }

  const pipedriveToken = await getSecret(db, "PB_PIPEDRIVE_API_TOKEN");
  if (pipedriveToken === null) {
    return json({ ok: false, error: "PB_PIPEDRIVE_API_TOKEN is not in Vault; nothing to pull with" }, 503);
  }
  const apiKey = await getSecret(db, "PB_ANTHROPIC_API_KEY");
  if (apiKey === null) {
    return json({ ok: false, error: "PB_ANTHROPIC_API_KEY is not in Vault; notes cannot be read" }, 503);
  }

  const as_of = typeof body.as_of === "string" ? body.as_of : today();
  const max_notes = typeof body.max_notes === "number" && body.max_notes > 0 ? Math.floor(body.max_notes) : 250;
  const dry_run = body.dry_run === true;
  const runId = await startRun(db, "ingest", SOURCE, dry_run ? "pb-notes (dry run)" : "pb-notes");
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const add = (c: Record<string, number>) => {
    for (const [k, v] of Object.entries(c)) counters[k] = (counters[k] ?? 0) + v;
  };

  try {
    const marks = await selectAll(db, "pb_source_watermarks", "source,last_seen_at", (q) => q.eq("source", SOURCE));
    const stored = marks.length > 0 ? (marks[0].last_seen_at as string | null) : null;
    const since = body.since === null ? null : typeof body.since === "string" ? body.since : stored;

    const accounts = await selectAll(db, "pb_accounts", "id,pipedrive_org_id");
    const accountByOrg: Record<string, string> = {};
    for (const a of accounts) {
      if (a.pipedrive_org_id != null) accountByOrg[String(a.pipedrive_org_id)] = String(a.id);
    }

    const pulled = await pullNotes(pipedriveToken, since, notes);
    const plan = planSweep({ notes: pulled, accountByOrg, since, as_of, max_notes });
    notes.push(...plan.notes);
    add(plan.counters);
    counters.notes_pulled = pulled.length;
    counters.notes_read = plan.read.length;

    // Group by account so mapPipedriveNotes sees every note for an account at once.
    const byAccount = new Map<string, PlannedNote[]>();
    for (const p of plan.read) {
      const list = byAccount.get(p.account_id) ?? [];
      list.push(p);
      byAccount.set(p.account_id, list);
    }

    const factRows: Rec[] = [];
    const candidateRows: Rec[] = [];

    for (const [account_id, planned] of byAccount) {
      const extractions: NoteExtraction[] = [];
      for (const p of planned) {
        let response: unknown = null;
        try {
          response = await readNote(apiKey, p);
        } catch (e) {
          notes.push(`Note ${p.note.id}: ${errorMessage(e)}; left for the next run.`);
          counters.extractor_failed = (counters.extractor_failed ?? 0) + 1;
          continue;
        }
        const v = verifyClaims(p, response);
        notes.push(...v.notes);
        add(v.counters);
        if (v.extraction.claims.length > 0) extractions.push(v.extraction);
      }
      if (extractions.length === 0) continue;

      const existing = await selectAll(
        db,
        "pb_current_facts",
        "key,value,evidence_label,source,observed_at,entered_by",
        (q) => q.eq("account_id", account_id),
      );
      const held: ExistingFact[] = existing.map((f) => ({
        key: String(f.key),
        value: f.value,
        evidence_label: String(f.evidence_label) as ExistingFact["evidence_label"],
        source: String(f.source),
        observed_at: (f.observed_at as string | null) ?? null,
        entered_by: (f.entered_by as string | null) ?? null,
      }));

      const mapped = mapPipedriveNotes({
        account_id,
        notes: planned.map((p) => p.note),
        extractions,
        existing: held,
        extractor: EXTRACTOR_VERSION,
        as_of,
      });
      notes.push(...mapped.notes);
      add(mapped.counters);

      for (const f of mapped.facts) {
        factRows.push({
          account_id: f.account_id,
          key: f.key,
          value: f.value,
          evidence_label: f.evidence_label,
          source: f.source,
          evidence_url: f.evidence_url,
          note: f.note,
          observed_at: f.observed_at,
          entered_by: EXTRACTOR_VERSION,
          stand_in: false,
        });
      }
      for (const c of mapped.candidates) {
        candidateRows.push({
          account_id: c.account_id,
          key: c.key,
          value: c.value,
          evidence_label: c.evidence_label,
          source: c.source,
          source_id: c.source_id,
          evidence_url: c.evidence_url,
          quote: c.quote,
          observed_at: c.observed_at,
          confidence: c.confidence,
          extractor: c.extractor,
          fingerprint: c.fingerprint,
          current_value: c.current_value,
          conflicts: c.conflicts,
          note: c.note,
        });
      }
    }

    if (dry_run) {
      notes.push("Dry run: nothing was written and the watermark did not move.");
      await finishRun(db, runId, "success", { ...counters, facts: factRows.length, candidates: candidateRows.length }, notes);
      return json({
        ok: true, run_id: runId, dry_run: true,
        would_write: { facts: factRows.length, candidates: candidateRows.length },
        next_watermark: plan.next_watermark, counters, notes,
      });
    }

    let wrote = 0;
    let errors = 0;

    if (factRows.length > 0) {
      const r = await insertBatches(db, "pb_facts", factRows);
      wrote += r.wrote;
      errors += r.errors.length;
      notes.push(...r.errors);
    }
    if (candidateRows.length > 0) {
      // A fingerprint already queued is not an error — it is the same text, already waiting.
      const { error } = await db.from("pb_fact_candidates")
        .upsert(candidateRows, { onConflict: "fingerprint", ignoreDuplicates: true });
      if (error) { errors++; notes.push(`pb_fact_candidates: ${error.message}`); }
      else wrote += candidateRows.length;
    }

    if (plan.next_watermark !== null && errors === 0) {
      const { error } = await db.from("pb_source_watermarks").upsert({
        source: SOURCE,
        last_seen_at: plan.next_watermark,
        last_run_at: new Date().toISOString(),
        note: `${EXTRACTOR_VERSION}: read ${plan.read.length} note(s), wrote ${factRows.length} fact(s), queued ${candidateRows.length}.`,
      }, { onConflict: "source" });
      if (error) { errors++; notes.push(`pb_source_watermarks: ${error.message}`); }
    } else if (errors > 0) {
      notes.push("The watermark was NOT advanced because this run had errors; the same notes are read again next time.");
    }

    await finishRun(db, runId, runStatus(wrote, errors), { ...counters, facts: factRows.length, candidates: candidateRows.length, wrote, errors }, notes);
    return json({
      ok: errors === 0, run_id: runId,
      wrote: { facts: factRows.length, candidates: candidateRows.length },
      next_watermark: plan.next_watermark, counters, notes,
    });
  } catch (e) {
    const message = errorMessage(e);
    await finishRun(db, runId, "failed", counters, [...notes, message]);
    return json({ ok: false, run_id: runId, error: message, counters, notes }, 500);
  }
});
