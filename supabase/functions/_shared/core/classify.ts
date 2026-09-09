/**
 * WLIQ Prospect Book — the strict rubric reader, gates, ICP classification, and the rubric's
 * little `when` grammar.
 *
 * PURE. No clock, no I/O. Imported by ./engine.ts, ./decay.ts and ./reason.ts. Every
 * threshold is read from the rubric JSON: this file holds control flow and a small
 * expression evaluator for the rubric's rule strings, so the JSON can change a threshold
 * without a code change.
 *
 * Unknown is never evidence: a null input never fails a gate and never fires a clause.
 */

import type { GateResult, IcpClass, ProspectFeatures } from "./prospect_types.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

/* ------------------------------------------------------------------ *
 * the strict rubric reader
 * ------------------------------------------------------------------ *
 * Every threshold, toggle, band and map the engine needs lives in the rubric JSON, and the
 * engine reads it with these helpers and nothing else. There is NO code fallback: a key that
 * is missing or of the wrong type throws a RubricError naming the path. A malformed rubric is
 * a configuration fault, not a data gap — "a grade is labelled, never withheld" is about
 * facts about a prospect; a rubric that cannot state its own thresholds must fail at preview
 * (`?rubric=<v>&preview=1`), loudly, before it is ever activated.
 */

export class RubricError extends Error {
  path: string;
  constructor(rubric: Rubric, path: string, expected: string, got: unknown) {
    const version = typeof rubric?.version === "string" ? rubric.version : "<no version>";
    super(
      `Rubric ${version}: '${path}' must be ${expected} (got ${describe(got)}). ` +
        `Every threshold lives in the rubric JSON and there is no code fallback — fix the rubric, not the engine.`,
    );
    this.name = "RubricError";
    this.path = path;
  }
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return "an object";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Resolve a dotted path against an object; undefined when any segment is missing. */
export function rubricAt(rubric: Rubric, path: string): unknown {
  let cur: unknown = rubric;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function reqNum(rubric: Rubric, path: string): number {
  const v = rubricAt(rubric, path);
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RubricError(rubric, path, "a finite number", v);
  return v;
}

export function reqBool(rubric: Rubric, path: string): boolean {
  const v = rubricAt(rubric, path);
  if (typeof v !== "boolean") throw new RubricError(rubric, path, "true or false", v);
  return v;
}

export function reqStr(rubric: Rubric, path: string): string {
  const v = rubricAt(rubric, path);
  if (typeof v !== "string" || v.trim().length === 0) throw new RubricError(rubric, path, "a non-empty string", v);
  return v;
}

export function reqArr<T = unknown>(rubric: Rubric, path: string): T[] {
  const v = rubricAt(rubric, path);
  if (!Array.isArray(v)) throw new RubricError(rubric, path, "an array", v);
  return v as T[];
}

export function reqObj(rubric: Rubric, path: string): Record<string, unknown> {
  const v = rubricAt(rubric, path);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new RubricError(rubric, path, "an object", v);
  return v as Record<string, unknown>;
}

export function reqOneOf<T extends string>(rubric: Rubric, path: string, options: readonly T[]): T {
  const v = rubricAt(rubric, path);
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    throw new RubricError(rubric, path, `one of ${options.map((o) => JSON.stringify(o)).join(", ")}`, v);
  }
  return v as T;
}

/** A number found at `path` inside an already-resolved object (for items inside arrays). */
export function reqNumIn(rubric: Rubric, obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RubricError(rubric, `${path}.${key}`, "a finite number", v);
  return v;
}

export function reqStrIn(rubric: Rubric, obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) throw new RubricError(rubric, `${path}.${key}`, "a non-empty string", v);
  return v;
}

export function reqOneOfIn<T extends string>(rubric: Rubric, obj: Record<string, unknown>, key: string, path: string, options: readonly T[]): T {
  const v = obj[key];
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    throw new RubricError(rubric, `${path}.${key}`, `one of ${options.map((o) => JSON.stringify(o)).join(", ")}`, v);
  }
  return v as T;
}

export const BASES = ["ruled", "unruled_default", "reasoned"] as const;

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
  return evalWhenDetailed(expr, ctx).result;
}

/**
 * Same, and also names the referenced fields that are unknown (null / undefined). A false
 * result with unknown fields is "false for want of evidence", not "false on the facts".
 */
export function evalWhenDetailed(expr: string, ctx: WhenContext): { result: boolean; unknown_fields: string[] } {
  const flat = expr.replace(/[()]/g, " ").trim();
  const unknown: string[] = [];
  if (!flat) return { result: false, unknown_fields: unknown };
  let result = true;
  for (const c of flat.split(/\s+AND\s+/)) {
    const m = CLAUSE.exec(c.trim());
    if (m) {
      const v = resolvePath(ctx, m[1]);
      if ((v === null || v === undefined) && !unknown.includes(m[1])) unknown.push(m[1]);
    }
    if (!evalClause(c, ctx)) result = false;
  }
  return { result, unknown_fields: unknown };
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
  const floor = reqNum(rubric, "gates.items.economics.floor_usd");
  const options = reqArr<string>(rubric, "gates.items.economics.floor_basis_options");
  const basis = reqOneOf(rubric, "gates.items.economics.floor_basis", options);
  if (f.hourly_rate_accepted === false) return { value: "fail", derived_from: "hourly_rate_accepted == false" };
  if (basis === "deal_size" && typeof f.deal_size_estimate === "number") {
    if (f.deal_size_estimate < floor) return { value: "fail", derived_from: `deal_size_estimate ${f.deal_size_estimate} < floor ${floor}` };
    return { value: "pass", derived_from: `deal_size_estimate ${f.deal_size_estimate} >= floor ${floor}` };
  }
  if (f.hourly_rate_accepted === true) return { value: "pass", derived_from: "hourly_rate_accepted == true" };
  return { value: null, derived_from: null };
}

/** Run every gate in rubric.gates.evaluation_order. `unknown` never fails. Mode `off` gates are recorded, never acted on. */
export function evaluateGates(f: ProspectFeatures, rubric: Rubric): GateResult[] {
  const order = reqArr<string>(rubric, "gates.evaluation_order");
  const items = reqObj(rubric, "gates.items");
  const out: GateResult[] = [];
  for (const id of order) {
    const path = `gates.items.${id}`;
    if (items[id] === null || typeof items[id] !== "object") throw new RubricError(rubric, path, "a gate item named in gates.evaluation_order", items[id]);
    const item = items[id] as Record<string, unknown>;
    const mode = reqOneOfIn(rubric, item, "mode", path, ["park", "flag", "off"] as const);
    const basis = reqOneOfIn(rubric, item, "basis", path, BASES);
    const label = reqStrIn(rubric, item, "label", path);
    const input = reqStrIn(rubric, item, "input", path);
    const test = reqStrIn(rubric, item, "test", path);
    if (item.fail_when === undefined) throw new RubricError(rubric, `${path}.fail_when`, "the value that fails the gate", item.fail_when);

    let value: unknown;
    let note = "";
    if (id === "economics") {
      const e = effectiveEconomics(f, rubric);
      value = e.value;
      if (e.derived_from) note = ` (derived: ${e.derived_from})`;
    } else {
      value = (f as unknown as Record<string, unknown>)[input];
    }

    let result: GateResult["result"];
    if (value === null || value === undefined) result = "unknown";
    else if (value === item.fail_when) result = "fail";
    else result = "pass";

    let reason: string;
    if (mode === "off") reason = `${label} is switched off (mode off); recorded, not applied.`;
    else if (result === "unknown") reason = `${input} is unknown — unknown never ${mode === "park" ? "parks" : "flags"}.`;
    else if (result === "fail") reason = `${input} = ${String(value)}${note}; ${mode === "park" ? "parks the row" : "flags the row"} (${test}).`;
    else reason = `${input} = ${String(value)}${note}; passes (${test}).`;

    out.push({ id, label, result, mode, reason, basis });
  }
  return out;
}

/**
 * The flag a gate in mode `flag` raises when it fails: the item's own `flag` text when the
 * rubric names one (the shipped rubric does, and lists it in flags.vocabulary), else
 * "<label> flag". The text is display vocabulary, not a threshold, so the label form is an
 * honest stand-in rather than a silent fallback — and it is still rubric text.
 */
export function gateFlagText(rubric: Rubric, id: string): string {
  const item = reqObj(rubric, `gates.items.${id}`);
  if (typeof item.flag === "string" && item.flag.trim().length > 0) return item.flag;
  return `${reqStrIn(rubric, item, "label", `gates.items.${id}`)} flag`;
}

/* ------------------------------------------------------------------ *
 * ICP class
 * ------------------------------------------------------------------ */

export interface IcpDerivation {
  icp: IcpClass | null;
  step: number | null;
  /**
   * true when every step rejected before the match was rejected on KNOWN facts. false when a
   * rejected step failed for want of an input (e.g. full_service with revenue_band unknown
   * falls to ICP-2 only because step 3 could not be tested): the class is still the flow's
   * best answer, but it is not evidence against a stated class.
   */
  firm: boolean;
  unknown_fields: string[];
}

/** Run the six-step flow on facts alone. null when no step matches (unknown never fires a step). */
export function deriveIcp(f: ProspectFeatures, rubric: Rubric): IcpDerivation {
  const flow = reqArr<Record<string, unknown>>(rubric, "dimension_b.icp.classification_flow").map((s, i) => ({
    step: reqNumIn(rubric, s, "step", `dimension_b.icp.classification_flow[${i}]`),
    test: reqStrIn(rubric, s, "test", `dimension_b.icp.classification_flow[${i}]`),
    then: reqStrIn(rubric, s, "then", `dimension_b.icp.classification_flow[${i}]`) as IcpClass,
  }));
  const ctx: WhenContext = {
    is_agency: f.is_agency,
    agency_type: f.agency_type,
    headcount: f.headcount,
    revenue_band: f.revenue_band,
    vertical_depth: f.vertical_depth,
  };
  const unknownSeen: string[] = [];
  for (const s of flow) {
    // The flow's steps 4 and 6 read "(otherwise)": the evaluator ignores that word because it
    // sits outside a clause; ordering carries the "otherwise" (step 3 was tested first).
    const expr = String(s.test).replace(/\(otherwise\)/g, "").replace(/\bOR\b/g, "__OR__");
    const parts = expr.includes("__OR__") ? expr.split("__OR__") : [expr];
    const results = parts.map((part) => evalWhenDetailed(part, ctx));
    if (results.some((r) => r.result)) {
      return { icp: s.then, step: s.step, firm: unknownSeen.length === 0, unknown_fields: unknownSeen };
    }
    // For an OR step, a part that fails on the facts is a firm rejection of that part; a part
    // whose fields are unknown leaves the step untestable.
    for (const r of results) {
      for (const u of r.unknown_fields) if (!unknownSeen.includes(u)) unknownSeen.push(u);
    }
  }
  return { icp: null, step: null, firm: unknownSeen.length === 0, unknown_fields: unknownSeen };
}

/**
 * A stated class wins (rubric.dimension_b.icp.stated_wins). The flow runs when nothing is
 * stated; when both exist and differ, the stated class stands and `disagrees` is true.
 */
export interface IcpClassification {
  icp_class: IcpClass | null;
  derivation: "stated" | "derived" | "none";
  /** Stated and firmly derived classes both exist and differ. A derivation that leaned on an unknown never disagrees. */
  disagrees: boolean;
  derived: IcpClass | null;
  step: number | null;
  firm: boolean;
  unknown_fields: string[];
}

export function classifyIcp(f: ProspectFeatures, rubric: Rubric): IcpClassification {
  const statedWins = reqBool(rubric, "dimension_b.icp.stated_wins");
  const d = deriveIcp(f, rubric);
  const common = { derived: d.icp, step: d.step, firm: d.firm, unknown_fields: d.unknown_fields };
  if (f.icp_class && statedWins) {
    return { icp_class: f.icp_class, derivation: "stated", disagrees: d.icp !== null && d.firm && d.icp !== f.icp_class, ...common };
  }
  if (d.icp) return { icp_class: d.icp, derivation: "derived", disagrees: false, ...common };
  if (f.icp_class) return { icp_class: f.icp_class, derivation: "stated", disagrees: false, ...common };
  return { icp_class: null, derivation: "none", disagrees: false, ...common };
}

/** A direct-to-client row (PRO-4): relationship_type direct or ICP-6. Agency-only rules skip it. */
export function isDirectRow(f: ProspectFeatures, icp: IcpClass | null): boolean {
  return f.relationship_type === "direct" || icp === "ICP-6";
}
