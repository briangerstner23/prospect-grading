/**
 * WLIQ Prospect Book — per-channel record adapters, tests.
 *
 * Run:  node --experimental-strip-types ingest/record_sources_test.ts
 *
 * Every name and domain here is INVENTED (rule 2).
 *
 * The attribution tests are the important ones. Getting the text out of Gmail or Fathom is
 * plumbing; deciding WHICH AGENCY a call was about is the step that could put one agency's
 * words on another agency's row, and it is the step with no quote to check it against.
 */

import {
  attribute,
  attributeAll,
  decodeBase64Url,
  domainOf,
  externalDomains,
  fathomToRecord,
  gmailBodyText,
  gmailToRecord,
  isChatter,
  PUBLIC_MAILBOXES,
  stripQuotedReply,
} from "./record_sources.ts";
import type { FathomMeeting, GmailMessage } from "./record_sources.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

const OURS = ["wliq.test", "wliq-mail.test"];
const BOOK: Record<string, string> = {
  "harborpine.test": "acct-harbor",
  "lanternfield.test": "acct-lantern",
};

/* ------------------------------------------------------------------ *
 * 1 · domains
 * ------------------------------------------------------------------ */

eq("domainOf reads an address", domainOf("sam@harborpine.test"), "harborpine.test");
eq("domainOf lower-cases", domainOf("Sam@HarborPine.Test"), "harborpine.test");
eq("domainOf strips a trailing bracket", domainOf("sam@harborpine.test>"), "harborpine.test");
eq("domainOf of a name is null", domainOf("Sam Reed"), null);
eq("domainOf of nothing is null", domainOf(null), null);
eq("domainOf of a bare local part is null", domainOf("sam@"), null);
eq("domainOf refuses a domain with no dot", domainOf("sam@localhost"), null);

eq("externalDomains drops our own", externalDomains(["a@wliq.test", "sam@harborpine.test"], OURS), ["harborpine.test"]);
eq("externalDomains drops every one of ours", externalDomains(["a@wliq.test", "b@wliq-mail.test"], OURS), []);
eq("externalDomains de-duplicates", externalDomains(["a@harborpine.test", "b@harborpine.test"], OURS), ["harborpine.test"]);
eq("externalDomains is ordered, so the result is stable", externalDomains(["b@lanternfield.test", "a@harborpine.test"], OURS), ["harborpine.test", "lanternfield.test"]);
eq("externalDomains drops a personal mailbox", externalDomains(["owner@gmail.com", "sam@harborpine.test"], OURS), ["harborpine.test"]);
check("the mailbox list covers the common ones", ["gmail.com", "outlook.com", "yahoo.com", "icloud.com"].every((d) => PUBLIC_MAILBOXES.includes(d)));
eq("externalDomains ignores junk entries", externalDomains([null, 7, "", "sam@harborpine.test"], OURS), ["harborpine.test"]);

/* ------------------------------------------------------------------ *
 * 2 · attribution — the step that could get it wrong
 * ------------------------------------------------------------------ */

eq("one prospect domain attributes", attribute(["harborpine.test"], BOOK), { ok: true, account_id: "acct-harbor", domain: "harborpine.test" });

{
  const a = attribute([], BOOK);
  eq("nobody outside WLIQ is an internal record", a, { ok: false, why: "internal", detail: "nobody outside WLIQ was on it" });
}
{
  const a = attribute(["someoneelse.test"], BOOK);
  check("an outside domain we do not track is refused", !a.ok && a.why === "not_in_book");
}
{
  // An introduction thread names two agencies. It is evidence about neither.
  const a = attribute(["harborpine.test", "lanternfield.test"], BOOK);
  check("two prospects on one record is refused, not guessed", !a.ok && a.why === "ambiguous");
  check("and the refusal names both", !a.ok && a.detail.includes("harborpine.test") && a.detail.includes("lanternfield.test"));
}
{
  // A stranger alongside a known account does not make it ambiguous.
  const a = attribute(["harborpine.test", "someoneelse.test"], BOOK);
  check("an untracked domain beside a known one still attributes", a.ok && a.account_id === "acct-harbor");
}
{
  // Two domains, one account (an agency with a second brand) is not ambiguous.
  const twoNames = { "harborpine.test": "acct-harbor", "harbor-pine.test": "acct-harbor" };
  const a = attribute(["harborpine.test", "harbor-pine.test"], twoNames);
  check("two domains of the SAME account attribute cleanly", a.ok && a.account_id === "acct-harbor");
}

/* ------------------------------------------------------------------ *
 * 3 · Fathom
 * ------------------------------------------------------------------ */

const MEETING: FathomMeeting = {
  id: 4242,
  title: "Harbor Pine <> WLIQ",
  url: "https://fathom.test/calls/4242",
  started_at: "2026-05-04T15:00:00Z",
  summary: "Harbor Pine has fourteen people and no developers on staff. They subcontract every build.",
  recorded_by: "Brian",
  attendee_emails: ["brian@wliq.test", "sam@harborpine.test"],
};

{
  const { record, domains } = fathomToRecord(MEETING, OURS);
  eq("a call becomes a record of its summary", record.content, MEETING.summary);
  eq("dated by the call, not the run", record.add_time, "2026-05-04T15:00:00Z");
  eq("sourced as a call", record.source, "fathom_call");
  eq("linking back to the recording", record.url, "https://fathom.test/calls/4242");
  check("labelled so a fact can name it", record.label.includes("Harbor Pine <> WLIQ") && record.label.includes("2026-05-04"));
  eq("and attributed by who was on it", domains, ["harborpine.test"]);
}
{
  const internal = fathomToRecord({ ...MEETING, attendee_emails: ["brian@wliq.test", "ellen@wliq.test"] }, OURS);
  eq("an internal call attributes to nobody", internal.domains, []);
  check("which attribute() then calls internal", !attribute(internal.domains, BOOK).ok);
}
{
  const noSummary = fathomToRecord({ ...MEETING, summary: null }, OURS);
  eq("a call with no summary yields empty text", noSummary.record.content, "");
}
eq("created_at stands in when started_at is absent", fathomToRecord({ ...MEETING, started_at: null, created_at: "2026-01-02T00:00:00Z" }, OURS).record.add_time, "2026-01-02T00:00:00Z");

/* ------------------------------------------------------------------ *
 * 4 · Gmail
 * ------------------------------------------------------------------ */

const MAIL: GmailMessage = {
  id: "m1",
  threadId: "t1",
  subject: "Great connecting",
  sender: "sam@harborpine.test",
  toRecipients: ["brian@wliq.test"],
  date: "2026-04-22T19:42:12Z",
  snippet: "We work with one or two freelancers for web projects and would rather have one partner.",
};

{
  const { record, domains } = gmailToRecord(MAIL, OURS);
  check("the subject is part of what was written", record.content.startsWith("Great connecting"));
  check("and so is the body", record.content.includes("one or two freelancers"));
  eq("dated by the message", record.add_time, "2026-04-22T19:42:12Z");
  eq("sourced as email", record.source, "email");
  check("linking back to the thread", record.url.includes("t1"));
  eq("attributed by everyone on it", domains, ["harborpine.test"]);
  eq("attributed to the sender's agency", attribute(domains, BOOK).account_id, "acct-harbor");
}
{
  // A message we sent still carries the prospect's domain, on the To line.
  const outbound = gmailToRecord({ ...MAIL, sender: "brian@wliq.test", toRecipients: ["sam@harborpine.test"] }, OURS);
  eq("what WE wrote about them is still about them", outbound.domains, ["harborpine.test"]);
}
{
  const cc = gmailToRecord({ ...MAIL, sender: "brian@wliq.test", toRecipients: ["ellen@wliq.test"], ccRecipients: ["sam@harborpine.test"] }, OURS);
  eq("the cc line counts too", cc.domains, ["harborpine.test"]);
}
eq("a message with no body falls back to nothing", gmailToRecord({ id: "x", sender: "a@harborpine.test" }, OURS).record.content, "");

check("a calendar invitation is chatter", isChatter({ id: "1", subject: "Invitation: Sam and Brian @ Tue Apr 14" }));
check("an acceptance is chatter", isChatter({ id: "1", subject: "Accepted: Sam and Brian @ Tue Apr 14" }));
check("a reminder is chatter", isChatter({ id: "1", subject: "Reminder: Sam and Brian" }));
check("a re: on an invitation is still chatter", isChatter({ id: "1", subject: "Re: Invitation: Sam and Brian" }));
check("a scheduling robot is chatter", isChatter({ id: "1", subject: "New booking", sender: "notifications@savvycal.test" }));
check("a no-reply is chatter", isChatter({ id: "1", subject: "Your receipt", sender: "no-reply@stripe.test" }));
check("a real message from a person is not chatter", !isChatter(MAIL));
check("a contact-form submission is not chatter — it is the first thing they told us", !isChatter({ id: "1", subject: "White Label IQ - Contact Us", sender: "inquiry@wliq.test" }));

/* ------------------------------------------------------------------ *
 * 5 · a whole pass over a channel
 * ------------------------------------------------------------------ */

{
  const items = [
    fathomToRecord(MEETING, OURS),
    fathomToRecord({ ...MEETING, id: 2, attendee_emails: ["brian@wliq.test"] }, OURS),
    fathomToRecord({ ...MEETING, id: 3, attendee_emails: ["brian@wliq.test", "x@someoneelse.test"] }, OURS),
    fathomToRecord({ ...MEETING, id: 4, attendee_emails: ["sam@harborpine.test", "kit@lanternfield.test"] }, OURS),
  ];
  const r = attributeAll(items, BOOK);
  eq("only the records that land on one account are kept", r.attributed.length, 1);
  eq("the internal one is counted", r.counters.skipped_internal, 1);
  eq("the stranger is counted", r.counters.skipped_not_in_book, 1);
  eq("the two-agency call is counted", r.counters.skipped_ambiguous, 1);
  eq("and the kept one is counted", r.counters.attributed, 1);
  check("the refusals worth knowing about are explained", r.notes.length === 2);
  check("internal records are not narrated one by one", !r.notes.some((n) => n.includes("nobody outside")));
  eq("the attribution records which domain earned it", r.attributed[0].domain, "harborpine.test");
}

{
  const r = attributeAll([], BOOK);
  eq("nothing in, nothing out", r.attributed.length, 0);
  eq("and no complaints", r.notes.length, 0);
}

/* ------------------------------------------------------------------ *
 * 6 · purity
 * ------------------------------------------------------------------ */

{
  const input = { ...MEETING };
  const snapshot = JSON.stringify(input);
  fathomToRecord(input, OURS);
  eq("reading a meeting does not mutate it", JSON.stringify(input), snapshot);
  eq("and is deterministic", JSON.stringify(fathomToRecord(MEETING, OURS)), JSON.stringify(fathomToRecord(MEETING, OURS)));
}

/* ------------------------------------------------------------------ *
 * reading a message body out of Gmail's MIME tree
 * ------------------------------------------------------------------ */

/** Gmail hands back base64url with the padding stripped. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

{
  eq("base64url decodes", decodeBase64Url(b64url("We have no developer in house.")), "We have no developer in house.");
  eq("and survives multibyte", decodeBase64Url(b64url("fee — £2,500 · naïve")), "fee — £2,500 · naïve");
  eq("garbage decodes to empty, never throws", decodeBase64Url("!!!not base64!!!"), "");
  eq("so does a missing body", decodeBase64Url(undefined), "");
}

{
  // text/plain wins over the html twin a client sends beside it
  const multipart = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("the plain one") } },
      { mimeType: "text/html", body: { data: b64url("<p>the html one</p>") } },
    ],
  };
  eq("text/plain wins", gmailBodyText(multipart), "the plain one");

  const htmlOnly = { mimeType: "text/html", body: { data: b64url("<p>only <b>html</b> here</p>") } };
  eq("html is stripped when it is all there is", gmailBodyText(htmlOnly), "only html here");

  const nested = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64url("buried but read") } }] },
      { mimeType: "application/pdf", filename: "quote.pdf", body: { data: b64url("%PDF-1.7 binary") } },
    ],
  };
  eq("nested parts are walked", gmailBodyText(nested), "buried but read");
  check("an attachment is never read as prose", !gmailBodyText(nested).includes("PDF"));

  eq("no payload is empty, not a throw", gmailBodyText(null), "");
  eq("a payload with no text part is empty", gmailBodyText({ mimeType: "image/png", filename: "logo.png", body: { data: b64url("x") } }), "");
}

/* ------------------------------------------------------------------ *
 * cutting the quoted history off a reply
 *
 * This is the one that protects rule 4. A passage quoted inside a later reply would otherwise
 * be dated by the reply, not by the message that said it.
 * ------------------------------------------------------------------ */

{
  const gmail = "We have no developer in house.\n\nOn Tue, 3 Jun 2026 at 09:12, A Person <someone@example.com> wrote:\n> we do have three\n> and a designer";
  eq("Gmail's 'On … wrote:' is the cut", stripQuotedReply(gmail), "We have no developer in house.");

  const outlook = "Happy to start in July.\n\n-----Original Message-----\nFrom: someone@example.com\nSent: 1 June 2026\n\nearlier text";
  eq("Outlook's original-message rule is the cut", stripQuotedReply(outlook), "Happy to start in July.");

  const headerBlock = "Yes, that budget works.\n\nFrom: A Person <a@example.com>\nSent: Monday, 1 June 2026 09:00\nTo: Someone Else\n\nolder message";
  eq("an Outlook header block is the cut", stripQuotedReply(headerBlock), "Yes, that budget works.");

  const forwarded = "Passing this on.\n\n---------- Forwarded message ---------\nFrom: someone@example.com";
  eq("a forward marker is the cut", stripQuotedReply(forwarded), "Passing this on.");

  const chevrons = "No budget until Q4.\n> what about now\n> please advise";
  eq("a bare chevron line is the cut", stripQuotedReply(chevrons), "No budget until Q4.");

  const clean = "We sell websites and we outsource the build. No dev team here.";
  eq("a message with no history is returned whole", stripQuotedReply(clean), clean);

  eq("empty stays empty", stripQuotedReply(""), "");

  // The earliest marker wins, not the first one in the list.
  const both = "Top line.\n> quoted first\n\nOn Tue, 3 Jun 2026, X wrote:\nlater";
  eq("the earliest marker wins", stripQuotedReply(both), "Top line.");

  // What this protects: a sentence from an older message must not survive into a later record.
  const dated = "Thanks, that is agreed.\n\nOn Tue, 3 Mar 2026 at 09:12, A Person <a@example.com> wrote:\n> our budget is $40,000";
  check(
    "a quoted figure from March cannot be read out of a September reply",
    !stripQuotedReply(dated).includes("40,000"),
  );
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`record_sources_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("record_sources_test failed");
  }
} else {
  console.log(`record_sources_test: ${passed} checks passed`);
}
