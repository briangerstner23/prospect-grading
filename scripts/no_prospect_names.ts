/**
 * Rule 2, made mechanical: no prospect or staff name may appear in a tracked file.
 *
 * The repository is public. Every breach so far (DECISIONS §23 — 26 agency names over five days)
 * entered as an *example* in prose, which is why reading the diff never caught it: each one looked
 * like exactly the concrete detail that makes a ruling legible. It is. It just has to be shaped
 * rather than named.
 *
 * The roster cannot live here — it IS the prospect data — so it is passed in:
 *
 *   select string_agg(name, E'\n' order by name) from public.pb_accounts where name is not null;
 *   node --experimental-strip-types scripts/no_prospect_names.ts /tmp/roster.txt
 *
 * Exit 0 clean · 1 a name was found · 2 no roster was given (never silently "pass").
 *
 * TWO SHAPES THE FIRST VERSION COULD NOT SEE (both found by hand in docs/DECISIONS.md on
 * 18 Sep 2026, while this script reported clean):
 *
 *   1. A multi-word name broken across a line break — the first word ended one line and the rest
 *      began the next. The roster holds a space where the file holds a newline, so a match against
 *      the raw text never fired. Fixed by NORMALISING the scanned text: every run of whitespace,
 *      newlines included, collapses to one space before matching. Line numbers survive it — the
 *      normaliser carries an index back to the original text for every character it keeps.
 *   2. A name referred to by its first word only ("Firstword", where the roster says
 *      "Firstword Something, Inc"). Only whole roster entries were matched. Fixed by also matching
 *      each entry's FIRST TOKEN, under three guards so the check does not cry wolf:
 *        · at least MIN_TOKEN characters,
 *        · not in GENERIC (the ordinary-English account names, reused as-is),
 *        · not in FIRST_TOKEN_ALLOW (ordinary words that lead a great many agency names).
 *      A token match prints the token AND the roster entry it came from, because a first word is
 *      circumstantial where a full name is not: a reader has to be able to judge it.
 *
 * Matching stays case-sensitive on word boundaries. Case-insensitive would drown in false
 * positives: the roster holds "Agency", "Momentum", "Snap", "Test" and "None" as literal account
 * names. Those are in GENERIC below and skipped, because a rule that cries wolf is a rule nobody
 * runs. An entry dropped by GENERIC contributes no first token either — that is deliberate, and it
 * is what keeps an entry like "second mile" from turning "second" into a rule.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Account names that are ordinary English and would match everywhere. */
const GENERIC = new Set([
  "agency", "agencies", "test", "none", "individual", "confidential", "outsourced", "unincorporated",
  "momentum", "snap", "snapshot", "wonder", "haystack", "watermark", "avenue", "mega", "metropolis",
  "nomadic", "shift", "the deal", "the fold", "the escape", "illuminated", "intrigue", "techies",
  "moor", "unity", "not yet", "tbd", "good company", "second mile", "the machine", "franco",
]);

/**
 * Ordinary English. A first word in here is never reported on its own, because matching it would
 * flag this repository's own prose rather than a reference to an account.
 *
 * **The rule for adding a word: it is ordinary English, used here in its ordinary sense. Never
 * because a particular finding was inconvenient.** The first run of the first-word rule against
 * the live roster made the distinction concrete: 453 hits over 24 words, of which 23 were this
 * repository writing English (a tier name, a TypeScript global, a journey stage, the start of a
 * sentence) and one was a real breach — an account named by its first word alone, three times, in
 * a passage about that account. Allowlisting all 24 would have made the check green and useless.
 *
 * Every word here is a blind spot: an account whose name starts with it is caught only by its
 * whole name. That is the trade this check makes to stay worth running. Given names and words
 * that read as a brand stay out, because those are exactly the cases a reader must look at.
 */
const FIRST_TOKEN_ALLOW = new Set([
  // What agency names are made of.
  "digital", "agency", "marketing", "creative", "design", "content", "social", "studio", "brand",
  "media", "branding", "consulting", "advertising", "partners", "partner", "communications",
  "interactive", "collective", "solutions", "solution", "strategy", "ventures", "graphics",
  // The book's own vocabulary: tiers, bands, reads, the things it writes about all day.
  "silver", "bronze", "platinum", "signal", "signals", "evidence", "potential", "anticipated",
  "override", "rubric", "prospect", "account", "accounts", "engine", "register", "roster",
  "ranking", "grading", "promotion", "delivery", "revenue", "website", "webhook", "request",
  "response", "fixture", "artifact", "migration", "identity", "candidate", "confidence",
  "crypto",
  // Ordinary English and ordinary technical English, six letters or more.
  "address", "advanced", "against", "already", "analysis", "another", "answer", "anything",
  "appear", "applied", "approach", "archive", "around", "article", "assign", "attempt", "author",
  "average", "backup", "balance", "before", "behind", "believe", "benefit", "better", "between",
  "beyond", "billing", "branch", "broken", "browser", "budget", "builder", "building", "business",
  "button", "cannot", "capital", "capture", "center", "central", "certain", "change", "changes",
  "channel", "charge", "choice", "choose", "circle", "client", "clients", "closed", "collect",
  "column", "combine", "coming", "command", "comment", "commerce", "common", "company", "compare",
  "complete", "concept", "concern", "confirm", "connect", "consider", "console", "contact",
  "contain", "context", "continue", "contract", "control", "convert", "correct", "counter",
  "course", "create", "created", "credit", "current", "custom", "customer", "dashboard",
  "database", "decide", "decision", "declare", "default", "define", "degree", "delete", "deliver",
  "demand", "depend", "deploy", "describe", "desktop", "detail", "details", "detect", "develop",
  "device", "direct", "direction", "director", "display", "distance", "district", "domain",
  "double", "during", "dynamic", "easier", "editor", "effect", "effort", "either", "element",
  "enable", "energy", "engage", "enough", "ensure", "entire", "entity", "escape", "events",
  "everything", "exactly", "example", "except", "exchange", "execute", "exists", "expand",
  "expect", "expert", "explain", "export", "express", "extend", "external", "extract", "factor",
  "failed", "failure", "family", "feature", "figure", "filter", "finally", "finance", "finding",
  "finish", "folder", "follow", "forecast", "format", "former", "formula", "forward", "freedom",
  "friend", "friends", "frozen", "function", "further", "future", "gather", "general", "generate",
  "global", "ground", "growth", "handle", "happen", "header", "health", "helper", "hidden",
  "higher", "history", "holding", "however", "ignore", "images", "impact", "import", "improve",
  "include", "income", "increase", "indeed", "industry", "initial", "inline", "inside", "insight",
  "install", "instead", "integer", "intent", "interest", "internal", "invalid", "invoice",
  "island", "itself", "keyword", "landing", "language", "larger", "largest", "latest", "launch",
  "leader", "leading", "leaving", "legacy", "length", "lesson", "letter", "library", "license",
  "likely", "limited", "linear", "listen", "little", "living", "loading", "locale", "locate",
  "location", "logging", "logical", "longer", "looking", "machine", "manage", "manager", "manual",
  "mapping", "margin", "market", "master", "matter", "matters", "maximum", "meaning", "measure",
  "medium", "member", "memory", "mention", "message", "method", "middle", "migrate", "minimum",
  "minute", "mirror", "mission", "mobile", "modern", "module", "moment", "monitor", "mostly",
  "moving", "multiple", "narrow", "native", "natural", "nearly", "needed", "network", "neutral",
  "normal", "nothing", "notice", "number", "object", "obtain", "obvious", "office", "offset",
  "online", "opened", "opening", "operate", "option", "orange", "organic", "origin", "outdoor",
  "outline", "output", "overall", "package", "parent", "partial", "passed", "pattern", "payment",
  "pending", "people", "percent", "perfect", "period", "person", "phrase", "picture", "planning",
  "platform", "please", "plugin", "policy", "portal", "portion", "position", "possible", "posted",
  "practice", "precise", "predict", "prefer", "prefix", "premium", "prepare", "present", "pretty",
  "prevent", "preview", "primary", "private", "problem", "process", "produce", "product",
  "profile", "profit", "program", "project", "promise", "prompt", "proper", "propose", "protect",
  "provide", "public", "publish", "purpose", "quality", "quarter", "question", "quickly", "random",
  "rather", "reader", "reading", "reason", "receive", "recent", "record", "reduce", "reform",
  "refresh", "refuse", "regard", "region", "regular", "reject", "relate", "release", "remain",
  "remote", "remove", "render", "repair", "repeat", "replace", "report", "require", "research",
  "reserve", "resolve", "resource", "respond", "restore", "result", "retain", "return", "reverse",
  "review", "revise", "routine", "running", "safety", "sample", "schedule", "schema", "school",
  "science", "screen", "script", "search", "season", "second", "secret", "section", "sector",
  "secure", "select", "seller", "sender", "senior", "series", "serious", "server", "service",
  "session", "setting", "several", "shadow", "shared", "sharing", "should", "similar", "simple",
  "simply", "single", "slight", "society", "software", "source", "special", "specific", "spread",
  "square", "stable", "staging", "standard", "starting", "static", "station", "status", "storage",
  "stored", "stream", "street", "strict", "string", "strong", "student", "submit", "subject",
  "success", "suggest", "summary", "supply", "support", "suppose", "surface", "survey", "switch",
  "symbol", "system", "target", "template", "terminal", "testing", "theory", "though", "thread",
  "through", "ticket", "timing", "toggle", "toward", "tracking", "traffic", "transfer", "travel",
  "trigger", "trouble", "trusted", "typical", "unable", "unique", "united", "unless", "update",
  "upgrade", "upload", "useful", "utility", "values", "vendor", "verify", "version", "vertical",
  "viewer", "virtual", "visible", "vision", "visual", "volume", "waiting", "wanted", "warning",
  "watching", "weather", "weekly", "weight", "welcome", "whatever", "whether", "window", "winning",
  "within", "without", "wonder", "worker", "working", "writer", "writing", "written", "yellow",
]);

/** A first token shorter than this is too weak to stand on its own as evidence of a name. */
const MIN_TOKEN = 6;

const EXTS = [".md", ".ts", ".sql", ".json", ".html", ".sh", ".txt", ".yml", ".yaml"];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collapse every run of whitespace to one space, keeping a map back to the original offsets so a
 * match can still be reported at the line it was written on. `origin[i]` is the index in `text` of
 * the character that became the flattened text's character `i`; a collapsed run maps to its start.
 */
function normalise(text: string): { text: string; origin: Int32Array } {
  const flat = text.replace(/\s+/g, " ");
  const origin = new Int32Array(flat.length);
  const runs = /\s+/g;
  let j = 0;
  let prev = 0;
  let m: RegExpExecArray | null;
  while ((m = runs.exec(text)) !== null) {
    for (let k = prev; k < m.index; k++) origin[j++] = k;
    origin[j++] = m.index;
    prev = m.index + m[0].length;
  }
  for (let k = prev; k < text.length; k++) origin[j++] = k;
  // The walk above and the replace above must agree, or every line number below is a fiction.
  if (j !== flat.length) throw new Error(`normalise: mapped ${j} of ${flat.length} characters`);
  return { text: flat, origin };
}

/** The roster's own whitespace is normalised too, so the two sides can meet. */
const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

const rosterPath = process.argv[2];
if (!rosterPath) {
  console.error("no_prospect_names: no roster file given — see the header for the query.");
  console.error("Refusing to report a clean run without something to check against.");
  process.exit(2);
}

const names = readFileSync(rosterPath, "utf8")
  .split("\n")
  .map((n) => flatten(n))
  .filter((n) => n.length >= 5 && !GENERIC.has(n.toLowerCase()));

/* The distinctive first word of each surviving entry, one rule per token, remembering every
 * entry it came from so the report can name them. */
const tokens = new Map<string, string[]>();
for (const name of names) {
  const raw = name.split(" ")[0];
  const token = raw.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  // A leading article is left alone on purpose: "The" is under the floor, so a "The Something"
  // entry keeps only its whole-name rule. Stepping to the second word would widen the check by
  // a word chosen for being second, which is not the same as a word chosen for being distinctive.
  if (token === name) continue;                          // a one-word entry: the name rule has it
  if (token.length < MIN_TOKEN) continue;
  if (!/^[A-Za-z][A-Za-z0-9'&-]*$/.test(token)) continue; // not a word: a number, an ampersand run
  if (GENERIC.has(token.toLowerCase())) continue;
  if (FIRST_TOKEN_ALLOW.has(token.toLowerCase())) continue;
  const from = tokens.get(token);
  if (from) from.push(name);
  else tokens.set(token, [name]);
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && EXTS.some((e) => f.endsWith(e)))
  // The script carries the word "roster"; it must not be scanned against a name like "Roster Ltd".
  .filter((f) => f !== "scripts/no_prospect_names.ts");

type Scanned = { raw: string; flat: string; origin: Int32Array; lines: string[]; covered: Array<[number, number]> };
const files = new Map<string, Scanned>();
for (const f of tracked) {
  try {
    const raw = readFileSync(f, "utf8");
    const { text, origin } = normalise(raw);
    files.set(f, { raw, flat: text, origin, lines: raw.split("\n"), covered: [] });
  } catch {
    // A binary or unreadable file carries no prose.
  }
}

/** The 1-based line of an original offset. */
const lineOf = (s: Scanned, at: number): number => s.raw.slice(0, at).split("\n").length;

function report(file: string, s: Scanned, at: number, end: number, what: string): void {
  const from = lineOf(s, s.origin[at]);
  const to = lineOf(s, s.origin[Math.max(at, end - 1)]);
  console.log(`${file}:${from === to ? from : `${from}-${to}`}  ${what}`);
  // One line reads best from the file itself; a match that wraps reads best flattened.
  const body = from === to
    ? s.lines[from - 1].trim().slice(0, 110)
    : s.flat.slice(Math.max(0, at - 20), end + 20).trim().slice(0, 110);
  console.log(`    ${body}`);
}

let found = 0;

// Pass 1 · whole roster entries. Each hit marks its span, so the first-token pass below does not
// report the same words a second time.
for (const name of names) {
  const re = new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])`, "g");
  for (const [file, s] of files) {
    for (const m of s.flat.matchAll(re)) {
      s.covered.push([m.index, m.index + m[0].length]);
      report(file, s, m.index, m.index + m[0].length, name);
      found++;
    }
  }
}

// Pass 2 · first tokens. Circumstantial, so the roster entry is printed alongside.
for (const [token, from] of tokens) {
  const re = new RegExp(`(?<![A-Za-z0-9])${escape(token)}(?![A-Za-z0-9])`, "g");
  const origin = from.length === 1 ? from[0] : `${from[0]} (+${from.length - 1} more)`;
  for (const [file, s] of files) {
    for (const m of s.flat.matchAll(re)) {
      if (s.covered.some(([a, b]) => m.index >= a && m.index < b)) continue; // inside a full name
      report(file, s, m.index, m.index + m[0].length, `${token}  — first word of roster entry: ${origin}`);
      found++;
    }
  }
}

if (found > 0) {
  console.error(`\nno_prospect_names: ${found} occurrence(s) of a roster name in tracked files.`);
  console.error("Rule 2: the repository is public. Shape the example, do not name it.");
  process.exit(1);
}
console.log(
  `no_prospect_names: clean — ${names.length} names and ${tokens.size} first tokens checked against ${files.size} files.`,
);
