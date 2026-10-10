/**
 * pb-notes — the sales-meeting reader's pure decisions, and the shared extractor's salvage, tests.
 *
 * Run:  node --experimental-strip-types supabase/functions/pb-notes/meetings_pure_test.ts
 *
 * Deno is not installed in the build container, so meetings.ts (the orchestration) cannot run
 * here. Every decision it makes that is not already in the ingest modules lives in
 * meetings_pure.ts and is exercised below; the orchestration itself is pinned by text — which
 * tables it may write, which it may never name, and that the notes sweep cannot reach it.
 *
 * Every recording, title, agency and person here is INVENTED (rule 2). People are roles; outside
 * domains are .example.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addCounters,
  addUsage,
  appendNotes,
  CLAIMABLE_STATUSES,
  DEFAULT_BUDGET_MS,
  emptyUsage,
  failureKind,
  failureNote,
  heldDates,
  INBOX_LIGHT_SELECT,
  inboxCandidates,
  isLocked,
  LEASE_MS,
  leaseCutoff,
  MAX_CONCURRENCY,
  meetingPeople,
  meetingRoute,
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
import type { InboxLightRow, NewRecording, RegisteredMeeting } from "./meetings_pure.ts";
import { ExtractorApiError, ExtractorReplyError, parseReplyJson, replyText, usageOf } from "./extractor.ts";
import { extractorId, MEETING_PROMPT_VERSION, PROMPT_VERSION } from "../_shared/ingest/notes_sweep.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, f), "utf8");

/** The source with its comments taken out, so a pin on CODE is not satisfied or broken by prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/* ------------------------------------------------------------------ *
 * 1 · the route
 * ------------------------------------------------------------------ */

eq("route: no sources (the nightly body) is the notes sweep", meetingRoute(undefined), "notes");
eq("route: an empty list is the notes sweep", meetingRoute([]), "notes");
eq("route: notes channels only", meetingRoute(["fathom_call", "website"]), "notes");
eq("route: sales_meeting alone", meetingRoute(["sales_meeting"]), "meetings");
eq("route: sales_meeting named twice is still alone", meetingRoute(["sales_meeting", "sales_meeting"]), "meetings");
eq("route: sales_meeting beside another channel is refused", meetingRoute(["sales_meeting", "fathom_call"]), "mixed");
eq("route: a non-array sources is the notes sweep (as before)", meetingRoute("sales_meeting"), "notes");

/* ------------------------------------------------------------------ *
 * 2 · the body
 * ------------------------------------------------------------------ */

{
  const p = parseMeetingBody({ sources: ["sales_meeting"] }, "2026-10-10");
  check("body: the bare body parses", p.ok);
  if (p.ok) {
    eq("body: defaults", p.opts, {
      recording_id: null, reread: false, register_only: false, dry_run: false,
      budget_ms: DEFAULT_BUDGET_MS, concurrency: MAX_CONCURRENCY, model: null, as_of: "2026-10-10",
    });
    eq("body: no notes for a clean body", p.notes, []);
  }
  eq("body: the default budget is the sweep's 110 s", DEFAULT_BUDGET_MS, 110_000);
  eq("body: at most six calls at once", MAX_CONCURRENCY, 6);
}
{
  const p = parseMeetingBody({ sources: ["sales_meeting"], recording_id: 5001, dry_run: true, budget_ms: 140000.7, concurrency: 9, model: " model-x ", as_of: "2026-10-01" }, "2026-10-10");
  check("body: a full body parses", p.ok);
  if (p.ok) {
    eq("body: a numeric recording id becomes text", p.opts.recording_id, "5001");
    eq("body: budget floored", p.opts.budget_ms, 140000);
    eq("body: concurrency capped at six", p.opts.concurrency, 6);
    check("body: the cap is said", p.notes.some((n) => n.includes("capped")));
    eq("body: model trimmed", p.opts.model, "model-x");
    eq("body: as_of kept", p.opts.as_of, "2026-10-01");
    eq("body: dry run", p.opts.dry_run, true);
  }
}
{
  const bad: Array<[string, Record<string, unknown>]> = [
    ["reread without a recording", { reread: true }],
    ["register_only with a recording", { register_only: true, recording_id: "5001" }],
    ["a string budget", { budget_ms: "fast" }],
    ["a zero budget", { budget_ms: 0 }],
    ["zero concurrency", { concurrency: 0 }],
    ["a non-boolean dry_run", { dry_run: "yes" }],
    ["an object recording id", { recording_id: { id: 1 } }],
    ["an empty model", { model: " " }],
    ["a bad as_of", { as_of: "10/10/2026" }],
  ];
  for (const [name, body] of bad) {
    const p = parseMeetingBody({ sources: ["sales_meeting"], ...body }, "2026-10-10");
    check(`body: refused — ${name}`, !p.ok);
  }
  const p = parseMeetingBody({ sources: ["sales_meeting"], max_notes: 5, since: null }, "2026-10-10");
  check("body: notes-sweep keys are ignored and said so", p.ok && p.notes.some((n) => n.includes("max_notes") && n.includes("since")));
}

/* ------------------------------------------------------------------ *
 * 3 · registration: which inbox rows, and the cursor
 * ------------------------------------------------------------------ */

const REP_A = { name: "Rep A", email: "rep-a@whitelabeliq.com", is_external: false };
const REP_B = { name: "Rep B", email: "rep-b@whitelabeliq.com", matched_speaker_display_name: "Rep B" };
const OWNER = { name: "Owner", email: "owner@whitelabeliq.com", is_external: false };
const FIRST_LINE = { speaker: { display_name: "Rep A" }, text: "Morning.", timestamp: "00:00:01" };

const row = (o: Partial<InboxLightRow> & { id: string; received_at: string }): InboxLightRow => ({
  rid: 5001,
  title: "Sales Standing Connect",
  recording_start_time: "2026-10-09T19:03:00Z",
  recording_end_time: "2026-10-09T19:59:00Z",
  url: "https://fathom.example/calls/5001",
  calendar_invitees: [REP_A, REP_B, OWNER],
  tx0: FIRST_LINE,
  ...o,
});

{
  const rows: InboxLightRow[] = [
    row({ id: "b0000000-0000-0000-0000-000000000002", received_at: "2026-10-09T20:01:00.000Z", rid: 5002, title: null, meeting_title: "Daily Stand Up" }),
    row({ id: "a0000000-0000-0000-0000-000000000001", received_at: "2026-10-09T20:01:00.000Z", rid: 5001 }),
    row({ id: "c0000000-0000-0000-0000-000000000003", received_at: "2026-10-09T20:02:00.000Z", rid: 6001, calendar_invitees: [REP_A, { name: "Founder", email: "founder@northgale.example" }] }),
    row({ id: "d0000000-0000-0000-0000-000000000004", received_at: "2026-10-09T20:03:00.000Z", rid: 6002, tx0: null }),
    row({ id: "e0000000-0000-0000-0000-000000000005", received_at: "2026-10-09T20:04:00.000Z", rid: 6003, calendar_invitees: [] }),
    row({ id: "f0000000-0000-0000-0000-000000000006", received_at: "2026-10-09T20:05:00.000Z", rid: null }),
    row({ id: "f1000000-0000-0000-0000-000000000007", received_at: "2026-10-09T20:06:00.000Z", rid: 5001, url: "https://fathom.example/calls/5001?again" }),
  ];
  const r = inboxCandidates(rows);
  eq("inbox: only internal recordings with a transcript, once each", r.candidates.map((c) => c.recording_id).sort(), ["5001", "5002"]);
  eq("inbox: the cursor is the last row considered, by (received_at, id)", r.cursor, { at: "2026-10-09T20:06:00.000Z", id: "f1000000-0000-0000-0000-000000000007" });
  eq("inbox: an outside invitee is not registered", r.counters["not_registered.external"], 1);
  eq("inbox: no transcript is not registered", r.counters["not_registered.no_transcript"], 1);
  eq("inbox: zero invitees is not internal (rule 5)", r.counters["not_registered.not_identified"], 1);
  eq("inbox: a missing recording id is not registered", r.counters["not_registered.missing_recording_id"], 1);
  eq("inbox: a redelivery is counted", r.counters.redelivered, 1);
  const again = r.candidates.find((c) => c.recording_id === "5001") as NewRecording;
  eq("inbox: the later delivery wins", again.inbox_id, "f1000000-0000-0000-0000-000000000007");
  const standup = r.candidates.find((c) => c.recording_id === "5002") as NewRecording;
  eq("inbox: the title falls back to meeting_title", standup.title, "Daily Stand Up");
  eq("inbox: title_norm", standup.title_norm, "daily stand up");
  eq("inbox: held_at is one spelling", standup.held_at, "2026-10-09T19:03:00.000Z");
  eq("inbox: nothing considered, no cursor", inboxCandidates([]).cursor, null);
}

check("inbox select: light columns only — the transcript's first line, never the whole of it", /tx0:body->transcript->0$/.test(INBOX_LIGHT_SELECT) && !/transcript(,|$)/.test(INBOX_LIGHT_SELECT));
for (const never of ["default_summary", "share_url", "action_items", "highlights"]) {
  check(`inbox select: never ${never}`, !INBOX_LIGHT_SELECT.includes(never));
}
eq("heldDates: distinct UTC dates, sorted", heldDates([{ held_at: "2026-10-09T23:30:00-02:00" }, { held_at: "2026-10-09T19:03:00Z" }, { held_at: null }]), ["2026-10-09", "2026-10-10"]);

/* ------------------------------------------------------------------ *
 * 4 · registration: one recording per meeting
 * ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-10T12:00:00Z");
const rec = (id: string, o: Partial<NewRecording> = {}): NewRecording => ({
  recording_id: id,
  inbox_id: `inbox-${id}`,
  title: "Sales Standing Connect",
  title_norm: "sales standing connect",
  held_at: "2026-10-09T19:00:00.000Z",
  ended_at: "2026-10-09T20:00:00.000Z",
  url: `https://fathom.example/calls/${id}`,
  ...o,
});
const reg = (id: string, o: Partial<RegisteredMeeting> = {}): RegisteredMeeting => ({
  recording_id: id,
  title_norm: "sales standing connect",
  held_at: "2026-10-09T19:00:00.000Z",
  ended_at: "2026-10-09T19:50:00.000Z",
  status: "waiting",
  include: null,
  duplicate_of: null,
  read_started_at: null,
  progress: null,
  ...o,
});
const byId = (rows: Record<string, unknown>[], id: string) => rows.find((r) => r.recording_id === id) as Record<string, unknown>;

{
  const p = planRegistration({
    candidates: [rec("7001"), rec("7002", { held_at: "2026-10-09T19:01:00.000Z", ended_at: "2026-10-09T19:58:00.000Z" })],
    existing: [],
    rules: [],
    now_ms: NOW,
  });
  eq("register: two recorders a minute apart are one meeting", p.inserts.length, 2);
  eq("register: the longest is read", byId(p.inserts, "7001").status, "waiting");
  eq("register: the other is its duplicate", [byId(p.inserts, "7002").status, byId(p.inserts, "7002").duplicate_of], ["duplicate", "7001"]);
  eq("register: representatives are written first", p.inserts[0].recording_id, "7001");
  eq("register: selected by the title pattern", byId(p.inserts, "7001").selected_by, "pattern");
  eq("register: an insert carries exactly the registration columns", Object.keys(byId(p.inserts, "7001")).sort(), [
    "duplicate_of", "ended_at", "held_at", "inbox_id", "include", "recording_id", "selected_by", "skip_reason", "status", "title", "title_norm", "url",
  ]);
  eq("register: nothing registered is relabelled", p.updates, []);
}
{
  const p = planRegistration({
    candidates: [rec("7101", { title: "Daily Stand Up", title_norm: "daily stand up" }), rec("7102", { title: "Post-Sales Review", title_norm: "post-sales review", held_at: "2026-10-09T21:00:00.000Z", ended_at: "2026-10-09T21:30:00.000Z" })],
    existing: [],
    rules: [{ title_norm: "post-sales review", read: false }],
    now_ms: NOW,
  });
  eq("register: a stand-up is skipped, not selected", [byId(p.inserts, "7101").status, byId(p.inserts, "7101").skip_reason, byId(p.inserts, "7101").selected_by], ["skipped", "not_selected", "none"]);
  eq("register: the owner's title rule beats the pattern", [byId(p.inserts, "7102").status, byId(p.inserts, "7102").selected_by], ["skipped", "title_rule"]);
}
{
  /* A longer recording arrives for a meeting that is registered but not yet read. */
  const p = planRegistration({
    candidates: [rec("7202", { held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T20:10:00.000Z" })],
    existing: [reg("7201", { include: true, selected_by: "owner" } as Partial<RegisteredMeeting>), reg("7200", { status: "duplicate", duplicate_of: "7201", ended_at: "2026-10-09T19:40:00.000Z" })],
    rules: [],
    now_ms: NOW,
  });
  eq("register: the new, longer recording is read instead", byId(p.inserts, "7202").status, "waiting");
  eq("register: it inherits the owner's include", [byId(p.inserts, "7202").include, byId(p.inserts, "7202").selected_by], [true, "owner"]);
  const displaced = p.updates.find((u) => u.recording_id === "7201");
  eq("register: the waiting one it displaced becomes its duplicate", displaced && { from: displaced.from_status, patch: displaced.patch }, { from: "waiting", patch: { status: "duplicate", duplicate_of: "7202", skip_reason: null } });
  const moved = p.updates.find((u) => u.recording_id === "7200");
  eq("register: an older duplicate now points at the new representative", moved?.patch.duplicate_of, "7202");
}
{
  const late = rec("7302", { held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T20:30:00.000Z" });
  for (const [name, existing] of [
    ["read", reg("7301", { status: "read" })],
    ["being read", reg("7301", { status: "reading", read_started_at: "2026-10-10T11:59:30.000Z" })],
    ["holding pass-1 mentions after a halt", reg("7301", { status: "waiting", progress: { done_refs: [], failed_refs: [] } })],
    ["under a live lease", reg("7301", { status: "waiting", read_started_at: "2026-10-10T11:59:00.000Z" })],
  ] as Array<[string, RegisteredMeeting]>) {
    const p = planRegistration({ candidates: [late], existing: [existing], rules: [], now_ms: NOW });
    eq(`register: a meeting ${name} keeps its representative; the late one is a duplicate`, [byId(p.inserts, "7302").status, byId(p.inserts, "7302").duplicate_of], ["duplicate", "7301"]);
    eq(`register: a meeting ${name} is not relabelled`, p.updates, []);
  }
  const stale = planRegistration({ candidates: [late], existing: [reg("7301", { status: "waiting", read_started_at: "2026-10-10T11:50:00.000Z" })], rules: [], now_ms: NOW });
  eq("register: a lapsed lease does not lock a waiting meeting", byId(stale.inserts, "7302").status, "waiting");
}
{
  const p = planRegistration({
    candidates: [rec("7401"), rec("7402", { held_at: "2026-10-09T02:00:00.000Z", ended_at: "2026-10-09T02:30:00.000Z" })],
    existing: [reg("7401", { status: "read" }), reg("7499", { status: "waiting", held_at: "2026-10-09T15:00:00.000Z", ended_at: "2026-10-09T15:30:00.000Z" })],
    rules: [],
    now_ms: NOW,
  });
  eq("register: an already-registered recording is left alone", p.counters.already_registered, 1);
  eq("register: same title, same day, no overlap → its own meeting", byId(p.inserts, "7402").status, "waiting");
  check("register: a group with no new member is never touched", !p.updates.some((u) => u.recording_id === "7499") && !byId(p.inserts, "7499"));
  const noEnd = planRegistration({ candidates: [rec("7501", { ended_at: null }), rec("7502")], existing: [], rules: [], now_ms: NOW });
  eq("register: a recording with no end time is never grouped", [byId(noEnd.inserts, "7501").status, byId(noEnd.inserts, "7502").status], ["waiting", "waiting"]);
}

eq("lease: 150 s", LEASE_MS, 150_000);
eq("lease: the cutoff", leaseCutoff(NOW), "2026-10-10T11:57:30.000Z");
check("lease: a fresh lease locks", isLocked(reg("1", { read_started_at: "2026-10-10T11:59:59.000Z" }), NOW));
check("lease: a lapsed lease does not", !isLocked(reg("1", { read_started_at: "2026-10-10T11:57:00.000Z" }), NOW));
check("lease: partial is locked", isLocked(reg("1", { status: "partial" }), NOW));
check("lease: skipped is not", !isLocked(reg("1", { status: "skipped" }), NOW));

/* ------------------------------------------------------------------ *
 * 5 · reading
 * ------------------------------------------------------------------ */

eq("people: invitee names, matched names, the recorder and the speakers — never an address", meetingPeople(
  [REP_A, REP_B, { name: "ops@whitelabeliq.com", email: "ops@whitelabeliq.com" }, "junk"],
  { name: "Owner", email: "owner@whitelabeliq.com" },
  [{ label: "S1", name: "Rep A" }, { label: "S2", name: "Rep C" }, { label: "S3", name: null }],
), ["Rep A", "Rep B", "Owner", "Rep C"]);
eq("people: nothing given, nobody", meetingPeople(null, null, []), []);

{
  const spec = { vocabulary: { tiers: ["Tier-A", "Tier-B", "Tier-C"] }, override: { reason_codes: ["code_a", "code_b"], expiry_default_days: 30 } };
  eq("rubric: tiers and codes from the spec", rubricVocabulary(spec), { tiers: ["Tier-A", "Tier-B", "Tier-C"], overrideCodes: ["code_a", "code_b"] });
  eq("rubric: no tiers → nothing is read", rubricVocabulary({ override: { reason_codes: ["x"] } }), null);
  eq("rubric: no codes → nothing is read", rubricVocabulary({ vocabulary: { tiers: ["Tier-A"] } }), null);
  eq("rubric: no spec", rubricVocabulary(null), null);
}

eq("progress: normalised", progressOf({ done_refs: ["A1", "A1", 3, "A2"], failed_refs: "A3" }), { done_refs: ["A1", "A2"], failed_refs: [] });
eq("progress: none", progressOf(null), { done_refs: [], failed_refs: [] });

{
  const cluster = { ref: "A1", state: "resolved", account_id: "acct-q", matched_on: "name", options: ["acct-q"], reason: null, said_as: ["Quillfeather"], said_key: "quillfeather", segments: [{ from: 3, to: 9 }], mention_lines: [3], first_line: 3, sources: ["C1"] };
  eq("stored clusters: a list of clusters is resumed", storedClusters([cluster])?.length, 1);
  eq("stored clusters: an empty list is resumed (nothing was discussed)", storedClusters([])?.length, 0);
  eq("stored clusters: anything else is read again", [storedClusters(null), storedClusters({ clusters: [] }), storedClusters([{ ref: "A1" }])], [null, null, null]);
}

eq("extractor: a meeting read resumes with its own model", modelFromExtractor(extractorId("model-x", MEETING_PROMPT_VERSION)), "model-x");
eq("extractor: the notes prompt is not this one", modelFromExtractor(extractorId("model-x", PROMPT_VERSION)), null);
eq("extractor: nothing stored", modelFromExtractor(null), null);
eq("extractor: an older meeting prompt is not resumed", modelFromExtractor("meeting@v0+model-x"), null);

{
  eq("verdict: waiting is read", readVerdict("waiting", { reread: false, dry_run: false }), { ok: true });
  eq("verdict: a lapsed reading is read", readVerdict("reading", { reread: false, dry_run: false }), { ok: true });
  for (const s of ["read", "partial", "failed"]) {
    check(`verdict: ${s} needs reread`, !readVerdict(s, { reread: false, dry_run: false }).ok);
    check(`verdict: ${s} with reread is read`, readVerdict(s, { reread: true, dry_run: false }).ok);
    check(`verdict: ${s} may be dry-run`, readVerdict(s, { reread: false, dry_run: true }).ok);
  }
  for (const s of ["duplicate", "skipped"]) {
    check(`verdict: ${s} is never read, reread or not`, !readVerdict(s, { reread: true, dry_run: false }).ok && !readVerdict(s, { reread: false, dry_run: true }).ok);
  }
  check("verdict: an unknown status is refused", !readVerdict("archived", { reread: true, dry_run: true }).ok);
  eq("verdict: the claimable statuses", CLAIMABLE_STATUSES, ["waiting", "reading"]);
  check("verdict: every claimable status is re-readable", CLAIMABLE_STATUSES.every((s) => REREADABLE_STATUSES.includes(s)));
}

{
  const SENTINEL = "the Quillfeather owner said forty seats";
  eq("failure: a 429 halts", failureKind(new ExtractorApiError(429, "{}")), "halt");
  eq("failure: a 529 halts", failureKind(new ExtractorApiError(529, "{}")), "halt");
  eq("failure: a 400 about credit halts", failureKind(new ExtractorApiError(400, "Your credit balance is too low")), "halt");
  eq("failure: a 400 about this request skips", failureKind(new ExtractorApiError(400, "messages: too long")), "skip");
  eq("failure: an unusable reply skips", failureKind(new ExtractorReplyError("no JSON", "no_json", "end_turn", 10, { input_tokens: 1, output_tokens: 1 })), "skip");
  eq("failure: a network error halts (it says nothing about the meeting)", failureKind(new TypeError("error sending request")), "halt");
  const notes = [
    failureNote(new ExtractorApiError(400, `{"error":"${SENTINEL}"}`)),
    failureNote(new ExtractorReplyError(`no JSON in the reply: ${SENTINEL}`, "no_json", "max_tokens", 4100, { input_tokens: 1, output_tokens: 1 })),
    failureNote(new Error(SENTINEL)),
    failureNote(SENTINEL),
  ];
  check("failure: a note never quotes the reply, the API body or the message", notes.every((n) => !n.includes("Quillfeather") && !n.includes("forty")), JSON.stringify(notes));
  eq("failure: the API note says the status", notes[0], "the extractor API answered 400");
  eq("failure: the reply note says why in counts", notes[1], "an unusable reply (no_json, stop_reason max_tokens, 4100 chars)");
}

/* ------------------------------------------------------------------ *
 * 6 · bookkeeping
 * ------------------------------------------------------------------ */

{
  let u = emptyUsage();
  u = addUsage(u, { input_tokens: 1200, output_tokens: 300 });
  u = addUsage(u, { input_tokens: 800.9, output_tokens: -5 });
  eq("usage: one call each, tokens summed, nonsense dropped", u, { calls: 2, input_tokens: 2000, output_tokens: 300 });
  eq("usage: a stored block carries its own call count", addUsage(emptyUsage(), { calls: 5, input_tokens: 10, output_tokens: 20 }), { calls: 5, input_tokens: 10, output_tokens: 20 });
  eq("counters: added under a prefix", addCounters({ "pass1.x": 1 }, { x: 2, y: 3, z: "no" }, "pass1"), { "pass1.x": 3, "pass1.y": 3 });
  eq("counters: a non-object adds nothing", addCounters({ a: 1 }, null), { a: 1 });
  eq("proposals: counted by status and kind", proposalCounts([
    { status: "proposed", kind: "fact", default_selected: true },
    { status: "agrees", kind: "override" },
    { status: "not_proposed", kind: "fact" },
  ]), { "proposals.proposed": 1, "proposals.kind.fact": 2, "proposals.pre_ticked": 1, "proposals.agrees": 1, "proposals.kind.override": 1, "proposals.not_proposed": 1 });
  eq("mentions: counted by state", mentionCounts([{ state: "resolved" }, { state: "unknown" }, { state: "resolved" }]), { "mentions.resolved": 2, "mentions.unknown": 1 });
  eq("notes: bounded to the newest", appendNotes(["a", "b", 3], ["c", "d"], 3), ["b", "c", "d"]);
}

/* ------------------------------------------------------------------ *
 * 7 · the extractor's salvage, moved out of index.ts unchanged
 * ------------------------------------------------------------------ */

{
  eq("salvage: plain JSON", parseReplyJson('{"claims":[]}', "end_turn"), { ok: true, value: { claims: [] } });
  eq("salvage: JSON inside prose", parseReplyJson('Here you go:\n{"claims":[{"a":1}]}\nDone.', "end_turn"), { ok: true, value: { claims: [{ a: 1 }] } });
  /* As index.ts always did it: the outermost {…} ends at the last "}", and the array is closed
     after the last "}," inside that — so the entry the cut ran into is never trusted. */
  eq("salvage: a reply cut off mid-array keeps the entries before the cut", parseReplyJson('{"claims":[{"a":1},{"b":2},{"c":', "max_tokens"), { ok: true, value: { claims: [{ a: 1 }] } });
  eq("salvage: a cut inside a later entry keeps both earlier ones", parseReplyJson('{"claims":[{"a":1},{"b":2},{"c":{"d":1}, "e', "max_tokens"), { ok: true, value: { claims: [{ a: 1 }, { b: 2 }] } });
  const none = parseReplyJson("I could not find anything.", "end_turn");
  eq("salvage: no JSON says why, in the words index.ts always used", none, {
    ok: false, reason: "no_json", message: "no JSON in the reply (stop_reason end_turn, 26 chars of text): I could not find anything.",
  });
  const unknownStop = parseReplyJson("", undefined);
  check("salvage: an unknown stop_reason prints as ?", !unknownStop.ok && unknownStop.message.startsWith("no JSON in the reply (stop_reason ?, 0 chars of text)"));
  const broken = parseReplyJson("{not json}", "end_turn");
  check("salvage: unparseable JSON is not_json", !broken.ok && broken.reason === "not_json" && broken.message.startsWith("reply was not JSON ("));
  eq("reply text: text blocks joined, thinking left out", replyText({ content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "{" }, { type: "text", text: "}" }] }), "{}");
  eq("reply text: no content", replyText({}), "");
  eq("usage: from the reply", usageOf({ usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 } }), { input_tokens: 10, output_tokens: 4 });
  eq("usage: none reported", usageOf({}), { input_tokens: 0, output_tokens: 0 });
  check("errors: an unusable reply is still an Error with the old message", new ExtractorReplyError("m", "no_json", null, 0, { input_tokens: 0, output_tokens: 0 }) instanceof Error);
  eq("errors: the API error's message is unchanged", new ExtractorApiError(429, "x".repeat(300)).message, `extractor returned 429: ${"x".repeat(200)}`);
}

/* ------------------------------------------------------------------ *
 * 8 · the orchestration, pinned by text
 * ------------------------------------------------------------------ */

{
  const meetings = read("meetings.ts");
  const pure = read("meetings_pure.ts");
  const index = read("index.ts");
  const extractor = read("extractor.ts");
  const mc = code(meetings);

  /* What it writes: four tables, by name, and nothing else. */
  const writes = new Set<string>();
  for (const m of mc.matchAll(/\.from\("([a-z_]+)"\)\s*\.(insert|upsert|update|delete)\(/g)) writes.add(m[1]);
  eq("meetings.ts writes only pb_meetings, pb_meeting_proposals, pb_source_watermarks and pb_runs", [...writes].sort(), [
    "pb_meeting_proposals", "pb_meetings", "pb_runs", "pb_source_watermarks",
  ]);
  check("meetings.ts never deletes", !/\.delete\(/.test(mc));
  const rpcs = [...mc.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
  eq("meetings.ts calls one function: the supersession", [...new Set(rpcs)], ["pb_meeting_supersede"]);
  check("meetings.ts upserts proposals on the fingerprint, ignoring duplicates", /pb_meeting_proposals"\)\s*\.upsert\(rows, \{ onConflict: "fingerprint", ignoreDuplicates: true \}\)/.test(mc));
  check("meetings.ts upserts the watermark of its own source only", /source: MEETING_SOURCE,\s*last_seen_at: found\.cursor\.at/.test(mc));
  check("meetings.ts opens its run as kind ingest, source sales_meeting", /startRun\(db, "ingest", MEETING_SOURCE,/.test(mc) && /closeAbandonedRuns\(db, MEETING_SOURCE\)/.test(mc));
  check("meetings.ts records credits_spent", /credits_spent:/.test(mc));

  /* What it may never name — not as a write, not at all (DECISIONS §65: a meeting claim waits
     in pb_meeting_proposals and reaches the book only through the decide function). */
  for (const t of ["pb_facts", "pb_register", "pb_fact_candidates", "pb_calls", "pb_signals", "pb_contact_events"]) {
    const re = new RegExp(`\\b${t}\\b`);
    check(`meetings.ts never names ${t}`, !re.test(meetings));
    check(`meetings_pure.ts never names ${t}`, !re.test(pure));
  }
  for (const never of ["default_summary", "share_url", "action_items", "highlights"]) {
    check(`meetings.ts never selects ${never}`, !new RegExp(`body->>?${never}`).test(mc));
  }
  check("meetings.ts reads the inbox only through the light select and one body", (mc.match(/from\("pb_webhook_inbox"\)/g) ?? []).length === 1 && /selectAll\(db, "pb_webhook_inbox", INBOX_LIGHT_SELECT/.test(mc));

  /* The lease: one conditional update, and every later write holds it. */
  check("the claim matches only a free lease", /\.is\("read_started_at", null\)/.test(mc) && /\.lt\("read_started_at", leaseCutoff\(Date\.now\(\)\)\)/.test(mc));
  check("every write to a claimed meeting is guarded by the lease", /\.eq\("recording_id", rid\)\.eq\("read_started_at", lease\)/.test(mc));
  check("a halt sends the meeting back to waiting and releases the lease", (mc.match(/status: "waiting", read_started_at: null/g) ?? []).length >= 2);

  /* The route: the nightly sweep cannot reach it, and it cannot be half-honoured. */
  check("index.ts routes through meetingRoute before the sweep starts its run", index.indexOf("meetingRoute(body.sources)") > 0 &&
    index.indexOf("meetingRoute(body.sources)") < index.indexOf('startRun(db, "ingest", "written_record"'));
  check("index.ts answers a mixed sources list with a 400", /route === "mixed"[\s\S]{0,300}?400\)/.test(index));
  check("index.ts: consider() never registers the meeting source", /const consider = [\s\S]{0,400}?if \(MEETING_SOURCES\.includes\(source\)\) return;/.test(index));

  /* One model call, in one place, shaped as it always was. */
  check("extractor.ts is the only place pb-notes calls the API", !/api\.anthropic\.com/.test(index) && !/api\.anthropic\.com/.test(meetings) && /api\.anthropic\.com\/v1\/messages/.test(extractor));
  check("extractor.ts keeps max_tokens 16000", /max_tokens: 16000/.test(extractor));
  check("extractor.ts sends no temperature", !/temperature\s*:/.test(code(extractor)));
  check("index.ts reads a record through callExtractor", /callExtractor\(apiKey, model, extractionPrompt\(planned\.note\.source\), `<record>\\n\$\{planned\.text\}\\n<\/record>`\)/.test(index));

  /* Pure means pure. */
  for (const [name, src] of [["meetings_pure.ts", pure]] as Array<[string, string]>) {
    const c = code(src);
    check(`${name} reads no clock`, !/Date\.now\(|new Date\(\)/.test(c));
    check(`${name} makes no request`, !/\bfetch\(/.test(c));
    check(`${name} imports no jsr: or npm:`, !/from "(jsr|npm):/.test(c));
    check(`${name} imports no db client`, !/_shared\/db\.ts/.test(c));
  }
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`meetings_pure_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("meetings_pure_test failed");
  }
} else {
  console.log(`meetings_pure_test: ${passed} checks passed`);
}
