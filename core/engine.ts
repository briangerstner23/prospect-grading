/**
 * WLIQ Prospect Book — the scoring engine.
 *
 * A PURE function: grade(features, rubric, options) → scorecard. No network, no clock, no
 * randomness, no filesystem. The same inputs and the same rubric bytes always produce the
 * same scorecard; the golden fixtures in ../fixtures/golden.json enforce it.
 *
 * Order of work (DESIGN §3): gates → ICP → base tier → adjustments (caps, agency-only
 * exclusion) → qualification → potential → platinum rule → signals → deal health → override
 * → status → effective tier, cell, chase key → flags → reason → trace.
 *
 * Every threshold lives in rubric.prospect.v0.1.json. This file holds control flow only:
 * every number, toggle, band and map is read through the strict reader in ./classify.ts,
 * which throws a RubricError naming the path when the rubric lacks it — a fallback constant
 * here would be a threshold the rubric cannot move, so there are none. A malformed rubric
 * fails loudly at preview; it never grades quietly on a code default.
 * Independent from the Client Book (PRO-17): the same discipline, none of its code.
 */

import type {
  AdjustmentTrace,
  Ceiling,
  Confidence,
  DealHealthRead,
  DealInput,
  EvidenceLabel,
  FactState,
  GateResult,
  GradeOptions,
  IcpClass,
  Override,
  PotentialRead,
  ProspectFeatures,
  ProspectScorecard,
  ProspectStatus,
  QualificationRead,
  SignalsRead,
  Tier,
} from "./prospect_types.ts";
import { CEILING_ORDER, TIER_ORDER, URGENCY_ORDER } from "./prospect_types.ts";
import {
  BASES,
  classifyIcp,
  effectiveEconomics,
  evalWhen,
  evaluateGates,
  gateFlagText,
  isDirectRow,
  reqArr,
  reqBool,
  reqNum,
  reqNumIn,
  reqObj,
  reqOneOf,
  reqOneOfIn,
  reqStr,
  reqStrIn,
  RubricError,
} from "./classify.ts";
import type { WhenContext } from "./classify.ts";
import { computeUrgency, daysBetween, decaySignals, routeTasks } from "./decay.ts";
import { buildReason } from "./reason.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

export { classifyIcp, evaluateGates, gateFlagText, RubricError } from "./classify.ts";
export { computeUrgency, decaySignals, routeTasks } from "./decay.ts";
export { buildReason } from "./reason.ts";

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * Canonical JSON: the same bytes for the same value whatever order its object keys arrive
 * in. Object keys are sorted recursively; arrays keep their order; undefined-valued keys are
 * dropped (as JSON.stringify drops them). The rubric is read from a file in tests and from a
 * jsonb column in production, and jsonb does not preserve key order — so the fingerprint
 * must not depend on it.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((x) => (x === undefined || typeof x === "function" ? "null" : canonicalJson(x))).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Non-cryptographic content fingerprint (FNV-1a, 32-bit, hex) over the CANONICAL JSON of
 * the value. The same hash the Client Book uses, so the two systems' fingerprints are
 * comparable in FORM and never in value. Synchronous so the engine stays pure.
 */
export function fingerprint(value: unknown): string {
  const s = canonicalJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** First band whose [min, max) contains value; bands are declared best-first in the rubric. */
export function pickBand(value: number, bands: Array<{ label: string; min?: number; max?: number }>): string | null {
  for (const b of bands ?? []) {
    const okMin = b.min === undefined || value >= b.min;
    const okMax = b.max === undefined || value < b.max;
    if (okMin && okMax) return b.label;
  }
  return null;
}

function tierAt(i: number): Tier {
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i))];
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

/* ------------------------------------------------------------------ *
 * fit · adjustments
 * ------------------------------------------------------------------ */

function runAdjustments(
  f: ProspectFeatures,
  icp: IcpClass | null,
  rubric: Rubric,
  notes: string[],
): { traces: AdjustmentTrace[]; net_raw: number; net: number } {
  const rules = reqArr<Record<string, unknown>>(rubric, "dimension_b.adjustments.rules");
  const agencyOnly = reqArr<string>(rubric, "dimension_b.adjustments.agency_only_rules");
  const capUp = reqNum(rubric, "dimension_b.adjustments.net_cap_up");
  const capDown = reqNum(rubric, "dimension_b.adjustments.net_cap_down");
  const direct = isDirectRow(f, icp);
  const ctx: WhenContext = { ...(f as unknown as WhenContext), icp_class: icp };

  const traces: AdjustmentTrace[] = [];
  let netRaw = 0;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const path = `dimension_b.adjustments.rules[${i}]`;
    const id = reqStrIn(rubric, r, "id", path);
    const when = reqStrIn(rubric, r, "when", path);
    if (r.direction !== 1 && r.direction !== -1) throw new RubricError(rubric, `${path}.direction`, "1 (up one rung) or -1 (down one rung)", r.direction);
    const direction = r.direction as 1 | -1;
    const basis = reqOneOfIn(rubric, r, "basis", path, BASES);
    const inputs: Record<string, unknown> = {};
    for (const field of when.match(/[a-z_][a-z0-9_.]*(?=\s+(==|!=|>=|<=|>|<|in)\s)/g) ?? []) {
      inputs[field] = ctx[field] === undefined ? null : ctx[field];
    }
    if (direct && agencyOnly.includes(id)) {
      inputs._skipped = "agency-only rule; direct-to-client row (PRO-4)";
      traces.push({ id, name: String(r.name), direction, fired: false, rule_text: when, basis, inputs });
      continue;
    }
    const fired = evalWhen(when, ctx);
    if (fired) netRaw += direction;
    traces.push({ id, name: String(r.name), direction, fired, rule_text: when, basis, inputs });
  }
  if (direct && agencyOnly.length) notes.push("Direct-to-client row: agency-only adjustment rules skipped (PRO-4).");

  const net = Math.max(-capDown, Math.min(capUp, netRaw));
  if (net !== netRaw) notes.push(`Adjustment net ${netRaw > 0 ? "+" : ""}${netRaw} capped to ${net > 0 ? "+" : ""}${net} (net cap +${capUp} / −${capDown}).`);
  return { traces, net_raw: netRaw, net };
}

/* ------------------------------------------------------------------ *
 * qualification
 * ------------------------------------------------------------------ */

function qualify(f: ProspectFeatures, rubric: Rubric, notes: string[]): QualificationRead {
  let timingFact: FactState = f.timing_state ?? "unknown";
  if (timingFact === "unknown" && f.timing) {
    // A stated timing value with no separate fact state: a date is present unless it says there is none.
    timingFact = f.timing === "no_timeline" ? "absent" : "present";
    notes.push(`Timing fact derived from the stated timing '${f.timing}' → ${timingFact}.`);
  }
  const facts = {
    money: f.money ?? "unknown",
    authority: f.authority ?? "unknown",
    timing: timingFact,
    specification: f.specification ?? "unknown",
  };
  const present = Object.values(facts).filter((v) => v === "present").length;
  const labels = reqArr<Record<string, unknown>>(rubric, "dimension_a.labels")
    .map((l, i) => ({
      label: reqStrIn(rubric, l, "label", `dimension_a.labels[${i}]`) as QualificationRead["label"],
      min_present: reqNumIn(rubric, l, "min_present", `dimension_a.labels[${i}]`),
    }))
    .sort((x, y) => y.min_present - x.min_present);
  const hit = labels.find((l) => present >= l.min_present);
  if (!hit) throw new RubricError(rubric, "dimension_a.labels", `a label whose min_present covers ${present} facts present`, labels.map((l) => l.min_present));
  return { facts, present_count: present, label: hit.label, timing: f.timing ?? null };
}

/* ------------------------------------------------------------------ *
 * confidence rules (shared by fit and potential)
 * ------------------------------------------------------------------ */

const CONFIDENCE_WORDS = ["High", "Medium", "Low"] as const;

/**
 * Walk a rubric confidence ladder (`[{label, when} …, {label, otherwise: true}]`) top to
 * bottom; the first rule whose `when` holds names the confidence. `when` may join
 * alternatives with ` OR `. The ladder must end in an `otherwise` rule — there is no code
 * default for confidence.
 */
function confidenceFrom(rubric: Rubric, path: string, ctx: WhenContext): Confidence {
  const rules = reqArr<Record<string, unknown>>(rubric, path);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const label = reqOneOfIn(rubric, rule, "label", `${path}[${i}]`, CONFIDENCE_WORDS);
    if (rule.otherwise === true) return label;
    const expr = reqStrIn(rubric, rule, "when", `${path}[${i}]`);
    const ok = expr.includes(" OR ") ? expr.split(" OR ").some((part) => evalWhen(part, ctx)) : evalWhen(expr, ctx);
    if (ok) return label;
  }
  throw new RubricError(rubric, path, "a ladder ending in an { otherwise: true } rule", rules.map((r) => r.label));
}

/* ------------------------------------------------------------------ *
 * potential
 * ------------------------------------------------------------------ */

/** Upper bound of a revenue band string like "1-5M" / "<1M" in dollars; null for open-ended (">25M"). */
function revenueBandMax(band: string | null): number | null {
  if (!band || band.startsWith(">")) return null;
  const nums = band.match(/\d+(\.\d+)?/g);
  if (!nums || !nums.length) return null;
  return Number(nums[nums.length - 1]) * 1_000_000;
}

function potentialOf(
  f: ProspectFeatures,
  icp: IcpClass | null,
  rubric: Rubric,
  notes: string[],
  flags: Set<string>,
): PotentialRead {
  const archetype: string = f.archetype ?? reqStr(rubric, "potential.revenue_per_head_usd.default");
  const revenuePerHead = reqNum(rubric, `potential.revenue_per_head_usd.${archetype}`);
  if (!f.archetype) notes.push(`Archetype unknown → revenue per head from the default archetype '${archetype}'.`);

  const outsourceable = reqNum(rubric, `potential.outsourceable_share_by_wl.${f.wl_signal ?? "default"}`);
  if (!f.wl_signal) notes.push("WL signal unknown → default outsourceable share.");

  const serviceable: number = isNum(f.serviceable_share) ? f.serviceable_share : reqNum(rubric, "potential.serviceable_share_default");

  let wallet: number | null = null;
  if (isNum(f.headcount)) {
    wallet = f.headcount * revenuePerHead * outsourceable * serviceable;
  }

  // Full precision drives the math; the reported share is rounded for display only.
  let winnableRaw: number;
  let winnableBasis: PotentialRead["winnable_basis"];
  if (isNum(f.n_vendors) && f.n_vendors > 0 && isNum(f.our_rank) && f.our_rank > 0) {
    winnableRaw = (1 - f.our_rank / (f.n_vendors + 1)) * (2 / f.n_vendors);
    winnableBasis = "wallet_allocation_rule";
  } else {
    winnableRaw = reqNum(rubric, "potential.winnable_share.default_when_unknown");
    winnableBasis = "default";
  }
  const winnable = Math.round(winnableRaw * 10_000) / 10_000;

  const trailing = isNum(f.trailing_12m_revenue) ? f.trailing_12m_revenue : 0;
  const headroom: number | null = wallet === null ? null : Math.round(wallet * winnableRaw - trailing);
  const headroomBands = reqArr<{ label: string; min?: number; max?: number }>(rubric, "potential.headroom_bands");
  const headroomBand = headroom === null ? null : pickBand(headroom, headroomBands);
  if (headroom !== null && headroomBand === null) throw new RubricError(rubric, "potential.headroom_bands", `bands that cover a headroom of ${headroom}`, headroomBands.map((b) => b.label));

  // Revenue-per-head sanity note (audit only): the band's most generous reading still falls short.
  const warnBelow = reqNum(rubric, "potential.revenue_per_head_warning_below");
  if (isNum(f.headcount) && f.headcount > 0) {
    const max = revenueBandMax(f.revenue_band);
    if (max !== null && max / f.headcount < warnBelow) {
      notes.push(`Implied revenue per head (revenue band ${f.revenue_band} over ${f.headcount} people) is below the $${warnBelow} warning line; wallet may be overstated.`);
    }
  }

  // Ceiling: headroom band → ceiling; when headroom is unknown a stated ceiling may stand in.
  let proposed: Ceiling | null = null;
  const statedStandsIn = reqBool(rubric, "potential.stated_ceiling_wins_when_headroom_unknown");
  if (headroomBand) {
    // Band labels are authored text ("≥ $100K"), so look the key up directly rather than through a dotted path.
    const fromHeadroom = reqObj(rubric, "potential.ceiling_from_headroom");
    proposed = reqOneOfIn(rubric, fromHeadroom, headroomBand, "potential.ceiling_from_headroom", CEILING_ORDER);
    if (f.stated_ceiling && f.stated_ceiling !== proposed) notes.push(`Stated ceiling ${f.stated_ceiling} noted; headroom is known so it does not stand in.`);
  } else if (f.stated_ceiling && statedStandsIn) {
    proposed = f.stated_ceiling;
    notes.push(`Headroom unknown → stated ceiling ${f.stated_ceiling} stands in (inferred).`);
  }

  // Climb evidence: rubric names, aliases mapped; unrecognised strings are noted, never counted.
  const canonical = reqArr<string>(rubric, "potential.climb_evidence.signals");
  const aliases = reqObj(rubric, "potential.climb_evidence.aliases") as Record<string, string>;
  const climb: string[] = [];
  for (const raw of f.climb_signals ?? []) {
    const name = aliases[raw] ?? raw;
    if (canonical.includes(name)) { if (!climb.includes(name)) climb.push(name); }
    else notes.push(`Climb signal '${raw}' is not in the rubric list; not counted.`);
  }
  climb.sort();

  let ceiling: Ceiling = "Project";
  let cappedReason: string | null = null;
  if (proposed === null) {
    notes.push("Ceiling defaults to Project: headroom unknown and no stated ceiling.");
  } else if (CEILING_ORDER.indexOf(proposed) > 0 && climb.length === 0) {
    ceiling = "Project";
    cappedReason = "no climb evidence";
    flags.add("Ceiling capped: no climb evidence");
  } else {
    ceiling = proposed;
  }

  // Year one: quote when present, else the ICP prior band, else unknown.
  let year1Band = "unknown";
  let year1Basis: PotentialRead["year1_basis"] = "unknown";
  const quoteWins = reqBool(rubric, "potential.year1_from_quote_when_present");
  const year1Bands = reqArr<{ label: string; min?: number; max?: number }>(rubric, "potential.year1_bands");
  if (quoteWins && isNum(f.quote_amount) && f.quote_amount > 0) {
    const band = pickBand(f.quote_amount, year1Bands);
    if (band === null) throw new RubricError(rubric, "potential.year1_bands", `bands that cover a quote of ${f.quote_amount}`, year1Bands.map((b) => b.label));
    year1Band = band;
    year1Basis = "quote";
  } else if (icp) {
    year1Band = reqStr(rubric, `potential.year1_icp_prior_band.map.${icp}`);
    year1Basis = "icp_prior";
  }

  // Confidence, from the rubric's rules (headcount must be known for a label to count).
  const cctx: WhenContext = {
    headcount: f.headcount,
    headcount_label: isNum(f.headcount) ? f.headcount_label : "unknown",
    wl_signal: f.wl_signal,
    stated_ceiling: f.stated_ceiling,
  };
  const confidence = confidenceFrom(rubric, "potential.confidence.rules", cctx);

  return {
    wallet: wallet === null ? null : Math.round(wallet),
    winnable_share: winnable,
    winnable_basis: winnableBasis,
    headroom,
    headroom_band: headroomBand,
    ceiling_proposed: proposed,
    ceiling,
    ceiling_capped_reason: cappedReason,
    climb_evidence: climb,
    year1_band: year1Band,
    year1_basis: year1Basis,
    confidence,
    inputs: {
      headcount: f.headcount,
      archetype,
      revenue_per_head: revenuePerHead,
      wl_signal: f.wl_signal,
      outsourceable_share: outsourceable,
      serviceable_share: serviceable,
      n_vendors: f.n_vendors,
      our_rank: f.our_rank,
      trailing_12m_revenue: trailing,
      quote_amount: f.quote_amount,
      stated_ceiling: f.stated_ceiling,
    },
  };
}

/* ------------------------------------------------------------------ *
 * deal health
 * ------------------------------------------------------------------ */

/** A deal as deal health reads it — DealInput, with its optional `has_next_meeting` (see prospect_types.ts). */
export type DealHealthInput = DealInput;

/**
 * true = a next meeting is booked; false = KNOWN not booked; null = unknown.
 *
 * `next_meeting_at` alone cannot separate "none is booked" from "the activities were never
 * read" (the ingest maps a missing Pipedrive activity to null either way), so:
 *   - a parseable next_meeting_at at or after as_of is a booking, whatever the flag says;
 *   - a next_meeting_at already in the past is a known absence only when has_next_meeting
 *     is not null (the activities were read, and the booking has passed);
 *   - with no usable date, has_next_meeting carries the state: true (booked, undated),
 *     false (read, none booked), null / absent (unknown — `unknown_never_warns`).
 */
function nextMeetingBooked(d: DealHealthInput, asOf: string): boolean | null {
  const known = d.has_next_meeting === true || d.has_next_meeting === false;
  const at = typeof d.next_meeting_at === "string" ? Date.parse(d.next_meeting_at) : Number.NaN;
  const asOfMs = Date.parse(asOf);
  if (Number.isFinite(at) && Number.isFinite(asOfMs)) {
    if (at >= asOfMs) return true;
    return known ? false : null;
  }
  return known ? (d.has_next_meeting as boolean) : null;
}

type DealCtx = {
  d: DealHealthInput;
  days_since_touch: number | null;
  days_in_stage: number | null;
  median: number;
  next_meeting: boolean | null;
};

type DealParams = Record<string, number>;

/**
 * The thresholds each deal-health rule needs, by name. Every one must sit in the rule's
 * `params: { name: number }` in the rubric; the rule's prose `test` is documentation of the
 * same rule and is never parsed. A rule whose params are incomplete is a RubricError — the
 * rubric, not the engine, states every threshold.
 */
const DEAL_PARAM_NAMES: Record<string, string[]> = {
  "DH-DARK": ["min_days_dark"],
  "DH-PUSHES": ["min_pushes", "max_push_days"],
  "DH-STALLED": ["median_multiple"],
  "DH-NO-DM": ["min_calls"],
  "DH-INDECISION": [],
  "DH-QUIET": ["min_days", "max_days"],
  "DH-PUSHED": ["min_pushes", "max_pushes"],
  "DH-NO-NEXT": [],
  "DH-NO-PRICE": ["min_calls"],
  "DH-THIN": ["min_contacts"],
  "DH-VELOCITY": ["max_emails"],
  "DH-NO-CRITICAL": ["min_calls"],
};

/** Resolve one known rule's parameters from its `params` in the rubric. Strict: every named threshold must be a number. */
function dealRuleParams(rubric: Rubric, rule: Record<string, unknown>, id: string, path: string): DealParams {
  const names = DEAL_PARAM_NAMES[id] ?? [];
  const structured = rule.params;
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
    throw new RubricError(rubric, `${path}.params`, `an object naming this rule's thresholds (${names.length ? names.join(", ") : "none needed, so {}"})`, structured);
  }
  const params: DealParams = {};
  for (const name of names) params[name] = reqNumIn(rubric, structured as Record<string, unknown>, name, `${path}.params`);
  return params;
}

/**
 * Rule evaluators keyed by rubric id; every threshold arrives in `p` from the rubric.
 * `unknown_never_warns`: every evaluator returns false when an input it needs is null.
 */
const DEAL_RULES: Record<string, (c: DealCtx, p: DealParams) => boolean> = {
  "DH-DARK": (c, p) => c.days_since_touch !== null && c.days_since_touch >= p.min_days_dark && c.next_meeting === false,
  "DH-PUSHES": (c, p) => (isNum(c.d.close_date_pushes) && c.d.close_date_pushes >= p.min_pushes) || (isNum(c.d.largest_push_days) && c.d.largest_push_days > p.max_push_days),
  "DH-STALLED": (c, p) => c.days_in_stage !== null && c.days_in_stage > p.median_multiple * c.median,
  "DH-NO-DM": (c, p) => c.d.decision_maker_engaged === false && isNum(c.d.calls_held) && c.d.calls_held >= p.min_calls,
  "DH-INDECISION": (c) => c.d.indecision_level === "high" || (c.d.risk_words_present === true && c.next_meeting === false),
  "DH-QUIET": (c, p) => c.days_since_touch !== null && c.days_since_touch >= p.min_days && c.days_since_touch <= p.max_days,
  "DH-PUSHED": (c, p) => isNum(c.d.close_date_pushes) && c.d.close_date_pushes >= p.min_pushes && c.d.close_date_pushes <= p.max_pushes,
  "DH-NO-NEXT": (c) => c.next_meeting === false,
  "DH-NO-PRICE": (c, p) => c.d.price_discussed === false && isNum(c.d.calls_held) && c.d.calls_held >= p.min_calls,
  "DH-THIN": (c, p) => isNum(c.d.buyer_contacts_30d) && c.d.buyer_contacts_30d < p.min_contacts,
  "DH-VELOCITY": (c, p) => isNum(c.d.buyer_email_velocity_7d) && c.d.buyer_email_velocity_7d <= p.max_emails,
  "DH-NO-CRITICAL": (c, p) => c.d.critical_event_captured === false && isNum(c.d.calls_held) && c.d.calls_held >= p.min_calls,
};

/**
 * Deal health per open deal. `notes`, when given, receives the audit trail: the thresholds
 * used (all from the rubric's `params`), and any rubric rule this engine has no evaluator
 * for (recorded, not evaluated). A known rule with a missing threshold is a RubricError.
 */
export function dealHealth(deals: DealHealthInput[], asOf: string, rubric: Rubric, notes?: string[]): DealHealthRead[] {
  const defaultMedian = reqNum(rubric, "deal_health.default_stage_median_days");
  const list = deals ?? [];
  const out: DealHealthRead[] = [];

  // Resolve every rule once: id, severity, message, evaluator, params.
  type Resolved = { id: string; severity: "red" | "yellow"; message: string; ev: ((c: DealCtx, p: DealParams) => boolean) | null; params: DealParams };
  const resolved: Resolved[] = [];
  const paramNotes: string[] = [];
  const skipped: string[] = [];
  for (const [severity, key] of [["red", "red_when_any"], ["yellow", "yellow_when_any"]] as Array<["red" | "yellow", string]>) {
    const rules = reqArr<Record<string, unknown>>(rubric, `deal_health.${key}`);
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      const path = `deal_health.${key}[${i}]`;
      const id = reqStrIn(rubric, r, "id", path);
      const message = reqStrIn(rubric, r, "message", path);
      reqStrIn(rubric, r, "test", path);
      const ev = DEAL_RULES[id] ?? null;
      const params = ev === null ? {} : dealRuleParams(rubric, r, id, path);
      if (ev === null) skipped.push(`${id}: no evaluator for this rule id`);
      else if (Object.keys(params).length) paramNotes.push(`${id} ${Object.entries(params).map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`);
      resolved.push({ id, severity, message, ev, params });
    }
  }
  if (notes && list.length) {
    if (paramNotes.length) notes.push(`Deal-health thresholds from the rubric — ${paramNotes.join("; ")}; stage median default ${fmt(defaultMedian)} days.`);
    for (const s of skipped) notes.push(`Deal-health rule ${s}; rule not evaluated.`);
  }

  for (const d of list) {
    const median = isNum(d.stage_median_days) ? d.stage_median_days : defaultMedian;
    const c: DealCtx = {
      d,
      days_since_touch: d.last_buyer_touch_at ? daysBetween(d.last_buyer_touch_at, asOf) : null,
      days_in_stage: d.stage_entered_at ? daysBetween(d.stage_entered_at, asOf) : null,
      median,
      next_meeting: nextMeetingBooked(d, asOf),
    };
    const warnings: DealHealthRead["warnings"] = [];
    for (const r of resolved) {
      if (r.ev === null) continue;
      if (r.ev(c, r.params)) warnings.push({ id: r.id, severity: r.severity, message: r.message });
    }
    const color: DealHealthRead["color"] = warnings.some((w) => w.severity === "red") ? "red" : warnings.length ? "yellow" : "green";
    out.push({ deal_id: d.deal_id, title: d.title ?? null, color, warnings });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * grade
 * ------------------------------------------------------------------ */

export function grade(features: ProspectFeatures, rubric: Rubric, options: GradeOptions = {}): ProspectScorecard {
  const f = features;
  const asOf = f.as_of;
  const notes: string[] = [];
  const flags = new Set<string>();
  const version = reqStr(rubric, "version");
  const validation = reqOneOf(rubric, "validation.status", ["UNVALIDATED", "VALIDATED"] as const);

  /* 1 · gates */
  const gates: GateResult[] = evaluateGates(f, rubric);
  const parkedGate = gates.find((g) => g.mode === "park" && g.result === "fail") ?? null;
  for (const g of gates) {
    // Any gate toggled to mode `flag` flags on failure, with the gate item's `flag` text
    // (broker character → "Broker character flag", geography → "Geography flag").
    if (g.mode === "flag" && g.result === "fail") flags.add(gateFlagText(rubric, g.id));
  }
  if (f.service_shape === null || f.service_shape === undefined) flags.add("Service shape unknown");
  if (effectiveEconomics(f, rubric).value === null) flags.add("Economics unknown");

  /* 2 · ICP */
  const icp = classifyIcp(f, rubric);
  if (icp.disagrees) {
    flags.add("ICP disagrees with derivation");
    notes.push(`Stated ${icp.icp_class} stands; the flow derives ${icp.derived} (step ${icp.step}).`);
  }
  if (icp.derivation === "stated" && icp.derived && icp.derived !== icp.icp_class && !icp.firm) {
    notes.push(`Stated ${icp.icp_class} stands; the flow would reach ${icp.derived} only because ${icp.unknown_fields.join(", ")} is unknown — not a disagreement.`);
  }
  if (icp.derivation === "derived") {
    notes.push(`ICP ${icp.icp_class} derived at step ${icp.step} of the classification flow${icp.firm ? "" : ` (tentative: ${icp.unknown_fields.join(", ")} unknown)`}.`);
  }
  if (icp.derivation === "none") notes.push("No ICP class stated and none derivable from the facts → Unclassified.");
  const icpLabel: EvidenceLabel = icp.derivation === "stated" ? (f.icp_class_label ?? "inferred") : icp.derivation === "derived" ? "inferred" : "unknown";

  /* 3 · base tier */
  const baseTier: Tier | null = icp.icp_class ? reqOneOf(rubric, `dimension_b.base_tier_from_icp.map.${icp.icp_class}`, TIER_ORDER) : null;

  /* 4 · adjustments */
  const adj = runAdjustments(f, icp.icp_class, rubric, notes);
  let adjustedTier: Tier | null = null;
  if (baseTier) {
    const never = reqOneOf(rubric, "dimension_b.adjustments.adjustments_never_reach", TIER_ORDER);
    const ceilingIdx = TIER_ORDER.indexOf(never) - 1;
    const raw = TIER_ORDER.indexOf(baseTier) + adj.net;
    const idx = Math.min(raw, Math.max(ceilingIdx, TIER_ORDER.indexOf(baseTier)));
    adjustedTier = tierAt(idx);
    if (raw > idx) notes.push(`Adjustments never reach ${never}; adjusted tier held at ${adjustedTier}.`);
  }

  /* 5 · qualification */
  const qualification = qualify(f, rubric, notes);

  /* 6 · potential */
  const potential = potentialOf(f, icp.icp_class, rubric, notes, flags);

  /* 7 · platinum rule */
  const requiresAll = reqArr<Record<string, unknown>>(rubric, "dimension_b.platinum_rule.requires_all");
  if (requiresAll.length === 0) throw new RubricError(rubric, "dimension_b.platinum_rule.requires_all", "at least one requirement", requiresAll);
  const prCtx: WhenContext = {
    adjusted_tier: adjustedTier,
    potential: { ceiling: potential.ceiling },
    qualification: { present_count: qualification.present_count },
  };
  const prReasons: string[] = [];
  let prMet = adjustedTier !== null;
  for (let i = 0; i < requiresAll.length; i++) {
    const path = `dimension_b.platinum_rule.requires_all[${i}]`;
    const test = reqStrIn(rubric, requiresAll[i], "test", path);
    const why = reqStrIn(rubric, requiresAll[i], "reason", path);
    if (!evalWhen(test, prCtx)) { prMet = false; prReasons.push(`not met: ${why} (${test})`); }
  }
  const computedTier: Tier | null = adjustedTier === null ? null : prMet ? "Platinum" : adjustedTier;

  /* fit confidence */
  let fitConfidence: Confidence | null = null;
  let fitConfidenceReason = "No ICP class: confidence not set.";
  if (icp.icp_class) {
    const cctx: WhenContext = { icp_class_label: icpLabel, qualification: { present_count: qualification.present_count } };
    fitConfidence = confidenceFrom(rubric, "dimension_b.confidence.rules", cctx);
    const rules = reqArr<Record<string, unknown>>(rubric, "dimension_b.confidence.rules");
    const matched = rules.find((r) => r.label === fitConfidence);
    const why = matched && typeof matched.when === "string" ? matched.when : "No higher rule matched.";
    fitConfidenceReason = `icp_class_label ${icpLabel}, ${qualification.present_count} of 4 facts present → ${fitConfidence}: ${why}`;
  }

  /* 8 · signals */
  const decayed = decaySignals(f.signals ?? [], asOf, rubric);
  const urg = computeUrgency(f.timing ?? null, decayed, rubric);
  const tasks = routeTasks(f.signals ?? [], asOf, rubric);
  // deno-lint-ignore no-explicit-any
  const catalog = reqObj(rubric, "signals.catalog") as Record<string, any>;
  for (const t of decayed.traces) {
    const flag = catalog[t.type]?.flag;
    if (typeof flag === "string" && t.weight_now !== 0) flags.add(flag);
  }
  for (const n of decayed.notes) notes.push(n);
  const signals: SignalsRead = {
    decayed_total: decayed.total,
    top: decayed.top,
    negatives: decayed.negatives,
    urgency: urg.urgency,
    urgency_basis: urg.basis,
    tasks,
  };

  /* 9 · deal health */
  const deal_health = dealHealth(f.deals ?? [], asOf, rubric, notes);

  /* 10 · override — every term of the contract is rubric.override, read strictly */
  const ov = options?.override ?? null;
  const maxMoved = reqNum(rubric, "override.max_tiers_moved");
  const codes = reqArr<string>(rubric, "override.reason_codes");
  const codeRequired = reqBool(rubric, "override.reason_code_required");
  // July (ruled, quoted in rubric.override.ruling): "one grade max, written reason required".
  const reasonRequired = reqBool(rubric, "override.written_reason_required");
  const expiryDefaultDays = reqNum(rubric, "override.expiry_default_days");
  const expiresSoonDays = reqNum(rubric, "override.expires_soon_days");
  let applied: Override | null = null;
  if (ov) {
    const hasApprover = typeof ov.approver === "string" && ov.approver.trim().length > 0;
    const codeGiven = typeof ov.reason_code === "string" && ov.reason_code.trim().length > 0;
    const codeOk = codeGiven ? codes.includes(ov.reason_code) : !codeRequired;
    const hasReason = typeof ov.reason === "string" && ov.reason.trim().length > 0;

    // Expiry: a stated expires_at; else set_at + rubric.override.expiry_default_days; else none.
    let expiresAt: string | null = null;
    let expirySource: "stated" | "derived" | "none" = "none";
    if (typeof ov.expires_at === "string" && ov.expires_at.trim().length > 0) {
      if (Number.isFinite(Date.parse(ov.expires_at))) { expiresAt = ov.expires_at; expirySource = "stated"; }
      else notes.push(`Override expires_at '${ov.expires_at}' is not a date; treated as no expiry.`);
    } else if (typeof ov.set_at === "string") {
      const setMs = Date.parse(ov.set_at);
      if (Number.isFinite(setMs)) {
        expiresAt = new Date(setMs + expiryDefaultDays * 86_400_000).toISOString();
        expirySource = "derived";
      } else notes.push(`Override set_at '${ov.set_at}' is not a date; no expiry could be derived.`);
    }
    const asOfMs = Date.parse(asOf);
    const expired = expiresAt !== null && Number.isFinite(asOfMs) && Date.parse(expiresAt) < asOfMs;

    if (!hasApprover) {
      notes.push("Override ignored: an approver is required.");
    } else if (!codeOk) {
      notes.push(codeGiven
        ? `Override ignored: reason code '${ov.reason_code}' is not one of ${codes.join(", ")}.`
        : "Override ignored: a reason code is required (rubric.override.reason_code_required).");
    } else if (reasonRequired && !hasReason) {
      notes.push("Override ignored: a written reason is required (July, ruled).");
    } else if (expired) {
      notes.push(`Override expired ${expiresAt}${expirySource === "derived" ? ` (set_at ${ov.set_at} + ${expiryDefaultDays} days)` : ""}; computed tier stands.`);
    } else if (computedTier === null) {
      notes.push("Override ignored: no computed tier to move from (Unclassified).");
    } else if (!TIER_ORDER.includes(ov.tier)) {
      notes.push(`Override ignored: '${String(ov.tier)}' is not a tier.`);
    } else if (Math.abs(TIER_ORDER.indexOf(ov.tier) - TIER_ORDER.indexOf(computedTier)) > maxMoved) {
      flags.add("Override refused: beyond one-tier cap");
      notes.push(`Override to ${ov.tier} refused: more than ${maxMoved} tier from computed ${computedTier}.`);
    } else {
      applied = expirySource === "derived" ? { ...ov, expires_at: expiresAt } : ov;
      notes.push(`Override applied: ${computedTier} → ${ov.tier} (${ov.reason_code ?? "no code"}, ${ov.approver}).`);
      if (expirySource === "derived") notes.push(`Override expiry derived: set_at ${ov.set_at} + ${expiryDefaultDays} days → ${expiresAt}.`);
      if (expiresAt === null) {
        notes.push("Override has no expiry: no expires_at, and no set_at to derive one from.");
      } else {
        const left = daysBetween(asOf, expiresAt);
        if (left !== null && left <= expiresSoonDays) flags.add("Override expires soon");
      }
    }
  }

  /* 11 · status */
  let status: ProspectStatus;
  if (parkedGate) status = "Parked";
  else if (icp.icp_class === null) status = "Unclassified";
  else if (applied) status = "Overridden";
  else status = "Ranked";
  if (parkedGate) notes.push(`Parked on ${parkedGate.label}; the grade is still computed and stored (PRO-0).`);

  /* 12 · effective tier, cell, chase key */
  let effectiveTier: Tier | null = applied ? applied.tier : computedTier;
  const minFacts = reqNum(rubric, "dimension_a.min_facts_to_publish_tier");
  if (minFacts > 0 && qualification.present_count < minFacts && effectiveTier !== null) {
    notes.push(`Tier withheld: ${qualification.present_count} of 4 facts present, below min_facts_to_publish_tier ${minFacts}.`);
    effectiveTier = null;
    flags.add("Conversation only");
  }
  const cell = effectiveTier ? `${effectiveTier} × ${potential.ceiling}` : null;

  const year1Bands = reqArr<{ label: string }>(rubric, "potential.year1_bands");
  const y1Idx = year1Bands.findIndex((b) => b.label === potential.year1_band);
  const y1Rank = y1Idx < 0 ? -1 : year1Bands.length - 1 - y1Idx;
  const chase_rank_key: ProspectScorecard["chase_rank_key"] = [
    effectiveTier ? -TIER_ORDER.indexOf(effectiveTier) : 1,
    -qualification.present_count,
    -URGENCY_ORDER.indexOf(signals.urgency),
    -y1Rank,
    f.name,
  ];

  /* 13 · flags */
  if (validation === "UNVALIDATED") flags.add("UNVALIDATED (PRO-8)");
  if (f.relationship_type === "direct" || icp.icp_class === "ICP-6") flags.add("Direct-to-client");
  if (f.roster_certified === false) flags.add("Roster source uncertified");
  if (f.lineage === "lapsed_client") flags.add("Lapsed client");
  if (!isNum(f.headcount)) flags.add("Headcount unknown");
  if (computedTier) {
    for (const pg of f.prior_grades ?? []) {
      const v = typeof pg.value === "string" ? pg.value.trim() : "";
      if ((TIER_ORDER as readonly string[]).includes(v) && v !== computedTier) {
        flags.add("Prior grade differs");
        notes.push(`Prior grade ${v} (${pg.source}) differs from computed ${computedTier}.`);
      }
    }
  }
  const flagList = [...flags].sort();

  /* 14 · reason */
  const reason = buildReason({
    status,
    effective_tier: effectiveTier,
    confidence: fitConfidence,
    icp_class: icp.icp_class,
    agency_type: f.agency_type,
    relationship_type: f.relationship_type,
    qualification,
    ceiling: potential.ceiling,
    headroom_band: potential.headroom_band,
    year1_band: potential.year1_band,
    urgency: signals.urgency,
    top_signal: signals.top[0] ?? null,
    deal_health,
    parked_on: parkedGate?.label ?? null,
    override_reason_code: applied?.reason_code ?? null,
  }, rubric);

  /* 15 · trace */
  const firedIds = adj.traces.filter((t) => t.fired).map((t) => `${t.id} ${t.direction > 0 ? "+1" : "−1"}`);
  const tierReasoning = [
    icp.icp_class ? `${icp.icp_class} (${icp.derivation}) → base ${baseTier}` : "no ICP class → no base tier",
    baseTier ? `adjustments ${firedIds.length ? firedIds.join(", ") : "none fired"} → net ${adj.net > 0 ? "+" : ""}${adj.net}${adj.net !== adj.net_raw ? ` (raw ${adj.net_raw > 0 ? "+" : ""}${adj.net_raw}, capped)` : ""} → adjusted ${adjustedTier}` : null,
    baseTier ? `platinum rule ${prMet ? "met" : "not met"}${prReasons.length ? ` (${prReasons.join("; ")})` : ""} → computed ${computedTier}` : null,
    applied ? `override → ${applied.tier}` : null,
    `effective ${effectiveTier ?? "none"}; status ${status}`,
  ].filter((x): x is string => typeof x === "string").join("; ") + ".";

  if (potential.headroom !== null) {
    notes.push(`Headroom audit: wallet ${fmt(potential.wallet ?? 0)} × winnable ${fmt(potential.winnable_share ?? 0)} (${potential.winnable_basis}) − trailing ${fmt(f.trailing_12m_revenue ?? 0)} = ${fmt(potential.headroom)} → band ${potential.headroom_band}.`);
  }
  notes.push(`Signals: decayed total ${fmt(decayed.total)} over ${decayed.traces.length} signal(s); urgency ${signals.urgency} (${signals.urgency_basis}); ${tasks.length} task(s).`);

  return {
    account_id: f.account_id,
    name: f.name,
    rubric_version: version,
    rubric_fingerprint: fingerprint(rubric),
    as_of: asOf,
    anticipated: true,
    validation,
    status,
    gates,
    fit: {
      icp_class: icp.icp_class,
      icp_derivation: icp.derivation,
      base_tier: baseTier,
      adjustments: adj.traces,
      net_adjustment: adj.net,
      adjusted_tier: adjustedTier,
      platinum_rule: { met: prMet, reasons: prReasons },
      computed_tier: computedTier,
      confidence: fitConfidence,
      confidence_reason: fitConfidenceReason,
    },
    qualification,
    potential,
    signals,
    deal_health,
    override: applied,
    effective_tier: effectiveTier,
    cell,
    chase_rank_key,
    flags: flagList,
    reason,
    trace: { tier_reasoning: tierReasoning, notes },
  };
}
