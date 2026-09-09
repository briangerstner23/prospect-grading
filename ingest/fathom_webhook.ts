/**
 * WLIQ Prospect Book — Fathom webhook parser (DESIGN.md §4e).
 *
 * PURE. No clock, no network, no filesystem, no dependencies. Runs under Deno and under
 * `node --experimental-strip-types`. The HTTP handler (`supabase/functions/pb-fathom-webhook`)
 * verifies the Standard Webhooks signature (webhook_signatures.ts), stores the delivery in
 * `pb_webhook_inbox`, then calls `parseFathomWebhook` and writes the pb_calls row it returns.
 *
 * The "new meeting content ready" payload is read DEFENSIVELY — every field has at least one
 * alternate name, because the shape is Fathom's to change:
 *   recording_id | id · title | meeting_title · url | share_url | recording_url ·
 *   created_at | recorded_at | scheduled_start_time | recording_start_time ·
 *   recorded_by {name,email} | string · calendar_invitees [{name,email,is_external}] ·
 *   default_summary | summary (string or {markdown_formatted}) · transcript [] | string ·
 *   action_items · crm_matches (carried through in `notes` only; pb_calls has no raw column).
 *
 * Attendance and identity:
 *   is_external      Fathom's flag when it is a boolean; otherwise computed from the email's
 *                    domain against INTERNAL_DOMAINS (+ opts.internal_domains). No email → null.
 *   domain           normalizeDomain(email): the join key. Generic mailboxes (gmail…) are null —
 *                    an external person with a personal address is still external, but never a key.
 *   external_domains the distinct join-key domains of external attendees, never an internal one.
 *   attach           the first external domain that matches a known account HIGH (identity.ts);
 *                    every other external domain becomes a pb_identity_candidates row.
 *   external=false   internal-only calls (and calls with no identifiable external attendee) are
 *                    skipped — counted in pb_runs, never a pb_calls row.
 *
 * The seven quote-backed fields plus the potential questions (R5) are the `CallFields` schema
 * below. This module defines the shape and leaves `fields: null`, `extraction_status:
 * 'pending'`; extraction is a later step and nothing writes to Pipedrive before `confirmed_by`.
 *
 * Unknown is never evidence: an absent field is null; no signal is ever emitted from a call.
 */

import type { KnownAccount } from "./identity.ts";
import { normalizeDomain, proposeMatches } from "./identity.ts";

/* ------------------------------------------------------------------ *
 * Input types (defensive)
 * ------------------------------------------------------------------ */

export interface FathomInvitee {
  name?: string | null;
  email?: string | null;
  is_external?: boolean | null;
  [key: string]: unknown;
}

export interface FathomSpeaker {
  display_name?: string | null;
  matched_calendar_invitee_email?: string | null;
  [key: string]: unknown;
}

export interface FathomTranscriptLine {
  speaker?: FathomSpeaker | string | null;
  text?: string | null;
  timestamp?: string | number | null;
  [key: string]: unknown;
}

export interface FathomSummaryObject {
  markdown_formatted?: string | null;
  text?: string | null;
  content?: string | null;
  [key: string]: unknown;
}

export interface FathomWebhookPayload {
  recording_id?: number | string | null;
  id?: number | string | null;
  title?: string | null;
  meeting_title?: string | null;
  url?: string | null;
  share_url?: string | null;
  recording_url?: string | null;
  created_at?: string | null;
  recorded_at?: string | null;
  scheduled_start_time?: string | null;
  recording_start_time?: string | null;
  recorded_by?: { name?: string | null; email?: string | null; [key: string]: unknown } | string | null;
  calendar_invitees?: FathomInvitee[] | null;
  default_summary?: string | FathomSummaryObject | null;
  summary?: string | FathomSummaryObject | null;
  transcript?: FathomTranscriptLine[] | string | null;
  action_items?: unknown;
  crm_matches?: unknown;
  [key: string]: unknown;
}

export interface FathomParseOptions {
  /** Added to INTERNAL_DOMAINS for this parse. Lower-case hosts, no www. */
  internal_domains?: string[];
}

/* ------------------------------------------------------------------ *
 * The seven-field extraction schema (R5) — defined here, filled later
 * ------------------------------------------------------------------ */

/** One extracted field: the value, the quote that backs it, where in the call, and whether it was inferred rather than said. */
export interface CallFieldValue {
  value: string | number | boolean | string[];
  quote: string;
  /** Transcript timestamp of the quote ("00:12:34" or seconds), when known. */
  timestamp: string | number | null;
  inferred: boolean;
}

export type CallField = CallFieldValue | "not discussed";

/**
 * SPICED's fields (pain, impact, critical_event, decision) plus price_reaction, next_step and
 * risk_words are the seven quote-backed fields; vendors_used and our_rank are the two potential
 * questions (who else do you use, where do we rank); attendees_roles feeds Dimension A's
 * authority. Nothing is SCORED on these (DECISIONS.md §1 row 5) — they feed Dimension A facts
 * and deal-health inputs only after a person confirms.
 */
export interface CallFields {
  pain: CallField;
  impact: CallField;
  critical_event: CallField;
  decision: CallField;
  price_reaction: CallField;
  next_step: CallField;
  risk_words: CallField;
  vendors_used: CallField;
  our_rank: CallField;
  attendees_roles: CallField;
}

export const CALL_FIELD_KEYS: readonly (keyof CallFields)[] = [
  "pain",
  "impact",
  "critical_event",
  "decision",
  "price_reaction",
  "next_step",
  "risk_words",
  "vendors_used",
  "our_rank",
  "attendees_roles",
];

export function emptyCallFields(): CallFields {
  return {
    pain: "not discussed",
    impact: "not discussed",
    critical_event: "not discussed",
    decision: "not discussed",
    price_reaction: "not discussed",
    next_step: "not discussed",
    risk_words: "not discussed",
    vendors_used: "not discussed",
    our_rank: "not discussed",
    attendees_roles: "not discussed",
  };
}

/* ------------------------------------------------------------------ *
 * Output types
 * ------------------------------------------------------------------ */

export interface CallAttendee {
  name: string | null;
  email: string | null;
  is_external: boolean | null;
  /** Join-key domain (normalizeDomain); null for internal, generic or missing addresses. */
  domain: string | null;
}

/** A pb_calls row. Every key is a column. */
export interface CallRow {
  fathom_recording_id: string;
  account_id: string | null;
  title: string | null;
  held_at: string | null;
  url: string | null;
  recorded_by: string | null;
  attendees: CallAttendee[];
  external_domains: string[];
  summary: string | null;
  transcript_available: boolean;
  fields: null;
  extraction_status: "pending";
}

/** A pb_identity_candidates row. */
export interface FathomIdentityCandidate {
  account_id: string | null;
  source: "fathom";
  source_id: string | null;
  source_name: string | null;
  source_domain: string | null;
  matched_on: string;
  confidence: "high" | "medium" | "low" | null;
  note: string | null;
}

export type FathomSkipReason = "missing recording id" | "internal only" | "no external attendee identified";

export interface FathomParseResult {
  call: CallRow;
  /** true when at least one attendee is external. false → skip (see skip_reason). */
  external: boolean;
  /** Non-null when the handler should write nothing to pb_calls. */
  skip_reason: FathomSkipReason | null;
  attach: KnownAccount | null;
  candidates: FathomIdentityCandidate[];
  /** Always empty: a call is evidence for extraction, never a signal by itself. */
  signals: never[];
  /** Plain-words observations for pb_runs. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Internal domains
 * ------------------------------------------------------------------ */

/** WLIQ's own mail domains. Extendable per call through opts.internal_domains. */
export const INTERNAL_DOMAINS: readonly string[] = ["whitelabeliq.com"];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length === 0 ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (/^\d{9,13}$/.test(s)) return toIso(Number(s));
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function firstStr(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = toStr(v);
    if (s !== null) return s;
  }
  return null;
}

function firstIso(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = toIso(v);
    if (s !== null) return s;
  }
  return null;
}

/** The raw host of an email address, lower-case, no generic-provider filtering. */
function rawEmailHost(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const host = email.slice(at + 1).trim().toLowerCase().replace(/^www\./, "");
  return host.length === 0 || !host.includes(".") ? null : host;
}

function cleanEmail(v: unknown): string | null {
  const s = toStr(v);
  if (s === null) return null;
  const angle = s.match(/<([^>]+)>/);
  const e = (angle ? angle[1] : s).trim().toLowerCase();
  return e.includes("@") ? e : null;
}

/**
 * Markdown → readable plain text. Headings, emphasis, bullets, links, code fences and
 * horizontal rules are removed; line structure is kept. Deterministic and conservative.
 */
export function markdownToPlain(md: unknown): string | null {
  const s = toStr(md);
  if (s === null) return null;
  // Line-anchored patterns use [ \t] rather than \s so a blank line is never swallowed.
  // Bullets are normalised before emphasis so a leading "* " is not read as italics.
  const text = s
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ""))
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1- ")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/gm, "$1$2")
    .replace(/(^|[^_\w])_([^_\n]+)_/gm, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length === 0 ? null : text;
}

function summaryText(payload: FathomWebhookPayload): string | null {
  for (const v of [payload.default_summary, payload.summary]) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      const t = markdownToPlain(v);
      if (t !== null) return t;
    } else if (isRec(v)) {
      const t = markdownToPlain(firstStr(v.markdown_formatted, v.text, v.content, v.summary));
      if (t !== null) return t;
    }
  }
  return null;
}

function transcriptAvailable(t: unknown): boolean {
  if (Array.isArray(t)) return t.some((line) => isRec(line) ? toStr(line.text) !== null : toStr(line) !== null);
  return toStr(t) !== null;
}

function recordedBy(v: unknown): string | null {
  if (isRec(v)) return cleanEmail(v.email) ?? firstStr(v.name, v.display_name);
  return cleanEmail(v) ?? toStr(v);
}

/* ------------------------------------------------------------------ *
 * Attendees
 * ------------------------------------------------------------------ */

interface AttendeeSeed {
  name: string | null;
  email: string | null;
  flag: boolean | null;
}

/** calendar_invitees when present; otherwise the distinct transcript speakers (name, matched email). */
function attendeeSeeds(payload: FathomWebhookPayload, notes: string[]): AttendeeSeed[] {
  const invitees = payload.calendar_invitees;
  if (Array.isArray(invitees) && invitees.length > 0) {
    return invitees
      .filter((i) => i !== null && i !== undefined)
      .map((i): AttendeeSeed => isRec(i)
        ? { name: firstStr(i.name, i.display_name), email: cleanEmail(i.email), flag: typeof i.is_external === "boolean" ? i.is_external : null }
        : typeof i === "string"
        ? { name: toStr(i), email: cleanEmail(i), flag: null }
        : { name: null, email: null, flag: null })
      .filter((s) => s.name !== null || s.email !== null);
  }
  const transcript = payload.transcript;
  if (Array.isArray(transcript) && transcript.length > 0) {
    const seen = new Map<string, AttendeeSeed>();
    for (const line of transcript) {
      if (!isRec(line)) continue;
      const sp = line.speaker;
      const seed: AttendeeSeed = isRec(sp)
        ? { name: firstStr(sp.display_name, sp.name), email: cleanEmail(sp.matched_calendar_invitee_email ?? sp.email), flag: null }
        : { name: toStr(sp), email: null, flag: null };
      if (seed.name === null && seed.email === null) continue;
      const k = seed.email ?? `name:${seed.name}`;
      if (!seen.has(k)) seen.set(k, seed);
    }
    if (seen.size > 0) notes.push("no calendar_invitees; attendees derived from transcript speakers");
    return Array.from(seen.values());
  }
  return [];
}

function buildAttendees(seeds: AttendeeSeed[], internal: Set<string>): CallAttendee[] {
  return seeds.map((s) => {
    const host = rawEmailHost(s.email);
    const hostInternal = host !== null && internal.has(host);
    const is_external = s.flag !== null ? s.flag : host !== null ? !hostInternal : null;
    const joinDomain = hostInternal ? null : normalizeDomain(s.email);
    return {
      name: s.name,
      email: s.email,
      is_external,
      domain: is_external === true && joinDomain !== null && !internal.has(joinDomain) ? joinDomain : null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * parseFathomWebhook
 * ------------------------------------------------------------------ */

/**
 * One "new meeting content ready" delivery → a pb_calls row, the attach decision and the
 * identity candidates. Never throws on a malformed payload.
 *
 *   payload  the delivery body as parsed JSON
 *   known    the pb_accounts rows (id, key, name, domain, pipedrive_org_id, orbit_client_id)
 *   opts     internal_domains to add to INTERNAL_DOMAINS
 */
export function parseFathomWebhook(
  payload: FathomWebhookPayload,
  known: KnownAccount[],
  opts: FathomParseOptions = {},
): FathomParseResult {
  const notes: string[] = [];
  const p: FathomWebhookPayload = isRec(payload) ? payload : {};
  const accounts = Array.isArray(known) ? known : [];

  const internal = new Set<string>(INTERNAL_DOMAINS);
  for (const d of opts.internal_domains ?? []) {
    const host = toStr(d)?.toLowerCase().replace(/^www\./, "");
    if (host) internal.add(host);
  }

  const recordingId = firstStr(p.recording_id, p.id, isRec(p.recording) ? (p.recording as Rec).id : null);
  const attendees = buildAttendees(attendeeSeeds(p, notes), internal);
  const externalDomains: string[] = [];
  for (const a of attendees) if (a.domain !== null && !externalDomains.includes(a.domain)) externalDomains.push(a.domain);

  const anyExternal = attendees.some((a) => a.is_external === true);
  // "internal only" is a positive finding: every attendee identified, every one internal.
  // An attendee nobody could place (no email) leaves the question open instead.
  const allInternal = attendees.length > 0 && attendees.every((a) => a.is_external === false);

  /* ---- identity: first HIGH domain match attaches; every other external domain is a candidate ---- */
  let attach: KnownAccount | null = null;
  let attachedOn: string | null = null;
  const candidates: FathomIdentityCandidate[] = [];
  for (const domain of externalDomains) {
    const proposal = proposeMatches({ source: "fathom", source_id: recordingId, domain }, accounts);
    if (proposal.attach && attach === null) {
      attach = proposal.attach;
      attachedOn = domain;
      notes.push(`attached to account ${attach.id} on domain ${domain}`);
      continue;
    }
    if (proposal.attach) {
      candidates.push({
        account_id: proposal.attach.id,
        source: "fathom",
        source_id: recordingId,
        source_name: null,
        source_domain: domain,
        matched_on: "domain",
        confidence: "high",
        note: `second external domain on the call also matches an account; ${attach?.id ?? "?"} was attached on ${attachedOn}`,
      });
      notes.push(`domain ${domain} also matches account ${proposal.attach.id}; queued for review`);
      continue;
    }
    candidates.push({
      account_id: null,
      source: "fathom",
      source_id: recordingId,
      source_name: null,
      source_domain: domain,
      matched_on: "none",
      confidence: null,
      note: `external domain on call ${recordingId ?? "?"} is not in the book`,
    });
    notes.push(`domain ${domain} not in the book; identity candidate queued`);
  }

  /* ---- skip decisions ---- */
  let skip: FathomSkipReason | null = null;
  if (recordingId === null) {
    skip = "missing recording id";
    notes.push("payload carries no recording_id or id; cannot key a pb_calls row");
  } else if (!anyExternal) {
    skip = allInternal ? "internal only" : "no external attendee identified";
    notes.push(skip === "internal only" ? "every identified attendee is internal; skipped" : "no attendee could be identified as external; skipped");
  }

  if (p.action_items !== undefined && p.action_items !== null) notes.push("payload carried action_items (not stored in Phase 1)");
  if (p.crm_matches !== undefined && p.crm_matches !== null) notes.push("payload carried crm_matches (not stored in Phase 1)");

  const call: CallRow = {
    fathom_recording_id: recordingId ?? "",
    account_id: attach?.id ?? null,
    title: firstStr(p.title, p.meeting_title),
    held_at: firstIso(p.created_at, p.recorded_at, p.scheduled_start_time, p.recording_start_time),
    url: firstStr(p.url, p.share_url, p.recording_url),
    recorded_by: recordedBy(p.recorded_by),
    attendees,
    external_domains: externalDomains,
    summary: summaryText(p),
    transcript_available: transcriptAvailable(p.transcript),
    fields: null,
    extraction_status: "pending",
  };

  return { call, external: anyExternal, skip_reason: skip, attach, candidates, signals: [], notes };
}
