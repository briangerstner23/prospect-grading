/**
 * WLIQ Prospect Book — METHOD.md staleness gate.
 *
 * Run:  node --experimental-strip-types explain/method_test.ts
 *
 * A method document that has drifted from the rubric is worse than no document: it is a
 * confident wrong answer to "how is a prospect graded", and it is exactly what a
 * salesperson quotes in a conversation. So the committed docs/METHOD.md is regenerated here
 * and compared BYTE FOR BYTE. If a threshold moves in the rubric and nobody regenerates,
 * this fails — which is what makes "the rubric is the answer" true rather than a slogan.
 *
 * It also checks that every number in the document comes from the JSON (moving a value in
 * a copy of the rubric must move it in the document), that every catalogued rule, signal,
 * flag and band is present, and that no person is named.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import { DEFAULT_RUBRIC_FILE, generateMethod } from "./generate_method.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(here, p), "utf8");

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail: string = "") => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---- 1 · the committed doc is current ---- */

const rubric = JSON.parse(read(`../core/${DEFAULT_RUBRIC_FILE}`));
const regenerated = generateMethod(rubric, DEFAULT_RUBRIC_FILE);
let committed = "";
try {
  committed = read("../docs/METHOD.md");
} catch {
  committed = "";
}

if (regenerated === committed) {
  passed++;
} else {
  const a = regenerated.split("\n"), b = committed.split("\n");
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  failures.push(
    `docs/METHOD.md is STALE — regenerate with:\n` +
    `      node --experimental-strip-types explain/generate_method.ts\n` +
    `    first difference at line ${i + 1}:\n` +
    `      committed:   ${JSON.stringify(b[i] ?? "<end of file>")}\n` +
    `      regenerated: ${JSON.stringify(a[i] ?? "<end of file>")}`,
  );
}

/* ---- 2 · deterministic: no clock, no randomness ---- */

check("generating twice produces identical bytes",
  generateMethod(rubric, DEFAULT_RUBRIC_FILE) === generateMethod(rubric, DEFAULT_RUBRIC_FILE));

/* ---- 3 · structure ---- */

const doc = regenerated;
const lines = doc.split("\n");

check("header line is exact",
  lines[2] === `> Generated from core/${DEFAULT_RUBRIC_FILE}. Do not edit by hand.`, JSON.stringify(lines[2]));
check("renders a substantial document", doc.length > 10000, `only ${doc.length} chars`);
check("leaks no unrendered objects", !doc.includes("[object Object]"));
check("leaks no undefined", !/\bundefined\b/.test(doc));
check("leaks no null cells", !/\|\s*null\s*\||\(null\)|: null\b/.test(doc), "a table cell or value rendered as null");
check("names no person (roles only)", !/\bBrian\b/.test(doc));

const emptyRow = lines.find((line) => {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  if (/^\|[\s|:-]*\|$/.test(t)) return false; // separator row
  return t.slice(1, -1).split("|").every((c) => c.trim() === "");
});
check("has no empty table rows", emptyRow === undefined, emptyRow);

const orphanHeader = lines.findIndex((l, i) =>
  /^\|[\s|:-]*\|$/.test(l.trim()) && l.includes("-") && !(lines[i + 1] ?? "").trim().startsWith("|"));
check("has no empty tables", orphanHeader === -1, orphanHeader >= 0 ? `header at line ${orphanHeader + 1}` : "");

// Every table row has the same number of cells as its header.
let badTable = "";
for (let i = 0; i < lines.length && !badTable; i++) {
  if (!/^\|[\s|:-]*\|$/.test(lines[i].trim()) || !lines[i].includes("-")) continue;
  const n = lines[i].split("|").length;
  for (let j = i + 1; j < lines.length && lines[j].trim().startsWith("|"); j++) {
    if (lines[j].replace(/\\\|/g, "").split("|").length !== n) { badTable = `line ${j + 1}`; break; }
  }
}
check("every table row has the header's column count", badTable === "", badTable);

/* ---- 4 · the doc covers every section the brief names ---- */

for (const [label, needle] of [
  ["what the grade is for", "What the grade is for"],
  ["the validation stamp", "Validation stamp"],
  ["vocabulary", "## 3 · Vocabulary"],
  ["gates", "Gates"],
  ["the ICP flow", "the ICP class"],
  ["the base-tier map", "Base tier from the ICP class"],
  ["adjustments", "Named adjustments"],
  ["the platinum rule", "platinum rule"],
  ["qualification", "Qualification (Dimension A)"],
  ["potential", "Potential: how big could it get?"],
  ["the signal catalog", "Signal catalog"],
  ["urgency", "Urgency"],
  ["routing", "Routing"],
  ["deal health", "Deal health"],
  ["the override contract", "Override contract"],
  ["status precedence", "Status precedence"],
  ["the chase order", "Chase order"],
  ["flags", "## 16 · Flags"],
  ["the reason sentence", "The reason sentence"],
  ["the still-open list", "Still open in this version"],
  ["the anticipated label", "**anticipated**"],
] as const) {
  check(`documents ${label}`, doc.includes(needle));
}

/* ---- 5 · every catalogued item is present ---- */

const has = (s: string) => doc.includes(s);
const all = (name: string, items: string[]) => {
  const missing = items.filter((i) => !has(i));
  check(`renders every ${name} (${items.length})`, missing.length === 0, `missing: ${missing.join(", ")}`);
};

all("tier word", rubric.vocabulary.tiers);
all("ceiling word", rubric.vocabulary.ceilings);
all("urgency word", rubric.vocabulary.urgency);
all("gate label", Object.values(rubric.gates.items as Obj).map((g: Obj) => g.label));
all("ICP class", Object.keys(rubric.dimension_b.icp.definitions));
all("ICP definition name", Object.values(rubric.dimension_b.icp.definitions as Obj).map((d: Obj) => d.name));
all("classification test", (rubric.dimension_b.icp.classification_flow as Obj[]).map((s) => s.test));
all("adjustment id", (rubric.dimension_b.adjustments.rules as Obj[]).map((r) => r.id));
all("adjustment condition", (rubric.dimension_b.adjustments.rules as Obj[]).map((r) => r.when));
all("adjustment source", (rubric.dimension_b.adjustments.rules as Obj[]).map((r) => r.source));
all("platinum requirement", (rubric.dimension_b.platinum_rule.requires_all as Obj[]).map((r) => r.test));
all("Dimension A item", Object.keys(rubric.dimension_a.items));
all("qualification label", (rubric.dimension_a.labels as Obj[]).map((l) => l.label));
all("headroom band label", (rubric.potential.headroom_bands as Obj[]).map((b) => b.label));
all("year-one band label", (rubric.potential.year1_bands as Obj[]).map((b) => b.label));
all("climb signal", rubric.potential.climb_evidence.signals);
all("signal key", Object.keys(rubric.signals.catalog).map((k) => `\`${k}\``));
all("signal label", Object.values(rubric.signals.catalog as Obj).map((s: Obj) => s.label));
all("red deal-health rule", (rubric.deal_health.red_when_any as Obj[]).map((r) => r.id));
all("yellow deal-health rule", (rubric.deal_health.yellow_when_any as Obj[]).map((r) => r.id));
all("deal-health message", [...rubric.deal_health.red_when_any, ...rubric.deal_health.yellow_when_any].map((r: Obj) => r.message));
all("deal-health threshold", [...rubric.deal_health.red_when_any, ...rubric.deal_health.yellow_when_any].flatMap((r: Obj) => Object.entries(r.params as Obj).map(([k, v]) => `${k} = ${v}`)));
all("gate flag text", Object.values(rubric.gates.items as Obj).map((g: Obj) => g.flag).filter((f: unknown) => typeof f === "string").map((f: string) => `\`${f}\``));
check("renders the top-n signal count", has(`top **${rubric.signals.top_n}** live positive signals`));
check("renders the expires-soon window", has(`**${rubric.override.expires_soon_days} days** or fewer remain`));
check("renders the written-reason requirement", has(rubric.override.written_reason_required ? "| Written reason | **required**" : "| Written reason | optional |"));
check("renders the Pipedrive-seed catalog rows", ["`verbally_accepted`", "`pa_sent`", "`quote_lost`"].every(has));
all("override reason code", rubric.override.reason_codes);
all("status", rubric.status_rules.precedence);
all("chase key", rubric.chase_rank_key.keys);
all("flag", rubric.flags.vocabulary);
all("still-open item", rubric.still_open);
check("renders the reason-sentence shape", has(rubric.reason_sentence.shape));
check("renders the headroom formula", has(rubric.potential.headroom));
check("renders the winnable-share formula", has(rubric.potential.winnable_share.formula));
check("renders the decay formula", has(rubric.signals.decay_formula));

/* ---- 6 · every number comes from the JSON ---- */

// Every numeric leaf of the signal catalog, urgency ladder, routing and deal-health defaults
// must appear in the document as a token.
const numericLeaves: number[] = [];
const walk = (v: unknown) => {
  if (typeof v === "number") numericLeaves.push(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") Object.values(v as Obj).forEach(walk);
};
walk(rubric.signals);
walk(rubric.override);
walk(rubric.deal_health);
walk(rubric.dimension_b.adjustments.net_cap_up);
walk(rubric.dimension_b.adjustments.net_cap_down);
walk(rubric.dimension_a.min_facts_to_publish_tier);
const missingNumbers = [...new Set(numericLeaves)].filter((n) => !new RegExp(`(^|[^\\d.])${String(n).replace("-", "-?")}(?![\\d])`).test(doc));
check("every numeric leaf of signals / override / deal-health defaults / caps appears in the doc",
  missingNumbers.length === 0, `missing: ${missingNumbers.join(", ")}`);

// Money and ratio thresholds render in their formatted form.
const money = [
  rubric.gates.items.economics.floor_usd,
  rubric.potential.revenue_per_head_warning_below,
  ...Object.values(rubric.potential.revenue_per_head_usd).filter((v) => typeof v === "number"),
  ...rubric.potential.headroom_bands.flatMap((b: Obj) => [b.min, b.max]).filter((v: unknown) => typeof v === "number"),
  ...rubric.potential.year1_bands.flatMap((b: Obj) => [b.min, b.max]).filter((v: unknown) => typeof v === "number"),
] as number[];
all("dollar threshold", money.map((n) => `$${n.toLocaleString("en-US")}`));
const ratios = Object.values(rubric.potential.outsourceable_share_by_wl).filter((v) => typeof v === "number") as number[];
all("outsourceable share", ratios.map((r) => `${Math.round(r * 100)}%`));
check("renders the serviceable-share default", has(`${Math.round(rubric.potential.serviceable_share_default * 100)}%`));

// Moving a value in a copy of the rubric must move it in the document. If a number were
// typed into the generator by hand, the document would not change.
const mutate = (path: string[], value: unknown): string => {
  const copy = JSON.parse(JSON.stringify(rubric));
  let node: Obj = copy;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path[path.length - 1]] = value;
  return generateMethod(copy, DEFAULT_RUBRIC_FILE);
};
for (const [label, path, value, expect] of [
  ["economic floor", ["gates", "items", "economics", "floor_usd"], 2500, "$2,500"],
  ["routing window", ["signals", "routing", "window_days"], 45, "45 days"],
  ["strong-signal weight", ["signals", "routing", "strong_min_weight"], 9, "weight ≥ 9"],
  ["default SLA", ["signals", "routing", "default_sla_hours"], 96, "96 hours"],
  ["override expiry", ["override", "expiry_default_days"], 60, "60 days"],
  ["override cap", ["override", "max_tiers_moved"], 2, "at most **2** tier"],
  ["the expires-soon window", ["override", "expires_soon_days"], 21, "raised when **21 days** or fewer remain"],
  ["the written-reason toggle", ["override", "written_reason_required"], false, "| Written reason | optional |"],
  ["the top-n signal count", ["signals", "top_n"], 7, "lists the top **7** live positive signals"],
  ["a deal-health threshold", ["deal_health", "red_when_any", "0", "params", "min_days_dark"], 28, "min_days_dark = 28"],
  ["a two-parameter deal-health rule", ["deal_health", "yellow_when_any", "0", "params", "max_days"], 27, "min_days = 14; max_days = 27"],
  ["a gate flag text", ["gates", "items", "broker_character", "flag"], "Character concern", "| `Character concern` |"],
  ["a new catalog row's lifespan", ["signals", "catalog", "quote_lost", "lifespan_days"], 200, "| -4 | 200 days | yes | negative |"],
  ["a signal weight", ["signals", "catalog", "quote_requested", "weight"], 11, "| 11 |"],
  ["a signal SLA", ["signals", "catalog", "quote_requested", "sla_hours"], 6, "| 6 h |"],
  ["a signal lifespan", ["signals", "catalog", "quote_requested", "lifespan_days"], 21, "| 21 days |"],
  ["an urgency threshold", ["signals", "urgency", "from_decayed_total", "0", "min"], 17, "| 17 |"],
  ["stage median", ["deal_health", "default_stage_median_days"], 28, "**28 days**"],
  ["revenue per head", ["potential", "revenue_per_head_usd", "strategy"], 210000, "$210,000"],
  ["outsourceable share", ["potential", "outsourceable_share_by_wl", "Low"], 0.15, "15%"],
  ["serviceable share", ["potential", "serviceable_share_default"], 0.6, "60%"],
  ["winnable default", ["potential", "winnable_share", "default_when_unknown"], 0.4, "**0.4**"],
  ["a year-one band edge", ["potential", "year1_bands", "1", "min"], 47000, "$47,000"],
  ["a headroom band edge", ["potential", "headroom_bands", "1", "min"], 36000, "$36,000"],
  ["the upward cap", ["dimension_b", "adjustments", "net_cap_up"], 2, "**+2**"],
  ["the downward cap", ["dimension_b", "adjustments", "net_cap_down"], 2, "**−2**"],
  ["the minimum facts to publish", ["dimension_a", "min_facts_to_publish_tier"], 2, "published: 2."],
  ["a qualification label threshold", ["dimension_a", "labels", "1", "min_present"], 3, "at least 3 |"],
  ["the base-tier map", ["dimension_b", "base_tier_from_icp", "map", "ICP-6"], "Bronze", "| **ICP-6** | **Bronze** |"],
  ["a gate mode", ["gates", "items", "broker_character", "mode"], "park", "| **park** | `reasoned` |"],
  ["the validation status", ["validation", "status"], "VALIDATED", "stamp **VALIDATED**"],
  ["the rubric version", ["version"], "0.2.0", "**Version:** 0.2.0"],
] as Array<[string, string[], unknown, string]>) {
  const md = mutate(path, value);
  check(`moving ${label} in the rubric moves it in the doc`, md !== doc && md.includes(expect), `expected ${JSON.stringify(expect)}`);
}

/* ---- 7 · renders under a different source file name ---- */

check("names the source file it was given",
  generateMethod(rubric, "rubric.prospect.v0.2.json").includes("> Generated from core/rubric.prospect.v0.2.json. Do not edit by hand."));

/* ------------------------------------------------------------------ */

console.log("");
if (failures.length) {
  console.log(`  ${passed} checks passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`    ✗ ${f}`);
  process.exit(1);
}
console.log(`  ${passed} checks passed, 0 failed`);
console.log("  METHOD.md is current — the published method matches the rubric exactly.");
console.log("");
