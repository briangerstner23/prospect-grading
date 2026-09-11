/**
 * pb-notes — the nightly sweep of everything a person wrote about an account.
 *
 *   POST /functions/v1/pb-notes
 *   Authorization: Bearer <PB_SYNC_TOKEN>        (Vault, read through pb_secret())
 *   { as_of?: "YYYY-MM-DD", max_notes?: number, since?: string|null, dry_run?: boolean }
 *
 * Sales writes the best data in the business into prose: Pipedrive notes, what a call summary
 * recorded, what a prospect said in an email. This function reads all of it.
 *
 * THREE CHANNELS, ONE PIPELINE. Each keeps its own row in pb_source_watermarks and needs its
 * own credential; a channel with no credential is skipped and said so, never guessed at.
 *
 *   pipedrive_note   PB_PIPEDRIVE_API_TOKEN   attributed by the note's own organisation
 *   fathom_call      (none — reads pb_calls)  already attributed by the Fathom webhook
 *   email            PB_GMAIL_REFRESH_TOKEN   attributed by who was on the thread
 *                    + PB_GMAIL_CLIENT_ID / PB_GMAIL_CLIENT_SECRET
 *
 * Per channel:
 *   1. Where did we get to        pb_source_watermarks(<source>).last_seen_at
 *   2. Pull                       newest-touched first, until past it
 *   3. Attribute                  record_sources — one account or none; never a guess
 *   4. Plan                       planSweep — real prose, not already read, capped
 *   5. Read                       one model call per record, asking for claims with quotes
 *   6. Verify                     verifyClaims — whitelist, THE QUOTE MUST BE IN THE RECORD,
 *                                 and an opinion is not an observation
 *   7. Decide                     mapWrittenRecord — quote-backed, observed, high → fact
 *   8. Write                      pb_facts, pb_fact_candidates (fingerprint dedupes), watermark
 *
 * Nothing here decides what is true. Steps 5 and 6 are the whole safety story: a sentence the
 * model invented is stripped, which drops the claim to the review queue, so an unattended run
 * can add work for a person but can never put an unsourced claim into the book. And a fact a
 * PERSON entered is never overwritten — see written_record.ts.
 *
 * Costs one model call per unread record with real prose in it. A re-run costs nothing: the
 * watermark skips them, and the fingerprint would refuse them anyway.
 *
 * Fathom TRANSCRIPTS are deliberately not read — see record_sources.ts. A transcript is speech;
 * quoting it verbatim would put half-finished sentences in the book as evidence.
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
import { mapPipedriveNotes } from "../_shared/ingest/written_record.ts";
import type { ExistingFact, NoteExtraction, WrittenRecord } from "../_shared/ingest/written_record.ts";
import { attributeAll, gmailToRecord, isChatter } from "../_shared/ingest/record_sources.ts";
import type { GmailMessage } from "../_shared/ingest/record_sources.ts";

/** Domains that are us. Anyone at one of these does not attribute a record to an account. */
const OUR_DOMAINS = ["whitelabeliq.com"];
const PIPEDRIVE_NOTES = "pipedrive_note";
const FATHOM_CALLS = "fathom_call";
const EMAIL = "email";
const MODEL = "claude-haiku-4-5";
const PAGE = 100;
/** Pipedrive paging stops here even if the watermark is never reached — a first run is finite. */
const MAX_PAGES = 40;

interface Body {
  as_of?: unknown;
  max_notes?: unknown;
  since?: unknown;
  dry_run?: unknown;
  /** Which channels to sweep. Default: every one that has a credential. */
  sources?: unknown;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}


/* ------------------------------------------------------------------ *
 * the channels
 * ------------------------------------------------------------------ */

/** Records a channel produced, each already knowing which account it is about. */
interface Pulled {
  records: WrittenRecord[];
  notes: string[];
  counters: Record<string, number>;
}

const EMPTY: Pulled = { records: [], notes: [], counters: {} };

/**
 * Pipedrive notes, newest-touched first, stopping once past the watermark. Pipedrive has no
 * "updated since" filter on notes, so the sort order is the filter.
 */
async function pullPipedriveNotes(
  token: string,
  since: string | null,
  accountByOrg: Record<string, string>,
): Promise<Pulled> {
  const records: WrittenRecord[] = [];
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.pipedrive.com/v1/notes?api_token=${encodeURIComponent(token)}` +
      `&start=${page * PAGE}&limit=${PAGE}&sort=${encodeURIComponent("update_time DESC")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pipedrive /notes returned ${res.status}`);
    const body = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length === 0) break;

    let past = false;
    for (const row of data) {
      if (!isRec(row)) continue;
      const touched = String(row.update_time ?? row.add_time ?? "");
      if (since !== null && touched !== "" && touched <= since) { past = true; continue; }
      const org = row.org_id == null ? "" : String(row.org_id);
      records.push({
        id: row.id as number,
        org_id: (row.org_id ?? null) as number | null,
        content: String(row.content ?? ""),
        add_time: String(row.add_time ?? ""),
        update_time: row.update_time == null ? null : String(row.update_time),
        user_name: isRec(row.user) ? String((row.user as Rec).name ?? "") || null : null,
        source: PIPEDRIVE_NOTES,
        account_id: accountByOrg[org],
      });
    }
    if (past) break;
    if (!body?.additional_data?.pagination?.more_items_in_collection) break;
    if (page === MAX_PAGES - 1) notes.push(`Stopped after ${MAX_PAGES} Pipedrive pages; run again to continue.`);
  }
  counters.pulled = records.length;
  return { records, notes, counters };
}

/**
 * Fathom call summaries, read from pb_calls rather than from Fathom.
 *
 * The webhook already does the hard part: it stores each recording with its summary AND the
 * account it belongs to, having resolved that from who was on the call. So this channel needs
 * no credential of its own and repeats no attribution — it reads what is already in the book.
 * A call that arrives after this runs is swept the following night.
 *
 * The TRANSCRIPT is deliberately not read even though pb_calls knows one exists. A transcript
 * is speech — half-finished sentences, people thinking aloud, two people talking at once.
 * Quoting it verbatim would put "yeah, I mean, we don't really have anybody" in the book as
 * evidence. A summary is already a considered written statement, which is what the quote rule
 * assumes it is checking.
 */
async function pullFathomCalls(db: DbLike, since: string | null): Promise<Pulled> {
  const rows = await selectAll(
    db,
    "pb_calls",
    "fathom_recording_id,account_id,title,held_at,url,recorded_by,summary,updated_at",
    (q) => {
      let query = q.not("summary", "is", null).not("account_id", "is", null);
      if (since !== null) query = query.gt("updated_at", since);
      return query.order("updated_at", { ascending: true });
    },
  );
  const records: WrittenRecord[] = [];
  for (const r of rows) {
    const held = String(r.held_at ?? r.updated_at ?? "");
    records.push({
      id: String(r.fathom_recording_id ?? ""),
      org_id: null,
      content: String(r.summary ?? ""),
      add_time: held,
      // The watermark walks updated_at, so a call whose summary is revised is read again.
      update_time: String(r.updated_at ?? held),
      user_name: (r.recorded_by as string | null) ?? null,
      source: FATHOM_CALLS,
      url: (r.url as string | null) ?? null,
      label: `Fathom call${r.title ? ` "${r.title}"` : ""}${held ? ` on ${held.slice(0, 10)}` : ""}`,
      account_id: String(r.account_id),
    });
  }
  return { records, notes: [], counters: { pulled: records.length } };
}

/**
 * Email. One record per MESSAGE, not per thread — a thread spans months and collapsing it
 * would date every sentence in it by the last reply.
 *
 * The query is domain-scoped rather than "everything": we ask Gmail only for mail involving a
 * domain the book already knows, so nobody's unrelated correspondence is read.
 */
async function pullEmail(
  token: string,
  since: string | null,
  accountByDomain: Record<string, string>,
  domains: readonly string[],
): Promise<Pulled> {
  const raw: { record: WrittenRecord; domains: string[] }[] = [];
  const notes: string[] = [];
  let chatter = 0;
  const after = since ? since.slice(0, 10).replace(/-/g, "/") : null;

  // Gmail's query length is bounded, so ask in batches of domains.
  for (let i = 0; i < domains.length; i += 20) {
    const batch = domains.slice(i, i + 20);
    const q = `(${batch.map((d) => `from:${d} OR to:${d}`).join(" OR ")})` + (after ? ` after:${after}` : "");
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Gmail list returned ${res.status}`);
    const list = await res.json();
    const ids = Array.isArray(list?.messages) ? list.messages : [];

    for (const m of ids) {
      if (!isRec(m)) continue;
      const one = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!one.ok) continue;
      const msg = await one.json();
      const headers: Record<string, string> = {};
      for (const h of (msg?.payload?.headers ?? [])) {
        if (isRec(h) && typeof h.name === "string") headers[h.name.toLowerCase()] = String(h.value ?? "");
      }
      const gm: GmailMessage = {
        id: String(msg.id),
        threadId: String(msg.threadId ?? ""),
        subject: headers.subject ?? null,
        sender: headers.from ?? null,
        toRecipients: (headers.to ?? "").split(","),
        ccRecipients: (headers.cc ?? "").split(","),
        date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : (headers.date ?? null),
        snippet: String(msg.snippet ?? ""),
      };
      if (isChatter(gm)) { chatter++; continue; }
      raw.push(gmailToRecord(gm, OUR_DOMAINS));
    }
  }

  const a = attributeAll(raw, accountByDomain);
  notes.push(...a.notes.slice(0, 40));
  return {
    records: a.attributed.map((x) => ({ ...x.record, account_id: x.account_id })),
    notes,
    counters: { pulled: raw.length, skipped_chatter: chatter, ...a.counters },
  };
}

/* ------------------------------------------------------------------ *
 * the extractor
 * ------------------------------------------------------------------ */

/**
 * A Google access token lasts an hour, which is no use to a job that runs at 05:45. The Vault
 * holds a REFRESH token and the OAuth client, and the run exchanges them for an access token it
 * throws away. Nothing long-lived is written down anywhere but the Vault.
 */
async function gmailAccessToken(refresh: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange returned ${res.status}; the refresh token may have been revoked`);
  const body = await res.json();
  const token = typeof body?.access_token === "string" ? body.access_token : "";
  if (!token) throw new Error("Google returned no access token");
  return token;
}

/** One record, one model call. Returns whatever came back; verifyClaims decides what it is worth. */
async function readRecord(apiKey: string, planned: PlannedNote): Promise<unknown> {
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
      messages: [{ role: "user", content: `<record>\n${planned.text}\n</record>` }],
    }),
  });
  if (!res.ok) throw new Error(`extractor returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = Array.isArray(body?.content)
    ? body.content.map((b: Rec) => (b?.type === "text" ? String(b.text ?? "") : "")).join("")
    : "";
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

  const apiKey = await getSecret(db, "PB_ANTHROPIC_API_KEY");
  if (apiKey === null) {
    return json({ ok: false, error: "PB_ANTHROPIC_API_KEY is not in Vault; nothing can be read" }, 503);
  }

  const as_of = typeof body.as_of === "string" ? body.as_of : today();
  const max_notes = typeof body.max_notes === "number" && body.max_notes > 0 ? Math.floor(body.max_notes) : 250;
  const dry_run = body.dry_run === true;
  const wanted = Array.isArray(body.sources) ? body.sources.map(String) : null;

  const runId = await startRun(db, "ingest", "written_record", dry_run ? "pb-notes (dry run)" : "pb-notes");
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const add = (prefix: string, c: Record<string, number>) => {
    for (const [k, v] of Object.entries(c)) {
      const key = `${prefix}.${k}`;
      counters[key] = (counters[key] ?? 0) + v;
    }
  };

  try {
    /* Who is who, once, for every channel. */
    const accounts = await selectAll(db, "pb_accounts", "id,pipedrive_org_id,domain");
    const accountByOrg: Record<string, string> = {};
    const accountByDomain: Record<string, string> = {};
    for (const a of accounts) {
      if (a.pipedrive_org_id != null) accountByOrg[String(a.pipedrive_org_id)] = String(a.id);
      const d = a.domain == null ? "" : String(a.domain).trim().toLowerCase().replace(/^www\./, "");
      if (d) accountByDomain[d] = String(a.id);
    }
    const bookDomains = Object.keys(accountByDomain);
    counters["book.accounts"] = accounts.length;
    counters["book.domains"] = bookDomains.length;

    const marks = await selectAll(db, "pb_source_watermarks", "source,last_seen_at");
    const watermark = (source: string): string | null => {
      if (body.since === null) return null;
      if (typeof body.since === "string") return body.since;
      const row = marks.find((m) => String(m.source) === source);
      return row ? ((row.last_seen_at as string | null) ?? null) : null;
    };

    /* Each channel, behind its own credential. A missing key is said out loud, never guessed. */
    const pipedriveToken = await getSecret(db, "PB_PIPEDRIVE_API_TOKEN");

    const gmailRefresh = await getSecret(db, "PB_GMAIL_REFRESH_TOKEN");
    const gmailClientId = await getSecret(db, "PB_GMAIL_CLIENT_ID");
    const gmailClientSecret = await getSecret(db, "PB_GMAIL_CLIENT_SECRET");
    const gmailReady = gmailRefresh !== null && gmailClientId !== null && gmailClientSecret !== null ? "ready" : null;

    const channels: { source: string; pull: () => Promise<Pulled> }[] = [];
    const consider = (source: string, secret: string | null, secretName: string, pull: () => Promise<Pulled>) => {
      if (wanted && !wanted.includes(source)) return;
      if (secret === null) {
        notes.push(`${source}: ${secretName} is not in Vault, so this channel was not swept.`);
        counters[`${source}.no_credential`] = 1;
        return;
      }
      channels.push({ source, pull });
    };

    consider(PIPEDRIVE_NOTES, pipedriveToken, "PB_PIPEDRIVE_API_TOKEN", () =>
      pullPipedriveNotes(pipedriveToken as string, watermark(PIPEDRIVE_NOTES), accountByOrg));
    // No credential: the webhook already put these in pb_calls, with their account resolved.
    consider(FATHOM_CALLS, "ready", "", () => pullFathomCalls(db, watermark(FATHOM_CALLS)));
    consider(EMAIL, gmailReady, "PB_GMAIL_REFRESH_TOKEN / PB_GMAIL_CLIENT_ID / PB_GMAIL_CLIENT_SECRET", async () => {
      const token = await gmailAccessToken(gmailRefresh as string, gmailClientId as string, gmailClientSecret as string);
      return pullEmail(token, watermark(EMAIL), accountByDomain, bookDomains);
    });

    if (channels.length === 0) {
      notes.push("No channel had a credential; nothing was swept.");
      await finishRun(db, runId, "success", counters, notes);
      return json({ ok: true, run_id: runId, swept: [], counters, notes });
    }

    const factRows: Rec[] = [];
    const candidateRows: Rec[] = [];
    const newWatermarks: Record<string, string> = {};
    const swept: string[] = [];
    let budget = max_notes;

    for (const channel of channels) {
      let pulled: Pulled;
      try {
        pulled = await channel.pull();
      } catch (e) {
        notes.push(`${channel.source}: ${errorMessage(e)}; the other channels continue and this one is retried next run.`);
        counters[`${channel.source}.pull_failed`] = 1;
        continue;
      }
      notes.push(...pulled.notes);
      add(channel.source, pulled.counters);
      swept.push(channel.source);

      const plan = planSweep({
        notes: pulled.records,
        accountByOrg,
        since: watermark(channel.source),
        as_of,
        max_notes: budget,
      });
      notes.push(...plan.notes);
      add(channel.source, plan.counters);
      budget -= plan.read.length;

      /* Group by account so the mapper sees every record for an account at once. */
      const byAccount = new Map<string, PlannedNote[]>();
      for (const p of plan.read) {
        const list = byAccount.get(p.account_id) ?? [];
        list.push(p);
        byAccount.set(p.account_id, list);
      }

      for (const [account_id, planned] of byAccount) {
        const extractions: NoteExtraction[] = [];
        for (const p of planned) {
          let response: unknown = null;
          try {
            response = await readRecord(apiKey, p);
          } catch (e) {
            notes.push(`${p.note.label ?? p.note.id}: ${errorMessage(e)}; left for the next run.`);
            counters[`${channel.source}.extractor_failed`] = (counters[`${channel.source}.extractor_failed`] ?? 0) + 1;
            continue;
          }
          const v = verifyClaims(p, response);
          notes.push(...v.notes);
          add(channel.source, v.counters);
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
        add(channel.source, mapped.counters);

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

      if (plan.next_watermark !== null) newWatermarks[channel.source] = plan.next_watermark;
      if (budget <= 0) {
        notes.push(`The run cap of ${max_notes} record(s) was reached; the remaining channels wait for the next run.`);
        break;
      }
    }

    if (dry_run) {
      notes.push("Dry run: nothing was written and no watermark moved.");
      await finishRun(db, runId, "success", { ...counters, facts: factRows.length, candidates: candidateRows.length }, notes);
      return json({
        ok: true, run_id: runId, dry_run: true, swept,
        would_write: { facts: factRows.length, candidates: candidateRows.length },
        next_watermarks: newWatermarks, counters, notes,
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

    if (errors === 0) {
      for (const [source, last_seen_at] of Object.entries(newWatermarks)) {
        const { error } = await db.from("pb_source_watermarks").upsert({
          source,
          last_seen_at,
          last_run_at: new Date().toISOString(),
          note: `${EXTRACTOR_VERSION}: swept ${source}.`,
        }, { onConflict: "source" });
        if (error) { errors++; notes.push(`pb_source_watermarks(${source}): ${error.message}`); }
      }
    } else {
      notes.push("No watermark was advanced because this run had errors; the same records are read again next time.");
    }

    await finishRun(db, runId, runStatus(wrote, errors), { ...counters, facts: factRows.length, candidates: candidateRows.length, wrote, errors }, notes);
    return json({
      ok: errors === 0, run_id: runId, swept,
      wrote: { facts: factRows.length, candidates: candidateRows.length },
      next_watermarks: newWatermarks, counters, notes,
    });
  } catch (e) {
    const message = errorMessage(e);
    await finishRun(db, runId, "failed", counters, [...notes, message]);
    return json({ ok: false, run_id: runId, error: message, counters, notes }, 500);
  }
});
