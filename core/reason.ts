/**
 * WLIQ Prospect Book — the one-sentence reason.
 *
 * PURE. Fills rubric.reason_sentence.shape:
 *   "Anticipated {tier} ({confidence}): {icp_class} {agency_type_words}, {qualification words};
 *    ceiling {ceiling} on {headroom_band or 'unknown headroom'}, year one likely {year1_band};
 *    {urgency} — {top signal or 'no live signal'}."
 * and never prints a bare score: no decayed total, no headroom dollars, no wallet.
 */

import type {
  Ceiling,
  Confidence,
  DealHealthRead,
  IcpClass,
  ProspectFeatures,
  ProspectStatus,
  QualificationRead,
  SignalTrace,
  Tier,
  Urgency,
} from "./prospect_types.ts";
import { reqObj, reqStr } from "./classify.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

export interface ReasonParts {
  status: ProspectStatus;
  effective_tier: Tier | null;
  confidence: Confidence | null;
  icp_class: IcpClass | null;
  agency_type: ProspectFeatures["agency_type"];
  relationship_type: ProspectFeatures["relationship_type"];
  qualification: Pick<QualificationRead, "label" | "present_count">;
  ceiling: Ceiling;
  headroom_band: string | null;
  year1_band: string;
  urgency: Urgency;
  top_signal: SignalTrace | null;
  deal_health: DealHealthRead[];
  /** The label of the gate that parked the row, when Parked. */
  parked_on: string | null;
  override_reason_code: string | null;
}

const AGENCY_WORDS: Record<string, string> = {
  full_service: "full-service agency",
  boutique: "boutique agency",
  digital_only: "digital-only agency",
  niche_vertical: "niche vertical agency",
  consultancy: "consultancy",
  direct_end_client: "direct end client",
};

export function agencyTypeWords(p: Pick<ReasonParts, "agency_type" | "relationship_type">): string {
  if (p.agency_type && AGENCY_WORDS[p.agency_type]) return AGENCY_WORDS[p.agency_type];
  if (p.relationship_type === "direct") return "direct-to-client";
  return "agency type unknown";
}

export function qualificationWords(q: Pick<QualificationRead, "label" | "present_count">): string {
  return `${q.label} (${q.present_count} of 4 facts)`;
}

/** The sentence shape is rubric text (reason_sentence.shape); there is no default shape in code. */
export function buildReason(p: ReasonParts, rubric: Rubric): string {
  const shape = reqStr(rubric, "reason_sentence.shape");
  // deno-lint-ignore no-explicit-any
  const catalog = reqObj(rubric, "signals.catalog") as Record<string, any>;
  const topSignal = p.top_signal ? (catalog[p.top_signal.type]?.label ?? p.top_signal.type) : null;

  const fill: Record<string, string> = {
    "{tier}": p.effective_tier ?? "tier withheld",
    "{confidence}": p.confidence ?? "confidence not set",
    "{icp_class}": p.icp_class ?? "no ICP class",
    "{agency_type_words}": agencyTypeWords(p),
    "{qualification words}": qualificationWords(p.qualification),
    "{ceiling}": p.ceiling,
    "{headroom_band or 'unknown headroom'}": p.headroom_band ?? "unknown headroom",
    "{year1_band}": p.year1_band,
    "{urgency}": p.urgency,
    "{top signal or 'no live signal'}": topSignal ?? "no live signal",
  };

  let sentence = shape;
  for (const [k, v] of Object.entries(fill)) sentence = sentence.split(k).join(v);

  // Deal health is omitted when there are no open deals (DESIGN §3).
  if (p.deal_health.length > 0) {
    const order: Record<string, number> = { red: 0, yellow: 1, green: 2 };
    const worst = [...p.deal_health].sort((a, b) => order[a.color] - order[b.color])[0];
    const first = worst.warnings[0]?.message;
    const n = p.deal_health.length;
    sentence = sentence.replace(/\.$/, "") + `; ${n} open deal${n === 1 ? "" : "s"}, worst ${worst.color}${first ? `: ${first.toLowerCase()}` : ""}.`;
  }

  if (p.status === "Parked") sentence = `Parked on ${p.parked_on ?? "a gate"}; grade still computed. ` + sentence;
  else if (p.status === "Unclassified") sentence = `Unclassified: no ICP class stated or derivable. ` + sentence;
  else if (p.status === "Overridden") sentence = `Overridden by the owner (${p.override_reason_code ?? "no code"}). ` + sentence;

  return sentence;
}
