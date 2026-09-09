/**
 * WLIQ Prospect Book — Fathom webhook parser tests.
 *
 * Run:  node --experimental-strip-types ingest/fathom_webhook_test.ts
 *   or: deno run ingest/fathom_webhook_test.ts
 *
 * Every payload is synthetic: invented agencies, invented people (roles only), .example
 * domains. The internal domain is WLIQ's own, which is configuration, not prospect data.
 */

import {
  CALL_FIELD_KEYS,
  emptyCallFields,
  INTERNAL_DOMAINS,
  markdownToPlain,
  parseFathomWebhook,
} from "./fathom_webhook.ts";
import type { CallFields, FathomWebhookPayload } from "./fathom_webhook.ts";
import type { KnownAccount } from "./identity.ts";

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
 * Synthetic world
 * ------------------------------------------------------------------ */

const KNOWN: KnownAccount[] = [
  { id: "acc-harbor", key: "harbor and pine creative", name: "Harbor & Pine Creative", domain: "harborpine.example", pipedrive_org_id: 501, orbit_client_id: null },
  { id: "acc-lumen", key: "lumen studio", name: "Lumen Studio", domain: "lumenstudio.example", pipedrive_org_id: null, orbit_client_id: 77 },
  { id: "acc-north", key: "northfield digital", name: "Northfield Digital", domain: null, pipedrive_org_id: null, orbit_client_id: null },
];

const RATER = { name: "Sales Rater", email: "rater@whitelabeliq.com" };

const basePayload = (o: Partial<FathomWebhookPayload> = {}): FathomWebhookPayload => ({
  recording_id: 9001,
  title: "Discovery — Harbor & Pine Creative",
  url: "https://fathom.video/calls/9001",
  created_at: "2026-09-08T15:00:00Z",
  recorded_by: RATER,
  calendar_invitees: [
    { ...RATER, is_external: false },
    { name: "Ops Director", email: "ops@harborpine.example", is_external: true },
    { name: "Founder", email: "founder@harborpine.example" },
  ],
  default_summary: "## Summary\n\n- They **need** a [new site](https://example.invalid/x)\n- Budget *unclear*, decision by Q4\n\n### Next steps\n1. Send a quote",
  transcript: [
    { speaker: { display_name: "Ops Director", matched_calendar_invitee_email: "ops@harborpine.example" }, text: "We need a new site before the rebrand.", timestamp: "00:01:02" },
    { speaker: { display_name: "Sales Rater", matched_calendar_invitee_email: RATER.email }, text: "What is the timeline?", timestamp: "00:01:30" },
  ],
  ...o,
});

/* ------------------------------------------------------------------ *
 * 1 · The happy path
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(basePayload(), KNOWN);
  eq("call: recording id as text", r.call.fathom_recording_id, "9001");
  eq("call: title, url, held_at", [r.call.title, r.call.url, r.call.held_at], ["Discovery — Harbor & Pine Creative", "https://fathom.video/calls/9001", "2026-09-08T15:00:00.000Z"]);
  eq("call: recorded_by prefers the email", r.call.recorded_by, "rater@whitelabeliq.com");
  eq("call: attendees carry name, email, is_external, domain", r.call.attendees, [
    { name: "Sales Rater", email: "rater@whitelabeliq.com", is_external: false, domain: null },
    { name: "Ops Director", email: "ops@harborpine.example", is_external: true, domain: "harborpine.example" },
    { name: "Founder", email: "founder@harborpine.example", is_external: true, domain: "harborpine.example" },
  ]);
  eq("call: external_domains distinct, no internal domain", r.call.external_domains, ["harborpine.example"]);
  eq("call: attached by domain (high)", [r.attach?.id, r.call.account_id], ["acc-harbor", "acc-harbor"]);
  eq("call: no candidates when the only external domain attached", r.candidates, []);
  eq("call: external true, not skipped", [r.external, r.skip_reason], [true, null]);
  eq("call: summary is plain text", r.call.summary, "Summary\n\n- They need a new site\n- Budget unclear, decision by Q4\n\nNext steps\n1. Send a quote");
  eq("call: transcript_available", r.call.transcript_available, true);
  eq("call: fields null, extraction pending", [r.call.fields, r.call.extraction_status], [null, "pending"]);
  eq("call: signals always empty", r.signals, []);
  eq("call: every key is a pb_calls column", Object.keys(r.call).sort(), [
    "account_id", "attendees", "external_domains", "extraction_status", "fathom_recording_id", "fields", "held_at", "recorded_by", "summary", "title", "transcript_available", "url",
  ]);
}

/* ------------------------------------------------------------------ *
 * 2 · Alternate field names
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(basePayload({
    recording_id: undefined, id: "rec_77",
    title: undefined, meeting_title: "Kickoff",
    url: undefined, share_url: "https://fathom.video/share/abc",
    created_at: undefined, recorded_at: undefined, scheduled_start_time: "2026-09-08T14:55:00Z",
    recorded_by: "rater@whitelabeliq.com",
    default_summary: undefined, summary: { markdown_formatted: "**Bold** point" },
    transcript: "Plain transcript text",
  }), KNOWN);
  eq("alt: id", r.call.fathom_recording_id, "rec_77");
  eq("alt: meeting_title", r.call.title, "Kickoff");
  eq("alt: share_url", r.call.url, "https://fathom.video/share/abc");
  eq("alt: scheduled_start_time", r.call.held_at, "2026-09-08T14:55:00.000Z");
  eq("alt: recorded_by as a string", r.call.recorded_by, "rater@whitelabeliq.com");
  eq("alt: summary object markdown_formatted", r.call.summary, "Bold point");
  eq("alt: transcript as a string counts as available", r.call.transcript_available, true);
  const r2 = parseFathomWebhook(basePayload({ created_at: undefined, recorded_at: "2026-09-08T15:05:00Z", recorded_by: { name: "Sales Rater" } }), KNOWN);
  eq("alt: recorded_at; recorded_by falls back to the name", [r2.call.held_at, r2.call.recorded_by], ["2026-09-08T15:05:00.000Z", "Sales Rater"]);
  const r3 = parseFathomWebhook(basePayload({ recording_id: undefined, recording: { id: 5 } } as unknown as FathomWebhookPayload), KNOWN);
  eq("alt: nested recording.id", r3.call.fathom_recording_id, "5");
}

/* ------------------------------------------------------------------ *
 * 3 · is_external and domains
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [
    { name: "Sales Rater", email: "rater@whitelabeliq.com" },
    { name: "Ops Director", email: "ops@HarborPine.example" },
    { name: "Personal", email: "someone@gmail.com" },
    { name: "No Email" },
    { name: "Flag says external", email: "colleague@whitelabeliq.com", is_external: true },
    { name: "Flag says internal", email: "guest@lumenstudio.example", is_external: false },
  ] }), KNOWN);
  const a = r.call.attendees;
  eq("is_external: internal domain, no flag → false", [a[0].is_external, a[0].domain], [false, null]);
  eq("is_external: external domain, no flag → true; email lower-cased; domain is the join key", [a[1].is_external, a[1].email, a[1].domain], [true, "ops@harborpine.example", "harborpine.example"]);
  eq("is_external: personal mailbox → external but never a join domain", [a[2].is_external, a[2].domain], [true, null]);
  eq("is_external: no email → null (unknown is not evidence)", [a[3].is_external, a[3].domain], [null, null]);
  eq("is_external: a flag is trusted, but an internal domain is never a join key", [a[4].is_external, a[4].domain], [true, null]);
  eq("is_external: a false flag is trusted; no join domain", [a[5].is_external, a[5].domain], [false, null]);
  eq("external_domains: only true externals with organisational domains", r.call.external_domains, ["harborpine.example"]);
  eq("external: true", r.external, true);
}

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [
    { ...RATER },
    { name: "Ops Director", email: "ops@harborpine.example" },
    { name: "Partner Agency", email: "hello@copperline.example" },
  ] }), KNOWN);
  eq("two external domains: the known one attaches", r.attach?.id, "acc-harbor");
  eq("two external domains: the unknown one is a candidate", r.candidates, [{
    account_id: null, source: "fathom", source_id: "9001", source_name: null, source_domain: "copperline.example", matched_on: "none", confidence: null,
    note: "external domain on call 9001 is not in the book",
  }]);
  eq("two external domains: both listed", r.call.external_domains, ["harborpine.example", "copperline.example"]);
}

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [
    { ...RATER },
    { name: "A", email: "a@lumenstudio.example" },
    { name: "B", email: "b@harborpine.example" },
  ] }), KNOWN);
  eq("two known external domains: first attaches, second is a high candidate for review", [r.attach?.id, r.candidates.length, r.candidates[0]?.account_id, r.candidates[0]?.confidence, r.candidates[0]?.matched_on], ["acc-lumen", 1, "acc-harbor", "high", "domain"]);
}

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [{ ...RATER }, { name: "Founder", email: "founder@copperline.example" }] }), KNOWN);
  eq("unknown external domain: no attach, account null, candidate none", [r.attach, r.call.account_id, r.candidates[0]?.matched_on], [null, null, "none"]);
  eq("unknown external domain: still external, not skipped", [r.external, r.skip_reason], [true, null]);
}

/* ------------------------------------------------------------------ *
 * 4 · Skips
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [{ ...RATER, is_external: false }, { name: "Owner", email: "owner@whitelabeliq.com" }] }), KNOWN);
  eq("internal only: external false, skip reason", [r.external, r.skip_reason], [false, "internal only"]);
  eq("internal only: call row still built, unattached, no domains", [r.call.fathom_recording_id, r.call.account_id, r.call.external_domains], ["9001", null, []]);
  eq("internal only: no candidates", r.candidates, []);
}

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [], transcript: [] }), KNOWN);
  eq("no attendees at all: external false, distinct skip reason", [r.external, r.skip_reason], [false, "no external attendee identified"]);
  const r2 = parseFathomWebhook(basePayload({ calendar_invitees: [{ name: "Nobody Known" }] }), KNOWN);
  eq("attendee without an email: cannot be identified as external", [r2.external, r2.skip_reason, r2.call.attendees[0].is_external], [false, "no external attendee identified", null]);
}

{
  const r = parseFathomWebhook(basePayload({ recording_id: undefined, id: undefined }), KNOWN);
  eq("missing recording id: skip reason, empty key", [r.skip_reason, r.call.fathom_recording_id], ["missing recording id", ""]);
  eq("missing recording id: attendance still computed", r.external, true);
}

/* ------------------------------------------------------------------ *
 * 5 · Internal domains
 * ------------------------------------------------------------------ */

{
  eq("INTERNAL_DOMAINS carries WLIQ's domain", Array.from(INTERNAL_DOMAINS), ["whitelabeliq.com"]);
  const r = parseFathomWebhook(basePayload({ calendar_invitees: [{ ...RATER }, { name: "Contractor", email: "dev@wliq-contractors.example" }] }), KNOWN, { internal_domains: ["WWW.WLIQ-Contractors.example"] });
  eq("opts.internal_domains extends the internal set (case- and www-insensitive)", [r.external, r.skip_reason, r.call.attendees[1].is_external], [false, "internal only", false]);
  const r2 = parseFathomWebhook(basePayload({ calendar_invitees: [{ ...RATER }, { name: "Contractor", email: "dev@wliq-contractors.example" }] }), KNOWN);
  eq("without the option the same domain is external", [r2.external, r2.call.external_domains], [true, ["wliq-contractors.example"]]);
}

/* ------------------------------------------------------------------ *
 * 6 · Transcript-derived attendees and transcript shapes
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(basePayload({ calendar_invitees: undefined, transcript: [
    { speaker: { display_name: "Ops Director", matched_calendar_invitee_email: "ops@harborpine.example" }, text: "hello", timestamp: 3 },
    { speaker: { display_name: "Ops Director", matched_calendar_invitee_email: "ops@harborpine.example" }, text: "again", timestamp: 9 },
    { speaker: "Unmatched Voice", text: "hi" },
    { speaker: { display_name: "Sales Rater", matched_calendar_invitee_email: RATER.email }, text: "yes" },
  ] }), KNOWN);
  eq("no invitees: attendees derived from distinct transcript speakers", r.call.attendees, [
    { name: "Ops Director", email: "ops@harborpine.example", is_external: true, domain: "harborpine.example" },
    { name: "Unmatched Voice", email: null, is_external: null, domain: null },
    { name: "Sales Rater", email: "rater@whitelabeliq.com", is_external: false, domain: null },
  ]);
  eq("no invitees: attaches through the speaker's matched email", r.attach?.id, "acc-harbor");
  check("no invitees: a note says attendees came from the transcript", r.notes.some((n) => n.includes("transcript speakers")));
  const empty = parseFathomWebhook(basePayload({ transcript: [{ speaker: "X", text: "" }, { text: null }] }), KNOWN);
  eq("transcript with only empty lines is not available", empty.call.transcript_available, false);
  const none = parseFathomWebhook(basePayload({ transcript: undefined }), KNOWN);
  eq("no transcript key: not available", none.call.transcript_available, false);
}

/* ------------------------------------------------------------------ *
 * 7 · Summary flattening
 * ------------------------------------------------------------------ */

{
  eq("markdownToPlain: headings, bold, italics, links, bullets", markdownToPlain("# Title\n\n* **Bold** and *it* with [link](http://x.example)\n---\n> quoted"), "Title\n\n- Bold and it with link\n\nquoted");
  eq("markdownToPlain: code fence content kept, fence removed", markdownToPlain("```js\nlet a = 1;\n```"), "let a = 1;");
  eq("markdownToPlain: inline code", markdownToPlain("run `npm test` now"), "run npm test now");
  eq("markdownToPlain: empty → null", markdownToPlain("   "), null);
  eq("markdownToPlain: null → null", markdownToPlain(null), null);
  const r = parseFathomWebhook(basePayload({ default_summary: null, summary: "fallback summary" }), KNOWN);
  eq("summary falls back from default_summary to summary", r.call.summary, "fallback summary");
  const r2 = parseFathomWebhook(basePayload({ default_summary: undefined, summary: undefined }), KNOWN);
  eq("no summary → null", r2.call.summary, null);
  const r3 = parseFathomWebhook(basePayload({ default_summary: { text: "object with text" } }), KNOWN);
  eq("summary object with text", r3.call.summary, "object with text");
}

/* ------------------------------------------------------------------ *
 * 8 · CallFields schema
 * ------------------------------------------------------------------ */

{
  const f = emptyCallFields();
  eq("emptyCallFields: ten keys in the contract order", Object.keys(f), [
    "pain", "impact", "critical_event", "decision", "price_reaction", "next_step", "risk_words", "vendors_used", "our_rank", "attendees_roles",
  ]);
  eq("CALL_FIELD_KEYS matches the object", Array.from(CALL_FIELD_KEYS), Object.keys(f));
  check("emptyCallFields: every field is 'not discussed'", Object.values(f).every((v) => v === "not discussed"));
  check("emptyCallFields returns a fresh object each time", emptyCallFields() !== emptyCallFields());
  const filled: CallFields = { ...f, pain: { value: "site is slow", quote: "our site takes six seconds to load", timestamp: "00:04:10", inferred: false } };
  eq("a filled field carries value, quote, timestamp, inferred", filled.pain, { value: "site is slow", quote: "our site takes six seconds to load", timestamp: "00:04:10", inferred: false });
}

/* ------------------------------------------------------------------ *
 * 9 · Malformed input and determinism
 * ------------------------------------------------------------------ */

{
  const r = parseFathomWebhook(null as unknown as FathomWebhookPayload, KNOWN);
  eq("null payload: skipped for missing id, nothing thrown", [r.skip_reason, r.external, r.call.attendees], ["missing recording id", false, []]);
  const r2 = parseFathomWebhook(basePayload({ calendar_invitees: [null, "ceo@harborpine.example", 42] as unknown as FathomWebhookPayload["calendar_invitees"] }), KNOWN);
  eq("odd invitee entries: null dropped, string read as an email, number dropped", r2.call.attendees, [{ name: "ceo@harborpine.example", email: "ceo@harborpine.example", is_external: true, domain: "harborpine.example" }]);
  const r3 = parseFathomWebhook(basePayload({ created_at: "not a date" }), KNOWN);
  eq("unparseable held_at → null", r3.call.held_at, null);
  const r4 = parseFathomWebhook(basePayload(), []);
  eq("no known accounts: unattached, candidate queued", [r4.attach, r4.candidates.length, r4.candidates[0]?.source_domain], [null, 1, "harborpine.example"]);
  const a = JSON.stringify(parseFathomWebhook(basePayload({ action_items: [{ text: "send quote" }], crm_matches: { deals: [] } }), KNOWN));
  const b = JSON.stringify(parseFathomWebhook(basePayload({ action_items: [{ text: "send quote" }], crm_matches: { deals: [] } }), KNOWN));
  eq("parseFathomWebhook is deterministic", a, b);
  check("action_items and crm_matches are acknowledged in notes, not stored", JSON.parse(a).notes.some((n: string) => n.includes("action_items")) && JSON.parse(a).notes.some((n: string) => n.includes("crm_matches")));
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`fathom_webhook_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("fathom_webhook_test failed");
  }
} else {
  console.log(`fathom_webhook_test: ${passed} checks passed`);
}
