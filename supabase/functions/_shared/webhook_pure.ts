/**
 * WLIQ Prospect Book — the webhook handlers' logic, pure.
 *
 * pb-fathom-webhook and pb-pipedrive-webhook are cap → read → verify → inbox → pure module →
 * write rows. The parsing is in ./ingest/fathom_webhook.ts and ./ingest/pipedrive_webhook.ts;
 * the verification in ./ingest/webhook_signatures.ts; the body cap in ./helpers.ts. What is
 * left — which headers the inbox keeps, what the inbox row holds when verification failed, the
 * deal merge, the field map from Vault, the account attach patch — is here and tested under Node.
 *
 * No signal is raised from an inbound call in Phase 1. The pb_calls row is the record; the
 * seven-field extraction (a later step, confirmed by a person) is what may read it. An earlier
 * helper that inferred a "next step agreed" signal from a delivery's action items was removed:
 * the design does not sanction that inference.
 */

import type { CallRow, FathomIdentityCandidate } from "./ingest/fathom_webhook.ts";
import type { AccountUpsert, ContactUpsert, FieldMap, IdentityCandidateRow } from "./ingest/pipedrive_webhook.ts";
import type { HeaderLike, ParsedJson, Rec } from "./helpers.ts";
import { headerSubset, inboxBody, isRec, safeJsonParse, sha256Hex, toStr } from "./helpers.ts";
import { dealRowForUpsert } from "./sync_pure.ts";

/* ------------------------------------------------------------------ *
 * Inbox headers — a subset, never the whole set (no credentials in the inbox)
 * ------------------------------------------------------------------ */

export const FATHOM_INBOX_HEADERS = ["webhook-id", "webhook-timestamp", "content-type", "content-length", "user-agent"] as const;
export const PIPEDRIVE_INBOX_HEADERS = ["content-type", "content-length", "user-agent", "x-pipedrive-webhook-id"] as const;

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
 * The inbox row — the full body only when it is safe to keep
 * ------------------------------------------------------------------ */

export type InboxStorage = "full" | "digest";

/**
 * What pb_webhook_inbox keeps of a delivery.
 *
 *   full    a verified delivery; or one that arrived while the secret was NOT configured — the
 *           replay case: the operator sets the secret, then processes the stored body.
 *   digest  the secret IS configured (or could not be read) and verification failed. An
 *           unauthenticated sender does not get to fill the inbox with bodies: only the header
 *           subset, a sha256 of the body, its byte length and the refusal reason are kept.
 */
export function inboxStorage(verified: boolean, secretConfigured: boolean | null): InboxStorage {
  if (verified) return "full";
  return secretConfigured === false ? "full" : "digest";
}

export interface InboxRowInput {
  source: "fathom" | "pipedrive";
  /** The header subset (fathomInboxHeaders / pipedriveInboxHeaders). */
  headers: Rec;
  rawBody: string;
  parsed: ParsedJson;
  /** Bytes read, from readBodyCapped. */
  bodyBytes: number;
  verified: boolean;
  /** true = a secret is set; false = not configured; null = the Vault lookup itself failed. */
  secretConfigured: boolean | null;
  /** The refusal reason when not verified; ignored when verified. */
  reason: string | null;
}

/** The pb_webhook_inbox insert row and which storage it got. Async only for the digest. */
export async function inboxRow(input: InboxRowInput): Promise<{ row: Rec; storage: InboxStorage }> {
  const storage = inboxStorage(input.verified, input.secretConfigured);
  const reason = input.reason !== null && input.reason.length > 0 ? input.reason : "not verified";
  if (storage === "full") {
    const notJson = input.parsed.ok ? null : `body is not JSON: ${input.parsed.error}`;
    return {
      storage,
      row: {
        source: input.source,
        headers: input.headers,
        body: inboxBody(input.rawBody, input.parsed),
        verified: input.verified,
        error: input.verified ? notJson : reason,
      },
    };
  }
  return {
    storage,
    row: {
      source: input.source,
      headers: input.headers,
      body: { stored: "digest", body_sha256: await sha256Hex(input.rawBody), body_bytes: input.bodyBytes, reason },
      verified: false,
      error: reason,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fathom
 * ------------------------------------------------------------------ */

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
