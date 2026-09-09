/**
 * WLIQ Prospect Book — Pipedrive webhooks v2 parser (DESIGN.md §4d).
 *
 * PURE. No clock (`now` is an input), no network, no filesystem, no dependencies. Runs under
 * Deno and under `node --experimental-strip-types`. The HTTP handler
 * (`supabase/functions/pb-pipedrive-webhook`) verifies HTTP Basic, stores the delivery in
 * `pb_webhook_inbox`, then calls `parsePipedriveEvent` and writes what comes back.
 *
 * One event in, at most one of {deal, account, contact, signal} out, plus identity candidates
 * and a reason when nothing applies:
 *
 *   deal          entity `deal`         → a pb_deals upsert row (all actions; delete → status deleted)
 *   account       entity `organization` → a pb_accounts attach / create / review proposal
 *   contact       entity `person`       → a pb_contacts row (account via org_id, else email domain)
 *   signal        entity `activity`     → pb_signals `meeting_accepted` for a meeting or call that
 *                                         is done or still ahead; entity `note` → `manual_note`,
 *                                         only on a deal or organization the book already knows
 *
 * Custom fields: Pipedrive keys them by a 40-hex hash. The map hash → {label, options} is
 * loaded at runtime from /v2/dealFields, /v1/organizationFields and /v1/personFields and
 * PASSED IN. No hash is hard-coded here, ever. Translated values land in
 * `raw.custom_fields_labelled`; the Grade field (label matching /grade/i) is surfaced as
 * `raw.grade_label`.
 *
 * Identity: `proposeMatches` from identity.ts. Only a HIGH match (pipedrive_org_id, domain)
 * attaches; anything below is a `pb_identity_candidates` row for a person (PRO-18's
 * discipline). A Pipedrive organization whose name merely resembles a seeded row is a
 * REVIEW, not a new account — creating it would collide on pb_accounts.key or breed a
 * duplicate that only a register entry may merge.
 *
 * Unknown is never evidence: an absent field is null, never a default that fires anything.
 *
 * Fields on the output that are NOT table columns (the handler consumes them, never inserts
 * them): `deal.close_date_push` (appended to pb_deals.close_date_pushes), `account.mode`,
 * `contact.pipedrive_org_id`, `signal.activity_id` lives in payload.
 */

import type { Rubric } from "../core/prospect_types.ts";
import type { KnownAccount, MatchCandidate } from "./identity.ts";
import { domainFromEmail, norm, normalizeDomain, proposeMatches } from "./identity.ts";

/* ------------------------------------------------------------------ *
 * Input types
 * ------------------------------------------------------------------ */

export type PipedriveAction = "create" | "change" | "delete";

export interface PipedriveV2Meta {
  action: PipedriveAction | string;
  /** deal | organization | person | activity | note | lead | product | … */
  entity: "deal" | "organization" | "person" | "activity" | "note" | string;
  entity_id: string | number;
  company_id?: string | number;
  user_id?: string | number | null;
  /** ISO timestamp of the change. Unix seconds / milliseconds are tolerated. */
  timestamp?: string | number | null;
  version?: string;
  webhook_id?: string | number;
  is_bulk_edit?: boolean;
  change_source?: string;
  attempt?: number;
  [key: string]: unknown;
}

export interface PipedriveV2Event {
  meta: PipedriveV2Meta;
  // deno-lint-ignore no-explicit-any
  data: any;
  // deno-lint-ignore no-explicit-any
  previous?: any;
}

export interface FieldDef {
  label: string;
  /** option id → option label, for enum / set fields */
  options?: Record<string, string>;
  field_type?: string;
}

/** hash key → definition, per entity. Built at runtime from the *Fields endpoints and passed in. */
export interface FieldMap {
  deals?: Record<string, FieldDef>;
  organizations?: Record<string, FieldDef>;
  persons?: Record<string, FieldDef>;
  activities?: Record<string, FieldDef>;
}

export interface ParseOptions {
  /**
   * pipedrive_deal_id → pb_accounts.id, for deals the book already holds. Lets an activity or
   * note that names only a deal find its account. Optional; without it only org_id resolves.
   */
  deal_accounts?: Record<string, string>;
  /**
   * The active rubric. When given, a signal's weight, lifespan_days, decays and expires_at
   * are filled from rubric.signals.catalog[type]; otherwise they are null and the handler
   * fills them before insert (pb_signals.weight is NOT NULL). Never hard-coded here.
   */
  rubric?: Rubric;
}

/* ------------------------------------------------------------------ *
 * Output types
 * ------------------------------------------------------------------ */

export interface CloseDatePush {
  from: string | null;
  to: string | null;
  at: string;
}

/** A pb_deals upsert row. `close_date_push` is not a column: the handler appends it. */
export interface DealUpsert {
  pipedrive_deal_id: number;
  account_id: string | null;
  title: string | null;
  pipeline_id: number | null;
  stage_id: number | null;
  /**
   * When the stage changed in this event: meta.timestamp. Otherwise Pipedrive's own
   * stage_change_time when the payload carries it, else null = "unchanged, do not overwrite".
   */
  stage_entered_at: string | null;
  value: number | null;
  currency: string | null;
  close_date: string | null;
  close_date_push: CloseDatePush | null;
  status: string | null;
  won_time: string | null;
  lost_time: string | null;
  owner_user_id: number | null;
  is_cj: boolean;
  raw: Record<string, unknown>;
}

export type AccountMode = "attach" | "create" | "review";

/**
 * A pb_accounts proposal from an organization event.
 *   attach — `id` is an existing row matched HIGH; set pipedrive_org_id, roster_source and
 *            roster_certified on it; fill name/domain (never change `key`).
 *   create — no existing row resembles it; insert.
 *   review — a medium/low resemblance exists; write the candidates, insert nothing.
 */
export interface AccountUpsert {
  mode: AccountMode;
  id: string | null;
  pipedrive_org_id: number;
  name: string;
  key: string;
  domain: string | null;
  roster_source: "pipedrive";
  roster_certified: true;
}

/** A pb_contacts row. `pipedrive_org_id` is not a column; kept so a later attach can find it. */
export interface ContactUpsert {
  account_id: string | null;
  name: string | null;
  email: string | null;
  title: string | null;
  pipedrive_person_id: number;
  pipedrive_org_id: number | null;
  source: "pipedrive";
}

/** A pb_signals row. weight/lifespan/decays/expires_at are filled only when a rubric is passed. */
export interface SignalInsert {
  account_id: string;
  contact_id: null;
  source: "pipedrive";
  type: "meeting_accepted" | "manual_note";
  observed_at: string;
  payload: Record<string, unknown>;
  evidence_url: null;
  weight: number | null;
  lifespan_days: number | null;
  decays: boolean | null;
  entered_by: "system:pipedrive";
  expires_at: string | null;
}

/** A pb_identity_candidates row. */
export interface IdentityCandidateRow {
  account_id: string | null;
  source: "pipedrive";
  source_id: string | null;
  source_name: string | null;
  source_domain: string | null;
  matched_on: string;
  confidence: "high" | "medium" | "low" | null;
  note: string | null;
}

export interface ParsedPipedriveEvent {
  deal?: DealUpsert;
  account?: AccountUpsert;
  contact?: ContactUpsert;
  signal?: SignalInsert;
  candidates: IdentityCandidateRow[];
  /** Set when the event produces no row. Never set for a CJ deal (it upserts, flagged is_cj). */
  ignored?: string;
  /** Plain-words observations for pb_runs; never a flag. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Coercion helpers — null for absent or unusable, never a guess
 * ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function rec(v: unknown): Rec {
  return isRec(v) ? v : {};
}

/** An integer id. Pipedrive v1 wrapped related ids as {value, name}; v2 sends plain numbers. */
function toId(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (isRec(v)) return toId(v.value ?? v.id);
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "");
    if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length === 0 ? null : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

/**
 * Any Pipedrive timestamp → ISO 8601 UTC, or null. Accepts ISO strings, the v1 form
 * "YYYY-MM-DD HH:MM:SS" (UTC), a bare "YYYY-MM-DD", and unix seconds or milliseconds.
 */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s === "0000-00-00 00:00:00" || s === "0000-00-00") return null;
  if (/^\d{9,13}$/.test(s)) return toIso(Number(s));
  let candidate = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) candidate = s.replace(" ", "T") + "Z";
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) candidate = s + "T00:00:00Z";
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** A calendar date "YYYY-MM-DD", or null. A datetime is reduced to its UTC date. */
function toDate(v: unknown): string | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    const s = v.trim();
    return s === "0000-00-00" ? null : s;
  }
  const iso = toIso(v);
  return iso === null ? null : iso.slice(0, 10);
}

/** Pipedrive's due_date "YYYY-MM-DD" + due_time "HH:MM" (may be empty) → ISO, or null. */
function dueIso(date: unknown, time: unknown): string | null {
  const d = toStr(date);
  if (d === null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = toStr(time);
  const hm = t !== null && /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? t : "00:00";
  return toIso(`${d} ${hm}`);
}

/** Pipedrive note content is HTML. Reduce to readable plain text. */
export function stripHtml(html: unknown): string | null {
  const s = toStr(html);
  if (s === null) return null;
  const text = s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length === 0 ? null : text;
}

/* ------------------------------------------------------------------ *
 * Meta normalisation (v2 words; v1 words tolerated)
 * ------------------------------------------------------------------ */

const ACTION_ALIASES: Record<string, PipedriveAction> = {
  create: "create",
  added: "create",
  change: "change",
  updated: "change",
  merged: "change",
  delete: "delete",
  deleted: "delete",
};

function normalizeAction(v: unknown): PipedriveAction | null {
  const s = toStr(v)?.toLowerCase();
  return s !== undefined && s in ACTION_ALIASES ? ACTION_ALIASES[s] : null;
}

/** v2 `entity`; v1 called it `object`. An empty entity falls through to object. */
function normalizeEntity(meta: Rec): string | null {
  const s = toStr(meta.entity) ?? toStr(meta.object);
  return s === null ? null : s.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Custom fields
 * ------------------------------------------------------------------ */

const HASH_KEY = /^[0-9a-f]{40}$/;

/** The hash → raw value pairs of a payload: v2 nests them under custom_fields; v1 spread them at top level. */
function customFieldPairs(data: Rec): Rec {
  const out: Rec = {};
  if (isRec(data.custom_fields)) for (const [k, v] of Object.entries(data.custom_fields)) out[k] = v;
  for (const [k, v] of Object.entries(data)) if (HASH_KEY.test(k)) out[k] = v;
  return out;
}

function optionLabel(def: FieldDef, id: unknown): unknown {
  const key = toStr(isRec(id) ? id.id ?? id.value : id);
  if (key === null) return null;
  return def.options && key in def.options ? def.options[key] : key;
}

/** One custom field value through its definition: option ids → labels, {value,…} kept as is. */
function translateValue(def: FieldDef | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (def?.options) {
    if (Array.isArray(v)) return v.map((x) => optionLabel(def, x));
    if (typeof v === "string" && v.includes(",")) return v.split(",").map((x) => optionLabel(def, x.trim()));
    return optionLabel(def, v);
  }
  if (isRec(v) && "value" in v && Object.keys(v).length === 1) return v.value;
  return v;
}

export interface LabelledCustomFields {
  labelled: Record<string, unknown>;
  grade_label: string | null;
}

/** Translate every custom field of a payload through the field map. Unknown hashes keep their hash as the key. */
export function labelCustomFields(data: Rec, defs: Record<string, FieldDef> | undefined): LabelledCustomFields {
  const labelled: Record<string, unknown> = {};
  let grade: string | null = null;
  let gradeExact = false;
  const map = defs ?? {};
  for (const [hash, raw] of Object.entries(customFieldPairs(data))) {
    const def = map[hash];
    const label = def?.label && def.label.trim().length > 0 ? def.label.trim() : hash;
    const value = translateValue(def, raw);
    labelled[label] = value;
    if (def && /grade/i.test(label) && value !== null && value !== undefined) {
      const asText = Array.isArray(value) ? value.map((x) => String(x)).join(", ") : typeof value === "object" ? null : String(value);
      const exact = /^grade$/i.test(label);
      if (asText !== null && (grade === null || (exact && !gradeExact))) {
        grade = asText;
        gradeExact = exact;
      }
    }
  }
  return { labelled, grade_label: grade };
}

/* ------------------------------------------------------------------ *
 * Rubric catalog lookup (weights are data, never constants)
 * ------------------------------------------------------------------ */

interface CatalogEntry {
  weight: number | null;
  lifespan_days: number | null;
  decays: boolean | null;
}

function catalogEntry(rubric: Rubric | undefined, type: string): CatalogEntry {
  const cat = rec(rec(rec(rubric).signals).catalog)[type];
  if (!isRec(cat)) return { weight: null, lifespan_days: null, decays: null };
  return {
    weight: toNum(cat.weight),
    lifespan_days: toNum(cat.lifespan_days),
    decays: typeof cat.decays === "boolean" ? cat.decays : null,
  };
}

function addDays(iso: string, days: number): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + days * 86_400_000).toISOString();
}

function makeSignal(
  accountId: string,
  type: SignalInsert["type"],
  observedAt: string,
  payload: Record<string, unknown>,
  rubric: Rubric | undefined,
): SignalInsert {
  const cat = catalogEntry(rubric, type);
  return {
    account_id: accountId,
    contact_id: null,
    source: "pipedrive",
    type,
    observed_at: observedAt,
    payload,
    evidence_url: null,
    weight: cat.weight,
    lifespan_days: cat.lifespan_days,
    decays: cat.decays,
    entered_by: "system:pipedrive",
    expires_at: cat.lifespan_days !== null && cat.lifespan_days > 0 ? addDays(observedAt, cat.lifespan_days) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Identity helpers
 * ------------------------------------------------------------------ */

function candidateRow(
  m: MatchCandidate,
  sourceId: string | null,
  sourceName: string | null,
  sourceDomain: string | null,
  note: string | null,
): IdentityCandidateRow {
  return {
    account_id: m.account_id,
    source: "pipedrive",
    source_id: sourceId,
    source_name: sourceName,
    source_domain: sourceDomain,
    matched_on: m.matched_on,
    confidence: m.confidence,
    note,
  };
}

function unmatchedRow(sourceId: string | null, sourceName: string | null, sourceDomain: string | null, note: string): IdentityCandidateRow {
  return {
    account_id: null,
    source: "pipedrive",
    source_id: sourceId,
    source_name: sourceName,
    source_domain: sourceDomain,
    matched_on: "none",
    confidence: null,
    note,
  };
}

/** The account for a Pipedrive org id: attach on HIGH, else null. Never a guess. */
function accountForOrg(orgId: number | null, known: KnownAccount[]): KnownAccount | null {
  if (orgId === null) return null;
  return proposeMatches({ source: "pipedrive", source_id: orgId, pipedrive_org_id: orgId }, known).attach;
}

/* ------------------------------------------------------------------ *
 * Deals
 * ------------------------------------------------------------------ */

/** Client Journey cards: a title that starts with the token "CJ" (any case), not a word that merely begins with those letters. */
export function isClientJourneyTitle(title: string | null): boolean {
  if (title === null) return false;
  return /^\s*cj(?![a-z0-9])/i.test(title);
}

function changedKeys(data: Rec, previous: Rec | null): string[] {
  if (previous === null) return [];
  const keys = new Set([...Object.keys(data), ...Object.keys(previous)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(data[k] ?? null) !== JSON.stringify(previous[k] ?? null)) out.push(k);
  }
  return out.sort();
}

function parseDeal(
  action: PipedriveAction,
  meta: Rec,
  data: Rec,
  previous: Rec | null,
  fieldMap: FieldMap,
  known: KnownAccount[],
  now: string,
  out: ParsedPipedriveEvent,
): void {
  const dealId = toId(data.id) ?? toId(meta.entity_id);
  if (dealId === null) {
    out.ignored = "deal event without a deal id";
    return;
  }
  const at = toIso(meta.timestamp) ?? now;
  const title = toStr(data.title);
  const orgId = toId(data.org_id);
  const stageId = toId(data.stage_id);
  // v2 may send only the changed fields in `previous`: a stage change is asserted only when
  // the event is a create, or `previous` carries a stage_id that differs. A change event
  // without `previous` asserts nothing (unknown is never evidence) and falls back to
  // Pipedrive's own stage_change_time.
  const stageChanged = action === "create" ||
    (previous !== null && "stage_id" in previous && toId(previous.stage_id) !== stageId);

  const closeDate = toDate(data.expected_close_date ?? data.close_date);
  let push: CloseDatePush | null = null;
  if (previous !== null && ("expected_close_date" in previous || "close_date" in previous)) {
    const prevClose = toDate(previous.expected_close_date ?? previous.close_date);
    if (prevClose !== null && prevClose !== closeDate) push = { from: prevClose, to: closeDate, at };
  }

  let status = toStr(data.status)?.toLowerCase() ?? null;
  if (action === "delete") status = "deleted";

  const attached = accountForOrg(orgId, known);
  if (orgId !== null && attached === null) {
    out.candidates.push(unmatchedRow(String(orgId), toStr(rec(data.org_id).name) ?? toStr(data.org_name), null,
      `deal ${dealId} references Pipedrive organization ${orgId}, which is not in the book`));
    out.notes.push(`deal ${dealId}: organization ${orgId} not in the book; identity candidate queued`);
  }
  if (orgId === null) out.notes.push(`deal ${dealId}: no organization on the deal`);

  const { labelled, grade_label } = labelCustomFields(data, fieldMap.deals);
  const changed = changedKeys(data, previous);
  const raw: Record<string, unknown> = {
    ...data,
    custom_fields_labelled: labelled,
    grade_label,
    webhook_meta: {
      action,
      entity: "deal",
      timestamp: at,
      webhook_id: toStr(meta.webhook_id),
      change_source: toStr(meta.change_source),
      is_bulk_edit: toBool(meta.is_bulk_edit),
      user_id: toId(meta.user_id),
    },
    changed_keys: changed,
  };
  if (previous !== null && changed.length > 0) {
    const prev: Rec = {};
    for (const k of changed) prev[k] = previous[k] ?? null;
    raw.previous = prev;
  }

  const isCj = isClientJourneyTitle(title);
  if (isCj) out.notes.push(`deal ${dealId}: Client Journey card (is_cj); upserted and excluded from prospect counts`);

  out.deal = {
    pipedrive_deal_id: dealId,
    account_id: attached?.id ?? null,
    title,
    pipeline_id: toId(data.pipeline_id),
    stage_id: stageId,
    stage_entered_at: stageChanged ? at : toIso(data.stage_change_time),
    value: toNum(isRec(data.value) ? data.value.value : data.value),
    currency: toStr(data.currency),
    close_date: closeDate,
    close_date_push: push,
    status,
    won_time: toIso(data.won_time),
    lost_time: toIso(data.lost_time),
    owner_user_id: toId(data.owner_id ?? data.user_id),
    is_cj: isCj,
    raw,
  };
}

/* ------------------------------------------------------------------ *
 * Organizations
 * ------------------------------------------------------------------ */

const WEBSITE_LABEL = /web\s*site|domain|\burl\b|homepage/i;

/** The organisation's domain from any field that could carry one: website-like keys, a custom field labelled website, the address. */
function orgDomain(data: Rec, labelled: Record<string, unknown>): string | null {
  const tries: unknown[] = [data.website, data.web, data.url, data.domain, data.homepage];
  for (const [label, value] of Object.entries(labelled)) if (WEBSITE_LABEL.test(label)) tries.push(value);
  const address = data.address;
  tries.push(isRec(address) ? address.value : address);
  for (const t of tries) {
    const s = toStr(isRec(t) ? t.value : t);
    if (s === null) continue;
    const d = normalizeDomain(s);
    if (d !== null) return d;
  }
  return null;
}

function parseOrganization(
  action: PipedriveAction,
  meta: Rec,
  data: Rec,
  fieldMap: FieldMap,
  known: KnownAccount[],
  out: ParsedPipedriveEvent,
): void {
  const orgId = toId(data.id) ?? toId(meta.entity_id);
  if (orgId === null) {
    out.ignored = "organization event without an organization id";
    return;
  }
  if (action === "delete") {
    out.ignored = `organization ${orgId} deleted in Pipedrive; pb_accounts rows are never deleted by a webhook`;
    return;
  }
  const name = toStr(data.name);
  if (name === null) {
    out.ignored = `organization ${orgId} has no name`;
    return;
  }
  const { labelled } = labelCustomFields(data, fieldMap.organizations);
  const domain = orgDomain(data, labelled);
  const proposal = proposeMatches({ source: "pipedrive", source_id: orgId, name, domain, pipedrive_org_id: orgId }, known);

  const sourceId = String(orgId);
  if (proposal.attach) {
    const a = proposal.attach;
    const via = proposal.candidates.find((c) => c.account_id === a.id)?.matched_on ?? "high";
    out.notes.push(`organization ${orgId} "${name}" attached to account ${a.id} on ${via}`);
    for (const c of proposal.candidates) {
      if (c.account_id === a.id) continue;
      out.candidates.push(candidateRow(c, sourceId, name, domain, `also matched while ${a.id} was attached on ${via}`));
    }
    out.account = {
      mode: "attach",
      id: a.id,
      pipedrive_org_id: orgId,
      name,
      key: a.key && a.key.length > 0 ? a.key : norm(a.name),
      domain: domain ?? (normalizeDomain(a.domain) ?? null),
      roster_source: "pipedrive",
      roster_certified: true,
    };
    return;
  }

  const key = norm(name);
  if (proposal.candidates.length > 0) {
    for (const c of proposal.candidates) {
      out.candidates.push(candidateRow(c, sourceId, name, domain, "Pipedrive organization resembles an existing account; confirm before it is created or attached"));
    }
    out.notes.push(`organization ${orgId} "${name}" resembles ${proposal.candidates.length} existing account(s); held for review`);
    out.account = { mode: "review", id: null, pipedrive_org_id: orgId, name, key, domain, roster_source: "pipedrive", roster_certified: true };
    return;
  }

  if (key.length === 0) {
    out.ignored = `organization ${orgId} "${name}" normalises to an empty key`;
    return;
  }
  out.notes.push(`organization ${orgId} "${name}" is new to the book; create`);
  out.account = { mode: "create", id: null, pipedrive_org_id: orgId, name, key, domain, roster_source: "pipedrive", roster_certified: true };
}

/* ------------------------------------------------------------------ *
 * Persons
 * ------------------------------------------------------------------ */

/** The first primary email of a person; else the first non-empty one. v2 `emails[]`, v1 `email[]` or a string. */
export function primaryEmail(data: Rec): string | null {
  const list = data.emails ?? data.email;
  if (typeof list === "string") return toStr(list)?.toLowerCase() ?? null;
  if (!Array.isArray(list)) return null;
  const values = list
    .map((e) => (isRec(e) ? { value: toStr(e.value), primary: toBool(e.primary) === true } : { value: toStr(e), primary: false }))
    .filter((e) => e.value !== null && e.value.includes("@"));
  const primary = values.find((e) => e.primary) ?? values[0];
  return primary ? (primary.value as string).toLowerCase() : null;
}

function parsePerson(
  action: PipedriveAction,
  meta: Rec,
  data: Rec,
  known: KnownAccount[],
  out: ParsedPipedriveEvent,
): void {
  const personId = toId(data.id) ?? toId(meta.entity_id);
  if (personId === null) {
    out.ignored = "person event without a person id";
    return;
  }
  if (action === "delete") {
    out.ignored = `person ${personId} deleted in Pipedrive; pb_contacts rows are never deleted by a webhook`;
    return;
  }
  const name = toStr(data.name) ?? toStr([toStr(data.first_name), toStr(data.last_name)].filter((x) => x !== null).join(" "));
  const email = primaryEmail(data);
  const title = toStr(data.job_title ?? data.title);
  const orgId = toId(data.org_id);
  const emailDomain = domainFromEmail(email);

  let account: KnownAccount | null = accountForOrg(orgId, known);
  let via = "pipedrive_org_id";
  if (account === null && emailDomain !== null) {
    account = proposeMatches({ source: "pipedrive", source_id: personId, domain: emailDomain }, known).attach;
    via = "domain";
  }
  if (account !== null) out.notes.push(`person ${personId} attached to account ${account.id} on ${via}`);
  else {
    const orgName = toStr(rec(data.org_id).name) ?? toStr(data.org_name);
    if (orgId !== null) {
      out.candidates.push(unmatchedRow(String(orgId), orgName, emailDomain, `person ${personId} belongs to Pipedrive organization ${orgId}, which is not in the book`));
      out.notes.push(`person ${personId}: organization ${orgId} not in the book; identity candidate queued; contact held (pb_contacts.account_id is required)`);
    } else if (emailDomain !== null) {
      out.candidates.push(unmatchedRow(null, orgName, emailDomain, `person ${personId} has no organization; email domain ${emailDomain} is not in the book`));
      out.notes.push(`person ${personId}: no organization and domain ${emailDomain} not in the book; contact held`);
    } else {
      out.notes.push(`person ${personId}: no organization and no organisational email domain; contact held`);
    }
  }

  out.contact = {
    account_id: account?.id ?? null,
    name,
    email,
    title,
    pipedrive_person_id: personId,
    pipedrive_org_id: orgId,
    source: "pipedrive",
  };
}

/* ------------------------------------------------------------------ *
 * Activities and notes → signals
 * ------------------------------------------------------------------ */

const MEETING_TYPES = new Set(["meeting", "call"]);

/** The account an activity or note belongs to: its organisation (HIGH), else its deal through opts.deal_accounts. */
function accountForActivity(data: Rec, known: KnownAccount[], opts: ParseOptions): { id: string | null; via: string } {
  const orgId = toId(data.org_id);
  const viaOrg = accountForOrg(orgId, known);
  if (viaOrg) return { id: viaOrg.id, via: "org_id" };
  const dealId = toId(data.deal_id);
  if (dealId !== null && opts.deal_accounts) {
    const id = opts.deal_accounts[String(dealId)];
    if (typeof id === "string" && id.length > 0) return { id, via: "deal_id" };
  }
  return { id: null, via: "none" };
}

function parseActivity(
  action: PipedriveAction,
  meta: Rec,
  data: Rec,
  known: KnownAccount[],
  now: string,
  opts: ParseOptions,
  out: ParsedPipedriveEvent,
): void {
  const activityId = toId(data.id) ?? toId(meta.entity_id);
  if (action === "delete") {
    out.ignored = `activity ${activityId ?? "?"} deleted; nothing to record`;
    return;
  }
  const type = toStr(data.type)?.toLowerCase() ?? null;
  if (type === null || !MEETING_TYPES.has(type)) {
    out.ignored = `activity ${activityId ?? "?"} of type ${type ?? "unknown"} is not a meeting or call`;
    return;
  }
  const done = toBool(data.done) === true;
  const due = dueIso(data.due_date, data.due_time);
  const nowMs = Date.parse(now);
  const dueAhead = due !== null && Number.isFinite(nowMs) && Date.parse(due) > nowMs;
  if (!done && !dueAhead) {
    out.ignored = due === null
      ? `activity ${activityId ?? "?"} (${type}) is not done and has no due date`
      : `activity ${activityId ?? "?"} (${type}) is not done and its due date has passed`;
    return;
  }
  const { id: accountId, via } = accountForActivity(data, known, opts);
  if (accountId === null) {
    out.ignored = `activity ${activityId ?? "?"} (${type}) is on no organisation or deal the book knows`;
    return;
  }
  const at = toIso(meta.timestamp) ?? now;
  // A held meeting is observed when it was held; a booked one when it was booked (this event).
  const observedAt = done ? (toIso(data.marked_as_done_time) ?? due ?? at) : at;
  out.notes.push(`activity ${activityId ?? "?"} (${type}, ${done ? "done" : "scheduled"}) → meeting_accepted for account ${accountId} via ${via}`);
  out.signal = makeSignal(accountId, "meeting_accepted", observedAt, {
    activity_id: activityId,
    activity_type: type,
    subject: toStr(data.subject),
    done,
    due_at: due,
    deal_id: toId(data.deal_id),
    org_id: toId(data.org_id),
    person_id: toId(data.person_id),
    matched_via: via,
  }, opts.rubric);
}

function parseNote(
  action: PipedriveAction,
  meta: Rec,
  data: Rec,
  known: KnownAccount[],
  now: string,
  opts: ParseOptions,
  out: ParsedPipedriveEvent,
): void {
  const noteId = toId(data.id) ?? toId(meta.entity_id);
  if (action === "delete") {
    out.ignored = `note ${noteId ?? "?"} deleted; nothing to record`;
    return;
  }
  const text = stripHtml(data.content);
  if (text === null) {
    out.ignored = `note ${noteId ?? "?"} has no content`;
    return;
  }
  const { id: accountId, via } = accountForActivity(data, known, opts);
  if (accountId === null) {
    out.ignored = `note ${noteId ?? "?"} is on no organisation or deal the book knows`;
    return;
  }
  const observedAt = toIso(data.update_time) ?? toIso(data.add_time) ?? toIso(meta.timestamp) ?? now;
  out.notes.push(`note ${noteId ?? "?"} → manual_note for account ${accountId} via ${via}`);
  out.signal = makeSignal(accountId, "manual_note", observedAt, {
    text,
    note_id: noteId,
    deal_id: toId(data.deal_id),
    org_id: toId(data.org_id),
    person_id: toId(data.person_id),
    user_id: toId(data.user_id),
    matched_via: via,
  }, opts.rubric);
}

/* ------------------------------------------------------------------ *
 * parsePipedriveEvent
 * ------------------------------------------------------------------ */

/**
 * One webhooks-v2 delivery → the rows it implies. Never throws on a malformed payload: the
 * result carries `ignored` with the reason instead, so the inbox row records why.
 *
 *   evt       the delivery body as parsed JSON
 *   fieldMap  hash → {label, options} per entity, loaded from Pipedrive at runtime
 *   known     the pb_accounts rows (id, key, name, domain, pipedrive_org_id, orbit_client_id)
 *   now       ISO timestamp of receipt — the only clock this module ever sees
 *   opts      deal_accounts (deal → account) and the rubric for signal weights; both optional
 */
export function parsePipedriveEvent(
  evt: PipedriveV2Event,
  fieldMap: FieldMap,
  known: KnownAccount[],
  now: string,
  opts: ParseOptions = {},
): ParsedPipedriveEvent {
  const out: ParsedPipedriveEvent = { candidates: [], notes: [] };
  if (!isRec(evt) || !isRec(evt.meta)) {
    out.ignored = "malformed event: missing meta";
    return out;
  }
  const meta = evt.meta as Rec;
  const action = normalizeAction(meta.action);
  const entity = normalizeEntity(meta);
  if (action === null) {
    out.ignored = `unknown action ${JSON.stringify(meta.action ?? null)}`;
    return out;
  }
  if (entity === null) {
    out.ignored = "malformed event: missing entity";
    return out;
  }
  const data = rec(evt.data);
  const previous = isRec(evt.previous) ? evt.previous : null;
  const map = fieldMap ?? {};
  const accounts = Array.isArray(known) ? known : [];
  const nowIso = toIso(now) ?? now;

  if (action !== "delete" && Object.keys(data).length === 0) {
    out.ignored = `${entity} ${action} event without data`;
    return out;
  }

  switch (entity) {
    case "deal":
      parseDeal(action, meta, data, previous, map, accounts, nowIso, out);
      break;
    case "organization":
      parseOrganization(action, meta, data, map, accounts, out);
      break;
    case "person":
      parsePerson(action, meta, data, accounts, out);
      break;
    case "activity":
      parseActivity(action, meta, data, accounts, nowIso, opts, out);
      break;
    case "note":
      parseNote(action, meta, data, accounts, nowIso, opts, out);
      break;
    default:
      out.ignored = `entity ${entity} is not handled`;
  }
  return out;
}
