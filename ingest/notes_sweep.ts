/**
 * WLIQ Prospect Book — planning and validation for the nightly notes sweep.
 *
 * pb-notes pulls Pipedrive notes, asks a model to read each one into claims, and hands the
 * result to mapPipedriveNotes. This module is everything in that loop that must be provable:
 * which notes are worth a model call, and what a model is allowed to have said.
 *
 * PURE. No clock (`as_of` is an input), no network, no filesystem, no model call.
 *
 * The one rule that makes an automated sweep safe:
 *
 *   A QUOTE IS ONLY A QUOTE IF IT IS IN THE NOTE.
 *
 * Every claim arrives with a sentence the model says supports it. We check that sentence
 * against the note's own text. A quote that is not there was invented, and an invented quote
 * can never become a fact — verifyClaims strips it, which drops the claim to the review queue
 * by the no-quote rule in written_record.ts. Hallucinated evidence is therefore structurally
 * unable to reach pb_facts, without anyone having to trust the model.
 *
 * Everything else is a whitelist: only keys the book knows, only values those keys can hold,
 * a cap on claims per note. A model that returns something unexpected loses that claim and
 * says so in the notes; it never widens the contract.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

import { stripHtml } from "./written_record.ts";
import type { ExtractedClaim, NoteExtraction, PipedriveNote } from "./written_record.ts";

/* ------------------------------------------------------------------ *
 * what a model may claim
 * ------------------------------------------------------------------ */

type Shape =
  | { kind: "boolean" }
  | { kind: "integer"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] };

/**
 * The only keys the sweep may write, and the only values each may take. A ProspectFeatures
 * key that is not here is not extractable from prose — it comes from a system of record.
 */
export const EXTRACTABLE: Readonly<Record<string, Shape>> = {
  is_agency: { kind: "boolean" },
  sells_build_work: { kind: "boolean" },
  no_inhouse_dev_team: { kind: "boolean" },
  recurring_work_shape: { kind: "boolean" },
  competitive_overlap: { kind: "boolean" },
  client_budget_size: { kind: "enum", values: ["buys_real_projects", "local_small"] },
  relationship_type: { kind: "enum", values: ["agency", "direct", "reseller", "referral"] },
  headcount: { kind: "integer", min: 1, max: 5000 },
  client_evidence_count: { kind: "integer", min: 0, max: 100000 },
};

const CONFIDENCES: readonly string[] = ["high", "medium", "low"];

/** No note yields this many honest claims; past it something has gone wrong. */
export const MAX_CLAIMS_PER_NOTE = 24;

/** Below this there is no prose to read, only a link or a one-liner. Not worth a model call. */
export const MIN_NOTE_CHARS = 120;

/* ------------------------------------------------------------------ *
 * which notes are worth reading
 * ------------------------------------------------------------------ */

export interface SweepPlanInput {
  notes: PipedriveNote[];
  /** pb_accounts.pipedrive_org_id → pb_accounts.id. A note whose org is unknown is skipped. */
  accountByOrg: Record<string, string>;
  /** pb_source_watermarks.last_seen_at. Notes not touched since are already read. */
  since: string | null;
  /** ISO date. A note dated after this is not read. */
  as_of: string;
  /** Fingerprints already in pb_fact_candidates / pb_facts, so a re-run costs no model calls. */
  seen?: readonly string[];
  /** Safety valve on one run's spend. */
  max_notes?: number;
}

export interface PlannedNote {
  note: PipedriveNote;
  account_id: string;
  /** The note with its markup taken off — what the model reads and what quotes are checked against. */
  text: string;
}

export interface SweepPlan {
  read: PlannedNote[];
  /** Every note left out, and why, in plain words. */
  notes: string[];
  counters: Record<string, number>;
  /** The watermark to store if this run completes: the newest update_time considered. */
  next_watermark: string | null;
}

function bump(c: Record<string, number>, k: string): void {
  c[k] = (c[k] ?? 0) + 1;
}

/** When the note last changed — what the watermark compares against. */
export function touchedAt(note: PipedriveNote): string {
  return String(note.update_time ?? note.add_time ?? "");
}

/**
 * Decide what this run reads. Notes are ordered oldest-touched first so that a run cut short
 * by `max_notes` still advances the watermark over a contiguous block — no note is skipped
 * forever because a busier one keeps jumping ahead of it.
 */
export function planSweep(input: SweepPlanInput): SweepPlan {
  const out: PlannedNote[] = [];
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const cap = input.max_notes ?? 250;
  let watermark: string | null = null;

  const ordered = [...input.notes].sort((a, b) => {
    const ta = touchedAt(a);
    const tb = touchedAt(b);
    return ta < tb ? -1 : ta > tb ? 1 : String(a.id) < String(b.id) ? -1 : 1;
  });

  for (const note of ordered) {
    const touched = touchedAt(note);
    if (touched === "") {
      notes.push(`Note ${note.id} has no add_time or update_time; skipped.`);
      bump(counters, "undated");
      continue;
    }
    if (input.since !== null && touched <= input.since) {
      bump(counters, "already_read");
      continue;
    }
    if (touched.slice(0, 10) > input.as_of) {
      notes.push(`Note ${note.id} is touched ${touched.slice(0, 10)}, after as_of ${input.as_of}; skipped.`);
      bump(counters, "after_as_of");
      continue;
    }

    // A puller that already knows the account (a call or an email, attributed by domain) says
    // so on the record; only a Pipedrive note is looked up by its organisation here.
    const orgKey = note.org_id == null ? "" : String(note.org_id);
    const account_id = note.account_id ?? input.accountByOrg[orgKey];
    if (!account_id) {
      notes.push(`Note ${note.id} belongs to org ${orgKey || "(none)"}, which is not an account in the book; skipped.`);
      bump(counters, "org_not_in_book");
      continue;
    }

    const text = stripHtml(note.content);
    if (text.length < MIN_NOTE_CHARS) {
      bump(counters, "too_short_to_read");
      continue;
    }

    if (out.length >= cap) {
      bump(counters, "over_run_cap");
      continue;
    }

    out.push({ note, account_id, text });
    // Only advance over notes this run actually read, so a capped run resumes cleanly.
    if (watermark === null || touched > watermark) watermark = touched;
  }

  if (counters.over_run_cap) {
    notes.push(`${counters.over_run_cap} note(s) left for the next run — this one is capped at ${cap}.`);
  }

  return { read: out, notes, counters, next_watermark: watermark };
}

/* ------------------------------------------------------------------ *
 * what a model is allowed to have said
 * ------------------------------------------------------------------ */

/** Whitespace and case folded away, so a quote still matches when the markup spaced it oddly. */
export function normalizeForQuote(s: string): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True only when the sentence really is in the note. This is the guarantee. */
export function quoteIsInNote(noteText: string, quote: string): boolean {
  const q = normalizeForQuote(quote);
  if (q.length < 12) return false; // too short to be evidence of anything
  return normalizeForQuote(noteText).includes(q);
}

/**
 * Sentences that are somebody's assessment rather than something a reader could check.
 *
 * The model is ASKED to mark each claim observation or judgement, and a model that wants to be
 * helpful will call an opinion an observation. So its answer is not the last word: if any of
 * these appears in the supporting sentence, the claim is a judgement whatever the model said.
 *
 * Every entry earns its place from real notes: screening summaries classify and rate
 * ("Classified GENUINE, ICP-5", "Strong ICP fit", "HIGH white-label signal"), and call
 * write-ups hedge ("he did seem incredibly knowledgeable", "I believe he came through a
 * website submission"). None of that is checkable; all of it reads as confident prose.
 *
 * A false positive costs one row in the review queue, a false negative puts an opinion in the
 * book as evidence. The list is tuned for the cheap mistake.
 */
export const JUDGEMENT_MARKERS: readonly string[] = [
  // hedged perception
  "seem", "seemed", "seems", "appear to", "appears to", "appeared to",
  "looks like", "looked like", "strikes me", "my sense", "my impression", "my understanding",
  "i think", "i believe", "i'd say", "i would say", "i suspect", "i assume", "i'm not sure",
  "probably", "presumably", "apparently", "i don't have full", "not exactly sure",
  // rating and classification
  "classified", "classification", "strong fit", "good fit", "poor fit", "weak fit",
  "strong icp", "weak icp", "ideal fit", "perfect fit", "great candidate", "priority a",
  "priority b", "high signal", "low signal", "moderate fit", "qualified as", "rated",
  "recommend", "recommended", "watch-item", "worth a look",
];

/** The marker that makes this sentence an assessment, or null when it reads as an observation. */
export function judgementMarker(sentence: string): string | null {
  const s = normalizeForQuote(sentence);
  for (const m of JUDGEMENT_MARKERS) if (s.includes(m)) return m;
  return null;
}

export interface VerifyResult {
  extraction: NoteExtraction;
  notes: string[];
  counters: Record<string, number>;
}

/**
 * Take what a model returned for one note and reduce it to claims the book will accept.
 *
 * Anything unrecognised is dropped, not coerced. A claim whose quote is not in the note keeps
 * its value but LOSES its quote — it becomes a review-queue item rather than a fact, which is
 * the honest outcome: the model may still be right, but nothing here proves it.
 */
export function verifyClaims(planned: PlannedNote, raw: unknown): VerifyResult {
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const claims: ExtractedClaim[] = [];
  const id = String(planned.note.id);

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { claims?: unknown }).claims)
    ? (raw as { claims: unknown[] }).claims
    : null;

  if (list === null) {
    notes.push(`Note ${id}: the extractor did not return a claims array; nothing taken from it.`);
    bump(counters, "unreadable_response");
    return { extraction: { note_id: planned.note.id, claims: [] }, notes, counters };
  }

  if (list.length > MAX_CLAIMS_PER_NOTE) {
    notes.push(`Note ${id}: ${list.length} claims returned, over the cap of ${MAX_CLAIMS_PER_NOTE}; nothing taken from it.`);
    bump(counters, "over_claim_cap");
    return { extraction: { note_id: planned.note.id, claims: [] }, notes, counters };
  }

  const keysSeen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== "object") { bump(counters, "malformed_claim"); continue; }
    const c = item as Record<string, unknown>;
    const key = typeof c.key === "string" ? c.key : "";
    const shape = EXTRACTABLE[key];
    if (!shape) {
      notes.push(`Note ${id}: '${key || "(no key)"}' is not an extractable key; dropped.`);
      bump(counters, "key_not_extractable");
      continue;
    }
    if (keysSeen.has(key)) {
      notes.push(`Note ${id}: ${key} claimed twice; only the first is kept.`);
      bump(counters, "duplicate_key");
      continue;
    }

    const value = coerce(shape, c.value);
    if (value === undefined) {
      notes.push(`Note ${id}: ${key} came back as ${describe(c.value)}, which it cannot hold; dropped.`);
      bump(counters, "value_out_of_shape");
      continue;
    }

    const confidence = typeof c.confidence === "string" && CONFIDENCES.includes(c.confidence)
      ? (c.confidence as ExtractedClaim["confidence"])
      : "low";
    if (confidence === "low" && c.confidence !== "low") {
      notes.push(`Note ${id}: ${key} had no usable confidence; treated as low.`);
      bump(counters, "confidence_missing");
    }

    const claimed = typeof c.quote === "string" ? c.quote.trim() : "";
    let quote: string | null = null;
    if (claimed === "") {
      bump(counters, "no_quote_offered");
    } else if (quoteIsInNote(planned.text, claimed)) {
      quote = claimed;
      bump(counters, "quote_verified");
    } else {
      notes.push(`Note ${id}: the sentence offered for ${key} is not in the note; the claim is kept for review but can never become a fact.`);
      bump(counters, "quote_not_in_note");
    }

    /* Observation or judgement. The model says which, and the lexicon overrules it — a model
       that wants to be useful will call an opinion an observation. Either vote for judgement
       is decisive; only a sentence both agree on is left as an observation. */
    let kind: "observation" | "judgement" = c.kind === "observation" ? "observation" : "judgement";
    if (c.kind !== "observation" && c.kind !== "judgement") {
      notes.push(`Note ${id}: ${key} did not say whether its sentence is an observation or a judgement; read as a judgement.`);
      bump(counters, "kind_missing");
    }
    if (kind === "observation" && quote !== null) {
      const marker = judgementMarker(quote);
      if (marker !== null) {
        kind = "judgement";
        notes.push(`Note ${id}: ${key} was offered as an observation, but its sentence says "${marker}" — that is an assessment, so a person confirms it.`);
        bump(counters, "judgement_caught_by_lexicon");
      }
    }
    bump(counters, kind === "observation" ? "observations" : "judgements");

    keysSeen.add(key);
    claims.push({ key, value, quote, confidence, kind });
  }

  return { extraction: { note_id: planned.note.id, claims }, notes, counters };
}

/** The value a key can hold, or undefined when the model returned something else. */
function coerce(shape: Shape, v: unknown): unknown {
  if (v === null) return undefined; // unknown is never evidence; say nothing instead
  if (shape.kind === "boolean") return typeof v === "boolean" ? v : undefined;
  if (shape.kind === "enum") return typeof v === "string" && shape.values.includes(v) ? v : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n >= shape.min && n <= shape.max ? n : undefined;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `'${v}'`;
  if (typeof v === "object") return Array.isArray(v) ? "an array" : "an object";
  return String(v);
}

/* ------------------------------------------------------------------ *
 * what the model is asked
 * ------------------------------------------------------------------ */

/**
 * The instruction the extractor runs under. Kept here, beside the validator, so the two can
 * never drift: what the prompt asks for is exactly what verifyClaims will accept.
 *
 * Change this and the extractor version changes too — every fingerprint carries the extractor
 * string, so a new prompt re-reads every note rather than silently mixing two readings.
 */
export const EXTRACTOR_VERSION = "notes@v2";

export function extractionPrompt(): string {
  const keys = Object.entries(EXTRACTABLE).map(([k, s]) => {
    const shape = s.kind === "boolean"
      ? "true or false"
      : s.kind === "enum"
      ? s.values.map((v) => `"${v}"`).join(" or ")
      : `a whole number ${s.min}-${s.max}`;
    return `  ${k}: ${shape}`;
  }).join("\n");

  return [
    "You are reading one CRM note about an agency and recording only what the note actually says.",
    "",
    "Return JSON: {\"claims\": [{\"key\", \"value\", \"quote\", \"confidence\", \"kind\"}]}. Return an empty list when the note says nothing about these.",
    "",
    "Keys and the values they may take:",
    keys,
    "",
    "Rules:",
    "- quote must be copied WORD FOR WORD from the note. It is checked against the note text; an invented or paraphrased quote makes the claim unusable.",
    "- If you cannot find a sentence that says it, leave the key out. Silence is correct; guessing is not.",
    "- confidence is high only when the sentence states the answer outright. A range, an implication or an inference is medium or low.",
    "- kind is \"observation\" when the sentence states something about the world a reader could check, and \"judgement\" when it is somebody's assessment of it.",
    "    observation: \"They work with one or two freelancers for web projects.\"",
    "    judgement:   \"Classified Genuine / Strong ICP fit.\" \u2014 really written, still an opinion.",
    "  Mark it honestly. A judgement is not wasted: it reaches a person either way. Calling one an observation only sends it back.",
    "- sells_build_work and no_inhouse_dev_team are about what the agency SELLS and whether it can BUILD it, not what industry it is in.",
    "- client_budget_size is about the agency's CLIENTS' budgets, not the agency's own size.",
    "- One claim per key at most.",
  ].join("\n");
}
