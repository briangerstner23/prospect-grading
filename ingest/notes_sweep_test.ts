/**
 * WLIQ Prospect Book — notes sweep planning and validation, tests.
 *
 * Run:  node --experimental-strip-types ingest/notes_sweep_test.ts
 *
 * Every note here is INVENTED (rule 2). The point of these tests is the one property that
 * makes an automated sweep safe to run unattended: a model cannot get an invented sentence
 * into pb_facts, because the sentence is checked against the note before anything is written.
 */

import {
  EXTRACTABLE,
  JUDGEMENT_MARKERS,
  judgementMarker,
  extractionPrompt,
  MAX_CLAIMS_PER_NOTE,
  MIN_NOTE_CHARS,
  normalizeForQuote,
  planSweep,
  quoteIsInNote,
  touchedAt,
  verifyClaims,
} from "./notes_sweep.ts";
import type { PlannedNote, SweepPlanInput } from "./notes_sweep.ts";
import type { PipedriveNote } from "./written_record.ts";

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

const PROSE =
  "<p><b>Screening Summary</b></p><p>Harbor Pine Studio is a full-service agency in Vermont with " +
  "fourteen people. They lack in-house development capability and subcontract every build. " +
  "Their clients are regional banks and a hospital group, and the work is retained rather than " +
  "one-off.</p>";

const note = (o: Partial<PipedriveNote> = {}): PipedriveNote => ({
  id: 7001,
  org_id: 501,
  add_time: "2026-03-02 09:00:00",
  update_time: "2026-03-02 09:00:00",
  content: PROSE,
  ...o,
});

const BASE: SweepPlanInput = {
  notes: [note()],
  accountByOrg: { "501": "acct-1", "502": "acct-2" },
  since: null,
  as_of: "2026-09-11",
};

const plannedOf = (input: SweepPlanInput = BASE): PlannedNote => planSweep(input).read[0];

/* ------------------------------------------------------------------ *
 * 1 · planning — which notes are worth a model call
 * ------------------------------------------------------------------ */

{
  const p = planSweep(BASE);
  eq("a prose note on a known org is read", p.read.length, 1);
  eq("it is attached to its account", p.read[0].account_id, "acct-1");
  check("the model reads text, not markup", !p.read[0].text.includes("<p>"));
  check("the text keeps the sentences", p.read[0].text.includes("lack in-house development capability"));
  eq("the watermark advances to what was read", p.next_watermark, "2026-03-02 09:00:00");
}

{
  const p = planSweep({ ...BASE, since: "2026-03-02 09:00:00" });
  eq("a note not touched since the watermark is not re-read", p.read.length, 0);
  eq("and it costs nothing to skip", p.counters.already_read, 1);
  eq("the watermark does not move when nothing was read", p.next_watermark, null);
}

{
  const edited = note({ update_time: "2026-04-01 12:00:00" });
  const p = planSweep({ ...BASE, notes: [edited], since: "2026-03-02 09:00:00" });
  eq("editing a note brings it back into the sweep", p.read.length, 1);
  eq("and the watermark follows the edit", p.next_watermark, "2026-04-01 12:00:00");
}

{
  const p = planSweep({ ...BASE, notes: [note({ org_id: 999 })] });
  eq("a note whose org is not in the book is skipped", p.read.length, 0);
  eq("and it is counted", p.counters.org_not_in_book, 1);
  check("and it is explained", p.notes.some((n) => n.includes("not an account in the book")));
}

{
  const p = planSweep({ ...BASE, notes: [note({ content: "<p>MNDA: https://example.test/x</p>" })] });
  eq("a note that is only a link is not worth a model call", p.read.length, 0);
  eq("and it is counted", p.counters.too_short_to_read, 1);
}

{
  const p = planSweep({ ...BASE, notes: [note({ add_time: "2027-01-01 00:00:00", update_time: "2027-01-01 00:00:00" })] });
  eq("a note touched after as_of is not read", p.read.length, 0);
  eq("and it is counted", p.counters.after_as_of, 1);
}

{
  const p = planSweep({ ...BASE, notes: [note({ add_time: "", update_time: null })] });
  eq("an undated note is not read", p.read.length, 0);
  eq("and it is counted", p.counters.undated, 1);
}

{
  const many = [
    note({ id: 1, update_time: "2026-03-05 00:00:00" }),
    note({ id: 2, update_time: "2026-03-01 00:00:00" }),
    note({ id: 3, update_time: "2026-03-03 00:00:00" }),
  ];
  const p = planSweep({ ...BASE, notes: many, max_notes: 2 });
  eq("a capped run reads the oldest first", p.read.map((r) => r.note.id), [2, 3]);
  eq("so the watermark covers a contiguous block", p.next_watermark, "2026-03-03 00:00:00");
  eq("and the rest wait for the next run", p.counters.over_run_cap, 1);
  check("and the operator is told", p.notes.some((n) => n.includes("left for the next run")));
  // Resuming from that watermark picks up exactly what was left.
  const q = planSweep({ ...BASE, notes: many, max_notes: 2, since: p.next_watermark });
  eq("the next run reads the remainder", q.read.map((r) => r.note.id), [1]);
}

{
  const p = planSweep({ ...BASE, notes: [] });
  eq("no notes, nothing read", p.read.length, 0);
  eq("and no watermark to store", p.next_watermark, null);
}

eq("touchedAt prefers update_time", touchedAt(note({ update_time: "2026-05-05 00:00:00" })), "2026-05-05 00:00:00");
eq("touchedAt falls back to add_time", touchedAt(note({ update_time: null })), "2026-03-02 09:00:00");
check("MIN_NOTE_CHARS is a real floor", MIN_NOTE_CHARS > 0);

/* ------------------------------------------------------------------ *
 * 2 · the guarantee — an invented sentence can never become a fact
 * ------------------------------------------------------------------ */

const P = plannedOf();

{
  const r = verifyClaims(P, {
    claims: [{
      key: "no_inhouse_dev_team",
      value: true,
      quote: "They lack in-house development capability and subcontract every build.",
      confidence: "high", kind: "observation",
    }],
  });
  eq("a real sentence is kept", r.extraction.claims.length, 1);
  check("and it keeps its quote, so it may become a fact", r.extraction.claims[0].quote !== null);
  eq("and it is counted as verified", r.counters.quote_verified, 1);
}

{
  const r = verifyClaims(P, {
    claims: [{
      key: "no_inhouse_dev_team",
      value: true,
      quote: "They told us on the call they have no developers whatsoever.",
      confidence: "high", kind: "observation",
    }],
  });
  eq("an invented sentence does not discard the claim", r.extraction.claims.length, 1);
  eq("but the claim loses its quote", r.extraction.claims[0].quote, null);
  eq("which is what stops it becoming a fact", r.counters.quote_not_in_note, 1);
  check("and it is said out loud", r.notes.some((n) => n.includes("is not in the note")));
}

{
  // Markup and smart punctuation must not defeat a genuine quote.
  const fancy = plannedOf({
    ...BASE,
    notes: [note({ content: "<p>They   lack in-house development\ncapability — and they subcontract every build.</p><p>Filler sentence to clear the minimum length for a model call, which is deliberately generous.</p>" })],
  });
  const r = verifyClaims(fancy, {
    claims: [{ key: "no_inhouse_dev_team", value: true, quote: "They lack in-house development capability - and they subcontract every build.", confidence: "high", kind: "observation" }],
  });
  eq("whitespace and dash style do not break a real quote", r.counters.quote_verified, 1);
}

check("a too-short fragment is not evidence", !quoteIsInNote("a b c d e f", "a b c"));
check("normalizeForQuote folds quotes and dashes", normalizeForQuote("“A—B”") === '"a-b"');

/* ------------------------------------------------------------------ *
 * 3 · the whitelist — nothing unexpected widens the contract
 * ------------------------------------------------------------------ */

{
  const r = verifyClaims(P, { claims: [{ key: "annual_revenue", value: 4000000, quote: "fourteen people", confidence: "high", kind: "observation" }] });
  eq("a key outside the whitelist is dropped", r.extraction.claims.length, 0);
  eq("and it is counted", r.counters.key_not_extractable, 1);
}

{
  const r = verifyClaims(P, { claims: [{ key: "client_budget_size", value: "enterprise", quote: "regional banks and a hospital group", confidence: "high", kind: "observation" }] });
  eq("a value the key cannot hold is dropped", r.extraction.claims.length, 0);
  eq("and it is counted", r.counters.value_out_of_shape, 1);
}

{
  const r = verifyClaims(P, { claims: [{ key: "is_agency", value: "yes", quote: "is a full-service agency in Vermont", confidence: "high", kind: "observation" }] });
  eq("a string where a boolean belongs is dropped, not coerced", r.extraction.claims.length, 0);
}

{
  const r = verifyClaims(P, { claims: [{ key: "headcount", value: 99999, quote: "fourteen people in the building", confidence: "high", kind: "observation" }] });
  eq("an out-of-range number is dropped", r.extraction.claims.length, 0);
}

{
  const r = verifyClaims(P, { claims: [{ key: "headcount", value: 14.4, quote: "full-service agency in Vermont with fourteen people", confidence: "high", kind: "observation" }] });
  eq("a near-integer is rounded, not refused", r.extraction.claims[0]?.value, 14);
}

{
  const r = verifyClaims(P, { claims: [{ key: "is_agency", value: null, quote: "is a full-service agency in Vermont", confidence: "high", kind: "observation" }] });
  eq("null is silence, not a claim", r.extraction.claims.length, 0);
}

{
  const r = verifyClaims(P, {
    claims: [
      { key: "is_agency", value: true, quote: "Harbor Pine Studio is a full-service agency in Vermont", confidence: "high", kind: "observation" },
      { key: "is_agency", value: false, quote: "Harbor Pine Studio is a full-service agency in Vermont", confidence: "low", kind: "observation" },
    ],
  });
  eq("one claim per key", r.extraction.claims.length, 1);
  eq("the first is the one kept", r.extraction.claims[0].value, true);
  eq("and the repeat is counted", r.counters.duplicate_key, 1);
}

{
  const r = verifyClaims(P, { claims: [{ key: "is_agency", value: true, quote: "Harbor Pine Studio is a full-service agency in Vermont", confidence: "certain", kind: "observation" }] });
  eq("an unknown confidence becomes low, never high", r.extraction.claims[0].confidence, "low");
  eq("and it is counted", r.counters.confidence_missing, 1);
}

{
  const r = verifyClaims(P, { claims: [{ key: "is_agency", value: true, confidence: "high", kind: "observation" }] });
  eq("a claim with no quote at all survives as a candidate", r.extraction.claims.length, 1);
  eq("with no quote", r.extraction.claims[0].quote, null);
  eq("and it is counted", r.counters.no_quote_offered, 1);
}

{
  eq("a response that is not a claims array yields nothing", verifyClaims(P, "sure thing!").extraction.claims.length, 0);
  eq("and says so", verifyClaims(P, "sure thing!").counters.unreadable_response, 1);
  eq("null yields nothing", verifyClaims(P, null).extraction.claims.length, 0);
  eq("a bare array is accepted too", verifyClaims(P, [{ key: "is_agency", value: true, quote: "is a full-service agency in Vermont", confidence: "high", kind: "observation" }]).extraction.claims.length, 1);
}

{
  const flood = Array.from({ length: MAX_CLAIMS_PER_NOTE + 1 }, () => ({ key: "is_agency", value: true, quote: "x", confidence: "high", kind: "observation" }));
  const r = verifyClaims(P, { claims: flood });
  eq("a flood of claims is refused whole", r.extraction.claims.length, 0);
  eq("and counted", r.counters.over_claim_cap, 1);
}

{
  const r = verifyClaims(P, { claims: [null, 7, "nope", { key: "is_agency", value: true, quote: "is a full-service agency in Vermont", confidence: "high", kind: "observation" }] });
  eq("junk entries are dropped and the good one kept", r.extraction.claims.length, 1);
  eq("and the junk is counted", r.counters.malformed_claim, 3);
}

/* ------------------------------------------------------------------ *
 * 3b · observation or judgement — the model says, the lexicon overrules
 * ------------------------------------------------------------------ */

const OPINION = plannedOf({
  ...BASE,
  notes: [note({ content: "<p>Screening. Harbor Pine Studio was classified Genuine with a strong fit for the partner programme. Andy did seem incredibly experienced on the call, and I believe they subcontract their builds. They lack in-house development capability.</p>" })],
});

{
  const r = verifyClaims(OPINION, { claims: [{ key: "is_agency", value: true, quote: "classified Genuine with a strong fit for the partner programme", confidence: "high", kind: "observation" }] });
  eq("a classification called an observation is caught anyway", r.extraction.claims[0].kind, "judgement");
  eq("and counted", r.counters.judgement_caught_by_lexicon, 1);
  check("and said out loud, naming the words that gave it away", r.notes.some((n) => n.includes("that is an assessment")));
  check("the quote survives, so a person can still weigh it", r.extraction.claims[0].quote !== null);
}

{
  const r = verifyClaims(OPINION, { claims: [{ key: "no_inhouse_dev_team", value: true, quote: "Andy did seem incredibly experienced on the call", confidence: "high", kind: "observation" }] });
  eq("a hedge is an assessment too", r.extraction.claims[0].kind, "judgement");
}

{
  const r = verifyClaims(OPINION, { claims: [{ key: "no_inhouse_dev_team", value: true, quote: "They lack in-house development capability", confidence: "high", kind: "observation" }] });
  eq("a plain statement of fact stays an observation", r.extraction.claims[0].kind, "observation");
  eq("and is counted as one", r.counters.observations, 1);
}

{
  const r = verifyClaims(OPINION, { claims: [{ key: "no_inhouse_dev_team", value: true, quote: "They lack in-house development capability", confidence: "high", kind: "judgement" }] });
  eq("the model may mark its own claim a judgement and is believed", r.extraction.claims[0].kind, "judgement");
  check("without the lexicon being blamed for it", r.counters.judgement_caught_by_lexicon === undefined);
}

{
  const r = verifyClaims(OPINION, { claims: [{ key: "no_inhouse_dev_team", value: true, quote: "They lack in-house development capability", confidence: "high" }] });
  eq("a missing kind is read as a judgement, never as an observation", r.extraction.claims[0].kind, "judgement");
  eq("and it is counted", r.counters.kind_missing, 1);
}

{
  const r = verifyClaims(OPINION, { claims: [{ key: "is_agency", value: true, quote: "nonsense never written down anywhere", confidence: "high", kind: "observation" }] });
  eq("an unverifiable quote is not re-judged by the lexicon", r.counters.judgement_caught_by_lexicon, undefined);
  eq("it fails on the quote, which is the stronger objection", r.counters.quote_not_in_note, 1);
}

check("judgementMarker finds nothing in a plain observation", judgementMarker("They work with one or two freelancers for web projects.") === null);
check("judgementMarker is case- and punctuation-insensitive", judgementMarker("CLASSIFIED \u2014 genuine") === "classified");
check("the lexicon is not empty", JUDGEMENT_MARKERS.length > 20);

/* ------------------------------------------------------------------ *
 * 4 · the prompt asks for exactly what the validator accepts
 * ------------------------------------------------------------------ */

{
  const prompt = extractionPrompt();
  for (const key of Object.keys(EXTRACTABLE)) {
    check(`the prompt names ${key}`, prompt.includes(key));
  }
  check("the prompt demands a verbatim quote", /WORD FOR WORD/.test(prompt));
  check("the prompt asks which kind of sentence it is", /observation/.test(prompt) && /judgement/.test(prompt));
  check("and shows one of each", /Classified Genuine/.test(prompt));
  check("the prompt says silence is correct", /Silence is correct/.test(prompt));
  check("the prompt names the enum values it will accept", prompt.includes('"buys_real_projects"'));
  eq("the prompt is deterministic", extractionPrompt(), prompt);
}


/* ------------------------------------------------------------------ *
 * 5 · a record that already knows its account
 * ------------------------------------------------------------------ */

{
  // A call or an email is attributed by domain before it reaches the planner; the org map has
  // nothing to say about it, and must not be allowed to refuse it.
  const call = { ...note({ id: 8100, org_id: null, content: PROSE }), account_id: "acct-2" };
  const p = planSweep({ ...BASE, notes: [call], accountByOrg: {} });
  eq("a pre-attributed record is read without an org", p.read.length, 1);
  eq("and keeps the account it arrived with", p.read[0].account_id, "acct-2");
}
{
  // The record's own answer wins: it was worked out from who was actually on the thread.
  const both = { ...note({ id: 8101 }), account_id: "acct-2" };
  const p = planSweep({ ...BASE, notes: [both] });
  eq("an attributed record does not get re-derived from its org", p.read[0].account_id, "acct-2");
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`notes_sweep_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("notes_sweep_test failed");
  }
} else {
  console.log(`notes_sweep_test: ${passed} checks passed`);
}
