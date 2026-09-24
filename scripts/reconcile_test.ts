/**
 * scripts/reconcile.ts — the pure evaluate() against canned states. Every failure branch is
 * exercised, because a reconciliation that only passes has not been shown to detect anything.
 * Exits non-zero on failure. Runs under Deno and `node --experimental-strip-types`.
 */

import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluate } from "./reconcile.ts";
import type { State, LedgerReconcile } from "./reconcile.ts";
import { fingerprint } from "../core/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const spec = JSON.parse(readFileSync(join(here, "../core/rubric.prospect.v0.1.4.json"), "utf8"));
const FP = fingerprint(spec);
const NOW = new Date("2026-09-17T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const ledger: LedgerReconcile = {
  active_rubric: { version: "0.1.4", file: "core/rubric.prospect.v0.1.4.json", engine_fingerprint: FP },
  known_unfiled_migrations: { reason: "test", names: ["prospect_book_boards_known"] },
  sources: {
    fathom: { mode: "warn", max_age_days: 7 },
    pipedrive: { mode: "fail", max_age_days: 7 },
    score_run: { mode: "fail", max_age_days: 2 },
    notes_run: { mode: "fail", max_age_days: 2 },
  },
};
const disk = ["prospect_book_schema", "prospect_book_cron"];
const green = (): State => ({
  generated_at: NOW.toISOString(),
  active_rubric: { version: "0.1.4", activated_at: day(1), spec },
  reads_on_active: { accounts: 829, fingerprints: [FP] },
  applied_migrations: ["prospect_book_schema", "prospect_book_cron", "prospect_book_boards_known"],
  sources: {
    fathom: { newest_external_verified_delivery_at: day(1) },
    pipedrive: { newest_external_verified_delivery_at: day(0.5) },
    score_run: { newest_success_finished_at: day(0.3) },
    notes_run: { newest_success_finished_at: day(0.4) },
  },
  rule9_mismatches: 0,
  live_accounts: 829,
  notes_work: {
    latest: {
      status: "success", started_at: day(0.41), finished_at: day(0.4),
      facts: 10, candidates: 14, wrote: 24, errors: 0, halted: 0,
      extractor_failed: 0, extractor_halted: null, pulled: 460, planned: null,
    },
    newest_productive_finished_at: day(0.4),
    runs_since_productive: 0,
    finished_runs_7d: 7,
  },
});

{
  const v = evaluate(green(), ledger, disk, FP, NOW);
  check("green state: no failures", v.failures.length === 0, v.failures.join(" | "));
  check("green state: the known-unfiled migration is a warning, not a failure", v.warnings.some((w) => w.includes("known list")));
}
{
  const s = green(); s.active_rubric!.version = "0.1.3";
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("version mismatch fails", v.failures.some((f) => f.includes("ledger pins 0.1.4")));
}
{
  const s = green(); s.active_rubric!.spec = { ...spec, version: "0.1.4", extra: 1 };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("spec edited in place fails on fingerprint", v.failures.some((f) => f.includes("edited in place")));
}
{
  const v = evaluate(green(), ledger, disk, null, NOW);
  check("missing file fails", v.failures.some((f) => f.includes("does not exist")));
}
{
  const v = evaluate(green(), ledger, disk, "deadbeef", NOW);
  check("file drifted from row fails", v.failures.some((f) => f.includes("have diverged")));
}
{
  const s = green(); s.reads_on_active = { accounts: 829, fingerprints: ["00000000"] };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("reads scored by a different spec fails", v.failures.some((f) => f.includes("different spec")));
}
{
  const s = green(); s.reads_on_active = { accounts: 0, fingerprints: [] };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("activated but not scored warns", v.warnings.some((w) => w.includes("not scored")) && v.failures.length === 0);
}
{
  const s = green(); s.applied_migrations.push("prospect_book_mystery");
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("unknown unfiled migration fails", v.failures.some((f) => f.includes("prospect_book_mystery")));
}
{
  const v = evaluate(green(), ledger, [...disk, "prospect_book_boards_known"], FP, NOW);
  check("known-unfiled name now on disk warns to remove it", v.warnings.some((w) => w.includes("remove from the ledger")));
}
{
  const s = green(); s.sources.fathom = { newest_external_verified_delivery_at: null };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("fathom with no external evidence warns (policy warn), does not fail", v.warnings.some((w) => w.startsWith("fathom: no external evidence")) && !v.failures.some((f) => f.startsWith("fathom")));
}
{
  const s = green(); s.sources.pipedrive = { newest_external_verified_delivery_at: day(9) };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("pipedrive 9 days old fails (limit 7)", v.failures.some((f) => f.startsWith("pipedrive:")));
}
{
  const s = green(); s.sources.score_run = { newest_success_finished_at: day(3) };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("score run 3 days old fails (limit 2)", v.failures.some((f) => f.startsWith("score_run:")));
}
{
  const s = green(); s.rule9_mismatches = 50;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("rule-9 mismatches fail", v.failures.some((f) => f.includes("rule 9: 50")));
}
{
  const s = green(); s.active_rubric = null;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("no active rubric fails", v.failures.some((f) => f.includes("no active rubric")));
}
{
  const s = green(); s.live_accounts = 900;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("live accounts ≠ reads warns", v.warnings.some((w) => w.includes("900 live accounts")));
}

{
  const v = evaluate(green(), ledger, disk, FP, NOW);
  check("healthy notes run: no notes failure or warning", !v.failures.some((f) => f.startsWith("notes")) && !v.warnings.some((w) => w.startsWith("notes")) && v.summary.some((s) => s.startsWith("notes run success")));
}
{
  // 22 Sep: credit ran out; 'success', 8 extractor failures, nothing written; two runs since the last write.
  const s = green();
  s.notes_work!.latest = { status: "success", started_at: day(0.26), finished_at: day(0.25), facts: 0, candidates: 0, wrote: 0, errors: 0, halted: null, extractor_failed: 8, extractor_halted: null, pulled: 29, planned: null };
  s.notes_work!.newest_productive_finished_at = day(2.25);
  s.notes_work!.runs_since_productive = 2;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("22-Sep run (success, 8 extractor failures, 0 written) fails", v.failures.some((f) => f.startsWith("notes run did no work") && f.includes("8 extractor failure")), v.failures.join(" | "));
  check("22-Sep run: notes_run liveness alone still passes (why check 5 exists)", !v.failures.some((f) => f.startsWith("notes_run:")));
  check("22-Sep run: 2.25 days idle does not yet warn (limit 3)", !v.warnings.some((w) => w.includes("no fact or candidate written")));
}
{
  const s = green();
  s.notes_work!.latest = { status: "success", started_at: day(1), finished_at: day(1), facts: 3, candidates: 0, wrote: 3, errors: 0, halted: 0, extractor_failed: 2, extractor_halted: null, pulled: 40, planned: null };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("extractor failures but something written: no failure", !v.failures.some((f) => f.startsWith("notes")));
}
{
  // After the 23 Sep pb-notes change: a refused API halts the run; 'partial' because it wrote first.
  const s = green();
  s.notes_work!.latest = { status: "partial", started_at: day(0.3), finished_at: day(0.3), facts: 1, candidates: 2, wrote: 3, errors: 0, halted: 1, extractor_failed: 0, extractor_halted: 1, pulled: 30, planned: null };
  s.sources.notes_run = { newest_success_finished_at: day(0.3) };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("halted 'partial' run fails even though it wrote something", v.failures.some((f) => f.startsWith("notes run halted")), v.failures.join(" | "));
}
{
  const s = green();
  s.notes_work!.latest = { status: "failed", started_at: day(0.3), finished_at: day(0.3), facts: 0, candidates: 0, wrote: 0, errors: 0, halted: null, extractor_failed: null, extractor_halted: 1, pulled: 30, planned: null };
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("a channel's extractor_halted alone fails", v.failures.some((f) => f.startsWith("notes run halted")));
}
{
  const s = green();
  s.notes_work!.latest = { status: "success", started_at: day(0.3), finished_at: day(0.3), facts: 0, candidates: 0, wrote: 0, errors: 0, halted: 0, extractor_failed: 0, extractor_halted: null, pulled: 0, planned: null };
  s.notes_work!.newest_productive_finished_at = day(4);
  s.notes_work!.runs_since_productive = 4;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("4 days with no write while runs keep finishing warns", v.warnings.some((w) => w.includes("no fact or candidate written for 4.0 days")));
  check("…and a quiet run with no extractor failure is not itself a failure", !v.failures.some((f) => f.startsWith("notes")));
}
{
  const s = green();
  s.notes_work!.newest_productive_finished_at = null;
  s.notes_work!.runs_since_productive = 5;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("runs but never a write warns", v.warnings.some((w) => w.includes("none has ever written")));
}
{
  const s = green(); delete s.notes_work;
  const v = evaluate(s, ledger, disk, FP, NOW);
  check("notes_work missing (old function) warns that the check could not run", v.warnings.some((w) => w.includes("could not be checked")) && !v.failures.some((f) => f.startsWith("notes")));
}

console.log(`reconcile_test: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length) process.exit(1);
