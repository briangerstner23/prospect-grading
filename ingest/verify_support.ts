/**
 * WLIQ Prospect Book — does the sentence actually SAY it?
 *
 * Rule 8's receipt proves that a sentence is really in the source. It does not prove that the
 * sentence says what the extractor decided it says, and on 18 Sep that gap turned out to be the
 * expensive one: four of ten claims the website reader had rated `high` were inferences wearing a
 * verbatim quote (DECISIONS §50). A delivery headcount of zero from a team page that listed one
 * person. A client-budget band from a case-study headline quoting the CLIENT's pipeline. Both
 * quotes were real. Neither said the thing.
 *
 * `kind` was supposed to catch this and cannot: it asks whether the SENTENCE is checkable, not
 * whether the sentence supports the VALUE. "a list of ~7 prospects" is a perfectly checkable
 * observation and still does not mean the agency has seven clients.
 *
 * So this module asks the one question that separates the four bad claims from the good ones:
 *
 *      Does this verbatim sentence state this value for this key?
 *
 *   states       the sentence says it outright. "Current client load: ~15 PI law firms."
 *   implies      a fair reading gets there, but the sentence does not say it. Still a candidate,
 *                never an automatic fact.
 *   unsupported  the sentence is about something else. Wrong subject, an illustrative number, a
 *                partial list read as a total, an absence read as a finding.
 *
 * PURE. No clock, no network, no filesystem, no model call. The model call happens in the edge
 * function; everything here is the prompt it sends, the parsing of what comes back, and the
 * lexicon — which may only ever move a verdict DOWN.
 *
 * WHY DOWN ONLY. This pass re-audits claims that already exist. A wrong `unsupported` costs one
 * row staying in a queue a person was going to read anyway. A wrong `states` puts an inference in
 * the book as evidence. The two mistakes are not the same size, so the lexicon is allowed to
 * contradict the model in exactly one direction and the parser refuses anything it cannot read
 * rather than guessing at it.
 *
 * WHAT A MALFORMED REPLY MEANS. Nothing. An unreadable verdict leaves `support` NULL and the claim
 * exactly as it was, to be asked again next run — it does not become `unsupported`, because
 * "the reader did not answer" is not a finding about the sentence. Rule 5, one level up.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

/* ------------------------------------------------------------------ *
 * the verdict
 * ------------------------------------------------------------------ */

export type Support = "states" | "implies" | "unsupported";

/** Weakest first. A ceiling is applied by taking the minimum of model and lexicon. */
export const SUPPORT_ORDER: readonly Support[] = ["unsupported", "implies", "states"];

export function weakest(a: Support, b: Support): Support {
  return SUPPORT_ORDER.indexOf(a) <= SUPPORT_ORDER.indexOf(b) ? a : b;
}

/** One claim to re-audit: what was claimed, and the sentence that was offered for it. */
export interface SupportClaim {
  /** pb_fact_candidates.id — the only thing tying a verdict back to a row. */
  id: string;
  key: string;
  value: unknown;
  quote: string;
}

export interface SupportVerdict {
  id: string;
  support: Support;
  reason: string;
  /** `model` when the reader decided it, `lexicon` when a rule below overruled it downward. */
  basis: "model" | "lexicon";
}

export interface SupportResult {
  verdicts: SupportVerdict[];
  /** Claims deliberately left unverified, with why — these keep support NULL and are asked again. */
  unresolved: { id: string; why: string }[];
  notes: string[];
  counters: Record<string, number>;
}

/* ------------------------------------------------------------------ *
 * the lexicon — three rules, one per failure actually observed
 * ------------------------------------------------------------------ */

/**
 * Keys whose value is a COUNT, where a number in the sentence is not automatically the answer.
 *
 * `client_budget_size` was in this list for one run and came out again. It is a BAND, not a count,
 * and the rule misfired on "Local SMBs: Businesses in a 3-county area (e.g., construction,
 * restaurants)" — a sentence that states the band outright, where the "e.g." is illustrating which
 * INDUSTRIES, not how many. The reader had it right and the lexicon overruled it. A rule that only
 * ever moves downward can still be wrong; it is just wrong in the cheaper direction, and that is a
 * reason to fix it rather than to keep it.
 */
export const QUANTITY_KEYS: readonly string[] = [
  "client_evidence_count", "headcount", "delivery_headcount", "years_operating",
];

/**
 * Words that make a number or a list an EXAMPLE rather than a total. Observed: "~200 sites cited
 * as example scale" became a client count of 200, and "client base includes A, B and C" became a
 * client count of 3 for an agency that may have thirty.
 */
export const ILLUSTRATIVE_MARKERS: readonly string[] = [
  "for example", "e.g.", "such as", "includes", "including", "example scale", "among them",
  "like ", "etc", "a few", "some of", "several of", "to name", "as an example",
];

/** Keys where "absent" is a finding about the record, not about the world. */
export const ABSENCE_KEYS: readonly string[] = ["money", "authority", "specification"];

/**
 * An explicit negation. `authority = absent` was once read out of "no job title on person" — a
 * MISSING FIELD, not a statement that nobody has authority. The extraction prompt already says
 * "not mentioned is not the same as not there"; this enforces it after the fact.
 */
export const NEGATION_MARKERS: readonly string[] = [
  "no ", "not ", "none", "never", "without", "lacks", "lack of", "hasn't", "has not",
  "doesn't", "does not", "don't", "do not", "isn't", "is not", "aren't", "are not",
  "cannot", "can't", "unable", "yet to", "still waiting", "no one", "nobody",
];

function normalize(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * The strongest verdict the lexicon will allow for this claim, or null when it has no opinion.
 * Never returns something STRONGER than the model said — the caller takes the weaker of the two.
 */
export function lexiconCeiling(key: string, value: unknown, quote: string): { ceiling: Support; why: string } | null {
  const q = normalize(quote);
  if (!q) return null;

  // 1. A count key whose sentence is offering an example, not a total.
  if (QUANTITY_KEYS.includes(key)) {
    for (const m of ILLUSTRATIVE_MARKERS) {
      if (q.includes(m)) {
        return { ceiling: "implies", why: `the sentence is giving an example ("${m.trim()}"), not a total` };
      }
    }
  }

  // 2. A client count read off a sentence that is counting something else.
  if (key === "client_evidence_count" && /\bprospect/.test(q) && !/\bclient/.test(q)) {
    return { ceiling: "unsupported", why: "the sentence counts prospects, and this key counts clients" };
  }

  // 3. "absent" claimed from a sentence that never says anything is missing.
  //
  // The ceiling here is `implies`, not `unsupported`, and the first run is why. It fired on
  // "Key Challenge: RFPs are often incomplete" and "This requires internal consultation with
  // leadership before proceeding" — sentences that plainly BEAR on specification and authority
  // even though neither says the thing is absent. `unsupported` means "about something else",
  // and calling those that is simply false. `implies` says exactly what is true of them: a fair
  // reading gets there, the sentence does not say it, and no machine writes it as a fact.
  //
  // Note what this rule cannot do: the case that motivated it, `authority = absent` read out of
  // "no job title on person", contains "no " and so never reaches here at all. The reader catches
  // that one. This is a backstop for the silent case, not the rule that does the work.
  if (ABSENCE_KEYS.includes(key) && normalize(String(value)).replace(/"/g, "") === "absent") {
    const negated = NEGATION_MARKERS.some((m) => q.includes(m));
    if (!negated) {
      return { ceiling: "implies", why: "nothing in the sentence says it is missing; silence is not absence" };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * the prompt
 * ------------------------------------------------------------------ */

export function supportPrompt(): string {
  return [
    "You are auditing claims that were already read out of a record. For each one you are given the",
    "KEY that was claimed, the VALUE that was recorded, and the VERBATIM SENTENCE that was offered",
    "as evidence for it. The sentence is genuine — it really is in the source. That is not what you",
    "are checking.",
    "",
    "You are checking ONE thing: does that sentence state that value for that key?",
    "",
    'Return JSON: {"verdicts": [{"id", "support", "reason"}]} with one entry per claim given.',
    "",
    "support is exactly one of:",
    '  "states"       the sentence says it outright. A reader would not have to add anything.',
    '  "implies"      a fair reading gets there, but the sentence does not actually say it.',
    '  "unsupported"  the sentence is about something else, or does not bear on the value at all.',
    "",
    "reason is one short clause, in plain words, naming what the sentence actually says. No preamble.",
    "",
    "Rules:",
    "- Judge the SENTENCE, not the claim. The claim may well be true; if this sentence does not say",
    "  it, that is 'implies' or 'unsupported', and saying so costs nothing — the claim goes to a",
    "  person rather than into the book.",
    "- A number in the sentence is not automatically the answer. Counting prospects is not counting",
    "  clients; a client's media spend is not the agency's project budget; \"~200 sites, as an",
    "  example of scale\" is not a count of anything.",
    "- A partial list is not a total. \"client base includes A, B and C\" does not say there are three.",
    "- A missing field is not a finding. \"no job title on person\" does not say nobody has authority.",
    "  For money, authority and specification, \"absent\" needs the sentence to SAY something is",
    "  missing, not merely to fail to mention it.",
    "- A fragment can still state something. \"Current client load: ~15 PI law firms\" is 'states'.",
    "- Do not be generous. 'states' is the strong answer and it is the one that lets a machine write",
    "  a fact with nobody reading it.",
    "- Return a verdict for every id you are given, and invent no ids.",
  ].join("\n");
}

/** How the claims are presented to the reader. One block per claim, id first. */
export function supportPayload(claims: readonly SupportClaim[]): string {
  return claims.map((c) =>
    [
      `id: ${c.id}`,
      `key: ${c.key}`,
      `value: ${JSON.stringify(c.value ?? null)}`,
      `sentence: ${String(c.quote ?? "").replace(/\s+/g, " ").trim()}`,
    ].join("\n")
  ).join("\n\n");
}

/* ------------------------------------------------------------------ *
 * parsing
 * ------------------------------------------------------------------ */

function bump(c: Record<string, number>, k: string): void {
  c[k] = (c[k] ?? 0) + 1;
}

function isSupport(v: unknown): v is Support {
  return v === "states" || v === "implies" || v === "unsupported";
}

/**
 * Reduce what the reader returned to verdicts the book will accept.
 *
 * Everything unrecognised becomes `unresolved` rather than a guess: an id that was not asked
 * about is dropped, a support value outside the three words is dropped, and a claim with no
 * verdict at all is left for the next run. Then the lexicon takes its pass, downward only.
 */
export function verifySupport(claims: readonly SupportClaim[], raw: unknown): SupportResult {
  const verdicts: SupportVerdict[] = [];
  const unresolved: { id: string; why: string }[] = [];
  const notes: string[] = [];
  const counters: Record<string, number> = {};

  const byId = new Map<string, SupportClaim>();
  for (const c of claims) if (c && typeof c.id === "string") byId.set(c.id, c);

  const rows = raw && typeof raw === "object" && Array.isArray((raw as { verdicts?: unknown }).verdicts)
    ? (raw as { verdicts: unknown[] }).verdicts
    : null;

  if (rows === null) {
    notes.push("The reader returned nothing shaped like {verdicts: [...]}; nothing was changed.");
    bump(counters, "reply_malformed");
    for (const c of claims) unresolved.push({ id: c.id, why: "the reader's reply could not be read" });
    return { verdicts, unresolved, notes, counters };
  }

  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") { bump(counters, "verdict_malformed"); continue; }
    const row = r as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : null;
    if (id === null || !byId.has(id)) {
      notes.push(`A verdict named ${id === null ? "no id" : id}, which was not in the batch; dropped.`);
      bump(counters, "verdict_for_unknown_claim");
      continue;
    }
    if (seen.has(id)) { bump(counters, "verdict_duplicated"); continue; }
    seen.add(id);

    if (!isSupport(row.support)) {
      unresolved.push({ id, why: `support was ${JSON.stringify(row.support ?? null)}, which is not one of the three words` });
      bump(counters, "verdict_not_one_of_three");
      continue;
    }

    const claim = byId.get(id)!;
    const modelSaid = row.support;
    const reason = typeof row.reason === "string" && row.reason.trim()
      ? row.reason.trim().slice(0, 300)
      : "no reason given";

    const cap = lexiconCeiling(claim.key, claim.value, claim.quote);
    if (cap && weakest(modelSaid, cap.ceiling) !== modelSaid) {
      verdicts.push({ id, support: cap.ceiling, basis: "lexicon", reason: `${cap.why} (the reader said ${modelSaid})` });
      notes.push(`${claim.key}: the reader said ${modelSaid}; ${cap.why} — held to ${cap.ceiling}.`);
      bump(counters, "lexicon_overruled_downward");
      continue;
    }

    verdicts.push({ id, support: modelSaid, basis: "model", reason });
    bump(counters, `model_said_${modelSaid}`);
  }

  for (const c of claims) {
    if (!seen.has(c.id) && !unresolved.some((u) => u.id === c.id)) {
      unresolved.push({ id: c.id, why: "the reader returned no verdict for it" });
      bump(counters, "no_verdict_returned");
    }
  }

  return { verdicts, unresolved, notes, counters };
}

/**
 * Split claims into batches the reader can hold at once. Characters, not rows: one 900-character
 * quote and forty short ones are not the same ask.
 */
export function batchClaims(
  claims: readonly SupportClaim[],
  maxClaims = 25,
  maxChars = 12000,
): SupportClaim[][] {
  const out: SupportClaim[][] = [];
  let cur: SupportClaim[] = [];
  let chars = 0;
  for (const c of claims) {
    const size = String(c.quote ?? "").length + String(c.key ?? "").length + 80;
    if (cur.length && (cur.length >= maxClaims || chars + size > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Versioned identity, so a verdict records which auditor produced it. */
export function auditorId(model: string): string {
  return `support@v1+${model}`;
}
