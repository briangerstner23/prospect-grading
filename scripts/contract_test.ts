/**
 * web/CONTRACT.json is the screens' contract. This enforces it.
 *
 *   node --experimental-strip-types scripts/contract_test.ts
 *
 * WHY THIS EXISTS, and why it is not the same as scripts/board_page_test.ts.
 *
 * board_page_test.ts pins what the board does: no sorting, no composite score, no closed table,
 * the publishable key only. Those are rules about behaviour, and they work.
 *
 * It also pinned thirteen dossier section names — and passed while thirteen OTHER sections from
 * the owner's approved layout were missing, because I wrote that list by reading the page I had
 * just built. A check derived from the implementation can only ever confirm the implementation.
 * It cannot notice an absence, because the absence is in the check too.
 *
 * So this test derives from the CONTRACT instead, which is written from the artifact the owner
 * ruled (DECISIONS §37, §46). It fails when:
 *
 *   1. a required section is not in the page                 — something was dropped
 *   2. the sections appear in a different order              — the screen was reshuffled
 *   3. a page renders a heading the contract does not name   — something was added unrecorded
 *
 * (3) matters as much as (1). "The info is not designed well as it keeps changing" is what
 * happens when every session adds a block wherever it fits; a screen with no fixed shape has no
 * shape. Adding to a screen is allowed — it means adding it to CONTRACT.json first, which is a
 * change the owner can see in a diff rather than discover on the page.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

interface Section { name: string; required: boolean; shows?: string; source?: string; column?: string }
interface Screen { file: string; view?: string; title: string; purpose: string; ordered?: boolean; sections: Section[] }
interface Contract { version: number; approved_by: string; source_of_truth: string; screens: Screen[] }

const contract = JSON.parse(readFileSync(join(root, "web/CONTRACT.json"), "utf8")) as Contract;

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/* A section is "in the page" when its exact name appears as a string literal. Every screen here
   builds its blocks by calling a helper with the title, so the name is in the source verbatim. */
const mentions = (page: string, name: string): boolean =>
  page.includes(`"${name}"`) || page.includes(`'${name}'`) || page.includes(`>${name}<`);

/* Where the name first appears, for the order check. -1 when absent. */
const at = (page: string, name: string): number => {
  for (const form of [`"${name}"`, `'${name}'`, `>${name}<`]) {
    const i = page.indexOf(form);
    if (i >= 0) return i;
  }
  return -1;
};

check("the contract names an approver", contract.approved_by.length > 0);
check("the contract names its source of truth", /artifact/i.test(contract.source_of_truth));

for (const screen of contract.screens) {
  const label = screen.view ? `${screen.file}#${screen.view}` : screen.file;
  const path = join(root, "web", screen.file);

  if (!existsSync(path)) {
    check(`${label}: the screen exists`, false, `web/${screen.file} has not been built yet`);
    continue;
  }
  check(`${label}: the screen exists`, true);
  const page = readFileSync(path, "utf8");

  const required = screen.sections.filter((s) => s.required);
  for (const s of required) {
    check(`${label}: has the section "${s.name}"`, mentions(page, s.name),
      s.shows ? `it should show ${s.shows}` : "");
  }

  /* Order. Only meaningful for a screen that declares one, and only over the sections that are
     actually present — a missing section is already a failure above and should not cascade. */
  if (screen.ordered) {
    const found = required.map((s) => ({ name: s.name, i: at(page, s.name) })).filter((x) => x.i >= 0);
    const sorted = [...found].sort((a, b) => a.i - b.i);
    const wrong = found.findIndex((x, n) => sorted[n]?.name !== x.name);
    check(`${label}: renders its sections in the contract's order`, wrong === -1,
      wrong === -1 ? "" : `"${found[wrong]?.name}" appears out of place — the contract puts it at position ${wrong + 1}`);
  }
}

/* Nothing unrecorded. A block title that is not in the contract is a change nobody approved. The
   check runs against the dossier's own block helper, which is the only place titles are declared. */
const board = existsSync(join(root, "web/board.html")) ? readFileSync(join(root, "web/board.html"), "utf8") : "";
if (board) {
  const declared = new Set(
    contract.screens.flatMap((s) => s.sections.map((x) => x.name)));
  const used = [...board.matchAll(/blk\(\s*"([^"]{3,60})"/g)].map((m) => m[1]);
  const undeclared = [...new Set(used)].filter((t) => !declared.has(t));
  check("board.html declares no dossier section the contract does not name", undeclared.length === 0,
    undeclared.length ? `add to CONTRACT.json first: ${undeclared.join(", ")}` : "");
}

console.log(`contract: ${passed} checks, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
