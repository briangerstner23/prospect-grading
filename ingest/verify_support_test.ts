/**
 * WLIQ Prospect Book — does the sentence actually say it, tests.
 *
 * Run:  node --experimental-strip-types ingest/verify_support_test.ts
 *
 * Every sentence here is INVENTED (rule 2), but each one is SHAPED like a real failure that
 * DECISIONS §53 found in the queue: a count read off prospects, an illustrative number read as a
 * total, a partial list read as a count, an absence read out of a missing field.
 *
 * The property these tests exist to pin is the asymmetry. This pass re-audits claims that already
 * exist, so a wrong `unsupported` costs a row staying in a queue somebody was going to read, and a
 * wrong `states` puts an inference in the book as evidence. Everything below checks that the code
 * is only ever allowed to be wrong in the cheap direction:
 *
 *   · the lexicon may lower a verdict and may never raise one;
 *   · an unreadable reply changes nothing at all rather than condemning the claim.
 */

import {
  auditorId,
  batchClaims,
  lexiconCeiling,
  supportPayload,
  supportPrompt,
  verifySupport,
  weakest,
} from "./verify_support.ts";
import type { SupportClaim } from "./verify_support.ts";

let passed = 0;
const failures: string[] = [];
function eq(what: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++;
  else failures.push(`${what}: got ${g}, wanted ${w}`);
}
function ok(what: string, cond: boolean): void {
  if (cond) passed++;
  else failures.push(what);
}

const claim = (id: string, key: string, value: unknown, quote: string): SupportClaim => ({ id, key, value, quote });
const reply = (rows: unknown[]) => ({ verdicts: rows });

/* ---- the ordering the whole module rests on ---- */
{
  eq("unsupported is weaker than implies", weakest("unsupported", "implies"), "unsupported");
  eq("implies is weaker than states", weakest("states", "implies"), "implies");
  eq("weakest is symmetric", weakest("implies", "states"), weakest("states", "implies"));
  eq("a verdict is its own weakest", weakest("states", "states"), "states");
}

/* ---- rule 1: an example is not a total ---- */
{
  const c = lexiconCeiling("client_evidence_count", 200, "~200 sites cited as an example of scale");
  ok("an illustrative count is capped", c !== null && c.ceiling === "implies");

  const partial = lexiconCeiling("client_evidence_count", 3, "client base includes Northwind, Contoso and Fabrikam");
  ok("a partial list is capped", partial !== null && partial.ceiling === "implies");

  const clean = lexiconCeiling("client_evidence_count", 15, "Current client load: ~15 personal injury firms.");
  eq("a plain count is left alone", clean, null);

  const notACount = lexiconCeiling("relationship_type", "reseller", "our work includes white-label delivery");
  eq("the example rule applies only to quantity keys", notACount, null);

  // The first real run's one clear false positive. A band is not a count: "e.g." here is naming
  // which industries, not how many, and the sentence states the band outright.
  const band = lexiconCeiling("client_budget_size", "local_small", "Local SMBs: businesses in a 3-county area (e.g., construction, restaurants)");
  eq("a budget BAND is not subject to the counting rule", band, null);
}

/* ---- rule 2: counting prospects is not counting clients ---- */
{
  const c = lexiconCeiling("client_evidence_count", 7, "a list of ~7 prospects for the readiness programme");
  ok("prospects counted as clients is refused outright", c !== null && c.ceiling === "unsupported");

  const both = lexiconCeiling("client_evidence_count", 7, "7 clients converted from a prospect list");
  ok("a sentence naming clients AND prospects is not refused by this rule", both === null || both.ceiling !== "unsupported");
}

/* ---- rule 3: a missing field is not an absence ---- */
{
  const c = lexiconCeiling("authority", "absent", "no job title on person");
  // "no " is a negation marker, so the lexicon lets this through to the reader rather than
  // pretending a string match understands the sentence. That is the honest boundary of a lexicon.
  eq("a negation in the sentence is left for the reader to judge", c, null);

  // `implies`, not `unsupported`. The first run fired this on "Key Challenge: RFPs are often
  // incomplete" and on "requires internal consultation with leadership before proceeding" —
  // sentences that bear on the claim without stating it. "About something else" would be a lie
  // about them; "a fair reading gets there, but it does not say it" is exactly true.
  const silent = lexiconCeiling("authority", "absent", "spoke with the marketing coordinator about timelines");
  ok("absence with no negation anywhere is held to implies", silent !== null && silent.ceiling === "implies");
  ok("and is never called unsupported", silent !== null && silent.ceiling !== "unsupported");

  const said = lexiconCeiling("money", "absent", "they have no budget allocated this year");
  eq("a stated absence is left alone", said, null);

  // Both from the full run, both cases where the rule overruled a reader who was right. A record
  // records a gap in its own words, not in grammatical negation.
  const literal = lexiconCeiling("authority", "absent", "Unknown for that org (absent).");
  eq("a sentence that says the word absent is left to the reader", literal, null);
  const gap = lexiconCeiling("specification", "absent", "A scope of work is needed for the new tool.");
  eq("a sentence saying something is needed is left to the reader", gap, null);

  const present = lexiconCeiling("money", "confirmed", "budget is approved at 40k");
  eq("the absence rule does not touch other values", present, null);
}

/* ---- the lexicon may lower a verdict and may never raise one ---- */
{
  const claims = [claim("a", "client_evidence_count", 7, "a list of ~7 prospects for the programme")];
  const r = verifySupport(claims, reply([{ id: "a", support: "states", reason: "it gives the number" }]));
  eq("the reader's 'states' is overruled downward", r.verdicts[0].support, "unsupported");
  eq("and the row says the lexicon did it", r.verdicts[0].basis, "lexicon");
  ok("and the reason keeps what the reader said", r.verdicts[0].reason.includes("states"));
}
{
  // The reader is harsher than the lexicon: the lexicon must not pull it back up.
  const claims = [claim("a", "client_evidence_count", 200, "~200 sites cited as an example of scale")];
  const r = verifySupport(claims, reply([{ id: "a", support: "unsupported", reason: "it is an example" }]));
  eq("a harsher reader is not raised to the lexicon's ceiling", r.verdicts[0].support, "unsupported");
  eq("and it is recorded as the reader's call", r.verdicts[0].basis, "model");
}

/* ---- a malformed reply changes NOTHING ---- */
{
  const claims = [claim("a", "headcount", 12, "we are a team of twelve")];
  const r = verifySupport(claims, { nonsense: true });
  eq("a reply of the wrong shape produces no verdicts", r.verdicts.length, 0);
  eq("and leaves the claim to be asked again", r.unresolved.length, 1);
  ok("and says so plainly", r.notes.join(" ").includes("nothing was changed"));
}
{
  const claims = [claim("a", "headcount", 12, "we are a team of twelve")];
  const r = verifySupport(claims, reply([{ id: "a", support: "probably", reason: "hmm" }]));
  eq("a support value outside the three words is not a verdict", r.verdicts.length, 0);
  eq("it is left unresolved rather than condemned", r.unresolved[0].id, "a");
  ok("unresolved is never the same as unsupported", !r.unresolved[0].why.includes("unsupported"));
}
{
  const claims = [claim("a", "headcount", 12, "we are a team of twelve"), claim("b", "is_agency", true, "we are an agency")];
  const r = verifySupport(claims, reply([{ id: "a", support: "states", reason: "says twelve" }]));
  eq("a claim the reader skipped is unresolved", r.unresolved.length, 1);
  eq("and it is the one that was skipped", r.unresolved[0].id, "b");
  eq("the answered one still lands", r.verdicts.length, 1);
}

/* ---- ids are never invented ---- */
{
  const claims = [claim("a", "headcount", 12, "we are a team of twelve")];
  const r = verifySupport(claims, reply([
    { id: "a", support: "states", reason: "says twelve" },
    { id: "ghost", support: "states", reason: "about a claim nobody asked about" },
  ]));
  eq("a verdict for an id not in the batch is dropped", r.verdicts.length, 1);
  eq("and counted", r.counters.verdict_for_unknown_claim, 1);
}
{
  const claims = [claim("a", "headcount", 12, "we are a team of twelve")];
  const r = verifySupport(claims, reply([
    { id: "a", support: "states", reason: "first" },
    { id: "a", support: "unsupported", reason: "second" },
  ]));
  eq("a repeated id is taken once", r.verdicts.length, 1);
  eq("and it is the first answer, not the last", r.verdicts[0].reason, "first");
}

/* ---- batching ---- */
{
  const many = Array.from({ length: 60 }, (_, i) => claim(`c${i}`, "headcount", i, "a short sentence"));
  const b = batchClaims(many, 25, 12000);
  ok("no batch exceeds the row cap", b.every((x) => x.length <= 25));
  eq("every claim is in exactly one batch", b.reduce((n, x) => n + x.length, 0), 60);
}
{
  const fat = Array.from({ length: 10 }, (_, i) => claim(`c${i}`, "headcount", i, "x".repeat(4000)));
  const b = batchClaims(fat, 25, 12000);
  ok("long quotes split the batch before the row cap does", b.length > 1);
  ok("a single oversized claim still goes somewhere", batchClaims([claim("z", "headcount", 1, "y".repeat(50000))]).length === 1);
}

/* ---- the prompt says the thing the failures needed it to say ---- */
{
  const p = supportPrompt();
  ok("it names the three verdicts", p.includes('"states"') && p.includes('"implies"') && p.includes('"unsupported"'));
  ok("it warns that a number is not automatically the answer", p.toLowerCase().includes("not automatically the answer"));
  ok("it warns about partial lists", p.toLowerCase().includes("partial list"));
  ok("it warns about missing fields", p.toLowerCase().includes("missing field"));
  ok("it tells the reader not to be generous", p.toLowerCase().includes("do not be generous"));
  ok("it forbids inventing ids", p.toLowerCase().includes("invent no ids"));
}

/* ---- the payload carries what the reader needs and nothing else ---- */
{
  const body = supportPayload([claim("a", "headcount", 12, "we are  a team\nof twelve")]);
  ok("the id is present", body.includes("id: a"));
  ok("the key is present", body.includes("key: headcount"));
  ok("the value is JSON, so a string is distinguishable from a number", body.includes("value: 12"));
  ok("whitespace in the sentence is flattened", body.includes("we are a team of twelve"));
}

/* ---- identity ---- */
{
  eq("the auditor names its version and its model", auditorId("claude-sonnet-5"), "support@v1+claude-sonnet-5");
}

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`verify_support_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("verify_support_test failed");
  }
} else {
  console.log(`verify_support_test: ${passed} checks passed`);
}
