/**
 * WLIQ Prospect Book — the internal sales meeting as a numbered transcript, tests.
 *
 * Run:  node --experimental-strip-types ingest/meeting_transcript_test.ts
 *
 * Every meeting, agency and line here is INVENTED (rule 2). People appear only as roles
 * ('Rep A', 'Rep B', 'Owner'); the internal domain is WLIQ's own, which is configuration. The
 * recording ids are small made-up numbers, never a real Fathom id.
 */

import {
  clockSeconds,
  clockText,
  excerptFor,
  groupRecording,
  internalOnly,
  lineLabel,
  MEETING_SOURCE,
  MEETING_TITLE_PATTERNS,
  normTitle,
  quoteInLines,
  renderLines,
  selectMeeting,
  speakerNameOf,
  transcriptLines,
  windowsFor,
} from "./meeting_transcript.ts";
import type { InboxLight, RecordingSpan, TranscriptLine } from "./meeting_transcript.ts";
import { MEETING_SOURCES } from "./notes_sweep.ts";

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

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

const REP_A = { name: "Rep A", email: "rep-a@whitelabeliq.com" };
const REP_B = { name: "Rep B", email: "rep-b@whitelabeliq.com" };
const OWNER = { name: "Owner", email: "owner@whitelabeliq.com" };

const inbox = (o: Partial<InboxLight> = {}): InboxLight => ({
  id: "inbox-1",
  received_at: "2026-10-09T20:01:00Z",
  rid: 5001,
  title: "Sales Standing Connect",
  recording_start_time: "2026-10-09T19:03:00Z",
  recording_end_time: "2026-10-09T19:59:00Z",
  url: "https://fathom.example/calls/5001",
  calendar_invitees: [
    { ...REP_A, is_external: false },
    { ...REP_B },
    { ...OWNER, is_external: false },
  ],
  tx0: { speaker: { display_name: "Rep A" }, text: "Morning.", timestamp: "00:00:01" },
  ...o,
});

const said = (name: string, email: string | null, text: string, timestamp: string | number | null = null) => ({
  speaker: email === null ? { display_name: name } : { display_name: name, matched_calendar_invitee_email: email },
  text,
  timestamp,
});

/* ------------------------------------------------------------------ *
 * 1 · the channel and selection
 * ------------------------------------------------------------------ */

eq("the channel is sales_meeting", MEETING_SOURCE, "sales_meeting");
check("and notes_sweep knows it as a meeting source", MEETING_SOURCES.includes(MEETING_SOURCE));
eq("three title patterns", MEETING_TITLE_PATTERNS.length, 3);

eq("normTitle collapses whitespace and case", normTitle("  Sales   Standing\tConnect \n"), "sales standing connect");
eq("normTitle of nothing is empty", normTitle(null), "");

for (const t of ["Sales Standing Connect", "sales connect", "Prospect Grading", "AM & Sales Strategy Training"]) {
  const s = selectMeeting({ title: t });
  eq(`'${t}' is selected by the pattern`, [s.selected, s.selected_by, s.skip_reason], [true, "pattern", null]);
}
for (const t of ["Daily Stand Up", "Finance Transition", "Salesforce migration"]) {
  const s = selectMeeting({ title: t });
  eq(`'${t}' is not selected`, [s.selected, s.selected_by, s.skip_reason], [false, "none", "not_selected"]);
}

{
  eq("'post-sales review' is selected by the pattern", selectMeeting({ title: "post-sales review" }).selected, true);
  const off = selectMeeting({ title: "post-sales review", rules: [{ title_norm: "post-sales review", read: false }] });
  eq("a title rule read=false turns it off", [off.selected, off.selected_by, off.skip_reason], [false, "title_rule", "not_selected"]);
  const on = selectMeeting({ title: "Daily Stand Up", rules: [{ title_norm: "daily stand up", read: true }] });
  eq("a title rule read=true turns a title on", [on.selected, on.selected_by], [true, "title_rule"]);
  const spaced = selectMeeting({ title: "Daily   STAND up", rules: [{ title_norm: "daily stand up", read: true }] });
  eq("the rule matches on the normalised title", spaced.selected_by, "title_rule");

  const ownerOn = selectMeeting({ title: "post-sales review", include: true, rules: [{ title_norm: "post-sales review", read: false }] });
  eq("include=true beats a title rule", [ownerOn.selected, ownerOn.selected_by], [true, "owner"]);
  const ownerOff = selectMeeting({ title: "Sales connect", include: false, rules: [{ title_norm: "sales connect", read: true }] });
  eq("include=false beats a title rule", [ownerOff.selected, ownerOff.selected_by, ownerOff.skip_reason], [false, "owner", "owner_excluded"]);
  eq("include=null is no say at all", selectMeeting({ title: "Sales connect", include: null }).selected_by, "pattern");
}

/* ------------------------------------------------------------------ *
 * 2 · internal only, by the webhook's own test
 * ------------------------------------------------------------------ */

{
  const r = internalOnly(inbox());
  eq("all-internal invitees: ok", r, { ok: true, recording_id: "5001" });
}
{
  const r = internalOnly(inbox({ calendar_invitees: [{ ...REP_A }, { name: "Founder", email: "founder@northgale.example" }] }));
  eq("one external invitee: external", [r.ok, r.ok ? null : r.why], [false, "external"]);
}
{
  const r = internalOnly(inbox({ calendar_invitees: [{ ...REP_A }, { name: "Guest", email: "someone@gmail.com" }] }));
  eq("one public-mailbox address: external", [r.ok, r.ok ? null : r.why], [false, "external"]);
}
{
  const r = internalOnly(inbox({ calendar_invitees: [] }));
  eq("zero invitees: not ok (rule 5 — nobody identified is not everybody internal)", [r.ok, r.ok ? null : r.why], [false, "not_identified"]);
  const r2 = internalOnly(inbox({ calendar_invitees: undefined }));
  eq("no invitee list at all: not ok", [r2.ok, r2.ok ? null : r2.why], [false, "not_identified"]);
  const r3 = internalOnly(inbox({ calendar_invitees: [{ ...REP_A }, { name: "Somebody" }] }));
  eq("an invitee with no address: not ok", [r3.ok, r3.ok ? null : r3.why], [false, "not_identified"]);
}
{
  const r = internalOnly(inbox({ rid: null }));
  eq("a missing recording_id: not ok", [r.ok, r.ok ? null : r.why], [false, "missing_recording_id"]);
}
{
  const r = internalOnly(inbox({ tx0: null }));
  eq("no transcript: not ok", [r.ok, r.ok ? null : r.why], [false, "no_transcript"]);
}
{
  const r = internalOnly(inbox({ calendar_invitees: [{ ...REP_A }, { name: "Partner", email: "partner@sister.example" }] }), { internal_domains: ["sister.example"] });
  eq("an extra internal domain is honoured", r.ok, true);
}

/* ------------------------------------------------------------------ *
 * 3 · the transcript, line by line
 * ------------------------------------------------------------------ */

const TRANSCRIPT = [
  said("Rep A", REP_A.email, "Okay, first on the list is Quillfern Digital.", "00:00:05"),
  said("Rep B", REP_B.email, "The Quill guys came back on the proposal yesterday.", "00:00:12"),
  said("Rep B", REP_B.email, "They said the budget is approved for the rebuild.", "00:00:19"),
  said("Rep B", REP_B.email, "And they want to start before the end of the month.", "00:00:25"),
  said("Owner", OWNER.email, "Good. Northgale next.", "00:01:02"),
  said("Owner", OWNER.email, "   ", "00:01:03"),
  said("Rep A", REP_A.email, "Northgale   Creative is still quiet,\nno reply since the call.", "00:01:10"),
  said("Visitor", null, "Sorry, joining late.", null),
];

const tx = transcriptLines(TRANSCRIPT);
const LINES: TranscriptLine[] = tx.lines;

eq("an empty line is dropped before numbering", LINES.length, 7);
eq("lines are numbered 1..n", LINES.map((l) => l.n), [1, 2, 3, 4, 5, 6, 7]);
eq("S-labels by first appearance", LINES.map((l) => l.speaker), ["S1", "S2", "S2", "S2", "S3", "S1", "S4"]);
eq("the speaker list carries labels and names", tx.speakers, [
  { label: "S1", name: "Rep A" }, { label: "S2", name: "Rep B" }, { label: "S3", name: "Owner" }, { label: "S4", name: "Visitor" },
]);
check("the speaker list carries no address", !JSON.stringify(tx.speakers).includes("@"));
check("and neither do the lines", !JSON.stringify(LINES).includes("@"));
eq("whitespace inside a line is collapsed", LINES[5].text, "Northgale Creative is still quiet, no reply since the call.");
eq("a missing timestamp inherits the last one", [LINES[6].at, LINES[6].seconds], ["00:01:10", 70]);
eq("an unmatched speaker is allowed", tx.external_speaker, false);
eq("the labels are deterministic", JSON.stringify(transcriptLines(TRANSCRIPT)), JSON.stringify(tx));

{
  const outside = transcriptLines([...TRANSCRIPT, said("Guest", "guest@northgale.example", "Hi all, thanks for having me.", "00:02:00")]);
  eq("a speaker matched to an outside address flags external_speaker", [outside.external_speaker, outside.external_lines], [true, 1]);
  check("and says so in the notes", outside.notes.some((n) => n.includes("outside WLIQ")));
  const sister = transcriptLines([said("Partner", "p@sister.example", "Morning everyone.", "00:00:01")], { internal_domains: ["sister.example"] });
  eq("an extra internal domain is not external", sister.external_speaker, false);
}
{
  // Fathom shows the address where it has no display name; the speaker list keeps the local part.
  const bare = transcriptLines([said(REP_A.email, REP_A.email, "Morning, let us start.", "00:00:01")]);
  check("a display name that is an address keeps only its local part", !JSON.stringify(bare.speakers).includes("@"),
    JSON.stringify(bare.speakers));
  eq("…and that local part is the name", bare.speakers[0]?.name, REP_A.email.slice(0, REP_A.email.indexOf("@")));
  eq("speakerNameOf leaves an ordinary name alone", speakerNameOf("Rep A"), "Rep A");
  eq("speakerNameOf of nothing is nothing", speakerNameOf(null), null);
}
{
  const s = transcriptLines("one long string");
  eq("a string transcript reads as no lines", s.lines.length, 0);
  check("and says why", s.notes.length === 1);
}

eq("HH:MM:SS parses to seconds", clockSeconds("01:02:03"), 3723);
eq("MM:SS parses to seconds", clockSeconds("02:03"), 123);
eq("a fraction is dropped", clockSeconds("00:00:07.480"), 7);
eq("a number of seconds is taken as is", clockSeconds(75.9), 75);
eq("nonsense is null", [clockSeconds("soon"), clockSeconds(-4), clockSeconds(null)], [null, null, null]);
eq("clockText pads", clockText(3723), "01:02:03");
eq("the line label pads to four", [lineLabel(7), lineLabel(412), lineLabel(12345)], ["L0007", "L0412", "L12345"]);

eq("renderLines is the cited shape", renderLines(LINES.slice(0, 2)),
  "L0001 [00:00:05] S1: Okay, first on the list is Quillfern Digital.\nL0002 [00:00:12] S2: The Quill guys came back on the proposal yesterday.");
eq("renderLines marks context", renderLines([{ ...LINES[0], context: true }]), "L0001 [00:00:05] S1 (context): Okay, first on the list is Quillfern Digital.");
eq("renderLines is stable", renderLines(LINES), renderLines(LINES));

/* ------------------------------------------------------------------ *
 * 4 · one recording per meeting (synthetic mirrors of the measured cases)
 * ------------------------------------------------------------------ */

const span = (recording_id: string, start: string | null, end: string | null, o: Partial<RecordingSpan> = {}): RecordingSpan =>
  ({ recording_id, title_norm: "sales standing connect", start, end, ...o });

{
  const g = groupRecording([
    span("101", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z"),
    span("102", "2026-10-09T13:01:00Z", "2026-10-09T13:58:00Z"),
  ]);
  eq("recorders a minute apart: one meeting", g.length, 1);
  eq("the longest wins", [g[0].representative, g[0].duplicates], ["101", ["102"]]);
}
{
  const g = groupRecording([
    span("201", "2026-10-09T13:51:00Z", "2026-10-09T14:56:00Z"),
    span("202", "2026-10-09T13:00:00Z", "2026-10-09T14:56:00Z"),
  ]);
  eq("a late joiner at 51 minutes: one meeting", g.length, 1);
  eq("the full recording is the representative, though its id is later", [g[0].representative, g[0].duplicates], ["202", ["201"]]);
}
{
  const g = groupRecording([
    span("301", "2026-10-09T13:00:00Z", "2026-10-09T13:30:00Z"),
    span("302", "2026-10-09T20:25:00Z", "2026-10-09T20:55:00Z"),
  ]);
  eq("same title, same day, 445 minutes apart: two meetings", g.map((x) => x.representative), ["301", "302"]);
}
{
  const g = groupRecording([
    span("311", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z"),
    span("312", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z", { title_norm: "sales connect" }),
  ]);
  eq("different titles: two meetings", g.length, 2);
}
{
  const g = groupRecording([
    span("321", "2026-10-09T23:30:00Z", "2026-10-09T23:59:00Z"),
    span("322", "2026-10-10T00:00:00Z", "2026-10-10T00:20:00Z"),
  ]);
  eq("different UTC dates: two meetings", g.length, 2);
}
{
  const g = groupRecording([
    span("401", "2026-10-09T13:05:00Z", "2026-10-09T13:50:00Z", { status: "waiting" }),
    span("402", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z"),
  ]);
  eq("a new longer recording replaces a waiting representative", [g[0].representative, g[0].duplicates, g[0].locked], ["402", ["401"], false]);
}
{
  const g = groupRecording([
    span("501", "2026-10-09T13:05:00Z", "2026-10-09T13:50:00Z", { status: "read" }),
    span("502", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z"),
  ]);
  eq("one arriving after the meeting was read is its duplicate", [g[0].representative, g[0].duplicates, g[0].locked], ["501", ["502"], true]);
  const r = groupRecording([
    span("511", "2026-10-09T13:05:00Z", "2026-10-09T13:50:00Z", { status: "reading" }),
    span("512", "2026-10-09T13:00:00Z", "2026-10-09T13:58:00Z"),
  ]);
  eq("a meeting being read is locked too", r[0].representative, "511");
}
{
  const g = groupRecording([
    span("601", "2026-10-09T13:00:00Z", null),
    span("602", "2026-10-09T13:00:00Z", "2026-10-09T13:50:00Z"),
  ]);
  eq("a null end time is never grouped", g.length, 2);
  const h = groupRecording([span("611", null, "2026-10-09T13:50:00Z"), span("612", "2026-10-09T13:00:00Z", "2026-10-09T13:50:00Z")]);
  eq("nor a null start", h.length, 2);
}
{
  const g = groupRecording([
    span("702", "2026-10-09T13:00:00Z", "2026-10-09T13:40:00Z"),
    span("701", "2026-10-09T13:00:00Z", "2026-10-09T13:40:00Z"),
  ]);
  eq("a tie goes to the earliest recording id", g[0].representative, "701");
  eq("members come back earliest id first", g[0].members, ["701", "702"]);
}
{
  const g = groupRecording([
    span("801", "2026-10-09T13:00:00Z", "2026-10-09T13:40:00Z"),
    span("802", "2026-10-09T13:30:00Z", "2026-10-09T14:30:00Z"),
  ]);
  eq("an overlap under half the shorter is two meetings", g.length, 2);
}

/* ------------------------------------------------------------------ *
 * 5 · windows and excerpts
 * ------------------------------------------------------------------ */

const many: TranscriptLine[] = Array.from({ length: 300 }, (_, i) => ({
  n: i + 1, at: clockText(i * 5), seconds: i * 5, speaker: i % 2 ? "S2" : "S1",
  text: `Line ${i + 1} of the synthetic meeting, talking about nothing in particular.`,
}));

{
  eq("a meeting that fits is one window", windowsFor(LINES), [{ from: 1, to: 7 }]);
  eq("no lines, no window", windowsFor([]), []);
  const max = 6000;
  const w = windowsFor(many, { max_chars: max, overlap: 40 });
  check("a long meeting is several windows", w.length > 1, JSON.stringify(w));
  eq("the windows start at the first line and end at the last", [w[0].from, w[w.length - 1].to], [1, 300]);
  let fits = true, overlaps = true;
  for (let i = 0; i < w.length; i++) {
    const text = renderLines(many.filter((l) => l.n >= w[i].from && l.n <= w[i].to));
    if (text.length > max) fits = false;
    if (i > 0 && w[i - 1].to - w[i].from + 1 !== 40) overlaps = false;
  }
  check("each window renders within the cap, never splitting a line", fits);
  check("consecutive windows overlap by 40 lines", overlaps, JSON.stringify(w));
}

{
  const ex = excerptFor(LINES, [{ from: 2, to: 4 }], { pad: 1 });
  eq("the excerpt holds the segment and its padding", ex.lines.map((l) => [l.n, l.context]), [[1, true], [2, false], [3, false], [4, false], [5, true]]);
  eq("owned lines are the segment's", ex.owned, [2, 3, 4]);
  eq("not capped", ex.capped, false);
  const big = excerptFor(many, [{ from: 100, to: 200 }], { pad: 3, max_chars: 2000 });
  check("a long excerpt stays within the character cap", renderLines(big.lines).length <= 2000);
  eq("and reports capped", big.capped, true);
  check("padding goes first", big.lines.every((l) => !l.context));
  eq("the earliest owned lines go, the end of the discussion stays", big.lines[big.lines.length - 1].n, 200);
  eq("owned still lists every segment line", big.owned.length, 101);
  eq("a segment past the end is clipped to the lines there are", excerptFor(LINES, [{ from: 6, to: 99 }], { pad: 0 }).owned, [6, 7]);
}

/* ------------------------------------------------------------------ *
 * 6 · the guarantee: a quote is in one speaker's lines, or it is nothing
 * ------------------------------------------------------------------ */

{
  const q = quoteInLines(LINES, {
    quote: "came back on the proposal yesterday. They said the budget is approved for the rebuild. And they want to start",
    line_from: 2, line_to: 4,
  });
  eq("three consecutive lines of one speaker: accepted", q, { ok: true, line_from: 2, line_to: 4, speaker: "S2", quote_at: "00:00:12" });
}
{
  const q = quoteInLines(LINES, { quote: "the budget is approved for the rebuild", line_from: 2, line_to: 4 });
  eq("the range is tightened to the line that holds it; quote_at is OURS", q, { ok: true, line_from: 3, line_to: 3, speaker: "S2", quote_at: "00:00:19" });
}
{
  const q = quoteInLines(LINES, { quote: "start before the end of the month. Good. Northgale next.", line_from: 4, line_to: 5 });
  eq("two speakers: refused", q, { ok: false, why: "two_speakers" });
}
{
  const q = quoteInLines(many, { quote: many.slice(10, 17).map((l) => l.text).join(" "), line_from: 11, line_to: 17 });
  eq("more than 6 lines: refused", q, { ok: false, why: "too_many_lines" });
}
{
  eq("under 12 characters: refused", quoteInLines(LINES, { quote: "Good.", line_from: 5, line_to: 5 }), { ok: false, why: "too_short" });
  eq("over 600 characters: refused", quoteInLines(LINES, { quote: "x".repeat(601), line_from: 1, line_to: 1 }), { ok: false, why: "too_long" });
  eq("an out-of-range line: refused", quoteInLines(LINES, { quote: "first on the list is Quillfern", line_from: 0, line_to: 1 }), { ok: false, why: "bad_range" });
  eq("a line past the end: refused", quoteInLines(LINES, { quote: "first on the list is Quillfern", line_from: 7, line_to: 9 }), { ok: false, why: "bad_range" });
  eq("a reversed range: refused", quoteInLines(LINES, { quote: "first on the list is Quillfern", line_from: 2, line_to: 1 }), { ok: false, why: "bad_range" });
  eq("a range that is not numbers: refused", quoteInLines(LINES, { quote: "first on the list is Quillfern", line_from: "one", line_to: 1 }), { ok: false, why: "bad_range" });
  eq("an invented quote: refused", quoteInLines(LINES, { quote: "They signed the contract this morning.", line_from: 2, line_to: 4 }), { ok: false, why: "not_in_lines" });
  eq("a paraphrase: refused", quoteInLines(LINES, { quote: "their budget for the rebuild was approved", line_from: 3, line_to: 3 }), { ok: false, why: "not_in_lines" });
  eq("a true quote on the wrong lines: refused", quoteInLines(LINES, { quote: "the budget is approved for the rebuild", line_from: 1, line_to: 2 }), { ok: false, why: "not_in_lines" });
  eq("case, curly quotes and spacing do not matter", quoteInLines(LINES, { quote: "THE BUDGET   is approved", line_from: 3, line_to: 3 }).ok, true);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`meeting_transcript_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("meeting_transcript_test failed");
  }
} else {
  console.log(`meeting_transcript_test: ${passed} checks passed`);
}
