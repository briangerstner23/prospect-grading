/**
 * WLIQ Prospect Book — identity resolution (DESIGN.md §4a).
 *
 * PURE. No clock, no network, no filesystem, no dependencies. Runs under Deno and under
 * `node --experimental-strip-types`.
 *
 * Every source (Notion, Orbit, Pipedrive, Fathom, Apollo, a sheet) arrives with some subset
 * of {name, domain, pipedrive_org_id, orbit_client_id}. This module answers one question:
 * which existing pb_accounts row, if any, is this? It never merges two rows and it never
 * attaches on a guess — PRO-18's discipline (a person confirms an identity match) applied
 * to every source, not only to promotion.
 *
 * Join keys in order of trust:
 *   pipedrive_org_id  → high
 *   orbit_client_id   → high
 *   domain            → high
 *   norm(name) exact  → medium   (a pb_identity_candidates row; a person decides)
 *   trigram ≥ 0.85    → low      (a pb_identity_candidates row; a person decides)
 *
 * Only a HIGH match attaches automatically. A null on either side never matches anything:
 * unknown is never evidence.
 *
 * This is an independent system from the Client Book (PRO-17): the normalisation rules here
 * are this book's own and are not kept in sync with any other list.
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The columns of pb_accounts the resolver needs. Ids may arrive as numbers or strings. */
export interface KnownAccount {
  id: string;
  /** norm(name) — pb_accounts.key */
  key: string;
  name: string;
  domain: string | null;
  pipedrive_org_id: number | string | null;
  orbit_client_id: number | string | null;
}

export interface IdentityCandidateInput {
  /** pipedrive | orbit | fathom | notion | apollo | sheet | client_book */
  source: string;
  source_id?: string | number | null;
  name?: string | null;
  domain?: string | null;
  pipedrive_org_id?: number | string | null;
  orbit_client_id?: number | string | null;
}

export type MatchConfidence = "high" | "medium" | "low";

export type MatchedOn =
  | "pipedrive_org_id"
  | "orbit_client_id"
  | "domain"
  | "name_exact"
  | "name_norm"
  | "name_trigram";

export interface MatchCandidate {
  account_id: string;
  matched_on: MatchedOn;
  confidence: MatchConfidence;
  /** Trigram similarity for name_trigram matches; 1 for every other kind. */
  score?: number;
}

export interface MatchProposal {
  /** The account to attach to, or null. Non-null ONLY on a high match. */
  attach: KnownAccount | null;
  /**
   * Every match found, strongest first, one entry per account. Includes the attached
   * account (so the audit trail can say why it attached) and every other account that
   * matched on any key — a second HIGH match on a different account is a conflict a
   * person must see. Callers writing pb_identity_candidates rows skip `attach.id`.
   */
  candidates: MatchCandidate[];
}

/* ------------------------------------------------------------------ *
 * norm(name) — pb_accounts.key
 * ------------------------------------------------------------------ */

/**
 * Words dropped from a name before it becomes a key (DESIGN.md §4a). Deliberately short:
 * every word here is one that two sources routinely disagree about. "and" is NOT stripped —
 * instead "&" is folded to "and" so the two spellings of the same conjunction meet.
 */
const STRIP_WORDS = new Set(["the", "inc", "llc", "ltd", "agency", "group", "co"]);

/**
 * Normalised join key: lower-case, "&" → "and", punctuation → space, the STRIP_WORDS
 * removed, whitespace collapsed. Deterministic and idempotent: norm(norm(x)) === norm(x).
 */
export function norm(name: string | null | undefined): string {
  if (name === null || name === undefined) return "";
  let s = String(name).toLowerCase();
  // NFKD strips accents so "café" and "cafe" meet; the mark range is dropped afterwards.
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  const words = s.split(" ").filter((w) => w.length > 0 && !STRIP_WORDS.has(w));
  return words.join(" ");
}

/* ------------------------------------------------------------------ *
 * Domains
 * ------------------------------------------------------------------ */

/**
 * Registrable labels that identify a personal or generic mailbox provider. A domain whose
 * registrable label is one of these is not an organisation and returns null.
 */
const GENERIC_MAIL_LABELS = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "proton",
  "protonmail",
  "pm",
]);

/** Second-level labels under a two-letter country code: co.uk, com.au, org.nz … */
const CC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/** The label that names the organisation: "harborpine" in "www.harborpine.co.uk". */
function registrableLabel(host: string): string {
  const labels = host.split(".");
  if (labels.length < 2) return labels[0] ?? "";
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (labels.length >= 3 && tld.length === 2 && CC_SECOND_LEVEL.has(second)) {
    return labels[labels.length - 3];
  }
  return second;
}

/**
 * Host only, lower-case, no `www.`, no scheme, port, path, query, fragment or userinfo.
 * Accepts a URL, an email address or a bare host. Returns null for anything empty, for a
 * host without a dot, for an invalid host, and for generic mail providers (gmail, outlook,
 * yahoo, icloud, hotmail, live, aol, proton and their aliases) — a personal mailbox is not
 * an organisation and must never become a join key.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().toLowerCase();
  if (s.length === 0) return null;

  // mailto:hello@x.com · hello@x.com · "Name <hello@x.com>"
  s = s.replace(/^mailto:/, "");
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  const at = s.lastIndexOf("@");
  if (at >= 0 && !s.slice(0, at).includes("/")) s = s.slice(at + 1);

  // scheme://user:pass@host:port/path?q#f
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^\/\//, "");
  const firstSlash = s.search(/[/?#]/);
  if (firstSlash >= 0) s = s.slice(0, firstSlash);
  const userinfo = s.lastIndexOf("@");
  if (userinfo >= 0) s = s.slice(userinfo + 1);
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^\.+|\.+$/g, "");
  s = s.replace(/^www\d*\./, "");

  if (s.length === 0) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (GENERIC_MAIL_LABELS.has(registrableLabel(s))) return null;
  return s;
}

/** The organisation domain of an email address, or null (no "@", or a generic provider). */
export function domainFromEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const s = String(email).trim();
  if (!s.includes("@")) return null;
  return normalizeDomain(s);
}

/* ------------------------------------------------------------------ *
 * Trigram similarity
 * ------------------------------------------------------------------ */

/**
 * The pg_trgm convention: each word padded with two leading spaces and one trailing space,
 * then every run of three characters. Using the same convention as Postgres means a later
 * SQL-side `similarity()` gives the same numbers as this function.
 */
function trigramsOf(s: string): Set<string> {
  const out = new Set<string>();
  const words = String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Jaccard similarity of the two trigram sets, 0..1. Deterministic. Two empty strings are
 * 0 (nothing in common is not evidence of sameness); identical non-empty strings are 1.
 */
export function trigram(a: string | null | undefined, b: string | null | undefined): number {
  const ta = trigramsOf(a ?? "");
  const tb = trigramsOf(b ?? "");
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Threshold for a `low` name match (DESIGN.md §4a). */
export const TRIGRAM_LOW_THRESHOLD = 0.85;

/* ------------------------------------------------------------------ *
 * proposeMatches
 * ------------------------------------------------------------------ */

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Ids compare as trimmed strings so 12345 and "12345" meet; null/empty never match. */
function idKey(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/** The compact form of a key: whitespace removed. "harbor pine" and "harborpine" meet here. */
function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Propose which known account a candidate is. Never merges, never attaches below `high`.
 *
 *   attach     — the first account matched on pipedrive_org_id, orbit_client_id or domain
 *                (in that order of trust), else null.
 *   candidates — every account matched on any key, strongest first, one entry per account.
 *
 * A `medium` match is norm(name) equality (matched_on `name_exact` when the raw names are
 * equal ignoring case, `name_norm` otherwise). A `low` match is a trigram similarity ≥ 0.85
 * between the normalised names, compared both as written and with whitespace removed, so a
 * CamelCase run-together spelling can meet its spaced twin. Anything below that is not a
 * candidate at all: the caller records `matched_on: none`.
 */
export function proposeMatches(
  candidate: IdentityCandidateInput,
  known: KnownAccount[],
): MatchProposal {
  const found = new Map<string, MatchCandidate>();
  const order: string[] = [];

  const record = (acc: KnownAccount, m: MatchCandidate) => {
    const prev = found.get(acc.id);
    if (!prev) {
      found.set(acc.id, m);
      order.push(acc.id);
      return;
    }
    const better =
      CONFIDENCE_RANK[m.confidence] > CONFIDENCE_RANK[prev.confidence] ||
      (m.confidence === prev.confidence && (m.score ?? 1) > (prev.score ?? 1));
    if (better) found.set(acc.id, m);
  };

  /* ---- high: pipedrive_org_id, then orbit_client_id, then domain ---- */
  const pdId = idKey(candidate.pipedrive_org_id);
  if (pdId !== null) {
    for (const acc of known) {
      if (idKey(acc.pipedrive_org_id) === pdId) {
        record(acc, { account_id: acc.id, matched_on: "pipedrive_org_id", confidence: "high", score: 1 });
      }
    }
  }
  const orbitId = idKey(candidate.orbit_client_id);
  if (orbitId !== null) {
    for (const acc of known) {
      if (idKey(acc.orbit_client_id) === orbitId) {
        record(acc, { account_id: acc.id, matched_on: "orbit_client_id", confidence: "high", score: 1 });
      }
    }
  }
  const domain = normalizeDomain(candidate.domain);
  if (domain !== null) {
    for (const acc of known) {
      if (normalizeDomain(acc.domain) === domain) {
        record(acc, { account_id: acc.id, matched_on: "domain", confidence: "high", score: 1 });
      }
    }
  }

  /* ---- medium: norm(name) exact ---- */
  const candKey = norm(candidate.name);
  const candRaw = String(candidate.name ?? "").trim().toLowerCase();
  if (candKey.length > 0) {
    for (const acc of known) {
      const accKey = acc.key && acc.key.length > 0 ? acc.key : norm(acc.name);
      if (accKey === candKey) {
        const raw = String(acc.name ?? "").trim().toLowerCase();
        record(acc, {
          account_id: acc.id,
          matched_on: raw.length > 0 && raw === candRaw ? "name_exact" : "name_norm",
          confidence: "medium",
          score: 1,
        });
      }
    }

    /* ---- low: trigram ≥ threshold, as written or with whitespace removed ---- */
    const candCompact = compact(candKey);
    for (const acc of known) {
      if (found.has(acc.id)) continue;
      const accKey = acc.key && acc.key.length > 0 ? acc.key : norm(acc.name);
      if (accKey.length === 0) continue;
      const score = Math.max(trigram(candKey, accKey), trigram(candCompact, compact(accKey)));
      if (score >= TRIGRAM_LOW_THRESHOLD) {
        record(acc, { account_id: acc.id, matched_on: "name_trigram", confidence: "low", score });
      }
    }
  }

  const candidates = order
    .map((id) => found.get(id) as MatchCandidate)
    .sort((x, y) => {
      const byConf = CONFIDENCE_RANK[y.confidence] - CONFIDENCE_RANK[x.confidence];
      if (byConf !== 0) return byConf;
      const byScore = (y.score ?? 1) - (x.score ?? 1);
      if (byScore !== 0) return byScore;
      return order.indexOf(x.account_id) - order.indexOf(y.account_id);
    });

  const first = candidates[0];
  const attach = first && first.confidence === "high"
    ? (known.find((k) => k.id === first.account_id) ?? null)
    : null;

  return { attach, candidates };
}
