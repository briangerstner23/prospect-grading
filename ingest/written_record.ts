/**
 * WLIQ Prospect Book — a written record → facts and fact candidates.
 *
 * Sales writes the best data in the business into prose, never into a field: structured
 * screening summaries ("Classified GENUINE, ICP-5 … HIGH white-label signal") in Pipedrive
 * notes, what was actually said in a Fathom call summary, what a client asked for in an email
 * thread. The seed read none of it. This module reads all of it.
 *
 * It is deliberately SOURCE-AGNOSTIC. A Pipedrive note, a Fathom summary and a Missive thread
 * are the same thing to the book: something a person wrote, on a date, about an account, that
 * a reader can be sent back to. Whoever pulls them says what `source` they carry and how a
 * reader returns to the original; everything downstream — the rules below, the review queue,
 * the audit trail — is identical for all of them. A new channel is a puller, not a rewrite.
 *
 * PURE. No clock (`as_of` is an input), no network, no filesystem, no model call. The reading of
 * free text into structured claims happens OUTSIDE this module and arrives as `extractions`;
 * this module decides only what may become a FACT, what must wait for a PERSON, and what is a
 * CONFLICT. That split is what makes the judgement reviewable and this module testable.
 *
 * The rules it enforces, in order of how much accuracy each one buys:
 *
 *   1. No quote, no fact. A claim without the verbatim sentence it came from can never write
 *      itself into pb_facts — it becomes a candidate a person reads the source for.
 *   2. A machine never overrules a person. An existing `evidence`-labelled fact entered by a
 *      human stands; a note-derived claim that disagrees becomes a candidate, never a write.
 *   3. A verified quote proves provenance, not truth. A sentence really in the note may still
 *      be somebody's opinion ("Strong ICP fit", "he seemed very experienced"). A claim whose
 *      supporting sentence is a JUDGEMENT rather than an OBSERVATION never writes itself; it
 *      goes to a person, who can tell the difference in about two seconds.
 *   4. Dates come from the SOURCE. A note written in 2025 is observed in 2025, so decay and
 *      recency see it for what it is. Never the extraction date.
 *   5. Disagreement is surfaced, not settled. When a claim contradicts what the book holds,
 *      both values travel on the candidate so a reviewer sees the conflict without leaving it.
 *   6. Re-running is free. Every emission carries a fingerprint over
 *      (source id · source updated_at · extractor version · key), so the same text extracted by
 *      the same extractor never queues or writes twice.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

import type { EvidenceLabel } from "../core/prospect_types.ts";

/* ------------------------------------------------------------------ *
 * inputs
 * ------------------------------------------------------------------ */

/**
 * Something a person wrote about an account: a CRM note, a call summary, an email thread.
 * `content` may be HTML — stripHtml runs before anything reads it.
 */
export interface WrittenRecord {
  id: number | string;
  /** The source system's own id for what this is attached to, when it has one. */
  org_id: number | string | null;
  content: string;
  /** When it was written. A fact's observed_at comes from here, never from the run. */
  add_time: string;
  update_time?: string | null;
  /** Display name of whoever wrote it, when known — travels into the fact's note. */
  user_name?: string | null;
  /**
   * What kind of record this is: `pipedrive_note`, `fathom_call`, `missive_thread`. It becomes
   * pb_facts.source — what the book says when asked where a fact came from.
   */
  source?: string;
  /** Where a reader goes to see the original. Overrides the Pipedrive default below. */
  url?: string | null;
  /** What a fact calls it: "Pipedrive note 3873", "Fathom call 2026-06-04". */
  label?: string | null;
  /**
   * The account this is about, when the puller already worked it out. A Pipedrive note knows
   * its organisation; a call or an email knows only who was on it, so record_sources.ts
   * attributes those by domain and sets this. When it is set nothing re-derives it.
   */
  account_id?: string;
}

/** What this type was called before the module served more than one system. */
export type PipedriveNote = WrittenRecord;

/** One thing an extractor claims a note says. The quote is what makes it checkable. */
export interface ExtractedClaim {
  /** A ProspectFeatures key — also the pb_facts.key. */
  key: string;
  value: unknown;
  /**
   * The VERBATIM sentence from the note that supports the claim. Null means the extractor
   * inferred it rather than read it; such a claim can never become a fact on its own.
   */
  quote: string | null;
  confidence: "high" | "medium" | "low";
  /**
   * Is the supporting sentence an OBSERVATION — something about the world a reader could check
   * — or a JUDGEMENT, someone's assessment of it?
   *
   * "They work with one or two freelancers for web projects" is an observation.
   * "Classified Genuine / Strong ICP fit" is a judgement: really written, really in the note,
   * and still just an opinion. Verifying the quote proves PROVENANCE, not TRUTH, so a
   * judgement-backed claim never becomes a fact on its own however confident the reader was.
   *
   * Absent is treated as a judgement — the cautious reading.
   */
  kind?: "observation" | "judgement";
}

/** What an extractor read out of one note. */
export interface NoteExtraction {
  note_id: number | string;
  claims: ExtractedClaim[];
}

/** A fact the book already holds for this account, so we can defer to it and spot conflicts. */
export interface ExistingFact {
  key: string;
  value: unknown;
  evidence_label: EvidenceLabel;
  source: string;
  /** ISO date. */
  observed_at: string | null;
  /** Who entered it. A human entry outranks any extraction. */
  entered_by?: string | null;
}

export interface MapNotesInput {
  account_id: string;
  /** Every record for this account that the run read. */
  notes: WrittenRecord[];
  extractions: NoteExtraction[];
  existing: ExistingFact[];
  /** Versioned extractor identity, e.g. "notes@v1". Part of every fingerprint. */
  extractor: string;
  /** ISO date. Nothing is emitted with an observed_at after it. */
  as_of: string;
  /** Sources whose facts a note may overwrite. Anything else defers. Default: machine sources. */
  may_supersede?: readonly string[];
}

/* ------------------------------------------------------------------ *
 * outputs
 * ------------------------------------------------------------------ */

export interface NoteFact {
  account_id: string;
  key: string;
  value: unknown;
  evidence_label: EvidenceLabel;
  /** Which written record it came from: pipedrive_note, fathom_call, missive_thread. */
  source: string;
  source_id: string;
  evidence_url: string | null;
  /** The verbatim sentence, plus who wrote it and when. This is the audit trail. */
  note: string;
  /** ISO date — the NOTE's date. */
  observed_at: string;
  fingerprint: string;
}

export interface FactCandidate {
  account_id: string;
  key: string;
  value: unknown;
  evidence_label: EvidenceLabel;
  source: string;
  source_id: string;
  evidence_url: string | null;
  quote: string | null;
  observed_at: string;
  confidence: "high" | "medium" | "low";
  extractor: string;
  fingerprint: string;
  /** What the book holds today, when it holds something different. */
  current_value: unknown;
  conflicts: boolean;
  /** Why this is waiting for a person rather than written. */
  note: string;
}

export interface MapNotesResult {
  facts: NoteFact[];
  candidates: FactCandidate[];
  /** Everything skipped, deferred or coerced, in plain words. */
  notes: string[];
  counters: Record<string, number>;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/** Machine sources a note may overwrite. A human entry is never in this list. */
const DEFAULT_SUPERSEDABLE: readonly string[] = ["apollo", "notion_master", "pipedrive"];

/**
 * FNV-1a, 32-bit, hex — the same shape the engine uses for its rubric fingerprint. Not
 * cryptographic; it only has to be stable and collision-shy across a few thousand notes.
 */
export function noteFingerprint(parts: readonly string[]): string {
  const s = parts.join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Pipedrive note content is HTML. Facts carry the readable sentence, never the markup. */
export function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ISO date (YYYY-MM-DD) from a Pipedrive timestamp; null when it is not a date. */
export function isoDate(ts: unknown): string | null {
  if (typeof ts !== "string" || ts.trim() === "") return null;
  const ms = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** Deep-ish equality for fact values — jsonb round-trips, so compare canonically. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

function bump(c: Record<string, number>, k: string): void {
  c[k] = (c[k] ?? 0) + 1;
}

/** The source a puller did not name — the first channel the book ever read. */
export const DEFAULT_SOURCE = "pipedrive_note";

/** Where a reader goes to see the original. A puller may supply its own; this is the fallback. */
export function noteUrl(note: WrittenRecord): string | null {
  if (note.url !== undefined) return note.url;
  return note.org_id == null ? null : `https://app.pipedrive.com/organization/${note.org_id}#note-${note.id}`;
}

/** How a fact names its own origin, before the author and the date are appended. */
export function recordLabel(note: WrittenRecord): string {
  if (note.label) return note.label;
  const source = note.source ?? DEFAULT_SOURCE;
  return source === "pipedrive_note" ? `Pipedrive note ${note.id}` : `${source.replace(/_/g, " ")} ${note.id}`;
}

/* ------------------------------------------------------------------ *
 * the mapper
 * ------------------------------------------------------------------ */

export function mapPipedriveNotes(input: MapNotesInput): MapNotesResult {
  const facts: NoteFact[] = [];
  const candidates: FactCandidate[] = [];
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const supersedable = input.may_supersede ?? DEFAULT_SUPERSEDABLE;

  const byId = new Map<string, WrittenRecord>();
  for (const n of input.notes) byId.set(String(n.id), n);

  // Latest fact per key wins as "what the book holds today".
  const held = new Map<string, ExistingFact>();
  for (const f of input.existing) {
    const prev = held.get(f.key);
    if (!prev || (f.observed_at ?? "") >= (prev.observed_at ?? "")) held.set(f.key, f);
  }

  const seen = new Set<string>();

  for (const ex of input.extractions) {
    const note = byId.get(String(ex.note_id));
    if (!note) {
      notes.push(`Extraction references note ${ex.note_id}, which is not in the note set; skipped.`);
      bump(counters, "extractions_without_a_note");
      continue;
    }
    const observed = isoDate(note.add_time);
    if (observed === null) {
      notes.push(`Note ${note.id}: add_time '${note.add_time}' is not a date; nothing from it can be dated, so it is skipped.`);
      bump(counters, "notes_without_a_date");
      continue;
    }
    if (observed > input.as_of) {
      notes.push(`Note ${note.id} is dated ${observed}, after as_of ${input.as_of}; skipped.`);
      bump(counters, "notes_after_as_of");
      continue;
    }

    const who = note.user_name ? ` by ${note.user_name}` : "";
    const url = noteUrl(note);
    const source = note.source ?? DEFAULT_SOURCE;
    const stamp = `${recordLabel(note)}${who}, ${observed}`;

    for (const claim of ex.claims) {
      if (!claim.key || claim.value === undefined) {
        bump(counters, "claims_malformed");
        continue;
      }
      const fp = noteFingerprint([
        String(note.id),
        String(note.update_time ?? note.add_time),
        input.extractor,
        claim.key,
      ]);
      if (seen.has(fp)) { bump(counters, "claims_duplicate_in_batch"); continue; }
      seen.add(fp);

      const current = held.get(claim.key);
      const conflicts = current !== undefined && !sameValue(current.value, claim.value);
      const quote = claim.quote && claim.quote.trim() ? stripHtml(claim.quote).trim() : null;

      /* rule 2 — a machine never overrules a person, or a fresher human record. */
      const humanHeld = current !== undefined &&
        current.evidence_label === "evidence" &&
        !supersedable.includes(current.source);
      if (humanHeld && conflicts) {
        candidates.push(candidate(input.account_id, claim, note, observed, fp, url, quote, input.extractor, current.value, true,
          `A person already recorded ${claim.key} from ${current.source}; a note never overrules that. ${stamp}.`));
        notes.push(`${claim.key}: held by ${current.source} (evidence) and the note disagrees — queued for review, not written.`);
        bump(counters, "deferred_to_human");
        continue;
      }

      /* Already on record from this same source, saying the same thing: nothing to add.
         Without this, re-reading a note under a new extractor version writes the fact twice. */
      if (current !== undefined && !conflicts && current.source === source) {
        bump(counters, "already_on_record");
        continue;
      }

      /* rule 1 — no quote, no fact. */
      if (!quote) {
        candidates.push(candidate(input.account_id, claim, note, observed, fp, url, null, input.extractor,
          current?.value ?? null, conflicts,
          `No supporting sentence in the note; a person reads the source before this becomes a fact. ${stamp}.`));
        bump(counters, "queued_no_quote");
        continue;
      }

      /* rule 3 — a verified quote proves provenance, not truth. */
      if (claim.kind !== "observation") {
        candidates.push(candidate(input.account_id, claim, note, observed, fp, url, quote, input.extractor,
          current?.value ?? null, conflicts,
          `The sentence behind this is someone's assessment, not something a reader could check. It is really in the note; that does not make it so. ${stamp}.`));
        bump(counters, "queued_judgement");
        continue;
      }

      if (claim.confidence !== "high") {
        candidates.push(candidate(input.account_id, claim, note, observed, fp, url, quote, input.extractor,
          current?.value ?? null, conflicts,
          `Confidence ${claim.confidence}; a person confirms before it becomes a fact. ${stamp}.`));
        bump(counters, "queued_low_confidence");
        continue;
      }

      /* quote-backed and high confidence: this is a fact, and it carries its own receipt. */
      facts.push({
        account_id: input.account_id,
        key: claim.key,
        value: claim.value,
        evidence_label: "evidence",
        source,
        source_id: String(note.id),
        evidence_url: url,
        note: `"${quote}" — ${stamp}`,
        observed_at: observed,
        fingerprint: fp,
      });
      bump(counters, "facts_written");
      if (conflicts) {
        notes.push(`${claim.key}: the note disagrees with ${current?.source ?? "the book"} — the note wins and the row is flagged.`);
        bump(counters, "conflicts_resolved_to_note");
      }
    }
  }

  return { facts, candidates, notes, counters };
}

function candidate(
  accountId: string,
  claim: ExtractedClaim,
  note: WrittenRecord,
  observed: string,
  fingerprint: string,
  url: string | null,
  quote: string | null,
  extractor: string,
  currentValue: unknown,
  conflicts: boolean,
  why: string,
): FactCandidate {
  return {
    account_id: accountId,
    key: claim.key,
    value: claim.value,
    evidence_label: "inferred",
    source: note.source ?? DEFAULT_SOURCE,
    source_id: String(note.id),
    evidence_url: url,
    quote,
    observed_at: observed,
    confidence: claim.confidence,
    extractor,
    fingerprint,
    current_value: currentValue,
    conflicts,
    note: why,
  };
}
