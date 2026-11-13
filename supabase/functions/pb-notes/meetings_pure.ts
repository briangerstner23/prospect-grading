/**
 * pb-notes — the sales-meeting reader's decisions, with no I/O (DECISIONS §65).
 *
 * meetings.ts is the orchestration: it reads rows, calls the model and writes rows. Every choice
 * with a branch in it that is not already in the ingest modules lives here instead, so it runs
 * under Node and meetings_pure_test.ts pins it:
 *
 *   meetingRoute        which path a body takes: the notes sweep, the meeting reader, or a 400
 *   parseMeetingBody    the body's options, refused when contradictory
 *   inboxCandidates     the inbox rows past the cursor → the internal recordings worth registering
 *   planRegistration    those recordings + what pb_meetings already holds → rows to insert, rows to
 *                       relabel 'duplicate', grouped by meeting_transcript.groupRecording
 *   meetingPeople       the names a spoken company may never resolve to (rule: a colleague named
 *                       like an agency is not one)
 *   rubricVocabulary    the active rubric's tiers and override codes, or null
 *   progressOf / storedClusters / modelFromExtractor   what a resumed read picks up
 *   windowMentions      pass 1's window replies → the mentions each supports, refs W<i>.C<n>
 *   clusterWindows      those mentions → resolved in code, joined across windows, one card each
 *   roundHeadroom       what the next round of calls is expected to take, against the budget
 *   callDeadline        the instant a call still running is stopped: the run's ceiling, not its budget
 *   ceilingVerdict      a meeting whose calls keep being stopped there: count the runs, set it aside
 *   failureKind         halt, skip, or out of time: what a failed call means for the meeting
 *   callUsage           what a failed call is counted as: a reply billed, a stopped call, nothing
 *   failureNote         an extractor failure as a note that quotes NOTHING (ids and counts only)
 *   SNAPSHOT_READ_SELECT / snapshotReadOf               the board's tiers per agency, live override included
 *   addUsage / addCounters / proposalCounts            bookkeeping
 *
 * PURE. No clock (`now_ms` and `today` are inputs), no network, no filesystem.
 */

import type { Rec } from "../_shared/helpers.ts";
import { isRec } from "../_shared/helpers.ts";
import { classifyExtractorFailure, compareCursor, MEETING_PROMPT_VERSION, MEETING_SOURCES, timeKey } from "../_shared/ingest/notes_sweep.ts";
import {
  groupRecording,
  internalOnly,
  LOCKED_STATUSES,
  normTitle,
  selectMeeting,
} from "../_shared/ingest/meeting_transcript.ts";
import type { InboxLight, MeetingSpeaker, RecordingSpan, TitleRule } from "../_shared/ingest/meeting_transcript.ts";
import { clusterMentions, joinAcrossWindows, resolveMention, verifySegments } from "../_shared/ingest/meeting_mentions.ts";
import type { MentionCluster, RosterIndex, SpokenLine, VerifiedMention } from "../_shared/ingest/meeting_mentions.ts";
import type { SnapshotRead } from "../_shared/ingest/meeting_claims.ts";
import { ExtractorApiError, ExtractorReplyError, ExtractorTimeoutError } from "./extractor.ts";
import type { ExtractorUsage } from "./extractor.ts";

/* ------------------------------------------------------------------ *
 * the route and the body
 * ------------------------------------------------------------------ */

/**
 * `sources` naming the meeting channel, and only it → the meeting reader. Naming it beside any
 * other channel → "mixed", which the handler answers with a 400. Anything else — no sources at all
 * (the nightly body), or only notes channels — is the notes sweep, exactly as before.
 */
export function meetingRoute(sources: unknown): "notes" | "meetings" | "mixed" {
  if (!Array.isArray(sources) || sources.length === 0) return "notes";
  const names = sources.map(String);
  const meeting = names.filter((s) => MEETING_SOURCES.includes(s));
  if (meeting.length === 0) return "notes";
  return meeting.length === names.length ? "meetings" : "mixed";
}

/** A wall-clock budget the run stops itself inside, as the sweep's. */
export const DEFAULT_BUDGET_MS = 110_000;
/** Pass-2 calls in flight at once. The cron asks for this; more is refused down to it. */
export const MAX_CONCURRENCY = 6;

export interface MeetingOptions {
  /** One recording to read (pb_meetings.recording_id). Absent: the oldest waiting meeting. */
  recording_id: string | null;
  /** Read a meeting already read, partial or failed, from scratch. Needs recording_id. */
  reread: boolean;
  /** Register new recordings and stop: no model call. */
  register_only: boolean;
  /** Read and verify, write nothing but the run row; the proposals come back in the response. */
  dry_run: boolean;
  budget_ms: number;
  concurrency: number;
  /** A model for this run. A resumed read keeps the model it started with. */
  model: string | null;
  /** The read date: what 'historic' is measured against. */
  as_of: string;
}

export type ParsedBody = { ok: true; opts: MeetingOptions; notes: string[] } | { ok: false; error: string };

/** Keys the meeting reader reads. Any other key in the body is ignored and said so. */
export const MEETING_BODY_KEYS: readonly string[] = [
  "sources", "recording_id", "reread", "register_only", "dry_run", "budget_ms", "concurrency", "model", "as_of",
];

function optBool(body: Rec, key: string): boolean | string {
  const v = body[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return `${key} must be true or false`;
}

/**
 * The body → the options, or the reason it is refused. Contradictions are refused rather than
 * guessed at: `reread` names one meeting, so it needs `recording_id`; `register_only` reads
 * nothing, so it takes no `recording_id`.
 */
export function parseMeetingBody(body: Rec, today: string): ParsedBody {
  const b = isRec(body) ? body : {};
  const notes: string[] = [];

  let recording_id: string | null = null;
  const rid = b.recording_id;
  if (typeof rid === "number" && Number.isFinite(rid)) recording_id = String(rid);
  else if (typeof rid === "string" && rid.trim() !== "") recording_id = rid.trim();
  else if (rid !== undefined && rid !== null && rid !== "") return { ok: false, error: "recording_id must be a string or a number" };

  const flags: Record<string, boolean> = {};
  for (const k of ["reread", "register_only", "dry_run"]) {
    const v = optBool(b, k);
    if (typeof v === "string") return { ok: false, error: v };
    flags[k] = v;
  }
  if (flags.reread && recording_id === null) return { ok: false, error: "reread names one meeting: give its recording_id" };
  if (flags.register_only && recording_id !== null) return { ok: false, error: "register_only reads nothing, so it takes no recording_id" };
  if (flags.register_only && flags.reread) return { ok: false, error: "register_only reads nothing, so it cannot reread" };

  let budget_ms = DEFAULT_BUDGET_MS;
  if (b.budget_ms !== undefined && b.budget_ms !== null) {
    if (typeof b.budget_ms !== "number" || !Number.isFinite(b.budget_ms) || b.budget_ms <= 0) {
      return { ok: false, error: "budget_ms must be a positive number of milliseconds" };
    }
    budget_ms = Math.floor(b.budget_ms);
    /* A run longer than its lease loses the meeting to the next tick while it is still writing,
       and what it read is thrown away (lease_lost). */
    if (budget_ms > MAX_BUDGET_MS) {
      notes.push(`budget_ms ${budget_ms} was capped at ${MAX_BUDGET_MS}: the meeting's lease is ${LEASE_MS / 1000}s.`);
      budget_ms = MAX_BUDGET_MS;
    }
  }

  let concurrency = MAX_CONCURRENCY;
  if (b.concurrency !== undefined && b.concurrency !== null) {
    if (typeof b.concurrency !== "number" || !Number.isFinite(b.concurrency) || b.concurrency < 1) {
      return { ok: false, error: "concurrency must be a number from 1 to 6" };
    }
    concurrency = Math.min(MAX_CONCURRENCY, Math.floor(b.concurrency));
    if (b.concurrency > MAX_CONCURRENCY) notes.push(`concurrency ${b.concurrency} was capped at ${MAX_CONCURRENCY}.`);
  }

  let model: string | null = null;
  if (b.model !== undefined && b.model !== null) {
    if (typeof b.model !== "string" || b.model.trim() === "") return { ok: false, error: "model must be a model id" };
    model = b.model.trim();
  }

  let as_of = today;
  if (b.as_of !== undefined && b.as_of !== null) {
    if (typeof b.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.as_of) || timeKey(b.as_of) === "") {
      return { ok: false, error: "as_of must be a date, YYYY-MM-DD" };
    }
    as_of = b.as_of;
  }

  const ignored = Object.keys(b).filter((k) => !MEETING_BODY_KEYS.includes(k)).sort();
  if (ignored.length > 0) notes.push(`Ignored for the meeting reader: ${ignored.join(", ")}.`);

  return {
    ok: true,
    opts: {
      recording_id,
      reread: flags.reread,
      register_only: flags.register_only,
      dry_run: flags.dry_run,
      budget_ms,
      concurrency,
      model,
      as_of,
    },
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

/**
 * The LIGHT columns of a Fathom pb_webhook_inbox row, as PostgREST selects them. Never the
 * transcript: `tx0` is its first line, read for presence only, and nothing of it is stored.
 */
export const INBOX_LIGHT_SELECT = [
  "id",
  "received_at",
  "rid:body->>recording_id",
  "title:body->>title",
  "meeting_title:body->>meeting_title",
  "recording_start_time:body->>recording_start_time",
  "recording_end_time:body->>recording_end_time",
  "url:body->>url",
  "calendar_invitees:body->calendar_invitees",
  "tx0:body->transcript->0",
].join(",");

/** A light inbox row as selected above. */
export interface InboxLightRow extends InboxLight {
  id: string;
  received_at: string;
  meeting_title?: string | null;
}

/** An internal recording with a transcript, not yet known to be registered. */
export interface NewRecording {
  recording_id: string;
  inbox_id: string;
  title: string | null;
  title_norm: string;
  held_at: string | null;
  ended_at: string | null;
  /** The Fathom call url — never share_url, which is a capability link. */
  url: string | null;
}

export interface InboxCandidates {
  candidates: NewRecording[];
  /** The last row considered, in (received_at, id) order: where the cursor moves to. */
  cursor: { at: string; id: string } | null;
  counters: Record<string, number>;
}

function bump(c: Record<string, number>, k: string, by = 1): void {
  c[k] = (c[k] ?? 0) + by;
}

/**
 * The inbox rows past the cursor → the internal recordings with a transcript. The test is
 * meeting_transcript.internalOnly — parseFathomWebhook's own — so the webhook and this reader can
 * never disagree about "internal". A recording delivered twice is one candidate (the later
 * delivery). The cursor passes every row considered, registered or not: a row that is not an
 * internal meeting with a transcript never will be.
 */
export function inboxCandidates(rows: readonly InboxLightRow[]): InboxCandidates {
  const counters: Record<string, number> = {};
  const ordered = [...(rows ?? [])].sort((a, b) =>
    compareCursor(String(a.received_at ?? ""), String(a.id ?? ""), String(b.received_at ?? ""), String(b.id ?? ""))
  );
  const byRecording = new Map<string, NewRecording>();
  for (const r of ordered) {
    bump(counters, "inbox_rows");
    const title = (typeof r.title === "string" && r.title.trim() !== "" ? r.title : null) ??
      (typeof r.meeting_title === "string" && r.meeting_title.trim() !== "" ? r.meeting_title : null);
    const v = internalOnly({ ...r, title });
    if (!v.ok) { bump(counters, `not_registered.${v.why}`); continue; }
    if (byRecording.has(v.recording_id)) bump(counters, "redelivered");
    byRecording.set(v.recording_id, {
      recording_id: v.recording_id,
      inbox_id: String(r.id),
      title,
      title_norm: normTitle(title),
      held_at: timeKey(r.recording_start_time ?? null) || null,
      ended_at: timeKey(r.recording_end_time ?? null) || null,
      url: typeof r.url === "string" && r.url.trim() !== "" ? r.url.trim() : null,
    });
  }
  const last = ordered[ordered.length - 1];
  return {
    candidates: [...byRecording.values()],
    cursor: last ? { at: timeKey(last.received_at) || String(last.received_at), id: String(last.id) } : null,
    counters,
  };
}

/** The UTC dates (YYYY-MM-DD) a set of recordings was held on: which pb_meetings rows to group against. */
export function heldDates(recordings: readonly { held_at: string | null }[]): string[] {
  const out = new Set<string>();
  for (const r of recordings ?? []) {
    const k = timeKey(r.held_at);
    if (k !== "") out.add(k.slice(0, 10));
  }
  return [...out].sort();
}

/** A pb_meetings row, as much of it as registration needs. */
export interface RegisteredMeeting {
  recording_id: string;
  title_norm: string;
  held_at: string | null;
  ended_at: string | null;
  status: string;
  include: boolean | null;
  duplicate_of: string | null;
  read_started_at?: string | null;
  /** pb_meetings.progress: set once pass 1 has stored its mentions. */
  progress?: unknown;
}

/** How long a lease holds. A run's budget is 110 s and its calls stop at 120 s; a lease older than this belongs to a dead run. */
export const LEASE_MS = 150_000;

/** What a run keeps free after its last call stops, for the writes that follow it. */
export const WRITE_MARGIN_MS = 30_000;

/**
 * The longest budget a run may ask for: the call ceiling itself (callDeadline). The budget decides
 * whether a ROUND of calls starts; a round never starts past it.
 */
export const MAX_BUDGET_MS = LEASE_MS - WRITE_MARGIN_MS;

/**
 * When a call that has not answered is stopped (an AbortSignal): the run's start + LEASE_MS − the
 * write margin, WHATEVER the budget. Two limits meet there. The lease is taken after the run starts
 * and lasts LEASE_MS, so a call stopped by then never outlives it; and the API gateway closes a
 * request at 150 s (RUNBOOK §17), so a run cannot outlive that either, and renewing the lease would
 * buy nothing. budget_ms decides whether a round STARTS; it must not also cut short a call that
 * started inside it, because the next run would claim the same meeting (oldest first), start the
 * same call and stop it at the same point — a 115 s pass 1 read on a 110 s budget never finishes,
 * and every meeting behind it waits.
 */
export function callDeadline(startedMs: number): number {
  return startedMs + LEASE_MS - WRITE_MARGIN_MS;
}

/** The instant before which a lease is free. */
export function leaseCutoff(now_ms: number): string {
  return new Date(now_ms - LEASE_MS).toISOString();
}

/**
 * A registered meeting whose representative must not change: read or being read by status, or
 * one that already holds pass-1 mentions (a halted read waits as 'waiting' with its progress), or
 * one under a live lease.
 */
export function isLocked(m: RegisteredMeeting, now_ms: number): boolean {
  if (LOCKED_STATUSES.includes(String(m.status))) return true;
  if (m.progress !== null && m.progress !== undefined) return true;
  const t = m.read_started_at ? Date.parse(timeKey(m.read_started_at)) : NaN;
  return Number.isFinite(t) && now_ms - t < LEASE_MS;
}

export interface RegistrationPlan {
  /** New pb_meetings rows. */
  inserts: Rec[];
  /** Registered rows a new recording displaced: each patch applies only while the row still has `from_status`. */
  updates: Array<{ recording_id: string; from_status: string; patch: Rec }>;
  counters: Record<string, number>;
}

/**
 * The registered rows of one meeting, as an interrupted registration leaves them and nothing else
 * does: two recordings still representatives (the new one was inserted, the one it displaced was
 * never relabelled), or a duplicate of a recording that is itself a duplicate now (its pointer was
 * never moved). False when a duplicate points at a recording that was not handed in — that is not
 * the whole meeting, and nothing is relabelled on a part of one.
 */
function halfRelabelled(members: readonly string[], existing: ReadonlyMap<string, RegisteredMeeting>): boolean {
  const rows = members.map((id) => existing.get(id)).filter((m): m is RegisteredMeeting => m !== undefined);
  const pointsAt = (m: RegisteredMeeting) => (m.status === "duplicate" && m.duplicate_of ? m.duplicate_of : null);
  if (rows.some((m) => pointsAt(m) !== null && !existing.has(pointsAt(m) as string))) return false;
  if (rows.filter((m) => m.status !== "duplicate").length >= 2) return true;
  return rows.some((m) => pointsAt(m) !== null && existing.get(pointsAt(m) as string)?.status === "duplicate");
}

/**
 * New recordings + every pb_meetings row of the dates any of them (or of the registered rows with
 * their ids) was held on → what to write.
 *
 *   · a recording already registered is not inserted again;
 *   · recordings are grouped into meetings by groupRecording (same title, same UTC date, overlap of
 *     at least half the shorter);
 *   · the representative is inserted 'waiting' when selectMeeting selects it, else 'skipped'; a
 *     new representative — or a registered duplicate it promotes — inherits the owner's include
 *     from the one it replaces;
 *   · every other new member is inserted 'duplicate' of the representative, and a registered
 *     member a new, longer recording displaced becomes 'duplicate' too — unless it is locked
 *     (read, being read, or holding mentions), in which case it stays the representative;
 *   · a group with no new member is touched only to finish relabels an earlier run planned and did
 *     not write. meetings.ts writes the inserts first and the relabels after, one by one; when a
 *     relabel fails it keeps the cursor, so the next run is handed the same deliveries — already
 *     registered, no longer new. Their meeting's rows are then half-relabelled (halfRelabelled),
 *     and the relabels planned for them are the ones the earlier run never wrote. Any other group
 *     without a new member is left exactly as it is.
 */
export function planRegistration(input: {
  candidates: readonly NewRecording[];
  existing: readonly RegisteredMeeting[];
  rules: readonly TitleRule[];
  now_ms: number;
}): RegistrationPlan {
  const counters: Record<string, number> = {};
  const existing = new Map<string, RegisteredMeeting>();
  for (const m of input.existing ?? []) existing.set(String(m.recording_id), m);
  const fresh = new Map<string, NewRecording>();
  for (const c of input.candidates ?? []) {
    if (existing.has(c.recording_id)) { bump(counters, "already_registered"); continue; }
    fresh.set(c.recording_id, c);
  }

  const spans: RecordingSpan[] = [];
  for (const m of existing.values()) {
    spans.push({
      recording_id: m.recording_id,
      title_norm: m.title_norm,
      start: m.held_at,
      end: m.ended_at,
      status: isLocked(m, input.now_ms) ? "reading" : m.status,
    });
  }
  for (const c of fresh.values()) {
    spans.push({ recording_id: c.recording_id, title_norm: c.title_norm, start: c.held_at, end: c.ended_at, status: null });
  }

  const inserts: Rec[] = [];
  const updates: Array<{ recording_id: string; from_status: string; patch: Rec }> = [];
  for (const g of groupRecording(spans)) {
    const hasNew = g.members.some((id) => fresh.has(id));
    if (!hasNew && !halfRelabelled(g.members, existing)) continue;
    const planned = updates.length;
    const rep = g.representative;
    /* The meeting's say so far: the include of the registered member that was its representative. */
    const previous = g.members.map((id) => existing.get(id)).find((m) => m !== undefined && m.status !== "duplicate");
    const inherited = previous?.include ?? null;

    const repNew = fresh.get(rep);
    const repOld = existing.get(rep);
    const title = repNew ? repNew.title_norm : repOld ? repOld.title_norm : "";
    /* A duplicate never holds an include of its own (pb_meeting_include refuses one), so one that
       becomes the representative takes the meeting's, as a new representative does. */
    const promoted = repOld !== undefined && repOld.status === "duplicate";
    const include = repNew || promoted ? inherited : repOld?.include ?? null;
    const sel = selectMeeting({ title, include, rules: input.rules });

    for (const id of g.members) {
      const n = fresh.get(id);
      if (n) {
        const isRep = id === rep;
        inserts.push({
          recording_id: n.recording_id,
          inbox_id: n.inbox_id,
          duplicate_of: isRep ? null : rep,
          title: n.title,
          title_norm: n.title_norm,
          held_at: n.held_at,
          ended_at: n.ended_at,
          url: n.url,
          include: isRep ? inherited : null,
          selected_by: sel.selected_by,
          status: isRep ? (sel.selected ? "waiting" : "skipped") : "duplicate",
          skip_reason: isRep ? sel.skip_reason : null,
        });
        bump(counters, isRep ? (sel.selected ? "registered.waiting" : "registered.skipped") : "registered.duplicate");
        continue;
      }
      const m = existing.get(id) as RegisteredMeeting;
      if (id === rep) {
        if (m.status === "duplicate") {
          updates.push({
            recording_id: id,
            from_status: m.status,
            patch: {
              status: sel.selected ? "waiting" : "skipped",
              skip_reason: sel.skip_reason,
              selected_by: sel.selected_by,
              include,
              duplicate_of: null,
            },
          });
          bump(counters, "relabelled.representative");
        }
        continue;
      }
      if (!g.duplicates.includes(id)) continue; // locked: nothing read is relabelled
      if (m.status !== "duplicate" || m.duplicate_of !== rep) {
        updates.push({ recording_id: id, from_status: m.status, patch: { status: "duplicate", duplicate_of: rep, skip_reason: null } });
        bump(counters, m.status === "duplicate" ? "relabelled.duplicate_of" : "relabelled.displaced");
      }
    }
    if (!hasNew && updates.length > planned) bump(counters, "relabelled.unfinished_meeting");
  }
  /* Representatives first, so a duplicate's reference is always to a row the same write holds. */
  inserts.sort((a, b) => (a.status === "duplicate" ? 1 : 0) - (b.status === "duplicate" ? 1 : 0));
  return { inserts, updates, counters };
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

/**
 * Everyone at this meeting, by name: calendar invitees, the recorder and the transcript's
 * speakers. buildRosterIndex refuses any of their words as an agency. Names only — no address is
 * read into the list.
 */
export function meetingPeople(invitees: unknown, recordedBy: unknown, speakers: readonly MeetingSpeaker[]): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (s !== "" && !s.includes("@") && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(invitees)) {
    for (const i of invitees) {
      if (!isRec(i)) continue;
      add(i.name);
      add(i.matched_speaker_display_name);
    }
  }
  if (isRec(recordedBy)) add(recordedBy.name);
  for (const s of speakers ?? []) add(s?.name);
  return out;
}

/**
 * The pb_current_reads columns the snapshot takes for each resolved agency: the two tiers, and the
 * tier of the override the engine APPLIED in that read (scorecard.override.tier, aliased
 * override_tier). Without it an override at the computed tier is invisible — it leaves the effective
 * tier equal to the computed one — and a third tier named under it would be pre-ticked, though
 * approving it ends the person's override (meeting_claims.liveOverrideIn).
 */
export const SNAPSHOT_READ_SELECT = "account_id,computed_tier,effective_tier,override_tier:scorecard->override->>tier";

/** One pb_current_reads row, as SNAPSHOT_READ_SELECT returns it → a SnapshotRead. */
export function snapshotReadOf(row: Rec): SnapshotRead {
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    account_id: String(row.account_id),
    computed_tier: text(row.computed_tier),
    effective_tier: text(row.effective_tier),
    override_tier: text(row.override_tier),
  };
}

/** The active rubric's tiers and override reason codes, or null when it has neither. */
export function rubricVocabulary(spec: unknown): { tiers: string[]; overrideCodes: string[] } | null {
  if (!isRec(spec)) return null;
  const vocab = isRec(spec.vocabulary) ? (spec.vocabulary as Rec) : null;
  const override = isRec(spec.override) ? (spec.override as Rec) : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
  const tiers = strings(vocab?.tiers);
  const overrideCodes = strings(override?.reason_codes);
  if (tiers.length === 0 || overrideCodes.length === 0) return null;
  return { tiers, overrideCodes };
}

/** pb_meetings.progress. */
export interface MeetingProgress {
  done_refs: string[];
  failed_refs: string[];
}

export function progressOf(raw: unknown): MeetingProgress {
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);
  return isRec(raw) ? { done_refs: list(raw.done_refs), failed_refs: list(raw.failed_refs) } : { done_refs: [], failed_refs: [] };
}

/**
 * pb_meetings.mentions as a resumed read takes it: the clusters pass 1 stored, or null when what
 * is stored is not a list of clusters (then pass 1 runs again).
 */
export function storedClusters(raw: unknown): MentionCluster[] | null {
  if (!Array.isArray(raw)) return null;
  for (const c of raw) {
    if (!isRec(c) || typeof c.ref !== "string" || typeof c.state !== "string" || typeof c.said_key !== "string") return null;
    if (!Array.isArray(c.segments) || !Array.isArray(c.said_as) || !Array.isArray(c.options)) return null;
  }
  return raw as MentionCluster[];
}

/**
 * The model a stored extractor id names, when it is this prompt's: 'meeting@v1+<model>' → <model>.
 * A read that resumes keeps its model, because every fingerprint carries the extractor id. Any
 * other prompt version → null: that read is not resumed, it starts again.
 */
export function modelFromExtractor(extractor: unknown): string | null {
  const prefix = `${MEETING_PROMPT_VERSION}+`;
  if (typeof extractor !== "string" || !extractor.startsWith(prefix)) return null;
  const m = extractor.slice(prefix.length);
  return m === "" ? null : m;
}

/** The statuses a named recording can be read from, and what a read of each needs. */
export const CLAIMABLE_STATUSES: readonly string[] = ["waiting", "reading"];
export const REREADABLE_STATUSES: readonly string[] = ["waiting", "reading", "read", "partial", "failed"];

/**
 * May this registered meeting be read now? A duplicate never is (its representative is); a
 * skipped one only once the owner includes it or rules its title in; one already read, partial or
 * failed only on a deliberate `reread` — or in a dry run, which writes nothing.
 */
export function readVerdict(status: string, opts: { reread: boolean; dry_run: boolean }): { ok: true } | { ok: false; why: string } {
  if (status === "duplicate") return { ok: false, why: "it is a duplicate recording: read its representative (duplicate_of)" };
  if (status === "skipped") return { ok: false, why: "it is not selected: the owner includes it (pb_meeting_include) or rules its title in first" };
  if (!REREADABLE_STATUSES.includes(status)) return { ok: false, why: `its status is ${status}` };
  if (!CLAIMABLE_STATUSES.includes(status) && !opts.reread && !opts.dry_run) {
    return { ok: false, why: `it is already ${status}: pass reread:true to read it again` };
  }
  return { ok: true };
}

/** What one round of calls is expected to take before there is a measurement. */
export const FIRST_CALL_GUESS_MS = 60_000;

/**
 * What the next round of calls is expected to take, checked against what is left of the budget
 * before the round starts: the slowest round of this pass so far; before there is one, the first
 * guess — or, for pass 2, the time pass 1 took in this run when that is longer. Pass 1 is one call
 * over the whole transcript, and it is the only measurement of this meeting a first pass-2 round
 * has; a fixed guess shorter than it started rounds the budget could not finish.
 */
export function roundHeadroom(slowestRoundMs: number, earlierPassMs = 0): number {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  if (n(slowestRoundMs) > 0) return n(slowestRoundMs);
  return Math.max(FIRST_CALL_GUESS_MS, n(earlierPassMs));
}

/**
 * How many runs in a row may end with a meeting's calls stopped at the ceiling, and nothing of it
 * settled, before the meeting is set aside. Each such run costs a call's input tokens and settles
 * nothing, and the queue is read oldest first, so without a limit one meeting holds it for good.
 */
export const MAX_CEILING_STOPS = 3;

/** pb_meetings.counts key: the runs in a row that stopped this meeting on time, settling nothing. */
export const CEILING_STOPS_KEY = "ceiling_stops_in_a_row";

/** The streak stored on a meeting's counts; 0 when there is none, or when it is not a count. */
export function ceilingStops(counts: unknown): number {
  const v = isRec(counts) ? counts[CEILING_STOPS_KEY] : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** counts with the streak written in (or taken out at 0). Returns `counts`. */
export function withCeilingStops(counts: Record<string, number>, streak: number): Record<string, number> {
  if (Number.isFinite(streak) && streak > 0) counts[CEILING_STOPS_KEY] = Math.floor(streak);
  else delete counts[CEILING_STOPS_KEY];
  return counts;
}

/**
 * The streak after one run of one meeting, and whether the meeting is set aside now.
 *
 *   settled   what this run made final: pass 1's mentions stored, or an agency read or failed in
 *             pass 2. Any of it, and the streak is 0 — the meeting is moving.
 *   stopped   the run ended on time with this meeting unfinished: a call stopped at the ceiling,
 *             or (pass 1, which keeps nothing until every window is in) a round it could not start.
 *
 * Neither, and the streak stands. set_aside at MAX_CEILING_STOPS: pass 1 is marked 'failed' (a
 * person re-reads it deliberately, with a faster model if need be); in pass 2 the agencies whose
 * calls keep stopping are recorded as failed and the meeting ends 'partial'. Either way the queue
 * moves on, and the meeting's notes say why.
 */
export function ceilingVerdict(prior: number, run: { settled: number; stopped: boolean }): { streak: number; set_aside: boolean } {
  const p = Number.isFinite(prior) && prior > 0 ? Math.floor(prior) : 0;
  const streak = run.settled > 0 ? 0 : run.stopped ? p + 1 : p;
  return { streak, set_aside: streak >= MAX_CEILING_STOPS };
}

/**
 * Does this failure stop the run, or only this call's agencies?
 *
 *   an API refusal       notes_sweep.classifyExtractorFailure decides, as for every channel;
 *   an unusable reply    'skip': it arrived, it was read, and retrying gives the same answer;
 *   the run's ceiling    'out_of_time': the call was still running at callDeadline and was
 *                        stopped (ExtractorTimeoutError). Like stopping before a call, not a
 *                        failure: those agencies are left for the next run, nothing is marked —
 *                        until ceilingVerdict sets the meeting aside;
 *   anything else        'halt': a network failure says nothing about the meeting, so nothing is
 *                        marked failed and the next tick tries again.
 */
export function failureKind(e: unknown): "halt" | "skip" | "out_of_time" {
  if (e instanceof ExtractorTimeoutError) return "out_of_time";
  if (e instanceof ExtractorApiError) return classifyExtractorFailure(e.status, e.message);
  if (e instanceof ExtractorReplyError) return "skip";
  return "halt";
}

/**
 * What a failed call is counted as, on the run and on the meeting. A reply that arrived unusable
 * was billed, and says what it cost. A call stopped at the ceiling was sent and may have been
 * billed for its input; what it cost is unknown, so it counts as one call of no known tokens —
 * a meeting that keeps being stopped shows its calls in credits_spent instead of none. An API
 * refusal is not billed, and nothing else is known: null.
 */
export function callUsage(e: unknown): ExtractorUsage | null {
  if (e instanceof ExtractorReplyError) return e.usage;
  if (e instanceof ExtractorTimeoutError) return { input_tokens: 0, output_tokens: 0 };
  return null;
}

/**
 * An extractor failure as a note. Notes carry ids and counts only, so this never quotes the reply
 * (which would put the meeting's words in pb_runs) and never repeats an API error body.
 */
export function failureNote(e: unknown): string {
  if (e instanceof ExtractorTimeoutError) return "a call stopped at the run's ceiling";
  if (e instanceof ExtractorApiError) return `the extractor API answered ${e.status}`;
  if (e instanceof ExtractorReplyError) {
    return `an unusable reply (${e.reason}, stop_reason ${e.stop_reason ?? "?"}, ${e.text_chars} chars)`;
  }
  if (e instanceof Error) return `a call that failed (${e.name})`;
  return "a call that failed";
}

/* ------------------------------------------------------------------ *
 * bookkeeping
 * ------------------------------------------------------------------ */

/** pb_meetings.usage and pb_runs.credits_spent. */
export interface MeetingUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export function emptyUsage(): MeetingUsage {
  return { calls: 0, input_tokens: 0, output_tokens: 0 };
}

/** usage + one call's tokens (or + a stored usage block). Never throws on a malformed side. */
export function addUsage(a: MeetingUsage, b: ExtractorUsage | MeetingUsage | unknown, calls = 1): MeetingUsage {
  const r = isRec(b) ? b : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const c = typeof r.calls === "number" ? n(r.calls) : calls;
  return { calls: a.calls + c, input_tokens: a.input_tokens + n(r.input_tokens), output_tokens: a.output_tokens + n(r.output_tokens) };
}

/** Add `more` into `into`, every key under `prefix.` when one is given. Returns `into`. */
export function addCounters(into: Record<string, number>, more: Record<string, number> | unknown, prefix = ""): Record<string, number> {
  if (!isRec(more)) return into;
  for (const [k, v] of Object.entries(more)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    into[key] = (into[key] ?? 0) + v;
  }
  return into;
}

/** Proposal rows → counts by status and by kind, for pb_meetings.counts and the run. */
export function proposalCounts(rows: readonly { status: string; kind: string; default_selected?: boolean }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of rows ?? []) {
    bump(c, `proposals.${r.status}`);
    bump(c, `proposals.kind.${r.kind}`);
    if (r.default_selected) bump(c, "proposals.pre_ticked");
  }
  return c;
}

/* ------------------------------------------------------------------ *
 * pass 1 across windows
 * ------------------------------------------------------------------ */

/** One pass-1 window that answered: where it sits in windowsFor's list, its lines, its parsed reply. */
export interface WindowReply {
  /** 0-based, in windowsFor's order. */
  window: number;
  lines: readonly SpokenLine[];
  value: unknown;
}

export interface WindowMentions {
  /** Per window, in window order: the mentions its reply supports. */
  perWindow: VerifiedMention[][];
  /** verifySegments' counters, summed over the windows. */
  counters: Record<string, number>;
  notes: string[];
}

/**
 * The windows that answered → what each supports (verifySegments, against that window's lines only).
 * Past one window, every window numbers its companies from C1, so each ref carries its window:
 * W2.C1. One window keeps the model's own refs, exactly as before windows existed.
 */
export function windowMentions(replies: readonly WindowReply[], windowCount: number): WindowMentions {
  const n = Math.max(1, Math.floor(windowCount));
  const perWindow: VerifiedMention[][] = Array.from({ length: n }, () => []);
  const counters: Record<string, number> = {};
  const notes: string[] = [];
  for (const x of replies ?? []) {
    if (!Number.isInteger(x.window) || x.window < 0 || x.window >= n) continue;
    const v = verifySegments(x.value, x.lines);
    addCounters(counters, v.counters);
    notes.push(...v.notes);
    for (const mm of v.mentions) perWindow[x.window].push(n > 1 ? { ...mm, ref: `W${x.window + 1}.${mm.ref}` } : mm);
  }
  return { perWindow, counters, notes };
}

/**
 * Pass 1's mentions → the meeting's agency cards. Resolved in code against the roster (resolveMention),
 * then joined across windows (meeting_mentions.joinAcrossWindows: a company one window heard only by a
 * short form, placed by the name another window heard), then clustered one card per account or per
 * spoken name, in discussion order (clusterMentions). One window is never joined: it comes back as
 * clusterMentions(resolveMention) always gave it.
 */
export function clusterWindows(perWindow: readonly (readonly VerifiedMention[])[], index: RosterIndex): {
  clusters: MentionCluster[];
  counters: Record<string, number>;
} {
  const resolved = (perWindow ?? []).map((ms) => (ms ?? []).map((m) => resolveMention(m, index)));
  const joined = joinAcrossWindows(resolved, index);
  return { clusters: clusterMentions(joined.resolutions), counters: joined.counters };
}

/** Mentions by state, for the meeting header's counts. */
export function mentionCounts(clusters: readonly { state: string }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const m of clusters ?? []) bump(c, `mentions.${m.state}`);
  return c;
}

/** Keep a meeting's notes bounded: the newest `max`. */
export function appendNotes(stored: unknown, more: readonly string[], max = 40): string[] {
  const prior = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
  return [...prior, ...more].slice(-max);
}
