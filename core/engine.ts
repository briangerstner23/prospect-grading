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
 * Every threshold lives in rubric.prospect.v0.1.json. This file holds control flow only.
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
  FitRead,
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
import { classifyIcp, effectiveEconomics, evalWhen, evaluateGates, isDirectRow } from "./classify.ts";
import type { WhenContext } from "./classify.ts";
import { computeUrgency, daysBetween, decaySignals, routeTasks } from "./decay.ts";
import { buildReason } from "./reason.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

export { classifyIcp, evaluateGates } from "./classify.ts";
export { computeUrgency, decaySignals, routeTasks } from "./decay.ts";
export { buildReason } from "./reason.ts";

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * Non-cryptographic content fingerprint (FNV-1a, 32-bit, hex). The same helper the Client
 * Book uses, so the two systems' fingerprints are comparable in FORM and never in value.
 * Synchronous so the engine stays pure.
 */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
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
  const a = rubric?.dimension_b?.adjustments ?? {};
  const rules: Array<Record<string, unknown>> = Array.isArray(a.rules) ? a.rules : [];
  const agencyOnly: string[] = Array.isArray(a.agency_only_rules) ? a.agency_only_rules : [];
  const direct = isDirectRow(f, icp);
  const ctx: WhenContext = { ...(f as unknown as WhenContext), icp_class: icp };

  const traces: AdjustmentTrace[] = [];
  let netRaw = 0;
  for (const r of rules) {
    const id = String(r.id);
    const when = String(r.when ?? "");
    const direction = (r.direction === -1 ? -1 : 1) as 1 | -1;
    const basis = (r.basis as AdjustmentTrace["basis"]) ?? "reasoned";
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

  const capUp = isNum(a.net_cap_up) ? a.net_cap_up : 1;
  const capDown = isNum(a.net_cap_down) ? a.net_cap_down : 1;
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
  const labels: Array<{ label: QualificationRead["label"]; min_present: number }> = [...(rubric?.dimension_a?.labels ?? [])]
    .sort((x, y) => y.min_present - x.min_present);
  let label: QualificationRead["label"] = "Conversation";
  for (const l of labels) {
    if (present >= l.min_present) { label = l.label; break; }
  }
  return { facts, present_count: present, label, timing: f.timing ?? null };
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
  const p = rubric?.potential ?? {};
  const rph = p.revenue_per_head_usd ?? {};
  const archetype = f.archetype ?? (rph.default as string) ?? "blended";
  const revenuePerHead: number | null = isNum(rph[archetype]) ? rph[archetype] : null;
  if (!f.archetype) notes.push(`Archetype unknown → revenue per head from the default archetype '${archetype}'.`);

  const osb = p.outsourceable_share_by_wl ?? {};
  const outsourceable: number | null = f.wl_signal && isNum(osb[f.wl_signal]) ? osb[f.wl_signal] : isNum(osb.default) ? osb.default : null;
  if (!f.wl_signal) notes.push("WL signal unknown → default outsourceable share.");

  const serviceable: number | null = isNum(f.serviceable_share) ? f.serviceable_share : isNum(p.serviceable_share_default) ? p.serviceable_share_default : null;

  let wallet: number | null = null;
  if (isNum(f.headcount) && isNum(revenuePerHead) && isNum(outsourceable) && isNum(serviceable)) {
    wallet = f.headcount * revenuePerHead * outsourceable * serviceable;
  }

  let winnable: number;
  let winnableBasis: PotentialRead["winnable_basis"];
  if (isNum(f.n_vendors) && f.n_vendors > 0 && isNum(f.our_rank) && f.our_rank > 0) {
    winnable = (1 - f.our_rank / (f.n_vendors + 1)) * (2 / f.n_vendors);
    winnable = Math.round(winnable * 10_000) / 10_000;
    winnableBasis = "wallet_allocation_rule";
  } else {
    winnable = isNum(p.winnable_share?.default_when_unknown) ? p.winnable_share.default_when_unknown : 0.5;
    winnableBasis = "default";
  }

  const trailing = isNum(f.trailing_12m_revenue) ? f.trailing_12m_revenue : 0;
  const headroom: number | null = wallet === null ? null : Math.round(wallet * winnable - trailing);
  const headroomBand = headroom === null ? null : pickBand(headroom, p.headroom_bands ?? []);

  // Revenue-per-head sanity note (audit only): the band's most generous reading still falls short.
  if (isNum(f.headcount) && f.headcount > 0 && isNum(p.revenue_per_head_warning_below)) {
    const max = revenueBandMax(f.revenue_band);
    if (max !== null && max / f.headcount < p.revenue_per_head_warning_below) {
      notes.push(`Implied revenue per head (revenue band ${f.revenue_band} over ${f.headcount} people) is below the $${p.revenue_per_head_warning_below} warning line; wallet may be overstated.`);
    }
  }

  // Ceiling: headroom band → ceiling; when headroom is unknown a stated ceiling may stand in.
  let proposed: Ceiling | null = null;
  const fromHeadroom = p.ceiling_from_headroom ?? {};
  if (headroomBand && fromHeadroom[headroomBand]) {
    proposed = fromHeadroom[headroomBand] as Ceiling;
    if (f.stated_ceiling && f.stated_ceiling !== proposed) notes.push(`Stated ceiling ${f.stated_ceiling} noted; headroom is known so it does not stand in.`);
  } else if (f.stated_ceiling && p.stated_ceiling_wins_when_headroom_unknown !== false) {
    proposed = f.stated_ceiling;
    notes.push(`Headroom unknown → stated ceiling ${f.stated_ceiling} stands in (inferred).`);
  }

  // Climb evidence: rubric names, aliases mapped; unrecognised strings are noted, never counted.
  const ce = p.climb_evidence ?? {};
  const canonical: string[] = Array.isArray(ce.signals) ? ce.signals : [];
  const aliases: Record<string, string> = ce.aliases ?? {};
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
  if (p.year1_from_quote_when_present !== false && isNum(f.quote_amount) && f.quote_amount > 0) {
    year1Band = pickBand(f.quote_amount, p.year1_bands ?? []) ?? "unknown";
    year1Basis = year1Band === "unknown" ? "unknown" : "quote";
  } else if (icp && p.year1_icp_prior_band?.map?.[icp]) {
    year1Band = p.year1_icp_prior_band.map[icp];
    year1Basis = "icp_prior";
  }

  // Confidence, from the rubric's rules (headcount must be known for a label to count).
  let confidence: Confidence = "Low";
  const cctx: WhenContext = {
    headcount: f.headcount,
    headcount_label: isNum(f.headcount) ? f.headcount_label : "unknown",
    wl_signal: f.wl_signal,
    stated_ceiling: f.stated_ceiling,
  };
  for (const rule of p.confidence?.rules ?? []) {
    if (rule.otherwise) { confidence = rule.label; break; }
    const expr = String(rule.when);
    const ok = expr.includes(" OR ") ? expr.split(" OR ").some((part: string) => evalWhen(part, cctx)) : evalWhen(expr, cctx);
    if (ok) { confidence = rule.label; break; }
  }

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

type DealCtx = {
  d: DealInput;
  days_since_touch: number | null;
  days_in_stage: number | null;
  median: number;
};

/**
 * Rule evaluators keyed by rubric id. The rubric carries each rule's id, prose test and
 * message; the thresholds in the prose are mirrored here. `unknown_never_warns`: every
 * evaluator returns false when an input it needs is null.
 */
const DEAL_RULES: Record<string, (c: DealCtx) => boolean> = {
  "DH-DARK": (c) => c.days_since_touch !== null && c.days_since_touch >= 21 && c.d.next_meeting_at == null,
  "DH-PUSHES": (c) => (isNum(c.d.close_date_pushes) && c.d.close_date_pushes >= 3) || (isNum(c.d.largest_push_days) && c.d.largest_push_days > 21),
  "DH-STALLED": (c) => c.days_in_stage !== null && c.days_in_stage > 2 * c.median,
  "DH-NO-DM": (c) => c.d.decision_maker_engaged === false && isNum(c.d.calls_held) && c.d.calls_held >= 2,
  "DH-INDECISION": (c) => c.d.indecision_level === "high" || (c.d.risk_words_present === true && c.d.next_meeting_at == null),
  "DH-QUIET": (c) => c.days_since_touch !== null && c.days_since_touch >= 14 && c.days_since_touch <= 20,
  "DH-PUSHED": (c) => isNum(c.d.close_date_pushes) && c.d.close_date_pushes >= 1 && c.d.close_date_pushes <= 2,
  "DH-NO-NEXT": (c) => c.d.next_meeting_at == null,
  "DH-NO-PRICE": (c) => c.d.price_discussed === false && isNum(c.d.calls_held) && c.d.calls_held >= 2,
  "DH-THIN": (c) => isNum(c.d.buyer_contacts_30d) && c.d.buyer_contacts_30d < 2,
  "DH-VELOCITY": (c) => c.d.buyer_email_velocity_7d === 0,
  "DH-NO-CRITICAL": (c) => c.d.critical_event_captured === false && isNum(c.d.calls_held) && c.d.calls_held >= 2,
};

export function dealHealth(deals: DealInput[], asOf: string, rubric: Rubric): DealHealthRead[] {
  const dh = rubric?.deal_health ?? {};
  const defaultMedian = isNum(dh.default_stage_median_days) ? dh.default_stage_median_days : 21;
  const out: DealHealthRead[] = [];
  for (const d of deals ?? []) {
    const c: DealCtx = {
      d,
      days_since_touch: d.last_buyer_touch_at ? daysBetween(d.last_buyer_touch_at, asOf) : null,
      days_in_stage: d.stage_entered_at ? daysBetween(d.stage_entered_at, asOf) : null,
      median: isNum(d.stage_median_days) ? d.stage_median_days : defaultMedian,
    };
    const warnings: DealHealthRead["warnings"] = [];
    for (const r of dh.red_when_any ?? []) {
      const ev = DEAL_RULES[r.id];
      if (ev && ev(c)) warnings.push({ id: r.id, severity: "red", message: r.message });
    }
    for (const r of dh.yellow_when_any ?? []) {
      const ev = DEAL_RULES[r.id];
      if (ev && ev(c)) warnings.push({ id: r.id, severity: "yellow", message: r.message });
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
  const version: string = String(rubric?.version ?? "0.0.0");
  const validation: ProspectScorecard["validation"] = rubric?.validation?.status === "VALIDATED" ? "VALIDATED" : "UNVALIDATED";

  /* 1 · gates */
  const gates: GateResult[] = evaluateGates(f, rubric);
  const parkedGate = gates.find((g) => g.mode === "park" && g.result === "fail") ?? null;
  for (const g of gates) {
    if (g.mode === "flag" && g.result === "fail" && g.id === "broker_character") flags.add("Broker character flag");
  }
  if (f.service_shape === null || f.service_shape === undefined) flags.add("Service shape unknown");
  if (effectiveEconomics(f, rubric).value === null) flags.add("Economics unknown");

  /* 2 · ICP */
  const icp = classifyIcp(f, rubric);
  if (icp.disagrees) {
    flags.add("ICP disagrees with derivation");
    notes.push(`Stated ${icp.icp_class} stands; the flow derives ${icp.derived} (step ${icp.step}).`);
  }
  if (icp.derivation === "derived") notes.push(`ICP ${icp.icp_class} derived at step ${icp.step} of the classification flow.`);
  if (icp.derivation === "none") notes.push("No ICP class stated and none derivable from the facts → Unclassified.");
  const icpLabel: EvidenceLabel = icp.derivation === "stated" ? (f.icp_class_label ?? "inferred") : icp.derivation === "derived" ? "inferred" : "unknown";

  /* 3 · base tier */
  const baseMap: Record<string, Tier> = rubric?.dimension_b?.base_tier_from_icp?.map ?? {};
  const baseTier: Tier | null = icp.icp_class ? (baseMap[icp.icp_class] ?? null) : null;

  /* 4 · adjustments */
  const adj = runAdjustments(f, icp.icp_class, rubric, notes);
  let adjustedTier: Tier | null = null;
  if (baseTier) {
    const never = rubric?.dimension_b?.adjustments?.adjustments_never_reach as Tier | undefined;
    const ceilingIdx = never ? TIER_ORDER.indexOf(never) - 1 : TIER_ORDER.length - 1;
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
  const pr = rubric?.dimension_b?.platinum_rule ?? {};
  const prCtx: WhenContext = {
    adjusted_tier: adjustedTier,
    potential: { ceiling: potential.ceiling },
    qualification: { present_count: qualification.present_count },
  };
  const prReasons: string[] = [];
  let prMet = adjustedTier !== null && Array.isArray(pr.requires_all) && pr.requires_all.length > 0;
  for (const req of pr.requires_all ?? []) {
    if (!evalWhen(String(req.test), prCtx)) { prMet = false; prReasons.push(`not met: ${req.reason} (${req.test})`); }
  }
  const computedTier: Tier | null = adjustedTier === null ? null : prMet ? "Platinum" : adjustedTier;

  /* fit confidence */
  let fitConfidence: Confidence | null = null;
  let fitConfidenceReason = "No ICP class: confidence not set.";
  if (icp.icp_class) {
    const cctx: WhenContext = { icp_class_label: icpLabel, qualification: { present_count: qualification.present_count } };
    for (const rule of rubric?.dimension_b?.confidence?.rules ?? []) {
      if (rule.otherwise) { fitConfidence = rule.label; fitConfidenceReason = "No higher rule matched."; break; }
      if (evalWhen(String(rule.when), cctx)) { fitConfidence = rule.label; fitConfidenceReason = String(rule.when); break; }
    }
    fitConfidenceReason = `icp_class_label ${icpLabel}, ${qualification.present_count} of 4 facts present → ${fitConfidence}: ${fitConfidenceReason}`;
  }

  /* 8 · signals */
  const decayed = decaySignals(f.signals ?? [], asOf, rubric);
  const urg = computeUrgency(f.timing ?? null, decayed, rubric);
  const tasks = routeTasks(f.signals ?? [], asOf, rubric);
  const catalog = rubric?.signals?.catalog ?? {};
  for (const t of decayed.traces) {
    const flag = catalog[t.type]?.flag;
    if (typeof flag === "string" && t.weight_now !== 0) flags.add(flag);
  }
  const signals: SignalsRead = {
    decayed_total: decayed.total,
    top: decayed.top,
    negatives: decayed.negatives,
    urgency: urg.urgency,
    urgency_basis: urg.basis,
    tasks,
  };

  /* 9 · deal health */
  const deal_health = dealHealth(f.deals ?? [], asOf, rubric);

  /* 10 · override */
  const ov = options?.override ?? null;
  const ovRules = rubric?.override ?? {};
  const maxMoved = isNum(ovRules.max_tiers_moved) ? ovRules.max_tiers_moved : 1;
  let applied: Override | null = null;
  if (ov) {
    const hasApprover = typeof ov.approver === "string" && ov.approver.trim().length > 0;
    const codes: string[] = Array.isArray(ovRules.reason_codes) ? ovRules.reason_codes : [];
    const hasCode = typeof ov.reason_code === "string" && (codes.length === 0 || codes.includes(ov.reason_code));
    const expired = typeof ov.expires_at === "string" && Date.parse(ov.expires_at) < Date.parse(asOf);
    if (!hasApprover || !hasCode) {
      notes.push("Override ignored: approver and reason_code are both required.");
    } else if (expired) {
      notes.push(`Override expired ${ov.expires_at}; computed tier stands.`);
    } else if (computedTier === null) {
      notes.push("Override ignored: no computed tier to move from (Unclassified).");
    } else if (!TIER_ORDER.includes(ov.tier)) {
      notes.push(`Override ignored: '${String(ov.tier)}' is not a tier.`);
    } else if (Math.abs(TIER_ORDER.indexOf(ov.tier) - TIER_ORDER.indexOf(computedTier)) > maxMoved) {
      flags.add("Override refused: beyond one-tier cap");
      notes.push(`Override to ${ov.tier} refused: more than ${maxMoved} tier from computed ${computedTier}.`);
    } else {
      applied = ov;
      notes.push(`Override applied: ${computedTier} → ${ov.tier} (${ov.reason_code}, ${ov.approver}).`);
      const soonDays = isNum(ovRules.expires_soon_days) ? ovRules.expires_soon_days : 14;
      if (typeof ov.expires_at === "string" && daysBetween(asOf, ov.expires_at) <= soonDays) flags.add("Override expires soon");
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
  const minFacts = isNum(rubric?.dimension_a?.min_facts_to_publish_tier) ? rubric.dimension_a.min_facts_to_publish_tier : 0;
  if (minFacts > 0 && qualification.present_count < minFacts && effectiveTier !== null) {
    notes.push(`Tier withheld: ${qualification.present_count} of 4 facts present, below min_facts_to_publish_tier ${minFacts}.`);
    effectiveTier = null;
    flags.add("Conversation only");
  }
  const cell = effectiveTier ? `${effectiveTier} × ${potential.ceiling}` : null;

  const year1Bands: Array<{ label: string }> = rubric?.potential?.year1_bands ?? [];
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
    icp.icp_class ? `ICP ${icp.icp_class} (${icp.derivation}) → base ${baseTier}` : "no ICP class → no base tier",
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
    } as FitRead,
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
