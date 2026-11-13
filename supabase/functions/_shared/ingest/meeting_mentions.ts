/**
 * WLIQ Prospect Book — which agency a sales meeting was talking about (DECISIONS §65).
 *
 * Pass 1 of the meeting reader asks a model one thing: which outside companies were discussed,
 * in the words the transcript wrote, and on which lines. Everything after that is HERE, in code,
 * and deliberately timid, because the costliest mistake this reader can make is a true sentence
 * filed against the wrong agency (the §60 wrong-company class):
 *
 *   · verifySegments keeps a spoken name only if it is on a line the model cited, and a segment
 *     only if it holds such a line — an invented mention cannot place a single line — and only
 *     as far as it stays near one (nearMentions), so a range cannot carry a company onto the next
 *     discussion;
 *   · resolveSurface / resolveMention match the words against the roster WITHOUT the model ever
 *     seeing the roster. A whole name held by exactly one account resolves; a single distinctive
 *     word, a domain label or a prefix only SUGGESTS, and a shared or ordinary word is AMBIGUOUS —
 *     both go to a person ("Who is this?"), whose answer is remembered as a learned alias. That is
 *     rule 8's posture: identity never attaches below high without a person;
 *   · placeholder rows, our own names, junk, and anyone at the meeting are REFUSED outright, so a
 *     colleague named like an agency can never become one;
 *   · clusterMentions merges every resolved mention of one account into one card, in the order
 *     the meeting discussed them.
 *
 * PURE. No clock, no network, no filesystem, no model call. The roster, aliases, junk and the
 * meeting's people all arrive as inputs. Imports only ./name_tokens.ts and ./notes_sweep.ts.
 * Runs under Deno and `node --experimental-strip-types`.
 */

import { FIRST_TOKEN_ALLOW, GENERIC, MIN_TOKEN } from "./name_tokens.ts";
import { normalizeForQuote } from "./notes_sweep.ts";

/* ------------------------------------------------------------------ *
 * vocabulary
 * ------------------------------------------------------------------ */

/** Our own names. Never an agency, whatever the transcript says. */
export const OWN_NAMES: readonly string[] = ["wliq", "white label iq", "whitelabel iq", "whitelabeliq"];

/** Placeholder account names and words that are said about every agency. Never a match. */
export const STOPLIST: readonly string[] = [
  "tbd", "none", "test", "n/a", "unknown", "individual", "confidential", "better",
  "agency", "client", "prospect",
];

/** Dropped from the end of a name before it is a key: "Something Studio, Inc" → "something studio". */
export const LEGAL_SUFFIXES: readonly string[] = ["inc", "llc", "ltd", "lp", "co", "corp", "corporation", "limited", "company"];

/** Dropped from the end of a name for its CORE key: "Something Digital" is also "something". */
export const TRAILING_GENERIC: readonly string[] = [
  "agency", "digital", "creative", "marketing", "media", "studio", "studios", "group", "partners",
  "design", "interactive", "solutions", "labs", "collective",
];

/** How a meeting refers to an agency without naming it: "the Something folks". */
export const FILLER_WORDS: readonly string[] = ["folks", "guys", "team", "people", "crew", "account", "deal"];

/** A key shorter than this is never a match. */
export const MIN_KEY_CHARS = 4;
/** A domain label shorter than this is never a key. */
export const MIN_DOMAIN_LABEL = 5;
/** The books a meeting can talk about. A merged row redirects to the row it merged into. */
export const LIVE_BOOKS: readonly string[] = ["prospect", "parked"];
export const MAX_OPTIONS = 5;
export const MAX_PREFIX_OPTIONS = 3;

/** Pass-1 kinds that are read further; every other kind is dropped and counted. */
export const READ_KINDS: readonly string[] = ["agency", "unclear"];

/* ------------------------------------------------------------------ *
 * keys
 * ------------------------------------------------------------------ */

/**
 * A spoken or written name, folded to the form both sides are compared in: lower case, accents
 * off, "&" → "and", quotes folded, a possessive 's stripped, punctuation → spaces, spaces
 * collapsed, a leading "the" dropped. Deterministic and idempotent.
 */
export function speechKey(s: unknown): string {
  let t = String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/&/g, " and ");
  t = t.replace(/([a-z0-9])'s\b/g, "$1").replace(/([a-z0-9])s'(?![a-z0-9])/g, "$1s");
  t = t.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.startsWith("the ")) t = t.slice(4);
  return t;
}

const OWN_KEYS = new Set(OWN_NAMES.map(speechKey));
const STOP_KEYS = new Set(STOPLIST.map(speechKey));

function dropTrailing(key: string, words: readonly string[]): string {
  const toks = key.split(" ").filter(Boolean);
  while (toks.length > 1 && words.includes(toks[toks.length - 1])) toks.pop();
  return toks.join(" ");
}

/** An ordinary English word: in GENERIC or FIRST_TOKEN_ALLOW. Never distinctive on its own. */
function ordinary(word: string): boolean {
  return GENERIC.has(word) || FIRST_TOKEN_ALLOW.has(word);
}

/** Distinctive enough to suggest an account by itself (the names check's own first-token rule). */
function distinctive(word: string): boolean {
  return word.length >= MIN_TOKEN && /^[a-z][a-z0-9]*$/.test(word) && !ordinary(word) &&
    !TRAILING_GENERIC.includes(word) && !STOP_KEYS.has(word) && !OWN_KEYS.has(word);
}

/** Second-level labels under a two-letter country code: co.uk, com.au … */
const CC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);

/** The label that names the organisation: "harborpine" in "www.harborpine.co.uk". */
export function domainLabel(domain: unknown): string | null {
  let s = String(domain ?? "").trim().toLowerCase();
  if (s === "") return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  s = s.split(/[/?#:]/)[0].replace(/^www\d*\./, "").replace(/^\.+|\.+$/g, "");
  const labels = s.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const label = labels.length >= 3 && tld.length === 2 && CC_SECOND_LEVEL.has(second) ? labels[labels.length - 3] : second;
  return /^[a-z0-9-]+$/.test(label) ? label.replace(/-/g, "") : null;
}

/* ------------------------------------------------------------------ *
 * the roster index
 * ------------------------------------------------------------------ */

/** A pb_accounts row, as much of it as matching needs. */
export interface RosterAccount {
  id: string;
  name: string | null;
  domain?: string | null;
  /** prospect · parked · merged. Absent is read as live. */
  book?: string | null;
  merged_into?: string | null;
}

/** pb_mdm_aliases. */
export interface MdmAlias {
  slug: string;
  alias: string;
  /** name · domain */
  alias_type: string;
  authoritative?: boolean | null;
}

/** pb_mdm_resolution: the slug → account join for aliases and poison pairs. */
export interface MdmResolution {
  account_id: string | null;
  slug: string | null;
}

/** pb_meeting_aliases: a spoken name a person confirmed once. */
export interface LearnedAlias {
  said_key: string;
  account_id: string;
  active?: boolean | null;
}

/** pb_mdm_junk. Only kinds `name` and `domain` are read. */
export interface JunkRow {
  kind: string;
  value: string;
}

/** pb_mdm_poison_pairs: two accounts that must never be confused for each other. */
export interface PoisonPair {
  slug_a: string;
  slug_b: string;
}

export interface RosterInput {
  accounts: readonly RosterAccount[];
  aliases?: readonly MdmAlias[];
  resolution?: readonly MdmResolution[];
  learned?: readonly LearnedAlias[];
  junk?: readonly JunkRow[];
  poison_pairs?: readonly PoisonPair[];
  /** This meeting's invitee and speaker names. Any of their words is never an agency. */
  people?: readonly (string | null | undefined)[];
}

/**
 * What a placement rests on. pb_meeting_proposals.matched_on allows exactly these ('person' is a
 * placement a reviewer made); scripts/meeting_contract_test.ts pins the two lists together.
 */
export const MATCHED_ON = ["name", "alias", "learned", "token", "domain", "prefix", "person"] as const;
export type MatchedOn = typeof MATCHED_ON[number];

/**
 * What a mention is. Only the first three are ever read or stored as proposals (meeting_claims
 * READ_STATES); pb_meeting_proposals.mention_state allows exactly those.
 */
export const MENTION_STATES = ["resolved", "suggested", "ambiguous", "unknown", "refused"] as const;
export type MentionState = typeof MENTION_STATES[number];

type Basis = "name" | "alias" | "learned" | "weak" | "token" | "domain";

interface Hit {
  account: string;
  basis: Basis;
}

export interface IndexedAccount {
  id: string;
  name: string;
  domain: string | null;
  full: string;
}

export interface RosterIndex {
  /** Live, matchable accounts by id. Junk and placeholder rows are not here, so never an option. */
  accounts: Map<string, IndexedAccount>;
  /** Keys that RESOLVE when one account holds them: full name, core name, authoritative alias, learned. Weak names too, which never resolve. */
  exact: Map<string, Hit[]>;
  /** Keys that only SUGGEST: a distinctive first token, a domain label, a non-authoritative alias. */
  soft: Map<string, Hit[]>;
  /** Distinctive tokens, for the prefix rule. */
  tokens: Map<string, string[]>;
  /** Keys that are never a match, with why. */
  refused: Map<string, string>;
  /** Every word of this meeting's people. */
  people: Set<string>;
  /** Account → the accounts it must never be confused with. */
  poison: Map<string, Set<string>>;
}

function push(map: Map<string, Hit[]>, key: string, hit: Hit): void {
  if (key.length < MIN_KEY_CHARS) return;
  const list = map.get(key);
  if (!list) map.set(key, [hit]);
  else if (!list.some((h) => h.account === hit.account && h.basis === hit.basis)) list.push(hit);
}

/**
 * Build the matcher for ONE meeting: the roster with every key each account can be said by, the
 * refusals, and the meeting's own people.
 *
 * Per account: `full` (the name without a legal suffix), `core` (full without trailing generic
 * words, kept when what remains is two or more words or one distinctive word), an authoritative
 * name alias, a learned alias — those resolve; and a distinctive first token (MIN_TOKEN or more,
 * not ordinary English), a domain label (MIN_DOMAIN_LABEL or more) and a non-authoritative alias —
 * those suggest. A name that is ONE ordinary word ("Haystack") is WEAK: offered, never resolved.
 */
export function buildRosterIndex(input: RosterInput): RosterIndex {
  const refused = new Map<string, string>();
  for (const k of OWN_KEYS) refused.set(k, "own_name");
  for (const k of STOP_KEYS) refused.set(k, "stoplist");
  const junkNames = new Set<string>();
  const junkLabels = new Set<string>();
  const junkDomains = new Set<string>();
  for (const j of input.junk ?? []) {
    if (j.kind === "name") {
      const k = dropTrailing(speechKey(j.value), LEGAL_SUFFIXES);
      if (k) { junkNames.add(k); if (!refused.has(k)) refused.set(k, "junk"); }
    } else if (j.kind === "domain") {
      const d = String(j.value ?? "").trim().toLowerCase().replace(/^www\./, "");
      if (d) junkDomains.add(d);
      const label = domainLabel(d);
      if (label) { junkLabels.add(label); if (!refused.has(label)) refused.set(label, "junk"); }
    }
  }

  const byId = new Map<string, RosterAccount>();
  for (const a of input.accounts ?? []) byId.set(String(a.id), a);
  const isLive = (a: RosterAccount | undefined): boolean =>
    a !== undefined && (a.book === undefined || a.book === null || LIVE_BOOKS.includes(String(a.book)));
  const nameKey = (a: RosterAccount): string => dropTrailing(speechKey(a.name), LEGAL_SUFFIXES);
  const isJunk = (a: RosterAccount): boolean => {
    const k = nameKey(a);
    const d = String(a.domain ?? "").trim().toLowerCase().replace(/^www\./, "");
    return k === "" || refused.has(k) || junkNames.has(k) || (d !== "" && junkDomains.has(d));
  };

  const accounts = new Map<string, IndexedAccount>();
  for (const a of input.accounts ?? []) {
    if (!isLive(a) || isJunk(a)) continue;
    accounts.set(String(a.id), { id: String(a.id), name: String(a.name ?? ""), domain: a.domain ?? null, full: nameKey(a) });
  }
  /** The live account a row speaks for: itself, or the live row a merged one merged into. */
  const target = (id: string | null | undefined): string | null => {
    if (id === null || id === undefined) return null;
    const a = byId.get(String(id));
    if (a === undefined) return null;
    if (isLive(a)) return accounts.has(String(a.id)) ? String(a.id) : null;
    if (String(a.book) === "merged" && a.merged_into) {
      const t = byId.get(String(a.merged_into));
      return t !== undefined && isLive(t) && accounts.has(String(t.id)) ? String(t.id) : null;
    }
    return null;
  };

  const exact = new Map<string, Hit[]>();
  const soft = new Map<string, Hit[]>();
  const tokens = new Map<string, string[]>();
  const usable = (k: string) => k.length >= MIN_KEY_CHARS && !refused.has(k);

  for (const a of input.accounts ?? []) {
    const t = target(a.id);
    if (t === null) continue;
    if (isJunk(a)) continue; // a merged row with a junk name contributes nothing either
    const full = nameKey(a);
    if (!usable(full)) continue;
    const words = full.split(" ");
    if (words.length === 1 && ordinary(full)) {
      push(exact, full, { account: t, basis: "weak" });
    } else {
      push(exact, full, { account: t, basis: "name" });
      const core = dropTrailing(full, TRAILING_GENERIC);
      const coreWords = core.split(" ");
      if (core !== full && usable(core) && (coreWords.length >= 2 || distinctive(core))) {
        push(exact, core, { account: t, basis: "name" });
      }
      if (words.length >= 2 && distinctive(words[0]) && usable(words[0])) {
        push(soft, words[0], { account: t, basis: "token" });
        const list = tokens.get(words[0]);
        if (!list) tokens.set(words[0], [t]);
        else if (!list.includes(t)) list.push(t);
      }
    }
    const label = domainLabel(a.domain);
    if (label !== null && label.length >= MIN_DOMAIN_LABEL && !ordinary(label) && !refused.has(label) && !junkLabels.has(label)) {
      push(soft, label, { account: t, basis: "domain" });
    }
  }

  const bySlug = new Map<string, string>();
  for (const r of input.resolution ?? []) {
    if (r.slug && r.account_id) bySlug.set(String(r.slug), String(r.account_id));
  }
  for (const al of input.aliases ?? []) {
    const t = target(bySlug.get(String(al.slug)));
    if (t === null) continue;
    if (al.alias_type === "name") {
      const k = dropTrailing(speechKey(al.alias), LEGAL_SUFFIXES);
      if (!usable(k)) continue;
      if (k.split(" ").length === 1 && ordinary(k)) push(exact, k, { account: t, basis: "weak" });
      else push(al.authoritative ? exact : soft, k, { account: t, basis: "alias" });
    } else if (al.alias_type === "domain") {
      const label = domainLabel(al.alias);
      if (label !== null && label.length >= MIN_DOMAIN_LABEL && !ordinary(label) && usable(label)) {
        push(soft, label, { account: t, basis: "domain" });
      }
    }
  }

  for (const l of input.learned ?? []) {
    if (l.active === false) continue;
    const t = target(l.account_id);
    if (t === null) continue;
    for (const part of String(l.said_key ?? "").split("|")) {
      const k = speechKey(part);
      if (usable(k)) push(exact, k, { account: t, basis: "learned" });
    }
  }

  const people = new Set<string>();
  for (const p of input.people ?? []) {
    const k = speechKey(p);
    if (!k) continue;
    people.add(k);
    for (const w of k.split(" ")) if (w.length >= 2) people.add(w);
  }

  const poison = new Map<string, Set<string>>();
  for (const pp of input.poison_pairs ?? []) {
    const a = target(bySlug.get(String(pp.slug_a)));
    const b = target(bySlug.get(String(pp.slug_b)));
    if (a === null || b === null || a === b) continue;
    if (!poison.has(a)) poison.set(a, new Set());
    if (!poison.has(b)) poison.set(b, new Set());
    (poison.get(a) as Set<string>).add(b);
    (poison.get(b) as Set<string>).add(a);
  }

  return { accounts, exact, soft, tokens, refused, people, poison };
}

/* ------------------------------------------------------------------ *
 * resolution
 * ------------------------------------------------------------------ */

export interface SurfaceResolution {
  surface: string;
  key: string;
  state: MentionState;
  account_id: string | null;
  matched_on: MatchedOn | null;
  /** Accounts a person may choose between (at most MAX_OPTIONS), the likeliest first. */
  options: string[];
  /** Why it was refused, or what made it ambiguous. */
  reason: string | null;
}

function sortedAccounts(index: RosterIndex, ids: Iterable<string>): string[] {
  const out = [...new Set(ids)].filter((id) => index.accounts.has(id));
  out.sort((a, b) => {
    const na = (index.accounts.get(a) as IndexedAccount).full;
    const nb = (index.accounts.get(b) as IndexedAccount).full;
    return na !== nb ? (na < nb ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
  });
  return out;
}

function withPartners(index: RosterIndex, ids: readonly string[]): string[] {
  const out = [...ids];
  for (const id of ids) {
    for (const p of sortedAccounts(index, index.poison.get(id) ?? [])) if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_OPTIONS);
}

const BASIS_RANK: Record<string, number> = { name: 0, alias: 1, learned: 2, token: 3, domain: 4 };

function fromHits(surface: string, key: string, hits: readonly Hit[], index: RosterIndex, strong: boolean): SurfaceResolution {
  const ids = sortedAccounts(index, hits.map((h) => h.account));
  if (ids.length === 0) return { surface, key, state: "unknown", account_id: null, matched_on: null, options: [], reason: null };
  const weak = hits.some((h) => h.basis === "weak");
  const poisoned = ids.some((id) => (index.poison.get(id)?.size ?? 0) > 0);
  if (ids.length === 1 && !weak && !poisoned) {
    const basis = hits.map((h) => h.basis).sort((a, b) => (BASIS_RANK[a] ?? 9) - (BASIS_RANK[b] ?? 9))[0] as MatchedOn;
    return { surface, key, state: strong ? "resolved" : "suggested", account_id: strong ? ids[0] : null, matched_on: basis, options: [ids[0]], reason: null };
  }
  const reason = ids.length > 1 ? "shared" : weak ? "weak_name" : "poison_pair";
  return { surface, key, state: "ambiguous", account_id: null, matched_on: null, options: withPartners(index, ids), reason };
}

/**
 * One spoken name → what it can be. In order:
 *
 *   refused    shorter than MIN_KEY_CHARS, our own name, a placeholder, junk, or a word of
 *              anyone at this meeting; a lone ordinary word that no account is named;
 *   resolved   a full name, core name, authoritative alias or learned alias of exactly ONE
 *              account (and that account is not one side of a poison pair);
 *   suggested  exactly one account by a distinctive first token, a domain label or a
 *              non-authoritative alias; or, failing all that, a spoken word of four or more
 *              characters that starts a distinctive token and is at least half its length (up to
 *              MAX_PREFIX_OPTIONS offered);
 *   ambiguous  any key two or more accounts hold, a WEAK name, or a poison pair;
 *   unknown    nothing — discussed, not in the book.
 *
 * "folks", "guys", "team" and the like are stripped from the end first, unless the words with
 * them are themselves a key.
 */
export function resolveSurface(surface: string, index: RosterIndex): SurfaceResolution {
  const raw = speechKey(surface);
  const stripped = dropTrailing(raw, FILLER_WORDS);
  const key = index.exact.has(raw) || index.soft.has(raw) || stripped === "" ? raw : stripped;
  const refuse = (reason: string): SurfaceResolution =>
    ({ surface, key, state: "refused", account_id: null, matched_on: null, options: [], reason });

  if (key.length < MIN_KEY_CHARS) return refuse("short");
  const why = index.refused.get(key);
  if (why !== undefined) return refuse(why);
  if (index.people.has(key)) return refuse("person");

  const exact = index.exact.get(key);
  if (exact && exact.length > 0) return fromHits(surface, key, exact, index, true);

  const words = key.split(" ");
  if (words.length === 1 && ordinary(key)) return refuse("ordinary_word");

  const soft = index.soft.get(key) ?? index.soft.get(key.replace(/ /g, ""));
  if (soft && soft.length > 0) return fromHits(surface, key, soft, index, false);

  const prefixed = new Set<string>();
  for (const w of words) {
    if (w.length < MIN_KEY_CHARS || ordinary(w) || STOP_KEYS.has(w) || index.people.has(w)) continue;
    for (const [tok, ids] of index.tokens) {
      if (tok !== w && tok.startsWith(w) && w.length * 2 >= tok.length) for (const id of ids) prefixed.add(id);
    }
  }
  if (prefixed.size > 0) {
    const options = sortedAccounts(index, prefixed).slice(0, MAX_PREFIX_OPTIONS);
    return { surface, key, state: "suggested", account_id: null, matched_on: "prefix", options, reason: null };
  }
  return { surface, key, state: "unknown", account_id: null, matched_on: null, options: [], reason: null };
}

/** One company pass 1 named, after verifySegments. */
export interface VerifiedMention {
  /** The model's own label for it in this reply ("C3"). */
  ref: string;
  /** The words as transcribed, each found on a line the model cited. */
  as_said: string[];
  kind: string;
  segments: Array<{ from: number; to: number }>;
  mention_lines: number[];
}

export interface MentionResolution extends VerifiedMention {
  said_key: string;
  state: MentionState;
  account_id: string | null;
  matched_on: MatchedOn | null;
  options: string[];
  reason: string | null;
  surfaces: SurfaceResolution[];
}

/** The card key for a set of spoken names: their sorted speech keys, "|"-joined. Stable. */
export function saidKeyOf(keys: Iterable<string>): string {
  return [...new Set([...keys].filter(Boolean))].sort().join("|");
}

/**
 * A mention → what it is, from all its spoken forms together. One account resolved and nothing
 * said pointing elsewhere: resolved ("Northgale" is ambiguous on its own, but beside "Northgale
 * Creative" it is not). Two accounts resolved: ambiguous. Otherwise the suggestions, if they agree;
 * ambiguous if they do not; unknown if nothing matched; refused only if every form was refused.
 */
export function resolveMention(mention: VerifiedMention, index: RosterIndex): MentionResolution {
  const surfaces = (mention.as_said ?? []).map((s) => resolveSurface(s, index));
  const live = surfaces.filter((s) => s.state !== "refused");
  const said_key = saidKeyOf((live.length > 0 ? live : surfaces).map((s) => s.key));
  const base = { ...mention, said_key, surfaces };
  const out = (state: MentionState, account_id: string | null, matched_on: MatchedOn | null, options: string[], reason: string | null): MentionResolution =>
    ({ ...base, state, account_id, matched_on, options: options.slice(0, MAX_OPTIONS), reason });

  const resolved = [...new Set(live.filter((s) => s.state === "resolved").map((s) => s.account_id as string))];
  const offered = live.filter((s) => s.state === "suggested" || s.state === "ambiguous");
  const union = (xs: readonly SurfaceResolution[]): string[] => {
    const ids: string[] = [];
    for (const s of xs) for (const o of s.options) if (!ids.includes(o)) ids.push(o);
    return ids;
  };

  if (resolved.length === 1) {
    const a = resolved[0];
    if (offered.every((s) => s.options.includes(a))) {
      const by = live.find((s) => s.state === "resolved" && s.account_id === a) as SurfaceResolution;
      return out("resolved", a, by.matched_on, [a], null);
    }
    return out("ambiguous", null, null, union([...live.filter((s) => s.state === "resolved"), ...offered]), "conflicting_names");
  }
  if (resolved.length > 1) {
    return out("ambiguous", null, null, union(live.filter((s) => s.state === "resolved" || s.state === "suggested" || s.state === "ambiguous")), "conflicting_names");
  }
  if (offered.length > 0) {
    const allSuggested = offered.every((s) => s.state === "suggested");
    const tops = [...new Set(offered.map((s) => s.options[0]))];
    if (allSuggested && tops.length === 1 && offered.every((s) => s.options.length === 1 || s.matched_on === "prefix")) {
      return out("suggested", null, offered[0].matched_on, union(offered), null);
    }
    return out("ambiguous", null, null, union(offered), offered.find((s) => s.reason)?.reason ?? "conflicting_names");
  }
  if (live.length > 0) return out("unknown", null, null, [], null);
  return out("refused", null, null, [], surfaces[0]?.reason ?? "no_name");
}

/* ------------------------------------------------------------------ *
 * pass-1 verification and clustering
 * ------------------------------------------------------------------ */

/** What verifySegments needs of a transcript line. */
export interface SpokenLine {
  n: number;
  text: string;
}

export const MAX_COMPANIES = 60;
export const MAX_AS_SAID = 5;
export const MAX_SEGMENTS = 12;
export const MAX_MENTION_LINES = 20;

/**
 * How far a company's lines reach from a line its name was verified on: this many before, and
 * MENTION_REACH_LINES after. A segment is the model's own range, and its lines are what pass 2
 * treats as this company's (planBatches' ownership). A range that runs on over the next discussion
 * would hand those lines to this company, and if pass 1 did not list the company actually being
 * discussed there, nothing else owns them to flag the overlap — so a quote about it would verify
 * as this one's. Talk runs on after a name far more than it runs ahead of one ("they", "their
 * owner"), hence the asymmetry. A first setting, to be re-cut from the dry runs' counters
 * (pass1.segment_lines_trimmed).
 */
export const MENTION_LEAD_LINES = 5;
export const MENTION_REACH_LINES = 30;

export interface SegmentVerification {
  mentions: VerifiedMention[];
  counters: Record<string, number>;
  notes: string[];
}

function bump(c: Record<string, number>, k: string, by = 1): void {
  c[k] = (c[k] ?? 0) + by;
}

/** The surface really is on this line, as whole words. */
export function surfaceOnLine(lineText: string, surface: string): boolean {
  const l = normalizeForQuote(lineText);
  const s = normalizeForQuote(surface);
  if (s === "") return false;
  for (let i = l.indexOf(s); i >= 0; i = l.indexOf(s, i + 1)) {
    const before = i === 0 ? "" : l[i - 1];
    const after = l[i + s.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

function intList(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v.slice(0, max)) {
    const n = Number(x);
    if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The parts of [from, to] within MENTION_LEAD_LINES before or MENTION_REACH_LINES after one of
 * `mentions` (sorted ascending), in order. Never empty when the range holds a mention line.
 */
export function nearMentions(from: number, to: number, mentions: readonly number[]): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const m of mentions) {
    const a = Math.max(from, m - MENTION_LEAD_LINES);
    const b = Math.min(to, m + MENTION_REACH_LINES);
    if (a > b) continue;
    const prev = out[out.length - 1];
    if (prev && a <= prev.to + 1) prev.to = Math.max(prev.to, b);
    else out.push({ from: a, to: b });
  }
  return out;
}

/**
 * Pass 1's reply → the mentions the transcript supports.
 *
 *   · a kind other than agency or unclear is dropped (counted by kind);
 *   · a spoken form survives only if it is on at least one line the model cited for that company,
 *     and a cited line survives only if one surviving form is on it — so neither a name nor a
 *     line can be invented;
 *   · a segment is clipped to the transcript and kept only if it holds a surviving line, and then
 *     only within MENTION_LEAD_LINES before and MENTION_REACH_LINES after a surviving line (the
 *     lines cut are counted, segment_lines_trimmed); kept segments are merged where they touch;
 *   · a company left with no form or no segment is dropped.
 */
export function verifySegments(raw: unknown, lines: readonly SpokenLine[]): SegmentVerification {
  const counters: Record<string, number> = {};
  const notes: string[] = [];
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { companies?: unknown }).companies)
    ? (raw as { companies: unknown[] }).companies
    : null;
  if (list === null) {
    bump(counters, "unreadable_response");
    notes.push("pass 1 did not return a companies array; nothing taken from it.");
    return { mentions: [], counters, notes };
  }
  const byN = new Map<number, string>();
  let first = Infinity, last = -Infinity;
  for (const l of lines ?? []) {
    byN.set(l.n, l.text);
    first = Math.min(first, l.n);
    last = Math.max(last, l.n);
  }
  if (list.length > MAX_COMPANIES) {
    bump(counters, "over_company_cap", list.length - MAX_COMPANIES);
    notes.push(`pass 1 named ${list.length} companies; only the first ${MAX_COMPANIES} are read.`);
  }

  const mentions: VerifiedMention[] = [];
  for (const item of list.slice(0, MAX_COMPANIES)) {
    if (!item || typeof item !== "object") { bump(counters, "malformed_company"); continue; }
    const c = item as Record<string, unknown>;
    const ref = typeof c.ref === "string" && c.ref.trim() ? c.ref.trim() : `C${mentions.length + 1}`;
    const kind = typeof c.kind === "string" ? c.kind : "";
    if (!READ_KINDS.includes(kind)) { bump(counters, `kind_${kind || "missing"}`); continue; }

    const said = Array.isArray(c.as_said)
      ? [...new Set(c.as_said.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()))].slice(0, MAX_AS_SAID)
      : [];
    const cited = intList(c.mention_lines, MAX_MENTION_LINES).filter((n) => byN.has(n));
    const forms = said.filter((s) => cited.some((n) => surfaceOnLine(byN.get(n) as string, s)));
    if (forms.length < said.length) bump(counters, "as_said_not_on_line", said.length - forms.length);
    const verified = cited.filter((n) => forms.some((s) => surfaceOnLine(byN.get(n) as string, s))).sort((a, b) => a - b);
    if (forms.length === 0 || verified.length === 0) { bump(counters, "mention_unverified"); continue; }

    const segs: Array<{ from: number; to: number }> = [];
    const rawSegs = Array.isArray(c.segments) ? c.segments.slice(0, MAX_SEGMENTS) : [];
    for (const s of rawSegs) {
      if (!s || typeof s !== "object") continue;
      let from = Number((s as Record<string, unknown>).from);
      let to = Number((s as Record<string, unknown>).to);
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      if (from > to) [from, to] = [to, from];
      from = Math.max(from, first);
      to = Math.min(to, last);
      if (from > to) continue;
      if (!verified.some((n) => n >= from && n <= to)) { bump(counters, "segment_without_mention"); continue; }
      const near = nearMentions(from, to, verified);
      const cut = to - from + 1 - near.reduce((k, r) => k + r.to - r.from + 1, 0);
      if (cut > 0) { bump(counters, "segment_trimmed"); bump(counters, "segment_lines_trimmed", cut); }
      segs.push(...near);
    }
    segs.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: Array<{ from: number; to: number }> = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      if (prev && s.from <= prev.to + 1) prev.to = Math.max(prev.to, s.to);
      else merged.push({ ...s });
    }
    if (merged.length === 0) { bump(counters, "no_segment"); continue; }

    bump(counters, "mentions_verified");
    mentions.push({ ref, as_said: forms, kind, segments: merged, mention_lines: verified });
  }
  return { mentions, counters, notes };
}

/** One agency card's worth of discussion: every mention of one account, or of one spoken name. */
export interface MentionCluster {
  /** A1, A2 … in discussion order. What pass 2 and every proposal row call it. */
  ref: string;
  state: MentionState;
  account_id: string | null;
  matched_on: MatchedOn | null;
  options: string[];
  reason: string | null;
  said_as: string[];
  said_key: string;
  segments: Array<{ from: number; to: number }>;
  mention_lines: number[];
  first_line: number;
  /** The pass-1 refs merged into it. */
  sources: string[];
}

/** Which card a mention joins: its account when resolved, else its state and spoken name. */
function cardKey(r: MentionResolution): string {
  return r.state === "resolved" && r.account_id ? `acct:${r.account_id}` : `said:${r.state}:${r.said_key}`;
}

/**
 * Resolved mentions of one account become one cluster; every other mention clusters by its
 * said_key, so the same unplaced name said twice is one "Who is this?" chip, and placing it later
 * never needs a re-read. Clusters come back in DISCUSSION ORDER — first line — with refs A1..An.
 * Unknown and refused clusters are kept (the header lists them) but pass 2 never reads them.
 */
export function clusterMentions(resolutions: readonly MentionResolution[]): MentionCluster[] {
  const groups = new Map<string, MentionResolution[]>();
  for (const r of resolutions ?? []) {
    const k = cardKey(r);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }

  const clusters: Array<Omit<MentionCluster, "ref">> = [];
  for (const members of groups.values()) {
    const head = members[0];
    const said_as: string[] = [];
    const keys: string[] = [];
    const lines = new Set<number>();
    const segs: Array<{ from: number; to: number }> = [];
    const options: string[] = [];
    for (const m of members) {
      for (const s of m.as_said) if (!said_as.includes(s)) said_as.push(s);
      for (const s of m.surfaces) if (s.state !== "refused" || m.state === "refused") keys.push(s.key);
      for (const n of m.mention_lines) lines.add(n);
      segs.push(...m.segments.map((s) => ({ ...s })));
      for (const o of m.options) if (!options.includes(o)) options.push(o);
    }
    segs.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: Array<{ from: number; to: number }> = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      if (prev && s.from <= prev.to + 1) prev.to = Math.max(prev.to, s.to);
      else merged.push(s);
    }
    const mention_lines = [...lines].sort((a, b) => a - b);
    clusters.push({
      state: head.state,
      account_id: head.state === "resolved" ? head.account_id : null,
      matched_on: head.matched_on,
      options: options.slice(0, MAX_OPTIONS),
      reason: head.reason,
      said_as,
      said_key: saidKeyOf(keys),
      segments: merged,
      mention_lines,
      first_line: Math.min(merged[0]?.from ?? Infinity, mention_lines[0] ?? Infinity),
      sources: members.map((m) => m.ref),
    });
  }
  clusters.sort((a, b) => a.first_line - b.first_line || (a.said_key < b.said_key ? -1 : a.said_key > b.said_key ? 1 : 0));
  return clusters.map((c, i) => ({ ref: `A${i + 1}`, ...c }));
}

/* ------------------------------------------------------------------ *
 * one company across pass-1 windows
 * ------------------------------------------------------------------ */

export interface WindowJoin {
  /** Every mention, flat and in window order; the ones joined across windows placed. */
  resolutions: MentionResolution[];
  /** joined_same_lines · joined_by_name · conflicting_names (mentions) · offered_first (cards). */
  counters: Record<string, number>;
}

/**
 * A long meeting goes to pass 1 in overlapping windows (meeting_transcript.windowsFor), each a call
 * that sees only its own lines. Inside ONE window the model puts every form of a company in one
 * entry ("Vorn Digital" and "Vorn"), and resolveMention places the short form BESIDE the whole name.
 * A window that only ever hears the short form cannot: "Vorn" alone is unknown (one word under
 * MIN_TOKEN), "Orange" alone an ordinary word, a distinctive token alone only a suggestion. Grouped
 * by account or by spoken name, it would become a second card whose lines are owned against the real
 * one — and, when unknown, never read, so the team's later word on the agency would be lost.
 *
 * This puts back what one window would have done, from evidence IN THIS MEETING, and only ACROSS
 * windows: a mention is joined to an account resolved in ANOTHER window, never to one its own window
 * resolved too (that window's model saw both and kept them apart, as one window's would), so a
 * meeting read in one window comes back unchanged.
 *
 * Meeting-local keys, each kept only while exactly one account holds it — and NO OTHER live account
 * of the roster has it as a word (or run of words) of its name, holds it as a key, or was offered
 * for it, whether or not this meeting named that account:
 *   · said beside — every form a RESOLVED mention carried beside its resolving name (live forms,
 *     and an ordinary word that is a word of the account's own name: "Orange" beside "Orange
 *     Wyvernhold");
 *   · the account's own short name — the core, or the first word, of a name this meeting resolved,
 *     when it is one word of MIN_KEY_CHARS or more that is not ordinary ("Vorn" of "Vorn Digital");
 *   never a key the index refuses (our names, placeholders, junk), a word of anyone at the meeting,
 *   a key shorter than MIN_KEY_CHARS, or an account with a poison partner. So "Vorn" said beside
 *   "Vorn Digital" is no key while "Vorn Partners Group" is live, and "Zell" grouped by one window
 *   with "Vorn Digital" is no key while "Zell Creative" is: a word two accounts share is never
 *   placed by the join.
 *
 * Then, for a mention its own window could not place:
 *   · the same sighting — every line it cites was cited, in another window, by ONE resolved mention
 *     that also carried every one of its forms (the overlap, seen twice): resolved to that mention's
 *     account, whatever its own state, because that other window's model grouped those very words on
 *     those very lines. Never pooled: lines one mention cited and words another carried are not it;
 *   · unknown, suggested, or refused only as an ordinary word — resolved when every form it has
 *     points at the same account of this meeting (a meeting-local key, or a roster suggestion that
 *     offers it) and every suggestion offers that account ALONE, in words no other live account's
 *     name has. A suggestion that also offers another account (a prefix of two accounts' tokens), or
 *     whose word another name has, is the roster saying the word is shared: the mention is never
 *     placed, it stays a suggestion with the meeting's account offered first. A form that points
 *     nowhere ("Vorn Labs") leaves the mention as it was; forms that point at two accounts, or a
 *     suggestion for another account only, make it AMBIGUOUS (conflicting_names) with the meeting's
 *     accounts offered first, as resolveMention does with two names in one entry;
 *   · ambiguous (a token two accounts share) — never joined: it stays a "Who is this?" card, with the
 *     account this meeting named moved to the front of its options.
 * Offered first is decided per CARD (one per state and spoken name, as clusterMentions groups them):
 * an account goes first only when every mention of the card would put it there, so a card holding a
 * mention its own window listed apart from that account keeps the roster's order.
 * A joined mention takes the basis its account was resolved on in this meeting, never 'learned': no
 * person confirmed it. When the account was resolved only on a learned alias, it takes the basis of its
 * own evidence instead ('token', or the suggestion's own).
 *
 * What it cannot join: a form that is neither a word of the name nor ever said beside it, heard only
 * in a window that never heard the name — a nickname, a mistranscription ("Vron"). That stays its own
 * card (unknown, so listed but not read): the known limit, and why the windows overlap.
 */
export function joinAcrossWindows(perWindow: readonly (readonly MentionResolution[])[], index: RosterIndex): WindowJoin {
  const counters: Record<string, number> = {};
  const all: Array<{ r: MentionResolution; w: number }> = [];
  (perWindow ?? []).forEach((list, w) => { for (const r of list ?? []) all.push({ r, w }); });
  if ((perWindow ?? []).length < 2) return { resolutions: all.map((x) => x.r), counters };

  const keyable = (k: string): boolean => k.length >= MIN_KEY_CHARS && !index.refused.has(k) && !index.people.has(k);
  const nameWords = (a: string): string[] => (index.accounts.get(a)?.full ?? "").split(" ").filter(Boolean);
  const plainWord = (k: string): boolean =>
    /^[a-z][a-z0-9]*$/.test(k) && !TRAILING_GENERIC.includes(k) && !FILLER_WORDS.includes(k) && !STOP_KEYS.has(k);
  /** The forms of a mention that can carry it: live ones, and an ordinary word of an account's name. */
  const ordinaryOf = (s: SurfaceResolution): boolean => s.state === "refused" && s.reason === "ordinary_word" && plainWord(s.key);

  /* What the resolved mentions say: which windows resolved each account, on what basis, which lines
     each cited, and which forms each carried beside its name. */
  const resolvedIn = new Map<string, Set<number>>();
  const basisOf = new Map<string, MatchedOn>();
  /** Each resolved mention on its own: its account, window, the lines it cited and the forms it carried. */
  const sightings: Array<{ a: string; w: number; lines: Set<number>; forms: Set<string> }> = [];
  const beside = new Map<string, Set<string>>(); // account → forms it was said with
  const offeredWith = new Map<string, Set<string>>(); // such a form → every account the roster offered for it
  for (const { r, w } of all) {
    if (r.state !== "resolved" || !r.account_id || !index.accounts.has(r.account_id)) continue;
    const a = r.account_id;
    if (!resolvedIn.has(a)) resolvedIn.set(a, new Set());
    (resolvedIn.get(a) as Set<number>).add(w);
    /* Never 'learned' (or 'person'): a joined mention's own words were confirmed by nobody. */
    const b = r.matched_on;
    const prev = basisOf.get(a);
    if (b !== null && b !== "learned" && b !== "person" && (prev === undefined || (BASIS_RANK[b] ?? 9) < (BASIS_RANK[prev] ?? 9))) basisOf.set(a, b);
    if (!beside.has(a)) beside.set(a, new Set());
    const forms = beside.get(a) as Set<string>;
    const own = new Set<string>();
    const words = nameWords(a);
    for (const s of r.surfaces) {
      if (!keyable(s.key)) continue;
      if (s.state !== "refused" || (ordinaryOf(s) && words.includes(s.key))) {
        forms.add(s.key);
        own.add(s.key);
        if (!offeredWith.has(s.key)) offeredWith.set(s.key, new Set());
        for (const o of s.options) (offeredWith.get(s.key) as Set<string>).add(o);
      }
    }
    sightings.push({ a, w, lines: new Set(r.mention_lines), forms: own });
  }

  /* The meeting-local keys. The ROSTER holds a key too: every live account that has it as a word, or
     a run of words, of ANY name the index knows it by — its current name, a merged row's name, an
     alias, a learned alias, a token or domain label — or that the index holds it for. A key another
     live account holds is never this meeting's, whichever account the meeting said it beside — so
     "Vorn", said beside "Vorn Digital", is no key while "Vorn Partners Group" is on the roster, named
     in this meeting or not, nor while "Vorn Partners" is a merged row or an alias of another account;
     and a word the model grouped with the wrong name ("Zell" beside "Vorn Digital") cannot carry Zell
     Creative's later discussion onto Vorn Digital's card. */
  const rosterHolders = new Map<string, string[]>();
  const heldBy = (k: string): string[] => {
    let ids = rosterHolders.get(k);
    if (ids === undefined) {
      const set = new Set<string>();
      const padded = ` ${k} `;
      for (const acc of index.accounts.values()) if (` ${acc.full} `.includes(padded)) set.add(acc.id);
      /* Every key the index holds is a name some live account is known by (a merged row's, an alias's,
         a learned one's already redirected to the account it speaks for): a word of it is held too. */
      for (const map of [index.exact, index.soft]) {
        for (const [key, hits] of map) if (` ${key} `.includes(padded)) for (const h of hits) set.add(h.account);
      }
      ids = [...set];
      rosterHolders.set(k, ids);
    }
    return ids;
  };
  /* resolveSurface matches a split word on its de-spaced form ("Brindle Cot" on the token
     "brindlecot"), so the roster is asked about that form too: a transcript that splits a word
     another account's name has must not slip past the check the whole word would fail. */
  const othersFor = (k: string, a: string): string[] => {
    const joined = k.replace(/ /g, "");
    const ids = joined === k ? heldBy(k) : [...new Set([...heldBy(k), ...heldBy(joined)])];
    return ids.filter((x) => x !== a);
  };
  const holders = new Map<string, Set<string>>();
  const hold = (k: string, a: string) => {
    if (!holders.has(k)) holders.set(k, new Set());
    (holders.get(k) as Set<string>).add(a);
  };
  for (const [a, forms] of beside) {
    for (const k of forms) {
      hold(k, a);
      for (const b of othersFor(k, a)) hold(k, b);
      for (const b of offeredWith.get(k) ?? []) hold(k, b);
    }
  }
  for (const a of resolvedIn.keys()) {
    const acc = index.accounts.get(a) as IndexedAccount;
    const words = nameWords(a);
    const core = dropTrailing(acc.full, TRAILING_GENERIC);
    const own = new Set<string>();
    if (!core.includes(" ")) own.add(core);
    if (words.length >= 2) own.add(words[0]);
    for (const k of own) {
      if (!keyable(k) || !plainWord(k) || ordinary(k)) continue;
      if (othersFor(k, a).length > 0) continue;
      hold(k, a);
    }
  }
  const local = new Map<string, string>();
  for (const [k, as] of holders) {
    if (as.size !== 1) continue;
    const a = [...as][0];
    if ((index.poison.get(a)?.size ?? 0) > 0) continue;
    local.set(k, a);
  }

  /* The basis its account was resolved on in this meeting; when that was only a learned alias, the
     basis of the joined mention's own evidence ('token' for a word of the name or a form said beside
     it, a suggestion's own basis otherwise) — never 'learned', which says a person confirmed it. */
  const placed = (r: MentionResolution, a: string, own: MatchedOn): MentionResolution =>
    ({ ...r, state: "resolved", account_id: a, matched_on: basisOf.get(a) ?? own, options: [a], reason: null });
  const ownBasis = (forms: readonly SurfaceResolution[]): MatchedOn => {
    const bs = forms.map((s): MatchedOn => (local.has(s.key) || s.matched_on === null || s.matched_on === "learned" || s.matched_on === "person" ? "token" : s.matched_on));
    return bs.sort((x, y) => (BASIS_RANK[x] ?? 9) - (BASIS_RANK[y] ?? 9))[0] ?? "token";
  };

  const out: MentionResolution[] = [];
  /** Per mention left unplaced as it was: the accounts its own decision would offer first. */
  const firstFor = new Map<number, string[]>();
  const keep = (r: MentionResolution, front: string[]): void => {
    firstFor.set(out.length, front);
    out.push(r);
  };
  for (const { r, w } of all) {
    if (r.state === "resolved") { out.push(r); continue; }
    /** Resolved in another window, and not in this one. */
    const elsewhere = (a: string): boolean => {
      const ws = resolvedIn.get(a);
      return ws !== undefined && !ws.has(w);
    };
    const forms = r.surfaces.filter((s) => s.state !== "refused" || (ordinaryOf(s) && local.has(s.key)));

    /* The same sighting: the overlap, where ONE resolved mention of another window cited every one of
       these lines AND carried every one of these words. Never pooled across mentions: a line one
       mention cited and a word another mention carried, elsewhere in the meeting, are not a sighting —
       so "Zell" grouped with "Vorn Digital" on other lines cannot carry Zell on this line onto it. */
    if (forms.length > 0 && r.mention_lines.length > 0) {
      const same = [...new Set(sightings.filter((q) =>
        q.w !== w && elsewhere(q.a) &&
        r.mention_lines.every((n) => q.lines.has(n)) &&
        forms.every((s) => q.forms.has(s.key))).map((q) => q.a))];
      if (same.length === 1) {
        out.push(placed(r, same[0], "token"));
        bump(counters, "joined_same_lines");
        continue;
      }
    }

    if (r.state === "ambiguous") {
      const named = new Set<string>();
      for (const s of forms) {
        const a = local.get(s.key);
        if (a !== undefined && elsewhere(a)) named.add(a);
        for (const o of s.options) if (elsewhere(o)) named.add(o);
      }
      keep(r, r.options.filter((o) => named.has(o)));
      continue;
    }

    /* unknown, suggested, or refused as an ordinary word */
    const targets: string[] = [];
    const offers: string[] = [];
    let stray = forms.length === 0;
    let blocked = false;
    for (const s of forms) {
      if (s.state === "suggested") for (const o of s.options) if (!offers.includes(o)) offers.push(o);
      const a = local.get(s.key);
      if (a !== undefined) {
        if (!elsewhere(a)) blocked = true;
        else if (!targets.includes(a)) targets.push(a);
        continue;
      }
      const hit = s.state === "suggested" ? s.options.filter(elsewhere) : [];
      if (hit.length === 0) stray = true;
      for (const o of hit) if (!targets.includes(o)) targets.push(o);
    }
    if (blocked || stray || targets.length === 0) { keep(r, []); continue; }
    const t = targets[0];
    /* A roster suggestion carries a mention only when it is evidence for t ALONE: it offers t and no
       other account, and no other live account has its words. One that also offers another account
       (a prefix of two accounts' tokens) or whose word another name has ("Brindlecot" of "Harrow
       Brindlecot Studio") is the roster saying the word is shared: never placed, t offered first. */
    const solely = (s: SurfaceResolution): boolean =>
      s.options.length === 1 && s.options[0] === t && othersFor(s.key, t).length === 0;
    if (targets.length === 1 && forms.every((s) => s.state !== "suggested" || solely(s))) {
      out.push(placed(r, t, ownBasis(forms)));
      bump(counters, "joined_by_name");
      continue;
    }
    if (targets.length === 1 && forms.every((s) => s.state !== "suggested" || s.options.includes(t))) {
      keep(r, [t]);
      continue;
    }
    const options = [...targets, ...offers.filter((o) => !targets.includes(o))].filter((o) => index.accounts.has(o)).slice(0, MAX_OPTIONS);
    out.push({ ...r, state: "ambiguous", account_id: null, matched_on: null, options, reason: "conflicting_names" });
    bump(counters, "conflicting_names");
  }

  /* Offered first, per CARD. clusterMentions makes one card of every unplaced mention with the same
     state and said_key, and takes its options head first; so the order is decided for the card, not
     for one of its mentions. An account goes first only when EVERY mention of the card would put it
     there — resolved only in windows none of them came from. A card holding a mention its own window
     listed apart from the account it named keeps the roster's order (that window's model saw both and
     kept them apart), every mention of a card carries the same order, and offered_first counts cards
     whose order moved — what the stored card shows. */
  const cards = new Map<string, number[]>();
  for (const i of firstFor.keys()) {
    const r = out[i];
    if (r.state !== "ambiguous" && r.state !== "suggested") continue;
    const k = cardKey(r);
    if (!cards.has(k)) cards.set(k, []);
    (cards.get(k) as number[]).push(i);
  }
  for (const members of cards.values()) {
    const common = (firstFor.get(members[0]) as string[]).filter((a) => members.every((i) => (firstFor.get(i) as string[]).includes(a)));
    let moved = false;
    for (const i of members) {
      const r = out[i];
      const front = common.filter((a) => r.options.includes(a));
      const reordered = [...front, ...r.options.filter((o) => !front.includes(o))];
      if (reordered.some((o, j) => o !== r.options[j])) {
        out[i] = { ...r, options: reordered };
        moved = true;
      }
    }
    if (moved) bump(counters, "offered_first");
  }
  return { resolutions: out, counters };
}
