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
 * names. Those are in GENERIC (ingest/name_tokens.ts) and skipped, because a rule that cries wolf
 * is a rule nobody runs. An entry dropped by GENERIC contributes no first token either — that is
 * deliberate, and it is what keeps an entry like "second mile" from turning "second" into a rule.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FIRST_TOKEN_ALLOW, GENERIC, MIN_TOKEN } from "../ingest/name_tokens.ts";

/* GENERIC, FIRST_TOKEN_ALLOW and MIN_TOKEN live in ingest/name_tokens.ts (moved there verbatim on
 * 10 Oct 2026), because the sales-meeting matcher must read the same lists: a word this check allows
 * must never be a distinctive token there, and the other way round. The rule for adding a word is
 * written beside the list and has not changed. */

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
