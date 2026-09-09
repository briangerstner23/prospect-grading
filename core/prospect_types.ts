/**
 * WLIQ Prospect Book — shared types.
 *
 * Zero dependencies by design. The engine in ./engine.ts is a PURE function of
 * (ProspectFeatures, rubric, options) and these are its complete inputs and outputs.
 * Nothing else may influence an anticipated grade.
 *
 * This is an INDEPENDENT system from the Client Book (PRO-17, 2026-09-09). It shares
 * vocabulary with the client engine on purpose (PRO-1r: the same four tier words) and
 * shares code with it never. The two connect at one event only — promotion, confirmed
 * by a person (PRO-10, PRO-18).
 *
 * Feature keys are snake_case because they map 1:1 to `pb_facts.key` in the database.
 */

/** PRO-1r: the client tier words, always printed with the label "anticipated". */
export type Tier = "Platinum" | "Gold" | "Silver" | "Bronze";

/** Worst → best. Index position is the comparison key for caps, bumps and overrides. */
export const TIER_ORDER: readonly Tier[] = ["Bronze", "Silver", "Gold", "Platinum"];

/**
 * Status precedence, evaluated in this order:
 *   Parked      — a gate in `park` mode failed (operational filter; PRO-0: not what the grade is FOR)
 *   Unclassified — no ICP class can be stated or derived, so there is nothing to rank
 *   Overridden  — a tier override is set with a reason code and the owner's name
 *   Ranked      — a computed anticipated tier stands
 */
export type ProspectStatus = "Parked" | "Unclassified" | "Overridden" | "Ranked";

export type IcpClass = "ICP-1" | "ICP-2" | "ICP-3" | "ICP-4" | "ICP-5" | "ICP-6";

export type Ceiling = "Project" | "Embedded" | "Partner";
export const CEILING_ORDER: readonly Ceiling[] = ["Project", "Embedded", "Partner"];

/** July Stage 4 words, kept as the DISPLAY of a computed urgency (research §7). */
export type Urgency = "Super Hot" | "Hot" | "Warm" | "Cold";
export const URGENCY_ORDER: readonly Urgency[] = ["Cold", "Warm", "Hot", "Super Hot"];

export type Confidence = "High" | "Medium" | "Low";

export type WlSignal = "Very High" | "High" | "Medium" | "Low";

export type ServiceShape = "Core" | "Complement" | "Off";

/**
 * Every fact carries a source and an evidence label (Client Book principle, carried over):
 *   evidence — observed in a primary record (site, LinkedIn, Clutch, a call, an email, a quote)
 *   inferred — derived or stated by a person without a primary record
 *   unknown  — absent, with the reason recorded where one exists
 */
export type EvidenceLabel = "evidence" | "inferred" | "unknown";

/** Dimension A item state (PRO-2r): a fact is present, absent, or not yet checked. */
export type FactState = "present" | "absent" | "unknown";

export type Timing = "within_1_week" | "within_1_month" | "within_3_months" | "no_timeline";

export type RelationshipType = "agency" | "direct";

export type Archetype = "production" | "blended" | "strategy";

/**
 * PRO-6: Pipedrive is the roster source of truth; every other list is uncertified intake.
 * A row from an uncertified source is still graded — PRO-8's principle: a grade is
 * labelled, never withheld — and carries the flag until Pipedrive confirms it.
 */
export type RosterSource =
  | "pipedrive"
  | "notion_master"
  | "sales_sheet"
  | "tier1_book"
  | "gotham"
  | "brian_trip"
  | "client_book_lapsed"
  | "manual";

/** A signal as the engine sees it: already resolved from pb_signals, weight and lifespan attached. */
export interface SignalInput {
  type: string;
  observed_at: string; // ISO date
  source: string;
  weight: number;
  /** Days until the signal is worth zero. null = never decays (informational). */
  lifespan_days: number | null;
  /** false = "act now; downgrade, don't decay" negatives and persistent attributes. */
  decays: boolean;
  evidence_url?: string | null;
  payload?: Record<string, unknown>;
}

/** An open Pipedrive deal as the engine sees it (mirrored in pb_deals). */
export interface DealInput {
  deal_id: string;
  title?: string | null;
  stage_name?: string | null;
  stage_entered_at?: string | null;
  /** WLIQ's own median days in this stage, when known. null → rubric default. */
  stage_median_days?: number | null;
  close_date?: string | null;
  close_date_pushes: number;
  largest_push_days?: number | null;
  last_buyer_touch_at?: string | null;
  buyer_email_velocity_7d?: number | null;
  next_meeting_at?: string | null;
  /**
   * The KNOWN state of the next meeting. `next_meeting_at` alone cannot separate "none is
   * booked" from "the activities were never read" (the ingest maps a missing Pipedrive
   * activity to null either way), so the resolver sets this only when the activities were
   * read: true = booked, false = known absent, null / omitted = unknown. Under
   * `unknown_never_warns` the next-meeting rules (DH-NO-NEXT, DH-DARK, DH-INDECISION) fire
   * only on a known absence.
   */
  has_next_meeting?: boolean | null;
  decision_maker_engaged?: boolean | null;
  buyer_contacts_30d?: number | null;
  price_discussed?: boolean | null;
  calls_held?: number | null;
  critical_event_captured?: boolean | null;
  indecision_level?: "low" | "medium" | "high" | null;
  risk_words_present?: boolean | null;
  competitor_named_late?: boolean | null;
}

export interface PriorGrade {
  source: string;
  value: string;
  observed_at?: string | null;
}

/**
 * The exact inputs the engine consumes. Resolved from the latest pb_facts per key, plus
 * signals, deals and prior grades. `as_of` is passed IN — the engine never reads a clock.
 */
export interface ProspectFeatures {
  account_id: string;
  name: string;
  as_of: string; // ISO date; decay and staleness are computed against this

  relationship_type: RelationshipType | null; // PRO-4: direct-to-client in scope, flagged
  roster_source: RosterSource | null;
  roster_certified: boolean; // PRO-6
  lineage: "lapsed_client" | null; // PRO-14 rows arriving from the Client Book at Phase 4

  /* ---- Dimension B · is it work we're good at (PRO-2r) ---- */
  icp_class: IcpClass | null;
  icp_class_label: EvidenceLabel;
  is_agency: boolean | null;
  agency_type:
    | "full_service"
    | "boutique"
    | "digital_only"
    | "niche_vertical"
    | "consultancy"
    | "direct_end_client"
    | null;
  headcount: number | null;
  headcount_label: EvidenceLabel;
  revenue_band: "<1M" | "1-5M" | "5-10M" | "10-25M" | ">25M" | null;
  vertical_depth: "deep_single_vertical" | "generalist" | null;
  wl_signal: WlSignal | null;
  service_shape: ServiceShape | null;
  /** Dimension B economics: accepts real rates at or above the floor. */
  economics: "pass" | "fail" | null;
  deal_size_estimate: number | null;
  hourly_rate_accepted: boolean | null;
  /** PRO-2r-a (open): broker character is never a grading input; it may be a safety flag. */
  broker_character: "pass" | "flag" | null;

  /* ---- Stage 2 adjustment inputs (named rules only; net cap one grade, ruled 2026-07-09) ---- */
  referral_from_network: boolean | null; // Brian / AMI / BABA referral (July rule)
  icp4_vertical_proven: boolean | null; // July rule: ICP-4 in an unproven vertical drops
  recurring_revenue_share: number | null; // 0..1 (research: retainers ≥25–50%)
  niche_positioning: boolean | null;
  am_pm_separated: boolean | null;
  platform_partner_badge: boolean | null;
  peer_network_member: boolean | null;
  ai_posture: "positive" | "neutral" | "negative" | null;
  avg_project_size: number | null; // research: ICP-3 floor at $10K
  already_outsources: boolean | null;
  owner_does_everything: boolean | null;
  inhouse_dev_team: boolean | null;
  dev_archetype: boolean | null;
  shrinking: boolean | null;

  /* ---- Dimension A · is the deal real (PRO-2r) — facts, not judgments ---- */
  money: FactState;
  authority: FactState;
  specification: FactState;
  timing: Timing | null; // null = unknown
  timing_state: FactState;

  /* ---- Potential inputs (headroom method, locked; PRO-16: output is a band) ---- */
  archetype: Archetype | null;
  serviceable_share: number | null; // 0..1; their menu that maps to ours
  n_vendors: number | null;
  our_rank: number | null;
  trailing_12m_revenue: number; // Orbit; 0 for a prospect
  quote_amount: number | null; // Orbit or PandaDoc; drives year-1 band when present
  stated_ceiling: Ceiling | null; // sales' hand-set ceiling, treated as inferred
  climb_signals: string[]; // from the climb-evidence list in the rubric

  /* ---- Dynamic ---- */
  signals: SignalInput[];
  deals: DealInput[];
  prior_grades: PriorGrade[];
}

/** A human tier override. Owner lane only (PRO-5 revision). One tier max (July, ruled). */
export interface Override {
  tier: Tier;
  reason_code: "data_wrong" | "relationship_known" | "timing_known" | "conflict" | "other";
  reason: string;
  approver: string;
  set_at?: string;
  expires_at?: string | null;
}

export interface GradeOptions {
  override?: Override | null;
}

/* ------------------------------------------------------------------ *
 * Scorecard
 * ------------------------------------------------------------------ */

export interface GateResult {
  id: string;
  label: string;
  result: "pass" | "fail" | "unknown";
  /** park = a fail parks the row (operational filter); flag = a fail only flags. */
  mode: "park" | "flag" | "off";
  reason: string;
  basis: "ruled" | "unruled_default" | "reasoned";
}

export interface AdjustmentTrace {
  id: string;
  name: string;
  direction: 1 | -1;
  fired: boolean;
  rule_text: string;
  basis: "ruled" | "unruled_default" | "reasoned";
  inputs: Record<string, unknown>;
}

export interface FitRead {
  icp_class: IcpClass | null;
  icp_derivation: "stated" | "derived" | "none";
  base_tier: Tier | null;
  adjustments: AdjustmentTrace[];
  net_adjustment: number; // after the ±1 caps
  adjusted_tier: Tier | null;
  platinum_rule: { met: boolean; reasons: string[] };
  computed_tier: Tier | null;
  confidence: Confidence | null;
  confidence_reason: string;
}

export interface QualificationRead {
  facts: { money: FactState; authority: FactState; timing: FactState; specification: FactState };
  present_count: number;
  label: "Qualified" | "Partly qualified" | "Conversation";
  timing: Timing | null;
}

export interface PotentialRead {
  wallet: number | null;
  winnable_share: number | null;
  winnable_basis: "wallet_allocation_rule" | "default";
  headroom: number | null;
  headroom_band: string | null;
  ceiling_proposed: Ceiling | null;
  ceiling: Ceiling;
  ceiling_capped_reason: string | null;
  climb_evidence: string[];
  year1_band: string;
  year1_basis: "quote" | "icp_prior" | "unknown";
  confidence: Confidence;
  inputs: Record<string, number | string | null>;
}

export interface SignalTrace {
  type: string;
  source: string;
  observed_at: string;
  weight: number;
  weight_now: number;
  age_days: number;
}

export interface SignalTask {
  signal: string;
  sla_hours: number;
  due_by: string;
  reason: string;
}

export interface SignalsRead {
  decayed_total: number;
  top: SignalTrace[];
  negatives: SignalTrace[];
  urgency: Urgency;
  urgency_basis: "stated_timing" | "computed" | "none";
  tasks: SignalTask[];
}

export interface DealHealthRead {
  deal_id: string;
  title: string | null;
  color: "green" | "yellow" | "red";
  warnings: Array<{ id: string; severity: "red" | "yellow"; message: string }>;
}

export interface ProspectScorecard {
  account_id: string;
  name: string;
  rubric_version: string;
  rubric_fingerprint: string;
  as_of: string;

  /** Always true. PRO-1r's accepted mitigation: the word prints beside every tier. */
  anticipated: true;
  /** PRO-8: UNVALIDATED until rank agreement ≥ 0.5 is measured on the retrodiction cohort. */
  validation: "UNVALIDATED" | "VALIDATED";

  status: ProspectStatus;
  gates: GateResult[];
  fit: FitRead;
  qualification: QualificationRead;
  potential: PotentialRead;
  signals: SignalsRead;
  deal_health: DealHealthRead[];

  override: Override | null;
  effective_tier: Tier | null;
  /** Fit × Ceiling, e.g. "Gold × Embedded". Null when the row is not ranked. */
  cell: string | null;
  /** Sort keys, best first: tier, facts present, urgency, year-1 band, name. PRO-0: ordering is the job. */
  chase_rank_key: [number, number, number, number, string];

  flags: string[];
  /** One sentence a salesperson can act on. Never a bare number. */
  reason: string;
  trace: { tier_reasoning: string; notes: string[] };
}

/* ------------------------------------------------------------------ *
 * Rubric (the versioned spec is data; these types describe its shape)
 * ------------------------------------------------------------------ */

export interface RubricBand<T = string> {
  min?: number;
  max?: number;
  label: T;
}

// deno-lint-ignore no-explicit-any
export type Rubric = any;
