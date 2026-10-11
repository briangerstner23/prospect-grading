/**
 * WLIQ Prospect Book — an internal sales meeting, as a numbered transcript (DECISIONS §65).
 *
 * The sales team's daily meeting is where the book is reviewed, and what is said there is the
 * team's judgement from its research. pb-fathom-webhook already stores every internal recording in
 * full in pb_webhook_inbox (service role only) and writes no pb_calls row for it; this module is
 * everything about turning one of those stored deliveries into something a reader can be held to:
 *
 *   · WHICH recordings are read — internal only, by the webhook parser's own test (internalOnly),
 *     selected by the owner, a title rule or a title pattern (selectMeeting), and one recording per
 *     meeting when several people recorded it (groupRecording);
 *   · WHAT was said, line by line — numbered lines with deterministic S1..Sn speaker labels and no
 *     addresses (transcriptLines, renderLines), split into model-sized windows (windowsFor) and
 *     cut into one agency's excerpt (excerptFor);
 *   · and the one guarantee every later step leans on: a quote is only a quote if it lies inside
 *     ONE speaker's consecutive lines of OUR transcript (quoteInLines). The summary Fathom writes is
 *     never read — it drops and misstates agencies in a multi-agency meeting.
 *
 * PURE. No clock (every time is an input), no network, no filesystem, no model call.
 * Imports only ./fathom_webhook.ts and ./notes_sweep.ts. Runs under Deno and
 * `node --experimental-strip-types`.
 */

import { INTERNAL_DOMAINS, parseFathomWebhook } from "./fathom_webhook.ts";
import type { FathomInvitee, FathomWebhookPayload } from "./fathom_webhook.ts";
import { earlierRecording, normalizeForQuote, timeKey } from "./notes_sweep.ts";

/* ------------------------------------------------------------------ *
 * the channel
 * ------------------------------------------------------------------ */

/** pb_facts.source, pb_runs.source and the pb_source_watermarks row of this channel. */
export const MEETING_SOURCE = "sales_meeting";

/**
 * A meeting is read by default when its title says it is about sales. Precedence is in
 * selectMeeting: the owner's say for one meeting, then the owner's rule for a title, then these.
 * "prospect" is a prefix on purpose (prospects, prospecting); the other two are whole words.
 */
export const MEETING_TITLE_PATTERNS: readonly RegExp[] = [/\bsales\b/i, /\bprospect/i, /\bgrading\b/i];

/** A title as pb_meetings.title_norm and pb_meeting_title_rules.title_norm hold it. */
export function normTitle(title: unknown): string {
  return String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/* ------------------------------------------------------------------ *
 * which recordings
 * ------------------------------------------------------------------ */

/**
 * The LIGHT columns pb-notes selects from a Fathom pb_webhook_inbox row to register it — never
 * the transcript itself. `tx0` is body->'transcript'->0, read for its presence only.
 */
export interface InboxLight {
  id?: string | null;
  received_at?: string | null;
  /** body->>'recording_id' */
  rid?: string | number | null;
  title?: string | null;
  recording_start_time?: string | null;
  recording_end_time?: string | null;
  url?: string | null;
  calendar_invitees?: unknown;
  tx0?: unknown;
}

export type InternalVerdict =
  | { ok: true; recording_id: string }
  | { ok: false; why: "missing_recording_id" | "external" | "not_identified" | "no_transcript"; detail: string };

/**
 * Is this delivery an INTERNAL meeting with a transcript? The test is parseFathomWebhook's own —
 * skip_reason 'internal only' means every calendar invitee was identified and every one is
 * internal, by Fathom's is_external flag or by INTERNAL_DOMAINS — reused on a stub of the light
 * columns rather than restated, so the webhook and this reader can never disagree about what
 * "internal" means.
 *
 * The stub carries no transcript, so a delivery with no invitees cannot fall back to its speakers:
 * zero invitees is "nobody identified", never "everybody internal" (rule 5).
 */
export function internalOnly(row: InboxLight, opts: { internal_domains?: string[] } = {}): InternalVerdict {
  const invitees = Array.isArray(row?.calendar_invitees) ? (row.calendar_invitees as FathomInvitee[]) : [];
  const stub: FathomWebhookPayload = {
    recording_id: row?.rid ?? null,
    title: row?.title ?? null,
    calendar_invitees: invitees,
  };
  const parsed = parseFathomWebhook(stub, [], { internal_domains: opts.internal_domains });
  if (parsed.skip_reason === "missing recording id") {
    return { ok: false, why: "missing_recording_id", detail: "the delivery carries no recording id" };
  }
  if (parsed.skip_reason === null) {
    return { ok: false, why: "external", detail: "someone outside WLIQ was invited" };
  }
  if (parsed.skip_reason !== "internal only") {
    return { ok: false, why: "not_identified", detail: "not every invitee could be identified as internal" };
  }
  if (row?.tx0 === null || row?.tx0 === undefined) {
    return { ok: false, why: "no_transcript", detail: "the delivery carries no transcript" };
  }
  return { ok: true, recording_id: parsed.call.fathom_recording_id };
}

export type SelectedBy = "owner" | "title_rule" | "pattern" | "none";

/** One pb_meeting_title_rules row. */
export interface TitleRule {
  title_norm: string;
  read: boolean;
}

export interface MeetingSelection {
  selected: boolean;
  /** pb_meetings.selected_by: who decided. */
  selected_by: SelectedBy;
  /** pb_meetings.skip_reason when it is not selected; null when it is. */
  skip_reason: "not_selected" | "owner_excluded" | null;
}

/**
 * Is this meeting read? The owner's say for THIS meeting (pb_meetings.include) beats the owner's
 * rule for its exact title (pb_meeting_title_rules), which beats MEETING_TITLE_PATTERNS. Nothing
 * said is "not selected".
 */
export function selectMeeting(input: {
  title: string | null | undefined;
  include?: boolean | null;
  rules?: readonly TitleRule[] | null;
}): MeetingSelection {
  if (input.include === true) return { selected: true, selected_by: "owner", skip_reason: null };
  if (input.include === false) return { selected: false, selected_by: "owner", skip_reason: "owner_excluded" };
  const t = normTitle(input.title);
  const rule = (input.rules ?? []).find((r) => normTitle(r.title_norm) === t);
  if (rule) {
    return rule.read
      ? { selected: true, selected_by: "title_rule", skip_reason: null }
      : { selected: false, selected_by: "title_rule", skip_reason: "not_selected" };
  }
  if (t !== "" && MEETING_TITLE_PATTERNS.some((p) => p.test(t))) {
    return { selected: true, selected_by: "pattern", skip_reason: null };
  }
  return { selected: false, selected_by: "none", skip_reason: "not_selected" };
}

/* ------------------------------------------------------------------ *
 * one recording per meeting
 * ------------------------------------------------------------------ */

/** What groupRecording needs of a recording, new or already in pb_meetings. */
export interface RecordingSpan {
  recording_id: string;
  title_norm: string;
  /** recording_start_time, ISO. */
  start: string | null;
  /** recording_end_time, ISO. */
  end: string | null;
  /** pb_meetings.status when it is already registered; absent for a new delivery. */
  status?: string | null;
}

export interface RecordingGroup {
  /** The recording that is read for this meeting. */
  representative: string;
  /** Every recording of the meeting, the representative included, earliest id first. */
  members: string[];
  /** The members that are pb_meetings 'duplicate' of the representative. */
  duplicates: string[];
  /** True when the meeting was already read (or is being read): its representative never changes. */
  locked: boolean;
}

/** A meeting in one of these states has been read, so a later recording can only be its duplicate. */
export const LOCKED_STATUSES: readonly string[] = ["reading", "read", "partial"];

/** Two recordings are one meeting when their intervals overlap by at least this share of the shorter. */
export const MIN_OVERLAP_SHARE = 0.5;

interface Span {
  rec: RecordingSpan;
  start: number;
  end: number;
  day: string;
  valid: boolean;
}

function spanOf(r: RecordingSpan): Span {
  const s = timeKey(r.start);
  const e = timeKey(r.end);
  const start = s === "" ? NaN : Date.parse(s);
  const end = e === "" ? NaN : Date.parse(e);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  return { rec: r, start, end, day: s.slice(0, 10), valid };
}

/** Longest coverage first; a tie goes to the earliest recording id. */
function better(a: Span, b: Span): boolean {
  const da = a.valid ? a.end - a.start : -1;
  const db = b.valid ? b.end - b.start : -1;
  if (da !== db) return da > db;
  return earlierRecording(String(a.rec.recording_id), String(b.rec.recording_id));
}

/**
 * Which recordings are one MEETING, and which of them is read.
 *
 * Fathom issues one recording per recorder, so a meeting three of the team recorded arrives three
 * times. Recordings are one meeting when they share the normalised title and the UTC date and
 * their [start, end] intervals overlap by at least half of the shorter one — measured on the two
 * stored sales duplicates (recorders a minute apart; a late joiner at 51 minutes). Overlap, not
 * fathom_webhook.meetingKey's day|title|, because an internal meeting has no external attendees to
 * key on and three same-title, same-day internal meetings that never overlapped are three meetings.
 *
 * The representative is the longest recording, ties to the earliest id — unless the meeting is
 * already read: then its representative stands and anything new is a duplicate, never re-read.
 * A recording with no end time (or no start) is never grouped; it stays its own meeting.
 *
 * Pass every recording of the dates in question, registered or new; groups come back earliest
 * meeting first.
 */
export function groupRecording(recordings: readonly RecordingSpan[]): RecordingGroup[] {
  const spans = (recordings ?? []).map(spanOf);
  const parent = spans.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      if (!a.valid || !b.valid) continue;
      if (a.rec.title_norm !== b.rec.title_norm || a.day !== b.day) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      const shorter = Math.min(a.end - a.start, b.end - b.start);
      if (shorter > 0 && overlap >= MIN_OVERLAP_SHARE * shorter) parent[find(j)] = find(i);
    }
  }

  const byRoot = new Map<number, Span[]>();
  spans.forEach((s, i) => {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(s);
    else byRoot.set(r, [s]);
  });

  const groups: Array<RecordingGroup & { at: number }> = [];
  for (const members of byRoot.values()) {
    const locked = members.filter((m) => LOCKED_STATUSES.includes(String(m.rec.status ?? "")));
    const pool = locked.length > 0 ? locked : members;
    let rep = pool[0];
    for (const m of pool) if (better(m, rep)) rep = m;
    const ids = members.map((m) => String(m.rec.recording_id))
      .sort((x, y) => (x === y ? 0 : earlierRecording(x, y) ? -1 : 1));
    const lockedIds = new Set(locked.map((m) => String(m.rec.recording_id)));
    const repId = String(rep.rec.recording_id);
    groups.push({
      representative: repId,
      members: ids,
      // A second member that was ALSO already read keeps its own status: nothing read is relabelled.
      duplicates: ids.filter((id) => id !== repId && !lockedIds.has(id)),
      locked: locked.length > 0,
      at: Math.min(...members.map((m) => (Number.isFinite(m.start) ? m.start : Infinity))),
    });
  }
  groups.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : earlierRecording(a.representative, b.representative) ? -1 : 1));
  return groups.map(({ at: _at, ...g }) => g);
}

/* ------------------------------------------------------------------ *
 * the transcript, line by line
 * ------------------------------------------------------------------ */

/** One spoken line. `n` is the line number every model reply cites and every check reads. */
export interface TranscriptLine {
  n: number;
  /** HH:MM:SS from the start of the recording. */
  at: string;
  seconds: number | null;
  /** S1..Sn, by first appearance. Never a name, never an address. */
  speaker: string;
  text: string;
}

/** A line as rendered for a model; `context` marks padding around an agency's own lines. */
export interface RenderLine {
  n: number;
  at: string;
  speaker: string;
  text: string;
  context?: boolean;
}

/** pb_meetings.speakers: the label and the display name. No addresses. */
export interface MeetingSpeaker {
  label: string;
  name: string | null;
}

export interface TranscriptRead {
  lines: TranscriptLine[];
  speakers: MeetingSpeaker[];
  /** A speaker matched to an address outside INTERNAL_DOMAINS: the meeting is skipped. */
  external_speaker: boolean;
  external_lines: number;
  notes: string[];
}

/** Seconds from "HH:MM:SS", "MM:SS" (fractions dropped) or a number of seconds; null otherwise. */
export function clockSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,]\d+)?$/);
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** "HH:MM:SS" for a number of seconds. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function emailHost(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase().replace(/^www\./, "") || null;
}

/**
 * A display name as pb_meetings.speakers may hold it: an address inside it is cut to its local
 * part, the dossier's own scrub (§43a). Fathom shows the address where it has no name — measured
 * on 28 of 78,042 stored lines, 10 Oct 2026 — and pb_meetings.speakers carries names, never
 * addresses.
 */
export function speakerNameOf(name: string | null): string | null {
  if (name === null) return null;
  const out = name.replace(/([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "$1").trim();
  return out === "" ? null : out;
}

/**
 * Body->transcript → numbered lines. Lines with no text are dropped before numbering, so a line
 * number is stable for a given payload. Speakers get S1, S2 … in order of first appearance, keyed
 * by their matched invitee address when Fathom has one and by display name when it does not.
 *
 * A speaker matched to an address OUTSIDE INTERNAL_DOMAINS flags external_speaker, and the caller
 * skips the meeting: an outsider's words are a call, not the team's judgement. A speaker Fathom
 * could not match to anyone is allowed — every invitee was already found internal.
 */
export function transcriptLines(transcript: unknown, opts: { internal_domains?: readonly string[] } = {}): TranscriptRead {
  const notes: string[] = [];
  const internal = new Set<string>(INTERNAL_DOMAINS);
  for (const d of opts.internal_domains ?? []) {
    const h = String(d ?? "").trim().toLowerCase().replace(/^www\./, "");
    if (h) internal.add(h);
  }
  if (!Array.isArray(transcript)) {
    if (transcript !== null && transcript !== undefined) notes.push("transcript is not a list of lines; nothing read");
    return { lines: [], speakers: [], external_speaker: false, external_lines: 0, notes };
  }

  const labelByKey = new Map<string, string>();
  const speakers: MeetingSpeaker[] = [];
  const lines: TranscriptLine[] = [];
  let externalLines = 0;
  let lastSeconds: number | null = null;

  for (const raw of transcript) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = String(r.text ?? "").replace(/\s+/g, " ").trim();
    if (text === "") continue;

    const sp = r.speaker;
    let name: string | null = null;
    let email: string | null = null;
    if (sp !== null && typeof sp === "object") {
      const o = sp as Record<string, unknown>;
      name = typeof o.display_name === "string" && o.display_name.trim() ? o.display_name.trim()
        : typeof o.name === "string" && o.name.trim() ? o.name.trim() : null;
      const e = o.matched_calendar_invitee_email ?? o.email;
      email = typeof e === "string" && e.includes("@") ? e.trim().toLowerCase() : null;
    } else if (typeof sp === "string" && sp.trim()) {
      name = sp.trim();
    }
    const key = email !== null ? `email:${email}` : name !== null ? `name:${name.toLowerCase()}` : "unknown";
    let label = labelByKey.get(key);
    if (label === undefined) {
      label = `S${labelByKey.size + 1}`;
      labelByKey.set(key, label);
      speakers.push({ label, name: speakerNameOf(name) });
    }
    if (email !== null) {
      const host = emailHost(email);
      if (host === null || !internal.has(host)) externalLines++;
    }

    const parsed = clockSeconds(r.timestamp);
    const seconds = parsed ?? lastSeconds;
    if (parsed !== null) lastSeconds = parsed;
    lines.push({ n: lines.length + 1, at: clockText(seconds ?? 0), seconds, speaker: label, text });
  }

  if (externalLines > 0) notes.push(`${externalLines} line(s) spoken by someone matched to an address outside WLIQ`);
  return { lines, speakers, external_speaker: externalLines > 0, external_lines: externalLines, notes };
}

/** "L0412" — the label a model cites a line by. */
export function lineLabel(n: number): string {
  return `L${String(n).padStart(4, "0")}`;
}

function renderLine(l: RenderLine): string {
  return `${lineLabel(l.n)} [${l.at}] ${l.speaker}${l.context ? " (context)" : ""}: ${l.text}`;
}

/** 'L0412 [00:31:07] S2: text', one per line; a context line reads 'S2 (context):'. Stable. */
export function renderLines(lines: readonly RenderLine[]): string {
  return (lines ?? []).map(renderLine).join("\n");
}

/** An inclusive range of line numbers. */
export interface LineRange {
  from: number;
  to: number;
}

/** Pass 1 reads the whole meeting in one call unless the rendered text is longer than this. */
export const PASS1_WINDOW_CHARS = 160000;
/** Consecutive pass-1 windows share this many lines, so a discussion on the seam is seen whole. */
export const PASS1_WINDOW_OVERLAP = 40;

/**
 * The line ranges pass 1 reads, each rendering to at most `max_chars`, never splitting a line,
 * consecutive ranges overlapping by `overlap` lines. One range when the meeting fits.
 */
export function windowsFor(
  lines: readonly TranscriptLine[],
  opts: { max_chars?: number; overlap?: number } = {},
): LineRange[] {
  const list = lines ?? [];
  if (list.length === 0) return [];
  const max = opts.max_chars ?? PASS1_WINDOW_CHARS;
  const overlap = Math.max(0, opts.overlap ?? PASS1_WINDOW_OVERLAP);
  const sizes = list.map((l) => renderLine(l).length + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= max + 1) return [{ from: list[0].n, to: list[list.length - 1].n }];

  const out: LineRange[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    let acc = 0;
    while (j < list.length && (j === i || acc + sizes[j] <= max + 1)) {
      acc += sizes[j];
      j++;
    }
    out.push({ from: list[i].n, to: list[j - 1].n });
    if (j >= list.length) break;
    i = Math.max(i + 1, j - overlap);
  }
  return out;
}

/** One line of an agency's excerpt: its own (owned) line, or padding around it. */
export interface ExcerptLine extends TranscriptLine {
  context: boolean;
}

export interface Excerpt {
  lines: ExcerptLine[];
  /** Every line inside the agency's segments, shown or not — what its quotes must lie within. */
  owned: number[];
  /** True when the cap cut lines out. */
  capped: boolean;
  dropped: number;
}

export const EXCERPT_PAD_LINES = 3;
export const EXCERPT_MAX_CHARS = 6000;

/**
 * One agency's excerpt: the lines of its segments, padded by `pad` context lines either side, and
 * at most `max_chars` rendered. Over the cap the padding goes first, then the EARLIEST owned
 * lines — the end of a discussion is where the team says what it decided ("if they change their
 * minds, report only the final position").
 */
export function excerptFor(
  lines: readonly TranscriptLine[],
  segments: readonly LineRange[],
  opts: { pad?: number; max_chars?: number } = {},
): Excerpt {
  const pad = Math.max(0, opts.pad ?? EXCERPT_PAD_LINES);
  const max = opts.max_chars ?? EXCERPT_MAX_CHARS;
  const byN = new Map<number, TranscriptLine>();
  for (const l of lines ?? []) byN.set(l.n, l);

  const owned = new Set<number>();
  for (const s of segments ?? []) {
    for (let n = Math.floor(s.from); n <= Math.floor(s.to); n++) if (byN.has(n)) owned.add(n);
  }
  const context = new Set<number>();
  for (const s of segments ?? []) {
    for (let k = 1; k <= pad; k++) {
      for (const n of [Math.floor(s.from) - k, Math.floor(s.to) + k]) {
        if (byN.has(n) && !owned.has(n)) context.add(n);
      }
    }
  }

  let shown: ExcerptLine[] = [...owned, ...context]
    .sort((a, b) => a - b)
    .map((n) => ({ ...(byN.get(n) as TranscriptLine), context: context.has(n) }));
  const size = (xs: readonly ExcerptLine[]) => renderLines(xs).length;
  const before = shown.length;
  let capped = false;
  if (size(shown) > max) {
    capped = true;
    shown = shown.filter((l) => !l.context);
    while (shown.length > 0 && size(shown) > max) shown = shown.slice(1);
  }
  return { lines: shown, owned: [...owned].sort((a, b) => a - b), capped, dropped: before - shown.length };
}

/* ------------------------------------------------------------------ *
 * the guarantee
 * ------------------------------------------------------------------ */

export const QUOTE_MIN_CHARS = 12;
export const QUOTE_MAX_CHARS = 600;
export const QUOTE_MAX_LINES = 6;

export type QuoteCheck =
  | { ok: true; line_from: number; line_to: number; speaker: string; quote_at: string }
  | { ok: false; why: "too_short" | "too_long" | "bad_range" | "too_many_lines" | "not_in_lines" | "two_speakers" };

/**
 * Is `quote` really in lines line_from..line_to of OUR transcript, spoken by one person?
 *
 * After normalizeForQuote the quote must be 12–600 characters and a substring of those lines
 * joined; the cited range must exist and span at most 6 lines. The range is then tightened to the
 * smallest run of lines that still holds the quote, and every line of that run must be one
 * speaker's. The returned line_from, line_to, speaker and quote_at are OURS — taken from the line,
 * never from the model.
 */
export function quoteInLines(
  lines: readonly TranscriptLine[],
  claim: { quote: unknown; line_from: unknown; line_to: unknown },
): QuoteCheck {
  const q = normalizeForQuote(typeof claim.quote === "string" ? claim.quote : "");
  if (q.length < QUOTE_MIN_CHARS) return { ok: false, why: "too_short" };
  if (q.length > QUOTE_MAX_CHARS) return { ok: false, why: "too_long" };
  const from = Number(claim.line_from);
  const to = Number(claim.line_to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return { ok: false, why: "bad_range" };

  const byN = new Map<number, TranscriptLine>();
  for (const l of lines ?? []) byN.set(l.n, l);
  for (let n = from; n <= Math.min(to, from + QUOTE_MAX_LINES); n++) if (!byN.has(n)) return { ok: false, why: "bad_range" };
  if (to - from + 1 > QUOTE_MAX_LINES) return { ok: false, why: "too_many_lines" };

  const joined = (a: number, b: number): string => {
    const parts: string[] = [];
    for (let n = a; n <= b; n++) parts.push((byN.get(n) as TranscriptLine).text);
    return normalizeForQuote(parts.join(" "));
  };
  if (!joined(from, to).includes(q)) return { ok: false, why: "not_in_lines" };

  let best: LineRange = { from, to };
  for (let a = from; a <= to; a++) {
    for (let b = a; b <= to; b++) {
      if (b - a >= best.to - best.from) break;
      if (joined(a, b).includes(q)) {
        best = { from: a, to: b };
        break;
      }
    }
  }
  const first = byN.get(best.from) as TranscriptLine;
  for (let n = best.from; n <= best.to; n++) {
    if ((byN.get(n) as TranscriptLine).speaker !== first.speaker) return { ok: false, why: "two_speakers" };
  }
  return { ok: true, line_from: best.from, line_to: best.to, speaker: first.speaker, quote_at: first.at };
}
