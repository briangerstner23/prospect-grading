/**
 * Sanity checks for the page's pure helpers.
 *
 * web/index.html keeps its pure helpers between the `@pure-start` and `@pure-end` markers:
 * no DOM, no clock, no network, no page state. This script slices that block out of the
 * HTML and evaluates it under Node in an EMPTY vm context — a helper that leans on anything
 * declared outside the block is a ReferenceError here before it is a bug in a browser.
 *
 *   node --experimental-strip-types scripts/page_pure_test.ts
 *
 * Plain script, no framework: prints "page_pure: N checks, F failed" and exits non-zero on
 * any failure.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
// The meeting review's mirrors are pinned against the modules they mirror (DECISIONS §65).
import { coerceClaimValue, EXTRACTABLE, keysFor } from "../ingest/notes_sweep.ts";
import type { ClaimShape } from "../ingest/notes_sweep.ts";
import { BLOCKING_FLAGS, DEFAULT_OVERRIDE_CODE, defaultSelected, defaultText, HISTORIC_DAYS, PERSON_SOURCES } from "../ingest/meeting_claims.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "..", "web", "index.html");
const page = readFileSync(pagePath, "utf8");

/* ------------------------------------------------------------------ *
 * Slice the block and evaluate it with nothing else in scope
 * ------------------------------------------------------------------ */
function sliceBlock(html: string): string {
  const startMark = html.indexOf("@pure-start");
  const endMark = html.indexOf("@pure-end");
  if (startMark < 0 || endMark < 0 || endMark < startMark) throw new Error("page_pure: @pure-start / @pure-end markers not found in web/index.html");
  const start = html.indexOf("*/", startMark) + 2; // the end of the marker's own comment
  const end = html.lastIndexOf("/*", endMark); // the start of the closing marker's comment
  return html.slice(start, end);
}

const block = sliceBlock(page);
const declared = [...block.matchAll(/^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm)].map((m) => m[1] ?? m[2]);
if (!declared.length) throw new Error("page_pure: no declarations found inside the pure block");

// deno-lint-ignore no-explicit-any
type Helpers = Record<string, any>;
const helpers: Helpers = vm.runInNewContext(
  `(function () {\n${block}\nreturn { ${declared.join(", ")} };\n})()`,
  {},
  { filename: "web/index.html#pure" },
);

/* ------------------------------------------------------------------ *
 * A tiny harness
 * ------------------------------------------------------------------ */
let checks = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (!ok) {
    failed++;
    console.error(`FAIL  ${name}${detail === undefined ? "" : "\n      " + safeJson(detail)}`);
  }
}
function safeJson(v: unknown): string {
  try { return JSON.stringify(v, (_k, x) => (typeof x === "symbol" ? x.toString() : x)); } catch { return String(v); }
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return safeJson(a) === safeJson(b) && typeof a === typeof b;
}
function eq(name: string, actual: unknown, expected: unknown): void { check(name, same(actual, expected), { actual, expected }); }
function includes(name: string, actual: unknown, needle: string): void { check(name, typeof actual === "string" && actual.includes(needle), { actual, needle }); }

const {
  compareKey, orderAccounts, usableKey, pickBand, coerceFactValue, overrideCapWarning, INVALID,
  ageWords, strengthWords, headcountWords, ratioWords, factValueWords, safeUrl, rowMatches,
  catalogEntries, signalCatalogWords, mergeTargets, movedWords, reviewEffectWords,
  rulesWithInputs, ruleFired, evidenceUse, quoteFromNote, stalenessNote,
  groupFactCandidates, valueGroupKey,
  MEETING_KIND_ORDER, MEETING_DEFAULT_OVERRIDE_CODE, MEETING_HISTORIC_DAYS, MEETING_BLOCKING_FLAGS, MEETING_KEY_SHAPES,
  meetingValue, scrubAddresses, meetingDefaultTick, meetingStartsTicked, groupMeetingCards, addDaysIso, dayMonthWords,
  tiersMoved, meetingRowWords, meetingFlagWords, meetingCellWords, overrideDefaults, removalDispositions, removalCodesFor,
  removalPair, removalEdit, cardItems, cardProblems, shortcutAction, decidedWords, meetingCounts, meetingCountWords,
  meetingsWaiting, pickMeeting, clockSecondsOf, fathomAt, meetingLengthWords, contextLines,
  MEETING_PERSON_SOURCES, meetingDefaultText, meetingSameValue, meetingLiveFlags, readTierWords,
  MEETING_SCREEN_FLAGS, meetingPersonHeld, meetingLiveRow, meetingOverrules, meetingsMissing, meetingPickList, pagedRows,
  meetingBoardShows, mergeReads, meetingReadOf, meetingSentValue, meetingTickBasis, meetingTick, placeCardNotices,
} = helpers;

function run(): void {
/* ---- the block exports what the page and this script expect ---- */
for (const name of ["compareKey", "orderAccounts", "usableKey", "pickBand", "coerceFactValue", "overrideCapWarning", "INVALID", "factValueWords", "rowMatches", "reviewEffectWords", "mergeTargets", "evidenceUse", "quoteFromNote"]) {
  check(`block declares ${name}`, name in helpers && helpers[name] !== undefined);
}
check("INVALID is a symbol", typeof INVALID === "symbol");
check("the block references no page global (the page's own names must not appear)", !/\b(state|document|window|\$\(|TIER_ORDER|FACT_KEYS|CLIMB_FALLBACK)\b/.test(block), { hint: "a pure helper reached outside the @pure block" });

/* ---- compareKey: chase_rank_key comparison, best first ---- */
check("compareKey: numbers compare numerically", compareKey([0, 0, 0, 0, "a"], [0, 0, 0, 0, "b"]) < 0);
check("compareKey: earlier position wins", compareKey([1, 0], [0, 9]) > 0);
check("compareKey: equal keys are 0", compareKey([0, 1, "x"], [0, 1, "x"]) === 0);
check("compareKey: a shorter key sorts first", compareKey([0], [0, 1]) < 0);
check("compareKey: strings compare case-insensitively (a == A)", compareKey(["a"], ["A"]) === 0);
check("compareKey: strings compare alphabetically", compareKey(["Beta"], ["alpha"]) > 0);
check("compareKey: 10 after 9, not before (numeric, not lexical)", compareKey([10], [9]) > 0);

/* ---- orderAccounts: read rows by key, unread rows last by name ---- */
{
  const accounts = [{ id: "x", name: "Zed Agency" }, { id: "y", name: "Alpha Studio" }, { id: "z", name: "Mid Co" }, { id: "w", name: "beta works" }];
  const reads = new Map<string, unknown>([
    ["x", { scorecard: { chase_rank_key: [1, 0, 0, 0, "zed agency"] } }],
    ["z", { scorecard: { chase_rank_key: [0, 2, 0, 0, "mid co"] } }],
  ]);
  eq("orderAccounts: scored rows first by key, unscored last by name", orderAccounts(accounts, reads).map((a: { id: string }) => a.id), ["z", "x", "y", "w"]);
  const tie = new Map<string, unknown>([["x", { scorecard: { chase_rank_key: [0, 0] } }], ["y", { scorecard: { chase_rank_key: [0, 0] } }]]);
  eq("orderAccounts: equal keys fall back to the name", orderAccounts(accounts.slice(0, 2), tie).map((a: { id: string }) => a.id), ["y", "x"]);
  const original = accounts.map((a) => a.id);
  orderAccounts(accounts, reads);
  eq("orderAccounts: does not mutate its input", accounts.map((a) => a.id), original);
  eq("orderAccounts: a read without a scorecard still counts as scored", orderAccounts([{ id: "a", name: "A" }, { id: "b", name: "B" }], new Map([["b", {}]])).map((a: { id: string }) => a.id), ["b", "a"]);
}

/* ---- usableKey: an absent chase key must not outrank a real one ----
 *
 * compareKey gives a missing element its rung, so an empty key compares ahead of
 * everything. A read carrying no chase_rank_key would therefore sort above a Platinum.
 * No live row does that today, but pb-score writes pb_reads in batches and tolerates a
 * failed batch, so a half-written run can produce one.
 */
{
  check("usableKey: a populated array is usable", usableKey([0, 1]) === true);
  check("usableKey: an empty array is not", usableKey([]) === false);
  check("usableKey: undefined is not", usableKey(undefined) === false);
  check("usableKey: null is not", usableKey(null) === false);
  check("usableKey: a non-array is not", usableKey("0,1") === false);

  // The hazard this guards, stated as the comparator sees it.
  check("compareKey: an empty key still compares ahead of a Platinum (why usableKey exists)", compareKey([], [-3, -4, -3, -4, "Platinum Co"]) < 0);

  const accounts = [{ id: "keyless", name: "Aaa Keyless" }, { id: "platinum", name: "Zzz Platinum" }];
  const reads = new Map<string, unknown>([
    ["keyless", { scorecard: {} }],
    ["platinum", { scorecard: { chase_rank_key: [-3, -4, -3, -4, "zzz platinum"] } }],
  ]);
  eq("orderAccounts: a read with no chase key sorts below one that has a key", orderAccounts(accounts, reads).map((a: { id: string }) => a.id), ["platinum", "keyless"]);

  const bothKeyless = new Map<string, unknown>([["keyless", { scorecard: {} }], ["platinum", { scorecard: { chase_rank_key: [] } }]]);
  eq("orderAccounts: two unusable keys fall back to the name", orderAccounts(accounts, bothKeyless).map((a: { id: string }) => a.id), ["keyless", "platinum"]);
}

/* ---- the null trap, pinned so a future nullable term cannot ship unnoticed ----
 *
 * typeof null === "object", so a null element misses compareKey's numeric branch and is
 * compared as the string "null" — which sorts after every number. An unknown would rank
 * below even the worst known value, which is the sort making unknown into evidence
 * (rule 5). A term whose value can be absent must be emitted as a number the rubric
 * names a position for, never as null. This test records the behaviour; it is not an
 * endorsement of it.
 */
check("compareKey: a null term sorts BELOW a large positive number (rule-5 trap)", compareKey([0, null], [0, 99]) > 0);
check("compareKey: a null term sorts BELOW a large negative number too", compareKey([0, null], [0, -99]) > 0);
check("compareKey: a longer key orders correctly against itself", compareKey([0, 0, 0, -1, -9, "a"], [0, 0, 0, -1, -5, "a"]) < 0);

/* ---- pickBand: [min, max) bands, as the rubric writes them ---- */
{
  const bands = [{ label: "≥ $100K", min: 100000 }, { label: "$46K–100K", min: 46000, max: 100000 }, { label: "$16K–46K", min: 16000, max: 46000 }, { label: "$6K–16K", min: 6000, max: 16000 }, { label: "< $6K", max: 6000 }];
  eq("pickBand: zero lands in the bottom band", pickBand(0, bands), "< $6K");
  eq("pickBand: min is inclusive", pickBand(16000, bands), "$16K–46K");
  eq("pickBand: max is exclusive", pickBand(45999.99, bands), "$16K–46K");
  eq("pickBand: open-ended top band", pickBand(250000, bands), "≥ $100K");
  eq("pickBand: boundary 100000 is the top band", pickBand(100000, bands), "≥ $100K");
  eq("pickBand: no bands → null", pickBand(5, []), null);
  eq("pickBand: undefined bands → null", pickBand(5, undefined), null);
  eq("pickBand: a value outside every band → null", pickBand(-1, [{ min: 0, label: "x" }]), null);
  const bottomUp = [{ max: 6000, label: "low" }, { min: 6000, label: "high" }];
  eq("pickBand: max is exclusive even when the lower band is listed first", pickBand(6000, bottomUp), "high");
  eq("pickBand: just under the boundary stays low", pickBand(5999.99, bottomUp), "low");
}

/* ---- coerceFactValue: form text → pb_facts.value, or INVALID ---- */
eq("coerce bool true", coerceFactValue("bool", "true"), true);
eq("coerce bool false", coerceFactValue("bool", "false"), false);
eq("coerce bool empty → null (recorded unknown)", coerceFactValue("bool", ""), null);
check("coerce bool other → INVALID", coerceFactValue("bool", "maybe") === INVALID);
eq("coerce enum value", coerceFactValue("enum", "ICP-2"), "ICP-2");
eq("coerce enum empty → null", coerceFactValue("enum", ""), null);
eq("coerce int", coerceFactValue("int", "12"), 12);
eq("coerce int with spaces", coerceFactValue("int", " 7 "), 7);
check("coerce int fraction → INVALID", coerceFactValue("int", "1.5") === INVALID);
check("coerce int negative → INVALID", coerceFactValue("int", "-1") === INVALID);
check("coerce int text → INVALID", coerceFactValue("int", "twelve") === INVALID);
eq("coerce int empty → null", coerceFactValue("int", ""), null);
eq("coerce money in dollars", coerceFactValue("money", "2500"), 2500);
eq("coerce money decimals allowed", coerceFactValue("money", "2500.50"), 2500.5);
eq("coerce ratio", coerceFactValue("ratio", "0.4"), 0.4);
eq("coerce ratio 1 allowed", coerceFactValue("ratio", "1"), 1);
check("coerce ratio > 1 → INVALID", coerceFactValue("ratio", "1.5") === INVALID);
eq("coerce list keeps non-empty strings", coerceFactValue("list", ["2nd person engaged", "", 3]), ["2nd person engaged"]);
check("coerce list from a string → INVALID", coerceFactValue("list", "x") === INVALID);
eq("coerce null → null", coerceFactValue("int", null), null);
eq("coerce text trims", coerceFactValue("text", "  hello "), "hello");
eq("coerce text empty → null", coerceFactValue("text", "   "), null);

/* ---- overrideCapWarning: the one-tier cap, explained before the engine refuses ---- */
{
  const order = ["Bronze", "Silver", "Gold", "Platinum"];
  eq("override: no tier chosen → no warning", overrideCapWarning("", "Silver", order), null);
  includes("override: no computed tier → cannot check", overrideCapWarning("Gold", null, order), "cannot check the one-tier cap");
  includes("override: same as computed → already", overrideCapWarning("Gold", "Gold", order), "already");
  includes("override: two tiers away → refused", overrideCapWarning("Platinum", "Silver", order), "beyond one-tier cap");
  includes("override: three tiers away → refused", overrideCapWarning("Bronze", "Platinum", order), "refuse");
  eq("override: one tier up → fine", overrideCapWarning("Gold", "Silver", order), null);
  eq("override: one tier down → fine", overrideCapWarning("Bronze", "Silver", order), null);
}

/* ---- words, never bare scores ---- */
eq("ageWords unknown", ageWords(undefined), "age unknown");
eq("ageWords same day", ageWords(0), "same day as scoring");
eq("ageWords one day", ageWords(1), "a day old");
eq("ageWords days", ageWords(5), "5 days old");
eq("ageWords weeks", ageWords(21), "3 weeks old");
eq("ageWords months", ageWords(90), "3 months old");
eq("ageWords year", ageWords(400), "over a year old");
eq("ageWords future", ageWords(-2), "dated after the scoring day");
eq("strengthWords strong", strengthWords(10, 9, 8, 4), "strong now");
eq("strengthWords medium", strengthWords(6, 5, 8, 4), "medium now");
eq("strengthWords weak", strengthWords(3, 2, 8, 4), "weak now");
eq("strengthWords spent", strengthWords(6, 0, 8, 4), "spent");
eq("strengthWords negative counted", strengthWords(-6, -6), "negative — counted at full weight");
eq("strengthWords unknown", strengthWords(null, 2), "strength unknown");
eq("headcountWords small", headcountWords(8), "1–10 people");
eq("headcountWords mid", headcountWords(50), "11–50 people");
eq("headcountWords large", headcountWords(101), "over 100 people");
eq("headcountWords unknown", headcountWords(null), "unknown");
eq("ratioWords quarter", ratioWords(0.1), "under a quarter");
eq("ratioWords top", ratioWords(0.9), "three quarters or more");
{
  const bands = [{ label: "≥ $100K", min: 100000 }, { label: "< $100K", max: 100000 }];
  eq("factValueWords money → band, never the figure", factValueWords("quote_amount", 120000, bands), "in the ≥ $100K band");
  eq("factValueWords money zero → none", factValueWords("trailing_12m_revenue", 0, bands), "none");
  eq("factValueWords money without bands → no figure printed", factValueWords("deal_size_estimate", 5000, []), "a figure is on record (no band table loaded)");
  eq("factValueWords ratio → words", factValueWords("serviceable_share", 0.6, bands), "a half to three quarters");
  eq("factValueWords headcount → band", factValueWords("headcount", 30, bands), "11–50 people");
  eq("factValueWords null → recorded unknown", factValueWords("headcount", null, bands), "unknown (recorded as checked, not known)");
  eq("factValueWords bool", factValueWords("is_agency", true, bands), "yes");
  eq("factValueWords list", factValueWords("climb_signals", ["a", "b"], bands), "a; b");
  eq("factValueWords empty list", factValueWords("climb_signals", [], bands), "none");
  eq("factValueWords enum passes through", factValueWords("icp_class", "ICP-3", bands), "ICP-3");
}

/* ---- safeUrl: only http(s) becomes a link ---- */
eq("safeUrl https", safeUrl(" https://example.com/x "), "https://example.com/x");
eq("safeUrl javascript: → null", safeUrl("javascript:alert(1)"), null);
eq("safeUrl with a space → null", safeUrl("https://exa mple.com"), null);
eq("safeUrl non-string → null", safeUrl(42), null);

/* ---- rowMatches: the roster filters ---- */
{
  const acc = { name: "Northwind Digital", domain: "northwind.example", roster_source: "pipedrive" };
  const read = { scorecard: { effective_tier: "Gold", status: "Ranked", flags: ["UNVALIDATED (PRO-8)"], cell: "Gold × Embedded", reason: "Chase first." } };
  const none = { q: "", tier: "", status: "", flag: "", source: "" };
  check("rowMatches: empty filters match", rowMatches(acc, read, none));
  check("rowMatches: tier match", rowMatches(acc, read, { ...none, tier: "Gold" }));
  check("rowMatches: tier mismatch", !rowMatches(acc, read, { ...none, tier: "Silver" }));
  check("rowMatches: unscored filter excludes scored rows", !rowMatches(acc, read, { ...none, tier: "unscored" }));
  check("rowMatches: unscored filter includes unread rows", rowMatches(acc, null, { ...none, tier: "unscored" }));
  check("rowMatches: 'none' tier needs a read without a tier", rowMatches(acc, { scorecard: { status: "Unclassified", flags: [] } }, { ...none, tier: "none" }));
  check("rowMatches: status", rowMatches(acc, read, { ...none, status: "Ranked" }) && !rowMatches(acc, read, { ...none, status: "Parked" }));
  check("rowMatches: flag", rowMatches(acc, read, { ...none, flag: "UNVALIDATED (PRO-8)" }) && !rowMatches(acc, read, { ...none, flag: "Direct-to-client" }));
  check("rowMatches: source", rowMatches(acc, read, { ...none, source: "pipedrive" }) && !rowMatches(acc, read, { ...none, source: "gotham" }));
  check("rowMatches: search is case-insensitive over name, domain, cell, reason", rowMatches(acc, read, { ...none, q: "EMBEDDED" }) && rowMatches(acc, read, { ...none, q: "northwind.example" }) && !rowMatches(acc, read, { ...none, q: "acme" }));
}

/* ---- the hand-signal catalog ---- */
{
  const catalog = {
    referral_warm_intro: { label: "Warm intro or referral", weight: 10, lifespan_days: 90, decays: true },
    neg_champion_left: { label: "Champion left", weight: -8, lifespan_days: 90, decays: false },
    prior_grade: { label: "Prior grade", weight: 0, lifespan_days: null, decays: false },
    broken: { label: "no weight" },
  };
  eq("catalogEntries: keeps catalog order, drops unweighted entries", catalogEntries(catalog).map(([k]: [string, unknown]) => k), ["referral_warm_intro", "neg_champion_left", "prior_grade"]);
  eq("catalogEntries: nothing → []", catalogEntries(null), []);
  eq("signalCatalogWords: positive", signalCatalogWords(catalog.referral_warm_intro), "weight 10; expires after 90 days; decays over its lifespan.");
  eq("signalCatalogWords: negative", signalCatalogWords(catalog.neg_champion_left), "negative, weight -8 — a downgrade, counted at full weight; expires after 90 days; does not decay.");
  eq("signalCatalogWords: informational", signalCatalogWords(catalog.prior_grade), "weight 0 — informational, never scores; never expires; does not decay.");
  eq("signalCatalogWords: missing", signalCatalogWords(undefined), "not in the catalog");
}

/* ---- merge targets: other roster rows, by name search ---- */
{
  const roster = [
    { id: "1", name: "Zeta Agency", domain: "zeta.example", book: "prospect" },
    { id: "2", name: "Alpha Studio", domain: "alpha.example", book: "prospect" },
    { id: "3", name: "Alpha Works", domain: null, book: "parked" },
    { id: "4", name: "Gone Co", domain: "gone.example", book: "merged" },
  ];
  eq("mergeTargets: excludes self and merged rows, name order", mergeTargets(roster, "1", "").map((x: { id: string }) => x.id), ["2", "3"]);
  eq("mergeTargets: name search, case-insensitive", mergeTargets(roster, "2", "alpha").map((x: { id: string }) => x.id), ["3"]);
  eq("mergeTargets: domain search", mergeTargets(roster, "2", "zeta.example").map((x: { id: string }) => x.id), ["1"]);
  eq("mergeTargets: limit", mergeTargets(roster, "9", "", 1).map((x: { id: string }) => x.id), ["2"]);
  eq("mergeTargets: no roster → []", mergeTargets(undefined, "1", "x"), []);
}

/* ---- what the two procedures report, in words ---- */
eq("movedWords: counts", movedWords({ facts: 3, signals: 2, contacts: 0 }), "3 facts, 2 signals, 0 contacts");
eq("movedWords: nothing", movedWords(null), "nothing counted");
eq("reviewEffectWords: rejected", reviewEffectWords({ ok: true, decision: "rejected" }), ["rejected; nothing moved"]);
eq("reviewEffectWords: orbit attached", reviewEffectWords({ ok: true, decision: "merged", effect: { orbit_client_id_set: true, orbit_client_id: "77" } }), ["Orbit client id attached"]);
eq("reviewEffectWords: orbit already set", reviewEffectWords({ decision: "merged", effect: { orbit_client_id_set: false } }), ["Orbit client id left as it was (the row already had one)"]);
eq("reviewEffectWords: pipedrive merge names the survivor", reviewEffectWords({ decision: "merged", effect: { ok: true, merged_into: "t1", moved: { facts: 2, calls: 1 } } }, (id: string) => (id === "t1" ? "Northwind Digital" : null)), ["merged into Northwind Digital", "moved 2 facts, 1 calls"]);
eq("reviewEffectWords: pipedrive merge without a name", reviewEffectWords({ decision: "merged", effect: { merged_into: "t2", moved: {} } }, () => null), ["merged into the row that already carries this Pipedrive organisation", "moved nothing counted"]);
eq("reviewEffectWords: pipedrive org attached", reviewEffectWords({ decision: "merged", effect: { pipedrive_org_id_set: true, roster_certified: true } }), ["Pipedrive organisation attached; roster certified (PRO-6)"]);
eq("reviewEffectWords: notion", reviewEffectWords({ decision: "merged", effect: { notion_client_id_set: true } }), ["Notion client id attached"]);
eq("reviewEffectWords: fathom calls", reviewEffectWords({ decision: "merged", effect: { calls_attached: 3 } }), ["calls attached: 3"]);
eq("reviewEffectWords: recorded only", reviewEffectWords({ decision: "merged", effect: { recorded_only: true } }), ["recorded only — this source attaches nothing"]);
eq("reviewEffectWords: empty effect", reviewEffectWords({ decision: "merged", effect: {} }), ["recorded"]);
eq("reviewEffectWords: no result", reviewEffectWords(null), ["recorded"]);

/* ---- provenance: the walk that turns a tier back into its sentences ----
 * The fixture is the SHAPE of a real scorecard — fit.adjustments[] with inputs, a criteria[]
 * with answers, a gates map — on invented values. If the engine ever moves a rule somewhere
 * new in the tree, this notices.
 */
const SCORECARD = {
  effective_tier: "Bronze",
  fit: {
    base_tier: "Bronze",
    criteria: [
      { key: "sells_build_work", answer: "yes", rule_text: "sells_build_work == true", inputs: { sells_build_work: true } },
      { key: "size_band_fit", answer: "no", rule_text: "headcount 8..40", inputs: { headcount: 115 } },
    ],
    adjustments: [
      { id: "ADJ-RECUR", name: "Recurring or retainer model", fired: true, inputs: { recurring_revenue_share: 0.4 } },
      { id: "ADJ-TINY", name: "Under 8 people", fired: false, inputs: { headcount: 115, owner_does_everything: null } },
    ],
    platinum_rule: { met: false, reasons: ["not met: top base band"] },
  },
  qualification: { money: { present: true, inputs: { budget_stated: true } } },
  trace: { notes: ["Archetype unknown → blended."], tier_reasoning: "ICP-3 → base Bronze." },
};

{
  const uses = evidenceUse(SCORECARD);
  const keys = uses.map((u) => u.key);
  check("evidenceUse finds inputs at every depth", ["sells_build_work", "headcount", "recurring_revenue_share", "owner_does_everything", "budget_stated"].every((k) => keys.includes(k)));
  eq("an input read by two rules is listed once", keys.filter((k) => k === "headcount").length, 1);
  const headcount = uses.find((u) => u.key === "headcount");
  eq("and carries both readers", headcount.by.length, 2);
  const recur = uses.find((u) => u.key === "recurring_revenue_share");
  eq("a rule that fired is marked as such", recur.firedCount, 1);
  eq("an answered criterion counts as fired", uses.find((u) => u.key === "sells_build_work").firedCount, 1);
  eq("a criterion answered no did not fire", uses.find((u) => u.key === "owner_does_everything").firedCount, 0);
  check("what moved the grade sorts first", uses[0].firedCount > 0);
  check("a null input is still reported as read", uses.some((u) => u.key === "owner_does_everything" && u.value === null));
}

eq("evidenceUse of nothing is nothing", evidenceUse(null), []);
eq("evidenceUse of a scorecard with no rules is nothing", evidenceUse({ effective_tier: "Bronze" }), []);
check("the walk does not descend into inputs looking for more rules", !evidenceUse({ inputs: { a: { inputs: { b: 1 } } } }).some((u) => u.key === "b"));

eq("quoteFromNote recovers the sentence", quoteFromNote('"They work with freelancers." \u2014 Pipedrive note 2702, 2025-08-13'), "They work with freelancers.");
eq("quoteFromNote handles curly quotes", quoteFromNote("\u201cNo developers on staff\u201d \u2014 Pipedrive note 1, 2025-01-01"), "No developers on staff");
eq("quoteFromNote of a plain note is null", quoteFromNote("Seen on the website"), null);
eq("quoteFromNote of nothing is null", quoteFromNote(null), null);

/* ---- stalenessNote: the book saying how far behind it is ---- */
// pb-score runs at 06:15 UTC nightly, so under a day is current and anything past it is a
// night that did not happen — the state 12 Sep was in while the page said nothing.
eq("stalenessNote is null when the book was scored this morning",
   stalenessNote("2026-09-12T06:15:00Z", "2026-09-12T13:00:00Z"), null);
eq("stalenessNote is null just under a day",
   stalenessNote("2026-09-11T06:15:00Z", "2026-09-12T06:14:00Z"), null);
eq("stalenessNote counts one missed night",
   stalenessNote("2026-09-11T06:15:00Z", "2026-09-12T13:00:00Z"), "1 night not scored");
eq("stalenessNote pluralises",
   stalenessNote("2026-09-09T06:15:00Z", "2026-09-12T13:00:00Z"), "3 nights not scored");
eq("stalenessNote of a book never scored is null", stalenessNote(null, "2026-09-12T13:00:00Z"), null);
eq("stalenessNote of an unparseable date is null", stalenessNote("not a date", "2026-09-12T13:00:00Z"), null);
eq("stalenessNote never reports a negative age (a read stamped ahead of now)",
   stalenessNote("2026-09-13T06:15:00Z", "2026-09-12T13:00:00Z"), null);

/* ---- groupFactCandidates: the bulk-reject view's arithmetic ----
 * The numbers this returns are what a reader reads before rejecting a batch, so an
 * over-count here is a person rejecting more than they meant to.
 */
{
  const cand = (id: string, key: string, value: unknown, extra: Record<string, unknown> = {}) =>
    ({ id, key, value, status: "proposed", account_id: "a1", ...extra });

  eq("groupFactCandidates of nothing is empty", groupFactCandidates([]), []);
  eq("groupFactCandidates tolerates a non-array", groupFactCandidates(null), []);
  eq("groupFactCandidates ignores rows that are not proposed",
     groupFactCandidates([cand("1", "timing", "now", { status: "rejected" }), cand("2", "timing", "now", { status: "confirmed" })]), []);
  check("groupFactCandidates drops a row with no id",
        groupFactCandidates([{ key: "timing", value: "now", status: "proposed" }]).length === 0);

  // The real shape: relationship_type as it stood on 14 Sep — 22 agency, 17 reseller, 6 direct,
  // 3 referral. The two the book cannot hold have to come out as their own groups.
  const rows = [
    ...Array.from({ length: 17 }, (_, i) => cand(`r${i}`, "relationship_type", "reseller", { account_id: `acc${i % 5}`, source: "fathom_call" })),
    ...Array.from({ length: 3 }, (_, i) => cand(`f${i}`, "relationship_type", "referral", { account_id: "acc9", source: "pipedrive_note" })),
    ...Array.from({ length: 6 }, (_, i) => cand(`t${i}`, "timing", "now", { account_id: "acc1" })),
  ];
  const grouped = groupFactCandidates(rows);
  eq("groupFactCandidates puts the biggest key first", grouped.map((g: { key: string }) => g.key), ["relationship_type", "timing"]);
  eq("groupFactCandidates totals a key across its values", grouped[0].total, 20);
  eq("groupFactCandidates counts distinct accounts, not rows", grouped[0].accountCount, 6);
  eq("groupFactCandidates splits a key by the value proposed", grouped[0].values.map((v: { count: number }) => v.count), [17, 3]);
  eq("groupFactCandidates names the values biggest first",
     grouped[0].values.map((v: { value: unknown }) => v.value), ["reseller", "referral"]);
  eq("groupFactCandidates gathers every id in the group", grouped[0].values[0].ids.length, 17);
  eq("groupFactCandidates reports the sources behind a value", grouped[0].values[0].sources, ["fathom_call"]);
  eq("groupFactCandidates counts a value's accounts", grouped[0].values[0].accountCount, 5);
  eq("groupFactCandidates carries the account ids for naming", grouped[0].values[1].accountIds, ["acc9"]);

  // A batch is only as safe as its id list: every id must appear exactly once, or a reader who
  // selects two overlapping groups rejects a row twice and the tally lies.
  const allIds = grouped.flatMap((g: { values: { ids: string[] }[] }) => g.values.flatMap((v) => v.ids));
  eq("groupFactCandidates emits each id exactly once", allIds.length, new Set(allIds).size);
  eq("groupFactCandidates emits every proposed id", allIds.length, rows.length);

  // Conflicts and missing quotes are the two things that should slow a reader down.
  const flagged = groupFactCandidates([
    cand("x1", "money", 1000, { conflicts: true, quote: "they said a thousand" }),
    cand("x2", "money", 1000, {}),
  ]);
  eq("groupFactCandidates counts the ones that disagree with the book", flagged[0].values[0].conflicts, 1);
  eq("groupFactCandidates counts the ones with a sentence behind them", flagged[0].values[0].quoted, 1);

  // Values are jsonb, so grouping has to work on shape, not on identity.
  eq("valueGroupKey folds null and undefined together", valueGroupKey(null), valueGroupKey(undefined));
  check("valueGroupKey separates the string 'true' from the boolean", valueGroupKey("true") !== valueGroupKey(true));
  check("valueGroupKey separates the string '1' from the number", valueGroupKey("1") !== valueGroupKey(1));
  eq("groupFactCandidates does not merge a boolean with its spelling",
     groupFactCandidates([cand("b1", "no_inhouse_dev_team", true), cand("b2", "no_inhouse_dev_team", "true")])[0].values.length, 2);
  eq("groupFactCandidates groups two rows holding the same value",
     groupFactCandidates([cand("b1", "no_inhouse_dev_team", true), cand("b2", "no_inhouse_dev_team", true)])[0].values.length, 1);
  eq("groupFactCandidates keeps a null value as its own group",
     groupFactCandidates([cand("n1", "timing", null)])[0].values[0].value, null);
}

/* ---- the sales-meeting review (#meetings, DECISIONS §65) ----
 * Synthetic throughout (rule 2): accounts are ids, speakers are roles, quotes are invented.
 */
{
  const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
  const REASONS = [
    { disposition: "do_not_contact", code: "asked_to_stop", label: "Asked us to stop", allows_review_date: false, sort: 10, active: true },
    { disposition: "do_not_contact", code: "other", label: "Other", allows_review_date: false, sort: 90, active: true },
    { disposition: "unqualified", code: "too_small", label: "Too small", allows_review_date: true, sort: 20, active: true },
    { disposition: "unqualified", code: "gone", label: "Gone", allows_review_date: true, sort: 10, active: true },
    { disposition: "unqualified", code: "retired_code", label: "Retired", allows_review_date: true, sort: 5, active: false },
  ];
  type Row = Record<string, unknown>;
  const prow = (id: string, extra: Row = {}): Row => ({
    id, recording_id: "rec-1", account_id: "acc-q", said_key: "quillfeather", said_as: ["Quillfeather"],
    mention_state: "resolved", matched_on: "name", options: [], kind: "fact", key: "headcount", value: 40,
    tier: null, reason_code: null, disposition: null, review_on: null, topic: null,
    quote: "they have about forty people now", context: null, line_from: 10, line_to: 10, quote_at: "00:05:00",
    speaker: "S1", mode: "asserted", flags: [], default_selected: true, held_on: "2026-10-09",
    current_value: null, current_source: null, conflicts: false, engine_tier: "Gold", effective_tier: "Gold",
    default_text: null, status: "proposed", ...extra,
  });

  for (const name of ["groupMeetingCards", "meetingRowWords", "overrideDefaults", "removalCodesFor", "cardItems", "shortcutAction"]) {
    check(`block declares ${name}`, typeof helpers[name] === "function");
  }

  /* -- the mirrors, pinned against the modules they mirror -- */
  const sortedJson = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
  eq("MEETING_KEY_SHAPES is notes_sweep EXTRACTABLE, key for key and shape for shape", sortedJson(MEETING_KEY_SHAPES), sortedJson(EXTRACTABLE));
  eq("MEETING_KEY_SHAPES holds exactly keysFor('sales_meeting')", Object.keys(MEETING_KEY_SHAPES).sort(), Object.keys(keysFor("sales_meeting")).sort());
  eq("MEETING_DEFAULT_OVERRIDE_CODE mirrors meeting_claims", MEETING_DEFAULT_OVERRIDE_CODE, DEFAULT_OVERRIDE_CODE);
  eq("MEETING_HISTORIC_DAYS mirrors meeting_claims", MEETING_HISTORIC_DAYS, HISTORIC_DAYS);
  eq("MEETING_BLOCKING_FLAGS mirrors meeting_claims", [...MEETING_BLOCKING_FLAGS].sort(), [...BLOCKING_FLAGS].sort());
  eq("MEETING_PERSON_SOURCES mirrors meeting_claims", [...MEETING_PERSON_SOURCES].sort(), [...PERSON_SOURCES].sort());
  for (const kind of ["fact", "override", "removal", "read"]) for (const topic of [null, "price"]) {
    const r = { kind, quote: "they said a thing about the agency", quote_at: "00:05:00", topic, held_on: "2026-10-09" };
    eq(`meetingDefaultText mirrors meeting_claims.defaultText (${kind}, ${topic})`, meetingDefaultText(r), defaultText(r, { held_on: "2026-10-09" }));
    check(`meetingDefaultText never carries the quote (${kind})`, !String(meetingDefaultText(r)).includes(r.quote));
  }
  eq("MEETING_KIND_ORDER is removal, tier call, facts, reads", MEETING_KIND_ORDER, ["removal", "override", "fact", "read"]);
  {
    let mismatches = 0;
    for (const [key, shape] of Object.entries(EXTRACTABLE) as [string, ClaimShape][]) {
      const vals = "values" in shape ? shape.values : [];
      const samples: unknown[] = [true, false, "x", ...vals, 0, 1, 40, 1.4, -1, 999999, [], vals.slice(0, 1), [vals[0], vals[0]], ["bogus"], vals.slice(0, 6), null, undefined, "40"];
      for (const s of samples) {
        const a = meetingValue(MEETING_KEY_SHAPES[key], s);
        const b = s === undefined ? undefined : coerceClaimValue(shape, s);
        if (!same(a, b)) { mismatches++; console.error(`      meetingValue(${key}, ${safeJson(s)}) = ${safeJson(a)}, coerceClaimValue = ${safeJson(b)}`); }
      }
    }
    eq("meetingValue agrees with notes_sweep.coerceClaimValue on every shape", mismatches, 0);
  }
  {
    // The pre-tick rule, mirrored: every combination the core's truth table can see.
    let mismatches = 0, cases = 0;
    for (const kind of ["fact", "override", "removal", "read"])
      for (const mode of ["asserted", "reported", "plan", "hypothetical", "question", "joke", "unclear"])
        for (const mention_state of ["resolved", "suggested", "ambiguous"])
          for (const matched_on of ["name", "token", "person", null])
            for (const account_id of ["acc-1", null])
              for (const flags of [[], ["historic"], ["shared_segment"], ["conflicts_with_person"], ["no_computed_tier"], ["question"], ["hypothetical"], ["joke"], ["something_else"]])
                for (const status of ["proposed", "agrees", "not_proposed"]) {
                  const row = { kind, mode, mention_state, matched_on, account_id, flags, status };
                  cases++;
                  if (meetingDefaultTick(row) !== defaultSelected(row)) mismatches++;
                }
    eq(`meetingDefaultTick agrees with meeting_claims.defaultSelected (${cases} cases)`, mismatches, 0);
  }
  eq("meetingStartsTicked: the server's default stands", meetingStartsTicked(prow("t1")), true);
  eq("meetingStartsTicked: a removal never starts ticked, whatever the row says", meetingStartsTicked(prow("t2", { kind: "removal", default_selected: true })), false);
  eq("meetingStartsTicked: a row a person placed is decided by the same rule now", meetingStartsTicked(prow("t3", { mention_state: "suggested", matched_on: "person", default_selected: false })), true);
  eq("meetingStartsTicked: placed by a person but flagged stays unticked", meetingStartsTicked(prow("t4", { mention_state: "suggested", matched_on: "person", default_selected: false, flags: ["historic"] })), false);
  eq("meetingStartsTicked: nothing that is not proposed", meetingStartsTicked(prow("t5", { status: "agrees" })), false);
  eq("meetingStartsTicked: a stored default_selected does not outlive a flag the book has raised since",
    meetingStartsTicked(prow("t6", { default_selected: true, flags: ["conflicts_with_person"] })), false);

  /* -- meetingLiveFlags: the book's flags re-derived from what the screen holds now -- */
  {
    const person = (value: unknown, source = "rater") => ({ account_id: "acc-q", key: "headcount", value, evidence_label: "evidence", source });
    eq("meetingLiveFlags: a person who recorded another value since → conflicts_with_person",
      meetingLiveFlags(prow("l1"), { facts: [person(25)] }), ["conflicts_with_person"]);
    eq("meetingLiveFlags: an approved meeting value is a person's too",
      meetingLiveFlags(prow("l2"), { facts: [person(25, "sales_meeting")] }), ["conflicts_with_person"]);
    eq("meetingLiveFlags: a machine value is no conflict", meetingLiveFlags(prow("l3"), { facts: [person(25, "website")] }), []);
    eq("meetingLiveFlags: the same value is no conflict", meetingLiveFlags(prow("l4"), { facts: [person(40)] }), []);
    eq("meetingLiveFlags: a stale conflict is cleared", meetingLiveFlags(prow("l5", { flags: ["conflicts_with_person", "historic"] }), { facts: [] }), ["historic"]);
    eq("meetingLiveFlags: no facts loaded → the stored flags stand", meetingLiveFlags(prow("l6", { flags: ["conflicts_with_person"] }), {}), ["conflicts_with_person"]);
    eq("meetingLiveFlags: a list in another order is the same value",
      meetingLiveFlags(prow("l7", { key: "climb_signals", value: ["b", "a"] }), { facts: [{ ...person(["a", "b"]), key: "climb_signals" }] }), []);
    const ov = (tier: string, extra: Row = {}) => prow("o", { kind: "override", key: null, value: null, tier, ...extra });
    eq("meetingLiveFlags: no read → no_computed_tier", meetingLiveFlags(ov("Gold"), { read: null }), ["no_computed_tier"]);
    eq("meetingLiveFlags: a tier computed since clears it", meetingLiveFlags(ov("Gold", { flags: ["no_computed_tier"] }), { read: { computed_tier: "Silver", effective_tier: "Silver" } }), []);
    eq("meetingLiveFlags: the computed tier under a live override → contradicts_live_override",
      meetingLiveFlags(ov("Silver"), { read: { computed_tier: "Silver", effective_tier: "Gold" } }), ["contradicts_live_override"]);
    eq("meetingLiveFlags: an unplaced row keeps what it was written with", meetingLiveFlags(prow("u", { account_id: null, flags: ["historic"] }), { facts: [person(25)] }), ["historic"]);
    eq("meetingLiveFlags: a decided row keeps what it was written with", meetingLiveFlags(prow("d", { status: "approved" }), { facts: [person(25)] }), []);
    check("meetingSameValue: numbers, strings, lists", meetingSameValue(40, 40) && !meetingSameValue(40, "40") && meetingSameValue(["x", "y"], ["y", "x"]) && !meetingSameValue(["x"], ["x", "y"]));
    // A row a person placed was written with no snapshot at all; now the screen raises the flag, the
    // row is not ticked, and the card sends overrule only if the person ticks it themselves.
    const placed = prow("p", { mention_state: "resolved", matched_on: "person", default_selected: false });
    const live = { ...placed, flags: meetingLiveFlags(placed, { facts: [person(25)] }) };
    eq("a placed row that would overrule a person starts unticked", meetingStartsTicked(live), false);
    eq("…and ticked on purpose, it goes with overrule", cardItems([live], { p: { ticked: true, touched: true } }, { lane: "owner" }), [{ id: "p", decision: "approve", overrule: true }]);
    eq("…but a tick no person set never sends overrule (the function refuses instead of replacing their value)",
      cardItems([live], { p: { ticked: true } }, { lane: "owner" }), [{ id: "p", decision: "approve" }]);

    /* A tier call naming the engine's own tier with no override live: the reader would have written
       it 'agrees', and pb_decide_meeting_card now records it so (nothing written). The screen never
       asks the person to tick it and never rejects it: a reject would reopen an older meeting's call. */
    eq("meetingLiveFlags: the computed tier with no override live → already_computed_tier",
      meetingLiveFlags(ov("Gold"), { read: { computed_tier: "Gold", effective_tier: "Gold" } }), ["already_computed_tier"]);
    eq("meetingLiveFlags: …an effective tier not set is the computed one",
      meetingLiveFlags(ov("gold"), { read: { computed_tier: "Gold", effective_tier: null } }), ["already_computed_tier"]);
    eq("meetingLiveFlags: an override lapsed since the read turns contradicts_live_override into already_computed_tier",
      meetingLiveFlags(ov("Silver", { flags: ["contradicts_live_override"] }), { read: { computed_tier: "Silver", effective_tier: "Silver" } }), ["already_computed_tier"]);
    eq("meetingLiveFlags: a live override that already says it → already_override_tier (the function records 'agrees')",
      meetingLiveFlags(ov("Gold"), { read: { computed_tier: "Silver", effective_tier: "Gold" } }), ["already_override_tier"]);
    eq("meetingLiveFlags: an override set since the read turns an ordinary call into already_override_tier",
      meetingLiveFlags(ov("Gold", { flags: ["shared_segment"] }), { read: { computed_tier: "Bronze", effective_tier: "Gold" } }), ["already_override_tier", "shared_segment"]);
    {
      // pb_decide_meeting_card's override branch, transcribed: no computed tier → refused; the tier the
      // board shows → agrees, whether the engine or a live override put it there (already_computed_tier
      // marks the first, already_override_tier the second, and the screen sends both with
      // only_if_agrees); any other tier while a live override shows one — the engine's own or a third —
      // → a newer override, which ends the live one (the engine applies the newest). The flags say the
      // same, and a screen flag is raised EXACTLY when the function would record 'agrees'.
      let mismatches = 0, cases = 0;
      for (const t of ["Gold", "Silver", "Bronze"]) for (const comp of ["Gold", "Silver", null]) for (const eff of ["Gold", "Silver", "Bronze", null]) {
        cases++;
        const shown = eff ?? comp;
        const agrees = comp !== null && t.toLowerCase() === String(shown).toLowerCase();
        const agreesSame = agrees && t.toLowerCase() === comp.toLowerCase();
        const agreesOverride = agrees && t.toLowerCase() !== comp.toLowerCase();
        const byOverride = comp !== null && String(shown).toLowerCase() !== comp.toLowerCase();
        const endsLive = byOverride && t.toLowerCase() !== String(shown).toLowerCase();
        const f = meetingLiveFlags(ov(t), { read: comp === null && eff === null ? null : { computed_tier: comp, effective_tier: eff } });
        const row = { ...ov(t), flags: f };
        if (f.includes("no_computed_tier") !== (comp === null) || f.includes("already_computed_tier") !== agreesSame
            || f.includes("already_override_tier") !== agreesOverride || f.includes("contradicts_live_override") !== endsLive
            || meetingBoardShows(row) !== agrees) {
          mismatches++;
          console.error(`      tier ${t}, computed ${comp}, effective ${eff}: ${safeJson(f)}`);
        }
      }
      eq(`meetingLiveFlags agrees with pb_decide_meeting_card's override branch (${cases} cases)`, mismatches, 0);
    }
    const sameTier = { ...prow("s1", { kind: "override", key: null, value: null, tier: "Gold" }), flags: meetingLiveFlags(ov("Gold"), { read: { computed_tier: "Gold", effective_tier: "Gold" } }) };
    eq("meetingStartsTicked: a tier call the board already shows never starts ticked", meetingStartsTicked(sameTier), false);
    eq("…though the reader's own rule would tick it (the flag is the screen's, not the reader's)", meetingDefaultTick(sameTier), true);
    eq("cardProblems: nothing is asked of it, ticked or not (it writes nothing)",
      [cardProblems([sameTier], { s1: { ticked: true, edit: { text: "", reason_code: null } } }, "owner"), cardProblems([sameTier], { s1: { ticked: false } }, "owner")], [[], []]);
    eq("cardItems (A, owner): never a reject — an approval that must still agree, with no edit",
      cardItems([sameTier], { s1: { ticked: false } }, { mode: "approve", lane: "owner" }), [{ id: "s1", decision: "approve", only_if_agrees: true }]);
    eq("cardItems (A, owner): …ticked from an earlier load, the same",
      cardItems([sameTier], { s1: { ticked: true, edit: { reason_code: "other", text: "x", expires_on: "2027-01-08" } } }, { mode: "approve", lane: "owner" }),
      [{ id: "s1", decision: "approve", only_if_agrees: true }]);
    eq("cardItems (A, rater): left for the owner, like any tier call", cardItems([sameTier], { s1: { ticked: false } }, { mode: "approve", lane: "rater" }), []);
    eq("cardItems (X): the person rejects the card, so it rejects", cardItems([sameTier], { s1: { ticked: false } }, { mode: "reject", lane: "owner" }), [{ id: "s1", decision: "reject" }]);
    {
      // The defect this closes: meeting 1 said Silver, meeting 2 said Gold (superseding it), and the
      // engine has since computed Gold. Deciding meeting 2's card must not send its Gold call as a reject.
      const newer = { ...prow("n2", { kind: "override", key: null, value: null, tier: "Gold", recording_id: "rec-2" }), flags: meetingLiveFlags(ov("Gold"), { read: { computed_tier: "Gold", effective_tier: "Gold" } }) };
      const fact = prow("n2f", { recording_id: "rec-2" });
      const sent = cardItems([newer, fact], { n2: { ticked: false }, n2f: { ticked: false } }, { mode: "approve", lane: "owner" });
      check("a newer meeting's call that agrees with the board is never rejected by A (an older call would reopen)",
        !sent.some((i: { id: string; decision: string }) => i.id === "n2" && i.decision === "reject") && sent.some((i: { id: string; decision: string }) => i.id === "n2f" && i.decision === "reject"), safeJson(sent));
    }
    includes("meetingRowWords: the tier call says the board already shows it", meetingRowWords(sameTier, { tiers: TIERS }), "the board already shows it");
    includes("meetingRowWords: …and that approving writes nothing", meetingRowWords(sameTier, { tiers: TIERS }), "writes nothing");
    check("meetingRowWords: …and prints no expiry for it (nothing is written, so nothing expires)",
      !meetingRowWords(sameTier, { tiers: TIERS, expiresOn: "2027-02-08", engineTier: "Gold" }).includes("until"));
    check("meetingFlagWords names already_computed_tier in words", !meetingFlagWords("already_computed_tier").includes("_"));
    {
      /* The same, when a LIVE OVERRIDE puts the call's tier on the board and the engine computes
         another. Meeting 1 said Silver; meeting 2 said "X and Y are Gold" (shared_segment) and
         superseded it; the owner has since overridden X to Gold. pb_decide_meeting_card records
         meeting 2's Gold as 'agrees' — so the screen must not send it as a reject, which would hand
         meeting 1's Silver back to its card, pre-ticked, where A writes an override ending the Gold one. */
      const read = { computed_tier: "Bronze", effective_tier: "Gold" };
      const p2 = { ...prow("p2", { kind: "override", key: null, value: null, tier: "Gold", flags: ["shared_segment"], recording_id: "rec-2" }), flags: meetingLiveFlags(ov("Gold", { flags: ["shared_segment"] }), { read }) };
      eq("meetingBoardShows: a live override's tier is one the board shows", meetingBoardShows(p2), true);
      eq("meetingStartsTicked: it never starts ticked", meetingStartsTicked(p2), false);
      eq("cardItems (A, owner): unticked, it is approved with only_if_agrees — never a reject",
        cardItems([p2], { p2: { ticked: false } }, { mode: "approve", lane: "owner" }), [{ id: "p2", decision: "approve", only_if_agrees: true }]);
      eq("cardItems (A, owner): …and a stale tick with an expiry sends no edit (the function would ignore it and write nothing)",
        cardItems([p2], { p2: { ticked: true, edit: { reason_code: "other", text: "x", expires_on: "2027-02-08" } } }, { mode: "approve", lane: "owner" }),
        [{ id: "p2", decision: "approve", only_if_agrees: true }]);
      eq("cardProblems: no reason or code is asked of it", cardProblems([p2], { p2: { ticked: true, edit: { text: "", reason_code: null } } }, "owner"), []);
      eq("cardItems (X): the person rejects the card, so it rejects", cardItems([p2], { p2: { ticked: false } }, { mode: "reject", lane: "owner" }), [{ id: "p2", decision: "reject" }]);
      const w = meetingRowWords(p2, { tiers: TIERS, engineTier: "Bronze", effectiveTier: "Gold", liveOverrideUntil: "2026-12-01", expiresOn: "2027-02-08" });
      includes("meetingRowWords: it says a live override shows it", w, "the board already shows it by a live override until 1 Dec 2026");
      includes("meetingRowWords: …that approving writes nothing", w, "writes nothing");
      includes("meetingRowWords: …and does not renew the override", w, "does not renew the override");
      check("meetingRowWords: …with no new expiry and no distance warning (no override is written)", !w.includes("8 Feb 2027") && !w.includes("moves") && !w.includes("will flag"), w);
      check("meetingFlagWords names already_override_tier in words", !meetingFlagWords("already_override_tier").includes("_"));
      // The engine's own tier under that override is still a real override that ends it.
      eq("meetingLiveFlags: the engine's tier under that override is still contradicts_live_override",
        meetingLiveFlags(ov("Bronze"), { read }), ["contradicts_live_override"]);
    }
    {
      /* A THIRD tier under a live override — neither the engine's nor the override's. Meeting M, held
         ten days ago, says X is Silver; the engine computes Gold; the owner has since overridden X to
         Bronze. Approving writes a newer Silver override, and the engine applies the newest: one A
         would replace the owner's override on an older word. So the row is flagged, never pre-ticked,
         and its words say what approving does. */
      const third = ov("Silver");
      const read = { computed_tier: "Gold", effective_tier: "Bronze" };
      const live = meetingLiveRow(third, { read });
      eq("meetingLiveFlags: a third tier under a live override → contradicts_live_override", live.flags, ["contradicts_live_override"]);
      eq("meetingStartsTicked: …never pre-ticked", meetingStartsTicked(live), false);
      eq("meetingTick: …and a fresh screen draws it unticked", meetingTick(live, { touched: false, edit: {} }).ticked, false);
      const w = meetingRowWords(live, { tiers: TIERS, engineTier: "Gold", effectiveTier: "Bronze", liveOverrideUntil: "2026-12-01" });
      includes("meetingRowWords: …and says the live override ends", w, "the board shows anticipated Bronze by a live override until 1 Dec 2026; approving ends it");
      eq("cardItems (A, owner): unticked, it is rejected — never an override nobody chose",
        cardItems([live], { o: { ticked: false } }, { mode: "approve", lane: "owner" }), [{ id: "o", decision: "reject" }]);
      // Ticked while no override was live; then a sheet override to Bronze lands before the next draw.
      const before = meetingLiveRow(third, { read: { computed_tier: "Gold", effective_tier: "Gold" } });
      const untouched = { touched: false, edit: {}, ...meetingTick(before, { touched: false, edit: {} }) };
      eq("redraw: with no override live it is an ordinary call, ticked", [before.flags, untouched.ticked], [[], true]);
      const mine = { ...untouched, ticked: true, mine: true, touched: true, basis: meetingTickBasis(before, untouched) };
      check("meetingTickBasis: an override landing under a tier call moves its basis", meetingTickBasis(before, untouched) !== meetingTickBasis(live, untouched));
      eq("redraw: the override lands — the kept tick is dropped, touched or not", [meetingTick(live, untouched).ticked, meetingTick(live, mine).ticked], [false, false]);
      // Ticked on purpose with those words on the row, it holds while the board holds…
      const meant = { ...mine, ticked: true, mine: true, basis: meetingTickBasis(live, mine) };
      eq("redraw: a tick the person made with the override's words on the row holds while the board holds",
        meetingTick(meetingLiveRow(third, { read: { ...read } }), meant).ticked, true);
      // …and not once the board moves under it (another override, another lapse date's tier).
      eq("redraw: …but not once another override shows another tier: that is a new question",
        meetingTick(meetingLiveRow(third, { read: { computed_tier: "Gold", effective_tier: "Platinum" } }), meant).ticked, false);
      // The reader's own rule (ingest/meeting_claims.ts) is the same: the row is written flagged.
      eq("meetingDefaultTick: the flag is a blocking one, as the reader writes it", meetingDefaultTick(live), false);
    }
    {
      /* A tab left open across the 06:15 score: loadBook read X at computed Gold, so meeting 2's Gold
         call showed as already_computed_tier, with no tick box and no controls, and A always sent it
         with only_if_agrees. The score then computed Silver. pb_decide_meeting_card refused the card
         ("reload it"), and every re-open rebuilt the same flag from the same page-load reads. The
         screen now reads the open rows' reads again each time it opens (mergeReads). */
      const day1 = new Map<string, unknown>([["acc-q", { account_id: "acc-q", computed_tier: "Gold", effective_tier: "Gold" }], ["acc-z", { account_id: "acc-z", computed_tier: "Bronze", effective_tier: "Bronze" }]]);
      const day2 = mergeReads(day1, ["acc-q"], [{ account_id: "acc-q", computed_tier: "Silver", effective_tier: "Silver" }]);
      eq("mergeReads: an open row's agency takes the read just read", day2.get("acc-q"), { account_id: "acc-q", computed_tier: "Silver", effective_tier: "Silver" });
      eq("mergeReads: every other agency keeps the read it had", day2.get("acc-z"), { account_id: "acc-z", computed_tier: "Bronze", effective_tier: "Bronze" });
      eq("mergeReads: …in a new Map, the old one untouched", [day2 !== day1, (day1.get("acc-q") as { computed_tier: string }).computed_tier], [true, "Gold"]);
      eq("mergeReads: an agency asked for that came back with no read has none now",
        mergeReads(day1, ["acc-q"], []).has("acc-q"), false);
      eq("mergeReads: nothing read, nothing asked: the reads as they were", [...mergeReads(day1, [], null).keys()], ["acc-q", "acc-z"]);
      eq("meetingReadOf: the account's read", meetingReadOf(day2, "acc-q", true), day2.get("acc-q"));
      eq("meetingReadOf: no read, and the book's reads are loaded → none (no_computed_tier)", meetingReadOf(day2, "acc-n", false), null);
      eq("meetingReadOf: no read, read again just now → none, even with no book loaded", meetingReadOf(new Map(), "acc-n", true), null);
      eq("meetingReadOf: nothing loaded and nothing read again → cannot say (the stored flags stand)", meetingReadOf(new Map(), "acc-n", false), undefined);
      const call = ov("Gold");
      const then = { ...call, flags: meetingLiveFlags(call, { read: meetingReadOf(day1, "acc-q", true) }) };
      eq("day 1: the Gold call is one the board shows", then.flags, ["already_computed_tier"]);
      // The choice as choiceFor builds it on day 1: the row has no tick box, so nobody touches it, and
      // the screen holds it unticked — a value no person could see or set.
      const edit = { reason_code: "other", text: "x", expires_on: "2027-02-08" };
      const held = { touched: false, edit, ...meetingTick(then, { touched: false, edit }) };
      eq("day 1: the screen holds it unticked (no box; A sends it with only_if_agrees)", held.ticked, false);
      const now = { ...call, flags: meetingLiveFlags(call, { read: meetingReadOf(day2, "acc-q", true) }) };
      eq("day 2, re-opened: it is an ordinary tier call again, with a tick box and the override's controls", [now.flags, meetingBoardShows(now)], [[], false]);
      const redrawn = { ...held, ...meetingTick(now, held) };
      eq("day 2, redrawn: it starts as a fresh screen would start it (ticked), not with day 1's hidden false",
        [redrawn.ticked, meetingStartsTicked(now)], [true, true]);
      const sent = cardItems([now], { o: redrawn }, { mode: "approve", lane: "owner" });
      eq("…which A sends as the person decides it, not with only_if_agrees",
        sent, [{ id: "o", decision: "approve", edit: { reason_code: "other", expires_at: "2027-02-08T00:00:00Z", text: "x" } }]);
      check("…and never as a reject the person did not choose (a rejected newer call reopens an older meeting's)",
        !sent.some((i: { decision: string }) => i.decision === "reject"), sent);
      // A box the person unticked on purpose stays unticked through the same move.
      const unticked = { ...redrawn, ticked: false, mine: false, touched: true, basis: meetingTickBasis(now, redrawn) };
      eq("…a tier call the person unticked stays unticked", meetingTick(now, unticked).ticked, false);
    }
    {
      /* A box the PERSON ticked, which the screen then unticked or hid, comes back ticked when the
         question returns to one they answered yes. Day 1: the engine computes Silver, the owner ticks
         the meeting's Gold call themselves. Day 2: the engine computes Gold — the board shows it, the
         box is replaced by a chip and the screen holds the row unticked. Day 3: the engine is back at
         Silver. A fresh screen would tick it; the person never unticked it; so it is ticked, and A sends
         the person's approval — not a reject, which would return an older meeting's call to its card. */
      const call = ov("Gold");
      const edit = { reason_code: "other", text: "x", expires_on: "2027-02-08" };
      const d1 = meetingLiveRow(call, { read: { computed_tier: "Silver", effective_tier: "Silver" } });
      const c0 = { touched: false, mine: false, edit, ...meetingTick(d1, { touched: false, edit }) };
      // The change handler, twice (off, on): ticked, touched, and the person's own answer is yes.
      const c1 = { ...c0, ticked: true, mine: true, touched: true, basis: meetingTickBasis(d1, c0) };
      const d2 = meetingLiveRow(call, { read: { computed_tier: "Gold", effective_tier: "Gold" } });
      const c2 = { ...c1, ...meetingTick(d2, c1) };
      eq("day 2: the board shows the call — no box, held unticked, and A sends it with only_if_agrees",
        [d2.flags, c2.ticked, c2.mine, cardItems([d2], { o: c2 }, { mode: "approve", lane: "owner" })],
        [["already_computed_tier"], false, true, [{ id: "o", decision: "approve", only_if_agrees: true }]]);
      const d3 = meetingLiveRow(call, { read: { computed_tier: "Silver", effective_tier: "Silver" } });
      const c3 = { ...c2, ...meetingTick(d3, c2) };
      eq("day 3: back to an ordinary call — the person's tick is back, as a reload would draw it", [c3.ticked, meetingStartsTicked(d3)], [true, true]);
      eq("…and A sends the person's approval, never a reject they did not choose",
        cardItems([d3], { o: c3 }, { mode: "approve", lane: "owner" }),
        [{ id: "o", decision: "approve", edit: { reason_code: "other", expires_at: "2027-02-08T00:00:00Z", text: "x" } }]);
      // A box the person unticked stays unticked through the same three days.
      const u1 = { ...c0, ticked: false, mine: false, touched: true, basis: meetingTickBasis(d1, c0) };
      const u2 = { ...u1, ...meetingTick(d2, u1) };
      eq("…an untick the person made stands through the same three days", meetingTick(d3, u2).ticked, false);
      // The same through a live override that comes and goes (already_override_tier).
      const v2 = meetingLiveRow(call, { read: { computed_tier: "Silver", effective_tier: "Gold" } });
      const k2 = { ...c1, ...meetingTick(v2, c1) };
      eq("…and through a live override that showed the call and lapsed", [v2.flags, k2.ticked, meetingTick(d1, k2).ticked], [["already_override_tier"], false, true]);
    }
    {
      /* A tick carried across a redraw that changed what it means. The owner opens the meeting while
         no person holds headcount, so the meeting's 40 starts ticked. A rater records 25 on the sheet;
         the owner's A is refused ("tick overrule to replace it on purpose") and the card is redrawn
         from the book with its choices kept. The redrawn box asks a new question — overrule the rater? —
         and a tick nobody made under it must not answer it. */
      const row = prow("k1");
      const fresh = { touched: false, edit: { value: 40, changed: false } };
      const d1 = meetingLiveRow(row, { facts: [] });
      const c1 = { ...fresh, ...meetingTick(d1, fresh) };
      eq("redraw: no person holds the key — the row starts ticked", c1.ticked, true);
      eq("redraw: …and the first A sends no overrule", cardItems([d1], { k1: c1 }, { mode: "approve", lane: "owner" }), [{ id: "k1", decision: "approve" }]);
      const d2 = meetingLiveRow(row, { facts: [person(25)] });
      const c2 = { ...c1, ...meetingTick(d2, c1) };
      eq("redraw: a rater's value since → the kept tick is dropped, as a fresh screen would start it", [c2.ticked, meetingStartsTicked(d2)], [false, false]);
      const after = cardItems([d2], { k1: c2 }, { mode: "approve", lane: "owner" });
      check("redraw: …so the next A sends no overrule:true", !after.some((i: { overrule?: boolean }) => i.overrule === true), after);
      eq("redraw: …it rejects the meeting's value and the rater's stands", after, [{ id: "k1", decision: "reject" }]);
      // The same when the PERSON ticked the box before the conflict was there.
      const t1 = { ...c1, ticked: true, mine: true, touched: true, basis: meetingTickBasis(d1, c1) };
      eq("redraw: a box the person ticked before the conflict is unticked too", meetingTick(d2, t1).ticked, false);
      // Ticked on purpose under the conflict (the change handler records the basis), it holds across a redraw that moved nothing.
      const p2 = { ...c2, ticked: true, mine: true, touched: true, basis: meetingTickBasis(d2, c2) };
      const p3 = { ...p2, ...meetingTick(meetingLiveRow(row, { facts: [person(25)] }), p2) };
      eq("redraw: a tick the person made against the rater's value survives a redraw that changed nothing", p3.ticked, true);
      eq("redraw: …and goes with overrule", cardItems([d2], { k1: p3 }, { mode: "approve", lane: "owner" }), [{ id: "k1", decision: "approve", overrule: true }]);
      eq("redraw: …but not one made against a value the person has since changed", meetingTick(meetingLiveRow(row, { facts: [person(30)] }), p3).ticked, false);
      // A rater records 30 (the screen unticks the overrule), then the meeting's own 40: no conflict is
      // left, a fresh screen would tick it, and the person ticked it — so it is ticked, never rejected.
      const p4 = { ...p3, ...meetingTick(meetingLiveRow(row, { facts: [person(30)] }), p3) };
      const d40 = meetingLiveRow(row, { facts: [person(40)] });
      const p5 = { ...p4, ...meetingTick(d40, p4) };
      eq("redraw: a fact the person ticked, unticked by the screen under another value, is ticked again once the value agrees",
        [p4.ticked, p5.ticked, meetingStartsTicked(d40)], [false, true, true]);
      eq("redraw: …and A approves it (the function records it 'agrees'), not a reject", cardItems([d40], { k1: p5 }, { mode: "approve", lane: "owner" }), [{ id: "k1", decision: "approve" }]);
      // An untick the person made always stands; a redraw that moved nothing keeps every tick as it was.
      const u1 = { ...c1, ticked: false, mine: false, touched: true, basis: meetingTickBasis(d1, c1) };
      eq("redraw: an untick the person made stands whatever moves", meetingTick(meetingLiveRow(row, { facts: [person(40)] }), u1).ticked, false);
      eq("redraw: a redraw that moved nothing keeps the tick and its basis", meetingTick(meetingLiveRow(row, { facts: [] }), c1), { ticked: true, basis: c1.basis });
      eq("redraw: an untouched row whose conflict has gone takes the fresh tick", meetingTick(meetingLiveRow(row, { facts: [person(40)] }), c2).ticked, true);
      eq("redraw: a row that cannot be put into words never keeps a tick", meetingTick(null, { ticked: true, touched: true, basis: null }).ticked, false);
      // An edit is the person's own value: the basis follows the value the card would SEND.
      eq("meetingSentValue: an edited fact sends its edit", meetingSentValue(d2, { edit: { value: 25, changed: true } }), 25);
      eq("meetingSentValue: an unedited one, its own (undefined)", meetingSentValue(d2, c1), undefined);
      eq("meetingSentValue: only a fact has one", meetingSentValue(ov("Gold"), { edit: { value: "x", changed: true } }), undefined);
      check("meetingTickBasis: an edit that ends the conflict moves the basis", meetingTickBasis(d2, c1) !== meetingTickBasis(d2, { edit: { value: 25, changed: true } }));
      // A tier call ticked while it was an ordinary call, then a live override shows another tier and the
      // engine computes the call's: approving now ENDS that override (contradicts_live_override).
      const callRow = ov("Silver");
      const o1 = { ...callRow, flags: meetingLiveFlags(callRow, { read: { computed_tier: "Gold", effective_tier: "Gold" } }) };
      const oc = { touched: false, edit: {}, ...meetingTick(o1, { touched: false, edit: {} }) };
      eq("redraw: an ordinary tier call starts ticked", [o1.flags, oc.ticked], [[], true]);
      const o2 = { ...callRow, flags: meetingLiveFlags(callRow, { read: { computed_tier: "Silver", effective_tier: "Gold" } }) };
      eq("redraw: …the book moves under it to contradicts_live_override, and the kept tick is dropped",
        [o2.flags, meetingTick(o2, oc).ticked, meetingTick(o2, { ...oc, touched: true, mine: true }).ticked], [["contradicts_live_override"], false, false]);
    }
    {
      /* A refusal's words on a card that is decided by the time the screen redraws it: the rater decided
         card X while the owner held it open, the owner's A was refused ("only an open proposal is
         decided"), and the redraw draws X decided — a one-line card with no footer. */
      const g = groupMeetingCards([prow("c1", { status: "approved" }), prow("c2", { account_id: "acc-z", said_key: "z" })]);
      eq("a card somebody else decided is drawn decided (no open rows)", g.cards.map((c: { key: string; open: unknown[] }) => [c.key, c.open.length]), [["a:acc-q", 0], ["a:acc-z", 1]]);
      const saved = new Map<string, unknown>([["a:acc-q", { kind: "bad", text: "Refused — x" }], ["a:gone", { kind: "ok", text: "y" }], ["a:acc-z", { kind: "ok", text: "z" }]]);
      const placed = placeCardNotices(saved, g.cards);
      eq("placeCardNotices: the refusal stays on its card, decided or not", placed.onCard.get("a:acc-q"), { kind: "bad", text: "Refused — x" });
      eq("placeCardNotices: an open card keeps its own", placed.onCard.get("a:acc-z"), { kind: "ok", text: "z" });
      eq("placeCardNotices: words for a card this draw does not show go to the top", placed.top, [{ kind: "ok", text: "y" }]);
      eq("placeCardNotices: every entry is placed exactly once", placed.onCard.size + placed.top.length, saved.size);
      eq("placeCardNotices: the saved Map is not touched (the screen clears it once placed)", saved.size, 3);
      const none = placeCardNotices(null, null);
      eq("placeCardNotices of nothing", [none.onCard.size, none.top], [0, []]);
    }
    eq("the screen's own flags are never the reader's", MEETING_SCREEN_FLAGS.filter((f: string) => BLOCKING_FLAGS.includes(f as never)), []);

    /* The value a card SENDS is the one pb_decide_meeting_card compares, so an edit can make a conflict or end one. */
    eq("meetingPersonHeld: a person's value", meetingPersonHeld(prow("h1"), [person(25)]), { value: 25, source: "rater" });
    eq("meetingPersonHeld: a machine value is nobody's", meetingPersonHeld(prow("h2"), [person(25, "website")]), null);
    eq("meetingPersonHeld: a person's inference is not their evidence", meetingPersonHeld(prow("h3"), [{ ...person(25), evidence_label: "inferred" }]), null);
    eq("meetingPersonHeld: nothing held", meetingPersonHeld(prow("h4"), []), null);
    eq("meetingPersonHeld: facts not loaded → cannot say", meetingPersonHeld(prow("h5"), undefined), undefined);
    const lr = meetingLiveRow(placed, { facts: [person(25)] });
    eq("meetingLiveRow: a placed row shows the book's value now, not the snapshot it was written without",
      [lr.current_value, lr.current_source, lr.person_held, lr.flags], [25, "rater", { value: 25, source: "rater" }, ["conflicts_with_person"]]);
    const lm = meetingLiveRow(prow("lm"), { facts: [person(25, "website")] });
    eq("meetingLiveRow: a machine value is shown and held by nobody", [lm.current_value, lm.current_source, lm.person_held], [25, "website", null]);
    eq("meetingLiveRow: facts not loaded → the row as written", "person_held" in meetingLiveRow(prow("ln", { current_value: 9 }), {}) ? "changed" : meetingLiveRow(prow("ln", { current_value: 9 }), {}).current_value, 9);
    eq("meetingLiveRow: a decided row is left alone", meetingLiveRow(prow("ld", { status: "approved" }), { facts: [person(25)] }).current_value, null);
    eq("meetingLiveRow: what words it prints for a placed row", meetingRowWords(lr), "headcount 40 · book: 25 from rater — a person recorded that; approving overrules them");
    const agreeing = meetingLiveRow(prow("ag", { value: 25, matched_on: "person" }), { facts: [person(25)] });
    eq("meetingOverrules: the meeting's own value, which the person holds too", meetingOverrules(agreeing, undefined), false);
    eq("meetingOverrules: …edited on the card to something else, it now overrules them", meetingOverrules(agreeing, 40), true);
    eq("meetingOverrules: a conflicting row edited to the person's value no longer does", meetingOverrules(lr, 25), false);
    eq("meetingOverrules: no person holds the key", meetingOverrules(lm, 99), false);
    eq("meetingOverrules: facts not loaded → the row's flag", [meetingOverrules(prow("u1", { flags: ["conflicts_with_person"] }), 7), meetingOverrules(prow("u2"), 7)], [true, false]);
    eq("meetingOverrules: only a fact overrules", meetingOverrules(ov("Gold"), "Gold"), false);
    eq("cardItems: an edit that now differs from a person's value goes with overrule",
      cardItems([agreeing], { ag: { ticked: true, touched: true, edit: { value: 40, changed: true } } }, { lane: "owner" }),
      [{ id: "ag", decision: "approve", overrule: true, edit: { value: 40 } }]);
    eq("cardItems: an edit to the person's own value needs none (the function records 'agrees')",
      cardItems([lr], { p: { ticked: true, edit: { value: 25, changed: true } } }, { lane: "owner" }),
      [{ id: "p", decision: "approve", edit: { value: 25 } }]);
    includes("meetingRowWords: the words follow the edited value's conflict", meetingRowWords(agreeing, { value: 40, overrules: true }), "approving overrules them");
    check("meetingRowWords: …and drop it when the edit ends one", !meetingRowWords(lr, { value: 25, overrules: false }).includes("overrules"));
  }

  /* -- readTierWords: rule 10 on one line -- */
  eq("readTierWords: tier, confidence and UNVALIDATED", readTierWords({ scorecard: { effective_tier: "Gold", confidence_grade: "B", validation: "UNVALIDATED" } }), "anticipated Gold · confidence B · UNVALIDATED (PRO-8)");
  eq("readTierWords: a validated read prints no label", readTierWords({ scorecard: { effective_tier: "Gold", confidence_grade: "B", validation: "VALIDATED" } }), "anticipated Gold · confidence B");
  eq("readTierWords: no tier", readTierWords({ scorecard: { status: "Unclassified", validation: "UNVALIDATED" } }), "no anticipated tier · Unclassified · UNVALIDATED (PRO-8)");
  eq("readTierWords: no read", readTierWords(null), "not yet scored");

  /* -- groupMeetingCards: discussion order, fixed row order, unplaced by said_key -- */
  {
    const rows = [
      prow("b-fact", { account_id: "acc-b", said_key: "northgale creative", said_as: ["Northgale Creative"], line_from: 50, line_to: 51, quote_at: "00:20:00" }),
      prow("b-agree", { account_id: "acc-b", said_key: "northgale creative", kind: "override", tier: "Gold", status: "agrees", line_from: 55, line_to: 55 }),
      prow("b-said", { account_id: "acc-b", said_key: "northgale creative", kind: "read", topic: "price", mode: "question", status: "not_proposed", line_from: 56, line_to: 56 }),
      prow("b-done", { account_id: "acc-b", said_key: "northgale creative", key: "money", status: "approved", line_from: 60, line_to: 60 }),
      prow("a-read", { account_id: "acc-a", said_key: "bluebarrow", said_as: ["Bluebarrow"], kind: "read", topic: "price", line_from: 20, line_to: 21, quote_at: "00:08:00" }),
      prow("a-removal", { account_id: "acc-a", said_key: "bluebarrow", said_as: ["the Bluebarrow folks"], kind: "removal", line_from: 80, line_to: 80, quote_at: "00:31:07" }),
      prow("a-fact", { account_id: "acc-a", said_key: "bluebarrow", kind: "fact", line_from: 40, line_to: 40, matched_on: "person" }),
      prow("u-quill-1", { account_id: null, said_key: "the quill", said_as: ["the Quill"], mention_state: "suggested", matched_on: "prefix", options: ["acc-q", "acc-z"], line_from: 35, line_to: 35 }),
      prow("u-quill-2", { account_id: null, said_key: "the quill", said_as: ["Quill"], mention_state: "suggested", matched_on: "prefix", options: ["acc-q"], line_from: 30, line_to: 31, quote_at: "00:12:00" }),
      prow("u-north", { account_id: null, said_key: "northgale", said_as: ["Northgale"], mention_state: "ambiguous", matched_on: "token", options: ["acc-b", "acc-c"], line_from: 5, line_to: 5 }),
    ];
    const g = groupMeetingCards(rows);
    eq("groupMeetingCards: cards in discussion order (first line_from)", g.cards.map((c: { account_id: string }) => c.account_id), ["acc-a", "acc-b"]);
    eq("groupMeetingCards: a card's rows in the fixed order — removal, tier call, facts, reads", g.cards[0].rows.map((r: { id: string }) => r.id), ["a-removal", "a-fact", "a-read"]);
    eq("groupMeetingCards: unplaced rows group by said_key, in discussion order", g.unplaced.map((u: { said_keys: string[] }) => u.said_keys), [["northgale"], ["the quill"]]);
    eq("groupMeetingCards: every claim under one name is one chip", g.unplaced[1].rows.length, 2);
    eq("groupMeetingCards: a chip's options are the union, at most five", g.unplaced[1].options, ["acc-q", "acc-z"]);
    eq("groupMeetingCards: a chip carries every surface said", g.unplaced[1].said_as, ["the Quill", "Quill"]);
    eq("groupMeetingCards: the first line and its timestamp", [g.unplaced[1].first_line, g.unplaced[1].first_at], [30, "00:12:00"]);
    eq("groupMeetingCards: the span runs to the last line cited", [g.cards[0].first_at, g.cards[0].last_at], ["00:08:00", "00:31:07"]);
    eq("groupMeetingCards: an ambiguous row makes the chip ambiguous", g.unplaced[0].mention_state, "ambiguous");
    eq("groupMeetingCards: a person's placement wins the basis chip", g.cards[0].matched_on, "person");
    const b = g.cards[1];
    eq("groupMeetingCards: open / agrees / said-not-decided / decided split by status",
       [b.open.map((r: { id: string }) => r.id), b.agrees.map((r: { id: string }) => r.id), b.unsaid.map((r: { id: string }) => r.id), b.decided.map((r: { id: string }) => r.id)],
       [["b-fact"], ["b-agree"], ["b-said"], ["b-done"]]);
    eq("groupMeetingCards: placed rows are never also in the strip", g.unplaced.flatMap((u: { rows: { id: string }[] }) => u.rows.map((r) => r.id)).filter((id: string) => !id.startsWith("u-")), []);
    eq("groupMeetingCards of nothing", groupMeetingCards(null), { cards: [], unplaced: [] });
    const original = rows.map((r) => r.id);
    groupMeetingCards(rows);
    eq("groupMeetingCards does not reorder its input", rows.map((r) => r.id), original);
  }

  /* -- meetingRowWords: the change in plain words; every tier is anticipated (rule 10) -- */
  {
    const tierCall = prow("o", { kind: "override", tier: "Silver", engine_tier: "Gold", key: null, value: null });
    eq("meetingRowWords: tier call with the engine's tier and the expiry",
       meetingRowWords(tierCall, { tiers: TIERS, expiresOn: "2027-01-08" }), "Tier → anticipated Silver (engine: anticipated Gold) until 8 Jan 2027");
    includes("meetingRowWords: a move of two tiers says so", meetingRowWords(prow("o2", { kind: "override", tier: "Platinum", engine_tier: "Silver" }), { tiers: TIERS }), "moves 2 tiers; the board will flag it");
    check("meetingRowWords: a move of one tier says nothing more", !meetingRowWords(tierCall, { tiers: TIERS }).includes("moves"));
    includes("meetingRowWords: the live engine tier beats the row's snapshot", meetingRowWords(tierCall, { tiers: TIERS, engineTier: "Bronze" }), "engine: anticipated Bronze");
    includes("meetingRowWords: no engine tier", meetingRowWords(prow("o3", { kind: "override", tier: "Gold", engine_tier: null }), { tiers: TIERS }), "engine: no anticipated tier yet");
    eq("meetingRowWords: a tier the board already has", meetingRowWords(prow("o4", { kind: "override", tier: "Gold", status: "agrees" }), {}), "Tier anticipated Gold — team agrees with the board");
    eq("meetingRowWords: the engine's tier against a live override names the override, its lapse, and what approving does",
      meetingRowWords(prow("o5", { kind: "override", tier: "Silver", engine_tier: "Silver", effective_tier: "Gold", flags: ["contradicts_live_override"] }),
        { tiers: TIERS, liveOverrideUntil: "2027-01-08" }),
      "Tier → anticipated Silver (engine: anticipated Silver) · the board shows anticipated Gold by a live override until 8 Jan 2027; approving ends it");
    includes("meetingRowWords: a do-not-contact over a live unqualified removal says so",
      meetingRowWords(prow("r9", { kind: "removal", disposition: "do_not_contact", flags: ["upgrades_removal"] }), { disposition: "do_not_contact" }),
      "already off the board as unqualified; this records the stronger call");
    for (const f of ["contradicts_live_override", "upgrades_removal"]) check(`meetingFlagWords names ${f} in words`, !meetingFlagWords(f).includes("_"));
    includes("cardProblems: a ticked tier call with no computed tier is refused on screen first",
      cardProblems([prow("o6", { kind: "override", tier: "Gold", flags: ["no_computed_tier"] })], { o6: { ticked: true, edit: { text: "x", reason_code: "other" } } }, "owner").join(" "),
      "no computed tier");
    eq("meetingRowWords: removal in words, never expiring",
       meetingRowWords(prow("x", { kind: "removal" }), { disposition: "do_not_contact", code: "asked_to_stop", reasons: REASONS }), "Remove — do not contact · asked us to stop · never expires");
    eq("meetingRowWords: a removal with nothing chosen asks for the disposition",
       meetingRowWords(prow("x2", { kind: "removal" }), { disposition: null, code: null, reasons: REASONS }), "Remove — choose do not contact or unqualified · never expires");
    includes("meetingRowWords: a review date is a person looking again, not an expiry",
       meetingRowWords(prow("x3", { kind: "removal" }), { disposition: "unqualified", code: "too_small", reviewOn: "2027-03-01", reasons: REASONS }), "a person looks again on 1 Mar 2027 · never expires");
    eq("meetingRowWords: fact against what the book holds",
       meetingRowWords(prow("f", { current_value: 25, current_source: "website" })), "headcount 40 · book: 25 from website");
    eq("meetingRowWords: fact where the book holds nothing", meetingRowWords(prow("f2")), "headcount 40 · book: nothing on record");
    includes("meetingRowWords: a fact that overrules a person says so",
       meetingRowWords(prow("f3", { current_value: 25, current_source: "rater", flags: ["conflicts_with_person"] })), "approving overrules them");
    eq("meetingRowWords: the edited value is the one shown", meetingRowWords(prow("f4"), { value: 45 }), "headcount 45 · book: nothing on record");
    eq("meetingRowWords: a boolean in words", meetingRowWords(prow("f5", { key: "sells_build_work", value: true })), "sells_build_work yes · book: nothing on record");
    eq("meetingRowWords: a fact the book already holds", meetingRowWords(prow("f6", { status: "agrees" })), "headcount 40 — team agrees with the board");
    eq("meetingRowWords: read", meetingRowWords(prow("r", { kind: "read", topic: "decision_maker" })), "Read · decision maker");
    // Rule 10 over everything the helper can print: no tier word ever stands without "anticipated".
    const printed = [
      meetingRowWords(tierCall, { tiers: TIERS, expiresOn: "2027-01-08" }),
      ...TIERS.flatMap((t) => TIERS.map((e) => meetingRowWords(prow("z", { kind: "override", tier: t, engine_tier: e }), { tiers: TIERS }))),
      ...TIERS.map((t) => meetingRowWords(prow("z", { kind: "override", tier: t, status: "agrees" }), {})),
      ...TIERS.map((t) => meetingRowWords(prow("z", { kind: "override", tier: t, engine_tier: "Silver" }), { tiers: TIERS, engineTier: t })),
      meetingCellWords("Gold × Project", TIERS),
    ].join("\n");
    check("meetingRowWords prints every tier with 'anticipated' (rule 10)", !/(?<!anticipated )\b(Bronze|Silver|Gold|Platinum)\b/.test(printed), printed);
    eq("meetingCellWords: a tier-led cell is anticipated", meetingCellWords("Gold × Project", TIERS), "cell anticipated Gold × Project");
    eq("meetingCellWords: any other cell as it is", meetingCellWords("Ready × High", TIERS), "cell Ready × High");
    eq("meetingCellWords: no cell", meetingCellWords(null, TIERS), null);
    eq("meetingFlagWords: historic names its window", meetingFlagWords("historic"), "said more than 21 days before it was read");
    eq("meetingFlagWords: an unknown flag in words", meetingFlagWords("new_flag"), "new flag");
    eq("tiersMoved: two apart", tiersMoved("Platinum", "Silver", TIERS), 2);
    eq("tiersMoved: unknown tier", tiersMoved("Platinum", null, TIERS), null);
  }

  /* -- overrideDefaults: everything from the rubric, nothing literal -- */
  {
    const spec = { override: { reason_codes: ["data_wrong", "relationship_known", "timing_known", "other"], expiry_default_days: 90 } };
    const d = overrideDefaults(prow("o", { kind: "override", reason_code: null, default_text: "\"they are gold now\" — Sales Connect, 2026-10-09 00:05:00" }), spec, "2026-10-10");
    eq("overrideDefaults: expiry = today + spec.override.expiry_default_days", d.expires_on, "2027-01-08");
    eq("overrideDefaults: the expiry follows the spec, not a constant", overrideDefaults(prow("o"), { override: { reason_codes: ["other"], expiry_default_days: 30 } }, "2026-10-10").expires_on, "2026-11-09");
    eq("overrideDefaults: codes are the spec's", d.codes, spec.override.reason_codes);
    eq("overrideDefaults: no model code → relationship_known", d.reason_code, "relationship_known");
    eq("overrideDefaults: the model's code when the rubric lists it", overrideDefaults(prow("o", { reason_code: "timing_known" }), spec, "2026-10-10").reason_code, "timing_known");
    eq("overrideDefaults: a code the rubric does not list falls back", overrideDefaults(prow("o", { reason_code: "made_up" }), spec, "2026-10-10").reason_code, "relationship_known");
    eq("overrideDefaults: without relationship_known, other", overrideDefaults(prow("o"), { override: { reason_codes: ["data_wrong", "other"], expiry_default_days: 90 } }, "2026-10-10").reason_code, "other");
    eq("overrideDefaults: the prefilled reason is the row's default_text", d.text, "\"they are gold now\" — Sales Connect, 2026-10-09 00:05:00");
    eq("overrideDefaults: no default_text → where it was said, never the quote",
      overrideDefaults(prow("o", { kind: "override" }), spec, "2026-10-10").text, "Tier call made in the sales meeting of 2026-10-09 at 00:05:00; the words are on its meeting card.");
    eq("overrideDefaults: no rubric → no codes, no expiry", [overrideDefaults(prow("o"), null, "2026-10-10").codes, overrideDefaults(prow("o"), null, "2026-10-10").expires_on], [[], null]);
    check("overrideDefaults holds no literal 90 and no literal code (they come from the spec)", !/\b90\b/.test(String(overrideDefaults)) && !String(overrideDefaults).includes("relationship_known"));
    eq("addDaysIso crosses a year", addDaysIso("2026-12-30", 3), "2027-01-02");
    eq("addDaysIso of nonsense", addDaysIso("soon", 3), null);
    eq("dayMonthWords", dayMonthWords("2027-01-08"), "8 Jan 2027");
  }

  /* -- removalCodesFor: the vocabulary is data; a review date only where it is allowed -- */
  {
    eq("removalDispositions in the vocabulary's order", removalDispositions(REASONS), ["do_not_contact", "unqualified"]);
    eq("removalCodesFor do_not_contact: its codes, none taking a review date",
       removalCodesFor(REASONS, "do_not_contact"), [{ code: "asked_to_stop", label: "Asked us to stop", review_date: false }, { code: "other", label: "Other", review_date: false }]);
    eq("removalCodesFor unqualified: sorted, inactive codes dropped, review date offered",
       removalCodesFor(REASONS, "unqualified"), [{ code: "gone", label: "Gone", review_date: true }, { code: "too_small", label: "Too small", review_date: true }]);
    eq("removalCodesFor an unknown disposition", removalCodesFor(REASONS, "elsewhere"), []);
    eq("removalCodesFor without a vocabulary", removalCodesFor(null, "unqualified"), []);
    check("removalCodesFor never offers a review date the row does not allow", removalCodesFor(REASONS, "do_not_contact").every((c: { review_date: boolean }) => c.review_date === false));
    eq("removalPair: an active pair", removalPair(REASONS, "unqualified", "gone")?.code, "gone");
    eq("removalPair: a code under the other disposition is no pair", removalPair(REASONS, "do_not_contact", "gone"), null);
    eq("removalPair: an inactive code is no pair", removalPair(REASONS, "unqualified", "retired_code"), null);
    eq("removalEdit: never an expiry, and no review date on do-not-contact",
       removalEdit({ disposition: "do_not_contact", reason_code: "asked_to_stop", review_on: "2027-01-01", expires_at: "2027-01-01T00:00:00Z", text: " \"stop calling\" — sales meeting " }, REASONS),
       { disposition: "do_not_contact", reason_code: "asked_to_stop", text: "\"stop calling\" — sales meeting" });
    eq("removalEdit: a review date where the pair takes one",
       removalEdit({ disposition: "unqualified", reason_code: "too_small", review_on: "2027-01-01", text: "x" }, REASONS),
       { disposition: "unqualified", reason_code: "too_small", text: "x", review_on: "2027-01-01" });
  }

  /* -- cardItems: one card, one call; removals only when chosen; never an expiry on one -- */
  {
    const rows = [
      prow("f1"),
      prow("f2", { key: "money", value: "present" }),
      prow("f3", { key: "timing", value: "within_1_month", flags: ["conflicts_with_person"] }),
      prow("r1", { kind: "read", topic: "price" }),
      prow("o1", { kind: "override", tier: "Silver" }),
      prow("x1", { kind: "removal", disposition: "unqualified", reason_code: "too_small" }),
      prow("a1", { status: "agrees" }),
      prow("n1", { status: "not_proposed", mode: "question" }),
      prow("d1", { status: "approved" }),
    ];
    const base = () => ({
      f1: { ticked: true, edit: { value: 40, changed: false } },
      f2: { ticked: false },
      f3: { ticked: true, touched: true },
      r1: { ticked: true },
      o1: { ticked: true, edit: { reason_code: "relationship_known", expires_on: "2027-01-08", text: " \"they are silver\" — Sales Connect " } },
      x1: { chosen: false, edit: { disposition: "unqualified", reason_code: "too_small", text: "\"take them off\"", expires_at: "2027-01-01T00:00:00Z" } },
    });
    const owner = cardItems(rows, base(), { mode: "approve", lane: "owner", reasons: REASONS });
    eq("cardItems (owner, A): ticked approve, unticked reject, the unchosen removal rejects, only proposed rows", owner, [
      { id: "f1", decision: "approve" },
      { id: "f2", decision: "reject" },
      { id: "f3", decision: "approve", overrule: true },
      { id: "r1", decision: "approve" },
      { id: "o1", decision: "approve", edit: { reason_code: "relationship_known", expires_at: "2027-01-08T00:00:00Z", text: "\"they are silver\" — Sales Connect" } },
      { id: "x1", decision: "reject" },
    ]);
    check("cardItems: a removal the model proposed is never approved without a choice", !owner.some((i: { id: string; decision: string }) => i.id === "x1" && i.decision === "approve"));
    const chosen = base();
    chosen.x1.chosen = true;
    const withRemoval = cardItems(rows, chosen, { mode: "approve", lane: "owner", reasons: REASONS });
    eq("cardItems: a chosen removal approves, with no expiry", withRemoval.find((i: { id: string }) => i.id === "x1"),
       { id: "x1", decision: "approve", edit: { disposition: "unqualified", reason_code: "too_small", text: "\"take them off\"" } });
    eq("cardItems ([Remove now]): the removal alone", cardItems(rows, chosen, { mode: "removal", only: "x1", lane: "owner", reasons: REASONS }),
       [{ id: "x1", decision: "approve", edit: { disposition: "unqualified", reason_code: "too_small", text: "\"take them off\"" } }]);
    eq("cardItems ([Remove now]): nothing when the removal was not chosen", cardItems(rows, base(), { mode: "removal", only: "x1", lane: "owner" }), []);
    const noCode = base();
    noCode.x1 = { chosen: true, edit: { disposition: "unqualified", reason_code: "", text: "x" } } as never;
    eq("cardItems: a chosen removal with no code is not an approval", cardItems(rows, noCode, { mode: "approve", lane: "owner" }).find((i: { id: string }) => i.id === "x1")?.decision, "reject");
    const rater = cardItems(rows, chosen, { mode: "approve", lane: "rater", reasons: REASONS });
    eq("cardItems (rater, A): a tier call and a removal are left for the owner, not rejected", rater.map((i: { id: string }) => i.id), ["f1", "f2", "f3", "r1"]);
    eq("cardItems ([Remove now], rater): nothing", cardItems(rows, chosen, { mode: "removal", only: "x1", lane: "rater" }), []);
    eq("cardItems (X): every open row rejects, nothing else is touched", cardItems(rows, chosen, { mode: "reject", lane: "rater" }),
       ["f1", "f2", "f3", "r1", "o1", "x1"].map((id) => ({ id, decision: "reject" })));
    const edited = base();
    edited.f1.edit = { value: 45, changed: true };
    eq("cardItems: an edited value travels as edit.value", cardItems(rows, edited, { mode: "approve", lane: "owner" })[0], { id: "f1", decision: "approve", edit: { value: 45 } });
    const untickedConflict = base();
    untickedConflict.f3.ticked = false;
    eq("cardItems: an unticked conflict rejects, with no overrule", cardItems(rows, untickedConflict, { mode: "approve", lane: "owner" })[2], { id: "f3", decision: "reject" });
    const every = [owner, withRemoval, rater, cardItems(rows, chosen, { mode: "removal", only: "x1", lane: "owner" }), cardItems(rows, chosen, { mode: "approve", lane: "owner" })].flat();
    check("cardItems never sends expires_at for a removal", every.filter((i: { id: string }) => i.id === "x1").every((i: { edit?: Record<string, unknown> }) => !i.edit || !("expires_at" in i.edit)));
    eq("cardItems of nothing", cardItems(null, null, null), []);

    const problems = base();
    problems.o1.edit.text = "  ";
    problems.x1.chosen = true;
    problems.x1.edit.reason_code = "";
    (problems.f1 as { edit: Record<string, unknown> }).edit = { value: 40, invalid: true };
    const said = cardProblems(rows, problems, "owner");
    check("cardProblems: a tier call with no written reason", said.some((s: string) => s.includes("written reason (rule 7)")), said);
    check("cardProblems: a chosen removal with no code", said.some((s: string) => s.includes("reason code")), said);
    check("cardProblems: a value that does not fit", said.some((s: string) => s.startsWith("headcount")), said);
    eq("cardProblems: the rater lane is not asked about the owner's rows", cardProblems(rows, problems, "rater").filter((s: string) => !s.startsWith("headcount")), []);
    eq("cardProblems: a clean card", cardProblems(rows, base(), "owner"), []);
  }

  /* -- shortcutAction: one card at a time, never the whole meeting -- */
  {
    const card = (key: string, extra: Row = {}) => shortcutAction({ key, zone: "card", ...extra });
    eq("shortcutAction: A approves the card", [card("A"), card("a")], ["approve", "approve"]);
    eq("shortcutAction: X rejects the card", card("X"), "reject");
    eq("shortcutAction: W wrong agency", card("W"), "wrong");
    eq("shortcutAction: L later", card("L"), "later");
    eq("shortcutAction: J next card", card("J"), "next");
    eq("shortcutAction: K previous card", card("k"), "prev");
    eq("shortcutAction: R the removal", card("r"), "removal");
    eq("shortcutAction: Space toggles the row", card(" "), "toggle");
    eq("shortcutAction: Space on a checkbox or button is the browser's", card(" ", { onControl: true }), null);
    eq("shortcutAction: nothing while typing", card("a", { typing: true }), null);
    eq("shortcutAction: nothing with a modifier (copy, reload…)", card("a", { mod: true }), null);
    eq("shortcutAction: an unmapped key", card("q"), null);
    eq("shortcutAction: 1–5 pick in 'Who is this?'", shortcutAction({ key: "3", zone: "strip" }), "pick:3");
    eq("shortcutAction: 6 picks nothing", shortcutAction({ key: "6", zone: "strip" }), null);
    eq("shortcutAction: N not in the book", shortcutAction({ key: "N", zone: "strip" }), "not_in_book");
    eq("shortcutAction: Enter confirms the pre-focused option", shortcutAction({ key: "Enter", zone: "strip" }), "confirm");
    eq("shortcutAction: Enter on a button is the button's own", shortcutAction({ key: "Enter", zone: "strip", onButton: true }), null);
    eq("shortcutAction: A in the strip approves nothing", shortcutAction({ key: "a", zone: "strip" }), null);
    // A held key: one decision, one toggle, one pick per press — a repeated A would send the card again
    // while the first press is still in flight. J and K keep walking.
    eq("shortcutAction: a held A, X, Space, R, W or L does nothing more",
      ["a", "x", " ", "r", "w", "l"].map((k) => card(k, { repeat: true })), [null, null, null, null, null, null]);
    eq("shortcutAction: …nor a held pick, N or Enter in the strip",
      ["3", "n", "Enter"].map((key) => shortcutAction({ key, zone: "strip", repeat: true })), [null, null, null]);
    eq("shortcutAction: a held J or K keeps walking the cards", [card("j", { repeat: true }), card("k", { repeat: true }), shortcutAction({ key: "j", zone: "strip", repeat: true })], ["next", "prev", "next"]);
    const actions = new Set<string>();
    for (const zone of ["card", "page", "strip"]) for (let c = 32; c < 127; c++) { const a = shortcutAction({ key: String.fromCharCode(c), zone }); if (a) actions.add(a.startsWith("pick:") ? "pick" : a); }
    eq("shortcutAction: the whole vocabulary — no approve-all among it", [...actions].sort(), ["approve", "later", "next", "not_in_book", "pick", "prev", "reject", "removal", "toggle", "wrong"]);
  }

  /* -- the words around a card -- */
  eq("decidedWords: the one line a card collapses to",
     decidedWords({ ok: true, approved: 4, rejected: 1, agrees: 0, facts: 3, overrides: 1, removals: 1, reads: 0, candidates_closed: 6 }),
     "Approved 4 · rejected 1 · 6 machine claims closed · tier and rank move at 06:15 UTC; removals leave the board now");
  eq("decidedWords: a rejected card", decidedWords({ approved: 0, rejected: 3 }), "Rejected 3");
  eq("decidedWords: reads only", decidedWords({ approved: 2, reads: 2 }), "Approved 2 · the reads are on the agency's register");
  eq("decidedWords: nothing", decidedWords({}), "Nothing changed");
  eq("decidedWords: no answer", decidedWords(null), "Decided");
  {
    const rows = [
      prow("1"), prow("2", { account_id: "acc-b" }), prow("3", { account_id: "acc-c", kind: "override", tier: "Gold" }),
      prow("4", { account_id: "acc-c", kind: "removal" }), prow("5", { account_id: null, said_key: "quill" }),
      prow("6", { account_id: null, said_key: "north", kind: "read", topic: "fit" }), prow("7", { status: "agrees" }), prow("8", { status: "rejected" }),
    ];
    const counts = meetingCounts(rows, 3);
    eq("meetingCounts: open rows only", counts, { agencies: 3, facts: 3, tier_calls: 1, removals: 1, reads: 1, to_place: 2, not_in_book: 3 });
    eq("meetingCountWords: the header line", meetingCountWords({ ...counts, reads: 0 }), "3 agencies · 3 facts · 1 tier call · 1 removal · 2 to place · 3 discussed, not in the book");
    includes("meetingCountWords: reads appear when there are any", meetingCountWords(counts), "1 read");
    eq("meetingCountWords: singular agency", meetingCountWords({ agencies: 1 }).split(" · ")[0], "1 agency");
  }
  {
    const open = [
      { recording_id: "rec-1", account_id: "acc-a", said_key: "a" }, { recording_id: "rec-1", account_id: "acc-a", said_key: "a" },
      { recording_id: "rec-1", account_id: null, said_key: "quill" }, { recording_id: "rec-2", account_id: "acc-a", said_key: "a" },
    ];
    eq("meetingsWaiting: agencies per meeting, a name not yet placed counts once", meetingsWaiting(open), { total: 3, byRecording: { "rec-1": 2, "rec-2": 1 } });
    eq("meetingsWaiting of nothing", meetingsWaiting(null), { total: 0, byRecording: {} });
    const list = [{ recording_id: "new" }, { recording_id: "mid" }, { recording_id: "old" }];
    eq("pickMeeting: the newest with open cards", pickMeeting(list, { mid: 2, old: 1 }), "mid");
    eq("pickMeeting: else the newest read", pickMeeting(list, {}), "new");
    eq("pickMeeting: none read", pickMeeting([], {}), null);

    /* Every meeting with an open card is reachable, however old: the reader works a backlog oldest first. */
    eq("meetingsMissing: open cards on meetings the newest-read list does not hold",
      meetingsMissing(list, { mid: 2, ancient: 1, older: 3, gone: 0 }), ["ancient", "older"]);
    eq("meetingsMissing of nothing", meetingsMissing(null, null), []);
    const newest = [
      { recording_id: "n2", held_at: "2026-11-02T15:00:00Z" }, { recording_id: "n1", held_at: "2026-11-01T15:00:00Z" },
    ];
    const extra = [
      { recording_id: "o1", held_at: "2026-09-01T15:00:00Z" }, { recording_id: "n1", held_at: "2026-11-01T15:00:00Z" },
      { recording_id: "undated", held_at: null }, { recording_id: "o2", held_at: "2026-10-01T15:00:00Z" },
    ];
    const merged = meetingPickList(newest, extra);
    eq("meetingPickList: the union, each once, newest first, an undated one last", merged.map((m: { recording_id: string }) => m.recording_id), ["n2", "n1", "o2", "o1", "undated"]);
    eq("pickMeeting over it: an old meeting's open cards are the ones a bare #meetings opens", pickMeeting(merged, { o1: 4 }), "o1");
    eq("meetingPickList of nothing", meetingPickList(null, undefined), []);
  }
  eq("clockSecondsOf", clockSecondsOf("00:31:07"), 1867);
  eq("clockSecondsOf of nonsense", clockSecondsOf("soon"), null);
  eq("fathomAt: the call url at the moment", fathomAt("https://fathom.example/calls/1", "00:00:10"), "https://fathom.example/calls/1?timestamp=10");
  eq("fathomAt: an existing query string", fathomAt("https://fathom.example/calls/1?x=1", "00:01:00"), "https://fathom.example/calls/1?x=1&timestamp=60");
  eq("fathomAt: no moment, the url", fathomAt("https://fathom.example/calls/1", null), "https://fathom.example/calls/1");
  eq("fathomAt: never a non-http url", fathomAt("javascript:alert(1)", "00:00:01"), null);
  eq("meetingLengthWords: minutes", meetingLengthWords("2026-10-09T15:00:00Z", "2026-10-09T15:58:00Z"), "58 min");
  eq("meetingLengthWords: hours", meetingLengthWords("2026-10-09T15:00:00Z", "2026-10-09T16:56:00Z"), "1 h 56 min");
  eq("meetingLengthWords: unknown end", meetingLengthWords("2026-10-09T15:00:00Z", null), null);
  {
    const ctx = "L0009 [00:04:58] S2: before that\nL0010 [00:05:00] S1: they have about forty people now\nL0011 [00:05:04] S2 (context): write to rep.b@example.com about it\nL0013 [00:05:30] S1: later";
    const speakers = [{ label: "S1", name: "Rep A" }, { label: "S2", name: null }];
    eq("contextLines: names for labels, addresses scrubbed", contextLines(ctx, speakers), [
      { n: 9, at: "00:04:58", who: "S2", text: "before that" },
      { n: 10, at: "00:05:00", who: "Rep A", text: "they have about forty people now" },
      { n: 11, at: "00:05:04", who: "S2", text: "write to [address] about it" },
      { n: 13, at: "00:05:30", who: "Rep A", text: "later" },
    ]);
    eq("contextLines: ±1 around the cited line", contextLines(ctx, speakers, 10, 10, 1).map((l: { n: number }) => l.n), [9, 10, 11]);
    eq("contextLines of nothing", contextLines(null, []), []);
  }
  eq("scrubAddresses: an address said aloud never reaches the screen", scrubAddresses("mail owner.x@example.co.uk today"), "mail [address] today");
  eq("scrubAddresses: plain text unchanged", scrubAddresses("about forty people @ the office"), "about forty people @ the office");
  eq("scrubAddresses: nothing", scrubAddresses(null), "");
}

/* ---- the meeting screen, as a page: what it calls and what it never does ---- */
{
  for (const fn of ["pb_decide_meeting_card", "pb_assign_meeting_mention", "pb_meeting_include", "pb_meeting_title_rule", "pb_dismiss_meeting"]) {
    check(`the meeting screen calls ${fn}`, page.includes(`rpc("${fn}"`));
  }
  check("the meeting screen reads pb_meetings and pb_meeting_proposals", page.includes('from("pb_meetings")') && page.includes('from("pb_meeting_proposals")'));
  // PostgREST cuts any answer at max-rows without a word, so the open proposals are read in pages, once, for both counts.
  const openReads = [...page.matchAll(/from\("pb_meeting_proposals"\)\.select\([^)]*\)\.eq\("status", "proposed"\)[^\n]*/g)].map((m) => m[0]);
  check("the open proposals are read in one place, a page at a time: an exact count, a unique order, a range, never .limit()",
    openReads.length === 1 && openReads.every((x) => x.includes('{ count: "exact" }') && x.includes('.order("id")') && x.includes(".range(from, to)") && !x.includes(".limit(")) &&
    page.includes("return pagedRows((from, to) => db.from(\"pb_meeting_proposals\")"), openReads);
  check("…and both the roster's count and the review's picker use it",
    page.includes("const { data, error } = await openMeetingProposals(state.db);") && page.includes("    openMeetingProposals(db),\n"));
  // The book's accounts and current reads both outnumber max-rows, and the screen's live checks rest on them: a read cut
  // from the answer flags its agency "no computed tier", an account cut from it can never be placed by "Who is this?".
  // Only one agency's own row, or the records merged into it, may be read without paging.
  const bookLoads = [...page.matchAll(/from\("(?:pb_accounts|pb_current_reads)"\)\.select\([^\n]*/g)].map((m) => m[0])
    .filter((x) => !/\.eq\("(?:id|merged_into)", id\)/.test(x));
  check("the book's accounts and current reads are read a page at a time: an exact count, a unique order, a range, never .limit()",
    bookLoads.length === 3 &&
    bookLoads.every((x) => x.includes('{ count: "exact" }') && /\.order\("(?:id|account_id)"\)\.range\(from, to\)\)/.test(x) && !x.includes(".limit(")) &&
    page.includes('pagedRows((from, to) => state.db.from("pb_accounts")') && page.includes('pagedRows((from, to) => state.db.from("pb_current_reads")') &&
    page.includes('pagedRows((from, to) => db.from("pb_current_reads").select("*", { count: "exact" }).in("account_id", openAccts)'), bookLoads);
  check("…and the roster is put back in name order once every page is in", page.includes("state.accounts = (acc.data ?? []).sort((x, y) => String(x.name"));
  // The meeting screen checks each open row against the book NOW: its facts AND its reads, read again
  // every time it opens, and a refused card is redrawn from them (a board moved under an open tab).
  {
    const fnBody = (name: string, next: string) => {
      const at = page.indexOf(name);
      return at < 0 ? "" : page.slice(at, page.indexOf(next, at));
    };
    const om = fnBody("async function openMeetings(", "\nfunction drawMeetings(");
    const merged = om.indexOf("state.reads = mergeReads(state.reads, openAccts, ");
    check("openMeetings reads the open rows' agencies' reads again (pb_current_reads), not only their facts",
      om.includes('db.from("pb_current_reads")') && om.includes('db.from("pb_current_facts")') && merged >= 0);
    check("…merges them before it re-derives a single row's flags",
      merged >= 0 && merged < om.indexOf("meetingLiveRow(r, {") && om.includes("read: meetingReadOf(state.reads, r.account_id, readsFresh),"));
    check("…and never checks a row against the page-load reads directly", !/read:\s*state\.reads\.(?:has|get)\(/.test(om));
    const dc = fnBody("async function decideCard(", "\n}\n");
    const refused = dc.slice(dc.indexOf("if (error) {"), dc.indexOf("return;", dc.indexOf("if (error) {")));
    check("a refused card keeps the database's words and is redrawn from the book as it stands",
      refused.includes("S.msgs.set(card.key,") && refused.includes("error.message") && refused.includes("await openMeetings(S.rid);"), refused);
    // The words saved for a card are shown on the next draw, wherever the card lands, and never kept.
    const dm = fnBody("function drawMeetings(", "\nfunction meetingHeader(");
    const placedAt = dm.indexOf("placeCardNotices(S.msgs, grouped.cards)");
    check("drawMeetings places the saved words once and empties them before it draws a card",
      placedAt >= 0 && dm.indexOf("S.msgs.clear();") > placedAt && dm.includes("S.notes = notes.onCard;") &&
      dm.includes("for (const m of notes.top) parts.push(") && dm.indexOf("S.msgs.clear();") < dm.indexOf("cards.map(meetingCard)"), dm.slice(0, 600));
    const done = fnBody("function doneCard(", "\nfunction meetingRow(");
    const foot = fnBody("function cardFooter(", "\nfunction sayOnCard(");
    check("a decided card shows the words saved for it (a refusal must not vanish behind a closed card)", done.includes("S.notes?.get(card.key)") && /saved \? h\("div", \{ class: "notice "/.test(done), done);
    check("…as an open card's footer does, and neither keeps them in S.msgs", foot.includes("S.notes?.get(card.key)") && !done.includes("S.msgs") && !foot.includes("S.msgs"), foot);
    // A row's tick is judged again on every draw, and only a person's own touch of the box marks it theirs.
    const cf = fnBody("function choiceFor(", "\nasync function openMeetings(");
    check("choiceFor judges the kept tick again against the row as drawn (meetingTick), never returns it as cached",
      cf.includes("Object.assign(c, meetingTick(r, c));") && !cf.includes("ticked: meetingStartsTicked(r)"), cf);
    const mr = fnBody("function meetingRow(", "\n/** Rebuild one row in place");
    check("the box's change handler marks the tick the person's, keeps their own answer apart (mine) and records what it answered",
      mr.includes('box.addEventListener("change", () => { c.ticked = box.checked; c.mine = box.checked; c.touched = true; c.basis = meetingTickBasis(r, c); });'), mr);
    check("…and nothing else on the page writes the person's own answer", (page.match(/\bc\.mine\s*=/g) ?? []).length === 1 && !/\bmine\s*:(?!\s*false\b)/.test(page.slice(page.indexOf("@pure-end"))));
    // The refresh closure itself — the change handler carries the same line, so a search of the whole
    // row would pass with refresh's own line gone.
    const rfAt = mr.indexOf("const refresh = () => {");
    const rf = rfAt < 0 ? "" : mr.slice(rfAt, mr.indexOf("\n  refresh();", rfAt));
    check("an edit that moves the conflict records the tick's new basis (inside refresh, not only in the change handler)",
      rf.length > 0 && rf.includes("c.basis = meetingTickBasis(r, c);") && !rf.includes("addEventListener"), rf);
    // One decision per card at a time: the buttons are disabled while it is in flight, the keys are not.
    const dcGuard = dc.slice(0, dc.indexOf("const lane"));
    check("decideCard does nothing while a decision on the same card is still in flight",
      dcGuard.includes("if (S.deciding.has(card.key)) return;"), dcGuard);
    const addAt = dc.indexOf("S.deciding.add(card.key);"), rpcAt = dc.indexOf('rpc("pb_decide_meeting_card"');
    const finAt = dc.indexOf("} finally {");
    check("…holds the card from before the call until its redraw is in, whatever the call answers",
      addAt >= 0 && addAt < rpcAt && dc.slice(addAt, rpcAt).includes("try {") && finAt > dc.lastIndexOf("await openMeetings(S.rid);") &&
      dc.slice(finAt).includes("S.deciding.delete(card.key);"), dc.slice(Math.max(0, addAt - 40), addAt + 200));
    check("…in the Set every kept state shares", om.includes("deciding: keep ? keep.deciding : new Set(),"));
    check("the keydown handler tells shortcutAction a held key repeats", page.includes("onButton, onControl, repeat: e.repeat });"));
  }
  check("the picker holds every meeting with an open card, not only the newest read ones",
    page.includes("meetingsMissing(list.data ?? [], waiting.byRecording)") && page.includes("pickMeeting(meetings, waiting.byRecording)") && page.includes("list: meetings,"));
  check("the open rows are shown as the book stands now, and a row's overrule follows the value as edited",
    page.includes(': meetingLiveRow(r, {') && page.includes("meetingOverrules(r, meetingSentValue(r, c))"));
  check("the #meetings routes exist", page.includes("#meetings") && /\^#meetings\(\?:=/.test(page));
  check("no select ever asks for share_url (a capability link)", !/select\([^)]*share_url/.test(page));
  check("the screen never names who decided a row (an address)", !page.includes("decided_by"));
  const decideCalls = page.match(/rpc\("pb_decide_meeting_card"/g) ?? [];
  check("pb_decide_meeting_card is called for one card, or one row — never for a meeting", decideCalls.length === 2 && page.includes("cardItems(card.open,") && !/cardItems\([^)]*rows\b[^)]*\)/.test(page.split("@pure-end")[1] ?? ""), { calls: decideCalls.length });
  check("meeting buttons are 44 px at phone width", /@media \(max-width:640px\)\{\s*#meetings button[^}]*min-height:44px/.test(page));
  const ls = [...page.matchAll(/localStorage|sessionStorage/g)];
  check("every browser-storage touch is inside a try", ls.every((m) => page.slice(Math.max(0, (m.index ?? 0) - 240), m.index).includes("try {")), { touches: ls.length });
}

/* ---- the page itself: data reaches the DOM as text only ---- */
check("page never assigns innerHTML / outerHTML", !/\.(inner|outer)HTML\s*=/.test(page));
check("page never calls insertAdjacentHTML", !page.includes("insertAdjacentHTML"));
check("page never renders wallet / headroom / winnable_share as numbers", !/\b(p|potential)\.(wallet|headroom|winnable_share)\b/.test(page) && !/inputs\.(revenue_per_head|outsourceable_share)\b/.test(page));
}

/* ---- pagedRows: every open proposal, past PostgREST's max-rows ---- */
async function pagedChecks(): Promise<void> {
  // A fake PostgREST: `total` rows, at most `cap` per answer whatever range is asked, the exact count.
  const server = (total: number, cap: number, opts: { failAt?: number; noCount?: boolean } = {}) => {
    const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
    const calls: [number, number][] = [];
    const page = async (from: number, to: number) => {
      calls.push([from, to]);
      if (opts.failAt !== undefined && calls.length === opts.failAt) return { data: null, error: { message: "boom" }, count: null };
      return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: opts.noCount ? null : total };
    };
    return { page, calls };
  };
  {
    const s = server(2500, 1000);
    const r = await pagedRows(s.page, 1000);
    eq("pagedRows: 2,500 rows under a 1,000-row cap all arrive", r.data.length, 2500);
    eq("pagedRows: in order, each once", r.data.every((x: { id: number }, i: number) => x.id === i), true);
    eq("pagedRows: three pages, and no empty fourth (the count says when it is done)", s.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  }
  {
    const s = server(1200, 500);
    const r = await pagedRows(s.page, 1000);
    eq("pagedRows: a max-rows smaller than the page still reads everything", r.data.length, 1200);
    eq("pagedRows: …asking again from where each short answer stopped", s.calls.map((c) => c[0]), [0, 500, 1000]);
  }
  {
    const s = server(0, 1000);
    const r = await pagedRows(s.page, 1000);
    eq("pagedRows: nothing open is one call and an empty list", [r.data, s.calls.length, r.error], [[], 1, null]);
  }
  {
    const s = server(2500, 1000, { failAt: 2 });
    const r = await pagedRows(s.page, 1000);
    eq("pagedRows: an error on any page is the answer, never a short list", [r.data, r.error?.message], [null, "boom"]);
  }
  {
    const s = server(1500, 1000, { noCount: true });
    const r = await pagedRows(s.page);
    eq("pagedRows: with no count, a short page is the last (default page of 1,000)", [r.data.length, s.calls.length], [1500, 2]);
  }
}

try {
  run();
  await pagedChecks();
} catch (err) {
  // A helper that throws (a ReferenceError to a page global, say) is a failure, not a crash.
  failed++;
  console.error(`FAIL  uncaught while checking: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
}

console.log(`page_pure: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
