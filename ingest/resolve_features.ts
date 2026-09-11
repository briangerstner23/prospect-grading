/**
 * WLIQ Prospect Book — feature resolver (DESIGN.md §4g).
 *
 *   pb_current_facts rows + pb_signals + pb_deals + pb_register overrides → ProspectFeatures
 *
 * PURE. No clock (as_of is an input), no network, no filesystem, no dependencies. Runs under
 * Deno and under `node --experimental-strip-types`.
 *
 * This module RESOLVES; it never reasons. It picks the latest fact per key, coerces each value
 * to the type its feature key demands, attaches signal weights from the rubric catalog where a
 * row carries none, keeps only live signals and open non-CJ deals, and lifts the latest live
 * override out of the register. Every place a value could not be used is a note, and the
 * feature is null — unknown is never evidence, and nothing is ever invented to fill a gap.
 *
 * Vocabularies come from the rubric where the rubric states them (ICP classes, WL levels,
 * ceilings and their aliases, timing words, service-shape aliases, Dimension A aliases, climb
 * evidence aliases, override reason codes). Where the rubric is silent the runtime list mirrors
 * the string union in core/prospect_types.ts and says so.
 */

import type {
  Archetype,
  Ceiling,
  DealInput,
  EvidenceLabel,
  FactState,
  IcpClass,
  Override,
  PriorGrade,
  ProspectFeatures,
  RelationshipType,
  RosterSource,
  Rubric,
  ServiceShape,
  SignalInput,
  Tier,
  Timing,
  WlSignal,
} from "../core/prospect_types.ts";
import { TIER_ORDER } from "../core/prospect_types.ts";

/* ------------------------------------------------------------------ *
 * Row shapes (mirror the pb_* tables; extra columns are tolerated)
 * ------------------------------------------------------------------ */

/** A pb_facts / pb_current_facts row. `value` is jsonb: anything. */
export interface FactRow {
  key: string;
  value: unknown;
  evidence_label: string;
  observed_at: string | null;
  source: string;
  created_at: string;
  id?: string;
  account_id?: string;
  evidence_url?: string | null;
  entered_by?: string;
  stand_in?: boolean;
  note?: string | null;
}

/** A pb_signals row. `weight` is numeric and may arrive as a string from PostgREST. */
export interface SignalRow {
  source: string;
  type: string;
  observed_at: string;
  payload: Record<string, unknown> | null;
  weight: number | string | null;
  lifespan_days: number | string | null;
  decays: boolean | null;
  expires_at: string | null;
  id?: string;
  account_id?: string;
  contact_id?: string | null;
  evidence_url?: string | null;
  entered_by?: string;
  created_at?: string;
}

/** A pb_deals row. The five Fathom-derived fields are not columns yet; passed through when present. */
export interface DealRow {
  pipedrive_deal_id: number | string;
  title: string | null;
  stage_name: string | null;
  stage_entered_at: string | null;
  close_date: string | null;
  /** jsonb [{from,to,at}] — or, defensively, a plain count. */
  close_date_pushes: unknown;
  status: string | null;
  is_cj: boolean | null;
  last_buyer_touch_at: string | null;
  buyer_email_velocity_7d: number | null;
  next_meeting_at: string | null;
  decision_maker_engaged: boolean | null;
  buyer_contacts_30d: number | null;
  price_discussed: boolean | null;
  calls_held: number | null;
  /**
   * Whether the source READ the deal's activities when it wrote the row. Not a pb_deals column
   * yet; accepted as a column or as `raw.activities_read`. Only an explicit `true` counts, and
   * it is what lets a missing next_meeting_at mean "known: none booked" rather than "unknown".
   */
  activities_read?: boolean | null;
  account_id?: string | null;
  pipeline_id?: number | null;
  stage_id?: number | null;
  value?: number | string | null;
  currency?: string | null;
  won_time?: string | null;
  lost_time?: string | null;
  owner_user_id?: number | null;
  health?: string | null;
  health_reasons?: unknown;
  raw?: unknown;
  updated_at?: string;
  largest_push_days?: number | null;
  critical_event_captured?: boolean | null;
  indecision_level?: "low" | "medium" | "high" | null;
  risk_words_present?: boolean | null;
  competitor_named_late?: boolean | null;
}

/** A pb_register row. For kind `override` the payload is {tier, reason_code, reason, expires_at}. */
export interface RegisterRow {
  kind: string;
  payload: Record<string, unknown> | null;
  made_by: string;
  created_at: string;
  expires_at: string | null;
  id?: string;
  account_id?: string | null;
  reason_code?: string | null;
  text?: string | null;
  fingerprint?: string | null;
}

export interface ResolveAccount {
  id: string;
  name: string;
  relationship_type: string | null;
  roster_source: string | null;
  roster_certified: boolean | null;
  lineage: string | null;
}

export interface ResolveInput {
  account: ResolveAccount;
  facts: FactRow[];
  signals: SignalRow[];
  deals: DealRow[];
  override_rows: RegisterRow[];
  /** ISO date or timestamp. Decay, expiry and override validity are judged against it. */
  as_of: string;
  rubric: Rubric;
}

export interface ResolveResult {
  features: ProspectFeatures;
  override: Override | null;
  /** Everything that was dropped, coerced or ignored, in plain words. Never a flag. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Runtime vocabularies (mirrors of the string unions in core/prospect_types.ts)
 * ------------------------------------------------------------------ */

type AgencyType = NonNullable<ProspectFeatures["agency_type"]>;
type RevenueBand = NonNullable<ProspectFeatures["revenue_band"]>;
type VerticalDepth = NonNullable<ProspectFeatures["vertical_depth"]>;
type Economics = NonNullable<ProspectFeatures["economics"]>;
type BrokerCharacter = NonNullable<ProspectFeatures["broker_character"]>;
type AiPosture = NonNullable<ProspectFeatures["ai_posture"]>;
type Lineage = NonNullable<ProspectFeatures["lineage"]>;

const EVIDENCE_LABELS: readonly EvidenceLabel[] = ["evidence", "inferred", "unknown"];
const FACT_STATES: readonly FactState[] = ["present", "absent", "unknown"];
const ICP_CLASSES: readonly IcpClass[] = ["ICP-1", "ICP-2", "ICP-3", "ICP-4", "ICP-5", "ICP-6"];
const AGENCY_TYPES: readonly AgencyType[] = ["full_service", "boutique", "digital_only", "niche_vertical", "consultancy", "direct_end_client"];
const REVENUE_BANDS: readonly RevenueBand[] = ["<1M", "1-5M", "5-10M", "10-25M", ">25M"];
type ClientBudgetSize = NonNullable<ProspectFeatures["client_budget_size"]>;
const CLIENT_BUDGET_SIZES: readonly ClientBudgetSize[] = ["buys_real_projects", "local_small"];
const VERTICAL_DEPTHS: readonly VerticalDepth[] = ["deep_single_vertical", "generalist"];
const WL_SIGNALS: readonly WlSignal[] = ["Very High", "High", "Medium", "Low"];
const SERVICE_SHAPES: readonly ServiceShape[] = ["Core", "Complement", "Off"];
const ECONOMICS: readonly Economics[] = ["pass", "fail"];
const BROKER: readonly BrokerCharacter[] = ["pass", "flag"];
const AI_POSTURES: readonly AiPosture[] = ["positive", "neutral", "negative"];
const TIMINGS: readonly Timing[] = ["within_1_week", "within_1_month", "within_3_months", "no_timeline"];
const ARCHETYPES: readonly Archetype[] = ["production", "blended", "strategy"];
const CEILINGS: readonly Ceiling[] = ["Project", "Embedded", "Partner"];
const RELATIONSHIP_TYPES: readonly RelationshipType[] = ["agency", "direct"];
const LINEAGES: readonly Lineage[] = ["lapsed_client"];
const ROSTER_SOURCES: readonly RosterSource[] = [
  "pipedrive", "notion_master", "sales_sheet", "tier1_book", "gotham", "brian_trip", "client_book_lapsed", "manual",
];
const OVERRIDE_REASON_CODES: readonly string[] = ["data_wrong", "relationship_known", "timing_known", "conflict", "other"];

/** Spellings other systems use for the same value. Alias → canonical; null = "this word means unknown". */
const RELATIONSHIP_ALIASES: Record<string, RelationshipType | null> = { "agency partner": "agency", "direct-to-client": "direct" };
const AGENCY_TYPE_ALIASES: Record<string, AgencyType | null> = {
  digital: "digital_only", niche: "niche_vertical", direct: "direct_end_client", "full-service agency": "full_service",
};
const TIMING_STATE_ALIASES: Record<string, FactState | null> = { true: "present", false: "absent", yes: "present", no: "absent" };

/* ------------------------------------------------------------------ *
 * Coercion helpers. INVALID means "a value was stated and it is not usable";
 * null means "recorded unknown". The two are never confused.
 * ------------------------------------------------------------------ */

const INVALID: unique symbol = Symbol("invalid");
type Coerced<T> = T | null | typeof INVALID;

/** Case, whitespace, hyphen, dash, underscore and "$" insensitive comparison key. */
function fold(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/[\s_\-–—]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** A number, or a numeric string ("12", "$12,000", "0.4"). Never a unit conversion. */
function toNumber(v: unknown): Coerced<number> {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : INVALID;
  if (typeof v === "boolean") return INVALID;
  if (typeof v === "string") {
    const s = v.trim().replace(/^\$/, "").replace(/,/g, "").trim();
    if (s.length === 0) return null;
    if (fold(s) === "unknown") return null;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return INVALID;
    const n = Number(s);
    return Number.isFinite(n) ? n : INVALID;
  }
  return INVALID;
}

function toInt(v: unknown, min: number): Coerced<number> {
  const n = toNumber(v);
  if (n === null || n === INVALID) return n;
  if (!Number.isInteger(n) || n < min) return INVALID;
  return n;
}

function toMoney(v: unknown): Coerced<number> {
  const n = toNumber(v);
  if (n === null || n === INVALID) return n;
  return n < 0 ? INVALID : n;
}

/** 0..1 only. A percent-shaped value (40 for 40%) is refused, never rescaled. */
function toRatio(v: unknown): Coerced<number> {
  const n = toNumber(v);
  if (n === null || n === INVALID) return n;
  return n >= 0 && n <= 1 ? n : INVALID;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

function toBool(v: unknown): Coerced<boolean> {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : INVALID;
  if (typeof v === "string") {
    const f = fold(v);
    if (f.length === 0 || f === "unknown") return null;
    if (TRUE_WORDS.has(f)) return true;
    if (FALSE_WORDS.has(f)) return false;
  }
  return INVALID;
}

/**
 * A value from a closed vocabulary, matched fold-insensitively, with optional aliases
 * (alias → canonical, or alias → null meaning "this word means unknown").
 */
function toEnum<T extends string>(
  v: unknown,
  vocab: readonly T[],
  aliases: Record<string, T | null> = {},
): Coerced<T> {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    if (typeof v === "number" || typeof v === "boolean") v = String(v);
    else return INVALID;
  }
  const f = fold(v as string);
  if (f.length === 0 || f === "unknown") return null;
  for (const word of vocab) if (fold(word) === f) return word;
  for (const [alias, target] of Object.entries(aliases)) {
    if (fold(alias) === f) return target;
  }
  return INVALID;
}

/* ------------------------------------------------------------------ *
 * Rubric-driven vocabularies and aliases (with the type mirrors as fallback)
 * ------------------------------------------------------------------ */

function rubricKeys(obj: unknown, drop: string[] = ["default", "basis", "note"]): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj as Record<string, unknown>).filter((k) => !drop.includes(k));
}

function pickVocab<T extends string>(fromRubric: string[], fallback: readonly T[]): readonly T[] {
  const filtered = fromRubric.filter((k): k is T => (fallback as readonly string[]).includes(k));
  return filtered.length > 0 ? filtered : fallback;
}

interface Vocab {
  icp: readonly IcpClass[];
  wl: readonly WlSignal[];
  ceilings: readonly Ceiling[];
  ceilingAliases: Record<string, Ceiling | null>;
  timings: readonly Timing[];
  timingAliases: Record<string, Timing | null>;
  serviceShapeAliases: Record<string, ServiceShape | null>;
  factStateAliases: Record<string, Record<string, FactState | null>>;
  archetypes: readonly Archetype[];
  climbCanonical: string[];
  climbAliases: Record<string, string>;
  reasonCodes: readonly string[];
  signalCatalog: Record<string, { weight?: unknown; lifespan_days?: unknown; decays?: unknown }>;
}

function buildVocab(rubric: Rubric): Vocab {
  const r = (rubric ?? {}) as Record<string, any>;

  const icpFromRubric = [
    ...rubricKeys(r.dimension_b?.icp?.definitions),
    ...rubricKeys(r.dimension_b?.base_tier_from_icp?.map),
  ];
  const icp = pickVocab(Array.from(new Set(icpFromRubric)), ICP_CLASSES);

  const wl = pickVocab(rubricKeys(r.potential?.outsourceable_share_by_wl), WL_SIGNALS);
  const archetypes = pickVocab(rubricKeys(r.potential?.revenue_per_head_usd), ARCHETYPES);

  const ceilings = pickVocab(Array.isArray(r.vocabulary?.ceilings) ? r.vocabulary.ceilings : [], CEILINGS);
  const ceilingAliases: Record<string, Ceiling | null> = {};
  for (const [alias, target] of Object.entries((r.vocabulary?.ceiling_aliases ?? {}) as Record<string, unknown>)) {
    ceilingAliases[alias] = (ceilings as readonly string[]).includes(String(target)) ? (target as Ceiling) : null;
  }

  const timings = pickVocab(rubricKeys(r.signals?.urgency?.from_timing, []), TIMINGS);
  const timingAliases: Record<string, Timing | null> = {};
  for (const [alias, target] of Object.entries((r.dimension_a?.notion_aliases?.timing ?? {}) as Record<string, unknown>)) {
    if (alias === "from" || alias === "note") continue;
    timingAliases[alias] = (timings as readonly string[]).includes(String(target)) ? (target as Timing) : null;
  }

  const serviceShapeAliases: Record<string, ServiceShape | null> = {};
  for (const [alias, target] of Object.entries((r.gates?.items?.service_shape?.notion_aliases ?? {}) as Record<string, unknown>)) {
    serviceShapeAliases[alias] = (SERVICE_SHAPES as readonly string[]).includes(String(target)) ? (target as ServiceShape) : null;
  }

  const factStateAliases: Record<string, Record<string, FactState | null>> = {};
  for (const item of ["money", "authority", "specification"]) {
    const table: Record<string, FactState | null> = { true: "present", false: "absent" };
    for (const [alias, target] of Object.entries((r.dimension_a?.notion_aliases?.[item] ?? {}) as Record<string, unknown>)) {
      if (alias === "from" || alias === "note") continue;
      table[alias] = (FACT_STATES as readonly string[]).includes(String(target)) ? (target as FactState) : null;
    }
    factStateAliases[item] = table;
  }

  const climbCanonical: string[] = Array.isArray(r.potential?.climb_evidence?.signals)
    ? r.potential.climb_evidence.signals.map((s: unknown) => String(s))
    : [];
  const climbAliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries((r.potential?.climb_evidence?.aliases ?? {}) as Record<string, unknown>)) {
    climbAliases[alias] = String(target);
  }

  const reasonCodes: readonly string[] = Array.isArray(r.override?.reason_codes) && r.override.reason_codes.length > 0
    ? r.override.reason_codes.map((c: unknown) => String(c))
    : OVERRIDE_REASON_CODES;

  const signalCatalog = (r.signals?.catalog ?? {}) as Vocab["signalCatalog"];

  return {
    icp, wl, ceilings, ceilingAliases, timings, timingAliases, serviceShapeAliases, factStateAliases,
    archetypes, climbCanonical, climbAliases, reasonCodes, signalCatalog,
  };
}

/* ------------------------------------------------------------------ *
 * Facts
 * ------------------------------------------------------------------ */

/** How much a row's label is worth when two rows claim the same key. Lower wins. */
function labelRank(label: unknown): number {
  return label === "evidence" ? 0 : label === "inferred" ? 1 : 2;
}

/**
 * Winning row per key, in the same order as the pb_current_facts view: evidence outranks
 * inferred outranks unknown, then newest written, then newest observed.
 *
 * Recency alone is not quality. A quote-backed sentence from a 2025 call note beats a machine
 * guess made this morning, and under a pure created_at sort the next sweep would overwrite it.
 * The view and this function must stay in step — pb-score reads one, the pure path the other.
 */
function latestFactPerKey(facts: FactRow[]): Map<string, FactRow> {
  const sorted = facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const la = labelRank(a.f.evidence_label);
      const lb = labelRank(b.f.evidence_label);
      if (la !== lb) return la - lb;
      const ca = parseMs(a.f.created_at) ?? -Infinity;
      const cb = parseMs(b.f.created_at) ?? -Infinity;
      if (ca !== cb) return cb - ca;
      const oa = parseMs(a.f.observed_at) ?? -Infinity;
      const ob = parseMs(b.f.observed_at) ?? -Infinity;
      if (oa !== ob) return ob - oa;
      return a.i - b.i;
    });
  const out = new Map<string, FactRow>();
  for (const { f } of sorted) if (!out.has(f.key)) out.set(f.key, f);
  return out;
}

function describe(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return String(v);
  }
}

/** ICP spellings the vocabulary check would miss: "ICP1", "icp 3", "1". */
function preIcp(v: unknown): unknown {
  if (typeof v === "number" && Number.isInteger(v)) return `ICP-${v}`;
  if (typeof v !== "string") return v;
  const m = v.trim().match(/^(?:icp)?[\s_\-]*([1-6])$/i);
  return m ? `ICP-${m[1]}` : v;
}

/* ------------------------------------------------------------------ *
 * Deals
 * ------------------------------------------------------------------ */

function parsePushes(v: unknown): { count: number; largest_days: number | null } {
  if (Array.isArray(v)) {
    let largest: number | null = null;
    for (const p of v) {
      if (!p || typeof p !== "object") continue;
      const from = parseMs((p as Record<string, unknown>).from);
      const to = parseMs((p as Record<string, unknown>).to);
      if (from === null || to === null) continue;
      const days = Math.round((to - from) / 86_400_000);
      if (largest === null || days > largest) largest = days;
    }
    return { count: v.length, largest_days: largest };
  }
  const n = toNumber(v);
  if (n !== null && n !== INVALID && n >= 0) return { count: Math.floor(n), largest_days: null };
  return { count: 0, largest_days: null };
}

function optBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * DealInput plus the deal-health flag the engine reads (`has_next_meeting`, optional). Declared
 * here as a widening so this module resolves the flag whether or not core/prospect_types.ts
 * carries the field yet; ProspectFeatures.deals accepts the wider shape either way.
 */
type ResolvedDeal = DealInput & { has_next_meeting?: boolean | null };

/**
 * The known state of the next meeting — never inferred from silence:
 *   true   next_meeting_at is set (a meeting is booked)
 *   false  the source read the deal's activities and found none booked — ONLY on an explicit
 *          marker: `activities_read === true` on the row or in `raw`
 *   null   unknown; a missing next_meeting_at alone says nothing, so no deal-health rule about
 *          the next meeting fires (unknown never warns)
 */
function hasNextMeeting(row: DealRow): boolean | null {
  if (optStr(row.next_meeting_at) !== null) return true;
  if (row.activities_read === true) return false;
  const raw = row.raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).activities_read === true) return false;
  return null;
}

function optInt(v: unknown): number | null {
  const n = toNumber(v);
  return n === null || n === INVALID ? null : n;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* ------------------------------------------------------------------ *
 * resolveFeatures
 * ------------------------------------------------------------------ */

export function resolveFeatures(input: ResolveInput): ResolveResult {
  const notes: string[] = [];
  const V = buildVocab(input.rubric);
  const asOfMs = parseMs(input.as_of);
  if (asOfMs === null) notes.push(`as_of ${describe(input.as_of)} is not a parseable date; expiry checks are skipped`);

  const facts = latestFactPerKey(input.facts ?? []);
  const consumed = new Set<string>();

  /** A resolved fact value: null when absent, recorded-unknown or out of vocabulary (with a note). */
  function fact<T>(key: string, coerce: (v: unknown) => Coerced<T>): T | null {
    consumed.add(key);
    const row = facts.get(key);
    if (!row) return null;
    const c = coerce(row.value);
    if (c === INVALID) {
      notes.push(`fact ${key}: value ${describe(row.value)} is not in the vocabulary; treated as unknown`);
      return null;
    }
    return c;
  }

  /** The evidence label of a fact that resolved to a value; "unknown" otherwise. */
  function labelOf(key: string, resolved: unknown): EvidenceLabel {
    const row = facts.get(key);
    if (!row || resolved === null) return "unknown";
    const l = toEnum(row.evidence_label, EVIDENCE_LABELS);
    if (l === INVALID) {
      notes.push(`fact ${key}: evidence_label ${describe(row.evidence_label)} is not in the vocabulary; treated as unknown`);
      return "unknown";
    }
    return l ?? "unknown";
  }

  /* ---- account ---- */
  const acct = input.account;
  let relationship_type: RelationshipType | null = null;
  {
    const fromAccount = toEnum<RelationshipType>(acct.relationship_type, RELATIONSHIP_TYPES, RELATIONSHIP_ALIASES);
    if (fromAccount === INVALID) {
      notes.push(`account relationship_type ${describe(acct.relationship_type)} is not in the vocabulary; treated as unknown`);
    } else if (fromAccount !== null) {
      relationship_type = fromAccount;
      consumed.add("relationship_type");
    }
    if (relationship_type === null) {
      relationship_type = fact<RelationshipType>("relationship_type", (v) => toEnum<RelationshipType>(v, RELATIONSHIP_TYPES, RELATIONSHIP_ALIASES));
    }
  }

  let roster_source = toEnum(acct.roster_source, ROSTER_SOURCES);
  if (roster_source === INVALID) {
    notes.push(`account roster_source ${describe(acct.roster_source)} is not in the vocabulary; treated as unknown`);
    roster_source = null;
  }

  const certified = toBool(acct.roster_certified);
  const roster_certified = certified === true;
  if (certified === INVALID) notes.push(`account roster_certified ${describe(acct.roster_certified)} is not a boolean; treated as false`);

  let lineage: Lineage | null = null;
  if (acct.lineage !== null && acct.lineage !== undefined) {
    const l = toEnum<Lineage>(acct.lineage, LINEAGES);
    if (l === INVALID) notes.push(`account lineage ${describe(acct.lineage)} is not in the vocabulary; treated as none`);
    else lineage = l;
  }

  /* ---- Dimension B ---- */
  const icp_class = fact("icp_class", (v) => toEnum(preIcp(v), V.icp));
  const icp_class_label = labelOf("icp_class", icp_class);
  const headcount = fact("headcount", (v) => toInt(v, 0));
  const headcount_label = labelOf("headcount", headcount);

  const agency_type = fact<AgencyType>("agency_type", (v) => toEnum<AgencyType>(v, AGENCY_TYPES, AGENCY_TYPE_ALIASES));

  /* Observable fit criteria (rubric 0.2.0 onward; unread by 0.1.0).
   * no_inhouse_dev_team falls back to the inverse of the older inhouse_dev_team fact so the
   * criterion can be answered from data the book already holds, rather than only from new facts. */
  const sells_build_work = fact("sells_build_work", toBool);
  const sells_build_work_label = labelOf("sells_build_work", sells_build_work);
  const inhouse_dev_team = fact("inhouse_dev_team", toBool);
  const no_inhouse_dev_team_direct = fact("no_inhouse_dev_team", toBool);
  const no_inhouse_dev_team = no_inhouse_dev_team_direct ?? (inhouse_dev_team === null ? null : !inhouse_dev_team);
  const no_inhouse_dev_team_label = no_inhouse_dev_team_direct !== null
    ? labelOf("no_inhouse_dev_team", no_inhouse_dev_team_direct)
    : labelOf("inhouse_dev_team", inhouse_dev_team);
  const client_budget_size = fact("client_budget_size", (v) => toEnum(v, CLIENT_BUDGET_SIZES));
  const client_budget_size_label = labelOf("client_budget_size", client_budget_size);
  const recurring_work_shape = fact("recurring_work_shape", toBool);
  const recurring_work_shape_label = labelOf("recurring_work_shape", recurring_work_shape);
  const service_shape = fact("service_shape", (v) => toEnum(v, SERVICE_SHAPES, V.serviceShapeAliases));

  /* ---- Dimension A ---- */
  const money: FactState = fact<FactState>("money", (v) => toEnum<FactState>(v, FACT_STATES, V.factStateAliases.money)) ?? "unknown";
  const authority: FactState = fact<FactState>("authority", (v) => toEnum<FactState>(v, FACT_STATES, V.factStateAliases.authority)) ?? "unknown";
  const specification: FactState = fact<FactState>("specification", (v) => toEnum<FactState>(v, FACT_STATES, V.factStateAliases.specification)) ?? "unknown";
  const timing = fact<Timing>("timing", (v) => toEnum<Timing>(v, V.timings, V.timingAliases));
  const explicitTimingState = fact<FactState>("timing_state", (v) => toEnum<FactState>(v, FACT_STATES, TIMING_STATE_ALIASES));
  const timing_state: FactState = explicitTimingState ?? (timing === null ? "unknown" : timing === "no_timeline" ? "absent" : "present");

  /* ---- potential ---- */
  const stated_ceiling = fact("stated_ceiling", (v) => toEnum(v, V.ceilings, V.ceilingAliases));
  const climb_signals = ((): string[] => {
    consumed.add("climb_signals");
    const row = facts.get("climb_signals");
    if (!row || row.value === null || row.value === undefined) return [];
    const raw: unknown[] = Array.isArray(row.value) ? row.value : typeof row.value === "string" ? [row.value] : [];
    if (!Array.isArray(row.value) && typeof row.value !== "string") {
      notes.push(`fact climb_signals: value ${describe(row.value)} is not a list; treated as none`);
      return [];
    }
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || item.trim().length === 0) {
        notes.push(`fact climb_signals: entry ${describe(item)} is not a string; dropped`);
        continue;
      }
      const f = fold(item);
      let canonical: string | null = null;
      for (const c of V.climbCanonical) if (fold(c) === f) canonical = c;
      if (canonical === null) {
        for (const [alias, target] of Object.entries(V.climbAliases)) if (fold(alias) === f) canonical = target;
      }
      if (canonical === null) {
        notes.push(`fact climb_signals: ${describe(item)} is not a climb-evidence signal or alias; dropped`);
        continue;
      }
      if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
  })();

  /* ---- signals and prior grades ---- */
  const signals: SignalInput[] = [];
  const prior_grades: PriorGrade[] = [];
  for (const row of input.signals ?? []) {
    const type = String(row.type ?? "");
    if (type === "prior_grade") {
      const value = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>).value : undefined;
      if (value === null || value === undefined || String(value).trim().length === 0) {
        notes.push(`prior_grade signal from ${row.source} has no payload.value; dropped`);
        continue;
      }
      prior_grades.push({ source: String(row.source), value: String(value), observed_at: row.observed_at ?? null });
      continue;
    }

    if (row.expires_at !== null && row.expires_at !== undefined) {
      const exp = parseMs(row.expires_at);
      if (exp === null) notes.push(`signal ${type}: expires_at ${describe(row.expires_at)} is not a date; kept`);
      else if (asOfMs !== null && exp < asOfMs) continue;
    }

    const observedMs = parseMs(row.observed_at);
    if (observedMs === null) {
      notes.push(`signal ${type}: observed_at ${describe(row.observed_at)} is not a date; dropped`);
      continue;
    }
    if (asOfMs !== null && observedMs > asOfMs) notes.push(`signal ${type}: observed_at is after as_of; kept, age is negative`);

    let weight = toNumber(row.weight);
    let lifespan_days: number | null;
    let decays: boolean;
    const cat = V.signalCatalog[type];
    if (weight === null || weight === INVALID) {
      if (weight === INVALID) notes.push(`signal ${type}: weight ${describe(row.weight)} is not a number; catalog weight used`);
      const cw = cat ? toNumber(cat.weight) : null;
      if (!cat || cw === null || cw === INVALID) {
        notes.push(`signal ${type}: no weight on the row and no catalog entry; dropped`);
        continue;
      }
      weight = cw;
      const cl = toNumber(cat.lifespan_days);
      lifespan_days = cl === null || cl === INVALID ? null : cl;
      decays = typeof cat.decays === "boolean" ? cat.decays : true;
    } else {
      const rl = toNumber(row.lifespan_days);
      if (rl === INVALID) notes.push(`signal ${type}: lifespan_days ${describe(row.lifespan_days)} is not a number; treated as never-decays`);
      lifespan_days = rl === null || rl === INVALID ? null : rl;
      decays = typeof row.decays === "boolean" ? row.decays : true;
    }

    const s: SignalInput = {
      type,
      observed_at: row.observed_at,
      source: String(row.source),
      weight,
      lifespan_days,
      decays,
      evidence_url: row.evidence_url ?? null,
    };
    if (row.payload && typeof row.payload === "object") s.payload = row.payload;
    signals.push(s);
  }
  signals.sort((a, b) => {
    const d = (parseMs(b.observed_at) ?? 0) - (parseMs(a.observed_at) ?? 0);
    if (d !== 0) return d;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  prior_grades.sort((a, b) => {
    const d = (parseMs(b.observed_at) ?? 0) - (parseMs(a.observed_at) ?? 0);
    if (d !== 0) return d;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });

  /* ---- deals: open, not Client Journey ---- */
  const deals: ResolvedDeal[] = [];
  for (const row of input.deals ?? []) {
    if (row.status !== "open") continue;
    if (row.is_cj === true) continue;
    const pushes = parsePushes(row.close_date_pushes);
    deals.push({
      deal_id: String(row.pipedrive_deal_id),
      title: optStr(row.title),
      stage_name: optStr(row.stage_name),
      stage_entered_at: optStr(row.stage_entered_at),
      stage_median_days: null,
      close_date: optStr(row.close_date),
      close_date_pushes: pushes.count,
      largest_push_days: optInt(row.largest_push_days) ?? pushes.largest_days,
      last_buyer_touch_at: optStr(row.last_buyer_touch_at),
      buyer_email_velocity_7d: optInt(row.buyer_email_velocity_7d),
      next_meeting_at: optStr(row.next_meeting_at),
      has_next_meeting: hasNextMeeting(row),
      decision_maker_engaged: optBool(row.decision_maker_engaged),
      buyer_contacts_30d: optInt(row.buyer_contacts_30d),
      price_discussed: optBool(row.price_discussed),
      calls_held: optInt(row.calls_held),
      critical_event_captured: optBool(row.critical_event_captured),
      indecision_level: row.indecision_level === "low" || row.indecision_level === "medium" || row.indecision_level === "high"
        ? row.indecision_level
        : null,
      risk_words_present: optBool(row.risk_words_present),
      competitor_named_late: optBool(row.competitor_named_late),
    });
  }
  deals.sort((a, b) => {
    const na = Number(a.deal_id), nb = Number(b.deal_id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.deal_id < b.deal_id ? -1 : a.deal_id > b.deal_id ? 1 : 0;
  });

  /* ---- override: latest live register row of kind override ---- */
  let override: Override | null = null;
  {
    const live = (input.override_rows ?? [])
      .filter((r) => r.kind === "override")
      .filter((r) => {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const expRaw = r.expires_at ?? (payload.expires_at as string | null | undefined) ?? null;
        if (expRaw === null || expRaw === undefined) return true;
        const exp = parseMs(expRaw);
        if (exp === null) {
          notes.push(`override by ${r.made_by}: expires_at ${describe(expRaw)} is not a date; not applied`);
          return false;
        }
        return asOfMs === null ? true : exp >= asOfMs;
      })
      .sort((a, b) => (parseMs(b.created_at) ?? 0) - (parseMs(a.created_at) ?? 0));
    const row = live[0];
    if (row) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const tier = toEnum(payload.tier, TIER_ORDER as readonly Tier[]);
      const code = toEnum(payload.reason_code ?? row.reason_code, V.reasonCodes);
      const reason = typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason
        : typeof row.text === "string" ? row.text : "";
      const expRaw = row.expires_at ?? (payload.expires_at as string | null | undefined) ?? null;
      if (tier === null || tier === INVALID) {
        notes.push(`override by ${row.made_by}: tier ${describe(payload.tier)} is not a tier; not applied`);
      } else if (code === null || code === INVALID) {
        notes.push(`override by ${row.made_by}: reason_code ${describe(payload.reason_code ?? row.reason_code)} is missing or not a reason code; not applied`);
      } else if (!row.made_by || String(row.made_by).trim().length === 0) {
        notes.push("override: made_by is empty; not applied");
      } else {
        override = {
          tier,
          reason_code: code as Override["reason_code"],
          reason,
          approver: String(row.made_by),
          set_at: row.created_at,
          expires_at: expRaw === undefined ? null : expRaw,
        };
      }
    }
  }

  /* ---- assemble ---- */
  const features: ProspectFeatures = {
    account_id: acct.id,
    name: acct.name,
    as_of: input.as_of,

    relationship_type,
    roster_source,
    roster_certified,
    lineage,

    icp_class,
    icp_class_label,
    is_agency: fact("is_agency", toBool),
    agency_type,
    headcount,
    headcount_label,
    revenue_band: fact("revenue_band", (v) => toEnum(v, REVENUE_BANDS)),
    vertical_depth: fact("vertical_depth", (v) => toEnum(v, VERTICAL_DEPTHS)),
    wl_signal: fact("wl_signal", (v) => toEnum(v, V.wl)),
    service_shape,
    economics: fact("economics", (v) => toEnum(v, ECONOMICS)),
    deal_size_estimate: fact("deal_size_estimate", toMoney),
    hourly_rate_accepted: fact("hourly_rate_accepted", toBool),
    broker_character: fact("broker_character", (v) => toEnum(v, BROKER)),

    sells_build_work,
    sells_build_work_label,
    no_inhouse_dev_team,
    no_inhouse_dev_team_label,
    client_budget_size,
    client_budget_size_label,
    client_evidence_count: fact("client_evidence_count", (v) => toInt(v, 0)),
    recurring_work_shape,
    recurring_work_shape_label,

    referral_from_network: fact("referral_from_network", toBool),
    icp4_vertical_proven: fact("icp4_vertical_proven", toBool),
    recurring_revenue_share: fact("recurring_revenue_share", toRatio),
    niche_positioning: fact("niche_positioning", toBool),
    am_pm_separated: fact("am_pm_separated", toBool),
    platform_partner_badge: fact("platform_partner_badge", toBool),
    peer_network_member: fact("peer_network_member", toBool),
    ai_posture: fact("ai_posture", (v) => toEnum(v, AI_POSTURES)),
    avg_project_size: fact("avg_project_size", toMoney),
    already_outsources: fact("already_outsources", toBool),
    owner_does_everything: fact("owner_does_everything", toBool),
    inhouse_dev_team,
    dev_archetype: fact("dev_archetype", toBool),
    shrinking: fact("shrinking", toBool),

    money,
    authority,
    specification,
    timing,
    timing_state,

    archetype: fact("archetype", (v) => toEnum(v, V.archetypes)),
    serviceable_share: fact("serviceable_share", toRatio),
    n_vendors: fact("n_vendors", (v) => toInt(v, 1)),
    our_rank: fact("our_rank", (v) => toInt(v, 1)),
    trailing_12m_revenue: fact("trailing_12m_revenue", toMoney) ?? 0,
    quote_amount: fact("quote_amount", toMoney),
    stated_ceiling,
    climb_signals,

    signals,
    deals,
    prior_grades,
  };

  const ignored = Array.from(facts.keys()).filter((k) => !consumed.has(k)).sort();
  if (ignored.length > 0) notes.push(`ignored non-feature fact keys: ${ignored.join(", ")}`);

  return { features, override, notes };
}
