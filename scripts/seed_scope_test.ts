/**
 * WLIQ Prospect Book — scripts/seed.ts, the --only-orgs admission path.
 *
 * The roster drift queue (pb_roster_drift, migration 20260913220000) names organisations whose
 * Client Journey card moved into a prospect stage after the seed ran. They have to come in the
 * way every other account came in — through the composer, so they pick up the PRO-10 cross-check,
 * the attach rules and fact precedence — and not as a bare insert, which would produce an account
 * graded on nothing. --only-orgs is that path: compose everything, write only what was named.
 *
 * This test drives the real script as a subprocess over a synthetic input set. Every agency here
 * is invented (rule 2: no prospect data in this repository).
 *
 * Run: node --experimental-strip-types scripts/seed_scope_test.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const seedScript = join(repoRoot, "scripts", "seed.ts");
const AS_OF = "2026-09-13";

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
 * A synthetic pull: three prospect-stage organisations, one partner
 * ------------------------------------------------------------------ */

// Pipeline 9 stage ids, as pb_cj_stage_name records them.
const STAGE_NEW = 57;
const STAGE_QUOTING = 70;
const STAGE_ACTIVE_CLIENT = 63;

const ORGS = [
  { id: 9001, name: "Harborlight Creative", website: "harborlightcreative.test", stage: STAGE_NEW },
  { id: 9002, name: "Pinefall Digital", website: "pinefalldigital.test", stage: STAGE_QUOTING },
  { id: 9003, name: "Marrowstone Studio", website: "marrowstonestudio.test", stage: STAGE_NEW },
  // PRO-10: a Client Book key, so the composer must refuse it however it is asked for.
  { id: 9004, name: "Kettleburn Partners", website: "kettleburn.test", stage: STAGE_NEW },
  // A card in a partner stage: never rostered at all.
  { id: 9005, name: "Vellum Harbor Agency", website: "vellumharbor.test", stage: STAGE_ACTIVE_CLIENT },
];

function writeInputs(dir: string, existingAccounts: unknown[]): void {
  const outDir = join(dir, "seed");
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    join(dir, "pipedrive_stages.json"),
    JSON.stringify({
      data: [
        { id: STAGE_NEW, name: "New", pipeline_id: 9 },
        { id: STAGE_QUOTING, name: "Quoting", pipeline_id: 9 },
        { id: STAGE_ACTIVE_CLIENT, name: "Active Client", pipeline_id: 9 },
      ],
    }),
  );
  writeFileSync(
    join(dir, "pipedrive_cj_deals.json"),
    JSON.stringify({
      data: ORGS.map((o, i) => ({
        id: 5000 + i,
        title: `CJ - ${o.name}`,
        org_id: o.id,
        pipeline_id: 9,
        stage_id: o.stage,
        status: "open",
        add_time: "2026-09-10 12:00:00",
        update_time: "2026-09-12 12:00:00",
        stage_change_time: "2026-09-12 12:00:00",
      })),
    }),
  );
  writeFileSync(join(dir, "pipedrive_p1_open_deals.json"), JSON.stringify({ data: [] }));
  writeFileSync(
    join(dir, "pipedrive_orgs.json"),
    JSON.stringify({
      data: ORGS.map((o) => ({ id: o.id, name: o.name, website: o.website, add_time: "2026-09-01 12:00:00", update_time: "2026-09-12 12:00:00" })),
    }),
  );
  writeFileSync(
    join(dir, "pipedrive_persons.json"),
    JSON.stringify({
      persons: ORGS.map((o, i) => ({ id: 7000 + i, name: `Contact ${i + 1}`, emails: [{ value: `hello@${o.website}`, primary: true }], org_id: o.id, job_title: "Owner" })),
    }),
  );
  writeFileSync(join(dir, "pipedrive_activities.json"), JSON.stringify({ activities: [] }));
  writeFileSync(join(dir, "notion_prospects.json"), JSON.stringify([]));
  writeFileSync(join(dir, "prospect_domains.json"), JSON.stringify({ by_account: {} }));
  writeFileSync(join(dir, "orbit_clients_for_prospects.json"), JSON.stringify({ lookups: [] }));
  writeFileSync(join(dir, "orbit_quotes.json"), JSON.stringify({ rows: [] }));
  writeFileSync(join(dir, "fathom_backfill.json"), JSON.stringify({ meetings: [] }));

  writeFileSync(
    join(outDir, "client_book_keys.json"),
    JSON.stringify({
      grading_roster: [{ client_key: "kettleburnpartners", name: "Kettleburn Partners", status: "active", effective_tier: "T2" }],
      grading_book_keys: ["kettleburnpartners"],
      pb_accounts: existingAccounts,
    }),
  );
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  dir: string;
  outDir: string;
}

function run(args: string[], existingAccounts: unknown[] = []): Run {
  const dir = mkdtempSync(join(tmpdir(), "pb-seed-scope-"));
  writeInputs(dir, existingAccounts);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", seedScript, "--in", dir, "--as-of", AS_OF, "--uuid-seed", "scope-test", ...args],
    { encoding: "utf8" },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", dir, outDir: join(dir, "seed") };
}

const sql = (r: Run, base: string): string => {
  const path = join(r.outDir, `${base}.sql`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const manifest = (r: Run): Record<string, any> => JSON.parse(readFileSync(join(r.outDir, "manifest.json"), "utf8"));

/* ------------------------------------------------------------------ *
 * 1 · A full run composes every prospect-stage organisation
 * ------------------------------------------------------------------ */

{
  const r = run([]);
  eq("full run exits 0", r.code, 0);
  const m = manifest(r);
  eq("full run: scope is null", m.counts.scope, null);
  // 9001–9003 roster; 9004 is a Client Book key (PRO-10); 9005's card is in a partner stage.
  eq("full run: three accounts", m.counts.accounts.total, 3);
  eq("full run: PRO-10 dropped one", m.counts.skipped.pipedrive_agency_partner.length, 1);
  check("full run: the partner-stage card never rostered", !sql(r, "01_accounts").includes("Vellum Harbor"), sql(r, "01_accounts"));
  rmSync(r.dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 2 · --only-orgs writes one organisation and withholds the rest
 * ------------------------------------------------------------------ */

{
  const r = run(["--only-orgs", "9002"]);
  eq("scoped run exits 0", r.code, 0);
  const m = manifest(r);
  const scope = m.counts.scope;
  check("scoped run: scope is reported", scope !== null && scope !== undefined);
  eq("scoped run: one account written", m.counts.accounts.total, 1);
  eq("scoped run: two accounts withheld", scope.withheld_accounts, 2);
  eq("scoped run: the admitted org", scope.admitted[0].pipedrive_org_id, 9002);

  const accountsSql = sql(r, "01_accounts");
  check("scoped run: the admitted account is in 01_accounts", accountsSql.includes("Pinefall Digital"), accountsSql);
  check("scoped run: the others are not", !accountsSql.includes("Harborlight") && !accountsSql.includes("Marrowstone"), accountsSql);

  // Every dependent pack is narrowed with it — a fact or a contact belonging to a withheld
  // account is the thing that would quietly corrupt an admission.
  check("scoped run: contacts are narrowed", !sql(r, "02_contacts").includes("harborlightcreative.test"), sql(r, "02_contacts"));
  // Facts carry an account id, not a name, so the check that matters is that every id in the
  // pack is the admitted account's — one withheld account's fact is what would corrupt this.
  const uuidsIn = (text: string): Set<string> => new Set([...text.matchAll(/\$q\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\$q\$::uuid/g)].map((m) => m[1] as string));
  const admittedId = [...uuidsIn(accountsSql)][0];
  check("scoped run: 01_accounts names exactly one account", uuidsIn(accountsSql).size === 1, accountsSql);
  const factIds = uuidsIn(sql(r, "03_facts"));
  eq("scoped run: the facts pack names exactly one account", factIds.size, 1);
  eq("scoped run: and it is the admitted one", [...factIds][0], admittedId);
  const contactIds = uuidsIn(sql(r, "02_contacts"));
  eq("scoped run: the contacts pack names only the admitted account", [...contactIds].filter((id) => id !== admittedId).length, 0);

  // The admitted account is composed, not blank: the drift row's whole point.
  check("scoped run: the admitted account carries facts", m.counts.facts.written > 0, JSON.stringify(m.counts.facts.written));
  eq("scoped run: the run record says what kind of run it was", sql(r, "08_runs").includes("admit:roster_drift"), true);
  check("scoped run: SUMMARY is headed as an admission", readFileSync(join(r.outDir, "SUMMARY.md"), "utf8").startsWith("# Admission dry run"));
  rmSync(r.dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 3 · Several ids at once, and the @file form the drift queue exports
 * ------------------------------------------------------------------ */

{
  const r = run(["--only-orgs", "9001,9003"]);
  eq("two ids: exits 0", r.code, 0);
  eq("two ids: two accounts", manifest(r).counts.accounts.total, 2);
  rmSync(r.dir, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), "pb-seed-scope-file-"));
  const queue = join(dir, "drift.json");
  writeFileSync(queue, JSON.stringify([{ direction: "missing", pipedrive_org_id: 9001, org_name: "Harborlight Creative" }, { direction: "missing", pipedrive_org_id: 9003, org_name: "Marrowstone Studio" }]));
  const r = run(["--only-orgs", `@${queue}`]);
  eq("@file of drift rows: exits 0", r.code, 0);
  eq("@file of drift rows: two accounts", manifest(r).counts.accounts.total, 2);
  rmSync(r.dir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 4 · An id the run did not compose stops it, and says why
 * ------------------------------------------------------------------ */

{
  const r = run(["--only-orgs", "9004"]);
  check("PRO-10 id: exits non-zero", r.code !== 0, `code ${r.code}`);
  check("PRO-10 id: says PRO-10", r.stderr.includes("PRO-10"), r.stderr);
  rmSync(r.dir, { recursive: true, force: true });
}

{
  const r = run(["--only-orgs", "9005"]);
  check("partner-stage id: exits non-zero", r.code !== 0, `code ${r.code}`);
  check("partner-stage id: says the roster did not compose it", r.stderr.includes("composed roster"), r.stderr);
  rmSync(r.dir, { recursive: true, force: true });
}

{
  const r = run(["--only-orgs", "424242"]);
  check("unknown id: exits non-zero", r.code !== 0, `code ${r.code}`);
  check("unknown id: names the id", r.stderr.includes("424242"), r.stderr);
  rmSync(r.dir, { recursive: true, force: true });
}

{
  const r = run(["--only-orgs", "not-an-id"]);
  check("non-numeric id: exits non-zero", r.code !== 0, `code ${r.code}`);
  rmSync(r.dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 5 · An organisation already in the book is refused — 02/03/04/07 are plain inserts
 * ------------------------------------------------------------------ */

const EXISTING = [{ id: "11111111-2222-4333-8444-555555555555", key: "pinefall-digital", name: "Pinefall Digital", domain: "pinefalldigital.test", pipedrive_org_id: 9002, orbit_client_id: null, notion_client_id: null }];

{
  const r = run(["--only-orgs", "9002"], EXISTING);
  check("already a row: exits non-zero", r.code !== 0, `code ${r.code}`);
  check("already a row: explains the duplicate-insert risk", r.stderr.includes("duplicate"), r.stderr);
  rmSync(r.dir, { recursive: true, force: true });
}

{
  const r = run(["--only-orgs", "9002", "--allow-existing"], EXISTING);
  eq("already a row with --allow-existing: exits 0", r.code, 0);
  eq("already a row with --allow-existing: one account", manifest(r).counts.accounts.total, 1);
  rmSync(r.dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */

if (failed > 0) {
  console.error(`seed_scope_test: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`seed_scope_test: ${passed} passed, 0 failed`);
