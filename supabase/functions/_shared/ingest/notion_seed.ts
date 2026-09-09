/**
 * WLIQ Prospect Book — Notion master seed mapper (DESIGN.md §4b).
 *
 *   one Notion "Clients master" row (Record type = Prospect)
 *     → a pb_accounts row + its pb_facts + its pb_signals + its pb_contacts
 *
 * PURE. No clock, no network, no filesystem, no dependencies. Runs under Deno and under
 * `node --experimental-strip-types`.
 *
 * Property names are used VERBATIM: every fact's note starts with `Notion "<property>" = <value>`
 * so a reader can trace a seeded value back to the cell it came from. The row is a plain object
 * keyed by those names, as a Notion SQL export gives them.
 *
 * Rules honoured here:
 *   - Unknown is never evidence. An empty property produces nothing. An explicit "Unknown"
 *     selection produces a fact whose value is the recorded unknown (null; or the word "unknown"
 *     for a Dimension A item, which is its FactState) with evidence_label "unknown": a person
 *     looked and did not know, which is worth recording, and which never fires a gate, an
 *     adjustment or a warning. A stated value the map does not recognise is kept the same way —
 *     value unknown, the verbatim text in the note — never guessed at.
 *   - Everything seeded is uncertified intake (PRO-6): roster_source notion_master,
 *     roster_certified false, book prospect. Every mapped value is "inferred" (a person selected
 *     it; there is no primary record behind it).
 *   - Vocabularies and aliases come from the rubric where the rubric states them (service shape,
 *     the four Dimension A items, ceilings, ICP classes, WL levels). The DESIGN §4b table is the
 *     fallback, and the source for the ones the rubric does not carry (relationship type,
 *     economics, broker character, the agency-type keyword map, the referral keyword rule).
 *   - Signal weight, lifespan and decay come from rubric.signals.catalog; never hard-coded.
 *   - "Est Year-1 $" is a band someone selected, not a quote: it is a prior_grade signal, never
 *     quote_amount (§14.5 C2). "Active project / immediate need?" ≈ specification is an
 *     approximation and every such fact says so in its note (DECISIONS §3.6).
 *   - A row that is already an Agency Partner (Business Status = Client, or T12M billings > 0)
 *     is not seeded (PRO-10). It is returned as skipped with the reason text the run log uses.
 */

import type { RelationshipType, Rubric } from "../core/prospect_types.ts";
import { domainFromEmail, norm, normalizeDomain } from "./identity.ts";

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/** What a Notion SQL export puts in a cell: a scalar, a list (multi-select, people) or an object. */
export type NotionValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | NotionValue[]
  | { [key: string]: unknown };

/** A Clients-master row keyed by the VERBATIM Notion property names (see PROPERTY). */
export interface NotionProspectRow {
  [property: string]: NotionValue;
}

/** The property names DESIGN.md §4b maps, verbatim. Exported so a seed script can select exactly these. */
export const PROPERTY = {
  client_name: "Client Name",
  client_id: "Client ID",
  record_type: "Record type",
  business_status: "Business Status",
  t12m_billings: "T12M billings $",
  last_edited: "Last edited",
  relationship_type: "Relationship type",
  icp_class: "ICP class",
  agency_type: "Agency type",
  headcount: "Headcount",
  wl_signal: "WL signal",
  gate_needs: "Gate: needs what we do",
  gate_afford: "Gate: can afford us",
  gate_decent: "Gate: decent to deal with",
  decision_maker: "Key decision maker?",
  lead_priority: "Lead priority",
  active_project: "Active project / immediate need?",
  ceiling: "Ceiling",
  proof_of_growth: "Proof of growth",
  est_year1: "Est Year-1 $",
  referral_source: "Referral source",
  trigger_event: "Trigger event",
  grade_effective: "Prospect grade (effective)",
  grade_sql: "SQL grade (auto)",
  grade_adjustment: "Grade adjustment (rule)",
  override_reason: "Override reason",
  headroom_rank: "Headroom / vendor rank",
  contact_name: "Contact name",
  contact_title: "Contact title",
  contact_email: "Contact email",
  additional_contacts: "Additional contacts",
  status: "Status",
  current_am: "Current AM",
} as const;

/** Optional properties the mapper reads when present (not in the §4b table; tolerated, never required). */
export const OPTIONAL_PROPERTY = {
  page_id: ["Page ID", "page_id", "Notion page id", "id"],
  last_edited_alt: ["Last edited time", "last_edited_time"],
  website: ["Website", "Domain", "URL"],
} as const;

export const NOTION_SOURCE = "notion_master";
export const DEFAULT_ENTERED_BY = "system:notion_master";
/** The exact run-log text for a row that PRO-10 says is already an Agency Partner. */
export const STALE_PROSPECT_REASON = "already an Agency Partner — stale prospect row";

export interface NotionSeedOptions {
  /** The active rubric. Signal weights, lifespans, decay and the alias tables are read from it. */
  rubric: Rubric;
  /** pb_facts.entered_by / pb_signals.entered_by. Default "system:notion_master". */
  entered_by?: string;
  /**
   * Fallback observed_at when a row carries no "Last edited" date. The mapper never reads a
   * clock; the caller passes the run date if it wants one. Without either, facts carry a null
   * observed_at and signals (whose observed_at is NOT NULL) are dropped with a note.
   */
  as_of?: string;
}

/* ------------------------------------------------------------------ *
 * Output (column names are the pb_* column names; account_key joins to pb_accounts.key)
 * ------------------------------------------------------------------ */

export interface SeedAccount {
  key: string;
  name: string;
  domain: string | null;
  notion_client_id: string | null;
  notion_page_id?: string | null;
  roster_source: "notion_master";
  roster_certified: false;
  relationship_type: RelationshipType | null;
  book: "prospect";
}

export interface SeedFact {
  /** pb_accounts.key of the row this fact belongs to (the sync resolves account_id). */
  account_key: string;
  key: string;
  value: unknown;
  evidence_label: "evidence" | "inferred" | "unknown";
  source: "notion_master";
  /** ISO date (YYYY-MM-DD) — pb_facts.observed_at is a date. */
  observed_at: string | null;
  entered_by: string;
  note: string;
}

export interface SeedSignal {
  account_key: string;
  type: string;
  /** ISO timestamp — pb_signals.observed_at is a timestamptz. */
  observed_at: string;
  payload: Record<string, unknown>;
  source: "notion_master";
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
  entered_by: string;
}

export interface SeedContact {
  account_key: string;
  name: string | null;
  email: string | null;
  title: string | null;
  source: "notion_master";
}

export interface NotionSeedResult {
  /** null = seed it; otherwise the reason it was not seeded (facts/signals/contacts are then empty). */
  skip: null | { reason: string };
  /** The account row; null only when the row has no usable Client Name. */
  account: SeedAccount | null;
  facts: SeedFact[];
  signals: SeedSignal[];
  contacts: SeedContact[];
  /** Everything dropped, unmapped or approximated, in plain words, for the run log. */
  notes: string[];
}

export interface NotionSeedBatchResult {
  accounts: SeedAccount[];
  facts: SeedFact[];
  signals: SeedSignal[];
  contacts: SeedContact[];
  skipped: Array<{ name: string; reason: string }>;
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Small coercions. Nothing here invents a value.
 * ------------------------------------------------------------------ */

/** Case, whitespace, hyphen, dash, underscore and "$" insensitive comparison key. */
function fold(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/[\s_\-–—]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Property-name comparison: exact first; then case- and whitespace-insensitive. */
function foldProp(s: string): string {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function getProp(row: NotionProspectRow, name: string): NotionValue {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const want = foldProp(name);
  for (const k of Object.keys(row)) if (foldProp(k) === want) return row[k];
  return undefined;
}

function getFirstProp(row: NotionProspectRow, names: readonly string[]): NotionValue {
  for (const n of names) {
    const v = getProp(row, n);
    if (v !== null && v !== undefined && !(typeof v === "string" && v.trim().length === 0)) return v;
  }
  return undefined;
}

/** A cell as one trimmed string, or null when empty. Lists join with ", "; Notion objects yield their name/email/text. */
function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 0 ? s : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const parts = v.map(asText).filter((x): x is string => x !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "title", "email", "plain_text", "content", "start", "id"]) {
      const t = asText(o[k]);
      if (t !== null) return t;
    }
    return null;
  }
  return null;
}

/** A multi-select cell as a list of trimmed strings: an array as given, a string split on , ; or newlines. */
function asList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(asText).filter((x): x is string => x !== null);
  const t = asText(v);
  if (t === null) return [];
  return t.split(/\s*[,;\n]\s*/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A number from a number or a numeric string ("12", "$12,500", "25K", "50+"). Null when empty; null when not numeric. */
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/^\$/, "").replace(/,/g, "").replace(/\+$/, "").trim();
  if (s.length === 0) return null;
  let mult = 1;
  const suffix = s.match(/^(-?\d+(?:\.\d+)?)\s*([kKmM])$/);
  if (suffix) {
    s = suffix[1];
    mult = suffix[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * mult;
  return Number.isFinite(n) ? n : null;
}

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v)) return parseMs((v as Record<string, unknown>).start);
  if (typeof v !== "string" && typeof v !== "number") return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function quoteNote(property: string, raw: unknown): string {
  return `Notion "${property}" = ${JSON.stringify(asText(raw) ?? raw)}`;
}

/* ------------------------------------------------------------------ *
 * Vocabularies: the rubric where it speaks, the §4b table where it does not
 * ------------------------------------------------------------------ */

type AliasTable = Record<string, string | null>;

const RELATIONSHIP_ALIASES: AliasTable = { "Agency partner": "agency", "Direct-to-client": "direct", Unknown: null };
const ECONOMICS_ALIASES: AliasTable = { Yes: "pass", No: "fail", Unknown: null };
const BROKER_ALIASES: AliasTable = { Pass: "pass", Flag: "flag", Unknown: null };
const SERVICE_SHAPE_FALLBACK: AliasTable = { Core: "Core", Adjacent: "Complement", Neither: "Off", Unknown: null };
const FACT_STATE_FALLBACK: AliasTable = { Yes: "present", No: "absent", Unknown: "unknown" };
const TIMING_FALLBACK: AliasTable = {
  "Super Hot": "within_1_week",
  Hot: "within_1_month",
  Warm: "within_3_months",
  Cold: "no_timeline",
};
const CEILING_FALLBACK: AliasTable = { "A job": "Project", "Seat at the table": "Embedded", Partnership: "Partner" };
const ICP_FALLBACK = ["ICP-1", "ICP-2", "ICP-3", "ICP-4", "ICP-5", "ICP-6"];
const WL_FALLBACK = ["Very High", "High", "Medium", "Low"];
const SPECIFICATION_NOTE_FALLBACK =
  "approximation: an immediate need is not a written scope; treated as inferred (DECISIONS §3.6); a rater's entry supersedes it";

/** Agency-type keyword map (§4b), most specific first. A text is scanned in this order; the first hit wins. */
const AGENCY_TYPE_KEYWORDS: Array<[RegExp, string]> = [
  [/full[\s\-]*service/i, "full_service"],
  [/consult|fractional/i, "consultancy"],
  [/niche|vertical/i, "niche_vertical"],
  [/boutique/i, "boutique"],
  [/digital/i, "digital_only"],
  [/direct|end[\s\-]*client/i, "direct_end_client"],
];

/**
 * §4b: referral_from_network = true when the referral source mentions any of these. The last
 * pattern is the referral word itself — referral / referred / referring — and deliberately
 * not the bare stem "refer": "Reference call with vendor" is not a referral.
 */
const REFERRAL_NETWORK_PATTERNS: RegExp[] = [
  /\bbrian\b/i,
  /\bami\b/i,
  /\bbaba\b/i,
  /\bagency\s*builders\b/i,
  /\bamin\b/i,
  /\breferr/i,
];

/** "#n of N", "#n/N", "rank n of N", "ranked #n of N". */
const RANK_RE = /(?:#|\brank(?:ed)?\s*#?)\s*(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b/i;

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

interface Vocab {
  relationship: AliasTable;
  serviceShape: AliasTable;
  money: AliasTable;
  authority: AliasTable;
  specification: AliasTable;
  specificationNote: string;
  timing: AliasTable;
  economics: AliasTable;
  broker: AliasTable;
  ceiling: AliasTable;
  icp: string[];
  wl: string[];
  catalog: Record<string, { weight?: unknown; lifespan_days?: unknown; decays?: unknown }>;
}

function rubricKeys(obj: unknown, drop: string[] = ["default", "basis", "note", "from"]): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>).filter((k) => !drop.includes(k));
}

/** Fallback aliases, overlaid with the rubric's where it has them; canonical words also map to themselves. */
function aliasTable(fromRubric: unknown, fallback: AliasTable, canonical: readonly string[]): AliasTable {
  const out: AliasTable = { ...fallback };
  if (fromRubric && typeof fromRubric === "object" && !Array.isArray(fromRubric)) {
    for (const [alias, target] of Object.entries(fromRubric as Record<string, unknown>)) {
      if (alias === "from" || alias === "note") continue;
      if (target === null) out[alias] = null;
      else if (typeof target === "string" && canonical.includes(target)) out[alias] = target;
    }
  }
  for (const c of canonical) if (!(c in out)) out[c] = c;
  return out;
}

function buildVocab(rubric: Rubric): Vocab {
  const r = (rubric ?? {}) as Record<string, any>;
  const icpFromRubric = Array.from(
    new Set([...rubricKeys(r.dimension_b?.icp?.definitions), ...rubricKeys(r.dimension_b?.base_tier_from_icp?.map)]),
  ).filter((k) => /^ICP-[1-6]$/.test(k));
  const icp = icpFromRubric.length > 0 ? icpFromRubric : ICP_FALLBACK;
  const wlFromRubric = rubricKeys(r.potential?.outsourceable_share_by_wl).filter((k) => WL_FALLBACK.includes(k));
  const wl = wlFromRubric.length > 0 ? wlFromRubric : WL_FALLBACK;
  const ceilings: string[] = Array.isArray(r.vocabulary?.ceilings) && r.vocabulary.ceilings.length > 0
    ? r.vocabulary.ceilings.map((c: unknown) => String(c))
    : ["Project", "Embedded", "Partner"];
  const timings = rubricKeys(r.signals?.urgency?.from_timing, []);
  const timingCanonical = timings.length > 0 ? timings : Object.values(TIMING_FALLBACK).filter((v): v is string => v !== null);
  const na = r.dimension_a?.notion_aliases ?? {};
  const specNote = typeof na.specification?.note === "string" && na.specification.note.trim().length > 0
    ? `approximation (${na.specification.note.trim()})`
    : SPECIFICATION_NOTE_FALLBACK;
  return {
    relationship: aliasTable(null, RELATIONSHIP_ALIASES, ["agency", "direct"]),
    serviceShape: aliasTable(r.gates?.items?.service_shape?.notion_aliases, SERVICE_SHAPE_FALLBACK, ["Core", "Complement", "Off"]),
    money: aliasTable(na.money, FACT_STATE_FALLBACK, ["present", "absent", "unknown"]),
    authority: aliasTable(na.authority, FACT_STATE_FALLBACK, ["present", "absent", "unknown"]),
    specification: aliasTable(na.specification, FACT_STATE_FALLBACK, ["present", "absent", "unknown"]),
    specificationNote: specNote,
    timing: aliasTable(na.timing, TIMING_FALLBACK, timingCanonical),
    economics: aliasTable(null, ECONOMICS_ALIASES, ["pass", "fail"]),
    broker: aliasTable(null, BROKER_ALIASES, ["pass", "flag"]),
    ceiling: aliasTable(r.vocabulary?.ceiling_aliases, CEILING_FALLBACK, ceilings),
    icp,
    wl,
    catalog: (r.signals?.catalog ?? {}) as Vocab["catalog"],
  };
}

/** Look a raw selection up in an alias table, fold-insensitively. `found` false = not a recognised option. */
function lookup(raw: string, table: AliasTable): { found: boolean; value: string | null } {
  const f = fold(raw);
  for (const [alias, target] of Object.entries(table)) if (fold(alias) === f) return { found: true, value: target };
  return { found: false, value: null };
}

/**
 * "ICP-3", "ICP 3", "icp-3", 3 → "ICP-3" when in the vocabulary. A labelled selection such as
 * "ICP-6: Direct End-Client" is matched on its prefix; the caller keeps the verbatim text in
 * the fact's note. "ICP-12" and "ICP-9" are not classes and return null.
 */
function canonicalIcp(raw: string, icp: readonly string[]): string | null {
  const m = raw.trim().match(/^(?:icp)?[\s_\-]*([1-6])(?![0-9])/i);
  if (!m) return null;
  const c = `ICP-${m[1]}`;
  return icp.includes(c) ? c : null;
}

function catalogEntry(
  catalog: Vocab["catalog"],
  type: string,
): { weight: number; lifespan_days: number | null; decays: boolean } | null {
  const cat = catalog[type];
  if (!cat || typeof cat !== "object") return null;
  const weight = asNumber(cat.weight);
  if (weight === null) return null;
  const lifespan = asNumber(cat.lifespan_days);
  return { weight, lifespan_days: lifespan, decays: typeof cat.decays === "boolean" ? cat.decays : true };
}

/* ------------------------------------------------------------------ *
 * Contacts
 * ------------------------------------------------------------------ */

interface ParsedContact {
  name: string | null;
  email: string | null;
  title: string | null;
}

/** "Jane Doe <jane@x.com>, COO" · "Jane Doe (COO) jane@x.com" · "jane@x.com" · "Jane Doe - Head of Ops" */
export function parseContactEntry(entry: string): ParsedContact | null {
  let s = String(entry ?? "").trim();
  if (s.length === 0) return null;
  let email: string | null = null;
  const m = s.match(EMAIL_RE);
  if (m) {
    email = m[0].toLowerCase();
    s = s.replace(m[0], " ");
  }
  let title: string | null = null;
  const paren = s.match(/\(([^)]*)\)/);
  if (paren) {
    title = paren[1].trim().length > 0 ? paren[1].trim() : null;
    s = s.replace(paren[0], " ");
  }
  s = s.replace(/[<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, "");
  let name: string | null = null;
  if (s.length > 0) {
    const parts = s.split(/\s*(?:,|;|:|\s[-–—]\s)\s*/).map((p) => p.trim()).filter((p) => p.length > 0);
    name = parts[0] ?? null;
    if (title === null && parts.length > 1) title = parts.slice(1).join(", ");
  }
  if (name === null && email === null) return null;
  return { name, email, title };
}

function parseAdditionalContacts(v: unknown): ParsedContact[] {
  if (v === null || v === undefined) return [];
  const out: ParsedContact[] = [];
  const push = (c: ParsedContact | null) => {
    if (c) out.push(c);
  };
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const email = asText(o.email);
        push({
          name: asText(o.name),
          email: email !== null && EMAIL_RE.test(email) ? (email.match(EMAIL_RE) as RegExpMatchArray)[0].toLowerCase() : null,
          title: asText(o.title) ?? asText(o.role),
        });
      } else {
        const t = asText(item);
        if (t !== null) push(parseContactEntry(t));
      }
    }
    return out.filter((c) => c.name !== null || c.email !== null);
  }
  const t = asText(v);
  if (t === null) return [];
  for (const entry of t.split(/\r?\n|;/)) push(parseContactEntry(entry));
  return out;
}

/* ------------------------------------------------------------------ *
 * mapNotionProspect
 * ------------------------------------------------------------------ */

export function mapNotionProspect(row: NotionProspectRow, opts: NotionSeedOptions): NotionSeedResult {
  const notes: string[] = [];
  const entered_by = opts.entered_by && opts.entered_by.trim().length > 0 ? opts.entered_by.trim() : DEFAULT_ENTERED_BY;
  const V = buildVocab(opts.rubric);
  const empty = (skip: NotionSeedResult["skip"], account: SeedAccount | null): NotionSeedResult => ({
    skip,
    account,
    facts: [],
    signals: [],
    contacts: [],
    notes,
  });

  /* ---- identity ---- */
  const name = asText(getProp(row, PROPERTY.client_name));
  if (name === null) return empty({ reason: `"${PROPERTY.client_name}" is empty` }, null);
  const key = norm(name);
  if (key.length === 0) return empty({ reason: `"${PROPERTY.client_name}" ${JSON.stringify(name)} normalises to an empty key` }, null);

  const clientIdRaw = getProp(row, PROPERTY.client_id);
  const notion_client_id = asText(clientIdRaw);
  const pageIdRaw = getFirstProp(row, OPTIONAL_PROPERTY.page_id);
  const notion_page_id = asText(pageIdRaw);

  const relRaw = asText(getProp(row, PROPERTY.relationship_type));
  let relationship_type: RelationshipType | null = null;
  let relFound = false;
  if (relRaw !== null) {
    const r = lookup(relRaw, V.relationship);
    relFound = r.found;
    relationship_type = r.found && (r.value === "agency" || r.value === "direct") ? r.value : null;
  }

  /* ---- contacts (also the domain fallback) ---- */
  const contacts: SeedContact[] = [];
  {
    const cName = asText(getProp(row, PROPERTY.contact_name));
    const cTitle = asText(getProp(row, PROPERTY.contact_title));
    const cEmailRaw = asText(getProp(row, PROPERTY.contact_email));
    let cEmail: string | null = null;
    if (cEmailRaw !== null) {
      const m = cEmailRaw.match(EMAIL_RE);
      if (m) cEmail = m[0].toLowerCase();
      else notes.push(`${quoteNote(PROPERTY.contact_email, cEmailRaw)} is not an email address; dropped`);
    }
    if (cName !== null || cEmail !== null) {
      contacts.push({ account_key: key, name: cName, email: cEmail, title: cTitle, source: NOTION_SOURCE });
    } else if (cTitle !== null) {
      notes.push(`${quoteNote(PROPERTY.contact_title, cTitle)} without a name or email; dropped`);
    }
    for (const c of parseAdditionalContacts(getProp(row, PROPERTY.additional_contacts))) {
      contacts.push({ account_key: key, name: c.name, email: c.email, title: c.title, source: NOTION_SOURCE });
    }
  }

  let domain: string | null = null;
  const websiteRaw = asText(getFirstProp(row, OPTIONAL_PROPERTY.website));
  if (websiteRaw !== null) {
    domain = normalizeDomain(websiteRaw);
    if (domain === null) notes.push(`website ${JSON.stringify(websiteRaw)} does not normalise to an organisation domain`);
  }
  if (domain === null) {
    for (const c of contacts) {
      const d = domainFromEmail(c.email);
      if (d !== null) {
        domain = d;
        break;
      }
    }
  }

  const account: SeedAccount = {
    key,
    name,
    domain,
    notion_client_id,
    notion_page_id,
    roster_source: NOTION_SOURCE,
    roster_certified: false,
    relationship_type,
    book: "prospect",
  };

  /* ---- skip rules ---- */
  const recordType = asText(getProp(row, PROPERTY.record_type));
  if (recordType !== null && fold(recordType) !== "prospect") {
    return empty({ reason: `"${PROPERTY.record_type}" is ${JSON.stringify(recordType)}, not Prospect` }, account);
  }
  const businessStatus = asText(getProp(row, PROPERTY.business_status));
  const t12m = asNumber(getProp(row, PROPERTY.t12m_billings));
  if ((businessStatus !== null && fold(businessStatus) === "client") || (t12m !== null && t12m > 0)) {
    return empty({ reason: STALE_PROSPECT_REASON }, account);
  }

  /* ---- observed_at: the row's last-edited date, else the caller's as_of, else none ---- */
  let observedMs = parseMs(getProp(row, PROPERTY.last_edited));
  if (observedMs === null) observedMs = parseMs(getFirstProp(row, OPTIONAL_PROPERTY.last_edited_alt));
  if (observedMs === null) {
    const fallback = parseMs(opts.as_of);
    if (fallback !== null) {
      observedMs = fallback;
      notes.push(`"${PROPERTY.last_edited}" missing or unparseable; observed_at taken from as_of`);
    } else {
      notes.push(`"${PROPERTY.last_edited}" missing or unparseable and no as_of given; facts carry observed_at null, signals are dropped`);
    }
  }
  const observedDate = observedMs === null ? null : isoDate(observedMs);
  const observedTs = observedMs === null ? null : new Date(observedMs).toISOString();

  /* ---- facts ---- */
  const facts: SeedFact[] = [];
  const addFact = (factKey: string, value: unknown, note: string, label?: SeedFact["evidence_label"]) => {
    const evidence_label: SeedFact["evidence_label"] = label ?? (value === null || value === "unknown" ? "unknown" : "inferred");
    facts.push({ account_key: key, key: factKey, value, evidence_label, source: NOTION_SOURCE, observed_at: observedDate, entered_by, note });
  };

  /** A select property → one fact through an alias table. Unrecognised options become a recorded unknown with the text in the note. */
  const selectFact = (property: string, factKey: string, table: AliasTable, extraNote?: string) => {
    const raw = asText(getProp(row, property));
    if (raw === null) return;
    const r = lookup(raw, table);
    const base = quoteNote(property, raw);
    if (!r.found) {
      notes.push(`${base} is not a recognised option for ${factKey}; recorded as unknown`);
      addFact(factKey, null, `${base} — not a recognised option; recorded as unknown`);
      return;
    }
    addFact(factKey, r.value, extraNote ? `${base} — ${extraNote}` : base);
  };

  if (relRaw !== null) {
    const base = quoteNote(PROPERTY.relationship_type, relRaw);
    if (!relFound) {
      notes.push(`${base} is not a recognised option for relationship_type; recorded as unknown`);
      addFact("relationship_type", null, `${base} — not a recognised option; recorded as unknown`);
    } else {
      addFact("relationship_type", relationship_type, base);
    }
  }

  {
    const raw = asText(getProp(row, PROPERTY.icp_class));
    if (raw !== null) {
      const c = canonicalIcp(raw, V.icp);
      const base = quoteNote(PROPERTY.icp_class, raw);
      if (c === null) {
        notes.push(`${base} is not an ICP class; recorded as unknown`);
        addFact("icp_class", null, `${base} — not an ICP class; recorded as unknown`);
      } else {
        addFact("icp_class", c, base);
      }
    }
  }

  {
    const raw = asText(getProp(row, PROPERTY.agency_type));
    if (raw !== null) {
      const base = quoteNote(PROPERTY.agency_type, raw);
      let mapped: string | null = null;
      for (const [re, target] of AGENCY_TYPE_KEYWORDS) {
        if (re.test(raw)) {
          mapped = target;
          break;
        }
      }
      if (mapped === null) {
        notes.push(`${base} matches no agency-type keyword; kept as note`);
        addFact("agency_type", null, `${base} — no keyword match; kept as note`);
      } else {
        addFact("agency_type", mapped, `${base} — keyword map`);
      }
    }
  }

  {
    const rawV = getProp(row, PROPERTY.headcount);
    const raw = asText(rawV);
    if (raw !== null) {
      const n = asNumber(rawV);
      const base = quoteNote(PROPERTY.headcount, raw);
      if (n === null || !Number.isInteger(n) || n < 0) {
        notes.push(`${base} is not a whole number (a range or a band is not parsed); recorded as unknown`);
        addFact("headcount", null, `${base} — not a whole number; recorded as unknown`);
      } else {
        addFact("headcount", n, base);
      }
    }
  }

  {
    const raw = asText(getProp(row, PROPERTY.wl_signal));
    if (raw !== null) {
      const base = quoteNote(PROPERTY.wl_signal, raw);
      const hit = V.wl.find((w) => fold(w) === fold(raw)) ?? null;
      if (hit === null) {
        notes.push(`${base} is not a WL level; recorded as unknown`);
        addFact("wl_signal", null, `${base} — not a WL level; recorded as unknown`);
      } else {
        addFact("wl_signal", hit, base);
      }
    }
  }

  selectFact(PROPERTY.gate_needs, "service_shape", V.serviceShape);
  selectFact(PROPERTY.gate_afford, "money", V.money);
  selectFact(PROPERTY.gate_afford, "economics", V.economics);
  selectFact(PROPERTY.gate_decent, "broker_character", V.broker);
  selectFact(PROPERTY.decision_maker, "authority", V.authority);
  selectFact(PROPERTY.lead_priority, "timing", V.timing);
  selectFact(PROPERTY.active_project, "specification", V.specification, V.specificationNote);
  selectFact(PROPERTY.ceiling, "stated_ceiling", V.ceiling);

  {
    const list = asList(getProp(row, PROPERTY.proof_of_growth));
    if (list.length > 0) addFact("climb_signals", list, quoteNote(PROPERTY.proof_of_growth, list));
  }

  {
    const raw = asText(getProp(row, PROPERTY.referral_source));
    if (raw !== null) {
      const base = quoteNote(PROPERTY.referral_source, raw);
      const hit = REFERRAL_NETWORK_PATTERNS.some((re) => re.test(raw));
      if (hit) addFact("referral_from_network", true, `${base} — mentions the Brian / AMI / BABA / Agency Builders / AMIN network or a referral`);
      else addFact("referral_from_network", null, `${base} — no network keyword; kept as note only`);
    }
  }

  {
    const raw = asText(getProp(row, PROPERTY.headroom_rank));
    if (raw !== null) {
      const base = quoteNote(PROPERTY.headroom_rank, raw);
      const m = raw.match(RANK_RE);
      const n = m ? Number(m[1]) : NaN;
      const N = m ? Number(m[2]) : NaN;
      if (m && Number.isInteger(n) && Number.isInteger(N) && N >= 1 && n >= 1 && n <= N) {
        addFact("our_rank", n, `${base} — parsed "#${n} of ${N}"`);
        addFact("n_vendors", N, `${base} — parsed "#${n} of ${N}"`);
      } else {
        if (m) notes.push(`${base} has a rank outside 1..N; kept as note`);
        else notes.push(`${base} carries no "#n of N"; kept as note`);
        addFact("notion_headroom_vendor_rank", raw, `${base} — no "#n of N" parsed; informational`);
      }
    }
  }

  {
    const raw = asText(getProp(row, PROPERTY.status));
    if (raw !== null) addFact("notion_status", raw, `${quoteNote(PROPERTY.status, raw)} — informational`);
  }
  {
    const raw = asText(getProp(row, PROPERTY.current_am));
    if (raw !== null) addFact("notion_current_am", raw, `${quoteNote(PROPERTY.current_am, raw)} — owner_email left null`);
  }

  /* ---- signals ---- */
  const signals: SeedSignal[] = [];
  const addSignal = (type: string, payload: Record<string, unknown>, what: string) => {
    const cat = catalogEntry(V.catalog, type);
    if (cat === null) {
      notes.push(`${what}: no rubric.signals.catalog entry for "${type}"; signal dropped`);
      return;
    }
    if (observedTs === null) {
      notes.push(`${what}: no observed_at; signal dropped`);
      return;
    }
    signals.push({
      account_key: key,
      type,
      observed_at: observedTs,
      payload,
      source: NOTION_SOURCE,
      weight: cat.weight,
      lifespan_days: cat.lifespan_days,
      decays: cat.decays,
      entered_by,
    });
  };

  for (const property of [PROPERTY.grade_effective, PROPERTY.grade_sql, PROPERTY.grade_adjustment, PROPERTY.override_reason]) {
    const raw = asText(getProp(row, property));
    if (raw !== null) addSignal("prior_grade", { field: property, value: raw, source: NOTION_SOURCE }, quoteNote(property, raw));
  }
  {
    const rawV = getProp(row, PROPERTY.est_year1);
    const raw = asText(rawV);
    if (raw !== null) {
      const n = asNumber(rawV);
      addSignal(
        "prior_grade",
        { field: PROPERTY.est_year1, value: n !== null && typeof rawV === "number" ? n : raw, source: NOTION_SOURCE, note: "a band someone selected, not a quote (§14.5 C2)" },
        quoteNote(PROPERTY.est_year1, raw),
      );
    }
  }
  {
    const raw = asText(getProp(row, PROPERTY.trigger_event));
    if (raw !== null) addSignal("manual_note", { text: raw, field: PROPERTY.trigger_event, source: NOTION_SOURCE }, quoteNote(PROPERTY.trigger_event, raw));
  }

  return { skip: null, account, facts, signals, contacts, notes };
}

/* ------------------------------------------------------------------ *
 * mapNotionProspects
 * ------------------------------------------------------------------ */

export function mapNotionProspects(rows: NotionProspectRow[], opts: NotionSeedOptions): NotionSeedBatchResult {
  const out: NotionSeedBatchResult = { accounts: [], facts: [], signals: [], contacts: [], skipped: [], notes: [] };
  const seen = new Map<string, string>();
  rows.forEach((row, i) => {
    const r = mapNotionProspect(row, opts);
    const label = r.account?.name ?? asText(getProp(row, PROPERTY.client_name)) ?? `row ${i + 1}`;
    for (const n of r.notes) out.notes.push(`${label}: ${n}`);
    if (r.skip !== null || r.account === null) {
      out.skipped.push({ name: label, reason: r.skip?.reason ?? `"${PROPERTY.client_name}" is empty` });
      return;
    }
    const prior = seen.get(r.account.key);
    if (prior !== undefined) {
      out.skipped.push({ name: label, reason: `duplicate key ${JSON.stringify(r.account.key)} — already seeded from ${JSON.stringify(prior)}; a person must decide (never auto-merged)` });
      return;
    }
    seen.set(r.account.key, r.account.name);
    out.accounts.push(r.account);
    out.facts.push(...r.facts);
    out.signals.push(...r.signals);
    out.contacts.push(...r.contacts);
  });
  return out;
}
