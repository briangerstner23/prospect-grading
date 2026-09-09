/**
 * WLIQ Prospect Book — pb-sync's logic, pure.
 *
 * pb-sync receives packs of rows (accounts, contacts, facts, signals, deals, calls,
 * identity_candidates) from in-session collectors — the Notion seed, the Orbit quote sweep,
 * a Fathom back-fill — and writes them with the natural conflict keys. Everything that can be
 * decided without the database is decided here and tested under Node:
 *
 *   - body validation (the run header, the pack shapes, the rubric upsert)
 *   - column allow-lists per table, so a collector's extra keys (`account_key`,
 *     `close_date_push`, `pipedrive_org_id` on a contact) never reach PostgREST
 *   - `account_key` → `account_id` resolution, from a key→id map the handler loads after the
 *     accounts pack has been upserted
 *   - defaults: `entered_by = system:<run.source>` on facts and signals; weight / lifespan /
 *     decays / expires_at from the rubric catalog on signals
 *   - `close_date_push` folded into `close_date_pushes` on deals
 *
 * Unknown is never evidence: a row that cannot be placed (no account) or typed (a signal type
 * outside the catalog) is reported, never guessed at.
 */

import type { Rubric } from "./core/prospect_types.ts";
import type { Rec } from "./helpers.ts";
import { isRec, toStr } from "./helpers.ts";
import { isRunKind } from "./log.ts";
import { catalogTypes, fillSignalFromCatalog } from "./rubric.ts";

/* ------------------------------------------------------------------ *
 * Column allow-lists (mirror 20260909120000_prospect_book_schema.sql)
 * ------------------------------------------------------------------ */

export const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pb_accounts: [
    "id", "key", "name", "domain", "pipedrive_org_id", "orbit_client_id", "apollo_org_id", "notion_client_id",
    "notion_page_id", "book", "roster_source", "roster_certified", "relationship_type", "lineage", "owner_email",
    "sponsor_email",
  ],
  pb_contacts: [
    "id", "account_id", "name", "email", "title", "seniority", "pipedrive_person_id", "apollo_person_id",
    "is_decision_maker", "last_job_change_at", "source",
  ],
  pb_facts: [
    "id", "account_id", "key", "value", "evidence_label", "source", "evidence_url", "observed_at", "entered_by",
    "stand_in", "note",
  ],
  pb_signals: [
    "id", "account_id", "contact_id", "source", "type", "observed_at", "payload", "evidence_url", "weight",
    "lifespan_days", "decays", "entered_by", "expires_at",
  ],
  pb_deals: [
    "pipedrive_deal_id", "account_id", "title", "pipeline_id", "stage_id", "stage_name", "stage_entered_at", "value",
    "currency", "close_date", "close_date_pushes", "status", "won_time", "lost_time", "owner_user_id", "is_cj",
    "last_buyer_touch_at", "buyer_email_velocity_7d", "next_meeting_at", "decision_maker_engaged",
    "buyer_contacts_30d", "price_discussed", "calls_held", "health", "health_reasons", "raw",
  ],
  pb_calls: [
    "id", "account_id", "fathom_recording_id", "title", "held_at", "url", "recorded_by", "attendees",
    "external_domains", "summary", "transcript_available", "fields", "extraction_status", "confirmed_by",
    "confirmed_at",
  ],
  pb_identity_candidates: [
    "id", "account_id", "source", "source_id", "source_name", "source_domain", "matched_on", "confidence", "status",
    "reviewed_by", "reviewed_at", "note",
  ],
};

/** The packs pb-sync accepts, with their table and natural conflict key (null = insert only). */
export const PACKS: ReadonlyArray<{ pack: string; table: string; on_conflict: string | null }> = [
  { pack: "accounts", table: "pb_accounts", on_conflict: "key" },
  { pack: "contacts", table: "pb_contacts", on_conflict: null },
  { pack: "facts", table: "pb_facts", on_conflict: null },
  { pack: "signals", table: "pb_signals", on_conflict: null },
  { pack: "deals", table: "pb_deals", on_conflict: "pipedrive_deal_id" },
  { pack: "calls", table: "pb_calls", on_conflict: "fathom_recording_id" },
  { pack: "identity_candidates", table: "pb_identity_candidates", on_conflict: null },
];

/** Keep only the table's columns. `dropped` names what was removed, for the run's notes. */
export function pickColumns(table: string, row: Rec): { row: Rec; dropped: string[] } {
  const allowed = COLUMNS[table] ?? [];
  const out: Rec = {};
  const dropped: string[] = [];
  for (const k of Object.keys(row)) {
    if (allowed.includes(k)) out[k] = row[k];
    else dropped.push(k);
  }
  return { row: out, dropped };
}

/* ------------------------------------------------------------------ *
 * Body validation
 * ------------------------------------------------------------------ */

export interface SyncRun {
  kind: string;
  source: string;
  triggered_by: string;
}

export interface RubricUpsertRequest {
  version: string;
  spec: Rec;
  activate: boolean;
}

export interface SyncBody {
  run: SyncRun;
  packs: Record<string, Rec[]>;
  rubric: RubricUpsertRequest | null;
}

export type ValidatedBody = { ok: true; body: SyncBody } | { ok: false; error: string };

/**
 * Shape-check the POST body. `run.source` is required (it names the collector and becomes the
 * default `entered_by`); `run.kind` defaults to 'ingest' and must be a pb_runs kind when given;
 * every pack present must be an array of objects. A body with no packs and no rubric is a 400.
 */
export function validateSyncBody(input: unknown): ValidatedBody {
  if (!isRec(input)) return { ok: false, error: "body must be a JSON object" };
  const runIn = isRec(input.run) ? input.run : null;
  if (runIn === null) return { ok: false, error: "body.run {kind, source, triggered_by} is required" };
  const source = toStr(runIn.source);
  if (source === null) return { ok: false, error: "body.run.source is required (names the collector)" };
  const kindRaw = toStr(runIn.kind) ?? "ingest";
  if (!isRunKind(kindRaw)) return { ok: false, error: `body.run.kind '${kindRaw}' is not a pb_runs kind` };
  const run: SyncRun = { kind: kindRaw, source, triggered_by: toStr(runIn.triggered_by) ?? "pb-sync" };

  const packs: Record<string, Rec[]> = {};
  let any = false;
  for (const { pack } of PACKS) {
    const v = input[pack];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return { ok: false, error: `body.${pack} must be an array` };
    const rows: Rec[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!isRec(v[i])) return { ok: false, error: `body.${pack}[${i}] must be an object` };
      rows.push(v[i] as Rec);
    }
    if (rows.length) any = true;
    packs[pack] = rows;
  }

  let rubric: RubricUpsertRequest | null = null;
  if (input.rubric !== undefined && input.rubric !== null) {
    const r = input.rubric;
    if (!isRec(r)) return { ok: false, error: "body.rubric must be {version, spec, activate?}" };
    if (!isRec(r.spec)) return { ok: false, error: "body.rubric.spec must be the rubric JSON object" };
    const version = toStr(r.version) ?? toStr(r.spec.version);
    if (version === null) return { ok: false, error: "body.rubric.version is required" };
    const specVersion = toStr(r.spec.version);
    if (specVersion !== null && specVersion !== version) {
      return { ok: false, error: `body.rubric.version '${version}' does not match spec.version '${specVersion}'` };
    }
    rubric = { version, spec: r.spec, activate: r.activate === true };
    any = true;
  }

  if (!any) return { ok: false, error: "nothing to write: no packs and no rubric" };
  return { ok: true, body: { run, packs, rubric } };
}

/* ------------------------------------------------------------------ *
 * Row preparation
 * ------------------------------------------------------------------ */

export interface Prepared {
  rows: Rec[];
  /** One line per row refused, with its index in the pack. */
  errors: string[];
  /** Plain-words observations (dropped keys, filled defaults). */
  notes: string[];
}

/** Every `key` the accounts pack carries, for the post-upsert id lookup. */
export function accountKeys(packs: Record<string, Rec[]>): string[] {
  const keys = new Set<string>();
  for (const pack of ["accounts", "contacts", "facts", "signals"]) {
    for (const r of packs[pack] ?? []) {
      const k = toStr(pack === "accounts" ? r.key : r.account_key);
      if (k !== null) keys.add(k);
    }
  }
  return [...keys].sort();
}

/**
 * Resolve `account_key` → `account_id` on a row. Returns the error text when the row names
 * neither, or names a key the map does not hold. Never invents an account.
 */
export function resolveAccountRef(row: Rec, keyToId: Readonly<Record<string, string>>): { row: Rec; error: string | null } {
  const out: Rec = { ...row };
  const id = toStr(out.account_id);
  const key = toStr(out.account_key);
  delete out.account_key;
  if (id !== null) return { row: out, error: null };
  if (key === null) return { row: out, error: "row has neither account_id nor account_key" };
  const found = keyToId[key];
  if (!found) return { row: out, error: `account_key '${key}' is not a pb_accounts.key (accounts pack missing it?)` };
  out.account_id = found;
  return { row: out, error: null };
}

export function prepareAccounts(rows: Rec[]): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  rows.forEach((r, i) => {
    const key = toStr(r.key);
    const name = toStr(r.name);
    if (key === null || name === null) {
      out.errors.push(`accounts[${i}]: key and name are required`);
      return;
    }
    const { row, dropped } = pickColumns("pb_accounts", { ...r, key, name });
    if (dropped.length) out.notes.push(`accounts[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  return out;
}

export function prepareContacts(rows: Rec[], keyToId: Readonly<Record<string, string>>): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  rows.forEach((r, i) => {
    const ref = resolveAccountRef(r, keyToId);
    if (ref.error) {
      out.errors.push(`contacts[${i}]: ${ref.error}`);
      return;
    }
    const { row, dropped } = pickColumns("pb_contacts", ref.row);
    if (dropped.length) out.notes.push(`contacts[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  return out;
}

const EVIDENCE_LABELS = ["evidence", "inferred", "unknown"];

export function prepareFacts(rows: Rec[], run: SyncRun, keyToId: Readonly<Record<string, string>>): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  let filledEnteredBy = 0;
  rows.forEach((r, i) => {
    const ref = resolveAccountRef(r, keyToId);
    if (ref.error) {
      out.errors.push(`facts[${i}]: ${ref.error}`);
      return;
    }
    const key = toStr(ref.row.key);
    if (key === null) {
      out.errors.push(`facts[${i}]: key is required`);
      return;
    }
    const label = toStr(ref.row.evidence_label);
    if (label === null || !EVIDENCE_LABELS.includes(label)) {
      out.errors.push(`facts[${i}]: evidence_label must be evidence | inferred | unknown`);
      return;
    }
    const source = toStr(ref.row.source) ?? run.source;
    const entered = toStr(ref.row.entered_by);
    const withDefaults: Rec = {
      ...ref.row,
      key,
      source,
      evidence_label: label,
      value: ref.row.value === undefined ? null : ref.row.value,
      entered_by: entered ?? `system:${run.source}`,
      stand_in: ref.row.stand_in === true,
    };
    if (entered === null) filledEnteredBy++;
    const { row, dropped } = pickColumns("pb_facts", withDefaults);
    if (dropped.length) out.notes.push(`facts[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  if (filledEnteredBy) out.notes.push(`facts: entered_by defaulted to system:${run.source} on ${filledEnteredBy} row(s)`);
  return out;
}

export interface PreparedSignals extends Prepared {
  /** Types outside the rubric catalog, unique, sorted — pb-sync answers 400 with this list. */
  bad_types: string[];
}

export function prepareSignals(rows: Rec[], run: SyncRun, rubric: Rubric, keyToId: Readonly<Record<string, string>>): PreparedSignals {
  const out: PreparedSignals = { rows: [], errors: [], notes: [], bad_types: [] };
  const known = new Set(catalogTypes(rubric));
  const bad = new Set<string>();
  let filledEnteredBy = 0;
  const filledFields = new Set<string>();
  rows.forEach((r, i) => {
    const type = toStr(r.type);
    if (type === null) {
      out.errors.push(`signals[${i}]: type is required`);
      return;
    }
    if (!known.has(type)) {
      bad.add(type);
      out.errors.push(`signals[${i}]: type '${type}' is not in the rubric catalog`);
      return;
    }
    const ref = resolveAccountRef(r, keyToId);
    if (ref.error) {
      out.errors.push(`signals[${i}]: ${ref.error}`);
      return;
    }
    const entered = toStr(ref.row.entered_by);
    if (entered === null) filledEnteredBy++;
    const fill = fillSignalFromCatalog({
      ...ref.row,
      source: toStr(ref.row.source) ?? run.source,
      entered_by: entered ?? `system:${run.source}`,
    }, rubric);
    if (fill.error) {
      out.errors.push(`signals[${i}]: ${fill.error}`);
      return;
    }
    for (const f of fill.filled) filledFields.add(f);
    const { row, dropped } = pickColumns("pb_signals", fill.row);
    if (dropped.length) out.notes.push(`signals[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  out.bad_types = [...bad].sort();
  if (filledEnteredBy) out.notes.push(`signals: entered_by defaulted to system:${run.source} on ${filledEnteredBy} row(s)`);
  if (filledFields.size) out.notes.push(`signals: ${[...filledFields].sort().join(", ")} filled from the rubric catalog where absent`);
  return out;
}

/** `close_date_pushes` as an array whatever the source sent (jsonb array, a count, or nothing). */
export function pushesArray(v: unknown): unknown[] {
  return Array.isArray(v) ? [...v] : [];
}

/**
 * A pb_deals upsert row. `close_date_push` (the parser's single-event shape) is appended to
 * `close_date_pushes`; a null `stage_entered_at` means "unchanged" and is omitted so the upsert
 * does not overwrite a known date with null.
 */
export function dealRowForUpsert(deal: Rec, existingPushes: unknown[] = []): Rec {
  const merged: Rec = { ...deal };
  const pushes = [...existingPushes, ...pushesArray(merged.close_date_pushes)];
  if (isRec(merged.close_date_push)) pushes.push(merged.close_date_push);
  delete merged.close_date_push;
  merged.close_date_pushes = pushes;
  if (merged.stage_entered_at === null || merged.stage_entered_at === undefined) delete merged.stage_entered_at;
  if (merged.is_cj === undefined || merged.is_cj === null) merged.is_cj = false;
  return pickColumns("pb_deals", merged).row;
}

export function prepareDeals(rows: Rec[]): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  rows.forEach((r, i) => {
    const id = r.pipedrive_deal_id;
    if (!(typeof id === "number" && Number.isFinite(id)) && toStr(id) === null) {
      out.errors.push(`deals[${i}]: pipedrive_deal_id is required`);
      return;
    }
    const dropped = Object.keys(r).filter((k) => !COLUMNS.pb_deals.includes(k) && k !== "close_date_push");
    if (dropped.length) out.notes.push(`deals[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(dealRowForUpsert(r));
  });
  return out;
}

export function prepareCalls(rows: Rec[]): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  rows.forEach((r, i) => {
    const rid = toStr(r.fathom_recording_id);
    if (rid === null) {
      out.errors.push(`calls[${i}]: fathom_recording_id is required`);
      return;
    }
    const { row, dropped } = pickColumns("pb_calls", { ...r, fathom_recording_id: rid });
    if (dropped.length) out.notes.push(`calls[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  return out;
}

export function prepareCandidates(rows: Rec[]): Prepared {
  const out: Prepared = { rows: [], errors: [], notes: [] };
  rows.forEach((r, i) => {
    const source = toStr(r.source);
    if (source === null) {
      out.errors.push(`identity_candidates[${i}]: source is required`);
      return;
    }
    const { row, dropped } = pickColumns("pb_identity_candidates", { ...r, source, status: toStr(r.status) ?? "proposed" });
    if (dropped.length) out.notes.push(`identity_candidates[${i}]: dropped ${dropped.join(", ")}`);
    out.rows.push(row);
  });
  return out;
}

/** The keys of `wrote` in the response, in a fixed order, every pack present even at 0. */
export const WROTE_KEYS = ["accounts", "contacts", "facts", "signals", "deals", "calls", "identity_candidates", "rubric"] as const;
