/**
 * WLIQ Prospect Book — Pipedrive notes → facts and candidates, tests.
 *
 * Run:  node --experimental-strip-types ingest/pipedrive_notes_test.ts
 *   or: deno run ingest/pipedrive_notes_test.ts
 *
 * Every agency, person and note here is INVENTED (rule 2 — no prospect data in this repo).
 * The two fixture families are the SHAPES the real notes come in, re-cast on made-up
 * agencies: a structured screening summary written by a rater, and a prose client profile.
 * What is being tested is the judgement, not the text.
 *
 * The five rules the module exists to enforce, each pinned below:
 *   1. No quote, no fact.
 *   2. A machine never overrules a person.
 *   3. Dates come from the source, not from the run.
 *   4. Disagreement is surfaced, not settled.
 *   5. Re-running is free.
 */

import {
  isoDate,
  mapPipedriveNotes,
  noteFingerprint,
  noteUrl,
  sameValue,
  stripHtml,
} from "./pipedrive_notes.ts";
import type {
  ExistingFact,
  ExtractedClaim,
  MapNotesInput,
  NoteExtraction,
  PipedriveNote,
} from "./pipedrive_notes.ts";

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
 * fixtures — synthetic, mirroring the two real note shapes
 * ------------------------------------------------------------------ */

/** Shape 1: a rater's structured screening summary. HTML, because Pipedrive stores HTML. */
const SCREENING: PipedriveNote = {
  id: 9001,
  org_id: 4242,
  user_name: "Rater",
  add_time: "2025-03-04 15:22:10",
  update_time: "2025-03-04 15:22:10",
  content:
    "<p><b>Screening — Harbor Pine Studio</b></p>" +
    "<p>Classified GENUINE. Full-service agency, 14 people, no developers on staff &mdash; " +
    "they subcontract every build.</p>" +
    "<ul><li>Clients are regional banks and a hospital group.</li>" +
    "<li>Retainer work, not one-off projects.</li></ul>",
};

/** Shape 2: a prose client profile, written up after a call. */
const PROFILE: PipedriveNote = {
  id: 9002,
  org_id: 4242,
  user_name: "Rater",
  add_time: "2025-07-19 09:05:00",
  content:
    "<div>Lantern &amp; Field profile. Client base skews small business + nonprofit. " +
    "They have two developers in house and mostly need overflow help.</div>",
};

const BASE: Omit<MapNotesInput, "extractions" | "existing"> = {
  account_id: "acct-harbor-pine",
  notes: [SCREENING, PROFILE],
  extractor: "notes@v1",
  as_of: "2026-09-11",
};

function claim(
  key: string,
  value: unknown,
  quote: string | null,
  confidence: ExtractedClaim["confidence"] = "high",
): ExtractedClaim {
  return { key, value, quote, confidence };
}

function run(extractions: NoteExtraction[], existing: ExistingFact[] = [], over: Partial<MapNotesInput> = {}) {
  return mapPipedriveNotes({ ...BASE, extractions, existing, ...over });
}

/* ------------------------------------------------------------------ *
 * 1 · helpers
 * ------------------------------------------------------------------ */

eq(
  "stripHtml turns block tags into line breaks",
  stripHtml("<p>one</p><p>two</p>"),
  "one\ntwo",
);
eq("stripHtml decodes the entities Pipedrive emits", stripHtml("A &amp; B &quot;C&quot; &#39;D&#39;"), 'A & B "C" \'D\'');
eq("stripHtml collapses runs of spaces", stripHtml("<p>a     b</p>"), "a b");
eq("stripHtml of empty is empty", stripHtml(""), "");

eq("isoDate reads the Pipedrive space-separated stamp", isoDate("2025-03-04 15:22:10"), "2025-03-04");
eq("isoDate reads an ISO stamp", isoDate("2025-03-04T15:22:10Z"), "2025-03-04");
eq("isoDate of nonsense is null", isoDate("last Tuesday"), null);
eq("isoDate of null is null", isoDate(null), null);
eq("isoDate of a number is null", isoDate(1741101730), null);

check("sameValue compares scalars", sameValue(14, 14) && !sameValue(14, 15));
check("sameValue treats null and undefined alike", sameValue(null, undefined));
check("sameValue compares structures", sameValue({ a: [1, 2] }, { a: [1, 2] }));
check("sameValue separates true from 'true'", !sameValue(true, "true"));

eq("noteUrl points back at the organization", noteUrl(SCREENING), "https://app.pipedrive.com/organization/4242#note-9001");
eq("noteUrl is null without an org", noteUrl({ ...SCREENING, org_id: null }), null);

eq("noteFingerprint is stable", noteFingerprint(["a", "b"]), noteFingerprint(["a", "b"]));
check("noteFingerprint separates the parts", noteFingerprint(["ab", "c"]) !== noteFingerprint(["a", "bc"]));
check("noteFingerprint is eight hex characters", /^[0-9a-f]{8}$/.test(noteFingerprint(["x"])));

/* ------------------------------------------------------------------ *
 * 2 · rule 1 — no quote, no fact
 * ------------------------------------------------------------------ */

{
  const r = run([{
    note_id: 9001,
    claims: [
      claim("no_inhouse_dev_team", true, "no developers on staff — they subcontract every build"),
      claim("sells_build_work", true, null),
    ],
  }]);
  eq("a quoted, high-confidence claim becomes one fact", r.facts.length, 1);
  eq("the quoted claim is the one that wrote", r.facts[0].key, "no_inhouse_dev_team");
  eq("the unquoted claim becomes a candidate", r.candidates.map((c) => c.key), ["sells_build_work"]);
  eq("a fact from a note is labelled evidence", r.facts[0].evidence_label, "evidence");
  eq("a candidate is never labelled evidence", r.candidates[0].evidence_label, "inferred");
  check("the fact carries the sentence it came from", r.facts[0].note.includes("no developers on staff"));
  check("the fact carries a link back to the note", r.facts[0].evidence_url === noteUrl(SCREENING));
  check("the candidate says why it is waiting", r.candidates[0].note.includes("No supporting sentence"));
  eq("the candidate belongs to the account", r.candidates[0].account_id, "acct-harbor-pine");
  eq("counters count the write", r.counters.facts_written, 1);
  eq("counters count the queue", r.counters.queued_no_quote, 1);
}

{
  const r = run([{
    note_id: 9001,
    claims: [claim("headcount", 14, "Full-service agency, 14 people", "medium")],
  }]);
  eq("a quoted claim below high confidence still waits for a person", r.facts.length, 0);
  eq("it waits as a candidate", r.candidates.length, 1);
  eq("the candidate keeps the quote for the reviewer", r.candidates[0].quote, "Full-service agency, 14 people");
  eq("the candidate keeps the extractor's own confidence", r.candidates[0].confidence, "medium");
  eq("counters separate low confidence from no quote", r.counters.queued_low_confidence, 1);
}

{
  const r = run([{ note_id: 9001, claims: [claim("headcount", 14, "   ")] }]);
  eq("whitespace is not a quote", r.facts.length, 0);
  eq("whitespace queues as no quote", r.counters.queued_no_quote, 1);
}

/* ------------------------------------------------------------------ *
 * 3 · rule 2 — a machine never overrules a person
 * ------------------------------------------------------------------ */

const HUMAN_HELD: ExistingFact = {
  key: "headcount",
  value: 40,
  evidence_label: "evidence",
  source: "rater_entry",
  observed_at: "2026-01-04",
  entered_by: "owner",
};

{
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "Full-service agency, 14 people")] }],
    [HUMAN_HELD],
  );
  eq("a note never overwrites what a person recorded", r.facts.length, 0);
  eq("it queues instead", r.candidates.length, 1);
  eq("the candidate shows what the book holds", r.candidates[0].current_value, 40);
  eq("the candidate says the two disagree", r.candidates[0].conflicts, true);
  check("the candidate names the source it deferred to", r.candidates[0].note.includes("rater_entry"));
  eq("counters count the deferral", r.counters.deferred_to_human, 1);
}

{
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 40, "Full-service agency, 40 people")] }],
    [HUMAN_HELD],
  );
  eq("agreeing with a person is corroboration, not a conflict", r.facts.length, 1);
  eq("nothing queues", r.candidates.length, 0);
  check("no deferral is counted", r.counters.deferred_to_human === undefined);
}

{
  const apolloHeld: ExistingFact = {
    key: "headcount",
    value: 115,
    evidence_label: "evidence",
    source: "apollo",
    observed_at: "2026-09-10",
  };
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "Full-service agency, 14 people")] }],
    [apolloHeld],
  );
  eq("a note does overrule a machine source", r.facts.length, 1);
  eq("the note's value is the one written", r.facts[0].value, 14);
  eq("the overruled machine value is reported", r.counters.conflicts_resolved_to_note, 1);
  check("the disagreement is said out loud", r.notes.some((n) => n.includes("apollo")));
}

{
  // The caller can widen or narrow what a note may supersede without touching the module.
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "Full-service agency, 14 people")] }],
    [HUMAN_HELD],
    { may_supersede: ["rater_entry"] },
  );
  eq("may_supersede is the caller's lever", r.facts.length, 1);
}

{
  const inferredHeld: ExistingFact = {
    key: "headcount",
    value: 40,
    evidence_label: "inferred",
    source: "rater_entry",
    observed_at: "2026-01-04",
  };
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "Full-service agency, 14 people")] }],
    [inferredHeld],
  );
  eq("only an evidence-labelled human fact blocks a write", r.facts.length, 1);
}

{
  // Two facts for one key: the later observation is what the book holds today.
  const r = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "Full-service agency, 14 people")] }],
    [
      { key: "headcount", value: 9, evidence_label: "evidence", source: "rater_entry", observed_at: "2024-02-02" },
      { key: "headcount", value: 40, evidence_label: "evidence", source: "rater_entry", observed_at: "2026-01-04" },
    ],
  );
  eq("the freshest existing fact is the one compared against", r.candidates[0].current_value, 40);
}

/* ------------------------------------------------------------------ *
 * 4 · rule 3 — dates come from the source
 * ------------------------------------------------------------------ */

{
  const r = run([
    { note_id: 9001, claims: [claim("no_inhouse_dev_team", true, "no developers on staff")] },
    { note_id: 9002, claims: [claim("client_budget_size", "local_small", "Client base skews small business + nonprofit")] },
  ]);
  eq("each fact is dated by its own note", r.facts.map((f) => f.observed_at), ["2025-03-04", "2025-07-19"]);
  check("no fact is dated by the run", r.facts.every((f) => f.observed_at !== BASE.as_of));
}

{
  const future: PipedriveNote = { ...SCREENING, id: 9003, add_time: "2027-01-01 00:00:00" };
  const r = run(
    [{ note_id: 9003, claims: [claim("headcount", 14, "14 people")] }],
    [],
    { notes: [future] },
  );
  eq("a note dated after as_of is not read", r.facts.length + r.candidates.length, 0);
  eq("and it is counted", r.counters.notes_after_as_of, 1);
  check("and it is explained", r.notes.some((n) => n.includes("after as_of")));
}

{
  const undated: PipedriveNote = { ...SCREENING, id: 9004, add_time: "" };
  const r = run(
    [{ note_id: 9004, claims: [claim("headcount", 14, "14 people")] }],
    [],
    { notes: [undated] },
  );
  eq("an undated note yields nothing", r.facts.length + r.candidates.length, 0);
  eq("and it is counted", r.counters.notes_without_a_date, 1);
}

{
  const r = run([{ note_id: 9999, claims: [claim("headcount", 14, "14 people")] }]);
  eq("an extraction with no note behind it yields nothing", r.facts.length + r.candidates.length, 0);
  eq("and it is counted", r.counters.extractions_without_a_note, 1);
}

/* ------------------------------------------------------------------ *
 * 5 · rule 5 — re-running is free
 * ------------------------------------------------------------------ */

{
  const ex: NoteExtraction[] = [{
    note_id: 9001,
    claims: [claim("no_inhouse_dev_team", true, "no developers on staff")],
  }];
  const a = run(ex);
  const b = run(ex);
  eq("the same input maps to the same output", JSON.stringify(a), JSON.stringify(b));
  eq("the fingerprint survives a second run", a.facts[0].fingerprint, b.facts[0].fingerprint);
}

{
  const r = run([
    { note_id: 9001, claims: [claim("headcount", 14, "14 people")] },
    { note_id: 9001, claims: [claim("headcount", 14, "14 people")] },
  ]);
  eq("the same key from the same note emits once", r.facts.length, 1);
  eq("the repeat is counted", r.counters.claims_duplicate_in_batch, 1);
}

{
  const edited: PipedriveNote = { ...SCREENING, update_time: "2025-06-01 10:00:00" };
  const before = run([{ note_id: 9001, claims: [claim("headcount", 14, "14 people")] }]);
  const after = run(
    [{ note_id: 9001, claims: [claim("headcount", 14, "14 people")] }],
    [],
    { notes: [edited, PROFILE] },
  );
  check(
    "editing the note re-opens it for extraction",
    before.facts[0].fingerprint !== after.facts[0].fingerprint,
  );
}

{
  const v1 = run([{ note_id: 9001, claims: [claim("headcount", 14, "14 people")] }]);
  const v2 = run([{ note_id: 9001, claims: [claim("headcount", 14, "14 people")] }], [], { extractor: "notes@v2" });
  check(
    "a new extractor version re-reads every note",
    v1.facts[0].fingerprint !== v2.facts[0].fingerprint,
  );
}

{
  const r = run([{ note_id: 9001, claims: [claim("headcount", 14, "14 people"), claim("is_agency", true, "Full-service agency")] }]);
  check("two keys from one note get two fingerprints", r.facts[0].fingerprint !== r.facts[1].fingerprint);
}

/* ------------------------------------------------------------------ *
 * 6 · malformed input is skipped, never guessed at
 * ------------------------------------------------------------------ */

{
  const r = run([{
    note_id: 9001,
    claims: [
      { key: "", value: 14, quote: "14 people", confidence: "high" },
      { key: "headcount", value: undefined, quote: "14 people", confidence: "high" },
      claim("headcount", 14, "14 people"),
    ],
  }]);
  eq("a claim without a key is dropped", r.counters.claims_malformed, 2);
  eq("the sound claim still writes", r.facts.length, 1);
}

{
  const r = run([]);
  eq("no extractions, no output", r.facts.length + r.candidates.length, 0);
  eq("and no complaints", r.notes.length, 0);
}

/* ------------------------------------------------------------------ *
 * 7 · purity — the module reads nothing but its input
 * ------------------------------------------------------------------ */

{
  const ex: NoteExtraction[] = [{ note_id: 9001, claims: [claim("headcount", 14, "14 people")] }];
  const input: MapNotesInput = { ...BASE, extractions: ex, existing: [HUMAN_HELD] };
  const snapshot = JSON.stringify(input);
  mapPipedriveNotes(input);
  eq("mapping does not mutate its input", JSON.stringify(input), snapshot);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`pipedrive_notes_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("pipedrive_notes_test failed");
  }
} else {
  console.log(`pipedrive_notes_test: ${passed} checks passed`);
}
