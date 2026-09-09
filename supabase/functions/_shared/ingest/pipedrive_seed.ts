/**
 * WLIQ Prospect Book — Pipedrive roster seed (DESIGN.md §4d; PRO-6).
 *
 *   a read-only Pipedrive pull (organizations, Client Journey cards, open pipeline-1 deals,
 *   persons, activities, stages) → accounts + facts + signals + contacts + deals + a
 *   write-back index, plus the rows that were NOT rostered and why.
 *
 * PURE. No clock (as_of is an input), no network, no filesystem, no dependencies. Runs under
 * Deno and under `node --experimental-strip-types`.
 *
 * PRO-6: Pipedrive is the roster source of truth. Everything this module emits is therefore
 * `roster_source = pipedrive`, `roster_certified = true`. The roster is:
 *
 *   - every organisation whose OPEN Client Journey card (pipeline 9) sits in a prospect stage
 *     (New · Schedule Sales Call · Sales Call Done · Quoting · Quote Lost · Unqualified/DNC —
 *     the last one lands in the `parked` book), PLUS
 *   - every organisation with an open pipeline-1 deal and no Client Journey card at all
 *     (flagged "No CJ card").
 *
 * An organisation whose card is in a client stage (Active · Inactive · Past · Lost Client) is
 * an Agency Partner under PRO-10 and never a prospect, even when it also carries an open
 * pipeline-1 deal; "Friends of WLIQ" is not a sales relationship. Both go to `skipped` with
 * their reason, as do cards without an organisation, organisations missing from the pull,
 * internal organisations and lost cards. When an organisation has several cards the most
 * recently updated OPEN one rules.
 *
 * Field keys. Pipedrive custom fields are 40-hex hashes whose labels were INFERRED from their
 * values (no field-definition endpoint was readable when the pull was made). Every hash lives
 * in `PipedriveKeys` — one place to change — and a caller may override any of them through
 * `opts.keys`. Enum values arrive as `{id, label}` objects (include_option_labels=true) or as
 * bare strings; both are read. A bare numeric option id without its label cannot be read and
 * is skipped with a note.
 *
 * Field precedence. Deal-level fields (Grade, ICP class, lead temperature, lead source,
 * budget, services of interest, …) are read from the organisation's Client Journey card first
 * and then from its open pipeline-1 deals, most recently updated first; the first non-empty
 * value wins and the record that supplied it provides the evidence URL and observed date.
 *
 * Rules honoured here:
 *   - Unknown is never evidence. An empty field produces nothing — no "absent" is ever
 *     invented from an empty cell. The one place a negative is recorded, referral_from_network
 *     = false, requires a filled lead source that does not match.
 *   - Almost every value is `inferred`: a CRM-entered employee_count is a person's statement,
 *     not a primary record (the headroom method counts only LinkedIn, the site or Clutch as
 *     evidence). Only a deal's own value, read straight off the deal, is `evidence`.
 *   - Signal weight, lifespan and decay come from rubric.signals.catalog. A type the catalog
 *     lacks uses the fallback named beside it or is skipped with a note — never invented.
 *   - No signal is emitted with observed_at after as_of. A date-only as_of covers its whole day.
 *   - Economics is never emitted (the floor's basis is unruled; the engine derives it).
 *   - Identity is never merged: two organisations that normalise to the same key both stay,
 *     the second under a disambiguated key and a flag.
 */

import type { EvidenceLabel, RelationshipType, Rubric, Timing } from "../core/prospect_types.ts";
import { domainFromEmail, norm, normalizeDomain } from "./identity.ts";

/* ------------------------------------------------------------------ *
 * Field keys — ONE place to change. Labels are inferences from values (9 Sep 2026 pull).
 * ------------------------------------------------------------------ */

export const PipedriveKeys = {
  deal: {
    /** High / Medium / Low */
    grade: "79d0a04a41f88291ab15925c354e7fff34beb5fb",
    /** "ICP-5: Strategic Consultant" … "Unclassified (Insufficient Data)" */
    icp_class: "e5100bc8ef9616c63e00ba8a07abe935d7ca61c6",
    /** Super Hot / Hot / Warm / Cold */
    lead_temperature: "8fb2e240e79d0ff2410a2e3f38072a94e16d0518",
    lead_source: "4a298d244a896041940f6bd0cc3ad87bdb333fb4",
    lead_channel: "3395a1415795cb2b86ce9d270314bf5296538d95",
    lead_source_detail: "2d2d976f8e77a2b5f752ebe3bc8cbd028e9035f1",
    /** Free text: "$10-20K", "5,220 - 6,000", "50000+" … */
    stated_budget: "a44f3b3cc3b76afd133b9380c3967e0b564ed00c",
    /** Multi-enum: Web/WordPress, AI, SEO, PPC, Paid Social, Hosting/Maintenance, Branding/Design … */
    services_of_interest: "422f8029f953398b0022e3accf52b9d2dbd2a2e8",
    inbound_inquiry: "96d69c0bbd6d783f023bb4feae053efcd2962b2d",
    lost_reason: "be4499e9c8f59e442bff227b1638187449a0c09f",
    lost_reason_notes: "d36b6a5adf382eaade5f147e23b832d39323ba47",
    status_summary: "153173a16dded3f9b6260f1bed1bd437d3669952",
    salesperson: "59650d626ad74614e8de7a0e1d065116e9e11647",
    account_manager: "6fd8bedec1c1bad3702f2aaefecc6e3f54809945",
    /** New / Existing */
    client_stage: "c47db9ce6fe352f6e37c9f04d8b68fd64fdd15d9",
    clientiq_url: "a29bbe1cb1dca053a553da504eb907685f81c44e",
    orbit_project_url: "f5e998a68da7d0894da4a2848ee70226b0e09e00",
  },
  org: {
    /** Agency / Direct Client */
    organization_type: "fcedd20b1f5fa10fcef67a47322fe5d9a5cce0c0",
    /** 1 · 2-10 · 11-50 · 51-100 · 101-250 · 250+ */
    employee_range: "33e4ee2a874d1524b9c534bbdbc6b789ccd74f75",
    industry_category: "6d18511d6aba47b16551f267937d4bc8431bcbe2",
    services_offered: "b96d8b0ed4edeaff4872bb9973669c69cf21bbbd",
    industries_served: "06c4a249c2cd1dcfaf6b7b8c4c720b40433a496b",
    specialties: "6922b197f46b2e21289d7251fd93c615e66e8b85",
    email: "866abc465875a3aeca412802708ae8b46332a287",
    notion_link: "193d4ef179455393fd6973fe3c107e79f86b7cba",
  },
} as const;

export type PipedriveDealKeys = { [K in keyof typeof PipedriveKeys.deal]: string };
export type PipedriveOrgKeys = { [K in keyof typeof PipedriveKeys.org]: string };

export interface PipedriveKeyOverrides {
  deal?: Partial<PipedriveDealKeys>;
  org?: Partial<PipedriveOrgKeys>;
}

/* ------------------------------------------------------------------ *
 * Stage ids (WLIQ's Pipedrive, 9 Sep 2026). Names come from the `stages` input at run time.
 * ------------------------------------------------------------------ */

export const STAGE = {
  p1: { discovery: 11, quoted: 12, refine: 1, verbally_accepted: 72, pa_sent: 4, unresponsive: 68, on_hold: 46 },
  cj: {
    new: 57,
    schedule_sales_call: 58,
    sales_call_done: 59,
    quoting: 70,
    quote_lost: 71,
    unqualified_dnc: 66,
    active_client: 63,
    inactive_client: 64,
    past_client: 65,
    lost_client: 67,
    friends_of_wliq: 69,
  },
} as const;

/** Client Journey stages that make an organisation a prospect. Stage 66 lands in the `parked` book. */
export const CJ_PROSPECT_STAGES: readonly number[] = [57, 58, 59, 70, 71, 66];
/** PRO-10: a client stage means an Agency Partner — never a prospect. */
export const CJ_CLIENT_STAGES: readonly number[] = [63, 64, 65, 67];
export const CJ_FRIENDS_STAGE = 69;
export const CJ_PARKED_STAGE = 66;
/** Pipeline-1 stages at or beyond a quote: money and specification are on the table. */
export const P1_QUOTED_OR_BEYOND: readonly number[] = [12, 1, 72, 4];

export const PIPEDRIVE_SOURCE = "pipedrive";
export const DEFAULT_ENTERED_BY = "system:pipedrive";
export const DEFAULT_BASE_URL = "https://app.pipedrive.com";
export const DEFAULT_INTERNAL_ORG_NAMES: readonly string[] = ["White Label IQ"];

/* ------------------------------------------------------------------ *
 * Input shapes (Pipedrive API v2 records; extra fields tolerated, every field optional)
 * ------------------------------------------------------------------ */

export type Rec = Record<string, unknown>;

export interface PipedriveDeal {
  id: number | string;
  title?: string | null;
  value?: number | string | null;
  currency?: string | null;
  person_id?: number | string | null;
  org_id?: number | string | null;
  stage_id?: number | string | null;
  pipeline_id?: number | string | null;
  status?: string | null;
  add_time?: string | null;
  update_time?: string | null;
  stage_change_time?: string | null;
  expected_close_date?: string | null;
  won_time?: string | null;
  lost_time?: string | null;
  lost_reason?: string | null;
  owner_id?: number | string | null;
  custom_fields?: Rec | null;
  [extra: string]: unknown;
}

export interface PipedriveOrg {
  id: number | string;
  name?: string | null;
  website?: string | null;
  linkedin?: string | null;
  employee_count?: number | string | null;
  industry?: number | string | null;
  owner_id?: number | string | null;
  add_time?: string | null;
  update_time?: string | null;
  custom_fields?: Rec | null;
  [extra: string]: unknown;
}

export type PipedriveEmail = string | { value?: unknown; primary?: unknown; label?: unknown };

export interface PipedrivePerson {
  id: number | string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  emails?: PipedriveEmail[] | string | null;
  phones?: unknown;
  job_title?: string | null;
  org_id?: number | string | null;
  update_time?: string | null;
  custom_fields?: Rec | null;
  [extra: string]: unknown;
}

export interface PipedriveActivity {
  id?: number | string;
  type?: string | null;
  done?: boolean | number | string | null;
  due_date?: string | null;
  due_time?: string | null;
  deal_id?: number | string | null;
  org_id?: number | string | null;
  person_id?: number | string | null;
  [extra: string]: unknown;
}

export interface PipedriveStage {
  id: number | string;
  name?: string | null;
  pipeline_id?: number | string | null;
  [extra: string]: unknown;
}

/** The pull saves persons as `{persons[], org_persons_index}`; a bare array is accepted too. */
export type PersonsInput = PipedrivePerson[] | { persons?: PipedrivePerson[] | null; org_persons_index?: Record<string, unknown> | null; [k: string]: unknown };
export type ActivitiesInput = PipedriveActivity[] | { activities?: PipedriveActivity[] | null; [k: string]: unknown };
/** The raw MCP envelope `{success, data: [...]}` or a bare array. */
export type StagesInput = PipedriveStage[] | { data?: PipedriveStage[] | null; [k: string]: unknown };
export type ListInput<T> = T[] | { data?: T[] | null; [k: string]: unknown };

export interface PipedriveSeedOptions {
  /** ISO date (or timestamp). Signals after it are dropped; "future meeting" is judged against it. Required. */
  as_of: string;
  /** pb_facts.entered_by / pb_signals.entered_by. Default "system:pipedrive". */
  entered_by?: string;
  /** Organisations excluded by name (compared through norm()). Default ["White Label IQ"]. */
  internal_org_names?: string[];
  /** Evidence URLs are `<base_url>/deal/<id>`, `/organization/<id>`, `/person/<id>`. Default https://app.pipedrive.com. */
  base_url?: string;
  /** Override any custom-field hash in PipedriveKeys. */
  keys?: PipedriveKeyOverrides;
}

export interface PipedriveRosterInput {
  orgs: ListInput<PipedriveOrg>;
  cj_deals: ListInput<PipedriveDeal>;
  p1_deals: ListInput<PipedriveDeal>;
  persons: PersonsInput;
  activities: ActivitiesInput;
  stages: StagesInput;
  rubric: Rubric;
  opts: PipedriveSeedOptions;
}

/* ------------------------------------------------------------------ *
 * Output (column names are the pb_* column names; account_key joins to pb_accounts.key)
 * ------------------------------------------------------------------ */

export type AgencyType = "full_service" | "boutique" | "digital_only" | "niche_vertical" | "consultancy" | "direct_end_client";

export interface RosterAccount {
  /** pb_accounts.key — the same value as account_key, so the row drops straight into the accounts pack. */
  key: string;
  account_key: string;
  name: string;
  domain: string | null;
  pipedrive_org_id: number;
  roster_source: "pipedrive";
  roster_certified: true;
  relationship_type: RelationshipType | null;
  book: "prospect" | "parked";
  flags: string[];
}

export interface RosterFact {
  account_key: string;
  key: string;
  value: unknown;
  evidence_label: EvidenceLabel;
  source: "pipedrive";
  evidence_url: string | null;
  /** ISO date (YYYY-MM-DD) — pb_facts.observed_at is a date. */
  observed_at: string | null;
  entered_by: string;
  note: string;
}

export interface RosterSignal {
  account_key: string;
  type: string;
  /** ISO timestamp — pb_signals.observed_at is a timestamptz. */
  observed_at: string;
  payload: Record<string, unknown>;
  source: "pipedrive";
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
  entered_by: string;
  evidence_url: string | null;
}

export interface RosterContact {
  account_key: string;
  name: string | null;
  email: string | null;
  title: string | null;
  pipedrive_person_id: number;
  is_decision_maker: boolean | null;
  source: "pipedrive";
}

export interface RosterDeal {
  pipedrive_deal_id: number;
  account_key: string;
  title: string | null;
  pipeline_id: number | null;
  stage_id: number | null;
  stage_name: string | null;
  stage_entered_at: string | null;
  value: number | null;
  currency: string | null;
  close_date: string | null;
  close_date_pushes: never[];
  status: string | null;
  won_time: string | null;
  lost_time: string | null;
  owner_user_id: number | null;
  is_cj: false;
  next_meeting_at: string | null;
  calls_held: number | null;
  raw: { custom_fields_labelled: Record<string, unknown>; grade_label: string | null };
}

export interface CjIndexEntry {
  cj_deal_id: number;
  stage_id: number;
  stage_name: string | null;
  org_id: number;
}

export interface RosterSkipped {
  org_id: number | null;
  name: string | null;
  reason: string;
  cj_deal_id: number | null;
}

export interface RosterSummary {
  roster_orgs: number;
  by_cj_stage: Record<string, number>;
  p1_only: number;
  parked: number;
  facts: number;
  facts_by_key: Record<string, number>;
  signals: number;
  signals_by_type: Record<string, number>;
  contacts: number;
  deals: number;
  skipped: number;
  skipped_by_reason: Record<string, number>;
  notes: string[];
}

export interface PipedriveRosterResult {
  accounts: RosterAccount[];
  facts: RosterFact[];
  signals: RosterSignal[];
  contacts: RosterContact[];
  deals: RosterDeal[];
  cj_index: Record<string, CjIndexEntry>;
  skipped: RosterSkipped[];
  summary: RosterSummary;
}

/* ------------------------------------------------------------------ *
 * Small coercions. Nothing here invents a value.
 * ------------------------------------------------------------------ */

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length === 0 ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace(/^\$/, "").replace(/,/g, "");
    if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toId(v: unknown): number | null {
  const n = toNum(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

/** Any Pipedrive timestamp → ISO 8601 UTC, or null. ISO, "YYYY-MM-DD HH:MM:SS" (UTC) and bare dates. */
function toIso(v: unknown): string | null {
  const s = toStr(v);
  if (s === null || s.startsWith("0000-00-00")) return null;
  let candidate = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) candidate = s.replace(" ", "T") + "Z";
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) candidate = s + "T00:00:00Z";
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A calendar date "YYYY-MM-DD", or null. A datetime is reduced to its UTC date. */
function toDate(v: unknown): string | null {
  const s = toStr(v);
  if (s !== null && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s === "0000-00-00" ? null : s;
  const iso = toIso(v);
  return iso === null ? null : iso.slice(0, 10);
}

function ms(v: unknown): number | null {
  const iso = toIso(v);
  if (iso === null) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

/** The later of two ISO dates/timestamps (string compare is safe for ISO UTC strings of equal shape). */
function laterDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function asList<T>(v: ListInput<T> | null | undefined): T[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)) return (v as { data: T[] }).data;
  return [];
}

function fields(rec: { custom_fields?: Rec | null } | null | undefined): Rec {
  const cf = rec?.custom_fields;
  return cf && typeof cf === "object" && !Array.isArray(cf) ? cf : {};
}

/**
 * The label of an enum value: `{id, label}` → label, a bare string → itself. A bare number is
 * an option id without its label and cannot be read: null. Reported through `onBareId`.
 */
function optionLabel(v: unknown, onBareId?: () => void): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return toStr(v);
  if (typeof v === "number") {
    if (onBareId) onBareId();
    return null;
  }
  if (typeof v === "object" && !Array.isArray(v)) return toStr((v as Rec).label);
  return null;
}

/** Labels of a multi-enum value (array of `{id,label}` or strings); a single value is a list of one. */
function optionLabels(v: unknown, onBareId?: () => void): string[] {
  if (v === null || v === undefined) return [];
  const items = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of items) {
    const l = optionLabel(item, onBareId);
    if (l !== null && !out.includes(l)) out.push(l);
  }
  return out;
}

/** A field's readable text: a string, an enum label, the labels of a multi-enum joined, a monetary value's number. */
function textOf(v: unknown, onBareId?: () => void): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return toStr(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const labels = optionLabels(v, onBareId);
    return labels.length ? labels.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Rec;
    if (o.label !== undefined) return toStr(o.label);
    if (o.value !== undefined) return toStr(o.value);
  }
  return null;
}

function describe(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/* ------------------------------------------------------------------ *
 * Exported pure helpers (tested on their own)
 * ------------------------------------------------------------------ */

/**
 * Midpoint of an employee-count picklist label: "1" → 1, "2-10" → 6, "11-50" → 30,
 * "51-100" → 75, "101-250" → 175, "250+" → 300 (an open top is read as 1.2× its floor).
 * Accepts the `{id, label}` object form. Anything else → null.
 */
export function midpointFromRange(label: unknown): number | null {
  const s = optionLabel(label);
  if (s === null) return null;
  const t = s.replace(/,/g, "").replace(/\s+/g, "");
  let m = t.match(/^(\d+)[-–—](\d+)$/);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return hi < lo ? null : Math.floor((lo + hi) / 2);
  }
  m = t.match(/^(\d+)\+$/);
  if (m) return Math.round(Number(m[1]) * 1.2);
  m = t.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const LESS = "(?:<|under|below|less than|up to)";
const BUDGET_RANGE = new RegExp(`(${LESS})?\\s*\\$?\\s*(${NUM})\\s*([kK])?\\s*(?:-|–|—|to)\\s*\\$?\\s*(${NUM})\\s*([kK])?(?![\\d,])`, "i");
const BUDGET_SINGLE = new RegExp(`(${LESS})?\\s*(\\$)?\\s*(${NUM})\\s*([kK])?(?![\\d,.]*\\d)\\s*(\\+)?`, "i");

/**
 * A dollar figure from a free-text budget: "$10-20K" → 15000 (midpoint), "<$1K" → 500 (half of
 * an upper bound), "$5,000" → 5000, "10k+" → 10000, "5,220 - 6,000" → 5610, "Base Project:
 * $23,080.00" → 23080. URLs are ignored; a number without "$" or "k" counts only from 100 up
 * (so "2 sites for $5000" reads 5000, not 2). Nothing money-like → null. Never a currency
 * conversion.
 */
export function parseBudgetText(text: unknown): number | null {
  const raw = toStr(text);
  if (raw === null) return null;
  const s = raw.replace(/https?:\/\/\S+/gi, " ");
  const moneyLike = (n: number, dollar: boolean, k: boolean) => dollar || k || n >= 100;
  const num = (t: string) => Number(t.replace(/,/g, ""));

  let pos = 0;
  while (pos < s.length) {
    const rest = s.slice(pos);
    const r = rest.match(BUDGET_RANGE);
    const sg = rest.match(BUDGET_SINGLE);
    if (!r && !sg) return null;
    const useRange = r !== null && (sg === null || (r.index ?? 0) <= (sg.index ?? 0));
    if (useRange && r) {
      const dollar = /\$/.test(r[0]);
      const loRaw = num(r[2]);
      const hiRaw = num(r[4]);
      const loK = Boolean(r[3]);
      const hiK = Boolean(r[5]);
      let lo = loK ? loRaw * 1000 : loRaw;
      let hi = hiK ? hiRaw * 1000 : hiRaw;
      // A "k" on one end only applies to both when the bare end reads in the same unit: "$10-20K" → 10K–20K.
      if (hiK && !loK && loRaw <= hiRaw) lo = loRaw * 1000;
      if (loK && !hiK && hiRaw >= loRaw) hi = hiRaw * 1000;
      if (moneyLike(Math.max(lo, hi), dollar, loK || hiK) && hi >= lo) return (lo + hi) / 2;
      pos += (r.index ?? 0) + r[0].length;
      continue;
    }
    if (sg) {
      const less = Boolean(sg[1]);
      const dollar = Boolean(sg[2]);
      const k = Boolean(sg[4]);
      let n = num(sg[3]) * (k ? 1000 : 1);
      if (moneyLike(n, dollar, k)) {
        if (less) n = n / 2;
        return n;
      }
      pos += (sg.index ?? 0) + Math.max(sg[0].length, 1);
      continue;
    }
    return null;
  }
  return null;
}

/** Keyword map for agency_type, in precedence order (DESIGN §4b's Notion map, extended for Pipedrive's free text). */
const AGENCY_TYPE_RULES: ReadonlyArray<{ re: RegExp; type: AgencyType }> = [
  { re: /full.?service/i, type: "full_service" },
  { re: /consult|fractional/i, type: "consultancy" },
  { re: /niche|vertical|specialist/i, type: "niche_vertical" },
  { re: /digital|\bseo\b|\bppc\b|\bpaid\b|performance/i, type: "digital_only" },
  { re: /boutique|studio|design/i, type: "boutique" },
];

/**
 * agency_type from free text (industry / category label, services offered, specialties…):
 * full-service → full_service; consult / fractional → consultancy; niche / vertical / specialist
 * → niche_vertical; digital / SEO / PPC / paid / performance → digital_only; boutique / studio /
 * design → boutique. First rule to match anywhere in the joined text wins. Nothing → null.
 * (Direct Client organisations are typed direct_end_client by the mapper, not here.)
 */
export function classifyAgencyType(texts: ReadonlyArray<unknown>): AgencyType | null {
  const joined = texts.map((t) => toStr(t) ?? "").filter((t) => t.length > 0).join(" | ");
  if (joined.length === 0) return null;
  for (const rule of AGENCY_TYPE_RULES) if (rule.re.test(joined)) return rule.type;
  return null;
}

const DECISION_MAKER_RE = /owner|founder|\bceo\b|president|principal|partner|managing director|chief|director of operations|\bcoo\b/i;

/** true / false from a job title; null when there is no title to read. */
export function isDecisionMakerTitle(title: unknown): boolean | null {
  const s = toStr(title);
  if (s === null) return null;
  return DECISION_MAKER_RE.test(s);
}

/** The July referral rule widened to Pipedrive's lead-source spellings. AMIN is bounded so "examine" never matches. */
export const REFERRAL_RE = /referr|\bAMI\b|BABA|agency builders|\bAMIN\b|peer group/i;

const ICP_PREFIX_RE = /^ICP-[1-6]/;

const TIMING_FROM_TEMPERATURE: Readonly<Record<string, Timing>> = {
  "super hot": "within_1_week",
  hot: "within_1_month",
  warm: "within_3_months",
  cold: "no_timeline",
};

/* ------------------------------------------------------------------ *
 * Signal catalog access
 * ------------------------------------------------------------------ */

interface CatalogEntry {
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
}

function catalogOf(rubric: Rubric): Record<string, CatalogEntry> {
  const raw = (rubric as { signals?: { catalog?: Record<string, Rec> } } | null)?.signals?.catalog ?? {};
  const out: Record<string, CatalogEntry> = {};
  for (const [type, e] of Object.entries(raw)) {
    if (!e || typeof e !== "object") continue;
    const w = toNum(e.weight);
    if (w === null) continue;
    const l = toNum(e.lifespan_days);
    out[type] = { weight: w, lifespan_days: l, decays: typeof e.decays === "boolean" ? e.decays : true };
  }
  return out;
}

/** Signal types this module wants, with the catalog fallback named for each (null = skip with a note). */
export const SIGNAL_TYPES: Readonly<Record<string, { fallback: string | null }>> = {
  prior_grade: { fallback: null },
  quote_sent: { fallback: null },
  verbally_accepted: { fallback: "orbit_verbally_accepted" },
  pa_sent: { fallback: "orbit_pa_sent" },
  neg_dark_21_days: { fallback: null },
  quote_lost: { fallback: null },
  referral_warm_intro: { fallback: null },
  inbound_reply: { fallback: null },
};

/* ------------------------------------------------------------------ *
 * mapPipedriveRoster
 * ------------------------------------------------------------------ */

export function mapPipedriveRoster(input: PipedriveRosterInput): PipedriveRosterResult {
  const opts = input.opts ?? ({} as PipedriveSeedOptions);
  const asOfIso = toIso(opts.as_of);
  if (asOfIso === null) throw new Error("mapPipedriveRoster: opts.as_of must be an ISO date");
  const asOfRaw = String(opts.as_of).trim();
  /** A date-only as_of covers its whole day; a timestamp is exact. */
  const cutoffMs = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? Date.parse(asOfRaw + "T23:59:59.999Z") : Date.parse(asOfIso);
  const asOfStartMs = Date.parse(asOfIso);

  const entered_by = toStr(opts.entered_by) ?? DEFAULT_ENTERED_BY;
  const base = (toStr(opts.base_url) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const dealUrl = (id: number) => `${base}/deal/${id}`;
  const orgUrl = (id: number) => `${base}/organization/${id}`;
  const personUrl = (id: number) => `${base}/person/${id}`;
  const internal = new Set((opts.internal_org_names ?? [...DEFAULT_INTERNAL_ORG_NAMES]).map((n) => norm(n)).filter((k) => k.length > 0));
  const DK: PipedriveDealKeys = { ...PipedriveKeys.deal, ...(opts.keys?.deal ?? {}) };
  const OK: PipedriveOrgKeys = { ...PipedriveKeys.org, ...(opts.keys?.org ?? {}) };
  const catalog = catalogOf(input.rubric);

  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const noteOnce = new Set<string>();
  const once = (s: string) => {
    if (!noteOnce.has(s)) {
      noteOnce.add(s);
      notes.push(s);
    }
  };
  const bareId = () => bump(counters, "bare_option_ids");

  /* ---- index the pull ---- */
  const orgs = asList(input.orgs);
  const orgById = new Map<number, PipedriveOrg>();
  for (const o of orgs) {
    const id = toId(o?.id);
    if (id !== null) orgById.set(id, o);
  }

  const stageName = new Map<number, string>();
  for (const s of asList(input.stages as ListInput<PipedriveStage>)) {
    const id = toId(s?.id);
    const name = toStr(s?.name);
    if (id !== null && name !== null) stageName.set(id, name);
  }
  const nameOfStage = (id: number | null) => (id === null ? null : stageName.get(id) ?? null);
  const stageLabel = (id: number | null) => (id === null ? "unknown stage" : stageName.get(id) ?? `stage ${id}`);

  const personsRaw = input.persons;
  const personList: PipedrivePerson[] = Array.isArray(personsRaw) ? personsRaw : (personsRaw?.persons ?? []);
  const orgPersonsIndex: Record<string, unknown> = Array.isArray(personsRaw) ? {} : (personsRaw?.org_persons_index ?? {}) as Record<string, unknown>;
  const personById = new Map<number, PipedrivePerson>();
  const personsByOrg = new Map<number, PipedrivePerson[]>();
  for (const p of personList) {
    const id = toId(p?.id);
    if (id === null) continue;
    personById.set(id, p);
    const oid = toId(p.org_id);
    if (oid !== null) {
      const list = personsByOrg.get(oid) ?? [];
      list.push(p);
      personsByOrg.set(oid, list);
    }
  }

  const activityList: PipedriveActivity[] = Array.isArray(input.activities) ? input.activities : (input.activities?.activities ?? []);
  const activitiesByDeal = new Map<number, PipedriveActivity[]>();
  for (const a of activityList) {
    const did = toId(a?.deal_id);
    if (did === null) continue;
    const list = activitiesByDeal.get(did) ?? [];
    list.push(a);
    activitiesByDeal.set(did, list);
  }

  /* ---- Client Journey cards: one chosen card per organisation ---- */
  const skipped: RosterSkipped[] = [];
  const cardsByOrg = new Map<number, PipedriveDeal[]>();
  for (const d of asList(input.cj_deals)) {
    const id = toId(d?.id);
    if (id === null) continue;
    const oid = toId(d.org_id);
    if (oid === null) {
      skipped.push({ org_id: null, name: nameFromTitle(d.title), reason: "no org on card", cj_deal_id: id });
      continue;
    }
    const list = cardsByOrg.get(oid) ?? [];
    list.push(d);
    cardsByOrg.set(oid, list);
  }
  const chosenCard = new Map<number, PipedriveDeal>();
  for (const [oid, cards] of cardsByOrg) {
    const sorted = [...cards].sort((a, b) => {
      const ao = a.status === "open" ? 0 : 1;
      const bo = b.status === "open" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const au = ms(a.update_time) ?? -Infinity;
      const bu = ms(b.update_time) ?? -Infinity;
      if (au !== bu) return bu - au;
      return (toId(b.id) ?? 0) - (toId(a.id) ?? 0);
    });
    chosenCard.set(oid, sorted[0]);
    if (sorted.length > 1) bump(counters, "orgs_with_several_cj_cards");
  }

  /* ---- open pipeline-1 deals per organisation, most recently updated first ---- */
  const p1ByOrg = new Map<number, PipedriveDeal[]>();
  for (const d of asList(input.p1_deals)) {
    if (toId(d?.id) === null) continue;
    if ((d.status ?? "open") !== "open") continue;
    const pipeline = toId(d.pipeline_id);
    if (pipeline !== null && pipeline !== 1) continue;
    const oid = toId(d.org_id);
    if (oid === null) {
      skipped.push({ org_id: null, name: toStr(d.title), reason: "no org on deal", cj_deal_id: null });
      continue;
    }
    const list = p1ByOrg.get(oid) ?? [];
    list.push(d);
    p1ByOrg.set(oid, list);
  }
  for (const list of p1ByOrg.values()) {
    list.sort((a, b) => (ms(b.update_time) ?? -Infinity) - (ms(a.update_time) ?? -Infinity) || (toId(a.id) ?? 0) - (toId(b.id) ?? 0));
  }

  /* ---- roster decision ---- */
  const candidateOrgIds = [...new Set([...chosenCard.keys(), ...p1ByOrg.keys()])].sort((a, b) => a - b);
  const roster: Array<{ org: PipedriveOrg; org_id: number; card: PipedriveDeal | null; p1: PipedriveDeal[] }> = [];

  for (const oid of candidateOrgIds) {
    const card = chosenCard.get(oid) ?? null;
    const org = orgById.get(oid) ?? null;
    const name = toStr(org?.name) ?? (card ? nameFromTitle(card.title) : null) ?? (p1ByOrg.get(oid)?.[0] ? toStr(p1ByOrg.get(oid)![0].title) : null);
    const cardId = card ? toId(card.id) : null;
    const skip = (reason: string) => skipped.push({ org_id: oid, name, reason, cj_deal_id: cardId });

    if (name !== null && internal.has(norm(name))) {
      skip("internal organisation");
      continue;
    }
    if (card) {
      const stage = toId(card.stage_id);
      const status = toStr(card.status) ?? "open";
      if (status !== "open") {
        skip(`CJ card ${status}: ${stageLabel(stage)}`);
        continue;
      }
      if (stage !== null && CJ_CLIENT_STAGES.includes(stage)) {
        skip(`CJ client stage: ${stageLabel(stage)}`);
        continue;
      }
      if (stage === CJ_FRIENDS_STAGE) {
        skip("Friends of WLIQ");
        continue;
      }
      if (stage === null || !CJ_PROSPECT_STAGES.includes(stage)) {
        skip(`CJ stage not mapped: ${stageLabel(stage)}`);
        continue;
      }
    }
    if (org === null) {
      skip("org not in pull");
      continue;
    }
    if (name === null) {
      skip("org has no name");
      continue;
    }
    roster.push({ org, org_id: oid, card, p1: p1ByOrg.get(oid) ?? [] });
  }

  /* ---- account keys: norm(name), disambiguated, never merged ---- */
  const usedKeys = new Set<string>();
  const keyOf = new Map<number, string>();
  const keyFlags = new Map<number, string[]>();
  for (const r of roster) {
    const name = toStr(r.org.name) as string;
    const flags: string[] = [];
    let key = norm(name);
    if (key.length === 0) {
      key = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      if (key.length === 0) key = `pipedrive org ${r.org_id}`;
      notes.push(`org ${r.org_id}: name normalises to an empty key; using "${key}"`);
    }
    if (usedKeys.has(key)) {
      const plain = key;
      key = `${key} pipedrive-${r.org_id}`;
      flags.push("Duplicate name key");
      notes.push(`org ${r.org_id}: key "${plain}" is already taken by another roster org; kept separately as "${key}" (never merged)`);
    }
    usedKeys.add(key);
    keyOf.set(r.org_id, key);
    keyFlags.set(r.org_id, flags);
  }

  /* ---- emit ---- */
  const accounts: RosterAccount[] = [];
  const facts: RosterFact[] = [];
  const signals: RosterSignal[] = [];
  const contacts: RosterContact[] = [];
  const deals: RosterDeal[] = [];
  const cj_index: Record<string, CjIndexEntry> = {};
  const byCjStage: Record<string, number> = {};
  let p1Only = 0;
  let parked = 0;
  let droppedAfterAsOf = 0;
  let stageEnteredFromAddTime = 0;
  const rosterOrgIds = new Set(roster.map((r) => r.org_id));

  const signalType = (wanted: string): string | null => {
    if (catalog[wanted]) return wanted;
    const fb = SIGNAL_TYPES[wanted]?.fallback ?? null;
    if (fb !== null && catalog[fb]) {
      once(`signal type '${wanted}' is not in the rubric catalog; emitted as '${fb}'`);
      return fb;
    }
    once(`signal type '${wanted}' is not in the rubric catalog and has no fallback; skipped`);
    return null;
  };

  const pushSignal = (account_key: string, wanted: string, observed: unknown, payload: Record<string, unknown>, evidence_url: string | null) => {
    const type = signalType(wanted);
    if (type === null) return;
    const iso = toIso(observed);
    if (iso === null) {
      bump(counters, "signals_without_observed_at");
      return;
    }
    if (Date.parse(iso) > cutoffMs) {
      droppedAfterAsOf++;
      return;
    }
    const cat = catalog[type];
    const full: Record<string, unknown> = wanted === type ? { ...payload } : { ...payload, requested_type: wanted };
    signals.push({
      account_key,
      type,
      observed_at: iso,
      payload: full,
      source: PIPEDRIVE_SOURCE,
      weight: cat.weight,
      lifespan_days: cat.lifespan_days,
      decays: cat.decays,
      entered_by,
      evidence_url,
    });
  };

  for (const r of roster) {
    const { org, org_id, card, p1 } = r;
    const account_key = keyOf.get(org_id) as string;
    const name = toStr(org.name) as string;
    const flags = [...(keyFlags.get(org_id) ?? [])];
    const OF = fields(org);
    const orgDate = toDate(org.update_time);
    const cardStage = card ? toId(card.stage_id) : null;
    const cardId = card ? toId(card.id) : null;

    /** Deal-level fields: the card first, then open pipeline-1 deals (latest first). */
    const records: PipedriveDeal[] = card ? [card, ...p1] : [...p1];
    const field = (key: string): { value: unknown; rec: PipedriveDeal } | null => {
      for (const rec of records) {
        const v = fields(rec)[key];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && v.trim().length === 0) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        return { value: v, rec };
      }
      return null;
    };
    const recId = (rec: PipedriveDeal) => toId(rec.id) as number;
    const recUrl = (rec: PipedriveDeal) => dealUrl(recId(rec));
    const recDate = (rec: PipedriveDeal) => toDate(rec.update_time) ?? toDate(rec.add_time);
    const recKind = (rec: PipedriveDeal) => (rec === card ? "CJ card" : "pipeline-1 deal");

    const fact = (key: string, value: unknown, evidence_label: EvidenceLabel, note: string, evidence_url: string | null, observed_at: string | null) => {
      facts.push({ account_key, key, value, evidence_label, source: PIPEDRIVE_SOURCE, evidence_url, observed_at, entered_by, note });
    };
    const factFrom = (key: string, value: unknown, evidence_label: EvidenceLabel, f: { value: unknown; rec: PipedriveDeal }, verbatim: string, extra = "") => {
      fact(key, value, evidence_label, `Pipedrive ${recKind(f.rec)} ${recId(f.rec)} "${verbatim}"${extra}`, recUrl(f.rec), recDate(f.rec));
    };
    const orgFact = (key: string, value: unknown, evidence_label: EvidenceLabel, note: string) => {
      fact(key, value, evidence_label, `Pipedrive organization ${org_id} ${note}`, orgUrl(org_id), orgDate);
    };

    /* ---- account ---- */
    const orgTypeLabel = optionLabel(OF[OK.organization_type], bareId);
    const relationship_type: RelationshipType | null = orgTypeLabel === null
      ? null
      : /direct/i.test(orgTypeLabel) ? "direct" : /agency/i.test(orgTypeLabel) ? "agency" : null;
    if (orgTypeLabel !== null && relationship_type === null) notes.push(`org ${org_id}: organization type "${orgTypeLabel}" is neither Agency nor Direct Client; relationship left unknown`);

    const linkedPersons = collectPersons(org_id, records, personById, personsByOrg, orgPersonsIndex);
    let domain = normalizeDomain(org.website) ?? normalizeDomain(toStr(OF[OK.email]));
    if (domain === null) {
      for (const p of linkedPersons) {
        for (const e of emailsOf(p)) {
          domain = domainFromEmail(e);
          if (domain !== null) break;
        }
        if (domain !== null) break;
      }
    }

    const book: RosterAccount["book"] = cardStage === CJ_PARKED_STAGE ? "parked" : "prospect";
    if (book === "parked") {
      flags.push(`Parked: ${stageLabel(cardStage)}`);
      parked++;
    }
    if (card === null) {
      flags.push("No CJ card");
      p1Only++;
    }
    if (card) bump(byCjStage, stageLabel(cardStage));

    accounts.push({
      key: account_key,
      account_key,
      name,
      domain,
      pipedrive_org_id: org_id,
      roster_source: PIPEDRIVE_SOURCE,
      roster_certified: true,
      relationship_type,
      book,
      flags,
    });

    if (card && cardId !== null && cardStage !== null) {
      cj_index[account_key] = { cj_deal_id: cardId, stage_id: cardStage, stage_name: nameOfStage(cardStage), org_id };
    }

    /* ---- Dimension B facts ---- */
    const icp = field(DK.icp_class);
    if (icp) {
      const label = optionLabel(icp.value, bareId);
      const m = label === null ? null : label.match(ICP_PREFIX_RE);
      if (m) factFrom("icp_class", m[0], "inferred", icp, label as string);
      else if (label !== null) bump(counters, "icp_unclassified");
    }

    if (relationship_type !== null) {
      orgFact("is_agency", relationship_type === "agency", "inferred", `organization type "${orgTypeLabel}"`);
    }

    const industryCategory = optionLabel(OF[OK.industry_category], bareId);
    const servicesOffered = textOf(OF[OK.services_offered], bareId);
    const specialties = textOf(OF[OK.specialties], bareId);
    const industriesServed = textOf(OF[OK.industries_served], bareId);
    if (relationship_type === "direct") {
      orgFact("agency_type", "direct_end_client", "inferred", `organization type "${orgTypeLabel}"`);
    } else {
      const at = classifyAgencyType([industryCategory, servicesOffered, specialties]);
      if (at !== null) {
        orgFact("agency_type", at, "inferred", `keyword map over industry/category, services offered and specialties: ${describe([industryCategory, servicesOffered, specialties].filter((t) => t !== null).join(" | "), 80)}`);
      }
    }

    const stdHeadcount = toNum(org.employee_count);
    if (stdHeadcount !== null && stdHeadcount > 0) {
      // A CRM-entered count is a person's statement, not an observed primary record. The locked
      // headroom method counts only LinkedIn, the site or Clutch as evidence, so this is inferred.
      orgFact("headcount", stdHeadcount, "inferred", `standard field employee_count = ${stdHeadcount} (CRM-entered; not a primary record)`);
    } else {
      const rangeLabel = optionLabel(OF[OK.employee_range], bareId);
      const mid = midpointFromRange(rangeLabel);
      if (mid !== null) orgFact("headcount", mid, "inferred", `range midpoint of ${rangeLabel}`);
      else if (rangeLabel !== null) notes.push(`org ${org_id}: employee range "${rangeLabel}" not understood; headcount left unknown`);
    }

    /* ---- Dimension A facts ---- */
    const temp = field(DK.lead_temperature);
    if (temp) {
      const label = optionLabel(temp.value, bareId);
      const timing = label === null ? undefined : TIMING_FROM_TEMPERATURE[label.toLowerCase()];
      if (timing) {
        factFrom("timing", timing, "inferred", temp, label as string, " (lead temperature)");
        factFrom("timing_state", timing === "no_timeline" ? "absent" : "present", "inferred", temp, label as string, timing === "no_timeline" ? " (Cold: no timeline stated)" : " (a timeline is stated)");
      } else if (label !== null) {
        notes.push(`org ${org_id}: lead temperature "${label}" is not Super Hot/Hot/Warm/Cold; timing left unknown`);
      }
    }

    const src = field(DK.lead_source);
    const chan = field(DK.lead_channel);
    const detail = field(DK.lead_source_detail);
    const sourceTexts = [src, chan, detail].map((f) => (f ? textOf(f.value, bareId) : null));
    const filledSources = sourceTexts.filter((t): t is string => t !== null);
    let referralHit: { text: string; f: { value: unknown; rec: PipedriveDeal } } | null = null;
    if (filledSources.length > 0) {
      const candidates = [src, chan, detail];
      for (let i = 0; i < candidates.length; i++) {
        const t = sourceTexts[i];
        const f = candidates[i];
        if (t !== null && f && REFERRAL_RE.test(t)) {
          referralHit = { text: t, f };
          break;
        }
      }
      if (referralHit) {
        factFrom("referral_from_network", true, "inferred", referralHit.f, describe(referralHit.text), " matches the referral rule");
      } else {
        const f = (src ?? chan ?? detail) as { value: unknown; rec: PipedriveDeal };
        factFrom("referral_from_network", false, "inferred", f, describe(filledSources.join(" / ")), " — lead source filled, no referral match");
      }
    }

    const budget = field(DK.stated_budget);
    const budgetText = budget ? textOf(budget.value, bareId) : null;
    const quotedDeals = p1.filter((d) => {
      const s = toId(d.stage_id);
      return s !== null && P1_QUOTED_OR_BEYOND.includes(s);
    });
    const valuedDeals = p1.filter((d) => (toNum(d.value) ?? 0) > 0);
    const p1Dates = p1.map((d) => toDate(d.update_time)).reduce<string | null>((acc, d) => laterDate(acc, d), null);
    if (budgetText !== null && budget) {
      factFrom("money", "present", "inferred", budget, describe(budgetText), " (stated budget)");
    } else if (valuedDeals.length > 0) {
      const d = valuedDeals[0];
      fact("money", "present", "inferred", `open pipeline-1 deal ${recId(d)} carries value ${toNum(d.value)}`, recUrl(d), recDate(d));
    } else if (quotedDeals.length > 0) {
      const d = quotedDeals[0];
      fact("money", "present", "inferred", `open pipeline-1 deal ${recId(d)} in stage ${stageLabel(toId(d.stage_id))}`, recUrl(d), recDate(d));
    }

    const services = field(DK.services_of_interest);
    const serviceLabels = services ? optionLabels(services.value, bareId) : [];
    if (serviceLabels.length > 0 && services) {
      factFrom("specification", "present", "inferred", services, serviceLabels.join(", "), " (services of interest)");
    } else if (quotedDeals.length > 0) {
      const d = quotedDeals[0];
      fact("specification", "present", "inferred", `open pipeline-1 deal ${recId(d)} in stage ${stageLabel(toId(d.stage_id))}`, recUrl(d), recDate(d));
    }

    const dm = linkedPersons.find((p) => isDecisionMakerTitle(p.job_title) === true);
    if (dm) {
      const pid = toId(dm.id) as number;
      fact("authority", "present", "inferred", `linked person ${pid} has job title "${toStr(dm.job_title)}"`, personUrl(pid), toDate(dm.update_time) ?? (card ? recDate(card) : null) ?? p1Dates ?? orgDate);
    }

    const wliqServices = serviceLabels.filter((l) => l.toLowerCase() !== "other");
    if (wliqServices.length > 0 && services) {
      factFrom("service_shape", "Core", "inferred", services, wliqServices.join(", "), " — every listed service is a WLIQ family");
    }

    const parsedBudget = budgetText === null ? null : parseBudgetText(budgetText);
    if (budget && budgetText !== null && parsedBudget !== null) {
      factFrom("deal_size_estimate", parsedBudget, "inferred", budget, describe(budgetText), " parsed to dollars");
    } else {
      if (budgetText !== null) notes.push(`org ${org_id}: stated budget ${describe(budgetText, 40)} has no readable dollar figure; deal_size_estimate from deal value if any`);
      const largest = valuedDeals.reduce<PipedriveDeal | null>((best, d) => (best === null || (toNum(d.value) ?? 0) > (toNum(best.value) ?? 0) ? d : best), null);
      if (largest) fact("deal_size_estimate", toNum(largest.value), "evidence", `largest open pipeline-1 deal ${recId(largest)} value`, recUrl(largest), recDate(largest));
    }

    /* ---- informational facts (verbatim, only when non-empty) ---- */
    if (card && cardId !== null) {
      fact("pipedrive_cj_deal_id", cardId, "inferred", "Client Journey card id (write-back target)", dealUrl(cardId), recDate(card));
      fact("pipedrive_cj_stage", stageLabel(cardStage), "inferred", `Client Journey stage ${cardStage}`, dealUrl(cardId), recDate(card));
    }
    const info = (key: string, f: { value: unknown; rec: PipedriveDeal } | null, value: unknown, verbatim: string) => {
      if (f === null || value === null || value === undefined) return;
      if (Array.isArray(value) && value.length === 0) return;
      factFrom(key, value, "inferred", f, verbatim);
    };
    info("pipedrive_lead_source", src, sourceTexts[0], "Lead source");
    info("pipedrive_lead_channel", chan, sourceTexts[1], "Lead channel");
    info("pipedrive_lead_source_detail", detail, sourceTexts[2], "Lead source detail");
    info("pipedrive_stated_budget", budget, budgetText, "Stated budget");
    info("pipedrive_services_of_interest", services, serviceLabels, "Services of interest");
    if (servicesOffered !== null) orgFact("pipedrive_services_offered", servicesOffered, "inferred", '"Services offered"');
    if (industriesServed !== null) orgFact("pipedrive_industries_served", industriesServed, "inferred", '"Client industries served"');
    if (specialties !== null) orgFact("pipedrive_specialties", specialties, "inferred", '"Specialties / positioning"');
    const ownerRec = card ?? p1[0] ?? null;
    const ownerId = toId(ownerRec?.owner_id) ?? toId(org.owner_id);
    if (ownerId !== null) {
      if (ownerRec && toId(ownerRec.owner_id) !== null) factFrom("pipedrive_owner_id", ownerId, "inferred", { value: ownerId, rec: ownerRec }, "owner_id");
      else orgFact("pipedrive_owner_id", ownerId, "inferred", "owner_id");
    }
    const sales = field(DK.salesperson);
    info("pipedrive_salesperson", sales, sales ? optionLabel(sales.value, bareId) : null, "Salesperson");
    const am = field(DK.account_manager);
    info("pipedrive_account_manager", am, am ? optionLabel(am.value, bareId) : null, "Account manager");
    const lost = field(DK.lost_reason);
    const lostNotes = field(DK.lost_reason_notes);
    const lostLabel = lost ? optionLabel(lost.value, bareId) : null;
    const lostText = lostLabel ?? (lostNotes ? textOf(lostNotes.value, bareId) : null) ?? (card ? toStr(card.lost_reason) : null);
    if (lostText !== null) {
      const f = lost ?? lostNotes ?? (card ? { value: card.lost_reason, rec: card } : null);
      if (f) factFrom("pipedrive_lost_reason", lostText, "inferred", f, "Lost reason");
    }
    const summary = field(DK.status_summary);
    info("pipedrive_status_summary", summary, summary ? textOf(summary.value, bareId) : null, "Deal status summary / next step");
    const cstage = field(DK.client_stage);
    info("pipedrive_client_stage", cstage, cstage ? optionLabel(cstage.value, bareId) : null, "Client stage");
    const notion = textOf(OF[OK.notion_link], bareId);
    if (notion !== null) orgFact("pipedrive_notion_link", notion, "inferred", '"Notion research link"');
    const ciq = field(DK.clientiq_url);
    info("pipedrive_clientiq_url", ciq, ciq ? textOf(ciq.value, bareId) : null, "ClientIQ journey URL");

    /* ---- signals ---- */
    const grade = field(DK.grade);
    const gradeLabel = grade ? optionLabel(grade.value, bareId) : null;
    if (grade && gradeLabel !== null) {
      pushSignal(account_key, "prior_grade", grade.rec.update_time, { field: "Grade", value: gradeLabel, deal_id: recId(grade.rec) }, recUrl(grade.rec));
    }
    if (temp) {
      const label = optionLabel(temp.value, bareId);
      if (label !== null) pushSignal(account_key, "prior_grade", temp.rec.update_time, { field: "Lead temperature", value: label, deal_id: recId(temp.rec) }, recUrl(temp.rec));
    }
    for (const d of p1) {
      const s = toId(d.stage_id);
      const did = recId(d);
      const entered = d.stage_change_time ?? d.add_time;
      const payload = { deal_id: did, title: toStr(d.title), value: toNum(d.value), stage: stageLabel(s) };
      if (s === STAGE.p1.quoted || s === STAGE.p1.refine) pushSignal(account_key, "quote_sent", entered, payload, dealUrl(did));
      else if (s === STAGE.p1.verbally_accepted) pushSignal(account_key, "verbally_accepted", entered, payload, dealUrl(did));
      else if (s === STAGE.p1.pa_sent) pushSignal(account_key, "pa_sent", entered, payload, dealUrl(did));
      else if (s === STAGE.p1.unresponsive) pushSignal(account_key, "neg_dark_21_days", entered, payload, dealUrl(did));
    }
    if (card && cardId !== null && cardStage === STAGE.cj.quote_lost) {
      pushSignal(account_key, "quote_lost", card.stage_change_time ?? card.add_time, { deal_id: cardId, lost_reason: lostText }, dealUrl(cardId));
    }
    if (referralHit) {
      pushSignal(account_key, "referral_warm_intro", referralHit.f.rec.add_time, {
        deal_id: recId(referralHit.f.rec),
        lead_source: sourceTexts[0],
        lead_channel: sourceTexts[1],
        lead_source_detail: sourceTexts[2],
        matched: describe(referralHit.text),
      }, recUrl(referralHit.f.rec));
    }
    const inquiry = field(DK.inbound_inquiry);
    const inquiryText = inquiry ? textOf(inquiry.value, bareId) : null;
    if (inquiry && inquiryText !== null) {
      pushSignal(account_key, "inbound_reply", inquiry.rec.add_time, { deal_id: recId(inquiry.rec), field: "Inbound inquiry message", chars: inquiryText.length }, recUrl(inquiry.rec));
    }

    /* ---- contacts ---- */
    for (const p of linkedPersons) {
      const pid = toId(p.id) as number;
      const emails = emailsOf(p);
      const first = toStr(p.first_name);
      const last = toStr(p.last_name);
      contacts.push({
        account_key,
        name: toStr(p.name) ?? (first || last ? [first, last].filter((x) => x !== null).join(" ") : null),
        email: emails[0] ?? null,
        title: toStr(p.job_title),
        pipedrive_person_id: pid,
        is_decision_maker: isDecisionMakerTitle(p.job_title),
        source: PIPEDRIVE_SOURCE,
      });
    }

    /* ---- pb_deals rows: open pipeline-1 deals ---- */
    for (const d of p1) {
      const did = recId(d);
      const s = toId(d.stage_id);
      let stage_entered_at = toIso(d.stage_change_time);
      if (stage_entered_at === null) {
        stage_entered_at = toIso(d.add_time);
        if (stage_entered_at !== null) stageEnteredFromAddTime++;
      }
      const acts = activitiesByDeal.get(did) ?? [];
      let next_meeting_at: string | null = null;
      let callsHeld = 0;
      for (const a of acts) {
        const type = (toStr(a.type) ?? "").toLowerCase();
        if (type !== "meeting" && type !== "call") continue;
        const done = toBool(a.done);
        if (done === true) {
          callsHeld++;
          continue;
        }
        const due = dueIso(a.due_date, a.due_time);
        if (due === null) continue;
        if (Date.parse(due) >= asOfStartMs && (next_meeting_at === null || due < next_meeting_at)) next_meeting_at = due;
      }
      const labelled: Record<string, unknown> = {};
      const cf = fields(d);
      for (const [label, hash] of Object.entries(DK)) {
        const v = cf[hash];
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) {
          const ls = optionLabels(v, bareId);
          if (ls.length) labelled[label] = ls;
        } else {
          const t = textOf(v, bareId);
          if (t !== null) labelled[label] = t;
        }
      }
      deals.push({
        pipedrive_deal_id: did,
        account_key,
        title: toStr(d.title),
        pipeline_id: toId(d.pipeline_id),
        stage_id: s,
        stage_name: nameOfStage(s),
        stage_entered_at,
        value: toNum(d.value),
        currency: toStr(d.currency),
        close_date: toDate(d.expected_close_date),
        close_date_pushes: [],
        status: toStr(d.status) ?? "open",
        won_time: toIso(d.won_time),
        lost_time: toIso(d.lost_time),
        owner_user_id: toId(d.owner_id),
        is_cj: false,
        next_meeting_at,
        calls_held: callsHeld > 0 ? callsHeld : null,
        raw: { custom_fields_labelled: labelled, grade_label: optionLabel(cf[DK.grade], bareId) },
      });
    }
  }

  /* ---- summary ---- */
  if (droppedAfterAsOf > 0) notes.push(`${droppedAfterAsOf} signal(s) dropped: observed_at after as_of ${asOfRaw}`);
  if (stageEnteredFromAddTime > 0) notes.push(`${stageEnteredFromAddTime} open pipeline-1 deal(s) have no stage_change_time; stage_entered_at taken from add_time (never moved stage)`);
  if (counters.orgs_with_several_cj_cards) notes.push(`${counters.orgs_with_several_cj_cards} org(s) carry several Client Journey cards; the most recently updated open card rules`);
  if (counters.icp_unclassified) notes.push(`${counters.icp_unclassified} roster org(s) have an ICP label without an ICP-1…6 prefix (Unclassified); no icp_class fact emitted`);
  if (counters.bare_option_ids) notes.push(`${counters.bare_option_ids} enum value(s) arrived as bare option ids without labels; skipped`);
  if (counters.signals_without_observed_at) notes.push(`${counters.signals_without_observed_at} signal(s) had no usable observed_at; skipped`);
  const missingCatalog = Object.keys(SIGNAL_TYPES).filter((t) => !catalog[t]);
  if (missingCatalog.length) once(`rubric catalog lacks: ${missingCatalog.join(", ")} (fallbacks: ${missingCatalog.map((t) => `${t}→${SIGNAL_TYPES[t].fallback ?? "skip"}`).join(", ")})`);
  if (!rosterOrgIds.size) notes.push("no roster organisations found");

  const facts_by_key: Record<string, number> = {};
  for (const f of facts) bump(facts_by_key, f.key);
  const signals_by_type: Record<string, number> = {};
  for (const s of signals) bump(signals_by_type, s.type);
  const skipped_by_reason: Record<string, number> = {};
  for (const s of skipped) bump(skipped_by_reason, s.reason);

  return {
    accounts,
    facts,
    signals,
    contacts,
    deals,
    cj_index,
    skipped,
    summary: {
      roster_orgs: accounts.length,
      by_cj_stage: byCjStage,
      p1_only: p1Only,
      parked,
      facts: facts.length,
      facts_by_key,
      signals: signals.length,
      signals_by_type,
      contacts: contacts.length,
      deals: deals.length,
      skipped: skipped.length,
      skipped_by_reason,
      notes,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Persons and activities helpers
 * ------------------------------------------------------------------ */

/** "CJ - Harbor Pine" → "Harbor Pine"; any other title verbatim; empty → null. */
function nameFromTitle(title: unknown): string | null {
  const s = toStr(title);
  if (s === null) return null;
  return toStr(s.replace(/^CJ\s*[-–—:]\s*/i, ""));
}

/** Email addresses of a person, primary first. Objects `{value, primary}` and bare strings both read. */
function emailsOf(p: PipedrivePerson): string[] {
  const raw = p.emails;
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const primary: string[] = [];
  const rest: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const s = toStr(item);
      if (s !== null && s.includes("@")) rest.push(s);
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Rec;
      const s = toStr(o.value);
      if (s === null || !s.includes("@")) continue;
      if (toBool(o.primary) === true) primary.push(s);
      else rest.push(s);
    }
  }
  return [...primary, ...rest];
}

/**
 * Every person linked to a roster organisation: persons whose org_id is the org, persons
 * listed under it in the pull's org_persons_index, and the person on each of its cards/deals.
 * Deduplicated by person id, in that order.
 */
function collectPersons(
  org_id: number,
  records: PipedriveDeal[],
  personById: Map<number, PipedrivePerson>,
  personsByOrg: Map<number, PipedrivePerson[]>,
  orgPersonsIndex: Record<string, unknown>,
): PipedrivePerson[] {
  const seen = new Set<number>();
  const out: PipedrivePerson[] = [];
  const add = (p: PipedrivePerson | undefined) => {
    if (!p) return;
    const id = toId(p.id);
    if (id === null || seen.has(id)) return;
    seen.add(id);
    out.push(p);
  };
  for (const p of personsByOrg.get(org_id) ?? []) add(p);
  const indexed = orgPersonsIndex[String(org_id)];
  if (Array.isArray(indexed)) for (const pid of indexed) add(personById.get(toId(pid) ?? -1));
  for (const rec of records) {
    const pid = toId(rec.person_id);
    if (pid !== null) add(personById.get(pid));
  }
  return out;
}

/** Pipedrive's due_date "YYYY-MM-DD" + due_time "HH:MM" (may be empty; treated as UTC) → ISO, or null. */
function dueIso(date: unknown, time: unknown): string | null {
  const d = toStr(date);
  if (d === null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = toStr(time);
  const hm = t !== null && /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? t : "00:00";
  return toIso(`${d} ${hm}`);
}
