/**
 * WLIQ Prospect Book — research conformance check.
 *
 * `docs/RESEARCH-CONFORMANCE.md` records how this repo compares to the 9 Sep 2026 Prospect
 * Grading Research and its ten requirements. That document lives outside the repo, no session
 * reads it by default, and three separate rulings (DECISIONS §16, §19, §21) each rediscovered a
 * gap it had already named. A prose ledger would go stale the same way, so the ledger carries a
 * fenced JSON block of CHECKS and this test runs them.
 *
 * Every `auto` check states what is true TODAY — including the gaps. Closing a gap therefore
 * FAILS this test until the ledger row is updated to say so, and a gap that is quietly reopened
 * fails it too. That is the point: the check is symmetric, so neither direction of drift is
 * silent.
 *
 * `manual` checks cannot be answered from the repo (a credential, a row count, a person). They
 * are printed with the date they were last verified and never fail the build.
 *
 * NOT a ruling, and not authority: the Grading Register governs, docs/DECISIONS.md records.
 * This only asserts that what the ledger SAYS about the code is what the code DOES.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const LEDGER = "docs/RESEARCH-CONFORMANCE.md";

type Probe = Record<string, unknown>;
interface Check {
  id: string;
  r: string;
  mode: "auto" | "manual";
  claim: string;
  verified_on?: string;
  probe?: Probe;
}

let failures = 0;
const fail = (id: string, why: string): void => {
  failures++;
  console.error(`  FAIL  ${id}\n        ${why}`);
};

/* ------------------------------------------------------------------ *
 * the ledger is the spec
 * ------------------------------------------------------------------ */

function loadChecks(): Check[] {
  const md = read(LEDGER);
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${LEDGER}: no fenced json block — the machine-checked claims are gone`);
  let parsed: { checks?: Check[] };
  try {
    parsed = JSON.parse(m[1]) as { checks?: Check[] };
  } catch (e) {
    throw new Error(`${LEDGER}: the json block does not parse — ${(e as Error).message}`);
  }
  const checks = parsed.checks;
  if (!Array.isArray(checks) || checks.length === 0) throw new Error(`${LEDGER}: no checks`);
  return checks;
}

/* ------------------------------------------------------------------ *
 * probes
 * ------------------------------------------------------------------ */

/** Walk a dotted path. Returns the sentinel MISSING rather than throwing, so a moved key reads as a mismatch. */
const MISSING = Symbol("missing");
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return MISSING;
    const rec = cur as Record<string, unknown>;
    if (!(key in rec)) return MISSING;
    cur = rec[key];
  }
  return cur;
}

const show = (v: unknown): string => (v === MISSING ? "<missing>" : JSON.stringify(v));

function rubric(version: string): unknown {
  return JSON.parse(read(`core/rubric.prospect.v${version}.json`));
}

/** Every file a probe path names: a file is itself, a directory is walked and filtered by extension. */
function filesUnder(p: string, exts: string[]): string[] {
  const abs = join(root, p);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [p];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    out.push(...filesUnder(join(p, entry), exts));
  }
  return exts.length === 0 ? out : out.filter((f) => exts.includes(extname(f)));
}

function countMatches(paths: string[], exts: string[], pattern: string): { n: number; scanned: number } {
  const re = new RegExp(pattern, "g");
  let n = 0;
  let scanned = 0;
  for (const p of paths) {
    for (const f of filesUnder(p, exts)) {
      scanned++;
      const hits = read(f).match(re);
      if (hits) n += hits.length;
    }
  }
  return { n, scanned };
}

function runProbe(c: Check): void {
  const p = c.probe ?? {};
  const kind = p.kind as string;

  if (kind === "rubric_equals") {
    const got = at(rubric(p.version as string), p.path as string);
    const want = p.value;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(c.id, `rubric v${p.version} ${p.path}: ledger says ${show(want)}, repo has ${show(got)}`);
    }
    return;
  }

  if (kind === "rubric_absent") {
    const sub = at(rubric(p.version as string), p.path as string);
    if (sub === MISSING) return fail(c.id, `rubric v${p.version}: ${p.path} is missing entirely`);
    if (JSON.stringify(sub).includes(p.needle as string)) {
      fail(c.id, `rubric v${p.version} ${p.path}: ledger says "${p.needle}" is absent, but it appears`);
    }
    return;
  }

  if (kind === "count_matches") {
    const paths = p.paths as string[];
    const exts = (p.exts as string[] | undefined) ?? [];
    const { n, scanned } = countMatches(paths, exts, p.pattern as string);
    if (scanned === 0) return fail(c.id, `no files scanned under ${paths.join(", ")} — a path moved or was deleted`);
    if (n !== (p.equals as number)) {
      fail(c.id, `/${p.pattern}/ over ${paths.join(", ")}: ledger says ${p.equals} match(es), found ${n}`);
    }
    return;
  }

  if (kind === "json_len") {
    const doc: unknown = JSON.parse(read(p.file as string));
    const target = p.path ? at(doc, p.path as string) : doc;
    if (!Array.isArray(target)) return fail(c.id, `${p.file}${p.path ? " " + p.path : ""} is not an array (${show(target)})`);
    const n = target.length;
    if (p.equals !== undefined && n !== p.equals) return fail(c.id, `${p.file}: ledger says length ${p.equals}, found ${n}`);
    if (p.min !== undefined && n < (p.min as number)) return fail(c.id, `${p.file}: ledger says at least ${p.min}, found ${n}`);
    return;
  }

  fail(c.id, `unknown probe kind "${kind}" — this test does not implement it`);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const checks = loadChecks();
const auto = checks.filter((c) => c.mode === "auto");
const manual = checks.filter((c) => c.mode === "manual");

if (auto.length === 0) {
  console.error(`${LEDGER}: every check is manual — nothing is enforced`);
  process.exit(1);
}

for (const c of auto) {
  if (!c.probe) {
    fail(c.id, "mode is auto but the row carries no probe");
    continue;
  }
  try {
    runProbe(c);
  } catch (e) {
    fail(c.id, `probe threw: ${(e as Error).message}`);
  }
}

console.log(`conformance: ${auto.length - failures}/${auto.length} auto checks match the ledger`);

if (manual.length > 0) {
  console.log(`\nconformance: ${manual.length} claims this test CANNOT verify — re-check them by hand:`);
  for (const c of manual) {
    console.log(`  [${c.r}] ${c.id} (verified ${c.verified_on ?? "never"})`);
    console.log(`        ${c.claim}`);
  }
}

if (failures > 0) {
  console.error(
    `\nconformance: ${failures} check(s) disagree with ${LEDGER}.\n` +
      `The repo and the ledger have diverged. If you closed a gap, update the row and its expected\n` +
      `value; if a gap reopened, that is the finding. Never delete a row to make this pass.`,
  );
  process.exit(1);
}
