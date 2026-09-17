/**
 * WLIQ Prospect Book — research conformance and reconciliation check.
 *
 * `docs/RESEARCH-CONFORMANCE.md` records how this repo compares to the 9 Sep 2026 Prospect
 * Grading Research (requirements R1..R10), its "do not build" list, and — since 17 Sep — a
 * RECONCILIATION section for what is DECLARED versus what is RUNNING. That document lives
 * outside the repo; three separate rulings (DECISIONS §16, §19, §21) each rediscovered a gap it
 * had already named, and on 17 Sep the active rubric turned out to have no file at all. A prose
 * ledger goes stale the same way, so the ledger carries a fenced JSON block and this test runs it.
 *
 * Every `auto` check states what is true TODAY — including the gaps. Closing a gap therefore
 * FAILS this test until the ledger row is updated, and a gap that quietly reopens fails it too.
 * The check is symmetric so neither direction of drift is silent.
 *
 * What this version enforces that the 16 Sep version did not (each was a real hole, found by
 * deleting rows and watching it stay green):
 *   - COMPLETENESS: every key in `required_coverage` must have at least one auto check. Deleting
 *     rows to go green fails the build.
 *   - STALENESS: a `manual` claim older than `manual_max_age_days` fails until re-verified. A
 *     date nobody reads is decoration.
 *   - THE ACTIVE RUBRIC IS PINNED BY THE ENGINE'S OWN FINGERPRINT — `fingerprint()` from
 *     core/engine.ts, the value every pb_reads row stores — not by an ad-hoc hash. The file on
 *     disk must produce the fingerprint the database recorded on the reads it graded.
 *   - Rubric-wide probes enumerate core/rubric.prospect.v*.json from disk. The 16 Sep version
 *     hard-coded two of what were then five files and audited a RETIRED rubric as active.
 *
 * What it still cannot do: see the database. Rubric drift vs pb_rubric_versions, migration drift
 * vs schema_migrations and source liveness need network and belong in scripts/reconcile.ts (not
 * yet built — the ledger says so). This test pins the FILE; that script pins the FILE TO THE DB.
 *
 * NOT a ruling: the Grading Register governs, docs/DECISIONS.md records. Runs under Deno and
 * `node --experimental-strip-types`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import process from "node:process";
import { fingerprint } from "../core/engine.ts";

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
  reverify?: string;
  probe?: Probe;
}
interface Ledger {
  compiled_on: string;
  required_coverage: string[];
  manual_max_age_days: number;
  active_rubric: { version: string; file: string; engine_fingerprint: string; reads_verified_on: string };
  checks: Check[];
}

let failures = 0;
const fail = (id: string, why: string): void => {
  failures++;
  console.error(`  FAIL  ${id}\n        ${why}`);
};

/* ------------------------------------------------------------------ *
 * the ledger is the spec
 * ------------------------------------------------------------------ */

function loadLedger(): Ledger {
  const md = read(LEDGER);
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${LEDGER}: no fenced json block — the machine-checked claims are gone`);
  let parsed: Ledger;
  try {
    parsed = JSON.parse(m[1]) as Ledger;
  } catch (e) {
    throw new Error(`${LEDGER}: the json block does not parse — ${(e as Error).message}`);
  }
  for (const k of ["compiled_on", "required_coverage", "manual_max_age_days", "active_rubric", "checks"] as const) {
    if (parsed[k] === undefined) throw new Error(`${LEDGER}: json block is missing "${k}"`);
  }
  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) throw new Error(`${LEDGER}: no checks`);
  return parsed;
}

/* ------------------------------------------------------------------ *
 * probes
 * ------------------------------------------------------------------ */

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

/** Every rubric file on disk, enumerated — never a hard-coded list. */
function rubricFiles(): string[] {
  return readdirSync(join(root, "core"))
    .filter((f) => /^rubric\.prospect\.v[\d.]+\.json$/.test(f))
    .map((f) => `core/${f}`)
    .sort();
}
function rubric(version: string): unknown {
  return JSON.parse(read(`core/rubric.prospect.v${version}.json`));
}

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
  for (const entry of readdirSync(abs)) out.push(...filesUnder(join(p, entry), exts));
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
    if (JSON.stringify(got) !== JSON.stringify(p.value)) {
      fail(c.id, `rubric v${p.version} ${p.path}: ledger says ${show(p.value)}, repo has ${show(got)}`);
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

  if (kind === "rubric_glob_absent") {
    // Across EVERY rubric file on disk. This is the probe the 16 Sep version lacked.
    const needles = p.needles as string[];
    const files = rubricFiles();
    if (files.length === 0) return fail(c.id, "no rubric files found under core/");
    for (const f of files) {
      const text = JSON.stringify(JSON.parse(read(f)));
      for (const needle of needles) {
        if (text.includes(needle)) fail(c.id, `${f} contains ${JSON.stringify(needle)}; ledger says no rubric does`);
      }
    }
    return;
  }

  if (kind === "count_matches") {
    const paths = p.paths as string[];
    const exts = (p.exts as string[] | undefined) ?? [];
    const { n, scanned } = countMatches(paths, exts, p.pattern as string);
    if (scanned === 0) return fail(c.id, `no files scanned under ${paths.join(", ")} — a path moved or was deleted`);
    if (p.equals !== undefined && n !== (p.equals as number)) {
      return fail(c.id, `/${p.pattern}/ over ${paths.join(", ")}: ledger says ${p.equals} match(es), found ${n}`);
    }
    if (p.min !== undefined && n < (p.min as number)) {
      return fail(c.id, `/${p.pattern}/ over ${paths.join(", ")}: ledger says at least ${p.min}, found ${n}`);
    }
    return;
  }

  if (kind === "json_len") {
    const doc: unknown = JSON.parse(read(p.file as string));
    const target = p.path ? at(doc, p.path as string) : doc;
    if (!Array.isArray(target)) return fail(c.id, `${p.file}${p.path ? " " + p.path : ""} is not an array (${show(target)})`);
    if (p.equals !== undefined && target.length !== p.equals) return fail(c.id, `${p.file}: ledger says length ${p.equals}, found ${target.length}`);
    if (p.min !== undefined && target.length < (p.min as number)) return fail(c.id, `${p.file}: ledger says at least ${p.min}, found ${target.length}`);
    return;
  }

  if (kind === "file_exists") {
    if (!existsSync(join(root, p.path as string))) fail(c.id, `${p.path} does not exist`);
    return;
  }

  fail(c.id, `unknown probe kind "${kind}" — this test does not implement it`);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const ledger = loadLedger();
const checks = ledger.checks;
const auto = checks.filter((c) => c.mode === "auto");
const manual = checks.filter((c) => c.mode === "manual");

// 1 · Completeness. Every required key needs at least one AUTO check.
for (const key of ledger.required_coverage) {
  const n = auto.filter((c) => c.r === key).length;
  if (n === 0) fail(`COVERAGE:${key}`, `no auto check covers ${key} — a row was deleted or never written; the ledger is incomplete`);
}
const unknownKeys = [...new Set(checks.map((c) => c.r))].filter((k) => !ledger.required_coverage.includes(k));
if (unknownKeys.length) fail("COVERAGE:unknown", `checks carry keys not in required_coverage: ${unknownKeys.join(", ")} — add them to required_coverage or fix the row`);

// 2 · The active rubric: on disk, and fingerprinted by the engine itself.
{
  const a = ledger.active_rubric;
  if (!existsSync(join(root, a.file))) {
    fail("ACTIVE-rubric-filed", `${a.file} does not exist — the rubric the ledger says is active has no file (this is exactly the 17 Sep finding)`);
  } else {
    const fp = fingerprint(JSON.parse(read(a.file)));
    if (fp !== a.engine_fingerprint) {
      fail("ACTIVE-rubric-pinned", `${a.file}: engine fingerprint is ${fp}, ledger pins ${a.engine_fingerprint} (the value pb_reads recorded on ${a.reads_verified_on}). The file drifted from what graded the book, or a new version was activated without updating the pin.`);
    }
    const v = (JSON.parse(read(a.file)) as { version?: string }).version;
    if (v !== a.version) fail("ACTIVE-rubric-version", `${a.file} says version ${v}, ledger says ${a.version}`);
  }
}

// 3 · Auto probes.
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

// 4 · Manual claims: printed every run, and they EXPIRE.
const asOf = process.env.CONFORMANCE_AS_OF ? new Date(process.env.CONFORMANCE_AS_OF) : new Date();
const dayMs = 86_400_000;
let stale = 0;
for (const c of manual) {
  if (!c.verified_on) {
    fail(c.id, "manual claim has no verified_on date");
    continue;
  }
  const age = Math.floor((asOf.getTime() - new Date(c.verified_on).getTime()) / dayMs);
  if (age > ledger.manual_max_age_days) {
    stale++;
    fail(c.id, `manual claim last verified ${c.verified_on} (${age} days ago, limit ${ledger.manual_max_age_days}). Re-verify it${c.reverify ? ` — ${c.reverify}` : ""} — and update verified_on.`);
  }
}

console.log(`conformance: ${auto.length - auto.filter((c) => false).length}/${auto.length} auto checks run; ${failures} failure(s); ledger compiled ${ledger.compiled_on}; active rubric ${ledger.active_rubric.version} @ ${ledger.active_rubric.engine_fingerprint}`);

if (manual.length > 0) {
  console.log(`\nconformance: ${manual.length} claims this test CANNOT verify offline (${stale} stale) — re-check by hand:`);
  for (const c of manual) {
    console.log(`  [${c.r}] ${c.id} (verified ${c.verified_on ?? "never"})`);
    console.log(`        ${c.claim}`);
    if (c.reverify) console.log(`        re-verify: ${c.reverify}`);
  }
}

if (failures > 0) {
  console.error(
    `\nconformance: ${failures} check(s) disagree with ${LEDGER}.\n` +
      `If you closed a gap, update the row and its expected value; if a gap reopened, that is the\n` +
      `finding; if a manual claim expired, re-verify it and bump verified_on. Never delete a row.`,
  );
  process.exit(1);
}
