/**
 * WLIQ Prospect Book — identity resolution tests.
 *
 * Run:  node --experimental-strip-types ingest/identity_test.ts
 *   or: deno run ingest/identity_test.ts
 *
 * Every name here is synthetic. The four "July alias" cases are the SHAPES of real
 * mismatches that were once resolved by hand, re-cast on invented agencies:
 *   1. ampersand vs "and"
 *   2. "The X Chef/SUFFIX" vs "X Chef"  (a dual-brand suffix, invented here)
 *   3. singular vs plural
 *   4. CamelCase run-together vs spaced
 * The tests show where each lands (medium / low / nothing) and that NONE attaches.
 */

import {
  domainFromEmail,
  norm,
  normalizeDomain,
  proposeMatches,
  trigram,
  TRIGRAM_LOW_THRESHOLD,
} from "./identity.ts";
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
 * 1 · norm(name)
 * ------------------------------------------------------------------ */

eq("norm lower-cases and collapses whitespace", norm("  Harbor   Pine  "), "harbor pine");
eq("norm strips the listed words", norm("The Harbor Pine Agency Group, Inc."), "harbor pine");
eq("norm strips llc / ltd / co", norm("Harbor Pine LLC"), "harbor pine");
eq("norm strips ltd", norm("Harbor Pine Ltd"), "harbor pine");
eq("norm strips co as a whole word only", norm("Harbor Co Pine Collective"), "harbor pine collective");
eq("norm turns punctuation into word breaks", norm("Harbor-Pine/Studio.io"), "harbor pine studio io");
eq("norm folds & to and", norm("Harbor & Pine"), "harbor and pine");
eq("norm drops accents", norm("Café Lumen"), "cafe lumen");
eq("norm is idempotent", norm(norm("The Harbor & Pine Agency, LLC")), norm("The Harbor & Pine Agency, LLC"));
eq("norm of null is empty", norm(null), "");
eq("norm of undefined is empty", norm(undefined), "");
eq("norm of only strip-words is empty", norm("The Agency Group"), "");
eq("norm keeps digits", norm("Studio 54 Creative"), "studio 54 creative");

/* ------------------------------------------------------------------ *
 * 2 · normalizeDomain / domainFromEmail
 * ------------------------------------------------------------------ */

eq("domain from a URL with www, path and query", normalizeDomain("https://www.Harbor-Pine.com/about?x=1"), "harbor-pine.com");
eq("domain from an email", normalizeDomain("hello@harborpine.com"), "harborpine.com");
eq("domain from a bare host, mixed case, www", normalizeDomain("WWW.HarborPine.COM"), "harborpine.com");
eq("domain strips a port", normalizeDomain("harborpine.com:8080"), "harborpine.com");
eq("domain strips userinfo and port from a URL", normalizeDomain("http://user:pw@harborpine.com:443/x"), "harborpine.com");
eq("domain from mailto:", normalizeDomain("mailto:hi@harborpine.io"), "harborpine.io");
eq("domain from an angle-bracketed address", normalizeDomain("Someone <ceo@harborpine.io>"), "harborpine.io");
eq("domain strips a trailing dot", normalizeDomain("harborpine.com."), "harborpine.com");
eq("domain strips www2", normalizeDomain("www2.harborpine.com"), "harborpine.com");
eq("domain keeps a real subdomain", normalizeDomain("live.harborpine.com"), "live.harborpine.com");
eq("domain keeps a cc second-level host", normalizeDomain("https://www.harborpine.co.uk/"), "harborpine.co.uk");
eq("domain of empty is null", normalizeDomain(""), null);
eq("domain of whitespace is null", normalizeDomain("   "), null);
eq("domain of null is null", normalizeDomain(null), null);
eq("domain of undefined is null", normalizeDomain(undefined), null);
eq("domain without a dot is null", normalizeDomain("localhost"), null);
eq("domain of a bare scheme is null", normalizeDomain("http://"), null);
for (const g of [
  "gmail.com", "googlemail.com", "outlook.com", "yahoo.com", "yahoo.co.uk", "icloud.com",
  "hotmail.com", "hotmail.co.uk", "live.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
]) {
  eq(`generic mail domain ${g} is null`, normalizeDomain(g), null);
  eq(`generic mail address at ${g} is null`, normalizeDomain(`someone@${g}`), null);
}
eq("domainFromEmail resolves an org address", domainFromEmail("ops@HarborPine.com"), "harborpine.com");
eq("domainFromEmail of a gmail address is null", domainFromEmail("someone@gmail.com"), null);
eq("domainFromEmail without @ is null", domainFromEmail("harborpine.com"), null);
eq("domainFromEmail of null is null", domainFromEmail(null), null);

/* ------------------------------------------------------------------ *
 * 3 · trigram
 * ------------------------------------------------------------------ */

eq("trigram of identical strings is 1", trigram("harbor pine", "harbor pine"), 1);
eq("trigram of two empties is 0", trigram("", ""), 0);
eq("trigram against empty is 0", trigram("harbor pine", ""), 0);
eq("trigram of null is 0", trigram(null, "harbor"), 0);
check("trigram is symmetric", trigram("harbor pine", "harbor vine") === trigram("harbor vine", "harbor pine"));
check("trigram is deterministic", trigram("harbor pine studios", "harbor pine studio") === trigram("harbor pine studios", "harbor pine studio"));
const tPlural = trigram("harbor pine studios", "harbor pine studio");
check(`trigram plural/singular ≥ ${TRIGRAM_LOW_THRESHOLD}`, tPlural >= TRIGRAM_LOW_THRESHOLD, `got ${tPlural}`);
const tVine = trigram("harbor pine", "harbor vine");
check("trigram of a one-letter word swap is well below the threshold", tVine < 0.7, `got ${tVine}`);
check("trigram stays inside 0..1", [tPlural, tVine, trigram("a", "b"), trigram("abc", "abc")].every((v) => v >= 0 && v <= 1));

/* ------------------------------------------------------------------ *
 * 4 · proposeMatches — the roster
 * ------------------------------------------------------------------ */

const acc = (
  id: string, name: string, domain: string | null = null,
  pipedrive_org_id: number | string | null = null, orbit_client_id: number | string | null = null,
): KnownAccount => ({ id, key: norm(name), name, domain, pipedrive_org_id, orbit_client_id });

const KNOWN: KnownAccount[] = [
  acc("a1", "Harbor & Pine Creative", "harborpine.com", 1001, 501),
  acc("a2", "Harbor Chef", "harborchef.com", 1002, null),
  acc("a3", "Harbor Pine Studios", null, null, 503),
  acc("a4", "Harbor Pine", "harbor-pine.io", null, null),
  acc("a5", "Northfield Digital", "northfield.digital", 1005, 505),
  acc("a6", "Bluewater Collective", null, null, null),
];

/* ---- high matches attach ---- */
{
  const r = proposeMatches({ source: "pipedrive", pipedrive_org_id: 1005, name: "Totally Different Name" }, KNOWN);
  eq("pipedrive_org_id attaches", r.attach?.id, "a5");
  eq("...as a high candidate on pipedrive_org_id", r.candidates[0], { account_id: "a5", matched_on: "pipedrive_org_id", confidence: "high", score: 1 });
}
{
  const r = proposeMatches({ source: "pipedrive", pipedrive_org_id: "1005" }, KNOWN);
  eq("pipedrive_org_id as a string still attaches", r.attach?.id, "a5");
}
{
  const r = proposeMatches({ source: "orbit", orbit_client_id: 503, name: "Someone Else" }, KNOWN);
  eq("orbit_client_id attaches", r.attach?.id, "a3");
  eq("...matched_on orbit_client_id", r.candidates[0].matched_on, "orbit_client_id");
}
{
  const r = proposeMatches({ source: "fathom", domain: "https://www.HarborChef.com/" }, KNOWN);
  eq("domain attaches after normalisation", r.attach?.id, "a2");
  eq("...matched_on domain, high", [r.candidates[0].matched_on, r.candidates[0].confidence], ["domain", "high"]);
}
{
  const r = proposeMatches({ source: "fathom", domain: "someone@gmail.com" }, KNOWN);
  eq("a generic mail domain never matches", r.attach, null);
  eq("...and yields no candidate", r.candidates, []);
}
{
  // Trust order: a pipedrive id that names one account beats a domain that names another.
  const r = proposeMatches({ source: "pipedrive", pipedrive_org_id: 1001, domain: "harborchef.com" }, KNOWN);
  eq("conflicting high keys: pipedrive_org_id wins the attach", r.attach?.id, "a1");
  eq("...and the domain match is surfaced as a second high candidate", r.candidates.map((c) => [c.account_id, c.matched_on]), [["a1", "pipedrive_org_id"], ["a2", "domain"]]);
}
{
  const r = proposeMatches({ source: "pipedrive", pipedrive_org_id: 1001, domain: "harborpine.com", name: "Harbor and Pine Creative" }, KNOWN);
  eq("one account matched three ways is listed once", r.candidates.length, 1);
  eq("...on its strongest key", r.candidates[0].matched_on, "pipedrive_org_id");
}

/* ---- null is never evidence ---- */
{
  const r = proposeMatches({ source: "sheet", name: "Unrelated Partners", pipedrive_org_id: null, orbit_client_id: null, domain: null }, KNOWN);
  eq("null ids never match the accounts with null ids", r.attach, null);
  eq("...no candidates from nulls", r.candidates, []);
}
{
  const r = proposeMatches({ source: "sheet", name: "" , domain: "" }, KNOWN);
  eq("empty name and domain produce nothing", r.candidates, []);
}
{
  const r = proposeMatches({ source: "sheet" }, KNOWN);
  eq("a candidate with no keys at all produces nothing", [r.attach, r.candidates], [null, []]);
}

/* ---- the four July alias shapes: medium / low / nothing, and NEVER an attach ---- */
{
  // 1 · ampersand vs "and" — norm folds & to and → medium (name_norm), not attached.
  const r = proposeMatches({ source: "notion", name: "Harbor and Pine Creative" }, KNOWN);
  eq("July-1 ampersand vs and → medium", r.candidates.map((c) => [c.account_id, c.matched_on, c.confidence]), [["a1", "name_norm", "medium"]]);
  eq("July-1 never attaches", r.attach, null);
}
{
  // 2 · "The X Chef/SUFFIX" vs "X Chef" — a dual-brand suffix: norm differs, trigram 0.71.
  // Below the 0.85 low threshold, so it is NOT a candidate; the caller records matched_on none
  // and the alias table (a person) resolves it. Asserted so a threshold change is visible.
  const r = proposeMatches({ source: "notion", name: "The Harbor Chef/NOVAE" }, KNOWN);
  const sim = trigram(norm("The Harbor Chef/NOVAE"), norm("Harbor Chef"));
  check("July-2 dual-brand suffix sits below the low threshold", sim < TRIGRAM_LOW_THRESHOLD && sim > 0.6, `trigram ${sim}`);
  eq("July-2 produces no automatic candidate", r.candidates, []);
  eq("July-2 never attaches", r.attach, null);
}
{
  // 3 · singular vs plural → low (trigram 0.857).
  const r = proposeMatches({ source: "orbit", name: "Harbor Pine Studio" }, KNOWN);
  const a3 = r.candidates.find((c) => c.account_id === "a3");
  check("July-3 plural vs singular → low on a3", a3 !== undefined && a3.confidence === "low" && a3.matched_on === "name_trigram", JSON.stringify(r.candidates));
  check("July-3 carries its similarity score", a3 !== undefined && (a3.score ?? 0) >= TRIGRAM_LOW_THRESHOLD && (a3.score ?? 0) < 1);
  check("July-3 is not a medium", r.candidates.every((c) => c.confidence !== "medium"));
  eq("July-3 never attaches", r.attach, null);
}
{
  // 4 · CamelCase run-together vs spaced → low (compact forms are identical, score 1).
  const r = proposeMatches({ source: "sheet", name: "HarborPine" }, KNOWN);
  const a4 = r.candidates.find((c) => c.account_id === "a4");
  check("July-4 CamelCase vs spaced → low on a4", a4 !== undefined && a4.confidence === "low" && a4.matched_on === "name_trigram", JSON.stringify(r.candidates));
  eq("July-4 compact forms are identical (score 1)", a4?.score, 1);
  check("July-4 is not a medium (norm keys differ)", norm("HarborPine") !== norm("Harbor Pine"));
  eq("July-4 never attaches", r.attach, null);
}

/* ---- medium and low never attach, in general ---- */
{
  const r = proposeMatches({ source: "sheet", name: "Northfield Digital" }, KNOWN);
  eq("raw-equal name → name_exact medium", r.candidates, [{ account_id: "a5", matched_on: "name_exact", confidence: "medium", score: 1 }]);
  eq("name_exact still does not attach", r.attach, null);
}
{
  const r = proposeMatches({ source: "sheet", name: "The Northfield Digital Group, LLC" }, KNOWN);
  eq("norm-equal name → name_norm medium", r.candidates[0].matched_on, "name_norm");
  eq("name_norm does not attach", r.attach, null);
}
{
  const r = proposeMatches({ source: "sheet", name: "Bluewater Collectives" }, KNOWN);
  eq("plural on a domainless account → low", r.candidates.map((c) => [c.account_id, c.confidence]), [["a6", "low"]]);
  eq("low does not attach", r.attach, null);
}
{
  const r = proposeMatches({ source: "sheet", name: "Harbor Vine" }, KNOWN);
  check("a one-letter word swap is NOT a candidate", r.candidates.length === 0, JSON.stringify(r.candidates));
}
{
  // A medium name match plus a high domain match on the same account: attaches, listed once as high.
  const r = proposeMatches({ source: "apollo", name: "Northfield Digital", domain: "northfield.digital" }, KNOWN);
  eq("high + medium on one account attaches", r.attach?.id, "a5");
  eq("...listed once, as the high", r.candidates, [{ account_id: "a5", matched_on: "domain", confidence: "high", score: 1 }]);
}
{
  // Ordering: strongest first when several accounts match.
  const r = proposeMatches({ source: "sheet", name: "Harbor Pine Studio", orbit_client_id: 501 }, KNOWN);
  eq("candidates are ordered high → low", r.candidates.map((c) => c.confidence), ["high", "low"]);
  eq("...and the high one attaches", r.attach?.id, "a1");
}
{
  // Determinism: the same call twice gives the same proposal.
  const x = JSON.stringify(proposeMatches({ source: "sheet", name: "Harbor Pine Studio" }, KNOWN));
  const y = JSON.stringify(proposeMatches({ source: "sheet", name: "Harbor Pine Studio" }, KNOWN));
  eq("proposeMatches is deterministic", x, y);
}
{
  // An account whose key was left empty falls back to norm(name).
  const weird: KnownAccount[] = [{ id: "z", key: "", name: "Harbor Pine", domain: null, pipedrive_org_id: null, orbit_client_id: null }];
  eq("an empty key falls back to norm(name)", proposeMatches({ source: "sheet", name: "harbor pine" }, weird).candidates[0]?.confidence, "medium");
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`identity_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("identity_test failed");
  }
} else {
  console.log(`identity_test: ${passed} checks passed`);
}
