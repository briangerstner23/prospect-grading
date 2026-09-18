/**
 * WLIQ Prospect Book — source coverage: every field a source hands us is either READ or
 * DELIBERATELY SKIPPED, in writing.
 *
 * Why this exists. On 17 Sep 2026 the owner asked whether LinkedIn URLs could be sourced for the
 * book. Pipedrive had been carrying `linkedin` on the organisation record since the certified
 * roster pull — declared on `PipedriveOrg`, typed, documented, and never once referenced. 306 of
 * 830 accounts, roughly half the book, for nothing. Nothing failed, because nothing asked.
 *
 * The shape of the miss is the point. `PipedriveOrg` was written from the API RESPONSE; the reader
 * was written from the RUBRIC. A field in the gap between them — offered by the source, wanted by
 * nobody yet — is invisible: no reference, no test, and `[extra: string]: unknown` swallowing the
 * rest in silence. Reading the diff never catches it, the same way reading the diff never caught
 * the agency names of DECISIONS §23. So this is mechanical, for the same reason rule 2 is.
 *
 * It is also a check on the reader of this code, not only its author. Chasing the question above,
 * a session with full access to the repository and the database got the same question wrong three
 * times running — claimed Pipedrive was unpulled (it is the single largest source, 5,741 facts),
 * claimed 72 ranked accounts were graded with the wrong rule set (it had counted `pb_facts` and
 * missed `pb_accounts.relationship_type`, which resolve_features reads FIRST), and claimed the
 * eight organisation custom fields were unread (all eight are read). "Which field feeds which key,
 * through which of two paths" is not a thing anyone holds in their head. It should be a command.
 *
 * What it enforces, symmetrically, so neither direction of drift is silent:
 *   - Every field declared on a source interface is referenced somewhere in the ingest module,
 *     or carries a written reason in SKIPPED below.
 *   - A SKIPPED field that has since been wired FAILS until its row is removed. A ledger that
 *     only ever grows is a ledger nobody trusts.
 *   - Every key in `PipedriveKeys` is dereferenced (`OK.x` / `DK.x`), or likewise excused.
 *
 * What it deliberately does NOT do: judge whether a field is read WELL, or reach the network to
 * measure fill rates. It answers one question — is this field looked at — and a false pass is
 * possible if a field's name collides with an unrelated property access. That is the safe
 * direction: it never invents a failure, and a human still decides every skip.
 *
 * NOT a ruling: the Grading Register governs, docs/DECISIONS.md records.
 * Runs under Deno and `node --experimental-strip-types`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failed = 0;
let checks = 0;
function ok(label: string, pass: boolean, detail = ""): void {
  checks++;
  if (!pass) {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * The ledger: a field here is NOT read, on purpose, with a reason a person wrote.
 * Keyed `<Interface>.<field>`. Remove the row when the field is wired — this test
 * fails while a skip claims something the code no longer does.
 * ------------------------------------------------------------------ */
const SKIPPED: Record<string, string> = {
  "PipedrivePerson.phones":
    "No graded key reads a phone number, pb_contacts has no column for one, and personal contact " +
    "details are the class of thing that must not reach a public board (DECISIONS §43: the board " +
    "is signed out, and NO EMAIL ADDRESSES reach it — a phone is the same call). Wiring this " +
    "needs the owner's say-so, not a developer's.",

  "PipedriveKeys.deal.orbit_project_url":
    "A pointer into Orbit, and Orbit is read, never written (rule 11). The overlap the book does " +
    "care about is computed from pb_orbit_clients, a snapshot filled from the read endpoints — " +
    "not from a link typed into a CRM field, which nothing validates and which goes stale silently.",

  "PipedriveOrg.industry":
    "OPEN GAP, recorded rather than quietly carried: Pipedrive's NATIVE industry field is filled " +
    "on 411 of the 661 book organisations, and the seed reads the CUSTOM \"Industry Vertical\" " +
    "field instead, filled on 159. The better-populated source is the one being ignored. It is " +
    "left unwired here on purpose: agency_type is derived from industry/services/specialties, so " +
    "adding a second industry input changes grades and belongs behind a preview run, not inside " +
    "the change that added this check. Remove this row when it is wired — the test fails until " +
    "someone does.",
};

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Field names declared on `export interface <name> { ... }`, index signatures excluded. */
function declaredFields(src: string, iface: string): string[] {
  const start = src.indexOf(`export interface ${iface} {`);
  if (start === -1) return [];
  const end = src.indexOf("\n}", start);
  if (end === -1) return [];
  const body = src.slice(start, end);
  const out: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    const m = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The module with every `export interface` block removed, so a declaration is not a "use". */
function bodyWithoutInterfaces(src: string): string {
  return src.replace(/export interface [A-Za-z0-9_]+ \{[\s\S]*?\n\}/g, "");
}

/**
 * Is this field dereferenced anywhere? Property access (`org.linkedin`, `rec?.custom_fields`) or
 * a quoted key. Word-bounded, so `industry` does NOT match `industry_category` — which is the
 * exact pair that hid a better-filled native field behind a custom one.
 */
function isRead(body: string, field: string): boolean {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${esc}\\b`).test(body) || new RegExp(`["']${esc}["']`).test(body);
}

/* ------------------------------------------------------------------ *
 * Pipedrive
 * ------------------------------------------------------------------ */

const seedPath = join(root, "ingest", "pipedrive_seed.ts");
const seed = readFileSync(seedPath, "utf8");
const seedBody = bodyWithoutInterfaces(seed);

const INTERFACES = ["PipedriveOrg", "PipedriveDeal", "PipedrivePerson"];

console.log("── source coverage: ingest/pipedrive_seed.ts");
const unread: string[] = [];
for (const iface of INTERFACES) {
  const fields = declaredFields(seed, iface);
  ok(`${iface}: declares fields`, fields.length > 0, "interface not found or empty");
  for (const f of fields) {
    const id = `${iface}.${f}`;
    const read = isRead(seedBody, f);
    const excused = Object.prototype.hasOwnProperty.call(SKIPPED, id);
    if (!read && !excused) unread.push(id);
    ok(`${id} is read or has a written reason`, read || excused,
       "declared by the source, referenced nowhere, and absent from SKIPPED");
    ok(`${id}: SKIPPED row still true`, !(read && excused),
       "listed as deliberately unread but the code reads it — remove the row");
  }
}

/* PipedriveKeys: the custom-field keys, dereferenced as OK.<name> / DK.<name>. */
for (const [group, alias] of [["org", "OK"], ["deal", "DK"]] as const) {
  const block = seed.match(new RegExp(`\\n  ${group}: \\{([\\s\\S]*?)\\n  \\},`));
  ok(`PipedriveKeys.${group}: block found`, block !== null);
  if (!block) continue;
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!m) continue;
    const id = `PipedriveKeys.${group}.${m[1]}`;
    const read = new RegExp(`\\b${alias}\\.${m[1]}\\b`).test(seedBody);
    const excused = Object.prototype.hasOwnProperty.call(SKIPPED, id);
    if (!read && !excused) unread.push(id);
    ok(`${id} is dereferenced or has a written reason`, read || excused,
       `declared in PipedriveKeys.${group} but never used as ${alias}.${m[1]}`);
    ok(`${id}: SKIPPED row still true`, !(read && excused),
       "listed as deliberately unread but the code reads it — remove the row");
  }
}

if (unread.length > 0) {
  console.error("\n  Fields a source hands us that nothing reads:");
  for (const u of unread) console.error(`    ${u}`);
  console.error("  Wire it, or add a row to SKIPPED with the reason. Silence is not a decision.\n");
}

console.log(`source_coverage: ${checks} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
