/**
 * WLIQ Prospect Book — gates, ICP classification, and the rubric's little `when` grammar.
 *
 * PURE. No clock, no I/O. Imported by ./engine.ts. Every threshold is read from the rubric
 * JSON: this file holds control flow and a small expression evaluator for the rubric's
 * rule strings, so the JSON can change a threshold without a code change.
 *
 * Unknown is never evidence: a null input never fails a gate and never fires a clause.
 */

import type { GateResult, IcpClass, ProspectFeatures } from "./prospect_types.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

/* ------------------------------------------------------------------ *
 * the `when` grammar
 * ------------------------------------------------------------------ *
 * Rubric rule text looks like:
 *   icp_class in [ICP-3, ICP-5] AND wl_signal in [Very High, High]
 *   (headcount != null AND headcount < 8) AND owner_does_everything == true
 *   potential.ceiling == Partner
 * Grammar: clauses joined by AND; a clause is `<path> <op> <value>`; ops are
 * == != >= <= > < in; values are true / false / null / a number / a bare word (or
 * words) / a bracketed list. Parentheses group only conjunctions and are ignored.
 * A clause on a null field is FALSE for every op except `== null` / `!= null`.
 */

export type WhenContext = Record<string, unknown>;

type Scalar = string | number | boolean | null;

function parseScalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function resolvePath(ctx: WhenContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const CLAUSE = /^(\S+)\s+(==|!=|>=|<=|>|<|in)\s+(.+)$/;

/** Evaluate one clause. Unknown (null/undefined) field → false unless the test is about null itself. */
export function evalClause(clause: string, ctx: WhenContext): boolean {
  const m = CLAUSE.exec(clause.trim());
  if (!m) return false;
  const [, path, op, rawValue] = m;
  const field = resolvePath(ctx, path);
  const isNull = field === null || field === undefined;

  if (op === "in") {
    if (isNull) return false;
    const inner = rawValue.trim().replace(/^\[/, "").replace(/\]$/, "");
    const list = inner.split(",").map(parseScalar);
    return list.includes(field as Scalar);
  }

  const value = parseScalar(rawValue);
  if (op === "==") return value === null ? isNull : !isNull && field === value;
  if (op === "!=") return value === null ? !isNull : !isNull && field !== value;
  if (isNull || typeof field !== "number" || typeof value !== "number") return false;
  if (op === ">=") return field >= value;
  if (op === "<=") return field <= value;
  if (op === ">") return field > value;
  if (op === "<") return field < value;
  return false;
}

/** Evaluate a rubric `when` / `test` string: a conjunction of clauses. Empty → false. */
export function evalWhen(expr: string, ctx: WhenContext): boolean {
  const flat = expr.replace(/[()]/g, " ").trim();
  if (!flat) return false;
  const clauses = flat.split(/\s+AND\s+/);
  for (const c of clauses) {
    if (!evalClause(c, ctx)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * gates
 * ------------------------------------------------------------------ */

/**
 * Economics as the gate sees it. The rubric's floor_note: the engine derives
 * economics = fail when deal_size_estimate is stated and below the floor (floor_basis
 * deal_size), or hourly_rate_accepted is explicitly false, and never from absence.
 * A stated figure at or above the floor (or an explicit hourly acceptance) derives pass.
 */
export function effectiveEconomics(
  f: ProspectFeatures,
  rubric: Rubric,
): { value: "pass" | "fail" | null; derived_from: string | null } {
  if (f.economics === "pass" || f.economics === "fail") return { value: f.economics, derived_from: null };
  const g = rubric?.gates?.items?.economics ?? {};
  const floor = typeof g.floor_usd === "number" ? g.floor_usd : null;
  const basis = g.floor_basis ?? "deal_size";
  if (f.hourly_rate_accepted === false) return { value: "fail", derived_from: "hourly_rate_accepted == false" };
  if (basis === "deal_size" && floor !== null && typeof f.deal_size_estimate === "number") {
    if (f.deal_size_estimate < floor) return { value: "fail", derived_from: `deal_size_estimate ${f.deal_size_estimate} < floor ${floor}` };
    return { value: "pass", derived_from: `deal_size_estimate ${f.deal_size_estimate} >= floor ${floor}` };
  }
  if (f.hourly_rate_accepted === true) return { value: "pass", derived_from: "hourly_rate_accepted == true" };
  return { value: null, derived_from: null };
}

/** Run every gate in rubric.gates.evaluation_order. `unknown` never fails. Mode `off` gates are recorded, never acted on. */
export function evaluateGates(f: ProspectFeatures, rubric: Rubric): GateResult[] {
  const gates = rubric?.gates ?? {};
  const order: string[] = Array.isArray(gates.evaluation_order) ? gates.evaluation_order : Object.keys(gates.items ?? {});
  const out: GateResult[] = [];
  for (const id of order) {
    const item = gates.items?.[id];
    if (!item) continue;
    const mode: GateResult["mode"] = item.mode === "park" || item.mode === "flag" ? item.mode : "off";
    const basis: GateResult["basis"] = item.basis ?? "reasoned";

    let value: unknown;
    let note = "";
    if (id === "economics") {
      const e = effectiveEconomics(f, rubric);
      value = e.value;
      if (e.derived_from) note = ` (derived: ${e.derived_from})`;
    } else {
      value = (f as unknown as Record<string, unknown>)[item.input];
    }

    let result: GateResult["result"];
    if (value === null || value === undefined) result = "unknown";
    else if (value === item.fail_when) result = "fail";
    else result = "pass";

    let reason: string;
    if (mode === "off") reason = `${item.label} is switched off (mode off); recorded, not applied.`;
    else if (result === "unknown") reason = `${item.input} is unknown — unknown never ${mode === "park" ? "parks" : "flags"}.`;
    else if (result === "fail") reason = `${item.input} = ${String(value)}${note}; ${mode === "park" ? "parks the row" : "flags the row"} (${item.test}).`;
    else reason = `${item.input} = ${String(value)}${note}; passes (${item.test}).`;

    out.push({ id, label: item.label ?? id, result, mode, reason, basis });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ICP class
 * ------------------------------------------------------------------ */

/** Run the six-step flow on facts alone. null when no step matches (unknown never fires a step). */
export function deriveIcp(f: ProspectFeatures, rubric: Rubric): { icp: IcpClass | null; step: number | null } {
  const flow: Array<{ step: number; test: string; then: IcpClass }> = rubric?.dimension_b?.icp?.classification_flow ?? [];
  const ctx: WhenContext = {
    is_agency: f.is_agency,
    agency_type: f.agency_type,
    headcount: f.headcount,
    revenue_band: f.revenue_band,
    vertical_depth: f.vertical_depth,
  };
  for (const s of flow) {
    // The flow's steps 4 and 6 read "(otherwise)": the evaluator ignores that word because it
    // sits outside a clause; ordering carries the "otherwise" (step 3 was tested first).
    const expr = String(s.test).replace(/\(otherwise\)/g, "").replace(/\bOR\b/g, "__OR__");
    if (expr.includes("__OR__")) {
      const any = expr.split("__OR__").some((part) => evalWhen(part, ctx));
      if (any) return { icp: s.then, step: s.step };
    } else if (evalWhen(expr, ctx)) {
      return { icp: s.then, step: s.step };
    }
  }
  return { icp: null, step: null };
}

/**
 * A stated class wins (rubric.dimension_b.icp.stated_wins). The flow runs when nothing is
 * stated; when both exist and differ, the stated class stands and `disagrees` is true.
 */
export function classifyIcp(
  f: ProspectFeatures,
  rubric: Rubric,
): { icp_class: IcpClass | null; derivation: "stated" | "derived" | "none"; disagrees: boolean; derived: IcpClass | null; step: number | null } {
  const statedWins = rubric?.dimension_b?.icp?.stated_wins !== false;
  const d = deriveIcp(f, rubric);
  if (f.icp_class && statedWins) {
    return { icp_class: f.icp_class, derivation: "stated", disagrees: d.icp !== null && d.icp !== f.icp_class, derived: d.icp, step: d.step };
  }
  if (d.icp) return { icp_class: d.icp, derivation: "derived", disagrees: false, derived: d.icp, step: d.step };
  if (f.icp_class) return { icp_class: f.icp_class, derivation: "stated", disagrees: false, derived: null, step: null };
  return { icp_class: null, derivation: "none", disagrees: false, derived: null, step: null };
}

/** A direct-to-client row (PRO-4): relationship_type direct or ICP-6. Agency-only rules skip it. */
export function isDirectRow(f: ProspectFeatures, icp: IcpClass | null): boolean {
  return f.relationship_type === "direct" || icp === "ICP-6";
}
