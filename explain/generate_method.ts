/**
 * WLIQ Prospect Book — generate docs/METHOD.md FROM the rubric.
 *
 *   node --experimental-strip-types explain/generate_method.ts [--rubric core/rubric.prospect.v0.1.json] [--out docs/METHOD.md]
 *
 * The Client Book convention, borrowed and not imported: a hand-written method document
 * drifts from the engine the first time a threshold moves, and then it is a confident
 * wrong answer to "how is a prospect graded". Generating the document from the rubric JSON
 * makes drift impossible, and `explain/method_test.ts` fails the build if the committed
 * file is stale.
 *
 * Every number in the output comes from the rubric. Nothing numeric is typed here.
 *
 * DETERMINISTIC: no clock, no randomness, no network. The same rubric always produces the
 * same bytes, which is what lets the staleness test be a byte comparison.
 *
 * Runs under Deno and `node --experimental-strip-types`: node: imports only, `.ts`
 * relative imports, no npm packages, `import type` for types.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The rubric is data; its shape is described in core/prospect_types.ts as `any`. */
// deno-lint-ignore no-explicit-any
type Rubric = any;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export const DEFAULT_RUBRIC_FILE = "rubric.prospect.v0.1.json";

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;
const pct = (n: number): string => `${Math.round(n * 100)}%`;
/** Rubric basis strings often start lowercase ("reasoned — ..."); a sentence should not. */
const sentence = (s: string): string => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Names of people appear in this repository only as roles (docs/DESIGN.md §2). The rubric
 * text names the owner in a few ruling notes; the rendered document says "the owner"
 * instead. Deterministic, applied to every rubric string that reaches the page.
 */
export function roleize(s: string): string {
  return s.replace(/\bBrian's\b/g, "the owner's").replace(/\bBrian\b/g, "the owner");
}

/** Markdown table cells cannot contain a bare pipe. */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map((x) => cell(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return roleize(String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");
};

const code = (v: unknown): string => `\`${cell(v).replace(/\\\|/g, "|")}\``;

function table(headers: string[], rows: unknown[][]): string[] {
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.map((c) => (typeof c === "string" ? roleize(c) : cell(c))).join(" | ")} |`);
  return out;
}

/** "≥ $100K" style bands come with min/max; render the numeric edges the label stands for. */
function bandEdges(b: Obj): string {
  const hasMin = typeof b.min === "number";
  const hasMax = typeof b.max === "number";
  if (hasMin && hasMax) return `${usd(b.min)} to ${usd(b.max)}`;
  if (hasMin) return `${usd(b.min)} and up`;
  if (hasMax) return `under ${usd(b.max)}`;
  return "—";
}

const lifespan = (d: number | null): string => (d === null ? "never expires" : `${d} days`);

const direction = (d: number): string => (d > 0 ? `↑ up ${d}` : `↓ down ${Math.abs(d)}`);

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

export function generateMethod(rubric: Rubric, sourceFile: string = DEFAULT_RUBRIC_FILE): string {
  const out: string[] = [];
  const w = (s: string = "") => out.push(s);
  const para = (s: unknown) => {
    if (typeof s === "string" && s.length) {
      w(roleize(s));
      w();
    }
  };
  const tbl = (headers: string[], rows: unknown[][]) => {
    for (const line of table(headers, rows)) w(line);
    w();
  };

  /* ---- title ---- */
  w(`# How a prospect is graded`);
  w();
  w(`> Generated from core/${sourceFile}. Do not edit by hand.`);
  w(`> Regenerate with \`node --experimental-strip-types explain/generate_method.ts\`.`);
  w(`> \`explain/method_test.ts\` fails the build if this file is out of date, so what you`);
  w(`> read here is what the engine actually does — not what someone once wrote down.`);
  w();
  w(`**Rubric:** ${cell(rubric.name)} · **Version:** ${cell(rubric.version)} · **Status:** ${cell(rubric.status)} · **Created:** ${cell(rubric.created)}`);
  w();
  w(`Every anticipated grade is produced by a pure function of stored inputs:`);
  w();
  w("```");
  w(`grade(features, rubric, options) -> scorecard`);
  w("```");
  w();
  w(`No network, no clock, no randomness, no AI judgment anywhere in the scoring path. The`);
  w(`same inputs and the same rubric version always produce the same grade. Every rule that`);
  w(`fires is written into the scorecard's trace with its inputs and its basis, so a reader`);
  w(`can re-derive the tier by hand. **Unknown is never evidence:** a missing input never`);
  w(`fires a gate, an adjustment or a warning — it raises a flag instead.`);
  w();
  w(`---`);
  w();

  /* ---- 1 · what the grade is for ---- */
  const wf = rubric.what_the_grade_is_for as Obj;
  w(`## 1 · What the grade is for — and what it is not`);
  w();
  para(`**Ruling.** ${wf.ruling}`);
  w(`**It is explicitly not:**`);
  w();
  for (const s of wf.explicitly_not as string[]) w(`- ${roleize(s)}`);
  w();
  para(wf.consequence);
  const arch = rubric.architecture as Obj;
  para(`**Architecture.** ${arch.ruling}`);
  para(`**Promotion.** ${arch.promotion}`);

  /* ---- 2 · validation ---- */
  const val = rubric.validation as Obj;
  w(`## 2 · Validation stamp: ${cell(val.status)}`);
  w();
  para(`Every scorecard under this version carries the stamp **${cell(val.status)}**. It is a statement about the instrument, not about the prospect.`);
  para(`**Rule.** ${val.rule}`);
  para(`**Measured so far.** ${val.measured_so_far}`);
  para(`**Sizing pass mark on bands:** ${val.sizing_pass_mark === null ? "not yet set" : cell(val.sizing_pass_mark)}. ${val.sizing_pass_mark_note ?? ""}`);

  /* ---- 3 · vocabulary ---- */
  const voc = rubric.vocabulary as Obj;
  w(`## 3 · Vocabulary`);
  w();
  w(`Three words print beside every tier, and none of them is optional:`);
  w();
  w(`- **anticipated** — this is a prospect's tier, a forecast of fit, never a client tier.`);
  w(`- **confidence** (High / Medium / Low) — how good the inputs behind it are (§8).`);
  w(`- **${cell(val.status)}** — the instrument's validation stamp (§2), until the rule there is met.`);
  w();
  w(`**Tiers** (worst to best): ${(voc.tiers as string[]).map((t) => `**${t}**`).join(" → ")}.`);
  w();
  para(voc.tier_ruling);
  w(`**Ceilings** (how big the relationship could become): ${(voc.ceilings as string[]).map((c) => `**${c}**`).join(" → ")}. Older lists used other words for the same three rungs:`);
  w();
  tbl(["Older word", "Ceiling"], Object.entries(voc.ceiling_aliases as Obj).map(([k, v]) => [k, v]));
  w(`**Urgency** (coldest to hottest): ${(voc.urgency as string[]).map((u) => `**${u}**`).join(" → ")}.`);
  w();
  para(voc.urgency_note);

  /* ---- 4 · gates ---- */
  const gates = rubric.gates as Obj;
  w(`## 4 · Gates — operational filters, run first`);
  w();
  para(gates.note);
  w(`A gate has one of three **modes**: \`park\` (a fail sets the row's status to Parked), \`flag\` (a fail only raises a flag) or \`off\` (not evaluated). ` +
    (gates.unknown_never_parks ? `**An unknown input never parks and never flags.** ` : ``) +
    `Gates run in this order:`);
  w();
  const gateOrder = gates.evaluation_order as string[];
  tbl(
    ["#", "Gate", "Test", "Input", "Fails when", "Mode", "Basis", "Flag raised on a fail"],
    gateOrder.map((id, i) => {
      const g = gates.items[id] as Obj;
      return [String(i + 1), `**${cell(g.label)}**`, g.test, code(g.input), code(g.fail_when), `**${cell(g.mode)}**`, code(g.basis), typeof g.flag === "string" ? code(g.flag) : "—"];
    }),
  );
  w(`A gate in mode \`flag\` raises the flag text in the last column when it fails (a gate in mode \`park\` parks instead; a gate in mode \`off\` does nothing). The text is listed in the flag vocabulary (§16) so the page can explain it.`);
  w();
  for (const id of gateOrder) {
    const g = gates.items[id] as Obj;
    const parts: string[] = [];
    if (typeof g.floor_usd === "number") {
      parts.push(`Floor **${usd(g.floor_usd)}**, read as **${cell(g.floor_basis)}** (options: ${(g.floor_basis_options as string[]).map((o) => code(o)).join(", ")}).`);
    }
    for (const k of ["floor_note", "ruling_note", "note"]) if (typeof g[k] === "string") parts.push(roleize(g[k]));
    if (g.notion_aliases) parts.push(`Seed values map as follows:`);
    if (!parts.length) continue;
    w(`**${cell(g.label)}.** ${parts.join(" ")}`);
    w();
    if (g.notion_aliases) {
      tbl(["Seed value", `→ ${code(g.input)}`], Object.entries(g.notion_aliases as Obj).map(([k, v]) => [k, v === null ? "unknown" : v]));
    }
  }

  /* ---- 5 · ICP ---- */
  const db = rubric.dimension_b as Obj;
  const icp = db.icp as Obj;
  w(`## 5 · Fit (Dimension B): the ICP class`);
  w();
  para(`**Ruling.** ${db.ruling}`);
  para(`**Source.** ${icp.source}`);
  w(`**A stated class wins.** ` + roleize(icp.stated_wins_note));
  w();
  w(`When no class is stated, the flow below runs top to bottom and the first test that passes names the class. If no test passes the row is **Unclassified**.`);
  w();
  tbl(["Step", "If", "Then"], (icp.classification_flow as Obj[]).map((s) => [String(s.step), code(s.test), `**${cell(s.then)}**`]));
  w(`**The six classes**, kept verbatim from the definitions document:`);
  w();
  tbl(
    ["Class", "Name", "Employees", "Revenue", "WL signal", "Typical ticket", "July priority"],
    Object.entries(icp.definitions as Obj).map(([k, d]) => [`**${k}**`, d.name, d.employees, d.revenue, d.wl_signal, d.ticket, d.july_priority]),
  );
  for (const [k, d] of Object.entries(icp.definitions as Obj)) {
    if ((d as Obj).ruling) para(`**${k}.** ${(d as Obj).ruling}`);
  }

  /* ---- 6 · base tier ---- */
  const bt = db.base_tier_from_icp as Obj;
  w(`## 6 · Base tier from the ICP class`);
  w();
  para(`${bt.stated_rule} Basis: ${code(bt.basis)}.`);
  tbl(["ICP class", "Base tier"], Object.entries(bt.map as Obj).map(([k, v]) => [`**${k}**`, `**${v}**`]));

  /* ---- 7 · adjustments ---- */
  const adj = db.adjustments as Obj;
  w(`## 7 · Named adjustments`);
  w();
  para(`**Ruling.** ${adj.ruling}`);
  w(`Each rule moves the base tier **one rung** in its direction and is logged with its inputs whether or not it fired. ` +
    `The net movement is capped at **+${adj.net_cap_up}** upward and **−${adj.net_cap_down}** downward, however many rules fire. ` +
    `Adjustments never reach **${cell(adj.adjustments_never_reach)}** — that tier is earned only by the platinum rule (§8). ` +
    `A rule whose inputs are unknown does not fire.`);
  w();
  para(`Basis of the downward cap: ${adj.net_cap_down_basis}.`);
  const agencyOnly = new Set<string>(adj.agency_only_rules as string[]);
  tbl(
    ["Rule", "Name", "Direction", "Fires when", "Basis", "Source", "Agency-only"],
    (adj.rules as Obj[]).map((r) => [
      `**${cell(r.id)}**`, r.name, direction(r.direction), code(r.when), code(r.basis), r.source, agencyOnly.has(r.id) ? "yes" : "no — applies to direct rows too",
    ]),
  );
  para(`**Agency-only rules.** ${adj.agency_only_note} The agency-only set is: ${(adj.agency_only_rules as string[]).map((r) => code(r)).join(", ")}.`);

  /* ---- 8 · platinum + confidence ---- */
  const pr = db.platinum_rule as Obj;
  w(`## 8 · The platinum rule, and confidence`);
  w();
  w(`**${cell(adj.adjustments_never_reach)}** is never a base tier and no adjustment reaches it. A row earns it only when **all** of the following hold (basis ${code(pr.basis)}):`);
  w();
  tbl(["Requirement", "Why"], (pr.requires_all as Obj[]).map((r) => [code(r.test), r.reason]));
  para(pr.why);
  const fc = db.confidence as Obj;
  w(`**Fit confidence** prints beside the anticipated tier. Rules are tried in order; the first that matches wins (basis ${code(fc.basis)}):`);
  w();
  tbl(["Confidence", "When"], (fc.rules as Obj[]).map((r) => [`**${cell(r.label)}**`, r.otherwise ? "otherwise" : code(r.when)]));
  para(fc.note);

  /* ---- 9 · qualification ---- */
  const da = rubric.dimension_a as Obj;
  w(`## 9 · Qualification (Dimension A): is the deal real?`);
  w();
  para(`**Ruling.** ${da.ruling}`);
  w(`Four facts. Each is **present**, **absent** or **unknown** — a fact, never a judgment:`);
  w();
  tbl(["Fact", "Test", "Where the evidence lives"], Object.entries(da.items as Obj).map(([k, v]) => [`**${k}**`, v.test, v.evidence]));
  w(`The count of facts **present** gives the qualification label:`);
  w();
  tbl(["Label", "Facts present"], (da.labels as Obj[]).map((l) => [`**${cell(l.label)}**`, `at least ${l.min_present}`]));
  w(`**Minimum facts present before a tier is published: ${da.min_facts_to_publish_tier}.** ` + roleize(da.min_facts_note));
  w();
  w(`Seed values from the intake list map to the four facts as follows (a rater's entry supersedes them):`);
  w();
  tbl(
    ["Fact", "Seed property", "Mapping", "Note"],
    Object.entries(da.notion_aliases as Obj).map(([k, v]) => {
      const m = Object.entries(v as Obj).filter(([kk]) => kk !== "from" && kk !== "note").map(([kk, vv]) => `${kk} → ${vv}`).join("; ");
      return [`**${k}**`, (v as Obj).from, m, (v as Obj).note ?? "—"];
    }),
  );

  /* ---- 10 · potential ---- */
  const pot = rubric.potential as Obj;
  w(`## 10 · Potential: how big could it get?`);
  w();
  para(`**Ruling.** ${pot.ruling}`);
  w(`Potential answers with three labels — a **ceiling**, a **headroom band** and a **year-one band** — and a confidence. The raw headroom number stays in the trace for audit and is never shown on the page.`);
  w();
  w(`### 10a · Headroom`);
  w();
  w("```");
  w(`headroom = ${cell(pot.headroom)}`);
  w("```");
  w();
  const rph = pot.revenue_per_head_usd as Obj;
  w(`**Revenue per head** by archetype (default archetype **${cell(rph.default)}**; a computed value below **${usd(pot.revenue_per_head_warning_below)}** per head is warned about in the trace). Basis: ${cell(rph.basis)}.`);
  w();
  tbl(["Archetype", "Revenue per head"], Object.entries(rph).filter(([k]) => k !== "default" && k !== "basis").map(([k, v]) => [`**${k}**`, usd(v as number)]));
  const osw = pot.outsourceable_share_by_wl as Obj;
  w(`**Outsourceable share** by white-label signal (default **${pct(osw.default)}** when the signal is unknown). Basis: ${cell(osw.basis)}.`);
  w();
  tbl(["WL signal", "Outsourceable share"], Object.entries(osw).filter(([k]) => k !== "default" && k !== "basis").map(([k, v]) => [`**${k}**`, pct(v as number)]));
  para(`**Serviceable share:** default **${pct(pot.serviceable_share_default)}**. ${sentence(pot.serviceable_share_basis)}.`);
  const ws = pot.winnable_share as Obj;
  w(`**Winnable share** from vendor rank (the Wallet Allocation Rule):`);
  w();
  w("```");
  w(`winnable_share = ${cell(ws.formula)}`);
  w("```");
  w();
  tbl(["Our rank", "Winnable share"], Object.entries(ws.examples as Obj).map(([k, v]) => [k, String(v)]));
  para(`When rank or vendor count is unknown the default is **${ws.default_when_unknown}**. ${sentence(ws.default_basis)}.`);
  w(`**Headroom bands** (basis: ${cell(pot.headroom_bands_basis)}) and the ceiling each proposes:`);
  w();
  tbl(
    ["Headroom band", "Edges", "Proposed ceiling"],
    (pot.headroom_bands as Obj[]).map((b) => [`**${cell(b.label)}**`, bandEdges(b), `**${cell((pot.ceiling_from_headroom as Obj)[b.label])}**`]),
  );
  if (pot.stated_ceiling_wins_when_headroom_unknown) {
    w(`When headroom cannot be computed (headcount unknown) a sales-stated ceiling stands in, treated as inferred.`);
    w();
  }
  const ce = pot.climb_evidence as Obj;
  w(`### 10b · Climb evidence caps the ceiling`);
  w();
  para(`${ce.rule} Basis: ${code(ce.basis)}. A ceiling held down by this rule carries the flag "Ceiling capped: no climb evidence".`);
  tbl(["Climb signal", "Also written as"], (ce.signals as string[]).map((s) => {
    const aliases = Object.entries(ce.aliases as Obj).filter(([, v]) => v === s).map(([k]) => code(k));
    return [`**${s}**`, aliases.length ? aliases.join(", ") : "—"];
  }));
  w(`### 10c · Year-one band`);
  w();
  w(`Year one is a **band, never a figure**.` +
    (pot.year1_from_quote_when_present ? ` When a quote exists its amount picks the band (basis \`quote\`); otherwise the ICP prior band below is used (basis \`icp_prior\`); with neither, the band is unknown.` : ``));
  w();
  tbl(["Year-one band", "Edges"], (pot.year1_bands as Obj[]).map((b) => [`**${cell(b.label)}**`, bandEdges(b)]));
  para(`Basis of the anchors: ${pot.year1_bands_basis}`);
  const yp = pot.year1_icp_prior_band as Obj;
  w(`**ICP prior band** (used only without a quote). Basis: ${cell(yp.basis)}`);
  w();
  tbl(["ICP class", "Prior year-one band"], Object.entries(yp.map as Obj).map(([k, v]) => [`**${k}**`, `**${v}**`]));
  const pc = pot.confidence as Obj;
  w(`### 10d · Potential confidence`);
  w();
  tbl(["Confidence", "When"], (pc.rules as Obj[]).map((r) => [`**${cell(r.label)}**`, r.otherwise ? "otherwise" : code(r.when)]));
  para(`Basis: ${pc.basis}.`);
  const snap = pot.snapshot_at_signing as Obj;
  para(`**Snapshot at signing** (later phase). Fields ${(snap.fields as string[]).map((f) => code(f)).join(", ")}, scored at ${(snap.scored_at_months as number[]).join(", ")} months. ${snap.note}`);

  /* ---- 11 · signals ---- */
  const sig = rubric.signals as Obj;
  w(`## 11 · Signals: are they moving now?`);
  w();
  para(`**Ruling.** ${sig.ruling}`);
  w(`Each signal has a weight and a lifespan. Behavioural signals decay linearly to zero over their lifespan; signals marked *does not decay* count at full weight until the lifespan ends and then drop to zero. Age is measured against the scoring date passed in (\`as_of\`), never a clock.`);
  w();
  w("```");
  w(cell(sig.decay_formula));
  w("```");
  w();
  w(`### 11a · Signal catalog`);
  w();
  tbl(
    ["Signal", "Label", "Weight", "Lifespan", "Decays", "Strength", "SLA", "Also"],
    Object.entries(sig.catalog as Obj).map(([k, s]) => [
      code(k), s.label, String(s.weight), lifespan(s.lifespan_days), s.decays ? "yes" : "no", cell(s.strength),
      typeof s.sla_hours === "number" ? `${s.sla_hours} h` : "default",
      s.flag ? `flag: ${cell(s.flag)}` : s.note ? cell(s.note) : "—",
    ]),
  );
  para(`The scorecard lists the top **${sig.top_n}** live positive signals, strongest first (display only); the decayed total behind urgency counts every signal, listed or not.`);
  const urg = sig.urgency as Obj;
  w(`### 11b · Urgency`);
  w();
  w((urg.stated_timing_wins ? `**A stated timing fact wins.** When the timing fact is present it sets urgency directly:` : `Urgency from a stated timing fact:`));
  w();
  tbl(["Stated timing", "Urgency"], Object.entries(urg.from_timing as Obj).map(([k, v]) => [code(k), `**${v}**`]));
  w(`Otherwise the **decayed total** of live signals climbs this ladder (the first rung the total reaches, from the top). With no signals at all the row is **${cell((urg.from_decayed_total as Obj[])[(urg.from_decayed_total as Obj[]).length - 1].label)}** with basis \`none\`.`);
  w();
  tbl(["Urgency", "Decayed total at least"], (urg.from_decayed_total as Obj[]).map((r) => [`**${cell(r.label)}**`, String(r.min)]));
  para(`Basis: ${urg.basis}.`);
  const rt = sig.routing as Obj;
  w(`### 11c · Routing: when a signal becomes a task`);
  w();
  para(rt.rule);
  tbl(["Setting", "Value"], [
    ["Window", `${rt.window_days} days`],
    ["Strong signal", `weight ≥ ${rt.strong_min_weight}`],
    ["Medium signal", `weight ≥ ${rt.medium_min_weight}`],
    ["Default SLA", `${rt.default_sla_hours} hours`],
  ]);
  para(`A task's SLA is the signal's own (catalog column above) or the default; it is due that many hours after the signal was observed. Basis: ${rt.basis}.`);

  /* ---- 12 · deal health ---- */
  const dh = rubric.deal_health as Obj;
  w(`## 12 · Deal health: are we winning?`);
  w();
  para(`**Ruling.** ${dh.ruling}`);
  w(`Computed **per open deal**; a row with no deals has no deal-health read and its reason sentence says nothing about it. A deal is **red** if any red rule fires, else **yellow** if any yellow rule fires, else **green**. ` +
    `Stage medians default to **${dh.default_stage_median_days} days** until WLIQ's own are known.` +
    (dh.unknown_never_warns ? ` **An unknown field never warns.**` : ``));
  w();
  para(dh.params_note);
  const params = (r: Obj): string => {
    const entries = Object.entries((r.params ?? {}) as Obj);
    return entries.length ? entries.map(([k, v]) => `${k} = ${cell(v)}`).join("; ") : "—";
  };
  w(`**Red when any of:**`);
  w();
  tbl(["Rule", "Test", "Thresholds (params)", "Warning shown"], (dh.red_when_any as Obj[]).map((r) => [`**${cell(r.id)}**`, code(r.test), params(r), r.message]));
  w(`**Yellow when any of:**`);
  w();
  tbl(["Rule", "Test", "Thresholds (params)", "Warning shown"], (dh.yellow_when_any as Obj[]).map((r) => [`**${cell(r.id)}**`, code(r.test), params(r), r.message]));
  para(`**The next meeting.** ${dh.next_meeting_note ?? ""}`);
  para(dh.stage_exit_criteria_note);

  /* ---- 13 · override ---- */
  const ov = rubric.override as Obj;
  w(`## 13 · Override contract`);
  w();
  para(`**Ruling.** ${ov.ruling}`);
  tbl(["Term", "Value"], [
    ["Who may override", `the **${cell(ov.lane)}** lane only`],
    ["How far", `at most **${ov.max_tiers_moved}** tier from the computed tier`],
    ["Reason code", ov.reason_code_required ? `**required**, one of ${(ov.reason_codes as string[]).map((c) => code(c)).join(", ")}` : `optional; when given, one of ${(ov.reason_codes as string[]).map((c) => code(c)).join(", ")}`],
    ["Written reason", ov.written_reason_required ? "**required** — an override without one is ignored" : "optional"],
    ["Default expiry", `${ov.expiry_default_days} days after it was set, when no expiry is stated`],
    ["Expires-soon warning", `raised when **${ov.expires_soon_days} days** or fewer remain before the expiry`],
    ["Beyond the cap", cell(ov.beyond_cap)],
    ["Recorded in the register", ov.into_register ? "yes" : "no"],
  ]);
  w(`An override is applied only when the approver is named${ov.reason_code_required ? ", a reason code from the list is given" : ""}${ov.written_reason_required ? ", a written reason is present" : ""} and it has not expired. ` +
    `A refused override leaves the computed tier standing and raises the flag "Override refused: beyond one-tier cap". An override within **${ov.expires_soon_days} days** of its expiry raises "Override expires soon".`);
  w();
  const raters = rubric.raters as Obj;
  para(`**Raters.** ${raters.ruling}`);
  para(raters.note);

  /* ---- 14 · status ---- */
  const st = rubric.status_rules as Obj;
  w(`## 14 · Status precedence`);
  w();
  w(`Evaluated in this order; the first that applies is the row's status: ${(st.precedence as string[]).map((s) => `**${s}**`).join(" → ")}. A parked or unclassified row is still graded and stored — only its status differs.`);
  w();
  tbl(["Status", "When"], (st.precedence as string[]).map((s) => [`**${s}**`, st[s]]));

  /* ---- 15 · chase order ---- */
  const ck = rubric.chase_rank_key as Obj;
  w(`## 15 · Chase order`);
  w();
  para(`**Ruling.** ${ck.ruling} Rows sort by these keys in turn, best first; the **cell** shown on the page is the anticipated tier × the ceiling.`);
  tbl(["Order", "Key"], (ck.keys as string[]).map((k, i) => [String(i + 1), k]));

  /* ---- 16 · flags ---- */
  const fl = rubric.flags as Obj;
  w(`## 16 · Flags`);
  w();
  para(fl.note);
  for (const f of fl.vocabulary as string[]) w(`- ${roleize(f)}`);
  w();

  /* ---- 17 · reason sentence ---- */
  const rs = rubric.reason_sentence as Obj;
  w(`## 17 · The reason sentence`);
  w();
  para(rs.rule);
  w("```");
  w(cell(rs.shape));
  w("```");
  w();

  /* ---- 18 · still open ---- */
  w(`## 18 · Still open in this version`);
  w();
  w(`Each of these is a toggle in the rubric with its current default stated; none is a new ruling.`);
  w();
  for (const q of rubric.still_open as string[]) w(`- ${roleize(q)}`);
  w();

  w(`---`);
  w();
  w(`*Generated from the rubric. If this document and the engine ever disagree, the`);
  w(`generator is broken — the rubric is the single source of both.*`);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rubricPath = arg("--rubric", join(HERE, "../core/", DEFAULT_RUBRIC_FILE));
  const outPath = arg("--out", join(HERE, "../docs/METHOD.md"));
  const rubric = JSON.parse(readFileSync(resolve(rubricPath), "utf8"));
  const md = generateMethod(rubric, rubricPath.split("/").pop() as string);
  writeFileSync(resolve(outPath), md);
  console.log(`METHOD.md generated from rubric v${rubric.version} -> ${outPath} (${md.length} chars)`);
}
