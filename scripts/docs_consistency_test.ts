/**
 * WLIQ Prospect Book — the documentation checks itself.
 *
 * Two failures on 18 September 2026 have the same cause, and neither was caught by any test:
 *
 *   1. Seven parallel sessions each appended a decision to docs/DECISIONS.md and five of them
 *      chose the SAME number. Four different rulings were called §50. Nothing detected it; the
 *      collision only surfaced when someone tried to merge, and resolving it by hand is the most
 *      expensive part of that merge.
 *
 *   2. CLAUDE.md carried counts that had gone stale — "All five edge functions" when six are on
 *      disk, "Seven cron jobs" when eight are active — inside sentences that already warned the
 *      reader the line had been wrong before. A warning label is not a check. A file that tells
 *      you not to trust it has stopped being documentation and become a rumour.
 *
 * The lesson both teach: PROSE MUST NOT HOLD A FACT THAT CHANGES. Either the fact is generated,
 * or it is checked, or it is not stated as a number at all. This script is the "checked" arm.
 *
 * It reads only the repository — no database, no network, no roster — so it runs in CI and on a
 * fresh clone with nothing configured. What it cannot see (cron jobs, deployed versions, the
 * active rubric) belongs to scripts/reconcile.ts, which has the database.
 *
 * Run: node --experimental-strip-types scripts/docs_consistency_test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const failures: string[] = [];
let checks = 0;

function check(name: string, ok: boolean, detail: string): void {
  checks++;
  if (!ok) failures.push(`${name}: ${detail}`);
}

/* ---- 1 · every decision number is used once ------------------------------------------------
   The one that bit hardest. A duplicate means "see §31" points at two different rulings and the
   reader cannot tell which. Sub-sections (§43a) are their own identity and may repeat a stem. */
function duplicateHeadings(md: string, patterns: RegExp[]): string[] {
  const seen = new Map<string, number>();
  for (const line of md.split("\n")) {
    for (const pattern of patterns) {
      const m = line.match(pattern);
      if (m) { seen.set(m[1], (seen.get(m[1]) ?? 0) + 1); break; }
    }
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
}

/* DECISIONS.md carries TWO heading conventions, and that is load-bearing for this check: §1–§42
   were written as "## 12 · Title" and everything from §43 on as "## §43 — Title". Matching only
   one of them reports three dozen phantom gaps — a check that cries wolf is a check nobody runs,
   which is the failure this whole file exists to prevent. Unifying the two is a real but separate
   job (it moves ~650 citations); until someone does it, read both.

   A second trap, found by this check's own first run: the older sections carry numbered SUB-points
   ("### 2 · The one-strong-or-two-weak bar…") that are not decision numbers at all. Matching h3 in
   the "N ·" form reported fifteen phantom duplicates. So: h2 only for that form; h2 and h3 for the
   "§N" form, because §43a IS a real sub-decision with its own identity. */
const DECISION_HEADINGS = [/^#{2,3}\s+§([0-9]+[a-z]?)\s/, /^##\s+([0-9]+[a-z]?)\s+·/];

/* Six collisions predate this check: §28–§33 each name two different rulings, one block in each
   heading style. They are GRANDFATHERED, not forgiven — the same posture the reconciler takes to
   known-unfiled migrations, and for the same reason: 109 citations across 34 files each have to be
   read in context to decide which §28 they meant, and a confidently wrong citation is worse than
   an ambiguous one. The list must only ever shrink. Anything NOT on it fails the build, so the
   count of collisions is frozen at six from today. */
const KNOWN_COLLISIONS = new Set(["28", "29", "30", "31", "32", "33"]);

const decisions = read("docs/DECISIONS.md");
const dupDecisions = duplicateHeadings(decisions, DECISION_HEADINGS);
const nums = [
  ...[...decisions.matchAll(/^##\s+§([0-9]+)\s/gm)].map((m) => Number(m[1])),
  ...[...decisions.matchAll(/^##\s+([0-9]+)\s+·/gm)].map((m) => Number(m[1])),
];
const newCollisions = dupDecisions.filter((d) => !KNOWN_COLLISIONS.has(d.split("×")[0]));
const healed = [...KNOWN_COLLISIONS].filter(
  (k) => !dupDecisions.some((d) => d.split("×")[0] === k),
);
check(
  "DECISIONS.md has no NEW decision-number collision",
  newCollisions.length === 0,
  newCollisions.length
    ? `reused: ${newCollisions.join(", ")} — a citation to one of these is ambiguous. Give the ` +
      `newer ruling the next free number (currently §${Math.max(...nums) + 1}) and fix its references.`
    : "",
);
check(
  "the grandfathered collision list is not stale",
  healed.length === 0,
  healed.length
    ? `§${healed.join(", §")} no longer collide — remove them from KNOWN_COLLISIONS so the list ` +
      `keeps shrinking and cannot quietly re-admit a collision.`
    : "",
);

/* ---- 2 · every runbook section number is used once ---------------------------------------- */
const runbook = read("docs/RUNBOOK.md");
const dupRunbook = duplicateHeadings(runbook, [/^##\s+([0-9]+)\s+·/]);
check(
  "RUNBOOK.md section numbers are unique",
  dupRunbook.length === 0,
  dupRunbook.length ? `reused: ${dupRunbook.join(", ")}` : "",
);

/* ---- 3 · the next free decision number is obvious -------------------------------------------
   Numbering must be dense and ascending, so "the next one" is never a guess. A gap is how two
   sessions both decide the next number is 50. */
const highest = nums.length ? Math.max(...nums) : 0;
const missing: number[] = [];
for (let i = 1; i <= highest; i++) if (!nums.includes(i)) missing.push(i);
check(
  "DECISIONS.md numbering has no gaps",
  missing.length === 0,
  missing.length
    ? `no §${missing.join(", §")} between §1 and §${highest}. A gap invites two sessions to ` +
      `claim the same next number. Either fill it or say in the file why it is empty.`
    : "",
);

/* ---- 4 · CLAUDE.md's countable claims match what is on disk ---------------------------------
   Only counts this script can verify from the repository. A count of something that lives in the
   database (cron jobs, deployed versions) must NOT be written as a number in prose at all — say
   where to read it instead, and let reconcile.ts check the rest. */
const claude = read("CLAUDE.md");
const WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const wordFor = (n: number): string =>
  Object.entries(WORD).find(([, v]) => v === n)?.[0] ?? String(n);

const edgeDirs = readdirSync(join(root, "supabase/functions"))
  .filter((d) => d.startsWith("pb-")).length;
const edgeClaim = claude.match(/\b(all\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\s+edge functions\b/i);
check(
  "CLAUDE.md edge-function count matches supabase/functions/",
  !edgeClaim || WORD[edgeClaim[2].toLowerCase()] === edgeDirs,
  edgeClaim
    ? `CLAUDE.md says "${edgeClaim[0]}" but ${edgeDirs} pb-* directories exist ` +
      `(write "${wordFor(edgeDirs)}")`
    : "",
);

const rubricFiles = readdirSync(join(root, "core"))
  .filter((f) => /^rubric\.prospect\..*\.json$/.test(f)).length;
const rubricClaim = claude.match(/\b(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE)\s+files\b/);
check(
  "CLAUDE.md rubric-file count matches core/",
  !rubricClaim || WORD[rubricClaim[1].toLowerCase()] === rubricFiles,
  rubricClaim
    ? `CLAUDE.md says "${rubricClaim[0]}" but ${rubricFiles} rubric files exist ` +
      `(write "${wordFor(rubricFiles).toUpperCase()}")`
    : "",
);

/* ---- 5 · no paragraph is pasted into CLAUDE.md twice ----------------------------------------
   Seven sessions merging one file produced two verbatim duplicate blocks. A reader who finds the
   first copy stops there, so a later edit to the second copy is invisible to them. */
const paras = claude.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 180);
const paraSeen = new Map<string, number>();
for (const p of paras) {
  const norm = p.replace(/\s+/g, " ");
  paraSeen.set(norm, (paraSeen.get(norm) ?? 0) + 1);
}
const dupParas = [...paraSeen.entries()].filter(([, n]) => n > 1);
check(
  "CLAUDE.md has no duplicated paragraph",
  dupParas.length === 0,
  dupParas.length
    ? `${dupParas.length} paragraph(s) appear more than once, first begins: ` +
      `"${dupParas[0][0].slice(0, 90)}…"`
    : "",
);

/* ---- 6 · the entry point exists and names what lives outside the repository ------------------
   A new operator — or a new Claude account — reads one file first. If that file does not say the
   Grading Register is authoritative AND lives in another repository, the reader will assume this
   repository is complete. It is not, by design. */
let start = "";
try {
  start = read("docs/START-HERE.md");
} catch {
  /* reported below */
}
check("docs/START-HERE.md exists", start.length > 0, "the single entry point is missing");
if (start) {
  for (const must of ["Grading Register", "wliq-momentum", "sgagrmapuovnjwvgsxbp"]) {
    check(
      `START-HERE.md names ${must}`,
      start.includes(must),
      `a reader cannot run or trust this system without knowing about ${must}`,
    );
  }
}

/* ---- report ------------------------------------------------------------------------------- */
if (failures.length) {
  console.error(`docs_consistency: ${checks} checks, ${failures.length} failed\n`);
  for (const f of failures) console.error(`  FAIL  ${f}\n`);
  console.error(
    "Prose must not hold a fact that changes. Fix the file, or stop stating the number and\n" +
      "point at the thing that knows it.",
  );
  process.exit(1);
}
console.log(`docs_consistency: ${checks} checks, 0 failed`);
