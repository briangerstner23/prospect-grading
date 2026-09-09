/**
 * WLIQ Prospect Book — Orbit quotes mapper tests.
 *
 * Run:  node --experimental-strip-types ingest/orbit_quotes_test.ts
 *   or: deno run ingest/orbit_quotes_test.ts
 *
 * Every account and project here is synthetic.
 */

import { LIFE_CYCLE_TO_SIGNAL, mapOrbitQuotes, ORBIT_PROJECT_URL_BASE, projectEvidence, signalTypeForLifeCycle } from "./orbit_quotes.ts";
import type { OrbitProjectRow } from "./orbit_quotes.ts";
import { norm } from "./identity.ts";
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

/* ---- the catalog entries the mapper reads, in the shape of core/rubric.prospect.v0.1.json ---- */
const RUBRIC = {
  version: "0.1.0",
  signals: {
    catalog: {
      quote_requested: { weight: 9, lifespan_days: 14, decays: true, sla_hours: 8 },
      quote_sent: { weight: 8, lifespan_days: 30, decays: true },
      orbit_verbally_accepted: { weight: 8, lifespan_days: 30, decays: true },
      orbit_pa_sent: { weight: 8, lifespan_days: 30, decays: true },
      orbit_pa_signed: { weight: 8, lifespan_days: 60, decays: false },
    },
  },
};

const acc = (id: string, name: string, domain: string | null = null, orbit_client_id: number | string | null = null): KnownAccount => ({
  id, key: norm(name), name, domain, pipedrive_org_id: null, orbit_client_id,
});

const KNOWN: KnownAccount[] = [
  acc("a1", "Harbor & Pine Creative", "harborpine.com", 501),
  acc("a2", "Northfield Digital", "northfield.digital", 505),
  acc("a3", "Bluewater Collective"),
  acc("a4", "Harbor Pine Studios", null, 503),
];

const base: OrbitProjectRow = {
  id: 9001,
  title: "Website rebuild",
  url: "website-rebuild-9001",
  project_number: "P-9001",
  status: "Quote",
  life_cycle_status: "quoted",
  project_type: "Fixed Cost",
  client_name: "Harbor & Pine Creative",
  sub_client_name: null,
  quoted_hours: 120,
  created_at: "2026-08-20T10:00:00Z",
  project_start_date: "2026-09-01",
  project_due_date: "2026-10-15",
  project_payment_cost: 12000,
  client_id: 501,
};

/* ------------------------------------------------------------------ *
 * 1 · a high match attaches: signal + quote_amount fact
 * ------------------------------------------------------------------ */
{
  const r = mapOrbitQuotes([base], KNOWN, RUBRIC);
  eq("one signal on the attached account", r.signals.map((s) => s.account_id), ["a1"]);
  const s = r.signals[0];
  eq("quoted → quote_sent", s.type, "quote_sent");
  eq("observed_at is the project's created_at", s.observed_at, "2026-08-20T10:00:00.000Z");
  eq("weight / lifespan / decays from the catalog", [s.weight, s.lifespan_days, s.decays], [8, 30, true]);
  eq("source and entered_by", [s.source, s.entered_by], ["orbit", "system:orbit"]);
  eq("evidence_url is the Orbit project URL from the slug", s.evidence_url, `${ORBIT_PROJECT_URL_BASE}website-rebuild-9001`);
  eq("payload carries project id, slug, title, hours and cost", [s.payload.project_id, s.payload.url_slug, s.payload.title, s.payload.quoted_hours, s.payload.project_payment_cost], [9001, "website-rebuild-9001", "Website rebuild", 120, 12000]);
  eq("cost > 0 → quote_amount fact (evidence)", r.facts.map((f) => [f.account_id, f.key, f.value, f.evidence_label, f.source]), [["a1", "quote_amount", 12000, "evidence", "orbit"]]);
  eq("fact observed_at is the created_at date", r.facts[0].observed_at, "2026-08-20");
  eq("fact evidence_url matches the signal's", r.facts[0].evidence_url, s.evidence_url);
  eq("summary", r.summary, { attached: 1, unmatched: 0, pending_review: 0, skipped: 0, by_type: { quote_sent: 1 } });
  eq("no candidates, no unmatched", [r.candidates.length, r.unmatched.length], [0, 0]);
}

/* ------------------------------------------------------------------ *
 * 2 · the life_cycle_status map
 * ------------------------------------------------------------------ */
{
  const lc = (life_cycle_status: string | null | undefined, id: number): OrbitProjectRow => ({ ...base, id, life_cycle_status, project_payment_cost: null });
  const r = mapOrbitQuotes(
    [lc("quoted", 1), lc("refine", 2), lc("verbally_accepted", 3), lc("pa_sent", 4), lc("pa_signed", 5), lc("not_set", 6), lc(null, 7), lc(undefined, 8), lc("PA Sent", 9), lc("something_else", 10)],
    KNOWN,
    RUBRIC,
  );
  eq("map per §4c, missing → quote_requested, spelling-insensitive, unrecognised → quote_requested", r.signals.map((s) => s.type), [
    "quote_sent", "quote_sent", "orbit_verbally_accepted", "orbit_pa_sent", "orbit_pa_signed", "quote_requested", "quote_requested", "quote_requested", "orbit_pa_sent", "quote_requested",
  ]);
  eq("pa_signed does not decay and lives 60 days (catalog)", [r.signals[4].decays, r.signals[4].lifespan_days], [false, 60]);
  eq("quote_requested carries the catalog weight 9", r.signals[5].weight, 9);
  eq("by_type counts signals written", r.summary.by_type, { quote_sent: 2, orbit_verbally_accepted: 1, orbit_pa_sent: 2, orbit_pa_signed: 1, quote_requested: 4 });
  check("an unrecognised life_cycle_status is noted", r.notes.some((n) => /something_else/.test(n)), JSON.stringify(r.notes));
  eq("no cost → no quote_amount facts", r.facts, []);
  eq("LIFE_CYCLE_TO_SIGNAL is the §4c table", LIFE_CYCLE_TO_SIGNAL, { quoted: "quote_sent", refine: "quote_sent", verbally_accepted: "orbit_verbally_accepted", pa_sent: "orbit_pa_sent", pa_signed: "orbit_pa_signed", not_set: "quote_requested" });
  eq("signalTypeForLifeCycle flags the unrecognised", signalTypeForLifeCycle("cancelled"), { type: "quote_requested", recognised: false });
}

/* ------------------------------------------------------------------ *
 * 3 · identity: only high attaches
 * ------------------------------------------------------------------ */
{
  // Same client name as a2 but no client_id: norm(name) is MEDIUM → candidate, signal held.
  const r = mapOrbitQuotes([{ ...base, id: 2001, client_name: "Northfield Digital", client_id: null }], KNOWN, RUBRIC);
  eq("a name-only match writes no signal", r.signals, []);
  eq("...and no fact", r.facts, []);
  eq("...but a medium candidate row for a2", r.candidates.map((c) => [c.account_id, c.matched_on, c.confidence, c.source, c.source_name]), [["a2", "name_exact", "medium", "orbit", "Northfield Digital"]]);
  eq("...counted as pending review", [r.summary.attached, r.summary.pending_review, r.summary.unmatched], [0, 1, 0]);
  check("candidate note explains the hold", /only high attaches/.test(r.candidates[0].note), r.candidates[0].note);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 2002, client_name: "Bluewater Collectives", client_id: null }], KNOWN, RUBRIC);
  eq("a plural spelling is a LOW trigram candidate", r.candidates.map((c) => [c.account_id, c.matched_on, c.confidence]), [["a3", "name_trigram", "low"]]);
  eq("...not attached", r.signals.length, 0);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 2003, client_name: "Totally Unrelated Co", client_id: null }], KNOWN, RUBRIC);
  eq("no match → unmatched row with matched_on none, confidence low", r.unmatched.map((u) => [u.source, u.source_id, u.source_name, u.matched_on, u.confidence]), [["orbit", "2003", "Totally Unrelated Co", "none", "low"]]);
  eq("...counted", r.summary.unmatched, 1);
  check("...note names the client and the quote", /Totally Unrelated Co/.test(r.unmatched[0].note) && /P-9001/.test(r.unmatched[0].note), r.unmatched[0].note);
}
{
  // Two quotes for the same unmatched client: one candidate row, two quotes counted.
  const r = mapOrbitQuotes(
    [{ ...base, id: 2004, client_name: "Totally Unrelated Co", client_id: null, project_number: "P-2004" }, { ...base, id: 2005, client_name: "Totally Unrelated Co", client_id: null, project_number: "P-2005" }],
    KNOWN,
    RUBRIC,
  );
  eq("one unmatched row per distinct client", r.unmatched.length, 1);
  eq("...summary counts quotes", r.summary.unmatched, 2);
  check("...the note lists both projects", /P-2004/.test(r.unmatched[0].note) && /P-2005/.test(r.unmatched[0].note), r.unmatched[0].note);
}
{
  // orbit_client_id is the join once the client list is loaded: the name can be anything.
  const r = mapOrbitQuotes([{ ...base, id: 2006, client_name: "H&P (Orbit spelling)", client_id: "505" }], KNOWN, RUBRIC);
  eq("orbit_client_id (as a string) attaches regardless of the name", r.signals.map((s) => s.account_id), ["a2"]);
}
{
  // Attached on id to a1, but the name also matches a4 at low: the conflict is surfaced as a candidate.
  const r = mapOrbitQuotes([{ ...base, id: 2007, client_name: "Harbor Pine Studio", client_id: 501 }], KNOWN, RUBRIC);
  eq("attached to the high match", r.signals.map((s) => s.account_id), ["a1"]);
  eq("the other account that matched is a candidate row", r.candidates.map((c) => [c.account_id, c.confidence]), [["a4", "low"]]);
  check("...marked as a conflict", /conflict/.test(r.candidates[0].note), r.candidates[0].note);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 2008, client_name: null, client_id: null }], KNOWN, RUBRIC);
  eq("no client name and no id → unmatched with a null name (never a guess)", r.unmatched.map((u) => [u.source_name, u.matched_on]), [[null, "none"]]);
}

/* ------------------------------------------------------------------ *
 * 4 · skips, dates, costs, URLs
 * ------------------------------------------------------------------ */
{
  const r = mapOrbitQuotes([{ ...base, id: 3001, status: "Active" }], KNOWN, RUBRIC);
  eq("a non-Quote status is skipped", [r.signals.length, r.summary.skipped], [0, 1]);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3002, status: null }], KNOWN, RUBRIC);
  eq("a missing status is tolerated (the caller filtered on Quote)", r.signals.length, 1);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3003, created_at: null }], KNOWN, RUBRIC);
  eq("no created_at → observed_at from project_start_date", r.signals[0]?.observed_at, "2026-09-01T00:00:00.000Z");
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3004, created_at: null, project_start_date: null }], KNOWN, RUBRIC);
  eq("no date at all and no as_of → skipped, never a clock", [r.signals.length, r.summary.skipped], [0, 1]);
  const r2 = mapOrbitQuotes([{ ...base, id: 3004, created_at: null, project_start_date: null }], KNOWN, RUBRIC, { as_of: "2026-09-09" });
  eq("...with as_of the caller's date is used", r2.signals[0]?.observed_at, "2026-09-09T00:00:00.000Z");
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3005, project_payment_cost: "$8,500.00" }], KNOWN, RUBRIC);
  eq("a dollar string cost parses", r.facts[0]?.value, 8500);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3006, project_payment_cost: 0 }, { ...base, id: 3007, project_payment_cost: null }, { ...base, id: 3008, project_payment_cost: "n/a" }], KNOWN, RUBRIC);
  eq("cost 0, null or unparseable → no quote_amount fact", r.facts, []);
  eq("...the signals are still written", r.signals.length, 3);
  eq("...the unparseable one is noted", r.notes.filter((n) => /not a number/.test(n)).length, 1);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3009, url: null }], KNOWN, RUBRIC);
  eq("no url → evidence_url null", [r.signals[0]?.evidence_url, r.facts[0]?.evidence_url], [null, null]);
}
{
  const r = mapOrbitQuotes([{ ...base, id: 3010, url: "https://app.whitelabeliq.com/93640173/project/website-rebuild-3010" }], KNOWN, RUBRIC);
  eq("a full URL is kept as evidence_url and its slug extracted", [r.signals[0]?.evidence_url, r.signals[0]?.payload.url_slug], ["https://app.whitelabeliq.com/93640173/project/website-rebuild-3010", "website-rebuild-3010"]);
}
eq("projectEvidence of a slug", projectEvidence("/abc-1/"), { slug: "abc-1", evidence_url: `${ORBIT_PROJECT_URL_BASE}abc-1` });
eq("projectEvidence of empty", projectEvidence("  "), { slug: null, evidence_url: null });
{
  const r = mapOrbitQuotes([{ ...base, id: 3011, quoted_hours: "40.5" }], KNOWN, RUBRIC, { entered_by: "sync@example.test" });
  eq("quoted_hours as a string parses", r.signals[0]?.payload.quoted_hours, 40.5);
  eq("entered_by option flows to signals and facts", [r.signals[0]?.entered_by, r.facts[0]?.entered_by], ["sync@example.test", "sync@example.test"]);
}
{
  const r = mapOrbitQuotes([base], KNOWN, { signals: { catalog: {} } });
  eq("a catalog without the type writes no signal (never invents a weight)", [r.signals.length, r.summary.skipped], [0, 1]);
}
{
  const r = mapOrbitQuotes([], KNOWN, RUBRIC);
  eq("empty input → empty output", r, { signals: [], facts: [], unmatched: [], candidates: [], summary: { attached: 0, unmatched: 0, pending_review: 0, skipped: 0, by_type: {} }, notes: [] });
}
{
  const rows = [base, { ...base, id: 2001, client_name: "Northfield Digital", client_id: null }, { ...base, id: 2003, client_name: "Totally Unrelated Co", client_id: null }];
  eq("mapOrbitQuotes is deterministic", JSON.stringify(mapOrbitQuotes(rows, KNOWN, RUBRIC)), JSON.stringify(mapOrbitQuotes(rows, KNOWN, RUBRIC)));
  const r = mapOrbitQuotes(rows, KNOWN, RUBRIC);
  eq("attached + pending_review + unmatched + skipped = rows", r.summary.attached + r.summary.pending_review + r.summary.unmatched + r.summary.skipped, rows.length);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`orbit_quotes_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("orbit_quotes_test failed");
  }
} else {
  console.log(`orbit_quotes_test: ${passed} checks passed`);
}
