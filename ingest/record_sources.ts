/**
 * WLIQ Prospect Book — turning what each channel returns into a WrittenRecord.
 *
 * The book reads three kinds of written record and will read more. What they have in common is
 * handled by written_record.ts; what differs is here, and it is only ever two questions:
 *
 *   1. What is the text, who wrote it, and when?
 *   2. WHICH ACCOUNT is it about?
 *
 * Question 2 is the whole difficulty. A Pipedrive note knows its own organisation. A Fathom
 * call and an email thread know only who was on them, so the account has to be recovered from
 * the domains of the people who are not us. That inference is the one place this module could
 * put a claim on the wrong agency's row, so it is deliberately timid:
 *
 *   · our own domains never count toward the answer;
 *   · a record with no outside domain is internal, and is not read at all;
 *   · a record with TWO different prospect domains on it is ambiguous, and is refused rather
 *     than guessed at — an introduction thread is not evidence about either party.
 *
 * PURE. No clock (`as_of` is an input), no network, no filesystem, no model call.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

import type { WrittenRecord } from "./written_record.ts";

/* ------------------------------------------------------------------ *
 * who is us, who is not
 * ------------------------------------------------------------------ */

/** Lower-cased domain of an email address, or null when it is not one. */
export function domainOf(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase().replace(/[>,;\s]+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/**
 * Domains on this record that are not ours and not a mailbox provider. The providers matter:
 * an agency owner writing from gmail.com would otherwise attach their note to every other
 * agency owner who does the same.
 */
export const PUBLIC_MAILBOXES: readonly string[] = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "gmx.com", "zoho.com", "mail.com",
];

export function externalDomains(emails: readonly unknown[], ourDomains: readonly string[]): string[] {
  const ours = new Set(ourDomains.map((d) => d.toLowerCase()));
  const out = new Set<string>();
  for (const e of emails) {
    const d = domainOf(e);
    if (d === null) continue;
    if (ours.has(d)) continue;
    if (PUBLIC_MAILBOXES.includes(d)) continue;
    out.add(d);
  }
  return [...out].sort();
}

export type Attribution =
  | { ok: true; account_id: string; domain: string }
  | { ok: false; why: "internal" | "ambiguous" | "not_in_book"; detail: string };

/**
 * The one account this record is about. Refuses rather than guesses — see the header.
 * `accountByDomain` maps a normalised domain to a pb_accounts.id.
 */
export function attribute(
  domains: readonly string[],
  accountByDomain: Record<string, string>,
): Attribution {
  if (domains.length === 0) return { ok: false, why: "internal", detail: "nobody outside WLIQ was on it" };
  const hits = domains.filter((d) => accountByDomain[d]);
  if (hits.length === 0) {
    return { ok: false, why: "not_in_book", detail: `${domains.join(", ")} — no account in the book` };
  }
  const ids = new Set(hits.map((d) => accountByDomain[d]));
  if (ids.size > 1) {
    return { ok: false, why: "ambiguous", detail: `${hits.join(" and ")} are different accounts; refusing to pick one` };
  }
  return { ok: true, account_id: accountByDomain[hits[0]], domain: hits[0] };
}

/* ------------------------------------------------------------------ *
 * Fathom
 * ------------------------------------------------------------------ */

export interface FathomMeeting {
  id: number | string;
  title?: string | null;
  url?: string | null;
  /** ISO. Fathom calls it recording_started_at / created_at depending on the endpoint. */
  started_at?: string | null;
  created_at?: string | null;
  /** The AI summary. The transcript is NOT read: it is speech, not a written record. */
  summary?: string | null;
  recorded_by?: string | null;
  /** Email addresses of everyone on the call. */
  attendee_emails?: readonly unknown[];
}

/**
 * A call summary is a written record: someone (Fathom) wrote down what was said, on a date,
 * about the people who were there.
 *
 * NOTE: the nightly sweep does not use this. pb_calls already holds each recording's summary
 * WITH its account resolved, put there by the Fathom webhook, so the sweep reads the book
 * rather than Fathom. This adapter is for a backfill that goes to Fathom's own API for calls
 * that predate the webhook — the one path that still has to attribute by attendee domain.
 *
 * The TRANSCRIPT is deliberately not read. A transcript is speech — half-finished sentences,
 * people talking over each other, a prospect thinking aloud. Quoting it verbatim would put
 * "yeah, I mean, we don't really have anybody" in the book as evidence. The summary is already
 * a considered written statement, which is what the quote rule assumes it is checking.
 */
export function fathomToRecord(m: FathomMeeting, ourDomains: readonly string[]): {
  record: WrittenRecord;
  domains: string[];
} {
  const when = String(m.started_at ?? m.created_at ?? "");
  const date = when.slice(0, 10);
  return {
    record: {
      id: m.id,
      org_id: null,
      content: String(m.summary ?? ""),
      add_time: when,
      update_time: when,
      user_name: m.recorded_by ?? null,
      source: "fathom_call",
      url: m.url ?? null,
      label: `Fathom call${m.title ? ` "${m.title}"` : ""}${date ? ` on ${date}` : ""}`,
    },
    domains: externalDomains(m.attendee_emails ?? [], ourDomains),
  };
}

/* ------------------------------------------------------------------ *
 * Gmail
 * ------------------------------------------------------------------ */

export interface GmailMessage {
  id: string;
  threadId?: string;
  subject?: string | null;
  sender?: string | null;
  toRecipients?: readonly unknown[];
  ccRecipients?: readonly unknown[];
  /** ISO. */
  date?: string | null;
  /** The body when we have it; the snippet otherwise. */
  body?: string | null;
  snippet?: string | null;
}

/**
 * Calendar traffic and scheduling robots. They carry a prospect's domain and say nothing about
 * the agency, so reading them would cost a model call per invitation for no fact at all.
 */
const CHATTER_SUBJECT = /^\s*(re:\s*)?(invitation|accepted|declined|tentative|reminder|new event|canceled|cancelled|updated invitation|invitation with note):/i;
const CHATTER_SENDER = /^(notifications?|no-?reply|donotreply|calendar|mailer-daemon|postmaster)@/i;

export function isChatter(m: GmailMessage): boolean {
  const subject = String(m.subject ?? "");
  const sender = String(m.sender ?? "");
  if (CHATTER_SUBJECT.test(subject)) return true;
  const local = sender.slice(0, sender.lastIndexOf("@") + 1);
  return CHATTER_SENDER.test(local);
}

/**
 * One record per MESSAGE, not per thread. A thread spans months; collapsing it would date every
 * sentence in it by the last reply and break rule 4. A message has one author and one date, and
 * that is what a fact drawn from it should carry.
 */
export function gmailToRecord(m: GmailMessage, ourDomains: readonly string[]): {
  record: WrittenRecord;
  domains: string[];
} {
  const when = String(m.date ?? "");
  const text = String(m.body ?? m.snippet ?? "");
  const subject = m.subject ? String(m.subject) : "";
  return {
    record: {
      id: m.id,
      org_id: null,
      // The subject is part of what was written and often carries the substance.
      content: subject ? `${subject}\n\n${text}` : text,
      add_time: when,
      update_time: when,
      user_name: m.sender ?? null,
      source: "email",
      url: m.threadId ? `https://mail.google.com/mail/u/0/#all/${m.threadId}` : null,
      label: `Email${subject ? ` "${subject}"` : ""}${when ? ` on ${when.slice(0, 10)}` : ""}`,
    },
    domains: externalDomains([m.sender, ...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])], ourDomains),
  };
}

/* ------------------------------------------------------------------ *
 * one pass over a channel
 * ------------------------------------------------------------------ */

export interface AttributedRecord {
  record: WrittenRecord;
  account_id: string;
  /** Which domain earned the attribution — the audit trail for the inference. */
  domain: string;
}

export interface AttributeAllResult {
  attributed: AttributedRecord[];
  notes: string[];
  counters: Record<string, number>;
}

/**
 * Attribute a channel's records to accounts, keeping only the ones that land on exactly one.
 * Everything refused is counted and explained: a sweep that silently drops half its input is
 * indistinguishable from one that works.
 */
export function attributeAll(
  items: readonly { record: WrittenRecord; domains: string[] }[],
  accountByDomain: Record<string, string>,
): AttributeAllResult {
  const attributed: AttributedRecord[] = [];
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const bump = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };

  for (const item of items) {
    const a = attribute(item.domains, accountByDomain);
    if (a.ok) {
      attributed.push({ record: item.record, account_id: a.account_id, domain: a.domain });
      bump("attributed");
      continue;
    }
    bump(`skipped_${a.why}`);
    // "internal" is the common case and not worth a line each; the others are worth knowing.
    if (a.why !== "internal") notes.push(`${item.record.label ?? item.record.id}: ${a.detail}.`);
  }
  return { attributed, notes, counters };
}
