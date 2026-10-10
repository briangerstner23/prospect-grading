/**
 * WLIQ Prospect Book — what a sales meeting said about each agency, as proposals (DECISIONS §65).
 *
 * The owner ruled that what the team says in its sales meeting is judgement from its research,
 * worth more than any machine source once a person confirms it — and that a tier call or "take
 * them off" is still a PROPOSAL until the owner clicks. This module is the provable half of that:
 *
 *   · the two prompts (segmentPrompt for pass 1, claimsPrompt + claimsMessage for pass 2), with
 *     every key, tier and code PRINTED FROM DATA — keysFor('sales_meeting'), the active rubric's
 *     vocabulary.tiers and override.reason_codes, the active pb_removal_reasons rows — so nothing
 *     a prompt offers can drift from what the verifier accepts;
 *   · planBatches: four agencies to a call, each seeing ONLY its own excerpt;
 *   · verifyMeetingClaims: a claim survives only if its quote lies inside one speaker's lines that
 *     belong to THAT agency (a quote from another agency's lines is refused 'other_agency_lines' —
 *     the §60 wrong-company class), its key and value pass the notes sweep's own shape table, its
 *     tier is a listed tier the quote actually names, and it states a mode. Every claim is forced
 *     to kind 'judgement', so no lane, bulk rule or autoconfirm could ever take one;
 *   · reduceClaims: the last word per agency — one tier call, one removal, eight facts, three reads;
 *   · proposalRows: pb_meeting_proposals rows, with status, flags, the server's pre-tick
 *     (defaultSelected — a removal is NEVER pre-ticked), the prefilled written reason
 *     (defaultText) and a fingerprint (written_record.noteFingerprint) that makes a re-run free.
 *
 * Nothing here writes. A row is a proposal until pb_decide_meeting_card runs under a signed-in
 * person; nothing is ever parked in pb_fact_candidates.
 *
 * PURE. No clock (`as_of` is an input), no network, no filesystem, no model call. Imports only
 * ./notes_sweep.ts, ./written_record.ts and ./meeting_transcript.ts. Runs under Deno and
 * `node --experimental-strip-types`.
 */

import { coerceClaimValue, keyShapeLines, keysFor, normalizeForQuote, timeKey } from "./notes_sweep.ts";
import { noteFingerprint, sameValue } from "./written_record.ts";
import { excerptFor, MEETING_SOURCE, QUOTE_MAX_CHARS, QUOTE_MAX_LINES, QUOTE_MIN_CHARS, quoteInLines, renderLines } from "./meeting_transcript.ts";
import type { ExcerptLine, LineRange, TranscriptLine } from "./meeting_transcript.ts";

/* ------------------------------------------------------------------ *
 * vocabulary
 * ------------------------------------------------------------------ */

/** How a sentence was said. Required on every claim; a missing or unknown mode is "unclear". */
export const MODES = ["asserted", "reported", "plan", "hypothetical", "question", "joke", "unclear"] as const;
export type Mode = typeof MODES[number];

/** Said, not decided: stored as 'not_proposed', behind "Said, not decided (n)". */
export const UNDECIDED_MODES: readonly string[] = ["hypothetical", "question", "joke"];

/** The modes that state a position, so the LAST of them is the agency's final word. */
export const DECISIVE_MODES: readonly string[] = ["asserted", "reported", "plan"];

export const CLAIM_TYPES = ["fact", "tier_call", "removal", "read"] as const;
export type ClaimType = typeof CLAIM_TYPES[number];

/** A free-text sales read is one of these. Never health, family or personal life. */
export const READ_TOPICS: readonly string[] = ["price", "decision_maker", "relationship", "timing", "risk", "fit", "next_step"];

export const MAX_CLAIMS_PER_BATCH = 40;
export const BATCH_SIZE = 4;
export const MAX_FACTS_PER_AGENCY = 8;
export const MAX_READS_PER_AGENCY = 3;

/** A meeting held more than this many days before it is read arrives unticked, as 'historic'. */
export const HISTORIC_DAYS = 21;

/**
 * The override reason code a tier call carries when the model named none of the rubric's own
 * (owner question, 10 Oct 2026: "the team knows something the engine's inputs do not"). Used
 * only when the active rubric's spec.override.reason_codes lists it.
 */
export const DEFAULT_OVERRIDE_CODE = "relationship_known";

/** Rule 9's person sources: a value one of these holds as evidence is never silently overruled. */
export const PERSON_SOURCES: readonly string[] = ["rater", MEETING_SOURCE];

/** A pb_removal_reasons row. */
export interface RemovalReason {
  disposition: string;
  code: string;
  label?: string | null;
  allows_review_date?: boolean | null;
  active?: boolean | null;
}

/** Plain-words guidance per disposition. The CODES are never written here — they are data. */
const DISPOSITION_GUIDE: Readonly<Record<string, string>> = {
  do_not_contact: "only for: they asked us to stop, a client or partner conflict, a spent relationship, legal",
  unqualified: "for: not an agency, out of business, too small, no build work, competitor, duplicate",
};

function activeReasons(reasons: readonly RemovalReason[] | null | undefined): RemovalReason[] {
  return (reasons ?? []).filter((r) => r && r.active !== false && r.disposition && r.code);
}

function dispositionsOf(reasons: readonly RemovalReason[]): string[] {
  const out: string[] = [];
  for (const r of reasons) if (!out.includes(r.disposition)) out.push(r.disposition);
  return out;
}

/* ------------------------------------------------------------------ *
 * the prompts
 * ------------------------------------------------------------------ */

/** Pass 1: which outside companies were discussed, in the words as transcribed, and on which lines. */
export function segmentPrompt(): string {
  return [
    "You are reading an INTERNAL White Label IQ sales meeting; every speaker works at WLIQ. List each OUTSIDE company discussed, with the words exactly as transcribed (nicknames included) and the line ranges where it is discussed. Exclude White Label IQ itself, software and platforms, people, and companies named only as an example. If unsure whether a word is a company, include it with kind \"unclear\"; a person checks.",
    "",
    "The transcript arrives as numbered lines: \"L0412 [00:31:07] S2: text\". Cite a line by its number (412), never by its timestamp.",
    "",
    "Return JSON only: {\"companies\": [{\"ref\", \"as_said\", \"kind\", \"segments\", \"mention_lines\"}]}. At most 60 companies; an empty list when no outside company is discussed.",
    "- ref: your own label for the company, \"C1\", \"C2\" and so on, unique in this reply.",
    "- as_said: up to 5 spellings EXACTLY as the transcript writes them, misspellings and nicknames included (\"the <name> guys\"). Each one must appear on one of its mention_lines.",
    "- kind: one of \"agency\", \"agency_client\", \"vendor\", \"tool\", \"wliq\", \"person\", \"unclear\". An agency is a company WLIQ sells to or might; an agency_client is one of an agency's own customers.",
    "- segments: up to 12 {\"from\", \"to\"} line ranges where THIS company is the subject. A range starts where the discussion of it starts and ends where the talk moves on. A company discussed twice gets one entry with two segments.",
    "- mention_lines: up to 20 line numbers where the company is named.",
    "- Do not summarise, judge or extract anything else.",
  ].join("\n");
}

export interface ClaimsPromptInput {
  /** The active rubric's vocabulary.tiers, lowest first. */
  tiers: readonly string[];
  /** The active rubric's spec.override.reason_codes. */
  overrideCodes: readonly string[];
  /** The pb_removal_reasons rows; inactive ones are left out. */
  removalReasons: readonly RemovalReason[];
}

/**
 * Pass 2: what the team said or decided about each agency. Every key comes from
 * keyShapeLines('sales_meeting'), every tier and code from the inputs — the module holds none.
 */
export function claimsPrompt(input: ClaimsPromptInput): string {
  const tiers = [...(input.tiers ?? [])];
  const codes = [...(input.overrideCodes ?? [])];
  const reasons = activeReasons(input.removalReasons);
  const top = tiers[tiers.length - 1] ?? "top-tier";
  const idiom = tiers.length >= 2 ? tiers[tiers.length - 2] : top;
  const dispositions = dispositionsOf(reasons);

  const removalLines = dispositions.map((d) => {
    const list = reasons.filter((r) => r.disposition === d).map((r) => r.code);
    return `  ${d}: ${list.map((c) => `"${c}"`).join(", ")}`;
  });
  const guide = dispositions.map((d) => {
    const g = DISPOSITION_GUIDE[d];
    const hasOther = reasons.some((r) => r.disposition === d && r.code === "other");
    return `  ${d} is ${g ?? "as its codes say"}. Its code comes from its own list above${hasOther ? ", else \"other\"" : ""}.`;
  });

  return [
    "You are reading excerpts of an INTERNAL White Label IQ sales meeting. Every speaker works at WLIQ. Each <agency ref=\"...\"> block holds only the lines where the team discussed ONE outside agency; lines marked (context) are padding around it.",
    "",
    "Record only what the TEAM SAID OR DECIDED about THIS agency. If a sentence could be about another company nearby, leave it out.",
    "",
    "Return JSON only: {\"claims\": [{\"ref\", \"type\", \"key\", \"value\", \"tier\", \"disposition\", \"code\", \"topic\", \"quote\", \"line_from\", \"line_to\", \"mode\", \"confidence\"}]}. At most " + MAX_CLAIMS_PER_BATCH + " claims. Silence is correct: an empty list is the right answer when nothing was said or decided.",
    "",
    "type is one of:",
    "- \"fact\": one of the keys below, with a value it may take.",
    "- \"tier_call\": the team naming a listed tier as what the agency is or should be. Give it in \"tier\", and a reason code in \"code\" when one fits.",
    "- \"removal\": the team deciding to stop pursuing them. Give \"disposition\" and \"code\".",
    "- \"read\": a short business read worth keeping, with \"topic\" one of " + READ_TOPICS.map((t) => `"${t}"`).join(", ") + ".",
    "",
    "Keys and the values they may take:",
    ...keyShapeLines(MEETING_SOURCE),
    "",
    `Tiers, lowest first: ${tiers.map((t) => `"${t}"`).join(", ")}`,
    `Reason codes for a tier_call: ${codes.map((c) => `"${c}"`).join(", ")}`,
    "Removal dispositions and their codes:",
    ...removalLines,
    "",
    "Rules:",
    "- quote is copied WORD FOR WORD from ONE speaker's consecutive lines inside that agency's own block — never a (context) line — at most " + QUOTE_MAX_LINES + " lines, cited by line_from and line_to. It is checked against the transcript; an invented, paraphrased or stitched quote drops the claim.",
    `- A tier_call names the tier in its quote. "Not a ${top}" alone, a partner badge, or an idiom such as "${idiom} standard" is not a tier call. A question is not a call, but its answer is.`,
    "- A removal is a decision to stop pursuing them, not frustration with them.",
    ...guide,
    "- money, authority and specification are \"absent\" only when said to be absent. Not mentioned is not absent: leave the key out.",
    "- Reads: at most " + MAX_READS_PER_AGENCY + " per agency, business-relevant only. Never health, family or personal life.",
    "- If they change their minds, report only the final position.",
    "- mode is required: \"asserted\" (stated as so), \"reported\" (someone tells what the agency said), \"plan\" (what we will do), \"hypothetical\", \"question\", \"joke\" or \"unclear\".",
    "- Never record claims about WLIQ, its staff, an agency's own end clients, or what WLIQ plans for itself.",
    "- confidence is \"high\" only when the words state it outright; otherwise \"medium\" or \"low\".",
    "- One fact per key per agency.",
  ].join("\n");
}

/** One agency in a pass-2 call. */
export interface BatchItem {
  ref: string;
  said_key: string;
  said_as: string[];
  state: string;
  account_id: string | null;
  /** The lines inside the agency's segments: where its quotes must lie. */
  owned: number[];
  /** What the model is shown: the owned lines plus context padding, capped. */
  excerpt: ExcerptLine[];
  capped: boolean;
}

export interface Batch {
  index: number;
  items: BatchItem[];
}

/** The user message of one pass-2 call: one <agency ref> block per agency, holding only its excerpt. */
export function claimsMessage(batch: Batch): string {
  const blocks = (batch?.items ?? []).map((it) => {
    const said = it.said_as.map((s) => s.replace(/"/g, "'")).join("; ");
    return [`<agency ref="${it.ref}" said_as="${said}">`, renderLines(it.excerpt), "</agency>"].join("\n");
  });
  return [
    `${blocks.length} agency block(s). Quote only from a block's own lines, never from a (context) line.`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * batches
 * ------------------------------------------------------------------ */

/** What planBatches needs of a meeting_mentions.MentionCluster. */
export interface ClusterForBatch {
  ref: string;
  state: string;
  said_key: string;
  said_as: readonly string[];
  account_id: string | null;
  segments: readonly LineRange[];
}

/** Pass 2 reads these; unknown and refused clusters are never read. */
export const READ_STATES: readonly string[] = ["resolved", "suggested", "ambiguous"];

export interface BatchPlan {
  batches: Batch[];
  /** Line number → every ref whose segments hold it, over every cluster that is not refused. */
  owners: Record<number, string[]>;
  /** Clusters not read, and why. */
  skipped: Array<{ ref: string; state: string }>;
}

/**
 * Group the readable clusters BATCH_SIZE to a call, in discussion order, each with its own
 * excerpt. `done` refs (pb_meetings.progress.done_refs) are left out, so a run that resumes
 * re-reads nothing. Ownership is computed over EVERY non-refused cluster — an outside company
 * that is not in the book still owns the lines it was discussed on.
 */
export function planBatches(
  clusters: readonly ClusterForBatch[],
  lines: readonly TranscriptLine[],
  opts: { size?: number; pad?: number; max_chars?: number; done?: readonly string[] } = {},
): BatchPlan {
  const size = Math.max(1, Math.min(BATCH_SIZE, opts.size ?? BATCH_SIZE));
  const known = new Set((lines ?? []).map((l) => l.n));
  const owners: Record<number, string[]> = {};
  for (const c of clusters ?? []) {
    if (c.state === "refused") continue;
    for (const s of c.segments ?? []) {
      for (let n = s.from; n <= s.to; n++) {
        if (!known.has(n)) continue;
        const list = owners[n] ?? (owners[n] = []);
        if (!list.includes(c.ref)) list.push(c.ref);
      }
    }
  }

  const skipped: Array<{ ref: string; state: string }> = [];
  const items: BatchItem[] = [];
  for (const c of clusters ?? []) {
    if (!READ_STATES.includes(c.state)) { skipped.push({ ref: c.ref, state: c.state }); continue; }
    if ((opts.done ?? []).includes(c.ref)) continue;
    const ex = excerptFor(lines, c.segments, { pad: opts.pad, max_chars: opts.max_chars });
    items.push({
      ref: c.ref,
      said_key: c.said_key,
      said_as: [...c.said_as],
      state: c.state,
      account_id: c.account_id,
      owned: ex.owned,
      excerpt: ex.lines,
      capped: ex.capped,
    });
  }
  const batches: Batch[] = [];
  for (let i = 0; i < items.length; i += size) batches.push({ index: batches.length, items: items.slice(i, i + size) });
  return { batches, owners, skipped };
}

/* ------------------------------------------------------------------ *
 * verification
 * ------------------------------------------------------------------ */

/**
 * Words that mark a sentence as not-a-decision. Under §54b's posture the lexicon FLAGS and never
 * overrules: the mode the model gave stands, the flag unticks the row.
 */
export function hedgeFlags(quote: string): string[] {
  const q = normalizeForQuote(quote);
  const flags: string[] = [];
  if (/\?["')\]]*$/.test(q)) flags.push("question");
  if (/\bwhat if\b|\bif they\b|\bsuppose\b|\bimagine\b|\bhypothetically\b/.test(q)) flags.push("hypothetical");
  if (/\bkidding\b|\bjoking\b|\[laughter\]|\bhaha\b/.test(q)) flags.push("joke");
  return flags;
}

export interface VerifiedClaim {
  ref: string;
  type: ClaimType;
  key: string | null;
  value: unknown;
  /** The tier as the rubric spells it. */
  tier: string | null;
  disposition: string | null;
  /** A removal code (active pair only) or an override reason code (the rubric's only). */
  code: string | null;
  topic: string | null;
  quote: string;
  line_from: number;
  line_to: number;
  /** From OUR line, never the model. */
  quote_at: string;
  speaker: string;
  mode: Mode;
  confidence: "high" | "medium" | "low";
  /** Always 'judgement' (§65): no lane, bulk rule or autoconfirm can ever take one. */
  kind: "judgement";
  flags: string[];
  /** Position in the model's reply, for a stable "last word". */
  order: number;
}

export interface MeetingVerifyContext {
  /** The whole numbered transcript. */
  lines: readonly TranscriptLine[];
  batch: Batch;
  /** planBatches().owners. */
  owners: Readonly<Record<number, readonly string[]>>;
  tiers: readonly string[];
  overrideCodes: readonly string[];
  removalReasons: readonly RemovalReason[];
}

export interface MeetingVerifyResult {
  claims: VerifiedClaim[];
  counters: Record<string, number>;
  notes: string[];
}

function bump(c: Record<string, number>, k: string, by = 1): void {
  c[k] = (c[k] ?? 0) + by;
}

const NEGATIONS = new Set(["not", "never", "no", "isn't", "aren't", "wasn't", "won't", "don't", "doesn't", "didn't", "nor", "hardly", "isnt", "arent", "wasnt", "dont", "doesnt", "didnt"]);

/** The tier is NAMED in the quote: as a whole word, not negated in the five words before it, not "<tier> standard". */
export function tierNamed(quote: string, tier: string): boolean {
  const words = normalizeForQuote(quote).replace(/[^a-z0-9' ]+/g, " ").split(" ").filter(Boolean);
  const t = tier.toLowerCase();
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== t) continue;
    if (words[i + 1] === "standard") continue;
    const before = words.slice(Math.max(0, i - 5), i);
    if (before.some((w) => NEGATIONS.has(w) || w.endsWith("n't"))) continue;
    return true;
  }
  return false;
}

/**
 * One pass-2 reply → the claims the transcript and the book will carry. Dropped, each counted:
 * an unknown ref or type; a quote not in one speaker's ≤6 consecutive lines of OUR transcript;
 * a quote on lines another agency owns ('other_agency_lines') or outside this agency's segments;
 * a fact key outside keysFor('sales_meeting') or a value out of shape; a tier not listed or not
 * named in its quote. Kept with a flag: a line two agencies share ('shared_segment'), and the
 * hedge words. An inactive disposition/code pair keeps the removal with code null, for the owner.
 */
export function verifyMeetingClaims(raw: unknown, ctx: MeetingVerifyContext): MeetingVerifyResult {
  const counters: Record<string, number> = {};
  const notes: string[] = [];
  const claims: VerifiedClaim[] = [];
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { claims?: unknown }).claims)
    ? (raw as { claims: unknown[] }).claims
    : null;
  if (list === null) {
    bump(counters, "unreadable_response");
    notes.push(`batch ${ctx.batch?.index ?? "?"}: the reply carried no claims array; nothing taken from it.`);
    return { claims, counters, notes };
  }
  if (list.length > MAX_CLAIMS_PER_BATCH) {
    bump(counters, "over_claim_cap", list.length - MAX_CLAIMS_PER_BATCH);
    notes.push(`batch ${ctx.batch.index}: ${list.length} claims returned; only the first ${MAX_CLAIMS_PER_BATCH} are read.`);
  }

  const items = new Map<string, BatchItem>();
  for (const it of ctx.batch?.items ?? []) items.set(it.ref, it);
  const allowed = keysFor(MEETING_SOURCE);
  const tiers = ctx.tiers ?? [];
  const reasons = activeReasons(ctx.removalReasons);
  const dispositions = dispositionsOf(reasons);

  list.slice(0, MAX_CLAIMS_PER_BATCH).forEach((item, order) => {
    if (!item || typeof item !== "object") { bump(counters, "malformed_claim"); return; }
    const c = item as Record<string, unknown>;
    const ref = typeof c.ref === "string" ? c.ref : "";
    const it = items.get(ref);
    if (!it) { bump(counters, "unknown_ref"); return; }
    const type = typeof c.type === "string" && (CLAIM_TYPES as readonly string[]).includes(c.type) ? (c.type as ClaimType) : null;
    if (type === null) { bump(counters, "unknown_type"); return; }

    const q = quoteInLines(ctx.lines, { quote: c.quote, line_from: c.line_from, line_to: c.line_to });
    if (!q.ok) { bump(counters, `quote_${q.why}`); return; }
    // Stored whitespace-collapsed, so the row always meets pb_meeting_proposals' 12–600 check.
    const quote = String(c.quote).replace(/\s+/g, " ").trim();
    if (quote.length < QUOTE_MIN_CHARS || quote.length > QUOTE_MAX_CHARS) { bump(counters, "quote_length"); return; }
    const own = new Set(it.owned);
    let shared = false;
    for (let n = q.line_from; n <= q.line_to; n++) {
      const holders = ctx.owners?.[n] ?? [];
      if (!own.has(n)) {
        bump(counters, holders.some((r) => r !== ref) ? "other_agency_lines" : "outside_segment");
        return;
      }
      if (holders.some((r) => r !== ref)) shared = true;
    }
    bump(counters, "quote_verified");

    let key: string | null = null;
    let value: unknown = null;
    let tier: string | null = null;
    let disposition: string | null = null;
    let code: string | null = null;
    let topic: string | null = null;

    if (type === "fact") {
      key = typeof c.key === "string" ? c.key : "";
      const shape = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
      if (!shape) { bump(counters, "key_not_extractable"); return; }
      value = coerceClaimValue(shape, c.value);
      if (value === undefined) { bump(counters, "value_out_of_shape"); return; }
    } else if (type === "tier_call") {
      const said = typeof c.tier === "string" ? c.tier.trim().toLowerCase() : "";
      tier = tiers.find((t) => t.toLowerCase() === said) ?? null;
      if (tier === null) { bump(counters, "tier_not_listed"); return; }
      if (!tierNamed(quote, tier)) { bump(counters, "tier_not_named_in_quote"); return; }
      code = typeof c.code === "string" && (ctx.overrideCodes ?? []).includes(c.code) ? c.code : null;
    } else if (type === "removal") {
      disposition = typeof c.disposition === "string" && dispositions.includes(c.disposition) ? c.disposition : null;
      const said = typeof c.code === "string" ? c.code : "";
      code = disposition !== null && reasons.some((r) => r.disposition === disposition && r.code === said) ? said : null;
      if (code === null) bump(counters, "removal_code_left_to_owner");
    } else {
      topic = typeof c.topic === "string" && READ_TOPICS.includes(c.topic) ? c.topic : "other";
    }

    const mode: Mode = typeof c.mode === "string" && (MODES as readonly string[]).includes(c.mode) ? (c.mode as Mode) : "unclear";
    if (mode === "unclear" && c.mode !== "unclear") bump(counters, "mode_missing");
    const confidence = c.confidence === "high" || c.confidence === "medium" || c.confidence === "low" ? c.confidence : "low";
    if (c.kind === "observation") bump(counters, "kind_forced_to_judgement");

    const flags = hedgeFlags(quote);
    if (shared) flags.push("shared_segment");
    claims.push({
      ref, type, key, value, tier, disposition, code, topic,
      quote,
      line_from: q.line_from, line_to: q.line_to, quote_at: q.quote_at, speaker: q.speaker,
      mode, confidence, kind: "judgement", flags, order,
    });
    bump(counters, `claims_${type}`);
  });
  return { claims, counters, notes };
}

/* ------------------------------------------------------------------ *
 * the last word
 * ------------------------------------------------------------------ */

function lastWord(list: readonly VerifiedClaim[]): VerifiedClaim | null {
  if (list.length === 0) return null;
  const decisive = list.filter((c) => DECISIVE_MODES.includes(c.mode));
  const pool = decisive.length > 0 ? decisive : list;
  return pool[pool.length - 1];
}

/**
 * The last word per agency: one tier call, one removal, at most MAX_FACTS_PER_AGENCY facts (one
 * per key) and at most MAX_READS_PER_AGENCY reads. "Last" is by transcript line; a decisive mode
 * (asserted, reported, plan) beats a later question or joke. Everything else is dropped and
 * counted.
 */
export function reduceClaims(claims: readonly VerifiedClaim[]): { claims: VerifiedClaim[]; counters: Record<string, number> } {
  const counters: Record<string, number> = {};
  const byRef = new Map<string, VerifiedClaim[]>();
  for (const c of claims ?? []) {
    const list = byRef.get(c.ref);
    if (list) list.push(c);
    else byRef.set(c.ref, [c]);
  }
  const ordered = (xs: readonly VerifiedClaim[]) => [...xs].sort((a, b) => a.line_from - b.line_from || a.order - b.order);

  const out: VerifiedClaim[] = [];
  for (const list of byRef.values()) {
    const all = ordered(list);
    const keep: VerifiedClaim[] = [];
    for (const type of ["tier_call", "removal"] as const) {
      const of = all.filter((c) => c.type === type);
      const w = lastWord(of);
      if (w) keep.push(w);
      if (of.length > 1) bump(counters, `reduced_${type}`, of.length - 1);
    }
    const facts = all.filter((c) => c.type === "fact");
    const perKey: VerifiedClaim[] = [];
    for (const k of [...new Set(facts.map((f) => f.key as string))]) {
      const of = facts.filter((f) => f.key === k);
      perKey.push(lastWord(of) as VerifiedClaim);
      if (of.length > 1) bump(counters, "reduced_fact", of.length - 1);
    }
    const factsKept = ordered(perKey).slice(-MAX_FACTS_PER_AGENCY);
    if (perKey.length > factsKept.length) bump(counters, "reduced_fact_cap", perKey.length - factsKept.length);
    const reads = all.filter((c) => c.type === "read");
    const readsKept = reads.slice(-MAX_READS_PER_AGENCY);
    if (reads.length > readsKept.length) bump(counters, "reduced_read_cap", reads.length - readsKept.length);
    out.push(...ordered([...keep, ...factsKept, ...readsKept]));
  }
  return { claims: out, counters };
}

/* ------------------------------------------------------------------ *
 * proposal rows
 * ------------------------------------------------------------------ */

export type ProposalKind = "fact" | "override" | "removal" | "read";
export type ProposalStatus = "proposed" | "not_proposed" | "agrees";

/** A pb_meeting_proposals row as pb-notes inserts it. Every key is a column. */
export interface ProposalRow {
  recording_id: string;
  account_id: string | null;
  said_as: string[];
  said_key: string;
  mention_state: "resolved" | "suggested" | "ambiguous";
  matched_on: string | null;
  options: string[];
  kind: ProposalKind;
  key: string | null;
  value: unknown;
  confidence: "high" | "medium" | "low" | null;
  tier: string | null;
  reason_code: string | null;
  disposition: string | null;
  review_on: string | null;
  topic: string | null;
  quote: string;
  context: string | null;
  line_from: number;
  line_to: number;
  quote_at: string;
  speaker: string;
  mode: Mode;
  flags: string[];
  default_selected: boolean;
  held_on: string;
  current_value: unknown;
  current_source: string | null;
  conflicts: boolean;
  engine_tier: string | null;
  effective_tier: string | null;
  default_text: string | null;
  extractor: string;
  fingerprint: string;
  status: ProposalStatus;
}

/** The columns proposalRows writes, in table order. The migration's table must hold every one. */
export const PROPOSAL_COLUMNS: readonly string[] = [
  "recording_id", "account_id", "said_as", "said_key", "mention_state", "matched_on", "options",
  "kind", "key", "value", "confidence", "tier", "reason_code", "disposition", "review_on", "topic",
  "quote", "context", "line_from", "line_to", "quote_at", "speaker", "mode", "flags",
  "default_selected", "held_on", "current_value", "current_source", "conflicts", "engine_tier",
  "effective_tier", "default_text", "extractor", "fingerprint", "status",
];

/** The columns the database fills (defaults) or a decision fills later. proposalRows never sends them. */
export const PROPOSAL_DB_COLUMNS: readonly string[] = [
  "id", "superseded_by", "decided_by", "decided_at", "decision_note", "result_id", "created_at",
];

/** Any of these on a row means a person must tick it deliberately. */
export const BLOCKING_FLAGS: readonly string[] = [
  "shared_segment", "question", "hypothetical", "joke", "historic", "conflicts_with_person", "no_computed_tier",
];

/**
 * Does a row start ticked? Only when it is a proposal, its mention is resolved (or a person placed
 * it), its mode states a position — asserted, or reported for a fact — no blocking flag is on it,
 * and it is NOT a removal. A removal is never pre-ticked; it has its own button. A display hint:
 * pb_decide_meeting_card re-derives every rule at decision time.
 */
export function defaultSelected(row: {
  kind: string;
  mode: string;
  mention_state: string;
  matched_on?: string | null;
  account_id?: string | null;
  flags: readonly string[];
  status?: string;
}): boolean {
  if (row.status !== undefined && row.status !== "proposed") return false;
  if (row.kind === "removal") return false;
  if (!(row.mode === "asserted" || (row.kind === "fact" && row.mode === "reported"))) return false;
  if (!(row.mention_state === "resolved" || row.matched_on === "person")) return false;
  if (row.account_id === null) return false;
  if ((row.flags ?? []).some((f) => BLOCKING_FLAGS.includes(f))) return false;
  return true;
}

/**
 * The prefilled, editable written reason. A tier call's carries the quote, the meeting's title,
 * its date and the line's timestamp — the team's real reason, so rule 7 is not weakened. A fact
 * has none: its pb_facts note is written by the decide function and never carries a quote.
 */
export function defaultText(
  row: { kind: string; quote: string; quote_at: string; topic?: string | null },
  meeting: { title: string | null; held_on: string },
): string | null {
  const q = `"${row.quote}"`;
  if (row.kind === "override") return `${q} — ${meeting.title ?? "sales meeting"}, ${meeting.held_on} ${row.quote_at}`;
  if (row.kind === "removal") return `${q} — sales meeting ${meeting.held_on}`;
  if (row.kind === "read") return `${q} — sales meeting ${meeting.held_on} (${row.topic ?? "other"})`;
  return null;
}

/** What proposalRows needs of a meeting_mentions.MentionCluster. */
export interface ProposalCluster {
  ref: string;
  state: string;
  said_as: readonly string[];
  said_key: string;
  account_id: string | null;
  matched_on: string | null;
  options: readonly string[];
}

/** A pb_current_facts row for a resolved account. */
export interface SnapshotFact {
  account_id: string;
  key: string;
  value: unknown;
  evidence_label: string;
  source: string;
}

/** A pb_current_reads row for a resolved account. */
export interface SnapshotRead {
  account_id: string;
  computed_tier: string | null;
  effective_tier: string | null;
}

export interface ProposalInput {
  meeting: { recording_id: string; title: string | null; held_at: string | null };
  /** extractorId(model, MEETING_PROMPT_VERSION): 'meeting@v1+<model>'. */
  extractor: string;
  /** ISO date the meeting is read. */
  as_of: string;
  clusters: readonly ProposalCluster[];
  /** reduceClaims().claims. */
  claims: readonly VerifiedClaim[];
  /** The whole numbered transcript, for each row's context (cited lines ± 2). */
  lines?: readonly TranscriptLine[];
  facts?: readonly SnapshotFact[];
  reads?: readonly SnapshotRead[];
  /** Account ids pb_removals holds. */
  removed?: readonly string[];
  /** The active rubric's spec.override.reason_codes. */
  overrideCodes: readonly string[];
}

export const CONTEXT_PAD_LINES = 2;
export const CONTEXT_MAX_CHARS = 1200;

function contextFor(lines: readonly TranscriptLine[] | undefined, from: number, to: number): string | null {
  if (!lines || lines.length === 0) return null;
  let a = from - CONTEXT_PAD_LINES;
  let b = to + CONTEXT_PAD_LINES;
  const pick = () => lines.filter((l) => l.n >= a && l.n <= b);
  let text = renderLines(pick());
  while (text.length > CONTEXT_MAX_CHARS && (a < from || b > to)) {
    if (b - to >= from - a && b > to) b--;
    else a++;
    text = renderLines(pick());
  }
  return text.length > CONTEXT_MAX_CHARS ? text.slice(0, CONTEXT_MAX_CHARS) : text || null;
}

/** Order-insensitive for lists (climb_signals), canonical otherwise. */
function sameFactValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return sameValue([...a].map(String).sort(), [...b].map(String).sort());
  }
  return sameValue(a, b);
}

function daysBefore(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 0;
}

/**
 * Verified claims → pb_meeting_proposals rows. For each claim of a readable cluster:
 *
 *   status    'not_proposed' for a hypothetical, question or joke; 'agrees' when the book already
 *             says it — a tier equal to the effective or the computed tier, a removal of an agency
 *             already off the board, a fact equal to the value a PERSON holds; else 'proposed';
 *   flags     the verifier's, plus 'historic' (held more than HISTORIC_DAYS before as_of),
 *             'conflicts_with_person' (a fact that disagrees with a person's value) and
 *             'no_computed_tier' (a tier call the engine would refuse);
 *   display   current_value / current_source, engine_tier / effective_tier — snapshots only;
 *   defaults  default_selected (defaultSelected), default_text (defaultText), and an override's
 *             reason_code: the model's if the rubric lists it, else DEFAULT_OVERRIDE_CODE;
 *   identity  a fingerprint over (source, recording, extractor, said_key, kind, key) — stable
 *             across reruns, new under a new extractor, distinct per agency.
 *
 * Rows of a mention that is not resolved carry account_id null and no snapshot; they wait for a
 * person to place them, and the decide function refuses them until then.
 */
export function proposalRows(input: ProposalInput): ProposalRow[] {
  const clusters = new Map<string, ProposalCluster>();
  for (const c of input.clusters ?? []) clusters.set(c.ref, c);
  const heldKey = timeKey(input.meeting.held_at);
  const held_on = heldKey !== "" ? heldKey.slice(0, 10) : input.as_of.slice(0, 10);
  const historic = daysBefore(held_on, input.as_of) > HISTORIC_DAYS;
  const removed = new Set(input.removed ?? []);
  const codes = input.overrideCodes ?? [];
  const fallbackCode = codes.includes(DEFAULT_OVERRIDE_CODE) ? DEFAULT_OVERRIDE_CODE : codes.includes("other") ? "other" : codes[0] ?? null;

  const rows: ProposalRow[] = [];
  for (const c of input.claims ?? []) {
    const cl = clusters.get(c.ref);
    if (!cl || !READ_STATES.includes(cl.state)) continue;
    const account = cl.state === "resolved" ? cl.account_id : null;
    const kind: ProposalKind = c.type === "tier_call" ? "override" : c.type;
    const read = account === null ? undefined : (input.reads ?? []).find((r) => r.account_id === account);
    const flags = new Set(c.flags);
    if (historic) flags.add("historic");

    let status: ProposalStatus = UNDECIDED_MODES.includes(c.mode) ? "not_proposed" : "proposed";
    let current_value: unknown = null;
    let current_source: string | null = null;
    let conflicts = false;

    if (kind === "fact" && account !== null) {
      const held = (input.facts ?? []).find((f) => f.account_id === account && f.key === c.key);
      if (held) {
        current_value = held.value ?? null;
        current_source = held.source ?? null;
        const same = sameFactValue(held.value, c.value);
        conflicts = !same;
        const person = held.evidence_label === "evidence" && PERSON_SOURCES.includes(held.source);
        if (person && same && status === "proposed") status = "agrees";
        if (person && !same) flags.add("conflicts_with_person");
      }
    } else if (kind === "override" && account !== null) {
      const t = (c.tier ?? "").toLowerCase();
      const eff = (read?.effective_tier ?? "").toLowerCase();
      const comp = (read?.computed_tier ?? "").toLowerCase();
      if (status === "proposed" && (t === eff || t === comp)) status = "agrees";
      if (!read || !read.computed_tier) flags.add("no_computed_tier");
    } else if (kind === "removal" && account !== null) {
      if (status === "proposed" && removed.has(account)) status = "agrees";
    }

    const discriminator = kind === "fact" ? String(c.key) : kind === "read" ? `${c.topic}|${c.line_from}` : "";
    const row: ProposalRow = {
      recording_id: input.meeting.recording_id,
      account_id: account,
      said_as: [...cl.said_as],
      said_key: cl.said_key,
      mention_state: cl.state as ProposalRow["mention_state"],
      matched_on: cl.matched_on ?? null,
      options: [...cl.options].slice(0, 5),
      kind,
      key: kind === "fact" ? c.key : null,
      value: kind === "fact" ? c.value : null,
      confidence: c.confidence,
      tier: kind === "override" ? c.tier : null,
      reason_code: kind === "override" ? (c.code ?? fallbackCode) : kind === "removal" ? c.code : null,
      disposition: kind === "removal" ? c.disposition : null,
      review_on: null,
      topic: kind === "read" ? c.topic : null,
      quote: c.quote,
      context: contextFor(input.lines, c.line_from, c.line_to),
      line_from: c.line_from,
      line_to: c.line_to,
      quote_at: c.quote_at,
      speaker: c.speaker,
      mode: c.mode,
      flags: [...flags].sort(),
      default_selected: false,
      held_on,
      current_value,
      current_source,
      conflicts,
      engine_tier: read?.computed_tier ?? null,
      effective_tier: read?.effective_tier ?? null,
      default_text: null,
      extractor: input.extractor,
      fingerprint: noteFingerprint([MEETING_SOURCE, input.meeting.recording_id, input.extractor, cl.said_key, kind, discriminator]),
      status,
    };
    row.default_selected = defaultSelected(row);
    row.default_text = defaultText(row, { title: input.meeting.title, held_on });
    rows.push(row);
  }
  return rows;
}
