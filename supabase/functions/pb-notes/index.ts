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
import { closeAbandonedRuns, finishRun, runStatus, startRun } from "../_shared/log.ts";
import { errorMessage, isRec, json, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  extractorId,
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
/**
 * Which model reads the records. Overridable from Vault (`PB_EXTRACTOR_MODEL`) so switching is
 * a secret change, not a redeploy — and so the two can be compared on the same corpus.
 *
 * Sonnet 5 is the default deliberately. Every guard in this pipeline protects PRECISION — the
 * quote check, the whitelist, the judgement rule and the review queue all stop a wrong fact
 * from being written. NOTHING protects RECALL: a claim the reader simply fails to notice
 * leaves no trace anywhere, and silence is indistinguishable from an honest "the note does not
 * say". Noticing is the part worth paying for, and at this volume the difference is pennies.
 */
const DEFAULT_MODEL = "claude-sonnet-5";
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
  /** Read with this model for one run, to compare it against the standing one. */
  model?: unknown;
  /** Wall-clock budget in ms. The run stops itself before the platform kills it. */
  budget_ms?: unknown;
  /** How many records to read at once. Default 3, capped at 6. */
  concurrency?: unknown;
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
async function readRecord(apiKey: string, model: string, planned: PlannedNote): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // The current models think before they answer, and thinking is billed and counted inside
      // max_tokens. At 1500 the budget was spent before any text block arrived, so every
      // response parsed as "no claims array" — an empty answer that looked like an honest
      // "the note says nothing". Leave room for both.
      max_tokens: 16000,
      // No `temperature`: sampling parameters are removed on the current models and a request
      // carrying one is rejected with a 400. Determinism comes from the prompt and the
      // validator, not from a sampling knob.
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
  if (start < 0 || end <= start) {
    // Say WHY there was no JSON. "No claims array" is indistinguishable from an honest empty
    // read, and that ambiguity cost a whole run to diagnose: stop_reason "max_tokens" means
    // the budget was spent, not that the record said nothing.
    throw new Error(
      `no JSON in the reply (stop_reason ${String(body?.stop_reason ?? "?")}, ` +
      `${text.length} chars of text): ${text.slice(0, 160)}`,
    );
  }
  const body_text = text.slice(start, end + 1);
  const parsed = safeJsonParse(body_text);
  if (parsed.ok) return parsed.value;

  /* A reply cut off mid-array is still worth its complete entries. Close the array after the
     last entry that finished and keep those; the guards downstream judge each one exactly as
     they would have. Salvaging beats discarding a record's whole reading over its last claim —
     but say so, because the claims past the cut are lost and that is recall, silently gone. */
  const lastWhole = body_text.lastIndexOf("},");
  if (lastWhole > 0) {
    const repaired = safeJsonParse(body_text.slice(0, lastWhole + 1) + "]}");
    if (repaired.ok) return repaired.value;
  }
  throw new Error(`reply was not JSON (${parsed.error}): ${text.slice(0, 160)}`);
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
  const model = (typeof body.model === "string" && body.model) || (await getSecret(db, "PB_EXTRACTOR_MODEL")) || DEFAULT_MODEL;
  const extractor = extractorId(model);

  const as_of = typeof body.as_of === "string" ? body.as_of : today();
  const max_notes = typeof body.max_notes === "number" && body.max_notes > 0 ? Math.floor(body.max_notes) : 250;
  const dry_run = body.dry_run === true;
  const wanted = Array.isArray(body.sources) ? body.sources.map(String) : null;

  const runId = await startRun(db, "ingest", "written_record", dry_run ? "pb-notes (dry run)" : "pb-notes");
  const notes: string[] = [];
  const abandoned = await closeAbandonedRuns(db, "written_record");
  if (abandoned > 0) {
    notes.push(`Closed ${abandoned} earlier run(s) that never reported — killed mid-flight. What they wrote is kept; the watermark says how far they got.`);
  }
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

    /* A self-imposed deadline. The platform kills a long function without warning, and a run
       killed mid-flight loses every model call it had paid for and leaves pb_runs saying
       "running" forever. Stopping ourselves means the run always ends cleanly, always reports,
       and always leaves a watermark the next run can resume from.

       The deadline has to be checked with the NEXT batch's cost in hand, not just the clock:
       a run that is 109s into a 110s budget and starts a 50s batch finishes at 159s, which is
       exactly the overrun the budget existed to prevent. So the check reserves headroom — the
       slowest batch this run has taken, or a first guess before there is one — and stops when
       starting another would cross the line. That makes the budget a real ceiling rather than
       a suggestion, at the cost of leaving a little of it unused. The watermark carries the
       rest, so unused budget costs a night, never a record. */
    const started = Date.now();
    const budgetMs = typeof body.budget_ms === "number" && body.budget_ms > 0
      ? Math.floor(body.budget_ms)
      : 110_000;
    /* How many records may be in flight at once. Three is chosen to be plainly under any
       rate limit rather than to be fast: the bottleneck is one model call per record, and the
       ceiling on a run is the budget, not the pool. */
    const concurrency = typeof body.concurrency === "number" && body.concurrency > 0
      ? Math.min(6, Math.floor(body.concurrency))
      : 3;

    const FIRST_BATCH_GUESS_MS = 60_000;
    let slowestBatchMs = 0;
    const headroomMs = () => (slowestBatchMs > 0 ? slowestBatchMs : FIRST_BATCH_GUESS_MS);
    const outOfTime = () => Date.now() - started + headroomMs() > budgetMs;

    let wrote = 0;
    let errors = 0;
    let factsWritten = 0;
    let queued = 0;
    const newWatermarks: Record<string, string> = {};
    const swept: string[] = [];
    let budget = max_notes;
    let stopped = false;

    /* Written per record, never accumulated to the end. A timeout then costs at most the
       record in flight, and everything already read stays in the book. */
    const flush = async (factRows: Rec[], candidateRows: Rec[]): Promise<boolean> => {
      let ok = true;
      if (factRows.length > 0) {
        const r = await insertBatches(db, "pb_facts", factRows);
        wrote += r.wrote;
        factsWritten += r.wrote;
        if (r.errors.length) { errors += r.errors.length; notes.push(...r.errors); ok = false; }
      }
      if (candidateRows.length > 0) {
        const { error } = await db.from("pb_fact_candidates")
          .upsert(candidateRows, { onConflict: "fingerprint", ignoreDuplicates: true });
        if (error) { errors++; notes.push(`pb_fact_candidates: ${error.message}`); ok = false; }
        else { wrote += candidateRows.length; queued += candidateRows.length; }
      }
      return ok;
    };

    for (const channel of channels) {
      if (stopped) break;
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

      /* Oldest first. The cost of a record is almost entirely one model call — about fifty
         seconds of waiting on a network round trip and almost no CPU — so reading them one at
         a time spends the whole budget on idling. Records are read in small concurrent
         batches instead, then processed strictly in time order, one at a time.

         A batch never holds two records for the same account. That is the one place sequence
         genuinely matters: a record must see what an earlier record on the same account
         already wrote, or the two would each write the same key. Across accounts there is
         nothing to see. Time order survives either way, because a batch is always a
         contiguous run of the ordered list — the batch closes at the first repeat rather than
         reaching past it. */
      const ordered = [...plan.read].sort((a, b) => {
        const ta = String(a.note.update_time ?? a.note.add_time ?? "");
        const tb = String(b.note.update_time ?? b.note.add_time ?? "");
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

      let cursor = 0;
      while (cursor < ordered.length && budget > 0) {
        if (outOfTime()) {
          notes.push(
            `Stopped after ${Math.round((Date.now() - started) / 1000)}s of a ${Math.round(budgetMs / 1000)}s budget: another batch needs about ` +
            `${Math.round(headroomMs() / 1000)}s and would run past it. The watermark carries the rest to the next run — ` +
            `raise budget_ms only as far as the caller's own timeout allows.`,
          );
          counters["stopped_on_time"] = 1;
          stopped = true;
          break;
        }

        const batch: typeof ordered = [];
        const accountsInBatch = new Set<string>();
        while (cursor < ordered.length && batch.length < concurrency && budget > 0) {
          const next = ordered[cursor];
          if (accountsInBatch.has(next.account_id)) break; // the batch ends here, not past it
          accountsInBatch.add(next.account_id);
          batch.push(next);
          cursor++;
          budget--;
        }
        if (batch.length === 0) break;

        const batchStarted = Date.now();
        const replies = await Promise.all(batch.map(async (p) => {
          try {
            return { p, response: await readRecord(apiKey, model, p), failure: null as string | null };
          } catch (e) {
            return { p, response: null as unknown, failure: errorMessage(e) };
          }
        }));

        for (const r of replies) {
          const p = r.p;
          if (r.failure !== null) {
            /* Move past it. A parse failure is deterministic — retrying gives the same reply —
               so holding the watermark here would wedge the whole channel on one bad record,
               forever, and nothing after it would ever be read. It is not lost quietly: the
               counter is non-zero and the run names the record, which is what an operator
               watches. Re-read it deliberately with `since: null`. */
            notes.push(`${p.note.label ?? p.note.id}: ${r.failure}; SKIPPED — re-read it with since:null once the cause is fixed.`);
            counters[`${channel.source}.extractor_failed`] = (counters[`${channel.source}.extractor_failed`] ?? 0) + 1;
            newWatermarks[channel.source] = String(p.note.update_time ?? p.note.add_time ?? "");
            continue;
          }

          const v = verifyClaims(p, r.response);
          notes.push(...v.notes);
          add(channel.source, v.counters);

          if (v.extraction.claims.length > 0) {
            const existing = await selectAll(
              db,
              "pb_current_facts",
              "key,value,evidence_label,source,observed_at,entered_by",
              (q) => q.eq("account_id", p.account_id),
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
              account_id: p.account_id,
              notes: [p.note],
              extractions: [v.extraction],
              existing: held,
              extractor,
              as_of,
            });
            notes.push(...mapped.notes);
            add(channel.source, mapped.counters);

            const factRows: Rec[] = mapped.facts.map((f) => ({
              account_id: f.account_id, key: f.key, value: f.value,
              evidence_label: f.evidence_label, source: f.source, evidence_url: f.evidence_url,
              note: f.note, observed_at: f.observed_at, entered_by: extractor, stand_in: false,
            }));
            const candidateRows: Rec[] = mapped.candidates.map((c) => ({
              account_id: c.account_id, key: c.key, value: c.value,
              evidence_label: c.evidence_label, source: c.source, source_id: c.source_id,
              evidence_url: c.evidence_url, quote: c.quote, observed_at: c.observed_at,
              confidence: c.confidence, extractor: c.extractor, fingerprint: c.fingerprint,
              current_value: c.current_value, conflicts: c.conflicts, note: c.note,
            }));

            if (!dry_run) {
              const ok = await flush(factRows, candidateRows);
              if (!ok) { stopped = true; break; } // a write that failed must not be marked read
            } else {
              factsWritten += factRows.length;
              queued += candidateRows.length;
            }
          }

          // Only now is this record genuinely done, so only now may the watermark pass it.
          newWatermarks[channel.source] = String(p.note.update_time ?? p.note.add_time ?? "");
        }

        /* Headroom is measured in batches because that is the unit the next iteration costs.
           A batch that was cut short by a write failure is not a measurement of anything. */
        if (stopped) break;
        slowestBatchMs = Math.max(slowestBatchMs, Date.now() - batchStarted);

        if (budget <= 0) {
          notes.push(`The run cap of ${max_notes} record(s) was reached; the rest waits for the next run.`);
          stopped = true;
          break;
        }
      }
    }

    if (dry_run) {
      notes.push("Dry run: nothing was written and no watermark moved.");
      await finishRun(db, runId, "success", { ...counters, facts: factsWritten, candidates: queued }, notes);
      return json({
        ok: true, run_id: runId, dry_run: true, swept, extractor,
        would_write: { facts: factsWritten, candidates: queued },
        next_watermarks: newWatermarks, counters, notes,
      });
    }

    /* The watermark moves only over records that were read AND written. A record that failed
       either step stopped the loop before its watermark was recorded, so the next run retries
       exactly it and nothing before it is read twice. */
    if (errors === 0) {
      for (const [source, last_seen_at] of Object.entries(newWatermarks)) {
        if (!last_seen_at) continue;
        const { error } = await db.from("pb_source_watermarks").upsert({
          source,
          last_seen_at,
          last_run_at: new Date().toISOString(),
          note: `${extractor}: swept ${source}.`,
        }, { onConflict: "source" });
        if (error) { errors++; notes.push(`pb_source_watermarks(${source}): ${error.message}`); }
      }
    } else {
      notes.push("No watermark was advanced because this run had errors; the same records are read again next time.");
    }

    await finishRun(db, runId, runStatus(wrote, errors), { ...counters, facts: factsWritten, candidates: queued, wrote, errors }, notes);
    return json({
      ok: errors === 0, run_id: runId, swept, extractor, stopped_early: stopped,
      wrote: { facts: factsWritten, candidates: queued },
      next_watermarks: newWatermarks, counters, notes,
    });
  } catch (e) {
    const message = errorMessage(e);
    await finishRun(db, runId, "failed", counters, [...notes, message]);
    return json({ ok: false, run_id: runId, error: message, counters, notes }, 500);
  }
});
