/**
 * WLIQ Prospect Book — scripts/no_prospect_names.ts, the two shapes it could not see.
 *
 * On 18 September 2026 the check reported clean while docs/DECISIONS.md still carried two roster
 * names: one broken across a line break, one referred to by its first word alone. This test drives
 * the real script as a subprocess over a throwaway git repository and a throwaway roster, and
 * proves both shapes are caught — and, just as important, that an ordinary first word is not.
 *
 * Every agency here is invented (rule 2: no prospect data in this repository). The roster is
 * written to a temporary directory and deleted, the way the real one is handed in from outside.
 *
 * Run: node --experimental-strip-types scripts/no_prospect_names_test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "..", "scripts", "no_prospect_names.ts");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(detail ? `${name}\n    ${detail}` : name);
  }
}
const eq = (name: string, actual: unknown, expected: unknown): void =>
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/* ------------------------------------------------------------------ *
 * Harness: a throwaway repository of tracked files + a throwaway roster
 * ------------------------------------------------------------------ */

type Run = { code: number; stdout: string; stderr: string };

/** `files` maps a repo-relative path to its content; `roster` is one account name per line. */
function run(roster: string[] | null, files: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "no-names-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, "repo", rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    // `git ls-files` is what the script scans, and staged is tracked enough — no commit needed,
    // so the test never depends on a configured user.name / user.email.
    spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });

    const args = [script];
    if (roster) {
      // Outside the repository, exactly as RUNBOOK §27 requires of the real one.
      const rosterPath = join(dir, "roster.txt");
      writeFileSync(rosterPath, roster.join("\n") + "\n");
      args.push(rosterPath);
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The script's own summary line carries the count; read it rather than counting output lines. */
function occurrences(r: Run): number {
  const m = r.stderr.match(/(\d+) occurrence\(s\)/);
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------------ *
 * 1 · A name broken across a line break is caught
 * ------------------------------------------------------------------ */

{
  const r = run(["Brightwater Analytics"], {
    "docs/A.md": "The book graded it in September, and the second pass moved Brightwater\nAnalytics up a tier.\n",
  });
  eq("wrapped name: exits 1", r.code, 1);
  check("wrapped name: names the roster entry", r.stdout.includes("Brightwater Analytics"), r.stdout);
  check("wrapped name: reports the line range it spans", /docs\/A\.md:1-2\b/.test(r.stdout), r.stdout);
  eq("wrapped name: one occurrence", occurrences(r), 1);
}

{
  // The same name, wrapped the other way: the break falls after a word in the middle.
  const r = run(["Harborlight Creative Partners"], {
    "docs/B.md": "- the queue held Harborlight Creative\n  Partners for a week\n",
  });
  eq("wrapped mid-name: exits 1", r.code, 1);
  check("wrapped mid-name: names the entry", r.stdout.includes("Harborlight Creative Partners"), r.stdout);
}

/* ------------------------------------------------------------------ *
 * 2 · A name referred to by its first word alone is caught
 * ------------------------------------------------------------------ */

{
  const r = run(["Quillfeather Something, Inc"], {
    "docs/C.md": "Quillfeather asked twice. Quillfeather is not in Apollo.\nWe graded Quillfeather anyway.\n",
  });
  eq("first token: exits 1", r.code, 1);
  eq("first token: three occurrences", occurrences(r), 3);
  check("first token: prints the token", r.stdout.includes("Quillfeather"), r.stdout);
  check(
    "first token: prints the roster entry it came from",
    r.stdout.includes("Quillfeather Something, Inc"),
    r.stdout,
  );
  check("first token: says it is a first word", /first word of roster entry/.test(r.stdout), r.stdout);
}

{
  // The comma in "Firstword, Inc" belongs to the roster, not to the word.
  const r = run(["Marrowstone, Inc"], { "docs/D.md": "One Marrowstone call, no deal.\n" });
  eq("trailing comma stripped from the token: exits 1", r.code, 1);
  check("trailing comma: prints the bare token", /\bMarrowstone\b/.test(r.stdout), r.stdout);
}

{
  // Six characters is the floor, and the floor is inclusive.
  const r = run(["Thrush Lanterns Ltd"], { "docs/E.md": "The Thrush account went quiet.\n" });
  eq("six-character token: exits 1", r.code, 1);
}

/* ------------------------------------------------------------------ *
 * 3 · An ordinary first word is NOT a finding
 * ------------------------------------------------------------------ */

{
  const r = run(
    [
      "Digital Harborworks Ltd",   // allowlisted first word
      "Creative Tidewater Group",  // allowlisted first word
      "Vane Thicketry Co",         // first word under the six-character floor
      "Momentum Kettlebrook LLC",  // first word already in GENERIC
    ],
    {
      "docs/F.md":
        "Digital work is most of the book, and Creative teams buy design differently.\n" +
        "A Vane is a weather instrument; Momentum is a word this repository uses constantly.\n",
      "core/g.ts": "// Momentum, digital, creative — all ordinary words in a comment.\n",
    },
  );
  eq("ordinary first words: exits 0", r.code, 0);
  check("ordinary first words: says clean", r.stdout.includes("clean"), r.stdout + r.stderr);
  check("ordinary first words: reports zero tokens as rules", /and 0 first tokens/.test(r.stdout), r.stdout);
}

{
  // A five-character first word is one short of the floor and stays out of it.
  const r = run(["Marsh Lanterns Ltd"], { "docs/H.md": "The Marsh is not an agency.\n" });
  eq("five-character token: exits 0", r.code, 0);
}

{
  // § 28 found a non-breaking space inside one real account name. Flattening both sides means
  // the roster's U+00A0 now meets the prose's ordinary space, which the old matcher could not.
  const r = run(["Silverbeck\u00a0Ironworks"], { "docs/M.md": "The Silverbeck Ironworks read was stale.\n" });
  eq("non-breaking space in the roster: exits 1", r.code, 1);
}

{
  // A name is a pattern only after escaping; "Redpoint (US)" must not compile to a capture group.
  const r = run(["Redpoint (US) Holdings", "Ash + Ember Co"], {
    "docs/N.md": "Redpoint (US) Holdings renewed. Ash + Ember Co did not.\n",
  });
  eq("regex metacharacters in a name: exits 1", r.code, 1);
  eq("regex metacharacters: both names found", occurrences(r), 2);
}

/* ------------------------------------------------------------------ *
 * 4 · Regressions: the whole-name rule, the counts, the exit codes
 * ------------------------------------------------------------------ */

{
  const r = run(["Pinefall Digital Group"], { "docs/I.md": "Pinefall Digital Group signed in August.\n" });
  eq("whole name on one line: exits 1", r.code, 1);
  eq("whole name: counted once, not twice by its own first word", occurrences(r), 1);
  check("whole name: reports a single line number", /docs\/I\.md:1\s/.test(r.stdout), r.stdout);
}

{
  const r = run(["Kettleburn Partners"], {
    "docs/J.md": "Kettleburn Partners is the whole name.\nKettleburn alone is the first word.\n",
  });
  eq("both shapes in one file: exits 1", r.code, 1);
  eq("both shapes in one file: two occurrences", occurrences(r), 2);
}

{
  const r = run(["Vellum Harbor Agency"], {
    "docs/K.md": "No agency is named here.\n",
    "fixtures/golden.json": '{"account": "an invented one"}\n',
  });
  eq("nothing to find: exits 0", r.code, 0);
  check("nothing to find: says clean", r.stdout.includes("clean"), r.stdout);
}

{
  const r = run(null, { "docs/L.md": "anything at all\n" });
  eq("no roster: exits 2", r.code, 2);
  check("no roster: refuses to report a clean run", r.stderr.includes("Refusing"), r.stderr);
}

/* ------------------------------------------------------------------ */

if (failed > 0) {
  console.error(`no_prospect_names_test: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`no_prospect_names_test: ${passed} passed, 0 failed`);
