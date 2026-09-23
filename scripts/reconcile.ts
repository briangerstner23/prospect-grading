/**
 * WLIQ Prospect Book — reconcile what is DECLARED with what is RUNNING.
 *
 * scripts/conformance_test.ts reads the repository and fails when the ledger stops matching the
 * code. It cannot see the database. On 17 Sep 2026 that blind spot cost four findings at once: the
 * active rubric had no file, 33 applied migrations had no file, Fathom had never delivered, and
 * rule 9 had drifted for two days — with every repo-side check green. This script is the other
 * half: it fetches `pb_reconcile_state()` (aggregates only, callable by anon) and compares.
 *
 * Checks, each a FAIL unless the ledger's policy says warn:
 *   1. The active rubric in the database is the version the ledger pins, its spec produces the
 *      pinned engine fingerprint, the file on disk produces it too, and the current reads under
 *      it carry it. Four things that must agree; on 16 Sep none of them was even checkable.
 *   2. Every applied prospect_book migration has a file on disk, matched by NAME (the timestamps
 *      follow different clocks). Names the ledger lists as known-unfiled warn instead — that list
 *      exists for the 29 boards migrations held on an owner decision, and it should shrink.
 *   3. Each source is alive by EXTERNAL evidence: a webhook row whose user agent is not pg_net, or
 *      a finished run. A row this database posted to itself is not proof of anything.
 *   4. The rule-9 mismatch count (view winner ≠ function-order winner) is zero.
 *   5. The newest notes run DID WORK (always a FAIL, not a ledger policy). On 22 and 23 Sep 2026
 *      the extractor's API credit ran out: pb-notes recorded 'success' with 0 facts, 0 candidates
 *      and 8 extractor failures, and check 3 stayed green because it asks only whether a run
 *      finished. A halted run, or one whose extractor failed and that wrote nothing, fails; no fact
 *      or candidate for more than three days while runs keep finishing warns. An older
 *      pb_reconcile_state() without `notes_work` warns that the check could not run.
 *
 * Runs from CI with no secrets: the URL and publishable key are the page's own
 * (web/index.html), and the rpc returns nothing that is not already readable. `--state <file>`
 * evaluates a saved state offline (that is what reconcile_test.ts uses); `--dump` prints the
 * fetched state. Exit 1 on any failure. NOT a ruling: it says whether the record matches the
 * running system, never what the system should be.
 *
 * Runs under Deno and `node --experimental-strip-types`.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fingerprint } from "../core/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

export interface SourcePolicy { mode: "fail" | "warn"; max_age_days: number; why?: string }
export interface LedgerReconcile {
  active_rubric: { version: string; file: string; engine_fingerprint: string };
  known_unfiled_migrations: { reason: string; names: string[] };
  sources: Record<string, SourcePolicy>;
}
export interface State {
  generated_at: string;
  active_rubric: { version: string; activated_at: string | null; spec: unknown } | null;
  reads_on_active: { accounts: number; fingerprints: string[] } | null;
  applied_migrations: string[];
  sources: Record<string, Record<string, unknown>>;
  rule9_mismatches: number | null;
  live_accounts: number;
  /** Added by migration 20260923211200; absent from an older pb_reconcile_state(). Numbers only. */
  notes_work?: NotesWork;
}
export interface NotesWork {
  latest: {
    status: string; started_at: string | null; finished_at: string | null;
    facts: number | null; candidates: number | null; wrote: number | null; errors: number | null;
    halted: number | null; extractor_failed: number | null; extractor_halted: number | null;
    pulled: number | null; planned: number | null;
  } | null;
  newest_productive_finished_at: string | null;
  runs_since_productive: number;
  finished_runs_7d: number;
}
export interface Verdict { failures: string[]; warnings: string[]; summary: string[] }

/* ------------------------------------------------------------------ *
 * the pure part — what reconcile_test.ts exercises
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const SOURCE_TS_FIELD: Record<string, string> = {
  fathom: "newest_external_verified_delivery_at",
  pipedrive: "newest_external_verified_delivery_at",
  score_run: "newest_success_finished_at",
  notes_run: "newest_success_finished_at",
};
/** Check 5: warn when notes runs keep finishing but none has written a fact or candidate for longer. */
export const NOTES_IDLE_WARN_DAYS = 3;

export function evaluate(
  state: State,
  ledger: LedgerReconcile,
  diskMigrationNames: string[],
  fileFingerprint: string | null,
  asOf: Date,
): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const pin = ledger.active_rubric;

  // 1 · the active rubric, four ways
  if (!state.active_rubric) {
    failures.push("no active rubric in pb_rubric_versions");
  } else {
    const dbv = state.active_rubric.version;
    const dbfp = fingerprint(state.active_rubric.spec);
    summary.push(`db active ${dbv} @ ${dbfp}; ledger pins ${pin.version} @ ${pin.engine_fingerprint}; file @ ${fileFingerprint ?? "<no file>"}`);
    if (dbv !== pin.version) failures.push(`active rubric is ${dbv} in the database; the ledger pins ${pin.version} — activated without updating the ledger, or the ledger is stale`);
    if (dbfp !== pin.engine_fingerprint) failures.push(`the database's active spec fingerprints ${dbfp}; the ledger pins ${pin.engine_fingerprint} — the row was edited in place, or the pin is wrong`);
    if (fileFingerprint === null) failures.push(`${pin.file} does not exist — the active rubric has no file (the 17 Sep finding)`);
    else if (fileFingerprint !== dbfp) failures.push(`${pin.file} fingerprints ${fileFingerprint}; the database's active spec fingerprints ${dbfp} — file and row have diverged`);
    const reads = state.reads_on_active;
    if (reads && reads.accounts > 0) {
      const other = reads.fingerprints.filter((f) => f !== dbfp);
      if (other.length) failures.push(`${reads.accounts} current reads are under ${dbv} but carry fingerprint(s) ${other.join(", ")} ≠ ${dbfp} — the reads were scored by a different spec than the one now active (activated without rescoring, or the spec changed after)`);
      else summary.push(`${reads.accounts} current reads under ${dbv} carry ${dbfp}`);
    } else warnings.push(`no current reads under the active rubric ${dbv} yet — activated but not scored`);
    if (state.live_accounts > 0 && reads && reads.accounts > 0 && reads.accounts !== state.live_accounts) {
      warnings.push(`${state.live_accounts} live accounts but ${reads.accounts} current reads under ${dbv}`);
    }
  }

  // 2 · migrations, by name
  const disk = new Set(diskMigrationNames);
  const known = new Set(ledger.known_unfiled_migrations.names);
  const unfiled = state.applied_migrations.filter((n) => !disk.has(n));
  const unknownUnfiled = unfiled.filter((n) => !known.has(n));
  const knownUnfiled = unfiled.filter((n) => known.has(n));
  const knownButFiled = [...known].filter((n) => disk.has(n));
  summary.push(`${state.applied_migrations.length} applied, ${unfiled.length} unfiled (${knownUnfiled.length} known, ${unknownUnfiled.length} unknown)`);
  if (unknownUnfiled.length) failures.push(`applied with no file and not on the known list: ${unknownUnfiled.join(", ")} — transcribe from schema_migrations.statements (DECISIONS §32)`);
  if (knownUnfiled.length) warnings.push(`${knownUnfiled.length} applied migrations have no file, on the known list (${ledger.known_unfiled_migrations.reason})`);
  if (knownButFiled.length) warnings.push(`on the known-unfiled list but now filed — remove from the ledger: ${knownButFiled.join(", ")}`);

  // 3 · source liveness, external evidence only
  for (const [name, policy] of Object.entries(ledger.sources)) {
    const field = SOURCE_TS_FIELD[name];
    const src = state.sources?.[name];
    const raw = field && src ? src[field] : undefined;
    const ts = typeof raw === "string" ? Date.parse(raw) : NaN;
    const sink = policy.mode === "fail" ? failures : warnings;
    if (!Number.isFinite(ts)) {
      sink.push(`${name}: no external evidence of life, ever (${field} is null)${policy.why ? ` — ${policy.why}` : ""}`);
      continue;
    }
    const age = (asOf.getTime() - ts) / DAY_MS;
    if (age > policy.max_age_days) sink.push(`${name}: newest external evidence is ${age.toFixed(1)} days old (limit ${policy.max_age_days})`);
    else summary.push(`${name}: alive, ${age.toFixed(1)} days`);
  }

  // 4 · rule 9
  if (state.rule9_mismatches === null || state.rule9_mismatches === undefined) failures.push("rule-9 mismatch count is missing from the state");
  else if (state.rule9_mismatches !== 0) failures.push(`rule 9: ${state.rule9_mismatches} key(s) resolve differently between pb_current_facts and latestFactPerKey's order`);
  else summary.push("rule 9: view and function agree on every key");

  // 5 · the notes sweep did work, not merely finished
  const nw = state.notes_work;
  if (!nw) {
    warnings.push("notes_work is missing from the state — pb_reconcile_state() predates migration 20260923211200, so whether the notes sweep did any work could not be checked");
  } else {
    const n = (x: number | null | undefined): number => (typeof x === "number" ? x : 0);
    const l = nw.latest;
    if (!l) warnings.push("notes_work: no finished notes run to check");
    else {
      const written = n(l.facts) + n(l.candidates);
      const at = `${l.status}, finished ${l.finished_at ?? "?"}`;
      if (n(l.halted) > 0 || n(l.extractor_halted) > 0) {
        failures.push(`notes run halted (${at}): the extractor refused the run — ${n(l.facts)} fact(s), ${n(l.candidates)} candidate(s) before it stopped. Check the extractor's API key and credit`);
      } else if (n(l.extractor_failed) > 0 && written === 0) {
        failures.push(`notes run did no work (${at}): ${n(l.extractor_failed)} extractor failure(s), 0 facts, 0 candidates from ${n(l.pulled)} record(s) pulled — a 'success' that read nothing (the 22–23 Sep finding). Check the extractor's API key and credit`);
      } else {
        summary.push(`notes run ${at}: ${n(l.facts)} fact(s), ${n(l.candidates)} candidate(s), ${n(l.extractor_failed)} extractor failure(s)`);
      }
    }
    const p = nw.newest_productive_finished_at;
    const pts = typeof p === "string" ? Date.parse(p) : NaN;
    if (nw.runs_since_productive > 0) {
      if (!Number.isFinite(pts)) {
        warnings.push(`notes_work: ${nw.runs_since_productive} finished notes run(s) and none has ever written a fact or candidate`);
      } else {
        const idle = (asOf.getTime() - pts) / DAY_MS;
        if (idle > NOTES_IDLE_WARN_DAYS) warnings.push(`notes_work: no fact or candidate written for ${idle.toFixed(1)} days (limit ${NOTES_IDLE_WARN_DAYS}) across ${nw.runs_since_productive} finished run(s) since`);
      }
    }
  }

  return { failures, warnings, summary };
}

/* ------------------------------------------------------------------ *
 * the impure part — fetch, load, report
 * ------------------------------------------------------------------ */

function loadLedger(): LedgerReconcile & { compiled_on: string } {
  const md = read("docs/RESEARCH-CONFORMANCE.md");
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error("docs/RESEARCH-CONFORMANCE.md: no fenced json block");
  const b = JSON.parse(m[1]) as { compiled_on: string; active_rubric: LedgerReconcile["active_rubric"]; reconcile?: Omit<LedgerReconcile, "active_rubric"> };
  if (!b.reconcile) throw new Error("docs/RESEARCH-CONFORMANCE.md: json block has no `reconcile` policy");
  return { compiled_on: b.compiled_on, active_rubric: b.active_rubric, ...b.reconcile };
}

/**
 * Which branch this ran on, and whether any other branch carries commits it does not.
 *
 * DECISIONS §39: this script compares the database to the WORKING TREE. On 17 Sep that made it
 * report 29 applied migrations as unfiled while 24 of their files sat on another branch. A check
 * that reads one branch cannot see work on another, so it has to say which one it read.
 * Best-effort: no git, no remotes, or a shallow clone all return null rather than failing a run.
 */
export function branchState(): { branch: string; unmerged: string[] } | null {
  try {
    const run = (cmd: string) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const branch = run("git rev-parse --abbrev-ref HEAD");
    // `git branch -r`, not for-each-ref: the --format spec's parentheses need shell quoting that
    // /bin/sh under execSync does not survive, and a silently-null check is worse than none.
    const heads = run("git branch -r")
      .split("\n").map((b) => b.replace(/^[* ]+/, "").trim())
      .filter((b) => b.startsWith("origin/") && !b.includes("->"))
      // An intentional frozen snapshot, not a line of work — docs/BASELINE.md, DECISIONS §39.
      .filter((b) => b !== "origin/baseline-v0.1.0");
    const unmerged: string[] = [];
    for (const b of heads) {
      const n = Number(run(`git rev-list --count HEAD..${b}`));
      if (Number.isFinite(n) && n > 0) unmerged.push(`${b} (+${n})`);
    }
    return { branch, unmerged };
  } catch {
    return null;
  }
}

export function diskMigrationNames(): string[] {
  return readdirSync(join(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/^\d+_/, "").replace(/\.sql$/, ""));
}

function pageCredentials(): { url: string; key: string } {
  const url = process.env.PB_SUPABASE_URL;
  const key = process.env.PB_SUPABASE_KEY;
  if (url && key) return { url, key };
  const html = read("web/index.html");
  const u = html.match(/const SUPABASE_URL = "([^"]+)"/);
  const k = html.match(/const SUPABASE_KEY = "([^"]+)"/);
  if (!u || !k) throw new Error("web/index.html: could not find SUPABASE_URL / SUPABASE_KEY; set PB_SUPABASE_URL and PB_SUPABASE_KEY");
  return { url: u[1], key: k[1] };
}

async function fetchState(): Promise<State> {
  const { url, key } = pageCredentials();
  const res = await fetch(`${url}/rest/v1/rpc/pb_reconcile_state`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`pb_reconcile_state: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as State;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateArg = args.indexOf("--state");
  const asOfArg = args.indexOf("--as-of");
  const asOf = asOfArg >= 0 ? new Date(args[asOfArg + 1]) : new Date();
  const ledger = loadLedger();
  const state: State = stateArg >= 0 ? (JSON.parse(readFileSync(resolve(args[stateArg + 1]), "utf8")) as State) : await fetchState();
  if (args.includes("--dump")) {
    const out = join(root, "reconcile-state.json");
    writeFileSync(out, JSON.stringify(state, null, 2));
    console.log(`state written to ${out}`);
  }
  const file = join(root, ledger.active_rubric.file);
  const fileFp = existsSync(file) ? fingerprint(JSON.parse(readFileSync(file, "utf8"))) : null;
  const v = evaluate(state, ledger, diskMigrationNames(), fileFp, asOf);

  const branches = branchState();
  if (branches) {
    console.log(`reconcile: read the working tree on branch ${branches.branch}`);
    if (branches.unmerged.length) {
      v.warnings.push(`${branches.unmerged.length} branch(es) carry commits this tree does not: ${branches.unmerged.join(", ")}. Everything below was measured against ${branches.branch} only — merge before trusting a "no file" or "missing" finding (DECISIONS §39).`);
    }
  }
  console.log(`reconcile: state generated ${state.generated_at}; ledger compiled ${ledger.compiled_on}; as of ${asOf.toISOString()}`);
  for (const s of v.summary) console.log(`  ok    ${s}`);
  for (const w of v.warnings) console.log(`  WARN  ${w}`);
  for (const f of v.failures) console.error(`  FAIL  ${f}`);
  console.log(`reconcile: ${v.failures.length} failure(s), ${v.warnings.length} warning(s)`);
  if (v.failures.length) {
    console.error("The running system and the record disagree. Fix the system, or update the record and say why in docs/DECISIONS.md. Never silence a row.");
    process.exit(1);
  }
}

const invokedDirectly = (() => {
  const meta = import.meta as unknown as { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  return typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`reconcile: ${(e as Error).message}`);
    process.exit(1);
  });
}
