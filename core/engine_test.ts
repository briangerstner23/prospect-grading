/**
 * WLIQ Prospect Book — engine test suite.
 *
 * Run:  node --experimental-strip-types core/engine_test.ts
 *   or: deno run --allow-read core/engine_test.ts
 *
 * Four layers:
 *   1. RULE ASSERTIONS — hand-written checks per rule family, stated from the rubric text,
 *      not from the engine's own output.
 *   2. GOLDEN REPLAY — every fixture in ../fixtures/golden.json must reproduce its expected
 *      slim exactly. A failed fixture is a stop, not a warning.
 *   3. DETERMINISM — grade twice, byte-identical JSON.
 *   4. PURITY — the output depends on `as_of`, never on the wall clock. No Date.now() anywhere
 *      in core/ (asserted by reading the sources).
 *
 * Every fixture is synthetic. No prospect data enters this repository.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildReason,
  canonicalJson,
  classifyIcp,
  computeUrgency,
  dealHealth,
  decaySignals,
  evaluateGates,
  fingerprint,
  grade,
  pickBand,
  routeTasks,
} from "./engine.ts";
import type { DealHealthInput } from "./engine.ts";
import { evalWhen, RubricError } from "./classify.ts";
import type { ProspectFeatures, ProspectScorecard, SignalInput, Tier } from "./prospect_types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(join(here, p), "utf8"));

// deno-lint-ignore no-explicit-any
type Rubric = any;
const RUBRICS: Record<string, Rubric> = { "0.1.0": load("rubric.prospect.v0.1.json") };
const R: Rubric = RUBRICS["0.1.0"];
const FIXTURES: Array<{ id: string; description: string; features: ProspectFeatures; options?: { override?: unknown }; expected: Record<string, unknown> }> =
  load("../fixtures/golden.json");

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
/** The call must throw a RubricError whose message names `needle` (the rubric path). */
function throws(name: string, fn: () => unknown, needle: string) {
  try {
    fn();
    failures.push(`${name} — expected a RubricError naming '${needle}', nothing was thrown`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ok = e instanceof RubricError && msg.includes(`'${needle}'`) && msg.includes("no code fallback");
    check(name, ok, ok ? "" : `expected a RubricError naming '${needle}', got ${e instanceof Error ? e.name : typeof e}: ${msg}`);
  }
}
/** Deep-clone the rubric and delete the key at a dotted path. */
function without(path: string): Rubric {
  const copy = structuredClone(R);
  const segs = path.split(".");
  let node = copy;
  for (const s of segs.slice(0, -1)) node = node[s];
  delete node[segs[segs.length - 1]];
  return copy;
}

/* ------------------------------------------------------------------ *
 * the pinned rubric fingerprint
 * ------------------------------------------------------------------ *
 * The rubric's bytes are the contract behind every fixture below. Changing them is a
 * deliberate act — a new threshold, a new catalog row — and this pin makes it one: edit the
 * rubric, re-read the fixtures, then re-record the hash here in the same change. A rubric
 * edit that arrives without this line moving is an accident.
 */
const PINNED_FINGERPRINT: Record<string, string> = { "0.1.0": "__PIN__" };

/* ------------------------------------------------------------------ *
 * a synthetic base record
 * ------------------------------------------------------------------ */

const AS_OF = "2026-09-09";
const daysAgo = (n: number, from = AS_OF) => new Date(Date.parse(from + "T00:00:00Z") - n * 86_400_000).toISOString();
const sig = (type: string, days: number, extra: Partial<SignalInput> = {}): SignalInput => {
  const c = R.signals.catalog[type];
  return { type, observed_at: daysAgo(days), source: "manual", weight: c.weight, lifespan_days: c.lifespan_days, decays: c.decays, ...extra };
};

const base = (o: Partial<ProspectFeatures> = {}): ProspectFeatures => ({
  account_id: "t", name: "Harbor & Pine Creative", as_of: AS_OF,
  relationship_type: "agency", roster_source: "pipedrive", roster_certified: true, lineage: null,
  icp_class: "ICP-2", icp_class_label: "inferred", is_agency: true, agency_type: "full_service",
  headcount: 20, headcount_label: "inferred", revenue_band: null, vertical_depth: null,
  wl_signal: null, service_shape: "Core", economics: "pass", deal_size_estimate: null, hourly_rate_accepted: null,
  broker_character: null, referral_from_network: null, icp4_vertical_proven: null, recurring_revenue_share: null,
  niche_positioning: null, am_pm_separated: null, platform_partner_badge: null, peer_network_member: null,
  ai_posture: null, avg_project_size: null, already_outsources: null, owner_does_everything: null,
  inhouse_dev_team: null, dev_archetype: null, shrinking: null,
  money: "unknown", authority: "unknown", specification: "unknown", timing: null, timing_state: "unknown",
  archetype: null, serviceable_share: null, n_vendors: null, our_rank: null, trailing_12m_revenue: 0, quote_amount: null,
  stated_ceiling: null, climb_signals: [], signals: [], deals: [], prior_grades: [], ...o,
});
const fired = (g: ProspectScorecard) => g.fit.adjustments.filter((a) => a.fired).map((a) => a.id);

/* ------------------------------------------------------------------ *
 * 1 · rule assertions
 * ------------------------------------------------------------------ */

/* the `when` grammar */
eq("when: in-list with spaces", evalWhen("wl_signal in [Very High, High]", { wl_signal: "Very High" }), true);
eq("when: null field never fires", evalWhen("headcount >= 40 AND inhouse_dev_team == true", { headcount: null, inhouse_dev_team: true }), false);
eq("when: != null is the only test a null passes", evalWhen("headcount != null", { headcount: null }), false);
eq("when: parentheses ignored", evalWhen("(headcount != null AND headcount < 8) AND owner_does_everything == true", { headcount: 5, owner_does_everything: true }), true);
eq("when: dotted path", evalWhen("qualification.present_count >= 3", { qualification: { present_count: 3 } }), true);
eq("when: == false needs an explicit false", evalWhen("icp4_vertical_proven == false", { icp4_vertical_proven: null }), false);

/* fingerprint */
eq("fingerprint: FNV-1a of an empty string", fingerprint(""), fingerprint(""));
check("fingerprint: 8 hex chars", /^[0-9a-f]{8}$/.test(fingerprint(R)));
check("fingerprint: sensitive to a one-byte change", fingerprint({ a: 1 }) !== fingerprint({ a: 2 }));
eq("fingerprint: scorecard carries the rubric fingerprint", grade(base(), R).rubric_fingerprint, fingerprint(R));
eq("fingerprint: independent vector — FNV-1a over JSON.stringify(\"a\") = 61a1cfea (checked in Python)", fingerprint("a"), "61a1cfea");
// Key order must not matter: tests read the rubric from a file, pb-score reads it from a jsonb
// column, and jsonb does not keep object key order. The hash runs over canonical JSON.
{
  const keySorted = (v: unknown): unknown => Array.isArray(v) ? v.map(keySorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, keySorted((v as Record<string, unknown>)[k])])) : v;
  const keyReversed = (v: unknown): unknown => Array.isArray(v) ? v.map(keyReversed) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().reverse().map((k) => [k, keyReversed((v as Record<string, unknown>)[k])])) : v;
  check("fingerprint: the reversed-key rubric is a different byte string", JSON.stringify(keyReversed(R)) !== JSON.stringify(R));
  eq("fingerprint: independent of object key order (sorted)", fingerprint(keySorted(R)), fingerprint(R));
  eq("fingerprint: independent of object key order (reversed)", fingerprint(keyReversed(R)), fingerprint(R));
  eq("fingerprint: a jsonb-style round trip of the rubric scores with the same fingerprint", grade(base(), JSON.parse(JSON.stringify(keyReversed(R)))).rubric_fingerprint, grade(base(), R).rubric_fingerprint);
  eq("fingerprint: canonical JSON sorts keys recursively, keeps array order, drops undefined",
    canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }], "≥": "x", z: null, n: 0.5, u: undefined }),
    "{\"a\":[1,{\"c\":3,\"d\":2}],\"b\":1,\"n\":0.5,\"z\":null,\"≥\":\"x\"}");
  eq("fingerprint: independent vector over canonical JSON (FNV-1a in Python: ffddc74b)", fingerprint({ b: 1, a: [1, { d: 2, c: 3 }], "≥": "x", z: null, n: 0.5 }), "ffddc74b");
  check("fingerprint: array order still matters", fingerprint([1, 2]) !== fingerprint([2, 1]));
  check("fingerprint: a changed value still changes the hash", fingerprint(keySorted({ ...R, version: "0.1.1" })) !== fingerprint(R));
}

/* gates */
{
  const parked = grade(base({ service_shape: "Off" }), R);
  eq("gate: service_shape Off parks", parked.status, "Parked");
  eq("gate: parked row still has a computed tier (PRO-0)", parked.fit.computed_tier, "Gold");
  eq("gate: economics fail parks", grade(base({ economics: "fail" }), R).status, "Parked");
  const unknown = grade(base({ service_shape: null, economics: null }), R);
  eq("gate: unknown never parks", unknown.status, "Ranked");
  check("gate: unknown service shape flags", unknown.flags.includes("Service shape unknown"));
  check("gate: unknown economics flags", unknown.flags.includes("Economics unknown"));
  const gates = evaluateGates(base({ service_shape: null }), R);
  eq("gate: unknown result recorded", gates.find((g) => g.id === "service_shape")?.result, "unknown");
  eq("gate: order follows the rubric", gates.map((g) => g.id), R.gates.evaluation_order);
  const broker = grade(base({ broker_character: "flag" }), R);
  eq("gate: broker character flags, never parks (PRO-2r-a open)", broker.status, "Ranked");
  check("gate: broker character flag text", broker.flags.includes("Broker character flag"));
  eq("gate: geography is off and unknown", gates.find((g) => g.id === "geography")?.mode, "off");
  const derivedFail = grade(base({ economics: null, deal_size_estimate: R.gates.items.economics.floor_usd - 1 }), R);
  eq("gate: economics derived fail from a stated deal size below the floor", derivedFail.status, "Parked");
  const derivedPass = grade(base({ economics: null, deal_size_estimate: R.gates.items.economics.floor_usd }), R);
  eq("gate: deal size at the floor passes", derivedPass.gates.find((g) => g.id === "economics")?.result, "pass");
  eq("gate: hourly_rate_accepted false derives fail", grade(base({ economics: null, hourly_rate_accepted: false }), R).status, "Parked");
  eq("gate: absence derives nothing", grade(base({ economics: null }), R).gates.find((g) => g.id === "economics")?.result, "unknown");
  // toggling the mode in the rubric changes behaviour without a code change
  const strict = structuredClone(R);
  strict.gates.items.broker_character.mode = "park";
  eq("gate: mode is read from the rubric (broker → park)", grade(base({ broker_character: "flag" }), strict).status, "Parked");
  // any gate in mode flag flags on failure; the text is the item's `flag` or "<label> flag"
  const geoFlag = structuredClone(R);
  geoFlag.gates.items.geography.mode = "flag";
  const geoRow = { ...base(), geography_ok: false } as unknown as ProspectFeatures;
  const geo = grade(geoRow, geoFlag);
  eq("gate: a geography gate in mode flag stays Ranked", geo.status, "Ranked");
  check("gate: a geography gate in mode flag flags with '<label> flag'", geo.flags.includes("Geography flag"), geo.flags.join(" | "));
  check("gate: unknown geography never flags", !grade(base(), geoFlag).flags.includes("Geography flag"));
  geoFlag.gates.items.geography.flag = "Outside territory";
  check("gate: the rubric's own flag text wins over the label", grade(geoRow, geoFlag).flags.includes("Outside territory") && !grade(geoRow, geoFlag).flags.includes("Geography flag"));
  const renamed = structuredClone(R);
  renamed.gates.items.character = renamed.gates.items.broker_character;
  delete renamed.gates.items.broker_character;
  renamed.gates.evaluation_order = renamed.gates.evaluation_order.map((id: string) => (id === "broker_character" ? "character" : id));
  check("gate: the broker flag does not depend on the gate's id", grade(base({ broker_character: "flag" }), renamed).flags.includes("Broker character flag"));
}

/* ICP */
{
  const c = classifyIcp(base({ icp_class: null, is_agency: false }), R);
  eq("icp: is_agency false → ICP-6 (step 1)", [c.icp_class, c.step], ["ICP-6", 1]);
  eq("icp: consultancy → ICP-5", classifyIcp(base({ icp_class: null, agency_type: "consultancy" }), R).icp_class, "ICP-5");
  eq("icp: full_service 11+ and $5–10M → ICP-1", classifyIcp(base({ icp_class: null, agency_type: "full_service", headcount: 11, revenue_band: "5-10M" }), R).icp_class, "ICP-1");
  eq("icp: full_service 10 people → ICP-2", classifyIcp(base({ icp_class: null, agency_type: "full_service", headcount: 10, revenue_band: "5-10M" }), R).icp_class, "ICP-2");
  const tentative = classifyIcp(base({ icp_class: null, agency_type: "full_service", headcount: 30, revenue_band: null }), R);
  eq("icp: full_service with revenue unknown → ICP-2, tentative", [tentative.icp_class, tentative.firm], ["ICP-2", false]);
  eq("icp: boutique deep vertical → ICP-4", classifyIcp(base({ icp_class: null, agency_type: "boutique", vertical_depth: "deep_single_vertical" }), R).icp_class, "ICP-4");
  eq("icp: digital_only generalist → ICP-3", classifyIcp(base({ icp_class: null, agency_type: "digital_only", vertical_depth: "generalist" }), R).icp_class, "ICP-3");
  eq("icp: nothing known → none", classifyIcp(base({ icp_class: null, is_agency: null, agency_type: null }), R).derivation, "none");
  eq("icp: unclassified status", grade(base({ icp_class: null, is_agency: null, agency_type: null }), R).status, "Unclassified");
  eq("icp: unclassified has no tier and no cell", (() => { const g = grade(base({ icp_class: null, is_agency: null, agency_type: null }), R); return [g.effective_tier, g.cell]; })(), [null, null]);
  const stated = classifyIcp(base({ icp_class: "ICP-3", agency_type: "full_service", headcount: 30, revenue_band: "5-10M" }), R);
  eq("icp: stated wins over a firm derivation", [stated.icp_class, stated.derivation, stated.disagrees], ["ICP-3", "stated", true]);
  check("icp: disagreement flag", grade(base({ icp_class: "ICP-3", agency_type: "full_service", headcount: 30, revenue_band: "5-10M" }), R).flags.includes("ICP disagrees with derivation"));
  check("icp: a derivation that leaned on an unknown never disagrees", !grade(base({ icp_class: "ICP-1", agency_type: "full_service", headcount: 30, revenue_band: null }), R).flags.includes("ICP disagrees with derivation"));
  // base tier map, read from the rubric
  for (const [icp, tier] of Object.entries(R.dimension_b.base_tier_from_icp.map)) {
    eq(`icp: base tier ${icp} → ${tier}`, grade(base({ icp_class: icp as ProspectFeatures["icp_class"], relationship_type: icp === "ICP-6" ? "direct" : "agency" }), R).fit.base_tier, tier);
  }
  check("icp: Platinum is never a base", !Object.values(R.dimension_b.base_tier_from_icp.map).includes("Platinum"));
}

/* adjustments */
{
  const wl = grade(base({ icp_class: "ICP-3", agency_type: "boutique", headcount: 6, wl_signal: "High" }), R);
  eq("adj: ADJ-WL fires on ICP-3 + High", fired(wl), ["ADJ-WL"]);
  eq("adj: ADJ-WL lifts Bronze to Silver", wl.fit.adjusted_tier, "Silver");
  check("adj: ADJ-WL does not fire on ICP-2", !fired(grade(base({ wl_signal: "High" }), R)).includes("ADJ-WL"));
  const two = grade(base({ icp_class: "ICP-3", agency_type: "boutique", headcount: 6, wl_signal: "Very High", referral_from_network: true }), R);
  eq("adj: two positives both logged", fired(two), ["ADJ-WL", "ADJ-REF"]);
  eq("adj: net capped at +1", two.fit.net_adjustment, 1);
  eq("adj: capped tier is Silver, not Gold", two.fit.adjusted_tier, "Silver");
  const twoDown = grade(base({ headcount: 45, inhouse_dev_team: true, shrinking: true, dev_archetype: true }), R);
  eq("adj: three negatives capped at −1", twoDown.fit.net_adjustment, -1);
  eq("adj: Gold −1 → Silver", twoDown.fit.adjusted_tier, "Silver");
  const mixed = grade(base({ referral_from_network: true, shrinking: true }), R);
  eq("adj: +1 and −1 net to 0", mixed.fit.net_adjustment, 0);
  const goldPlus = grade(base({ referral_from_network: true, ai_posture: "positive" }), R);
  eq("adj: adjustments never reach Platinum", goldPlus.fit.adjusted_tier, "Gold");
  eq("adj: Bronze −1 stays Bronze", grade(base({ icp_class: "ICP-5", agency_type: "consultancy", headcount: 4, shrinking: true }), R).fit.adjusted_tier, "Bronze");
  eq("adj: ADJ-ICP4-UNPROVEN", grade(base({ icp_class: "ICP-4", agency_type: "niche_vertical", icp4_vertical_proven: false }), R).fit.adjusted_tier, "Silver");
  check("adj: ICP-4 with vertical unknown does not drop", !fired(grade(base({ icp_class: "ICP-4", agency_type: "niche_vertical", icp4_vertical_proven: null }), R)).includes("ADJ-ICP4-UNPROVEN"));
  eq("adj: ADJ-ICP3-FLOOR needs both facts", fired(grade(base({ icp_class: "ICP-3", agency_type: "boutique", avg_project_size: 12000, already_outsources: true }), R)), ["ADJ-ICP3-FLOOR"]);
  check("adj: ADJ-ICP3-FLOOR does not fire on $9,999", !fired(grade(base({ icp_class: "ICP-3", agency_type: "boutique", avg_project_size: 9999, already_outsources: true }), R)).includes("ADJ-ICP3-FLOOR"));
  eq("adj: ADJ-RECUR at exactly 0.25", fired(grade(base({ recurring_revenue_share: 0.25 }), R)), ["ADJ-RECUR"]);
  eq("adj: ADJ-TINY needs headcount < 8 and owner_does_everything", fired(grade(base({ headcount: 7, owner_does_everything: true }), R)), ["ADJ-TINY"]);
  check("adj: ADJ-TINY with headcount unknown never fires", !fired(grade(base({ headcount: null, owner_does_everything: true }), R)).includes("ADJ-TINY"));
  // direct-to-client rows skip agency-only rules but keep ADJ-REF and ADJ-AI
  const direct = grade(base({ relationship_type: "direct", icp_class: "ICP-6", is_agency: false, agency_type: "direct_end_client", headcount: 100, wl_signal: "High", niche_positioning: true, am_pm_separated: true, referral_from_network: true, ai_posture: "positive" }), R);
  eq("adj: direct row fires only the non-agency rules", fired(direct), ["ADJ-REF", "ADJ-AI"]);
  check("adj: direct row flagged", direct.flags.includes("Direct-to-client"));
  eq("adj: skipped rules are traced, not fired", direct.fit.adjustments.find((a) => a.id === "ADJ-NICHE")?.inputs._skipped !== undefined, true);
  const directByType = grade(base({ relationship_type: "direct", icp_class: "ICP-2", niche_positioning: true }), R);
  eq("adj: relationship_type direct alone skips agency-only rules", fired(directByType), []);
  check("adj: every fired rule has a basis", grade(base({ referral_from_network: true }), R).fit.adjustments.every((a) => ["ruled", "unruled_default", "reasoned"].includes(a.basis)));
  eq("adj: every rubric rule appears in the trace", grade(base(), R).fit.adjustments.map((a) => a.id), R.dimension_b.adjustments.rules.map((r: { id: string }) => r.id));
  // caps come from the rubric
  const wide = structuredClone(R);
  wide.dimension_b.adjustments.net_cap_up = 2;
  eq("adj: net cap read from rubric (cap 2 → Gold from Bronze)", grade(base({ icp_class: "ICP-3", agency_type: "boutique", headcount: 6, wl_signal: "Very High", referral_from_network: true }), wide).fit.adjusted_tier, "Gold");
}

/* qualification */
{
  const q = (o: Partial<ProspectFeatures>) => grade(base(o), R).qualification;
  eq("qual: 0 facts → Conversation", q({}).label, "Conversation");
  eq("qual: 1 fact → Conversation", q({ money: "present" }).label, "Conversation");
  eq("qual: 2 facts → Partly qualified", q({ money: "present", authority: "present" }).label, "Partly qualified");
  eq("qual: 3 facts → Partly qualified", q({ money: "present", authority: "present", specification: "present" }).label, "Partly qualified");
  eq("qual: 4 facts → Qualified", q({ money: "present", authority: "present", specification: "present", timing_state: "present", timing: "within_1_week" }).label, "Qualified");
  eq("qual: absent is not present", q({ money: "absent", authority: "absent", specification: "absent", timing_state: "absent" }).present_count, 0);
  eq("qual: a stated timing with unknown state counts as present", q({ timing: "within_1_month" }).facts.timing, "present");
  eq("qual: no_timeline is an absent date", q({ timing: "no_timeline" }).facts.timing, "absent");
  // min_facts_to_publish_tier is a rubric toggle (default 0)
  eq("qual: default publishes a tier on a Conversation row", grade(base(), R).effective_tier, "Gold");
  const strict = structuredClone(R);
  strict.dimension_a.min_facts_to_publish_tier = 2;
  const hidden = grade(base({ money: "present" }), strict);
  eq("qual: min_facts 2 hides the tier below 2 facts", hidden.effective_tier, null);
  check("qual: hidden tier flags Conversation only", hidden.flags.includes("Conversation only"));
  eq("qual: hidden tier keeps the computed tier in the trace", hidden.fit.computed_tier, "Gold");
  eq("qual: hidden tier has no cell", hidden.cell, null);
  eq("qual: min_facts 2 publishes at 2 facts", grade(base({ money: "present", authority: "present" }), strict).effective_tier, "Gold");
}

/* potential */
{
  const p = (o: Partial<ProspectFeatures>) => grade(base(o), R).potential;
  // wallet = 40 × 175,000 (blended) × 0.30 (High) × 0.5 (default serviceable) = 1,050,000; #1 of 2 → 2/3; headroom 700,000
  const big = p({ headcount: 40, archetype: "blended", wl_signal: "High", n_vendors: 2, our_rank: 1, climb_signals: ["2nd person engaged"] });
  eq("pot: wallet formula", big.wallet, 1_050_000);
  eq("pot: winnable share #1 of 2", big.winnable_share, 0.6667);
  eq("pot: winnable basis", big.winnable_basis, "wallet_allocation_rule");
  eq("pot: headroom", big.headroom, 700_000);
  eq("pot: headroom band", big.headroom_band, "≥ $100K");
  eq("pot: Partner ceiling with climb evidence", big.ceiling, "Partner");
  eq("pot: winnable #1 of 3", p({ n_vendors: 3, our_rank: 1 }).winnable_share, 0.5);
  eq("pot: winnable #2 of 3", p({ n_vendors: 3, our_rank: 2 }).winnable_share, 0.3333);
  eq("pot: winnable default when rank unknown", p({ n_vendors: 3, our_rank: null }).winnable_basis, "default");
  eq("pot: default archetype is blended", p({ archetype: null }).inputs.revenue_per_head, R.potential.revenue_per_head_usd.blended);
  eq("pot: production archetype", p({ archetype: "production" }).inputs.revenue_per_head, R.potential.revenue_per_head_usd.production);
  eq("pot: WL Low → 10%", p({ wl_signal: "Low" }).inputs.outsourceable_share, 0.1);
  eq("pot: WL unknown → default share", p({ wl_signal: null }).inputs.outsourceable_share, R.potential.outsourceable_share_by_wl.default);
  eq("pot: trailing revenue reduces headroom", p({ headcount: 40, wl_signal: "High", n_vendors: 2, our_rank: 1, trailing_12m_revenue: 100_000 }).headroom, 600_000);
  // climb cap
  const capped = p({ headcount: 40, wl_signal: "High", climb_signals: [] });
  eq("pot: ceiling proposed Partner", capped.ceiling_proposed, "Partner");
  eq("pot: capped to Project without climb evidence", capped.ceiling, "Project");
  eq("pot: capped reason", capped.ceiling_capped_reason, "no climb evidence");
  check("pot: capped flag", grade(base({ headcount: 40, wl_signal: "High" }), R).flags.includes("Ceiling capped: no climb evidence"));
  eq("pot: alias maps to a canonical climb signal", p({ climb_signals: ["multi_thread"] }).climb_evidence, ["2nd person engaged"]);
  eq("pot: unknown climb strings are not counted", p({ headcount: 40, wl_signal: "High", climb_signals: ["they seemed keen"] }).ceiling, "Project");
  eq("pot: Project ceiling needs no climb evidence", p({ headcount: 3, wl_signal: "Low" }).ceiling_capped_reason, null);
  // < $35K: 3 × 175,000 × 0.1 × 0.5 × 0.5 = 13,125
  eq("pot: small headroom band", p({ headcount: 3, wl_signal: "Low" }).headroom_band, "< $35K");
  // headroom unknown → stated ceiling
  const stated = p({ headcount: null, stated_ceiling: "Embedded", climb_signals: ["Referred someone"] });
  eq("pot: headroom null when headcount unknown", stated.headroom, null);
  eq("pot: stated ceiling stands in when headroom unknown", stated.ceiling, "Embedded");
  eq("pot: stated ceiling still needs climb evidence above Project", p({ headcount: null, stated_ceiling: "Partner" }).ceiling, "Project");
  eq("pot: headroom known → stated ceiling does not override", p({ headcount: 40, wl_signal: "High", stated_ceiling: "Project", climb_signals: ["Structural break"] }).ceiling, "Partner");
  eq("pot: nothing known → Project", p({ headcount: null }).ceiling, "Project");
  check("pot: headcount unknown flag", grade(base({ headcount: null }), R).flags.includes("Headcount unknown"));
  // year one
  eq("pot: year1 from quote", [p({ quote_amount: 52_000 }).year1_band, p({ quote_amount: 52_000 }).year1_basis], ["$46K–100K", "quote"]);
  eq("pot: year1 quote at a band edge", p({ quote_amount: 100_000 }).year1_band, "≥ $100K");
  eq("pot: year1 quote below $6K", p({ quote_amount: 5_000 }).year1_band, "< $6K");
  eq("pot: year1 icp prior when no quote", [p({}).year1_band, p({}).year1_basis], [R.potential.year1_icp_prior_band.map["ICP-2"], "icp_prior"]);
  eq("pot: year1 unknown when no ICP", grade(base({ icp_class: null, is_agency: null, agency_type: null }), R).potential.year1_basis, "unknown");
  eq("pot: a zero quote is not a quote", p({ quote_amount: 0 }).year1_basis, "icp_prior");
  // confidence
  eq("pot: confidence High", p({ headcount: 20, headcount_label: "evidence", wl_signal: "High" }).confidence, "High");
  eq("pot: confidence Medium (inferred)", p({ headcount: 20, headcount_label: "inferred", wl_signal: "High" }).confidence, "Medium");
  eq("pot: confidence Medium (stated ceiling, no headcount)", p({ headcount: null, stated_ceiling: "Embedded" }).confidence, "Medium");
  eq("pot: confidence Low", p({ headcount: null, stated_ceiling: null }).confidence, "Low");
  eq("pot: evidence label without a headcount is not High", p({ headcount: null, headcount_label: "evidence", wl_signal: "High" }).confidence, "Low");
  eq("pot: bands are [min, max)", [pickBand(35_000, R.potential.headroom_bands), pickBand(34_999.99, R.potential.headroom_bands)], ["$35K–100K", "< $35K"]);
}

/* platinum rule and fit confidence */
{
  const plat = base({ icp_class: "ICP-1", icp_class_label: "evidence", headcount: 40, headcount_label: "evidence", wl_signal: "High", n_vendors: 2, our_rank: 1, climb_signals: ["2nd person engaged"], money: "present", authority: "present", specification: "present", timing: "within_1_month", timing_state: "present" });
  const g = grade(plat, R);
  eq("plat: all three met → Platinum", g.fit.computed_tier, "Platinum");
  eq("plat: met flag", g.fit.platinum_rule.met, true);
  eq("plat: 3 of 4 facts is enough", grade({ ...plat, timing: null, timing_state: "unknown" }, R).fit.computed_tier, "Platinum");
  eq("plat: 2 of 4 facts is not", grade({ ...plat, timing: null, timing_state: "unknown", specification: "unknown" }, R).fit.computed_tier, "Gold");
  eq("plat: no climb evidence → ceiling capped → Gold", grade({ ...plat, climb_signals: [] }, R).fit.computed_tier, "Gold");
  eq("plat: Silver never reaches Platinum", grade({ ...plat, icp_class: "ICP-6", relationship_type: "direct" }, R).fit.computed_tier, "Silver");
  check("plat: unmet reasons are listed", grade({ ...plat, climb_signals: [] }, R).fit.platinum_rule.reasons.length === 1);
  eq("plat: cell", g.cell, "Platinum × Partner");
  eq("conf: High needs evidence label and 3 facts", g.fit.confidence, "High");
  eq("conf: inferred label → Medium", grade({ ...plat, icp_class_label: "inferred" }, R).fit.confidence, "Medium");
  eq("conf: no facts → Low", grade(base(), R).fit.confidence, "Low");
  eq("conf: derived ICP counts as inferred", grade(base({ icp_class: null, money: "present" }), R).fit.confidence, "Medium");
  eq("conf: unclassified has no confidence", grade(base({ icp_class: null, is_agency: null, agency_type: null }), R).fit.confidence, null);
}

/* signals: decay, urgency, routing */
{
  const d = decaySignals([sig("quote_sent", 15)], AS_OF, R);
  eq("decay: linear — 8 × (1 − 15/30) = 4", d.total, 4);
  eq("decay: expired decaying signal is 0", decaySignals([sig("quote_sent", 30)], AS_OF, R).total, 0);
  eq("decay: same-day signal is full weight", decaySignals([sig("quote_sent", 0)], AS_OF, R).total, 8);
  eq("decay: non-decaying negative counts in full until lifespan", decaySignals([sig("neg_champion_left", 89)], AS_OF, R).total, -8);
  eq("decay: non-decaying negative drops to 0 after lifespan", decaySignals([sig("neg_champion_left", 91)], AS_OF, R).total, 0);
  eq("decay: lifespan null never expires", decaySignals([sig("prior_grade", 1000, { weight: 3 })], AS_OF, R).total, 3);
  eq("decay: negatives are traced", decaySignals([sig("neg_champion_left", 91)], AS_OF, R).negatives.map((n) => n.weight_now), [0]);
  eq("decay: top excludes negatives and expired", decaySignals([sig("neg_champion_left", 10), sig("quote_sent", 40), sig("inbound_reply", 2)], AS_OF, R).top.map((t) => t.type), ["inbound_reply"]);
  eq("decay: future-dated signal has age 0", decaySignals([sig("quote_sent", -3)], AS_OF, R).total, 8);
  // an unparseable observed_at is unknown, and unknown is not evidence: it counts for nothing
  const garbage = decaySignals([sig("quote_requested", 0, { observed_at: "not a date" })], AS_OF, R);
  eq("decay: unparseable observed_at counts for nothing", [garbage.total, garbage.top.length, garbage.has_live], [0, 0, false]);
  eq("decay: unparseable observed_at has an unknown age", garbage.traces[0].age_days as unknown, null);
  check("decay: unparseable observed_at is noted", garbage.notes.some((n) => n.includes("not a date") && n.includes("not counted")), garbage.notes.join(" | "));
  eq("decay: unparseable observed_at never routes", routeTasks([sig("quote_requested", 0, { observed_at: "garbage" })], AS_OF, R), []);
  const gg = grade(base({ signals: [sig("quote_requested", 0, { observed_at: "garbage" })] }), R);
  check("decay: engine trace carries the not-counted note", gg.trace.notes.some((n) => n.includes("not counted")));
  eq("decay: a garbage-only signal set is Cold with basis none", [gg.signals.urgency, gg.signals.urgency_basis, gg.signals.tasks.length], ["Cold", "none", 0]);
  // top_n is the rubric's or nothing: with no key every live positive signal is listed
  const six = ["referral_warm_intro", "quote_sent", "inbound_reply", "meeting_accepted", "cluster_hiring", "manual_note"].map((t) => sig(t, 1));
  const noTop = structuredClone(R);
  delete noTop.signals.top_n;
  eq("decay: without signals.top_n every live positive signal is listed", decaySignals(six, AS_OF, noTop).top.length, 6);
  const topTwo = structuredClone(R);
  topTwo.signals.top_n = 2;
  eq("decay: signals.top_n caps the list", decaySignals(six, AS_OF, topTwo).top.map((t) => t.type), ["referral_warm_intro", "quote_sent"]);
  // urgency
  eq("urg: stated timing wins", computeUrgency("within_1_week", { total: 0, has_live: false }, R), { urgency: "Super Hot", basis: "stated_timing" });
  eq("urg: ladder Hot at 8", computeUrgency(null, { total: 8, has_live: true }, R), { urgency: "Hot", basis: "computed" });
  eq("urg: ladder Warm at 3", computeUrgency(null, { total: 3, has_live: true }, R).urgency, "Warm");
  eq("urg: ladder Super Hot at 15", computeUrgency(null, { total: 15, has_live: true }, R).urgency, "Super Hot");
  eq("urg: ladder Cold below 3, basis computed", computeUrgency(null, { total: 2.9, has_live: true }, R), { urgency: "Cold", basis: "computed" });
  eq("urg: no live signal → Cold / none", computeUrgency(null, { total: 0, has_live: false }, R), { urgency: "Cold", basis: "none" });
  eq("urg: stated no_timeline → Cold stated", computeUrgency("no_timeline", { total: 20, has_live: true }, R), { urgency: "Cold", basis: "stated_timing" });
  const g = grade(base({ timing: "within_1_week", timing_state: "present", signals: [sig("manual_note", 80)] }), R);
  eq("urg: engine honours stated timing over a cold computed score", [g.signals.urgency, g.signals.urgency_basis], ["Super Hot", "stated_timing"]);
  // routing
  const t1 = routeTasks([sig("quote_requested", 2)], AS_OF, R);
  eq("route: one strong signal → one task with its catalog SLA", [t1.length, t1[0].sla_hours], [1, 8]);
  eq("route: due from observed_at", t1[0].due_by, new Date(Date.parse(daysAgo(2)) + 8 * 3_600_000).toISOString());
  eq("route: strong signal without catalog SLA uses the default", routeTasks([sig("quote_sent", 2)], AS_OF, R)[0].sla_hours, R.signals.routing.default_sla_hours);
  eq("route: one medium signal is a note, not a task", routeTasks([sig("cluster_hiring", 2)], AS_OF, R).length, 0);
  eq("route: two medium signals → one task", routeTasks([sig("cluster_hiring", 2), sig("leadership_change", 9)], AS_OF, R).length, 1);
  eq("route: outside the window nothing routes", routeTasks([sig("referral_warm_intro", 31)], AS_OF, R).length, 0);
  eq("route: negatives never route", routeTasks([sig("neg_champion_left", 1)], AS_OF, R).length, 0);
  eq("route: weak signals never route", routeTasks([sig("review_award_relaunch", 1), sig("manual_note", 1)], AS_OF, R).length, 0);
  check("route: PA signed raises its catalog flag", grade(base({ signals: [sig("orbit_pa_signed", 10)] }), R).flags.includes("PA signed — promotion pending (PRO-18)"));
  check("route: expired PA signed does not flag", !grade(base({ signals: [sig("orbit_pa_signed", 61)] }), R).flags.includes("PA signed — promotion pending (PRO-18)"));
}

/* deal health */
{
  const deal = (o: Partial<DealHealthInput> = {}): DealHealthInput => ({
    deal_id: "d", title: "Site build", stage_name: "Proposal", stage_entered_at: daysAgo(5), stage_median_days: null, close_date: "2026-10-01",
    close_date_pushes: 0, largest_push_days: null, last_buyer_touch_at: daysAgo(2), buyer_email_velocity_7d: 3, next_meeting_at: "2026-09-12T15:00:00Z",
    decision_maker_engaged: true, buyer_contacts_30d: 2, price_discussed: true, calls_held: 2, critical_event_captured: true, indecision_level: "low" as const, risk_words_present: false, competitor_named_late: false, ...o,
  });
  const dh = (o: Partial<DealHealthInput>) => dealHealth([deal(o)], AS_OF, R)[0];
  // "no next meeting" is a KNOWN state (has_next_meeting false); a null date alone is unknown
  const noMeeting = { next_meeting_at: null, has_next_meeting: false };
  eq("deal: healthy is green", dh({}).color, "green");
  eq("deal: three pushes → red DH-PUSHES", dh({ close_date_pushes: 3 }).warnings.map((w) => w.id), ["DH-PUSHES"]);
  eq("deal: one big push → red", dh({ close_date_pushes: 1, largest_push_days: 22 }).color, "red");
  eq("deal: one small push → yellow DH-PUSHED", dh({ close_date_pushes: 1 }).warnings.map((w) => w.id), ["DH-PUSHED"]);
  eq("deal: dark 21 days with no meeting → red", dh({ last_buyer_touch_at: daysAgo(21), ...noMeeting }).warnings.map((w) => w.id), ["DH-DARK", "DH-NO-NEXT"]);
  eq("deal: dark 21 days with a meeting is not dark", dh({ last_buyer_touch_at: daysAgo(21) }).color, "green");
  eq("deal: quiet 14–20 → yellow", dh({ last_buyer_touch_at: daysAgo(14) }).warnings.map((w) => w.id), ["DH-QUIET"]);
  eq("deal: stalled > 2× default median (21)", dh({ stage_entered_at: daysAgo(43) }).warnings.map((w) => w.id), ["DH-STALLED"]);
  eq("deal: 42 days is not > 2 × 21", dh({ stage_entered_at: daysAgo(42) }).color, "green");
  eq("deal: own stage median overrides the default", dh({ stage_entered_at: daysAgo(15), stage_median_days: 7 }).color, "red");
  eq("deal: no DM after two calls → red", dh({ decision_maker_engaged: false }).warnings[0].id, "DH-NO-DM");
  eq("deal: high indecision → red", dh({ indecision_level: "high" }).warnings[0].id, "DH-INDECISION");
  eq("deal: risk words with no next step → red", dh({ risk_words_present: true, ...noMeeting }).color, "red");
  eq("deal: no price by call two → yellow", dh({ price_discussed: false }).warnings.map((w) => w.id), ["DH-NO-PRICE"]);
  eq("deal: thin buyer side → yellow", dh({ buyer_contacts_30d: 1 }).warnings.map((w) => w.id), ["DH-THIN"]);
  eq("deal: zero email velocity → yellow", dh({ buyer_email_velocity_7d: 0 }).warnings.map((w) => w.id), ["DH-VELOCITY"]);
  eq("deal: no critical event → yellow", dh({ critical_event_captured: false }).warnings.map((w) => w.id), ["DH-NO-CRITICAL"]);
  // unknown never warns
  eq("deal: unknown touch date never warns", dh({ last_buyer_touch_at: null }).color, "green");
  eq("deal: unknown stage entry never warns", dh({ stage_entered_at: null }).color, "green");
  eq("deal: unknown contacts/velocity/price never warn", dh({ buyer_contacts_30d: null, buyer_email_velocity_7d: null, price_discussed: null, critical_event_captured: null, decision_maker_engaged: null, indecision_level: null, risk_words_present: null }).color, "green");
  eq("deal: no deals → empty array", grade(base(), R).deal_health, []);
  check("deal: reason omits deals when there are none", !grade(base(), R).reason.includes("open deal"));
  check("deal: reason carries the worst deal", grade(base({ deals: [deal({ close_date_pushes: 3 })] }), R).reason.includes("worst red"));

  // unknown_never_warns for the next meeting: the ingest maps a missing Pipedrive activity to
  // null, so null alone is UNKNOWN; only has_next_meeting === false is "known not booked".
  const nullDeal: DealHealthInput = { deal_id: "d1", close_date_pushes: 0 };
  eq("deal: a deal with nothing known is green", dealHealth([nullDeal], AS_OF, R)[0], { deal_id: "d1", title: null, color: "green", warnings: [] });
  eq("deal: every optional field explicitly null is green", dh({
    stage_entered_at: null, last_buyer_touch_at: null, largest_push_days: null, buyer_email_velocity_7d: null, next_meeting_at: null, decision_maker_engaged: null,
    buyer_contacts_30d: null, price_discussed: null, calls_held: null, critical_event_captured: null, indecision_level: null, risk_words_present: null, competitor_named_late: null,
  }).color, "green");
  eq("deal: next meeting unknown → DH-NO-NEXT does not fire", dh({ next_meeting_at: null }).warnings.map((w) => w.id), []);
  eq("deal: known no next meeting → yellow DH-NO-NEXT", dh(noMeeting).warnings.map((w) => w.id), ["DH-NO-NEXT"]);
  eq("deal: dark 21 days with the next meeting unknown is not DH-DARK", dh({ last_buyer_touch_at: daysAgo(21), next_meeting_at: null }).color, "green");
  eq("deal: risk words with the next meeting unknown is not DH-INDECISION", dh({ risk_words_present: true, next_meeting_at: null }).color, "green");
  eq("deal: a booked meeting date wins over has_next_meeting false", dh({ next_meeting_at: "2026-09-12T15:00:00Z", has_next_meeting: false }).color, "green");
  eq("deal: has_next_meeting true with no date counts as booked", dh({ next_meeting_at: null, has_next_meeting: true }).color, "green");
  check("deal: the reason for an unknown-only deal carries no warning text", grade(base({ deals: [nullDeal] }), R).reason.endsWith("1 open deal, worst green."));
  eq("deal: unparseable touch date never warns", dh({ last_buyer_touch_at: "not a date" }).color, "green");

  // thresholds come from the rubric: structured `params` when a rule carries them, else the
  // numbers in the rule's own `test` prose — editing the JSON moves the behaviour either way
  const dhWith = (rubric: Rubric, o: Partial<DealHealthInput>, notes?: string[]) => dealHealth([deal(o)], AS_OF, rubric, notes)[0];
  const ruleOf = (rubric: Rubric, id: string) => [...rubric.deal_health.red_when_any, ...rubric.deal_health.yellow_when_any].find((r: { id: string }) => r.id === id);
  const dark21 = { last_buyer_touch_at: daysAgo(21), ...noMeeting };
  {
    const wider = structuredClone(R);
    ruleOf(wider, "DH-DARK").params = { min_days_dark: 28 };
    ruleOf(wider, "DH-QUIET").params = { min_days: 21, max_days: 27 };
    eq("deal: params in the rubric move DH-DARK (21 days is quiet, not dark, at min 28)", dhWith(wider, dark21).warnings.map((w) => w.id), ["DH-QUIET", "DH-NO-NEXT"]);
    eq("deal: params in the rubric move DH-DARK (28 days is dark)", dhWith(wider, { ...dark21, last_buyer_touch_at: daysAgo(28) }).warnings.map((w) => w.id), ["DH-DARK", "DH-NO-NEXT"]);
    check("deal: the edited rubric has a different fingerprint", fingerprint(wider) !== fingerprint(R));
    const prose = structuredClone(R);
    ruleOf(prose, "DH-DARK").test = "days since last buyer-initiated touch >= 28 AND no next meeting booked";
    ruleOf(prose, "DH-QUIET").test = "days since last buyer-initiated touch between 21 and 27";
    eq("deal: editing the prose test alone moves the threshold too", dhWith(prose, dark21).warnings.map((w) => w.id), ["DH-QUIET", "DH-NO-NEXT"]);
    const pushes = structuredClone(R);
    ruleOf(pushes, "DH-PUSHES").params = { min_pushes: 5, max_push_days: 40 };
    eq("deal: DH-PUSHES params (min 5 pushes, 40 days) → three pushes and a 22-day push are no longer red", dhWith(pushes, { close_date_pushes: 3, largest_push_days: 22 }).color, "green");
    const stalled = structuredClone(R);
    ruleOf(stalled, "DH-STALLED").params = { median_multiple: 3 };
    eq("deal: DH-STALLED median_multiple 3 → 43 days is not > 63", dhWith(stalled, { stage_entered_at: daysAgo(43) }).color, "green");
    const thin = structuredClone(R);
    ruleOf(thin, "DH-THIN").params = { min_contacts: 3 };
    eq("deal: DH-THIN min_contacts 3 → two contacts is thin", dhWith(thin, {}).warnings.map((w) => w.id), ["DH-THIN"]);
    const calls = structuredClone(R);
    ruleOf(calls, "DH-NO-PRICE").params = { min_calls: 3 };
    eq("deal: DH-NO-PRICE min_calls 3 → no price by call two is not yet a warning", dhWith(calls, { price_discussed: false }).color, "green");
    const velocity = structuredClone(R);
    ruleOf(velocity, "DH-VELOCITY").params = { max_emails: 1 };
    eq("deal: DH-VELOCITY max_emails 1 → one email this week is a warning", dhWith(velocity, { buyer_email_velocity_7d: 1 }).warnings.map((w) => w.id), ["DH-VELOCITY"]);
    // a rule whose threshold cannot be found is not evaluated, and the trace says so
    const broken = structuredClone(R);
    ruleOf(broken, "DH-DARK").test = "buyer has gone dark with nothing scheduled";
    const notes: string[] = [];
    eq("deal: unfindable threshold → rule not evaluated", dhWith(broken, dark21, notes).warnings.map((w) => w.id), ["DH-NO-NEXT"]);
    check("deal: unfindable threshold is noted", notes.some((n) => n.includes("DH-DARK") && n.includes("min_days_dark") && n.includes("not evaluated")), notes.join(" | "));
    const used: string[] = [];
    dhWith(R, {}, used);
    check("deal: the thresholds used are in the notes with their source", used.some((n) => n.startsWith("Deal-health thresholds from the rubric") && n.includes("DH-DARK min_days_dark=21 (test)") && n.includes("DH-PUSHES min_pushes=3, max_push_days=21 (test)")), used.join(" | "));
    check("deal: engine trace carries the deal-health thresholds", grade(base({ deals: [deal()] }), R).trace.notes.some((n) => n.startsWith("Deal-health thresholds from the rubric")));
    check("deal: no deals → no deal-health notes", !grade(base(), R).trace.notes.some((n) => n.startsWith("Deal-health")));
    for (const r of [...R.deal_health.red_when_any, ...R.deal_health.yellow_when_any]) {
      check(`deal: ${r.id} is evaluable under the shipped rubric`, !used.some((n) => n.includes(`Deal-health rule ${r.id}`)));
    }
    const unknownRule = structuredClone(R);
    unknownRule.deal_health.yellow_when_any.push({ id: "DH-NEW", test: "x > 1", message: "new" });
    const skipped: string[] = [];
    eq("deal: a rule id with no evaluator is skipped", dhWith(unknownRule, {}, skipped).color, "green");
    check("deal: a rule id with no evaluator is noted", skipped.some((n) => n.includes("DH-NEW") && n.includes("no evaluator")), skipped.join(" | "));
    const noMedian = structuredClone(R);
    delete noMedian.deal_health.default_stage_median_days;
    eq("deal: no default median in the rubric → DH-STALLED not evaluated", dhWith(noMedian, { stage_entered_at: daysAgo(400) }).color, "green");
    eq("deal: a deal's own stage median still works without a rubric default", dhWith(noMedian, { stage_entered_at: daysAgo(15), stage_median_days: 7 }).color, "red");
  }
}

/* override */
{
  const ov = (tier: Tier, extra: Record<string, unknown> = {}) => ({ override: { tier, reason_code: "data_wrong" as const, reason: "test", approver: "owner@example.test", expires_at: "2026-12-01", ...extra } });
  const gold = base({ money: "present" }); // computed Gold
  const within = grade(gold, R, ov("Silver"));
  eq("ovr: within cap → Overridden", within.status, "Overridden");
  eq("ovr: effective tier is the override", within.effective_tier, "Silver");
  eq("ovr: computed tier preserved", within.fit.computed_tier, "Gold");
  eq("ovr: cell follows the override", within.cell, "Silver × Project");
  eq("ovr: override recorded", within.override?.tier, "Silver");
  const beyond = grade(gold, R, ov("Bronze"));
  eq("ovr: beyond cap → Ranked", beyond.status, "Ranked");
  eq("ovr: beyond cap keeps the computed tier", beyond.effective_tier, "Gold");
  check("ovr: beyond cap flag", beyond.flags.includes("Override refused: beyond one-tier cap"));
  eq("ovr: refused override is not recorded", beyond.override, null);
  eq("ovr: same tier is within cap", grade(gold, R, ov("Gold")).status, "Overridden");
  eq("ovr: up one to Platinum is allowed", grade(gold, R, ov("Platinum")).effective_tier, "Platinum");
  eq("ovr: missing approver → ignored", grade(gold, R, ov("Silver", { approver: "" })).status, "Ranked");
  eq("ovr: missing reason code → ignored", grade(gold, R, { override: { tier: "Silver", reason: "x", approver: "owner@example.test" } as never }).status, "Ranked");
  eq("ovr: expired override → ignored", grade(gold, R, ov("Silver", { expires_at: "2026-09-01" })).status, "Ranked");
  eq("ovr: parked beats overridden", grade(base({ service_shape: "Off" }), R, ov("Silver")).status, "Parked");
  eq("ovr: unclassified has nothing to override", grade(base({ icp_class: null, is_agency: null, agency_type: null }), R, ov("Silver")).status, "Unclassified");

  // July (ruled): "one grade max, written reason required" — quoted in rubric.override.ruling
  const noReason = grade(gold, R, ov("Silver", { reason: "" }));
  eq("ovr: missing written reason → ignored", noReason.status, "Ranked");
  eq("ovr: missing written reason keeps the computed tier", noReason.effective_tier, "Gold");
  eq("ovr: refused-for-reason override is not recorded", noReason.override, null);
  check("ovr: missing written reason is noted with the ruling", noReason.trace.notes.some((n) => n.includes("written reason is required") && n.includes("July")), noReason.trace.notes.join(" | "));
  eq("ovr: whitespace is not a written reason", grade(gold, R, ov("Silver", { reason: "   " })).status, "Ranked");
  eq("ovr: undefined reason → ignored", grade(gold, R, ov("Silver", { reason: undefined })).status, "Ranked");
  const lax = structuredClone(R);
  lax.override.written_reason_required = false;
  eq("ovr: written_reason_required false in the rubric lets a reasonless override apply", grade(gold, lax, ov("Silver", { reason: "" })).status, "Overridden");

  // "expires soon" is rubric.override.expires_soon_days and nothing else
  const soon = structuredClone(R);
  soon.override.expires_soon_days = 14;
  check("ovr: expiring within the rubric window flags", grade(gold, soon, ov("Silver", { expires_at: "2026-09-20" })).flags.includes("Override expires soon"));
  check("ovr: expiring on the window's last day flags", grade(gold, soon, ov("Silver", { expires_at: "2026-09-23" })).flags.includes("Override expires soon"));
  check("ovr: expiring a day beyond the window does not flag", !grade(gold, soon, ov("Silver", { expires_at: "2026-09-24" })).flags.includes("Override expires soon"));
  check("ovr: expiring later does not flag", !grade(gold, soon, ov("Silver", { expires_at: "2026-12-01" })).flags.includes("Override expires soon"));
  soon.override.expires_soon_days = 30;
  check("ovr: the window moves with the rubric", grade(gold, soon, ov("Silver", { expires_at: "2026-10-01" })).flags.includes("Override expires soon"));
  const noWindow = grade(gold, R, ov("Silver", { expires_at: "2026-09-10" }));
  check("ovr: without expires_soon_days in the rubric nothing flags and the trace says why", !noWindow.flags.includes("Override expires soon") && noWindow.trace.notes.some((n) => n.includes("expires_soon_days is not set")), noWindow.trace.notes.join(" | "));

  // rubric.override.expiry_default_days applies when expires_at is absent
  const old = grade(gold, R, ov("Silver", { expires_at: undefined, set_at: "2026-01-01" }));
  eq("ovr: set_at + expiry_default_days in the past → expired, computed tier stands", [old.status, old.effective_tier], ["Ranked", "Gold"]);
  check("ovr: the derived expiry is noted", old.trace.notes.some((n) => n.includes("Override expired") && n.includes(`set_at 2026-01-01 + ${R.override.expiry_default_days} days`)), old.trace.notes.join(" | "));
  const live = grade(gold, R, ov("Silver", { expires_at: undefined, set_at: "2026-09-01" }));
  eq("ovr: set_at + expiry_default_days still ahead → applied", live.status, "Overridden");
  eq("ovr: the applied override carries the derived expiry", live.override?.expires_at, new Date(Date.parse("2026-09-01") + R.override.expiry_default_days * 86_400_000).toISOString());
  check("ovr: derivation is noted", live.trace.notes.some((n) => n.startsWith("Override expiry derived")));
  eq("ovr: exactly expiry_default_days old is not yet expired", grade(gold, R, ov("Silver", { expires_at: undefined, set_at: daysAgo(R.override.expiry_default_days).slice(0, 10) })).status, "Overridden");
  const shorter = structuredClone(R);
  shorter.override.expiry_default_days = 5;
  eq("ovr: expiry_default_days is read from the rubric", grade(gold, shorter, ov("Silver", { expires_at: undefined, set_at: "2026-09-01" })).status, "Ranked");
  const none = grade(gold, R, ov("Silver", { expires_at: undefined, set_at: undefined }));
  eq("ovr: no expires_at and no set_at → applied and noted as having no expiry", [none.status, none.trace.notes.some((n) => n.includes("Override has no expiry"))], ["Overridden", true]);
  const bad = grade(gold, R, ov("Silver", { expires_at: "someday" }));
  eq("ovr: unparseable expires_at → applied as no expiry, noted", [bad.status, bad.trace.notes.some((n) => n.includes("'someday' is not a date"))], ["Overridden", true]);
  eq("ovr: a stated expires_at is kept as given", grade(gold, R, ov("Silver", { set_at: "2026-09-01", expires_at: "2026-12-01" })).override?.expires_at, "2026-12-01");
}

/* flags, status precedence, chase key */
{
  const g = grade(base({ lineage: "lapsed_client", roster_source: "client_book_lapsed", roster_certified: false, prior_grades: [{ source: "tier1_book", value: "Platinum" }, { source: "gotham", value: "A" }] }), R);
  check("flag: lapsed client", g.flags.includes("Lapsed client"));
  check("flag: roster uncertified", g.flags.includes("Roster source uncertified"));
  check("flag: prior grade differs on a tier word", g.flags.includes("Prior grade differs"));
  check("flag: non-tier prior values are ignored", !grade(base({ prior_grades: [{ source: "gotham", value: "A" }] }), R).flags.includes("Prior grade differs"));
  check("flag: matching prior grade does not flag", !grade(base({ prior_grades: [{ source: "x", value: "Gold" }] }), R).flags.includes("Prior grade differs"));
  check("flag: UNVALIDATED stamp on every row", grade(base(), R).flags.includes("UNVALIDATED (PRO-8)"));
  eq("flag: validation from the rubric", grade(base(), R).validation, R.validation.status);
  eq("flag: anticipated is always true", grade(base(), R).anticipated, true);
  eq("flag: sorted", g.flags, [...g.flags].sort());
  eq("flag: deduplicated", new Set(g.flags).size, g.flags.length);
  const vocab: string[] = [...R.flags.vocabulary, "Override refused: beyond one-tier cap"];
  for (const fx of FIXTURES) {
    const out = grade(fx.features, R, (fx.options ?? {}) as never);
    for (const fl of out.flags) check(`flag: '${fl}' is in the rubric vocabulary (${fx.id})`, vocab.includes(fl), fl);
  }
  // status precedence
  eq("status: Parked beats Unclassified", grade(base({ service_shape: "Off", icp_class: null, is_agency: null, agency_type: null }), R).status, "Parked");
  // chase key: ascending sort puts the best first
  const best = grade(base({ icp_class: "ICP-1", icp_class_label: "evidence", headcount: 40, wl_signal: "High", n_vendors: 2, our_rank: 1, climb_signals: ["2nd person engaged"], money: "present", authority: "present", specification: "present", timing: "within_1_week", timing_state: "present", quote_amount: 120_000 }), R);
  const mid = grade(base({ money: "present", authority: "present", name: "Mid Agency" }), R);
  const low = grade(base({ icp_class: "ICP-3", agency_type: "boutique", headcount: 4, name: "Low Agency" }), R);
  const none = grade(base({ icp_class: null, is_agency: null, agency_type: null, name: "Nobody" }), R);
  const keys = [none, low, mid, best].map((x) => x.chase_rank_key);
  const sorted = [...keys].sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
  });
  eq("chase: ascending sort puts Platinum → Gold → Bronze → no tier", sorted.map((k) => k[4]), [best.name, mid.name, low.name, none.name]);
  eq("chase: key shape", best.chase_rank_key, [-3, -4, -3, -4, best.name]);
  eq("chase: unknown year-1 band sorts last", none.chase_rank_key[3], 1);
  const a = grade(base({ name: "Alpha", money: "present" }), R).chase_rank_key;
  const b = grade(base({ name: "Beta", money: "present", timing: "within_1_week", timing_state: "present" }), R).chase_rank_key;
  check("chase: same tier, more facts / hotter first", b[1] < a[1] && b[2] < a[2]);
}

/* reason sentence */
{
  const g = grade(base({ headcount: 40, wl_signal: "High", climb_signals: ["2nd person engaged"], money: "present", authority: "present", signals: [sig("quote_sent", 3)] }), R);
  check("reason: starts with Anticipated <tier>", /^Anticipated Gold \(/.test(g.reason));
  check("reason: names the ICP", g.reason.includes("ICP-2"));
  check("reason: names the qualification label", g.reason.includes("Partly qualified"));
  check("reason: names the ceiling and headroom band", g.reason.includes("ceiling Partner on ≥ $100K"));
  check("reason: names the year-1 band", g.reason.includes("year one likely $16K–46K"));
  check("reason: names urgency and the top signal label (8 × (1 − 3/30) = 7.2 → Warm)", g.reason.includes("Warm — Quote sent"));
  check("reason: no bare decayed total", !g.reason.includes(String(g.signals.decayed_total)));
  check("reason: no bare headroom dollars", !g.reason.includes(String(g.potential.headroom)));
  check("reason: 'no live signal' when nothing is live", grade(base(), R).reason.endsWith("no live signal."));
  check("reason: parked prefix", grade(base({ service_shape: "Off" }), R).reason.startsWith("Parked on Service shape"));
  check("reason: unknown headroom words", grade(base({ headcount: null }), R).reason.includes("on unknown headroom"));
  const shaped = structuredClone(R);
  shaped.reason_sentence.shape = "{tier}/{urgency}";
  eq("reason: shape is read from the rubric", buildReason({
    status: "Ranked", effective_tier: "Gold", confidence: "Low", icp_class: "ICP-2", agency_type: null, relationship_type: null,
    qualification: { label: "Conversation", present_count: 0 }, ceiling: "Project", headroom_band: null, year1_band: "unknown", urgency: "Cold",
    top_signal: null, deal_health: [], parked_on: null, override_reason_code: null,
  }, shaped), "Gold/Cold");
}

/* trace */
{
  const g = grade(base({ icp_class: "ICP-3", agency_type: "boutique", headcount: 6, wl_signal: "Very High", referral_from_network: true }), R);
  check("trace: tier reasoning names the base", g.trace.tier_reasoning.includes("base Bronze"));
  check("trace: tier reasoning names fired rules", g.trace.tier_reasoning.includes("ADJ-WL +1, ADJ-REF +1"));
  check("trace: tier reasoning shows the cap", g.trace.tier_reasoning.includes("raw +2, capped"));
  check("trace: cap note", g.trace.notes.some((n) => n.includes("capped to +1")));
  check("trace: headroom audit lives in the notes", g.trace.notes.some((n) => n.startsWith("Headroom audit")));
  check("trace: every gate has a basis", g.gates.every((x) => ["ruled", "unruled_default", "reasoned"].includes(x.basis)));
}

/* ------------------------------------------------------------------ *
 * 2 · golden replay
 * ------------------------------------------------------------------ */

const slim = (g: ProspectScorecard) => ({
  status: g.status,
  effective_tier: g.effective_tier,
  computed_tier: g.fit.computed_tier,
  cell: g.cell,
  qualification: g.qualification.label,
  ceiling: g.potential.ceiling,
  year1_band: g.potential.year1_band,
  urgency: g.signals.urgency,
  flags: [...g.flags].sort(),
  adjustments: fired(g),
});

check("golden: at least 17 fixtures", FIXTURES.length >= 17, `found ${FIXTURES.length}`);
check("golden: ids unique", new Set(FIXTURES.map((f) => f.id)).size === FIXTURES.length);
for (const fx of FIXTURES) {
  check(`golden ${fx.id}: has a description`, typeof fx.description === "string" && fx.description.length > 20);
  for (const [version, expected] of Object.entries(fx.expected)) {
    const rubric = RUBRICS[version];
    if (!rubric) { failures.push(`fixture ${fx.id}: unknown rubric version ${version}`); continue; }
    eq(`golden ${fx.id} @ ${version} (${fx.features.name})`, slim(grade(fx.features, rubric, (fx.options ?? {}) as never)), expected);
  }
}
// the fixture set covers the §3 list
const need: Array<[string, (g: ProspectScorecard, fx: (typeof FIXTURES)[number]) => boolean]> = [
  ["parked on service shape", (g) => g.status === "Parked" && g.gates.some((x) => x.id === "service_shape" && x.result === "fail")],
  ["parked on economics", (g) => g.status === "Parked" && g.gates.some((x) => x.id === "economics" && x.result === "fail")],
  ["unclassified", (g) => g.status === "Unclassified"],
  ["ICP-1 Platinum", (g) => g.fit.icp_class === "ICP-1" && g.fit.computed_tier === "Platinum" && g.potential.ceiling === "Partner"],
  ["ICP-2 ceiling capped Gold", (g) => g.fit.icp_class === "ICP-2" && g.fit.computed_tier === "Gold" && g.potential.ceiling_capped_reason !== null],
  ["ICP-3 Silver via ADJ-WL", (g) => g.fit.icp_class === "ICP-3" && fired(g).includes("ADJ-WL") && g.fit.computed_tier === "Silver"],
  ["ICP-3 two positives capped", (g) => g.fit.icp_class === "ICP-3" && fired(g).length >= 2 && g.fit.net_adjustment === 1],
  ["ICP-6 direct", (g) => g.fit.icp_class === "ICP-6" && g.flags.includes("Direct-to-client")],
  ["ICP-4 unproven Silver", (g) => fired(g).includes("ADJ-ICP4-UNPROVEN") && g.fit.computed_tier === "Silver"],
  ["Conversation row", (g) => g.qualification.present_count === 0 && g.status === "Ranked"],
  ["override within cap", (g) => g.status === "Overridden"],
  ["override refused", (g) => g.flags.includes("Override refused: beyond one-tier cap")],
  ["lapsed client", (g) => g.flags.includes("Lapsed client")],
  ["year-1 from quote", (g) => g.potential.year1_basis === "quote"],
  ["non-decaying negative", (g) => g.signals.negatives.some((n) => n.weight_now < 0)],
  ["Super Hot stated over Cold computed", (g) => g.signals.urgency === "Super Hot" && g.signals.urgency_basis === "stated_timing" && g.signals.decayed_total < 3],
  ["red deal on three pushes", (g) => g.deal_health.some((d) => d.color === "red" && d.warnings.some((w) => w.id === "DH-PUSHES"))],
  ["deal with the next meeting unknown stays green while known-absent is yellow", (g, fx) =>
    g.deal_health.length === 2 &&
    fx.features.deals.every((d) => d.next_meeting_at === null) &&
    g.deal_health.some((d) => d.color === "green" && d.warnings.length === 0) &&
    g.deal_health.some((d) => d.color === "yellow" && d.warnings.map((w) => w.id).join() === "DH-NO-NEXT")],
];
for (const [label, test] of need) {
  check(`golden covers: ${label}`, FIXTURES.some((fx) => test(grade(fx.features, R, (fx.options ?? {}) as never), fx)));
}
// no real-looking data: every fixture name is from the synthetic set and no email is a real domain
for (const fx of FIXTURES) {
  check(`golden ${fx.id}: synthetic approver only`, JSON.stringify(fx).split("@").every((part, i) => i === 0 || part.startsWith("example.test")));
}

/* ------------------------------------------------------------------ *
 * 3 · determinism
 * ------------------------------------------------------------------ */

for (const fx of FIXTURES) {
  const a = JSON.stringify(grade(fx.features, R, (fx.options ?? {}) as never));
  const b = JSON.stringify(grade(fx.features, R, (fx.options ?? {}) as never));
  check(`determinism ${fx.id}`, a === b);
}
check("determinism: input is not mutated", (() => {
  const f = base({ signals: [sig("quote_sent", 2)], climb_signals: ["multi_thread"] });
  const before = JSON.stringify(f);
  grade(f, R);
  return JSON.stringify(f) === before;
})());

/* ------------------------------------------------------------------ *
 * 4 · purity — as_of drives decay; the wall clock never does
 * ------------------------------------------------------------------ */

{
  const signals = [sig("quote_sent", 0, { observed_at: "2026-09-01T00:00:00Z" })];
  const early = grade(base({ as_of: "2026-09-02", signals }), R);
  const late = grade(base({ as_of: "2026-09-21", signals }), R);
  check("purity: decay differs between two as_of values", early.signals.decayed_total !== late.signals.decayed_total, `${early.signals.decayed_total} vs ${late.signals.decayed_total}`);
  eq("purity: 1 day old → 8 × (1 − 1/30)", early.signals.decayed_total, 7.7333);
  eq("purity: 20 days old → 8 × (1 − 20/30)", late.signals.decayed_total, 2.6667);
  eq("purity: as_of echoed", late.as_of, "2026-09-21");
  // the same call, made twice, is stable across time — the fixtures were frozen on 2026-09-09
  // and must replay identically whenever this file runs.
  for (const file of ["engine.ts", "classify.ts", "decay.ts", "reason.ts"]) {
    const src = readFileSync(join(here, file), "utf8");
    check(`purity: ${file} never reads the clock`, !/Date\.now|new Date\(\)|performance\.now/.test(src));
    check(`purity: ${file} has no I/O import`, !/from "node:|from "npm:|from "jsr:|fetch\(/.test(src));
    check(`purity: ${file} has no Math.random`, !src.includes("Math.random"));
  }
}

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
for (const f of failures) console.error("FAIL", f);
console.log(`engine: ${total} checks, ${failures.length} failed`);
if (failures.length) {
  // Deno and Node both expose a process-like exit; Node's is the real one.
  const proc = (globalThis as unknown as { process?: { exit: (c: number) => void } }).process;
  if (proc) proc.exit(1);
  else throw new Error(`${failures.length} engine checks failed`);
}
