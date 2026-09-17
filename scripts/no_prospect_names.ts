/**
 * Rule 2, made mechanical: no prospect or staff name may appear in a tracked file.
 *
 * The repository is public. Every breach so far (DECISIONS §23 — fifteen agency names over five
 * days) entered as an *example* in prose, which is why reading the diff never caught it: each one
 * looked like exactly the concrete detail that makes a ruling legible. It is. It just has to be
 * shaped rather than named.
 *
 * The roster cannot live here — it IS the prospect data — so it is passed in:
 *
 *   select string_agg(name, E'\n') from public.pb_accounts where name is not null;   -- > roster.txt
 *   node --experimental-strip-types scripts/no_prospect_names.ts /tmp/roster.txt
 *
 * Exit 0 clean · 1 a name was found · 2 no roster was given (never silently "pass").
 *
 * Matching is case-sensitive on word boundaries. Case-insensitive would drown in false positives:
 * the roster holds "Agency", "Momentum", "Snap", "Test" and "None" as literal account names. Those
 * are listed in GENERIC below and skipped, because a rule that cries wolf is a rule nobody runs.
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

const EXTS = [".md", ".ts", ".sql", ".json", ".html", ".sh", ".txt", ".yml", ".yaml"];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const rosterPath = process.argv[2];
if (!rosterPath) {
  console.error("no_prospect_names: no roster file given — see the header for the query.");
  console.error("Refusing to report a clean run without something to check against.");
  process.exit(2);
}

const names = readFileSync(rosterPath, "utf8")
  .split("\n")
  .map((n) => n.trim())
  .filter((n) => n.length >= 5 && !GENERIC.has(n.toLowerCase()));

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && EXTS.some((e) => f.endsWith(e)))
  // The script carries the word "roster"; it must not be scanned against a name like "Roster Ltd".
  .filter((f) => f !== "scripts/no_prospect_names.ts");

const texts = new Map<string, string>();
for (const f of tracked) {
  try {
    texts.set(f, readFileSync(f, "utf8"));
  } catch {
    // A binary or unreadable file carries no prose.
  }
}

let found = 0;
for (const name of names) {
  const re = new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])`, "g");
  for (const [file, text] of texts) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      const body = text.split("\n")[line - 1].trim().slice(0, 110);
      console.log(`${file}:${line}  ${name}`);
      console.log(`    ${body}`);
      found++;
    }
  }
}

if (found > 0) {
  console.error(`\nno_prospect_names: ${found} occurrence(s) of a roster name in tracked files.`);
  console.error("Rule 2: the repository is public. Shape the example, do not name it.");
  process.exit(1);
}
console.log(`no_prospect_names: clean — ${names.length} names checked against ${texts.size} files.`);
