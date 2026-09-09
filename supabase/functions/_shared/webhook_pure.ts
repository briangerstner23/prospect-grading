/**
 * WLIQ Prospect Book — the webhook handlers' logic, pure.
 *
 * pb-fathom-webhook and pb-pipedrive-webhook are parse → verify → pure module → write rows.
 * The parsing is in ./ingest/fathom_webhook.ts and ./ingest/pipedrive_webhook.ts; the
 * verification in ./ingest/webhook_signatures.ts. What is left — which headers the inbox
 * keeps, the one approximated Fathom signal, the deal merge, the field map from Vault, the
 * account attach patch — is here and tested under Node.
 */

import type { Rubric } from "./core/prospect_types.ts";
import type { CallRow, FathomIdentityCandidate } from "./ingest/fathom_webhook.ts";
import type { AccountUpsert, ContactUpsert, FieldMap, IdentityCandidateRow } from "./ingest/pipedrive_webhook.ts";
import type { HeaderLike, Rec } from "./helpers.ts";
import { headerSubset, isRec, safeJsonParse, toStr } from "./helpers.ts";
import { catalogEntry } from "./rubric.ts";
import { dealRowForUpsert } from "./sync_pure.ts";

/* ------------------------------------------------------------------ *
 * Inbox headers — a subset, never the whole set (no credentials in the inbox)
 * ------------------------------------------------------------------ */

export const FATHOM_INBOX_HEADERS = ["webhook-id", "webhook-timestamp", "content-type", "user-agent"] as const;
export const PIPEDRIVE_INBOX_HEADERS = ["content-type", "user-agent", "x-pipedrive-webhook-id"] as const;

/** Fathom: webhook-id, webhook-timestamp and whether a signature header was present — never the signature value. */
export function fathomInboxHeaders(headers: HeaderLike | null | undefined): Rec {
  const sub = headerSubset(headers, FATHOM_INBOX_HEADERS);
  let sig: string | null | undefined = null;
  try {
    sig = headers && typeof headers.get === "function" ? headers.get("webhook-signature") : null;
  } catch {
    sig = null;
  }
  return { ...sub, "has-signature": sig !== null && sig !== undefined && String(sig).length > 0 };
}

/** Pipedrive: content-type, user-agent and whether an Authorization header was present — never its value. */
export function pipedriveInboxHeaders(headers: HeaderLike | null | undefined): Rec {
  const sub = headerSubset(headers, PIPEDRIVE_INBOX_HEADERS);
  let auth: string | null | undefined = null;
  try {
    auth = headers && typeof headers.get === "function" ? headers.get("authorization") : null;
  } catch {
    auth = null;
  }
  return { ...sub, "has-authorization": auth !== null && auth !== undefined && String(auth).length > 0 };
}

/* ------------------------------------------------------------------ *
 * Fathom
 * ------------------------------------------------------------------ */

/**
 * The payload's action_items exist and are non-empty. Fathom's shape varies (an array, or a
 * string of bullet lines, or an object with `items`); anything else — including an empty
 * array or a blank string — is "no action items". Unknown is never evidence.
 */
export function hasNonEmptyActionItems(payload: unknown): boolean {
  if (!isRec(payload)) return false;
  const v = payload.action_items;
  if (Array.isArray(v)) return v.some((x) => x !== null && x !== undefined && (typeof x !== "string" || x.trim().length > 0));
  if (typeof v === "string") return v.trim().length > 0;
  if (isRec(v)) {
    const items = v.items ?? v.action_items;
    return Array.isArray(items) ? items.length > 0 : false;
  }
  return false;
}

export function actionItemCount(payload: unknown): number | null {
  if (!isRec(payload)) return null;
  const v = payload.action_items;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.trim().length ? v.split(/\r?\n/).filter((l) => l.trim().length).length : 0;
  if (isRec(v)) {
    const items = v.items ?? v.action_items;
    return Array.isArray(items) ? items.length : null;
  }
  return null;
}

/**
 * The one signal a Fathom delivery may raise in Phase 1: `next_step_agreed`, ONLY when the
 * call attached to an account (high domain match) AND the payload carries non-empty
 * action_items. This is a documented approximation — an action item is not proof a next step
 * was agreed; the seven-field extraction (later step) will supersede it. Weight, lifespan and
 * decay come from the rubric catalog; no catalog entry → no signal.
 */
export function fathomNextStepSignal(call: CallRow, accountId: string | null, payload: unknown, rubric: Rubric): Rec | null {
  if (accountId === null) return null;
  if (!hasNonEmptyActionItems(payload)) return null;
  const cat = catalogEntry(rubric, "next_step_agreed");
  if (cat === null) return null;
  const observed = call.held_at;
  if (observed === null) return null;
  const expires = cat.lifespan_days !== null && cat.lifespan_days > 0 ? new Date(Date.parse(observed) + cat.lifespan_days * 86_400_000) : null;
  if (expires !== null && Number.isNaN(expires.getTime())) return null;
  return {
    account_id: accountId,
    contact_id: null,
    source: "fathom",
    type: "next_step_agreed",
    observed_at: observed,
    payload: {
      recording_id: call.fathom_recording_id,
      title: call.title,
      action_item_count: actionItemCount(payload),
      approximation: "action_items present on the Fathom delivery; superseded by the extraction step (R5)",
    },
    evidence_url: call.url,
    weight: cat.weight,
    lifespan_days: cat.lifespan_days,
    decays: cat.decays,
    entered_by: "system:fathom",
    expires_at: expires === null ? null : expires.toISOString(),
  };
}

/** A pb_calls upsert row: the parser's CallRow with the attached account (when any). */
export function callRowForUpsert(call: CallRow, accountId: string | null): Rec {
  return { ...(call as unknown as Rec), account_id: accountId ?? call.account_id ?? null };
}

/** pb_identity_candidates rows from either parser's candidate shape, status 'proposed'. */
export function candidateRows(cands: ReadonlyArray<FathomIdentityCandidate | IdentityCandidateRow>): Rec[] {
  return cands.map((c) => ({
    account_id: c.account_id,
    source: c.source,
    source_id: c.source_id,
    source_name: c.source_name,
    source_domain: c.source_domain,
    matched_on: c.matched_on,
    confidence: c.confidence,
    status: "proposed",
    note: c.note,
  }));
}

/* ------------------------------------------------------------------ *
 * Pipedrive
 * ------------------------------------------------------------------ */

/**
 * The custom-field map is JSON written to Vault as PB_PIPEDRIVE_FIELD_MAP by the collector
 * that reads /v2/dealFields and /v1/organizationFields. Absent or unparseable → an empty map
 * (custom fields then pass through unlabelled) with a note; hash keys are never hard-coded.
 */
export function parseFieldMap(text: string | null | undefined): { map: FieldMap; note: string | null } {
  if (text === null || text === undefined || text.trim().length === 0) {
    return { map: {}, note: "PB_PIPEDRIVE_FIELD_MAP is not set; custom fields are unlabelled" };
  }
  const parsed = safeJsonParse(text);
  if (!parsed.ok || !isRec(parsed.value)) {
    return { map: {}, note: "PB_PIPEDRIVE_FIELD_MAP is not a JSON object; custom fields are unlabelled" };
  }
  const v = parsed.value;
  const map: FieldMap = {};
  for (const entity of ["deals", "organizations", "persons", "activities"] as const) {
    if (isRec(v[entity])) (map as Rec)[entity] = v[entity];
  }
  return { map, note: null };
}

/**
 * Attach: the columns to set on the existing account. `pipedrive_org_id`, `roster_source` and
 * `roster_certified` always (PRO-6: Pipedrive certifies the row); `name` and `domain` only when
 * the existing row has none — `key` is never changed.
 */
export function accountAttachPatch(acct: AccountUpsert, existing: Rec | null): Rec {
  const patch: Rec = {
    pipedrive_org_id: acct.pipedrive_org_id,
    roster_source: acct.roster_source,
    roster_certified: acct.roster_certified,
  };
  if (existing && toStr(existing.name) === null && toStr(acct.name) !== null) patch.name = acct.name;
  if (existing && toStr(existing.domain) === null && acct.domain !== null) patch.domain = acct.domain;
  return patch;
}

/** Create: a new pb_accounts row from an organization event. */
export function accountCreateRow(acct: AccountUpsert): Rec {
  return {
    key: acct.key,
    name: acct.name,
    domain: acct.domain,
    pipedrive_org_id: acct.pipedrive_org_id,
    roster_source: acct.roster_source,
    roster_certified: acct.roster_certified,
    book: "prospect",
  };
}

/** A pb_contacts row; `pipedrive_org_id` is not a column and is dropped. null when no account. */
export function contactRow(contact: ContactUpsert, resolvedAccountId: string | null): Rec | null {
  const accountId = contact.account_id ?? resolvedAccountId;
  if (accountId === null) return null;
  return {
    account_id: accountId,
    name: contact.name,
    email: contact.email,
    title: contact.title,
    pipedrive_person_id: contact.pipedrive_person_id,
    source: contact.source,
  };
}

/** The pb_deals upsert row for a webhook deal: existing pushes kept, the new push appended. */
export function mergeDealUpsert(deal: Rec, existing: Rec | null): Rec {
  const existingPushes = existing && Array.isArray(existing.close_date_pushes) ? existing.close_date_pushes : [];
  return dealRowForUpsert(deal, existingPushes);
}

/** `pipedrive_org_id` → account id from the known-accounts list, for a contact whose org is known but unattached. */
export function accountIdForOrg(known: ReadonlyArray<{ id: string; pipedrive_org_id: number | string | null }>, orgId: number | null): string | null {
  if (orgId === null) return null;
  for (const k of known) {
    if (k.pipedrive_org_id !== null && k.pipedrive_org_id !== undefined && Number(k.pipedrive_org_id) === orgId) return k.id;
  }
  return null;
}

/** Deals the book already holds, as the parser's `deal_accounts` option. */
export function dealAccountsMap(rows: ReadonlyArray<Rec>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const id = toStr(r.pipedrive_deal_id);
    const acct = toStr(r.account_id);
    if (id !== null && acct !== null) out[id] = acct;
  }
  return out;
}
