/**
 * pb-notes — the sales-meeting reader (DECISIONS §65).
 *
 *   POST /functions/v1/pb-notes
 *   Authorization: Bearer <PB_SYNC_TOKEN>
 *   { sources: ["sales_meeting"], recording_id?, reread?, register_only?, dry_run?,
 *     budget_ms? (110000), concurrency? (≤ 6), model?, as_of? }
 *
 * The team's internal sales meeting is where the book is reviewed, and the owner ruled that what
 * is said there is judgement from research. pb-fathom-webhook already stores every internal
 * recording whole in pb_webhook_inbox (service role only) and writes nothing else for it. This
 * reads those stored deliveries — the transcript, never Fathom's summary — into proposals a
 * person decides, one agency card at a time. Every run, in order:
 *
 *   1. REGISTER   inbox rows past the (received_at, id) cursor, LIGHT columns only → the internal
 *                 recordings with a transcript (meeting_transcript.internalOnly, the webhook's own
 *                 test), selected (owner > title rule > title pattern), one recording per meeting
 *                 (groupRecording) → pb_meetings 'waiting' | 'skipped' | 'duplicate'. No model call.
 *   2. CLAIM      the oldest waiting meeting, or one whose reader died, under an atomic lease:
 *                 an update that matches only while read_started_at is free.
 *   3. PASS 1     one call over the numbered transcript (two windows past 160k characters): which
 *                 companies were discussed, in the words as said, on which lines. verifySegments
 *                 keeps a name only on a line it was cited for.
 *   4. RESOLVE    in code, never by the model: buildRosterIndex / resolveMention / clusterMentions.
 *                 Stored in pb_meetings.mentions; the meeting is 'reading'.
 *   5. PASS 2     four agencies to a call, each seeing ONLY its own lines, up to six calls at once,
 *                 round by round inside the budget. verifyMeetingClaims refuses a quote that is not
 *                 one speaker's lines of THAT agency; reduceClaims keeps the last word.
 *   6. WRITE      proposalRows against a snapshot of the book (current facts, current reads,
 *                 removals) → pb_meeting_proposals, upserted on the fingerprint so a re-run writes
 *                 nothing twice; then pb_meeting_supersede, so the newest meeting's word wins.
 *   7. CLOSE      'read', or 'partial' when an agency's call came back unusable; usage and counts on
 *                 the meeting; a pb_runs row (kind ingest, source sales_meeting, credits_spent).
 *
 * WHAT IT WRITES — and nothing else: pb_meetings, pb_meeting_proposals, the 'sales_meeting' row of
 * pb_source_watermarks, and pb_runs. It never writes a fact, a register row, a candidate, a call,
 * a signal or a contact event. A proposal reaches the book only through pb_decide_meeting_card,
 * under a signed-in person.
 *
 * WHAT IT NEVER STORES: no transcript leaves the inbox except as the quoted lines of a proposal;
 * the run's notes carry recording ids, refs and counts — never a quote, a name or a title.
 *
 * WHEN IT STOPS:
 *   · out of budget — before a call whose expected time would cross budget_ms. The meeting stays
 *     'reading' with its progress written and its lease left to lapse (LEASE_MS), so the next tick
 *     resumes it where it stopped and re-reads nothing.
 *   · halt — the API refused (classifyExtractorFailure) or the call never answered. The lease is
 *     released, the meeting goes back to 'waiting' with whatever progress it had, and the run is
 *     'failed' (or 'partial' if it wrote first). Nothing is marked read that was not read.
 *   · skip — a reply came back unusable. Pass 1: the meeting is 'failed' (re-read it deliberately).
 *     Pass 2: those agencies are recorded in progress.failed_refs and the meeting ends 'partial'.
 *
 * dry_run reads and verifies exactly as a real run and writes only its pb_runs row: no lease, no
 * registration, no proposal, no watermark. The proposals come back in the response, quotes
 * included, for the hand check before the first real write.
 */

import { selectAll, selectIn } from "../_shared/db.ts";
import { getSecret } from "../_shared/auth.ts";
import { closeAbandonedRuns, finishRun, runStatus, startRun } from "../_shared/log.ts";
import { errorMessage, json } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import { extractorId, isPastCursor, MEETING_PROMPT_VERSION } from "../_shared/ingest/notes_sweep.ts";
import { MEETING_SOURCE, renderLines, transcriptLines, windowsFor } from "../_shared/ingest/meeting_transcript.ts";
import type { TitleRule } from "../_shared/ingest/meeting_transcript.ts";
import { buildRosterIndex, clusterMentions, resolveMention, verifySegments } from "../_shared/ingest/meeting_mentions.ts";
import type {
  JunkRow,
  LearnedAlias,
  MdmAlias,
  MdmResolution,
  MentionCluster,
  PoisonPair,
  RosterAccount,
  VerifiedMention,
} from "../_shared/ingest/meeting_mentions.ts";
import {
  claimsMessage,
  claimsPrompt,
  planBatches,
  proposalRows,
  reduceClaims,
  segmentPrompt,
  verifyMeetingClaims,
} from "../_shared/ingest/meeting_claims.ts";
import type { ProposalRow, RemovalReason, SnapshotFact, SnapshotRead, VerifiedClaim } from "../_shared/ingest/meeting_claims.ts";
import { callExtractor, ExtractorReplyError } from "./extractor.ts";
import type { ExtractorResult } from "./extractor.ts";
import {
  addCounters,
  addUsage,
  appendNotes,
  CLAIMABLE_STATUSES,
  emptyUsage,
  failureKind,
  failureNote,
  heldDates,
  INBOX_LIGHT_SELECT,
  inboxCandidates,
  leaseCutoff,
  meetingPeople,
  mentionCounts,
  modelFromExtractor,
  parseMeetingBody,
  planRegistration,
  progressOf,
  proposalCounts,
  readVerdict,
  REREADABLE_STATUSES,
  rubricVocabulary,
  storedClusters,
} from "./meetings_pure.ts";
import type { InboxLightRow, MeetingOptions, MeetingProgress, MeetingUsage, RegisteredMeeting, RegistrationPlan } from "./meetings_pure.ts";

export interface MeetingDeps {
  /** The standing model when neither the body nor PB_EXTRACTOR_MODEL names one. */
  defaultModel: string;
}

/** What one call is expected to take before there is a measurement: pass 1, or a pass-2 round. */
const FIRST_CALL_GUESS_MS = 60_000;

const WATERMARK_NOTE = `${MEETING_PROMPT_VERSION}: registration cursor over pb_webhook_inbox (received_at, id)`;

/** pb_meetings columns registration reads. `progress` stands in for "pass 1 has stored mentions". */
const REGISTERED_COLS = "recording_id,title_norm,held_at,ended_at,status,include,duplicate_of,read_started_at,progress";

/** pb_meetings columns a read needs. */
const MEETING_COLS =
  "recording_id,inbox_id,title,title_norm,held_at,status,include,extractor,mentions,progress,counts,usage,notes,read_started_at,duplicate_of";

/** Everything one invocation accumulates for its pb_runs row and its response. */
interface RunState {
  notes: string[];
  counters: Record<string, number>;
  usage: MeetingUsage;
  wrote: number;
  errors: number;
  halted: string | null;
  stopped_early: boolean;
  /** The model the meeting was read with: this run's, or the one a resumed read started with. */
  model_used: string | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(c: Record<string, number>, k: string, by = 1): void {
  c[k] = (c[k] ?? 0) + by;
}

/** Run `fn` over `items`, `size` at a time; results in input order. */
async function inRounds<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    out.push(...(await Promise.all(items.slice(i, i + Math.max(1, size)).map(fn))));
  }
  return out;
}

type CallOutcome = { ok: true; r: ExtractorResult } | { ok: false; e: unknown };

async function tryCall(apiKey: string, model: string, system: string, user: string): Promise<CallOutcome> {
  try {
    return { ok: true, r: await callExtractor(apiKey, model, system, user) };
  } catch (e) {
    return { ok: false, e };
  }
}

/** What a call cost, counted on the run and on the meeting. An API refusal is not billed. */
function charge(run: RunState, meeting: { usage: MeetingUsage }, o: CallOutcome): void {
  const used = o.ok ? o.r.usage : o.e instanceof ExtractorReplyError ? o.e.usage : null;
  if (used === null) return;
  run.usage = addUsage(run.usage, used, 1);
  meeting.usage = addUsage(meeting.usage, used, 1);
}

/* ------------------------------------------------------------------ *
 * the entry point
 * ------------------------------------------------------------------ */

export async function runMeetings(db: DbLike, raw: Rec, deps: MeetingDeps): Promise<Response> {
  const started = Date.now();
  const parsed = parseMeetingBody(raw, today());
  if (!parsed.ok) return json({ ok: false, source: MEETING_SOURCE, error: parsed.error }, 400);
  const o = parsed.opts;

  /* Like the sweep: no key, no run row — a 503 that says so, before anything is written. A
     register-only run makes no model call and needs no key. */
  let apiKey = "";
  let model = "";
  if (!o.register_only) {
    const key = await getSecret(db, "PB_ANTHROPIC_API_KEY");
    if (key === null) {
      return json({ ok: false, source: MEETING_SOURCE, error: "PB_ANTHROPIC_API_KEY is not in Vault; nothing can be read" }, 503);
    }
    apiKey = key;
    model = o.model || (await getSecret(db, "PB_EXTRACTOR_MODEL")) || deps.defaultModel;
  }

  const runId = await startRun(db, "ingest", MEETING_SOURCE, o.dry_run ? "pb-notes (dry run)" : "pb-notes");
  const run: RunState = {
    notes: [...parsed.notes],
    counters: {},
    usage: emptyUsage(),
    wrote: 0,
    errors: 0,
    halted: null,
    stopped_early: false,
    model_used: null,
  };
  const abandoned = await closeAbandonedRuns(db, MEETING_SOURCE);
  if (abandoned > 0) {
    run.notes.push(`Closed ${abandoned} earlier run(s) that never reported. What they wrote is kept; pb_meetings.progress says how far each got.`);
  }

  let httpStatus = 200;
  let meeting: Rec | null = null;
  let proposals: ProposalRow[] | null = null;
  try {
    const t0 = Date.now();
    const plan = await register(db, o, run);
    run.counters["ms.register"] = Date.now() - t0;

    if (o.register_only) {
      run.notes.push("register_only: nothing was read.");
    } else {
      const read = await readNext(db, o, run, { apiKey, model, started, plan });
      httpStatus = read.http;
      meeting = read.meeting;
      proposals = read.proposals;
    }
    if (o.dry_run) run.notes.push("Dry run: nothing was written but this run row — no registration, no lease, no proposal, no watermark.");

    const status = run.halted !== null ? (run.wrote > 0 ? "partial" : "failed") : runStatus(run.wrote, run.errors);
    if (run.usage.calls > 0) {
      const { error } = await db.from("pb_runs").update({ credits_spent: { model: run.model_used ?? model, ...run.usage } }).eq("id", runId);
      if (error) run.notes.push(`pb_runs(credits_spent): ${error.message}`);
    }
    await finishRun(db, runId, status, { ...run.counters, wrote: run.wrote, errors: run.errors, halted: run.halted !== null ? 1 : 0 }, run.notes);
    const body: Rec = {
      ok: run.errors === 0 && run.halted === null && httpStatus < 400,
      run_id: runId,
      source: MEETING_SOURCE,
      dry_run: o.dry_run,
      extractor: run.model_used || model ? extractorId(run.model_used ?? model, MEETING_PROMPT_VERSION) : null,
      meeting,
      usage: run.usage,
      stopped_early: run.stopped_early,
      halted: run.halted,
      wrote: run.wrote,
      counters: run.counters,
      notes: run.notes,
    };
    if (o.dry_run && proposals !== null) body.proposals = proposals;
    return json(body, httpStatus);
  } catch (e) {
    const message = errorMessage(e);
    await finishRun(db, runId, "failed", run.counters, [...run.notes, message]);
    return json({ ok: false, run_id: runId, source: MEETING_SOURCE, error: message, counters: run.counters, notes: run.notes }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * 1. register
 * ------------------------------------------------------------------ */

/**
 * Every Fathom delivery past the cursor, light columns only, → pb_meetings rows. The cursor then
 * passes every row considered, registered or not. A dry run plans and writes nothing.
 */
async function register(db: DbLike, o: MeetingOptions, run: RunState): Promise<RegistrationPlan> {
  const { data: mark, error: markError } = await db
    .from("pb_source_watermarks").select("last_seen_at,last_seen_id").eq("source", MEETING_SOURCE).maybeSingle();
  if (markError) throw new Error(`pb_source_watermarks: ${markError.message}`);
  const at: string | null = (mark?.last_seen_at as string | null) ?? null;
  const atId: string | null = (mark?.last_seen_id as string | null) ?? null;
  if (!mark) run.notes.push("No pb_source_watermarks row for sales_meeting yet: every stored delivery was considered.");

  /* At or after the cursor's instant, then past it by (time, id) in code — the rule every
     channel's cursor follows, so a delivery sharing the cursor's instant is never skipped. */
  const rows = await selectAll(db, "pb_webhook_inbox", INBOX_LIGHT_SELECT, (q: DbLike) => {
    let x = q.eq("source", "fathom").eq("verified", true);
    if (at !== null) x = x.gte("received_at", at);
    return x.order("received_at", { ascending: true }).order("id", { ascending: true });
  });
  const past = rows.filter((r) => isPastCursor(String(r.received_at ?? ""), String(r.id ?? ""), at, atId));
  const found = inboxCandidates(past as unknown as InboxLightRow[]);
  addCounters(run.counters, found.counters, "register");

  let plan: RegistrationPlan = { inserts: [], updates: [], counters: {} };
  if (found.candidates.length > 0) {
    const ids = found.candidates.map((c) => c.recording_id);
    const byId = await selectIn(db, "pb_meetings", "recording_id", ids, REGISTERED_COLS, 100, "recording_id");
    const dates = heldDates(found.candidates);
    let sameDays: Rec[] = [];
    if (dates.length > 0) {
      const from = `${dates[0]}T00:00:00.000Z`;
      const until = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00.000Z`) + 86_400_000).toISOString();
      sameDays = await selectAll(db, "pb_meetings", REGISTERED_COLS, (q: DbLike) =>
        q.gte("held_at", from).lt("held_at", until).order("recording_id", { ascending: true }));
    }
    const existing = new Map<string, RegisteredMeeting>();
    for (const r of [...byId, ...sameDays]) {
      existing.set(String(r.recording_id), {
        recording_id: String(r.recording_id),
        title_norm: String(r.title_norm ?? ""),
        held_at: (r.held_at as string | null) ?? null,
        ended_at: (r.ended_at as string | null) ?? null,
        status: String(r.status ?? ""),
        include: typeof r.include === "boolean" ? r.include : null,
        duplicate_of: (r.duplicate_of as string | null) ?? null,
        read_started_at: (r.read_started_at as string | null) ?? null,
        progress: r.progress ?? null,
      });
    }
    const rules = (await selectAll(db, "pb_meeting_title_rules", "title_norm,read", (q: DbLike) => q.order("title_norm")))
      .map((r) => ({ title_norm: String(r.title_norm ?? ""), read: r.read === true })) as TitleRule[];
    plan = planRegistration({ candidates: found.candidates, existing: [...existing.values()], rules, now_ms: Date.now() });
    addCounters(run.counters, plan.counters, "register");
  }

  if (o.dry_run) return plan;

  let ok = true;
  if (plan.inserts.length > 0) {
    const { data, error } = await db.from("pb_meetings")
      .upsert(plan.inserts, { onConflict: "recording_id", ignoreDuplicates: true }).select("recording_id");
    if (error) {
      ok = false;
      run.errors++;
      run.notes.push(`pb_meetings (register): ${error.message}`);
    } else {
      const n = Array.isArray(data) ? data.length : 0;
      run.wrote += n;
      run.counters["register.inserted"] = n;
    }
  }
  for (const u of ok ? plan.updates : []) {
    /* Only while the row still holds the status it was planned from: a run that claimed it in
       the meantime has made it 'reading', and then it is not relabelled. */
    const { data, error } = await db.from("pb_meetings").update(u.patch)
      .eq("recording_id", u.recording_id).eq("status", u.from_status).select("recording_id");
    if (error) {
      ok = false;
      run.errors++;
      run.notes.push(`pb_meetings (relabel ${u.recording_id}): ${error.message}`);
      break;
    }
    if (Array.isArray(data) && data.length > 0) { run.wrote += data.length; bump(run.counters, "register.relabelled"); }
  }

  if (ok && found.cursor !== null) {
    const { error } = await db.from("pb_source_watermarks").upsert({
      source: MEETING_SOURCE,
      last_seen_at: found.cursor.at,
      last_seen_id: found.cursor.id,
      last_run_at: new Date().toISOString(),
      note: WATERMARK_NOTE,
    }, { onConflict: "source" });
    if (error) { run.errors++; run.notes.push(`pb_source_watermarks(sales_meeting): ${error.message}`); }
  } else if (!ok) {
    run.notes.push("The registration cursor did not move because a write failed; the same deliveries are considered next run.");
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * 2. claim
 * ------------------------------------------------------------------ */

/**
 * The lease: ONE update that matches only while the row is in `statuses` and its lease is free —
 * never taken, released, or older than LEASE_MS. Two runs racing for one meeting cannot both
 * match: the second update re-reads the row the first wrote and finds the lease taken. Returns
 * the lease (the instant written), which every later write of this run must still find there.
 */
async function claim(db: DbLike, recordingId: string, statuses: readonly string[], reset: boolean): Promise<string | null> {
  const lease = new Date().toISOString();
  const patch: Rec = { status: "reading", read_started_at: lease };
  /* A deliberate re-read starts from nothing: pass 1 again, every agency again. What it spent
     before stays in usage, because that money was spent. */
  if (reset) Object.assign(patch, { mentions: null, progress: null, counts: null, read_at: null, extractor: null });
  const free: Array<(q: DbLike) => DbLike> = [
    (q) => q.is("read_started_at", null),
    (q) => q.lt("read_started_at", leaseCutoff(Date.now())),
  ];
  for (const f of free) {
    const q = f(db.from("pb_meetings").update(patch).eq("recording_id", recordingId).in("status", [...statuses]));
    const { data, error } = await q.select("recording_id");
    if (error) throw new Error(`pb_meetings (lease ${recordingId}): ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return lease;
  }
  return null;
}

interface ReadContext {
  apiKey: string;
  model: string;
  started: number;
  plan: RegistrationPlan;
}

interface ReadNext {
  http: number;
  meeting: Rec | null;
  proposals: ProposalRow[] | null;
}

/** Which meeting this run reads, under a lease (or none, in a dry run), and the read itself. */
async function readNext(db: DbLike, o: MeetingOptions, run: RunState, ctx: ReadContext): Promise<ReadNext> {
  const none = (http: number, meeting: Rec | null = null): ReadNext => ({ http, meeting, proposals: null });

  const { data: rubrics, error: rubricError } = await db.from("pb_rubric_versions").select("version,spec").eq("status", "active");
  if (rubricError) throw new Error(`pb_rubric_versions: ${rubricError.message}`);
  const active = Array.isArray(rubrics) && rubrics.length > 0 ? rubrics[0] : null;
  const vocab = rubricVocabulary(active?.spec);
  if (vocab === null) {
    run.errors++;
    run.notes.push("No active rubric with vocabulary.tiers and override.reason_codes: nothing read, because a tier call could not be checked.");
    return none(200);
  }
  const reasons = (await selectAll(db, "pb_removal_reasons", "disposition,code,label,allows_review_date,active", (q: DbLike) =>
    q.order("disposition").order("code"))) as unknown as RemovalReason[];

  if (Date.now() - ctx.started + FIRST_CALL_GUESS_MS > o.budget_ms) {
    run.stopped_early = true;
    run.counters["stopped_on_time"] = 1;
    run.notes.push(`Registration left too little of the ${Math.round(o.budget_ms / 1000)}s budget for a model call; no meeting was claimed.`);
    return none(200);
  }

  let row: Rec | null = null;
  let lease: string | null = null;

  if (o.recording_id !== null) {
    const { data, error } = await db.from("pb_meetings").select(MEETING_COLS).eq("recording_id", o.recording_id).maybeSingle();
    if (error) throw new Error(`pb_meetings: ${error.message}`);
    row = (data as Rec | null) ?? null;
    if (row === null && o.dry_run) {
      /* A dry run registers nothing, so a recording it has just found is read from the plan. */
      const planned = ctx.plan.inserts.find((r) => String(r.recording_id) === o.recording_id && r.status === "waiting");
      if (planned) row = { ...planned, mentions: null, progress: null, counts: null, usage: null, notes: null, extractor: null };
    }
    if (row === null) {
      run.notes.push(`${o.recording_id}: not registered as an internal meeting with a transcript; nothing read.`);
      return none(404, { recording_id: o.recording_id, read: false });
    }
    const verdict = readVerdict(String(row.status), { reread: o.reread, dry_run: o.dry_run });
    if (!verdict.ok) {
      run.notes.push(`${o.recording_id}: not read — ${verdict.why}.`);
      return none(409, { recording_id: o.recording_id, status: row.status, read: false, why: verdict.why });
    }
    if (!o.dry_run) {
      lease = await claim(db, o.recording_id, o.reread ? REREADABLE_STATUSES : CLAIMABLE_STATUSES, o.reread);
      if (lease === null) {
        run.notes.push(`${o.recording_id}: another run holds its lease; nothing read.`);
        return none(409, { recording_id: o.recording_id, status: row.status, read: false, why: "another run holds its lease" });
      }
    }
  } else {
    const { data, error } = await db.from("pb_meetings")
      .select("recording_id,status,read_started_at")
      .in("status", [...CLAIMABLE_STATUSES])
      .order("held_at", { ascending: true, nullsFirst: false })
      .order("recording_id", { ascending: true })
      .limit(10);
    if (error) throw new Error(`pb_meetings: ${error.message}`);
    const cutoff = Date.parse(leaseCutoff(Date.now()));
    const free = (Array.isArray(data) ? data : []).filter((m: Rec) =>
      m.read_started_at === null || m.read_started_at === undefined || Date.parse(String(m.read_started_at)) < cutoff
    );
    run.counters["queue.claimable_seen"] = free.length;
    let chosen: string | null = null;
    for (const m of free) {
      const id = String(m.recording_id);
      if (o.dry_run) { chosen = id; break; }
      lease = await claim(db, id, CLAIMABLE_STATUSES, false);
      if (lease !== null) { chosen = id; break; }
    }
    if (chosen === null) {
      run.notes.push("No meeting is waiting to be read.");
      return none(200);
    }
    const { data: full, error: fullError } = await db.from("pb_meetings").select(MEETING_COLS).eq("recording_id", chosen).single();
    if (fullError) throw new Error(`pb_meetings: ${fullError.message}`);
    row = full as Rec;
  }

  return await readMeeting(db, o, run, ctx, row as Rec, lease, vocab, reasons);
}

/* ------------------------------------------------------------------ *
 * 3–7. one meeting
 * ------------------------------------------------------------------ */

async function readMeeting(
  db: DbLike,
  o: MeetingOptions,
  run: RunState,
  ctx: ReadContext,
  m: Rec,
  lease: string | null,
  vocab: { tiers: string[]; overrideCodes: string[] },
  reasons: RemovalReason[],
): Promise<ReadNext> {
  const rid = String(m.recording_id);
  const dry = o.dry_run;
  const outOfTime = (need: number) => Date.now() - ctx.started + need > o.budget_ms;

  /* What this run adds to the meeting. A resumed read adds to what is stored; a fresh one or a
     re-read starts its counts again (a re-read's claim already cleared them). */
  const here: Record<string, number> = {};
  const meetingNotes: string[] = [];
  const spend = { usage: m.usage !== null && typeof m.usage === "object" ? addUsage(emptyUsage(), m.usage) : emptyUsage() };
  let baseCounts: Record<string, number> = {};
  const report: Rec = { recording_id: rid, status_before: m.status, read: false };

  /** A write to this meeting that lands only while this run still holds the lease. */
  const guarded = async (patch: Rec): Promise<boolean> => {
    if (dry || lease === null) return true;
    const { data, error } = await db.from("pb_meetings").update(patch)
      .eq("recording_id", rid).eq("read_started_at", lease).select("recording_id");
    if (error) {
      run.errors++;
      run.notes.push(`pb_meetings(${rid}): ${error.message}`);
      return false;
    }
    if (!Array.isArray(data) || data.length === 0) {
      run.counters["lease_lost"] = 1;
      run.notes.push(`${rid}: the lease passed to another run; this run stopped writing.`);
      return false;
    }
    return true;
  };
  const bookkeeping = (): Rec => ({
    counts: addCounters({ ...baseCounts }, here),
    usage: spend.usage,
    notes: appendNotes(m.notes, meetingNotes),
  });
  /** Close this run's part in the meeting: one guarded write, and the run's counters. */
  const settle = (status: string) => {
    addCounters(run.counters, here, "meeting");
    report.status = dry ? `${status} (dry run: not written)` : status;
    report.counts = here;
  };
  const finishWith = async (patch: Rec): Promise<ReadNext> => {
    await guarded({ ...bookkeeping(), ...patch });
    settle(String(patch.status ?? m.status));
    return { http: 200, meeting: report, proposals: dry ? [] : null };
  };

  /* The one body this run reads: the transcript, who was invited and who recorded. Never the
     summary, the highlights or the action items. */
  const { data: inbox, error: inboxError } = await db.from("pb_webhook_inbox")
    .select("transcript:body->transcript,calendar_invitees:body->calendar_invitees,recorded_by:body->recorded_by")
    .eq("id", String(m.inbox_id)).maybeSingle();
  if (inboxError) throw new Error(`pb_webhook_inbox: ${inboxError.message}`);
  if (!inbox) {
    meetingNotes.push(`inbox row ${String(m.inbox_id)} is gone; the meeting cannot be read.`);
    run.notes.push(`${rid}: inbox row ${String(m.inbox_id)} is gone; marked failed.`);
    return await finishWith({ status: "failed", read_started_at: null });
  }

  const tl = transcriptLines((inbox as Rec).transcript);
  here["lines"] = tl.lines.length;
  if (tl.external_speaker) {
    /* Someone outside WLIQ spoke: that is a call, not the team's judgement. */
    run.notes.push(`${rid}: ${tl.external_lines} line(s) spoken by an outside address; skipped.`);
    return await finishWith({ status: "skipped", skip_reason: "external_speaker", read_started_at: null });
  }
  if (tl.lines.length === 0) {
    run.notes.push(`${rid}: the transcript holds no spoken lines; skipped.`);
    return await finishWith({ status: "skipped", skip_reason: "no_transcript", read_started_at: null });
  }

  /* Resume where the last run stopped — with ITS model, because every fingerprint carries the
     extractor id. A dry run always reads from the start: it is a measurement. */
  let clusters: MentionCluster[] | null = null;
  let model = ctx.model;
  let progress: MeetingProgress = { done_refs: [], failed_refs: [] };
  if (!dry && !o.reread) {
    const stored = storedClusters(m.mentions);
    const storedModel = modelFromExtractor(m.extractor);
    if (stored !== null && storedModel !== null && m.progress !== null && m.progress !== undefined) {
      clusters = stored;
      model = storedModel;
      progress = progressOf(m.progress);
      addCounters(baseCounts, m.counts);
      report.resumed = true;
      if (storedModel !== ctx.model) run.notes.push(`${rid}: resumed with the model it was started with, not this run's.`);
    }
  }
  const extractor = extractorId(model, MEETING_PROMPT_VERSION);
  report.extractor = extractor;
  run.model_used = model;

  /* ---------------- pass 1: which companies, on which lines ---------------- */
  if (clusters === null) {
    baseCounts = {};
    const windows = windowsFor(tl.lines);
    here["pass1.windows"] = windows.length;
    const system = segmentPrompt();
    const t1 = Date.now();
    const replies = await inRounds(windows, o.concurrency, async (w) => {
      const lines = tl.lines.filter((l) => l.n >= w.from && l.n <= w.to);
      return { lines, out: await tryCall(ctx.apiKey, model, system, renderLines(lines)) };
    });
    here["ms.pass1"] = Date.now() - t1;

    const mentions: VerifiedMention[] = [];
    let failed: unknown = null;
    for (const [i, x] of replies.entries()) {
      charge(run, spend, x.out);
      if (!x.out.ok) {
        if (failureKind(x.out.e) === "halt") {
          run.halted = `${rid} pass 1: ${failureNote(x.out.e)}`;
          bump(here, "pass1.halted");
        } else if (failed === null) {
          failed = x.out.e;
        }
        continue;
      }
      const v = verifySegments(x.out.r.value, x.lines);
      addCounters(here, v.counters, "pass1");
      meetingNotes.push(...v.notes);
      /* Two windows each number their companies from C1; the window keeps them apart. Mentions of
         one company seen in both are merged by clusterMentions like any other repeat. */
      for (const mm of v.mentions) mentions.push(windows.length > 1 ? { ...mm, ref: `W${i + 1}.${mm.ref}` } : mm);
    }

    if (run.halted !== null) {
      run.notes.push(`HALTED — ${run.halted}. ${rid} goes back to waiting; nothing was marked read.`);
      return await finishWith({ status: "waiting", read_started_at: null });
    }
    if (failed !== null) {
      const why = failureNote(failed);
      bump(here, "pass1.failed");
      meetingNotes.push(`pass 1 came back as ${why}; re-read the meeting deliberately once the cause is fixed.`);
      run.notes.push(`${rid}: pass 1 came back as ${why}; marked failed.`);
      return await finishWith({ status: "failed", read_started_at: null, extractor });
    }

    /* Resolve in code. The roster never reaches the model. */
    const index = await rosterIndex(db, meetingPeople((inbox as Rec).calendar_invitees, (inbox as Rec).recorded_by, tl.speakers));
    clusters = clusterMentions(mentions.map((mm) => resolveMention(mm, index)));
    addCounters(here, mentionCounts(clusters));
    progress = { done_refs: [], failed_refs: [] };

    const stored = await guarded({
      ...bookkeeping(),
      status: "reading",
      extractor,
      speakers: tl.speakers,
      mentions: clusters,
      progress,
    });
    if (!stored) {
      settle(String(m.status));
      return { http: 200, meeting: report, proposals: null };
    }
  } else {
    here["pass1.resumed"] = 1;
  }
  report.mentions = mentionCounts(clusters);

  /* ---------------- pass 2: what was said about each agency ---------------- */
  const plan = planBatches(clusters, tl.lines, { done: [...progress.done_refs, ...progress.failed_refs] });
  report.batches_planned = plan.batches.length;
  here["pass2.batches_planned"] = plan.batches.length;

  let facts: SnapshotFact[] = [];
  let reads: SnapshotRead[] = [];
  let removed: string[] = [];
  const accounts = [...new Set(clusters.filter((c) => c.state === "resolved" && c.account_id).map((c) => String(c.account_id)))];
  if (plan.batches.length > 0 && accounts.length > 0) {
    const snap = await snapshot(db, accounts);
    facts = snap.facts;
    reads = snap.reads;
    removed = snap.removed;
  }

  const system = claimsPrompt({ tiers: vocab.tiers, overrideCodes: vocab.overrideCodes, removalReasons: reasons });
  const dryRows: ProposalRow[] = [];
  let slowest = 0;
  let next = 0;
  let stoppedOnTime = false;
  let interrupted = false;
  const t2 = Date.now();

  while (next < plan.batches.length) {
    const headroom = slowest > 0 ? slowest : FIRST_CALL_GUESS_MS;
    if (outOfTime(headroom)) {
      stoppedOnTime = true;
      run.stopped_early = true;
      run.counters["stopped_on_time"] = 1;
      run.notes.push(
        `${rid}: stopped after ${Math.round((Date.now() - ctx.started) / 1000)}s of a ${Math.round(o.budget_ms / 1000)}s budget with ` +
        `${plan.batches.length - next} of ${plan.batches.length} batch(es) to go; the next run resumes it.`,
      );
      break;
    }
    const round = plan.batches.slice(next, next + o.concurrency);
    next += round.length;
    const tr = Date.now();
    const outs = await Promise.all(round.map(async (b) => ({ b, out: await tryCall(ctx.apiKey, model, system, claimsMessage(b)) })));

    const claims: VerifiedClaim[] = [];
    const doneNow: string[] = [];
    const failedNow: string[] = [];
    let haltedHere = false;
    for (const { b, out } of outs) {
      charge(run, spend, out);
      const refs = b.items.map((it) => it.ref);
      if (!out.ok) {
        if (failureKind(out.e) === "halt") {
          haltedHere = true;
          run.halted = `${rid} batch ${b.index}: ${failureNote(out.e)}`;
          bump(here, "pass2.batch_halted");
          continue;
        }
        failedNow.push(...refs);
        bump(here, "pass2.batch_failed");
        meetingNotes.push(`batch ${b.index} (${refs.join(", ")}) came back as ${failureNote(out.e)}; those agencies were not read.`);
        run.notes.push(`${rid} batch ${b.index} (${refs.join(", ")}): ${failureNote(out.e)}; not read.`);
        continue;
      }
      const v = verifyMeetingClaims(out.r.value, {
        lines: tl.lines,
        batch: b,
        owners: plan.owners,
        tiers: vocab.tiers,
        overrideCodes: vocab.overrideCodes,
        removalReasons: reasons,
      });
      addCounters(here, v.counters, "pass2");
      meetingNotes.push(...v.notes);
      claims.push(...v.claims);
      doneNow.push(...refs);
    }

    const reduced = reduceClaims(claims);
    addCounters(here, reduced.counters, "pass2");
    const rows = proposalRows({
      meeting: { recording_id: rid, title: (m.title as string | null) ?? null, held_at: (m.held_at as string | null) ?? null },
      extractor,
      as_of: o.as_of,
      clusters,
      claims: reduced.claims,
      lines: tl.lines,
      facts,
      reads,
      removed,
      overrideCodes: vocab.overrideCodes,
    });
    addCounters(here, proposalCounts(rows));

    if (dry) {
      dryRows.push(...rows);
    } else if (rows.length > 0) {
      /* The fingerprint makes a re-run free: a row this extractor already proposed is ignored. */
      const { data, error } = await db.from("pb_meeting_proposals")
        .upsert(rows, { onConflict: "fingerprint", ignoreDuplicates: true }).select("id");
      if (error) {
        /* Not marked done: the next run reads these agencies again, and the fingerprint keeps
           whatever did land from landing twice. */
        run.errors++;
        run.notes.push(`pb_meeting_proposals (${rid} batch ${round.map((b) => b.index).join(",")}): ${error.message}`);
        interrupted = true;
        break;
      }
      const n = Array.isArray(data) ? data.length : 0;
      run.wrote += n;
      bump(here, "proposals_written", n);
      /* Newest meeting's word wins per (account, kind, key), whatever order rows were written in. */
      const sup = await db.rpc("pb_meeting_supersede", { p_recording_id: rid });
      if (sup.error) {
        run.errors++;
        run.notes.push(`pb_meeting_supersede(${rid}): ${sup.error.message}`);
      } else {
        bump(here, "proposals_superseded", Number(sup.data) || 0);
      }
    }

    progress = {
      done_refs: [...progress.done_refs, ...doneNow],
      failed_refs: [...progress.failed_refs, ...failedNow],
    };
    if (!(await guarded({ ...bookkeeping(), progress }))) { interrupted = true; break; }
    slowest = Math.max(slowest, Date.now() - tr);
    if (haltedHere) break;
  }
  here["ms.pass2"] = Date.now() - t2;
  report.agencies_read = progress.done_refs.length;
  report.agencies_failed = progress.failed_refs.length;
  const settled = new Set([...progress.done_refs, ...progress.failed_refs]);
  report.batches_left = plan.batches.filter((b) => b.items.some((it) => !settled.has(it.ref))).length;

  if (run.halted !== null) {
    run.notes.push(`HALTED — ${run.halted}. ${rid} goes back to waiting with its progress; nothing was marked read.`);
    const r = await finishWith({ status: "waiting", read_started_at: null });
    return { ...r, proposals: dry ? dryRows : null };
  }
  if (stoppedOnTime || interrupted) {
    /* Still 'reading', progress written, lease left to lapse (LEASE_MS): the next tick claims it
       again and resumes where this run stopped. */
    settle("reading");
    return { http: 200, meeting: report, proposals: dry ? dryRows : null };
  }

  const status = progress.failed_refs.length > 0 ? "partial" : "read";
  report.read = true;
  const r = await finishWith({ status, read_at: new Date().toISOString(), read_started_at: null });
  return { ...r, proposals: dry ? dryRows : null };
}

/* ------------------------------------------------------------------ *
 * the book, as the matcher and the proposals see it
 * ------------------------------------------------------------------ */

/**
 * The roster index for ONE meeting: every account (merged ones too, so they can redirect), the
 * registry's aliases through its resolution, the aliases a person confirmed at an earlier meeting,
 * the junk names and domains, the poison pairs — and this meeting's own people.
 */
async function rosterIndex(db: DbLike, people: string[]) {
  const [accounts, aliases, resolution, learned, junk, poison] = await Promise.all([
    selectAll(db, "pb_accounts", "id,name,domain,book,merged_into", (q: DbLike) => q.order("id")),
    selectAll(db, "pb_mdm_aliases", "slug,alias,alias_type,authoritative", (q: DbLike) => q.order("id")),
    selectAll(db, "pb_mdm_resolution", "account_id,slug", (q: DbLike) => q.order("account_id").order("slug")),
    selectAll(db, "pb_meeting_aliases", "said_key,account_id,active", (q: DbLike) =>
      q.eq("active", true).order("said_key").order("account_id")),
    selectAll(db, "pb_mdm_junk", "kind,value", (q: DbLike) => q.in("kind", ["name", "domain"]).order("id")),
    selectAll(db, "pb_mdm_poison_pairs", "slug_a,slug_b", (q: DbLike) => q.order("id")),
  ]);
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return buildRosterIndex({
    accounts: accounts.map((a) => ({
      id: String(a.id),
      name: str(a.name),
      domain: str(a.domain),
      book: str(a.book),
      merged_into: str(a.merged_into),
    })) as RosterAccount[],
    aliases: aliases.map((a) => ({
      slug: String(a.slug ?? ""),
      alias: String(a.alias ?? ""),
      alias_type: String(a.alias_type ?? ""),
      authoritative: a.authoritative === true,
    })) as MdmAlias[],
    resolution: resolution.map((r) => ({ account_id: str(r.account_id), slug: str(r.slug) })) as MdmResolution[],
    learned: learned.map((l) => ({ said_key: String(l.said_key ?? ""), account_id: String(l.account_id ?? ""), active: l.active !== false })) as LearnedAlias[],
    junk: junk.map((j) => ({ kind: String(j.kind ?? ""), value: String(j.value ?? "") })) as JunkRow[],
    poison_pairs: poison.map((p) => ({ slug_a: String(p.slug_a ?? ""), slug_b: String(p.slug_b ?? "") })) as PoisonPair[],
    people,
  });
}

/**
 * What the book says now about the agencies the meeting resolved: the current facts (rule 9's
 * winners, as pb-score reads them), the current computed and effective tiers, and who is off the
 * board. Display snapshots and status hints only — the decide function re-derives all of it.
 */
async function snapshot(db: DbLike, accounts: string[]): Promise<{ facts: SnapshotFact[]; reads: SnapshotRead[]; removed: string[] }> {
  const [f, r, x] = await Promise.all([
    selectIn(db, "pb_current_facts", "account_id", accounts, "id,account_id,key,value,evidence_label,source", 100, "id"),
    selectIn(db, "pb_current_reads", "account_id", accounts, "account_id,computed_tier,effective_tier", 100, "account_id"),
    selectIn(db, "pb_removals", "account_id", accounts, "account_id", 100, "account_id"),
  ]);
  return {
    facts: f.map((row) => ({
      account_id: String(row.account_id),
      key: String(row.key),
      value: row.value,
      evidence_label: String(row.evidence_label ?? ""),
      source: String(row.source ?? ""),
    })),
    reads: r.map((row) => ({
      account_id: String(row.account_id),
      computed_tier: (row.computed_tier as string | null) ?? null,
      effective_tier: (row.effective_tier as string | null) ?? null,
    })),
    removed: [...new Set(x.map((row) => String(row.account_id)))],
  };
}
