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
const declared = [...block.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm)].map((m) => m[1] ?? m[2]);
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
  compareKey, orderAccounts, pickBand, coerceFactValue, overrideCapWarning, INVALID,
  ageWords, strengthWords, headcountWords, ratioWords, factValueWords, safeUrl, rowMatches,
  catalogEntries, signalCatalogWords, mergeTargets, movedWords, reviewEffectWords,
} = helpers;

function run(): void {
/* ---- the block exports what the page and this script expect ---- */
for (const name of ["compareKey", "orderAccounts", "pickBand", "coerceFactValue", "overrideCapWarning", "INVALID", "factValueWords", "rowMatches", "reviewEffectWords", "mergeTargets"]) {
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

/* ---- the page itself: data reaches the DOM as text only ---- */
check("page never assigns innerHTML / outerHTML", !/\.(inner|outer)HTML\s*=/.test(page));
check("page never calls insertAdjacentHTML", !page.includes("insertAdjacentHTML"));
check("page never renders wallet / headroom / winnable_share as numbers", !/\b(p|potential)\.(wallet|headroom|winnable_share)\b/.test(page) && !/inputs\.(revenue_per_head|outsourceable_share)\b/.test(page));
}

try {
  run();
} catch (err) {
  // A helper that throws (a ReferenceError to a page global, say) is a failure, not a crash.
  failed++;
  console.error(`FAIL  uncaught while checking: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
}

console.log(`page_pure: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
