/**
 * WLIQ Prospect Book — one-time seed composer (GENERATE ONLY; writes SQL files, never the database).
 *
 *   node --experimental-strip-types scripts/seed.ts --in <inputs dir> [--out <dir>] [--as-of YYYY-MM-DD]
 *     [--uuid-seed <text>] [--chunk-kb <n>] [--only-orgs <ids|@file>] [--allow-existing]
 *
 * Composes the four intake sources into ONE consistent set of pb_* rows and writes numbered SQL
 * files (each ≤ 150 KB, each a single transaction) that the orchestrator applies through the
 * Supabase MCP `execute_sql`, one file per call, in lexical order. See scripts/seed_README.md.
 *
 * The mappers do the reading (ingest/pipedrive_seed.ts, notion_seed.ts, orbit_quotes.ts,
 * fathom_webhook.ts); this script only COMPOSES: it assigns account ids, applies the PRO-10
 * cross-check against the Client Book reference pull, attaches Notion rows to Pipedrive
 * organisations on a HIGH key (domain) and never on a name, carries Orbit client ids across,
 * decides fact precedence (Pipedrive wins where both speak; Notion fills what Pipedrive lacks),
 * validates every row against the schema's constraints and the rubric's signal catalog, and
 * fails loudly on anything it cannot vouch for.
 *
 * Inputs (all JSON, in --in): notion_prospects.json · orbit_quotes.json ·
 * orbit_clients_for_prospects.json · fathom_backfill.json · pipedrive_stages.json ·
 * pipedrive_cj_deals.json · pipedrive_p1_open_deals.json · pipedrive_orgs.json ·
 * pipedrive_persons.json · pipedrive_activities.json · prospect_domains.json, plus the read-only
 * reference pull seed/client_book_keys.json (grading_roster + grading_book keys + existing
 * pb_accounts rows), saved by the orchestrator before this runs.
 *
 * --only-orgs makes the run an ADMISSION rather than a seed: the whole composition still runs,
 * exactly as a full seed would — the same PRO-10 cross-check, the same Notion attach rule, the
 * same fact precedence — and then only the rows belonging to the named Pipedrive organisations
 * are written out. That is what the roster drift queue needs (pb_roster_drift, migration
 * 20260913220000): an organisation whose card moved into a prospect stage after the seed ran is
 * brought in the same way every other account arrived, not inserted bare. Scoping is an OUTPUT
 * filter on purpose — attach and precedence decisions depend on the whole set, so they are made
 * against the whole set and only the emission is narrowed.
 *
 * Deterministic for a given --as-of, apart from account uuids; pass --uuid-seed to derive those
 * from a seed so a re-run reproduces the same ids. No prospect data lives in this file: every
 * name flows from the inputs to the scratchpad outputs and never into the repository.
 *
 * Runs under `node --experimental-strip-types` (Node 22+): relative .ts imports, `import type`,
 * no enums, no decorators, no parameter properties. node:fs / node:crypto / node:path only.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { KnownAccount } from "../ingest/identity.ts";
import { norm, normalizeDomain, proposeMatches } from "../ingest/identity.ts";
import type { RosterFact } from "../ingest/pipedrive_seed.ts";
import { mapPipedriveRoster } from "../ingest/pipedrive_seed.ts";
import type { SeedFact } from "../ingest/notion_seed.ts";
import { mapNotionProspects } from "../ingest/notion_seed.ts";
import type { OrbitProjectRow } from "../ingest/orbit_quotes.ts";
import { mapOrbitQuotes } from "../ingest/orbit_quotes.ts";
import type { FathomWebhookPayload } from "../ingest/fathom_webhook.ts";
import { parseFathomWebhook } from "../ingest/fathom_webhook.ts";

// Every date this script parses is treated as UTC, whatever machine runs it.
process.env.TZ = "UTC";

/* ------------------------------------------------------------------ *
 * Arguments and paths
 * ------------------------------------------------------------------ */

interface Args {
  as_of: string;
  uuid_seed: string | null;
  in_dir: string;
  out_dir: string;
  /** null = write everything (a full seed). Otherwise: emit only these organisations' rows. */
  only_orgs: number[] | null;
  /** With --only-orgs: permit an organisation that is already a pb_accounts row. */
  allow_existing: boolean;
}

/**
 * --only-orgs takes a comma/whitespace list of Pipedrive organisation ids, or `@<path>` to a file
 * holding them. The file may be one id per line, a JSON array of ids, or a JSON array of objects
 * carrying `pipedrive_org_id` — the shape a `pb_roster_drift` export has, so the queue can be
 * handed to the composer without being retyped.
 */
function parseOnlyOrgs(spec: string | null): number[] | null {
  if (spec === null) return null;
  let text = spec;
  if (spec.startsWith("@")) {
    const path = resolve(spec.slice(1));
    if (!existsSync(path)) fail(`--only-orgs ${spec}: no such file ${path}`);
    text = readFileSync(path, "utf8");
  }
  const ids: number[] = [];
  const add = (v: unknown): void => {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n <= 0) fail(`--only-orgs: ${JSON.stringify(v)} is not a Pipedrive organisation id`);
    if (!ids.includes(n)) ids.push(n);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fail("--only-orgs: the file looks like JSON but does not parse");
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of rows) {
      if (r !== null && typeof r === "object") {
        const v = (r as Record<string, unknown>).pipedrive_org_id;
        if (v === undefined || v === null) fail("--only-orgs: a JSON object in the file carries no pipedrive_org_id");
        add(v);
      } else {
        add(r);
      }
    }
  } else {
    for (const tok of trimmed.split(/[\s,;]+/)) if (tok !== "") add(tok);
  }
  if (ids.length === 0) fail("--only-orgs was given but names no organisation ids");
  return ids;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === `--${name}`) return argv[i + 1] ?? null;
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
    }
    return null;
  };
  const in_dir = get("in") ?? process.env.PB_SEED_IN ?? null;
  if (in_dir === null) fail("--in <inputs dir> is required (or set PB_SEED_IN)");
  const as_of = get("as-of") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of)) fail(`--as-of must be YYYY-MM-DD, got ${JSON.stringify(as_of)}`);
  return {
    as_of,
    uuid_seed: get("uuid-seed"),
    in_dir: resolve(in_dir as string),
    out_dir: resolve(get("out") ?? process.env.PB_SEED_OUT ?? join(in_dir as string, "seed")),
    only_orgs: parseOnlyOrgs(get("only-orgs") ?? process.env.PB_SEED_ONLY_ORGS ?? null),
    allow_existing: argv.includes("--allow-existing"),
  };
}

function fail(msg: string): never {
  console.error(`seed: ${msg}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = parseArgs(process.argv.slice(2));

function readJson<T = unknown>(path: string): T {
  if (!existsSync(path)) fail(`missing input ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
const input = <T = unknown>(name: string): T => readJson<T>(join(args.in_dir, name));

const rubric = readJson<Record<string, any>>(join(repoRoot, "core", "rubric.prospect.v0.1.json"));
const catalog: Record<string, unknown> = rubric?.signals?.catalog ?? {};
if (Object.keys(catalog).length === 0) fail("rubric.signals.catalog is empty");

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

/** Keep only the rows a predicate accepts, in place; returns how many were dropped. */
function retain<T>(rows: T[], keep: (row: T) => boolean): number {
  let w = 0;
  for (let r = 0; r < rows.length; r++) if (keep(rows[r] as T)) rows[w++] = rows[r] as T;
  const dropped = rows.length - w;
  rows.length = w;
  return dropped;
}

function bump(counter: Record<string, number>, key: string, n = 1): void {
  counter[key] = (counter[key] ?? 0) + n;
}

function sortedCounter(c: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function int(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Deterministic RFC-4122-shaped uuid from a seed and parts (v4 version/variant bits set). */
function uuidFrom(seed: string, ...parts: string[]): string {
  const h = createHash("sha256").update([seed, ...parts].join(" ")).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const newAccountId = (key: string): string => (args.uuid_seed !== null ? uuidFrom(args.uuid_seed, "account", key) : randomUUID());

/** "YYYY-MM-DD HH:MM:SS" (no zone) → ISO UTC; anything else passes through. */
function utcIso(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)Z?$/);
  if (m) return `${m[1]}T${m[2]}${m[2].length === 5 ? ":00" : ""}Z`;
  return s;
}

/* ------------------------------------------------------------------ *
 * SQL literals — dollar-quoted, never concatenated raw
 * ------------------------------------------------------------------ */

function dollarTag(s: string): string {
  let tag = "$q$";
  let i = 0;
  while (s.includes(tag)) tag = `$q${++i}$`;
  return tag;
}

function lit(v: string | null | undefined): string {
  if (v === null || v === undefined) return "null";
  const clean = v.replace(/ /g, "");
  const tag = dollarTag(clean);
  return `${tag}${clean}${tag}`;
}

function jsonb(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const s = JSON.stringify(v, (_k, val) => (typeof val === "string" ? val.replace(/ /g, "") : val));
  return `${lit(s)}::jsonb`;
}

function num(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "null";
}
function bool(v: boolean | null | undefined): string {
  return typeof v === "boolean" ? (v ? "true" : "false") : "null";
}
function date(v: string | null | undefined): string {
  return v === null || v === undefined ? "null" : `${lit(v)}::date`;
}
function ts(v: string | null | undefined): string {
  return v === null || v === undefined ? "null" : `${lit(v)}::timestamptz`;
}
function uuid(v: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) fail(`not a uuid: ${v}`);
  return `${lit(v)}::uuid`;
}
function textArray(v: string[]): string {
  return v.length === 0 ? "'{}'::text[]" : `array[${v.map((s) => lit(s)).join(", ")}]::text[]`;
}
const row = (...cells: string[]): string => `(${cells.join(", ")})`;

/* ------------------------------------------------------------------ *
 * SQL files: numbered, ≤ 150 KB, one transaction each
 * ------------------------------------------------------------------ */

const FILE_LIMIT_BYTES = (() => {
  // --chunk-kb <n> caps each SQL file (default 150 KB). Smaller files travel better through a
  // tool call whose payload is a single string; the load order and the transactions are unchanged.
  const i = process.argv.indexOf("--chunk-kb");
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return (Number.isFinite(n) && n >= 8 ? n : 150) * 1024;
})();
const FILE_TARGET_BYTES = FILE_LIMIT_BYTES - 2 * 1024; // margin for the header comment
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

interface SqlFile {
  name: string;
  bytes: number;
  rows: number;
}
const sqlFiles: SqlFile[] = [];

/** Splits `rows` across as many files as the size limit needs; each file is `begin; insert …; commit;`. */
function writeInsert(base: string, head: string, rows: string[], tail: string): void {
  if (rows.length === 0) return;
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = bytes("begin;\n") + bytes(head) + bytes(tail) + bytes(";\ncommit;\n");
  for (const r of rows) {
    const add = bytes(r) + 2;
    if (current.length > 0 && size + add > FILE_TARGET_BYTES) {
      chunks.push(current);
      current = [];
      size = bytes("begin;\n") + bytes(head) + bytes(tail) + bytes(";\ncommit;\n");
    }
    current.push(r);
    size += add;
  }
  if (current.length > 0) chunks.push(current);
  chunks.forEach((chunk, i) => {
    const name = chunks.length === 1 ? `${base}.sql` : `${base}_${String(i + 1).padStart(2, "0")}.sql`;
    const header = `-- WLIQ Prospect Book seed · ${name} · as_of ${args.as_of} · generated by scripts/seed.ts · part ${i + 1}/${chunks.length} · ${chunk.length} rows\n`;
    const body = `${header}begin;\n${head}${chunk.join(",\n")}${tail};\ncommit;\n`;
    const n = bytes(body);
    if (n > FILE_LIMIT_BYTES) fail(`${name} is ${n} bytes; a single row exceeds the file limit`);
    writeFileSync(join(args.out_dir, name), body);
    sqlFiles.push({ name, bytes: n, rows: chunk.length });
  });
}

/* ------------------------------------------------------------------ *
 * Reference: the Client Book keys (PRO-10) and existing pb_accounts rows
 * ------------------------------------------------------------------ */

interface ReferencePull {
  grading_roster: Array<{ client_key: string; name: string; status: string | null; effective_tier: string | null }>;
  grading_book_keys: string[];
  pb_accounts: Array<{ id: string; key: string; name: string; domain: string | null; pipedrive_org_id: number | string | null; orbit_client_id: number | string | null; notion_client_id: string | null }>;
}

mkdirSync(args.out_dir, { recursive: true });
const refPath = join(args.out_dir, "client_book_keys.json");
if (!existsSync(refPath)) fail(`${refPath} is missing — the orchestrator saves the read-only reference pull there first (see scripts/seed_README.md)`);
const reference = readJson<ReferencePull>(refPath);
const clientBookKeys = new Set<string>([...reference.grading_roster.map((r) => r.client_key), ...reference.grading_book_keys]);
if (clientBookKeys.size === 0) fail("client_book_keys.json carries no keys");
const clientBookNameByKey = new Map<string, string>(reference.grading_roster.map((r) => [r.client_key, r.name]));

/** The Client Book's own key shape, as observed in grading_roster: lower-case, these words dropped, non-alphanumerics removed. */
const CLIENT_BOOK_STRIP = new Set(["the", "inc", "llc", "ltd", "group", "co", "corp", "company", "associates", "assoc"]);
function lowerAlnum(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
}
function clientBookStyleKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !CLIENT_BOOK_STRIP.has(w))
    .join("");
}

interface ClientBookHit {
  client_key: string;
  client_name: string | null;
  variant: "norm_compact" | "lower_alnum" | "client_book_style";
}

/** PRO-10 cross-check: a name that IS a Client Book key under any of three spellings is an Agency Partner, never a prospect. */
function clientBookHit(name: string | null | undefined): ClientBookHit | null {
  if (name === null || name === undefined) return null;
  const variants: Array<[ClientBookHit["variant"], string]> = [
    ["norm_compact", norm(name).replace(/\s+/g, "")],
    ["lower_alnum", lowerAlnum(name)],
    ["client_book_style", clientBookStyleKey(name)],
  ];
  for (const [variant, key] of variants) {
    if (key.length > 0 && clientBookKeys.has(key)) return { client_key: key, client_name: clientBookNameByKey.get(key) ?? null, variant };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The account registry
 * ------------------------------------------------------------------ */

interface Acct {
  id: string;
  key: string;
  name: string;
  domain: string | null;
  /** The LinkedIn company page, normalised. Identity, not a graded feature — never a fact. */
  linkedin_url: string | null;
  pipedrive_org_id: number | null;
  orbit_client_id: number | null;
  notion_client_id: string | null;
  notion_page_id: string | null;
  book: "prospect" | "parked";
  roster_source: "pipedrive" | "notion_master";
  roster_certified: boolean;
  relationship_type: "agency" | "direct" | null;
  sources: Set<string>;
  flags: string[];
  existing_row: boolean;
  notion_names: string[];
}

const accounts: Acct[] = [];
const byKey = new Map<string, Acct>();
const byId = new Map<string, Acct>();
function addAccount(a: Acct): Acct {
  if (byKey.has(a.key)) fail(`duplicate account key ${JSON.stringify(a.key)}`);
  if (byId.has(a.id)) fail(`duplicate account id ${a.id}`);
  accounts.push(a);
  byKey.set(a.key, a);
  byId.set(a.id, a);
  return a;
}
const known = (): KnownAccount[] => accounts.map((a) => ({ id: a.id, key: a.key, name: a.name, domain: a.domain, pipedrive_org_id: a.pipedrive_org_id, orbit_client_id: a.orbit_client_id }));

const existingByKey = new Map<string, ReferencePull["pb_accounts"][number]>();
const existingByPdOrg = new Map<string, ReferencePull["pb_accounts"][number]>();
for (const e of reference.pb_accounts ?? []) {
  existingByKey.set(e.key, e);
  if (e.pipedrive_org_id !== null && e.pipedrive_org_id !== undefined) existingByPdOrg.set(String(e.pipedrive_org_id), e);
}

/* ------------------------------------------------------------------ *
 * Output row shapes (column names are pb_* column names)
 * ------------------------------------------------------------------ */

interface FactOut {
  account_id: string;
  key: string;
  value: unknown;
  evidence_label: string;
  source: string;
  evidence_url: string | null;
  observed_at: string | null;
  entered_by: string;
  note: string | null;
  origin: "notion" | "pipedrive" | "orbit" | "seed";
}
interface SignalOut {
  account_id: string;
  source: string;
  type: string;
  observed_at: string;
  payload: Record<string, unknown>;
  evidence_url: string | null;
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
  entered_by: string;
}
interface ContactOut {
  account_id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  pipedrive_person_id: number | null;
  is_decision_maker: boolean | null;
  source: string;
}
interface CandidateOut {
  account_id: string | null;
  source: string;
  source_id: string | null;
  source_name: string | null;
  source_domain: string | null;
  matched_on: string;
  confidence: "high" | "medium" | "low" | null;
  status: "proposed";
  note: string;
}

const EVIDENCE_LABELS = new Set(["evidence", "inferred", "unknown"]);
const SIGNAL_SOURCES = new Set(["pipedrive", "fathom", "gmail", "orbit", "apollo", "skill", "viq", "manual", "notion_master", "sheet", "tier1_book", "gotham", "brian_trip", "client_book"]);

const candidates: CandidateOut[] = [];
const runNotes: Record<string, string[]> = { pipedrive: [], notion: [], orbit: [], fathom: [], seed: [] };
const note = (lane: keyof typeof runNotes, s: string) => runNotes[lane].push(s);

/* ================================================================== *
 * 2 · Pipedrive roster (PRO-6: certified) + PRO-10 cross-check
 * ================================================================== */

const pd = mapPipedriveRoster({
  orgs: input("pipedrive_orgs.json"),
  cj_deals: input("pipedrive_cj_deals.json"),
  p1_deals: input("pipedrive_p1_open_deals.json"),
  persons: input("pipedrive_persons.json"),
  activities: input("pipedrive_activities.json"),
  stages: input("pipedrive_stages.json"),
  rubric,
  opts: { as_of: args.as_of, entered_by: "system:pipedrive" },
});
for (const n of pd.summary.notes) note("pipedrive", n);

/** Engine keys plus the short informational keys we keep. Long-text informational facts are left out (re-pullable). */
const PIPEDRIVE_KEEP = new Set([
  "icp_class", "is_agency", "agency_type", "headcount", "timing", "timing_state", "referral_from_network",
  "money", "specification", "authority", "service_shape", "deal_size_estimate",
  "pipedrive_cj_deal_id", "pipedrive_cj_stage", "pipedrive_lead_source", "pipedrive_stated_budget",
  "pipedrive_services_of_interest", "pipedrive_salesperson", "pipedrive_account_manager",
  "pipedrive_lost_reason", "pipedrive_client_stage",
]);

interface SkippedAccount {
  name: string;
  key: string;
  reason: string;
  matched_client_key?: string;
  matched_client_name?: string | null;
  matched_variant?: string;
  pipedrive_org_id?: number | null;
  notion_client_id?: string | null;
  cj_stage?: string | null;
}
const skippedPipedrive: SkippedAccount[] = [];
const pdDroppedKeys = new Set<string>();
const pdKeyToId = new Map<string, string>();
let existingReused = 0;

for (const a of pd.accounts) {
  const hit = clientBookHit(a.name);
  if (hit) {
    skippedPipedrive.push({
      name: a.name, key: a.key, reason: "already an Agency Partner (Client Book)",
      matched_client_key: hit.client_key, matched_client_name: hit.client_name, matched_variant: hit.variant,
      pipedrive_org_id: a.pipedrive_org_id, cj_stage: pd.cj_index[a.key]?.stage_name ?? null,
    });
    pdDroppedKeys.add(a.key);
    continue;
  }
  let key = a.key;
  let id: string;
  let existing_row = false;
  const exOrg = existingByPdOrg.get(String(a.pipedrive_org_id));
  const exKey = existingByKey.get(a.key);
  if (exOrg) {
    id = exOrg.id;
    key = exOrg.key;
    existing_row = true;
  } else if (exKey && (exKey.pipedrive_org_id === null || exKey.pipedrive_org_id === undefined || String(exKey.pipedrive_org_id) === String(a.pipedrive_org_id))) {
    id = exKey.id;
    existing_row = true;
  } else {
    if (exKey) {
      key = `${a.key} pipedrive-${a.pipedrive_org_id}`;
      note("seed", `Pipedrive org ${a.pipedrive_org_id}: key ${JSON.stringify(a.key)} belongs to an existing pb_accounts row with a different pipedrive_org_id; kept separately as ${JSON.stringify(key)} (never merged on name)`);
    }
    id = newAccountId(key);
  }
  if (existing_row) existingReused++;
  pdKeyToId.set(a.key, id);
  addAccount({
    id, key, name: a.name, domain: a.domain, linkedin_url: a.linkedin_url, pipedrive_org_id: a.pipedrive_org_id, orbit_client_id: null,
    notion_client_id: null, notion_page_id: null, book: a.book, roster_source: "pipedrive", roster_certified: true,
    relationship_type: a.relationship_type, sources: new Set(["pipedrive"]), flags: [...a.flags], existing_row, notion_names: [],
  });
}

const pdFacts: FactOut[] = [];
const pdInformationalDropped: Record<string, number> = {};
for (const f of pd.facts as RosterFact[]) {
  if (pdDroppedKeys.has(f.account_key)) continue;
  if (!PIPEDRIVE_KEEP.has(f.key)) {
    bump(pdInformationalDropped, f.key);
    continue;
  }
  const account_id = pdKeyToId.get(f.account_key);
  if (!account_id) fail(`Pipedrive fact for unknown account key ${f.account_key}`);
  pdFacts.push({ account_id, key: f.key, value: f.value, evidence_label: f.evidence_label, source: f.source, evidence_url: f.evidence_url, observed_at: f.observed_at, entered_by: f.entered_by, note: f.note, origin: "pipedrive" });
}

/* ================================================================== *
 * 3 · Notion master (uncertified intake) — attach on domain, never on name
 * ================================================================== */

/** The export encodes multi-selects as JSON-array strings and stamps dates "YYYY-MM-DD HH:MM:SSZ"; both are shaped here, nothing is re-interpreted. */
function adaptNotionRows(rows: Rec[]): { rows: Rec[]; json_array_cells: number } {
  let json_array_cells = 0;
  const out = rows.map((r) => {
    const o: Rec = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && /^\s*\[/.test(v)) {
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) {
            o[k] = parsed;
            json_array_cells++;
            continue;
          }
        } catch {
          /* not JSON; keep the text */
        }
      }
      o[k] = v;
    }
    return o;
  });
  return { rows: out, json_array_cells };
}

const notionRaw = input<Rec[]>("notion_prospects.json");
const notionAdapted = adaptNotionRows(notionRaw);
const nt = mapNotionProspects(notionAdapted.rows as any, { rubric, entered_by: "system:notion_master", as_of: args.as_of });
for (const n of nt.notes) note("notion", n);

const prospectDomains = input<{ by_account?: Record<string, string[]> }>("prospect_domains.json").by_account ?? {};

const skippedNotion: SkippedAccount[] = [];
const notionKeyToId = new Map<string, string>();
const notionByClientId = new Map<string, Acct>();
const notionAttached: Array<{ notion_name: string; notion_client_id: string | null; account: Acct; domain: string }> = [];
const notionCreated: Acct[] = [];
const seedNoteFacts: FactOut[] = [];
const knownBeforeNotion = known();
let notionDomainsSupplemented = 0;

for (const n of nt.accounts) {
  const hit = clientBookHit(n.name);
  if (hit) {
    skippedNotion.push({ name: n.name, key: n.key, reason: "already an Agency Partner (Client Book)", matched_client_key: hit.client_key, matched_client_name: hit.client_name, matched_variant: hit.variant, notion_client_id: n.notion_client_id });
    continue;
  }
  let domain = n.domain;
  if (domain === null) {
    const extra = (prospectDomains[n.name] ?? []).map((d) => normalizeDomain(d)).find((d): d is string => d !== null) ?? null;
    if (extra !== null) {
      domain = extra;
      notionDomainsSupplemented++;
      note("seed", `${n.name}: no contact-email domain in the Notion row; domain ${extra} taken from prospect_domains.json`);
    }
  }

  const proposal = proposeMatches({ source: "notion", source_id: n.notion_client_id, name: n.name, domain }, knownBeforeNotion);

  if (proposal.attach !== null) {
    const target = byId.get(proposal.attach.id) as Acct;
    const matchedOn = proposal.candidates.find((c) => c.account_id === target.id)?.matched_on ?? "domain";
    target.sources.add("notion_master");
    target.notion_names.push(n.name);
    if (target.notion_client_id === null) target.notion_client_id = n.notion_client_id;
    else if (n.notion_client_id !== null && target.notion_client_id !== n.notion_client_id) {
      candidates.push({ account_id: target.id, source: "notion", source_id: n.notion_client_id, source_name: n.name, source_domain: domain, matched_on: matchedOn, confidence: "high", status: "proposed", note: `second Notion row attached to the same Pipedrive organisation ${target.pipedrive_org_id} on ${matchedOn}; notion_client_id ${target.notion_client_id} is already carried — a person decides whether these are one company` });
      note("seed", `${n.name} (Notion ${n.notion_client_id}) attached to an account that already carries Notion ${target.notion_client_id}; queued for review`);
    }
    if (target.notion_page_id === null) target.notion_page_id = n.notion_page_id ?? null;
    if (target.relationship_type === null) target.relationship_type = n.relationship_type;
    if (target.domain === null) target.domain = domain;
    notionKeyToId.set(n.key, target.id);
    if (n.notion_client_id !== null) notionByClientId.set(n.notion_client_id, target);
    notionAttached.push({ notion_name: n.name, notion_client_id: n.notion_client_id, account: target, domain: domain as string });
    seedNoteFacts.push({
      account_id: target.id, key: "notion_attached_on", value: domain, evidence_label: "evidence", source: "notion_master", evidence_url: null,
      observed_at: args.as_of, entered_by: "system:seed",
      note: `Notion "Client Name" = ${JSON.stringify(n.name)} (Client ID ${n.notion_client_id ?? "?"}) attached to Pipedrive organisation ${target.pipedrive_org_id ?? "?"} ${JSON.stringify(target.name)}: Notion contact-email domain equals the organisation domain (high, ${matchedOn}); the Notion account row was not created`,
      origin: "seed",
    });
    for (const c of proposal.candidates) {
      if (c.account_id === target.id) continue;
      const other = byId.get(c.account_id) as Acct;
      candidates.push({ account_id: other.id, source: "notion", source_id: n.notion_client_id, source_name: n.name, source_domain: domain, matched_on: c.matched_on, confidence: c.confidence, status: "proposed", note: `Notion row attached to account ${target.id} (${JSON.stringify(target.name)}) on domain but ALSO matched this account (${c.confidence} on ${c.matched_on}) — a conflict a person must see` });
    }
    continue;
  }

  // Create the Notion account. A norm(name) collision with a rostered account is MEDIUM: separate row, disambiguated key, merge-queue row.
  let key = n.key;
  let id: string;
  let existing_row = false;
  const flags: string[] = [];
  const ex = existingByKey.get(key);
  if (ex && !byKey.has(key) && (ex.pipedrive_org_id === null || ex.pipedrive_org_id === undefined)) {
    id = ex.id;
    existing_row = true;
    existingReused++;
  } else {
    if (byKey.has(key) || ex) {
      key = `${n.key} notion-${n.notion_client_id ?? lowerAlnum(n.name)}`;
      flags.push("Duplicate name key");
    }
    id = newAccountId(key);
  }
  const acct = addAccount({
    id, key, name: n.name, domain, linkedin_url: null, pipedrive_org_id: null, orbit_client_id: null, notion_client_id: n.notion_client_id,
    notion_page_id: n.notion_page_id ?? null, book: "prospect", roster_source: "notion_master", roster_certified: false,
    relationship_type: n.relationship_type, sources: new Set(["notion_master"]), flags, existing_row, notion_names: [n.name],
  });
  notionKeyToId.set(n.key, acct.id);
  if (n.notion_client_id !== null) notionByClientId.set(n.notion_client_id, acct);
  notionCreated.push(acct);
  for (const c of proposal.candidates) {
    const other = byId.get(c.account_id) as Acct;
    const viaPipedrive = other.pipedrive_org_id !== null;
    candidates.push({
      account_id: acct.id,
      source: viaPipedrive ? "pipedrive" : other.roster_source,
      source_id: viaPipedrive ? String(other.pipedrive_org_id) : (other.notion_client_id ?? other.key),
      source_name: other.name,
      source_domain: other.domain,
      matched_on: c.matched_on,
      confidence: c.confidence,
      status: "proposed",
      note: `Notion prospect ${JSON.stringify(n.name)} (Client ID ${n.notion_client_id ?? "?"}) matches ${viaPipedrive ? `Pipedrive organisation ${other.pipedrive_org_id}` : `account ${other.key}`} ${JSON.stringify(other.name)} on ${c.matched_on} only (${c.confidence}); kept as a separate account ${JSON.stringify(acct.key)} — never merged on a name; a person decides`,
    });
  }
}

// Notion rows that share a domain with each other (and matched no Pipedrive organisation) are one company by §4a; queued, never merged here.
{
  const byDomain = new Map<string, Acct>();
  for (const a of notionCreated) {
    if (a.domain === null) continue;
    const first = byDomain.get(a.domain);
    if (!first) {
      byDomain.set(a.domain, a);
      continue;
    }
    candidates.push({ account_id: first.id, source: "notion", source_id: a.notion_client_id, source_name: a.name, source_domain: a.domain, matched_on: "domain", confidence: "high", status: "proposed", note: `two Notion rows share the domain ${a.domain}: ${JSON.stringify(first.name)} and ${JSON.stringify(a.name)} were both created as accounts; a person confirms the merge (pb_merge_accounts)` });
    note("seed", `${first.name} and ${a.name} share domain ${a.domain}; both created, merge queued for review`);
  }
}

const notionFactsRaw: FactOut[] = [];
for (const f of nt.facts as SeedFact[]) {
  const account_id = notionKeyToId.get(f.account_key);
  if (!account_id) continue; // account skipped under PRO-10
  notionFactsRaw.push({ account_id, key: f.key, value: f.value, evidence_label: f.evidence_label, source: f.source, evidence_url: null, observed_at: f.observed_at, entered_by: f.entered_by, note: f.note, origin: "notion" });
}

/* ================================================================== *
 * 4 · Orbit: client ids from the lookup file, then the quotes
 * ================================================================== */

interface OrbitLookup {
  notion_client_id: number | string;
  prospect_name: string;
  prospect_domain?: string | null;
  note?: string | null;
  candidates: Array<{ id: number; company_name: string; company_email?: string | null; website_link?: string | null; match?: string; match_basis?: string; client_type?: string | null }>;
  best: { orbit_client_id: number | null; match: "high" | "medium" | "low" | "none" };
}
const orbitLookups = input<{ lookups: OrbitLookup[] }>("orbit_clients_for_prospects.json").lookups;
const orbitLookupCounts: Record<string, number> = {};
const orbitLookupSkipped: Array<{ prospect_name: string; notion_client_id: string; match: string; reason: string }> = [];
let orbitIdsAttached = 0;
const orbitNameToId = new Map<string, number | null>(); // null = ambiguous

for (const l of orbitLookups) {
  for (const c of l.candidates ?? []) {
    const nm = str(c.company_name)?.toLowerCase();
    if (!nm || c.id === undefined || c.id === null) continue;
    const prev = orbitNameToId.get(nm);
    if (prev === undefined) orbitNameToId.set(nm, c.id);
    else if (prev !== null && prev !== c.id) orbitNameToId.set(nm, null);
  }
}
for (const l of orbitLookups) {
  const match = l.best?.match ?? "none";
  bump(orbitLookupCounts, match);
  if (match === "none") continue;
  const acct = notionByClientId.get(String(l.notion_client_id));
  if (!acct) {
    orbitLookupSkipped.push({ prospect_name: l.prospect_name, notion_client_id: String(l.notion_client_id), match, reason: "Notion prospect not seeded (PRO-10 or mapper skip)" });
    continue;
  }
  const orbitId = int(l.best.orbit_client_id);
  const cand = (l.candidates ?? []).find((c) => c.id === orbitId) ?? null;
  const source_domain = normalizeDomain(cand?.website_link ?? null) ?? normalizeDomain(cand?.company_email ?? null);
  const basis = `${cand?.match_basis ?? match}${l.note ? `; ${l.note}` : ""}`;
  if (orbitId === null) continue;
  if (match === "high") {
    const holder = accounts.find((a) => a.orbit_client_id === orbitId);
    if (holder && holder.id !== acct.id) {
      candidates.push({ account_id: acct.id, source: "orbit", source_id: String(orbitId), source_name: cand?.company_name ?? null, source_domain, matched_on: "orbit_client_id", confidence: "high", status: "proposed", note: `Orbit client ${orbitId} is already carried by account ${holder.id} (${JSON.stringify(holder.name)}); this account also matched it high (${basis}) — a person decides` });
      continue;
    }
    if (acct.orbit_client_id !== null && acct.orbit_client_id !== orbitId) {
      candidates.push({ account_id: acct.id, source: "orbit", source_id: String(orbitId), source_name: cand?.company_name ?? null, source_domain, matched_on: "domain", confidence: "high", status: "proposed", note: `account already carries Orbit client ${acct.orbit_client_id}; a second high match (${basis}) is queued` });
      continue;
    }
    acct.orbit_client_id = orbitId;
    acct.sources.add("orbit");
    if (acct.domain === null && source_domain !== null) acct.domain = source_domain;
    orbitIdsAttached++;
    continue;
  }
  const matched_on = /normali[sz]ed name/i.test(cand?.match_basis ?? "") ? "name_norm" : "name_contains";
  candidates.push({ account_id: acct.id, source: "orbit", source_id: String(orbitId), source_name: cand?.company_name ?? null, source_domain, matched_on, confidence: match, status: "proposed", note: `Orbit client lookup for ${JSON.stringify(l.prospect_name)}: ${basis}; not attached (only high attaches)` });
}

interface QuoteRow extends OrbitProjectRow {
  id: number | string;
}
const quotesIn = input<{ rows: QuoteRow[] }>("orbit_quotes.json").rows;
const agencyPartnerQuotes: Array<{ id: number | string; client_name: string | null; life_cycle_status: string | null; client_key: string }> = [];
const quoteRows: QuoteRow[] = [];
let quotesEnriched = 0;
for (const q of quotesIn) {
  const cn = str(q.client_name);
  const hit = cn === null ? null : clientBookHit(cn);
  if (hit) {
    agencyPartnerQuotes.push({ id: q.id, client_name: cn, life_cycle_status: str(q.life_cycle_status), client_key: hit.client_key });
    continue;
  }
  const orbitId = cn === null ? undefined : orbitNameToId.get(cn.toLowerCase());
  const client_id = orbitId === undefined || orbitId === null ? null : orbitId;
  if (client_id !== null) quotesEnriched++;
  quoteRows.push({ ...q, created_at: utcIso(q.created_at), project_start_date: utcIso(q.project_start_date), client_id });
}
const oq = mapOrbitQuotes(quoteRows, known(), rubric, { entered_by: "system:orbit", as_of: args.as_of });
for (const n of oq.notes) note("orbit", n);
const attachedQuoteIds = new Set(oq.signals.map((s) => String(s.payload.project_id)));
const pendingClientKeys = new Set(oq.candidates.map((c) => norm(c.source_name)));
const unmatchedQuotes: Array<{ id: number | string; client_name: string | null; life_cycle_status: string | null }> = [];
const pendingQuotes: Array<{ id: number | string; client_name: string | null; life_cycle_status: string | null }> = [];
for (const q of quoteRows) {
  if (attachedQuoteIds.has(String(q.id))) continue;
  const entry = { id: q.id, client_name: str(q.client_name), life_cycle_status: str(q.life_cycle_status) };
  if (str(q.client_name) !== null && pendingClientKeys.has(norm(q.client_name))) pendingQuotes.push(entry);
  else unmatchedQuotes.push(entry);
}
for (const s of oq.signals) (byId.get(s.account_id) as Acct).sources.add("orbit");
for (const c of oq.candidates) candidates.push({ account_id: c.account_id, source: "orbit", source_id: c.source_id, source_name: c.source_name, source_domain: null, matched_on: c.matched_on, confidence: c.confidence, status: "proposed", note: c.note });
const orbitFacts: FactOut[] = oq.facts.map((f) => ({ account_id: f.account_id, key: f.key, value: f.value, evidence_label: f.evidence_label, source: f.source, evidence_url: f.evidence_url, observed_at: f.observed_at, entered_by: f.entered_by, note: f.note, origin: "orbit" }));

/* ================================================================== *
 * 5 · Fathom back-fill → pb_calls
 * ================================================================== */

interface FathomMeeting {
  recording_id: number | string;
  title?: string | null;
  url?: string | null;
  share_url?: string | null;
  created_iso?: string | null;
  recorded_by?: { name?: string | null; email?: string | null } | string | null;
  attendees?: Array<{ name?: string | null; email?: string | null; is_external?: boolean | null }> | null;
  summary?: string | null;
  action_items?: unknown;
}
interface CallOut {
  account_id: string | null;
  fathom_recording_id: string;
  title: string | null;
  held_at: string | null;
  url: string | null;
  recorded_by: string | null;
  attendees: unknown[];
  external_domains: string[];
  summary: string | null;
}
const meetings = input<{ meetings: FathomMeeting[] }>("fathom_backfill.json").meetings;
const calls: CallOut[] = [];
const callsSkipped: Array<{ recording_id: string; title: string | null; reason: string }> = [];
const fathomDomainsNotInBook: Record<string, number> = {};
const knownAll = known();
for (const m of meetings) {
  const payload: FathomWebhookPayload = {
    recording_id: m.recording_id,
    title: m.title ?? null,
    url: m.share_url ?? m.url ?? null,
    created_at: m.created_iso ?? null,
    recorded_by: m.recorded_by ?? null,
    calendar_invitees: m.attendees ?? null,
    default_summary: m.summary ?? null,
    action_items: m.action_items ?? null,
  };
  const r = parseFathomWebhook(payload, knownAll);
  for (const n of r.notes) note("fathom", `${m.recording_id}: ${n}`);
  if (r.skip_reason !== null) {
    callsSkipped.push({ recording_id: String(m.recording_id), title: m.title ?? null, reason: r.skip_reason });
    continue;
  }
  calls.push({
    account_id: r.attach?.id ?? null,
    fathom_recording_id: r.call.fathom_recording_id,
    title: r.call.title,
    held_at: r.call.held_at,
    url: r.call.url,
    recorded_by: r.call.recorded_by,
    attendees: r.call.attendees,
    external_domains: r.call.external_domains,
    summary: r.call.summary,
  });
  if (r.attach) (byId.get(r.attach.id) as Acct).sources.add("fathom");
  for (const c of r.candidates) {
    if (r.attach && c.account_id === null) {
      // The call attached elsewhere; another external domain on it is not in the book. Counted, not queued.
      if (c.source_domain) bump(fathomDomainsNotInBook, c.source_domain);
      continue;
    }
    candidates.push({ account_id: c.account_id, source: "fathom", source_id: c.source_id, source_name: c.source_name, source_domain: c.source_domain, matched_on: c.matched_on, confidence: c.confidence, status: "proposed", note: c.note ?? "" });
    if (c.account_id === null && c.source_domain) bump(fathomDomainsNotInBook, c.source_domain);
  }
}

/* ================================================================== *
 * 6 · Compose: facts (precedence), contacts (dedupe), signals (validate + dedupe), deals
 * ================================================================== */

/** Notion keys that always fill even when Pipedrive speaks (Pipedrive never emits them today; Pipedrive still wins by created_at if it ever does). */
const NOTION_ALWAYS_FILL = new Set(["wl_signal", "stated_ceiling", "climb_signals"]);
const pdKeysByAccount = new Map<string, Set<string>>();
for (const f of pdFacts) {
  const s = pdKeysByAccount.get(f.account_id) ?? new Set<string>();
  s.add(f.key);
  pdKeysByAccount.set(f.account_id, s);
}
const notionDroppedByPrecedence: Record<string, number> = {};
const notionFacts: FactOut[] = [];
for (const f of notionFactsRaw) {
  const pdKeys = pdKeysByAccount.get(f.account_id);
  if (pdKeys && pdKeys.has(f.key) && !NOTION_ALWAYS_FILL.has(f.key)) {
    bump(notionDroppedByPrecedence, f.key);
    continue;
  }
  notionFacts.push(f);
}
// Emission order = created_at order: Notion first, Pipedrive later (Pipedrive supersedes on a shared key), Orbit, then the seed's own notes.
const facts: FactOut[] = [...notionFacts, ...pdFacts, ...orbitFacts, ...seedNoteFacts];
for (const f of facts) {
  if (!byId.has(f.account_id)) fail(`fact ${f.key} references unknown account ${f.account_id}`);
  if (!EVIDENCE_LABELS.has(f.evidence_label)) fail(`fact ${f.key}: evidence_label ${JSON.stringify(f.evidence_label)} is not valid`);
  if (str(f.entered_by) === null) fail(`fact ${f.key}: entered_by is empty`);
  if (str(f.key) === null || str(f.source) === null) fail(`fact with empty key or source on account ${f.account_id}`);
}

const contacts: ContactOut[] = [];
let contactsDeduped = 0;
{
  const seen = new Set<string>();
  const push = (c: ContactOut) => {
    const k = c.email !== null ? `${c.account_id}|email:${c.email.toLowerCase()}` : c.pipedrive_person_id !== null ? `${c.account_id}|pid:${c.pipedrive_person_id}` : `${c.account_id}|name:${(c.name ?? "").toLowerCase()}`;
    if (seen.has(k)) {
      contactsDeduped++;
      return;
    }
    seen.add(k);
    contacts.push(c);
  };
  for (const c of pd.contacts) {
    if (pdDroppedKeys.has(c.account_key)) continue;
    push({ account_id: pdKeyToId.get(c.account_key) as string, name: c.name, email: c.email, title: c.title, pipedrive_person_id: c.pipedrive_person_id, is_decision_maker: c.is_decision_maker, source: c.source });
  }
  for (const c of nt.contacts) {
    const account_id = notionKeyToId.get(c.account_key);
    if (!account_id) continue;
    push({ account_id, name: c.name, email: c.email, title: c.title, pipedrive_person_id: null, is_decision_maker: null, source: c.source });
  }
}

const signals: SignalOut[] = [];
let signalsDeduped = 0;
const signalFallbacksUsed: Record<string, number> = {};
{
  const seen = new Set<string>();
  const push = (s: SignalOut) => {
    if (!catalog[s.type]) fail(`signal type ${JSON.stringify(s.type)} is not in rubric.signals.catalog (account ${s.account_id}, source ${s.source})`);
    if (!SIGNAL_SOURCES.has(s.source)) fail(`signal source ${JSON.stringify(s.source)} is not allowed by pb_signals`);
    if (str(s.entered_by) === null) fail(`signal ${s.type}: entered_by is empty`);
    if (!Number.isFinite(s.weight)) fail(`signal ${s.type}: weight is not a number`);
    if (!Number.isFinite(Date.parse(s.observed_at))) fail(`signal ${s.type}: observed_at ${JSON.stringify(s.observed_at)} is not a date`);
    if (!byId.has(s.account_id)) fail(`signal ${s.type} references unknown account ${s.account_id}`);
    if (typeof s.payload?.requested_type === "string") bump(signalFallbacksUsed, `${s.payload.requested_type}→${s.type}`);
    // "Identical" includes the payload: several prior_grade rows legitimately share account, type, date and source.
    const k = [s.account_id, s.type, s.observed_at, s.source, JSON.stringify(s.payload ?? null)].join("|");
    if (seen.has(k)) {
      signalsDeduped++;
      return;
    }
    seen.add(k);
    signals.push(s);
  };
  for (const s of pd.signals) {
    if (pdDroppedKeys.has(s.account_key)) continue;
    push({ account_id: pdKeyToId.get(s.account_key) as string, source: s.source, type: s.type, observed_at: s.observed_at, payload: s.payload, evidence_url: s.evidence_url, weight: s.weight, lifespan_days: s.lifespan_days, decays: s.decays, entered_by: s.entered_by });
  }
  for (const s of nt.signals) {
    const account_id = notionKeyToId.get(s.account_key);
    if (!account_id) continue;
    push({ account_id, source: s.source, type: s.type, observed_at: s.observed_at, payload: s.payload, evidence_url: null, weight: s.weight, lifespan_days: s.lifespan_days, decays: s.decays, entered_by: s.entered_by });
  }
  for (const s of oq.signals) {
    push({ account_id: s.account_id, source: s.source, type: s.type, observed_at: s.observed_at, payload: s.payload, evidence_url: s.evidence_url, weight: s.weight, lifespan_days: s.lifespan_days, decays: s.decays, entered_by: s.entered_by });
  }
}

const deals = pd.deals.filter((d) => !pdDroppedKeys.has(d.account_key));

// Merge-queue rows: one per (account, source, source id); a later duplicate adds its note to the first.
const candidateRows: CandidateOut[] = [];
let candidatesMerged = 0;
{
  const seen = new Map<string, CandidateOut>();
  for (const c of candidates) {
    if (c.account_id !== null && !byId.has(c.account_id)) fail(`identity candidate references unknown account ${c.account_id}`);
    const k = `${c.account_id ?? ""}|${c.source}|${c.source_id ?? ""}|${c.source_domain ?? ""}`;
    const prev = seen.get(k);
    if (prev) {
      candidatesMerged++;
      if (c.note && !prev.note.includes(c.note)) prev.note = `${prev.note} | ${c.note}`;
      continue;
    }
    seen.set(k, c);
    candidateRows.push(c);
  }
}

/* ================================================================== *
 * 5b · Scope — with --only-orgs, emit one admission rather than a seed
 * ================================================================== */

interface ScopeReport {
  only_orgs: number[];
  admitted: Array<{ key: string; name: string; pipedrive_org_id: number | null; book: string; already_a_row: boolean }>;
  withheld_accounts: number;
  withheld_rows: Record<string, number>;
  note: string;
}

let scope: ScopeReport | null = null;

if (args.only_orgs !== null) {
  const wanted = new Set(args.only_orgs.map((n) => String(n)));
  const admitted = accounts.filter((a) => a.pipedrive_org_id !== null && wanted.has(String(a.pipedrive_org_id)));
  const found = new Set(admitted.map((a) => String(a.pipedrive_org_id)));

  // An id this run did not compose is a stop, not a silent no-op: either the pull does not cover
  // it, or PRO-10 refused it — and the second is the answer to the question, not an error.
  const missing = [...wanted].filter((org) => !found.has(org));
  if (missing.length) {
    const why = (org: string): string => {
      const partner = skippedPipedrive.find((sk) => String(sk.pipedrive_org_id ?? "") === org);
      if (partner) {
        return `PRO-10: the cross-check reads it as an Agency Partner (${partner.matched_client_name ?? partner.matched_client_key ?? "Client Book"}) — it never enters this book`;
      }
      return "not in this run's composed roster — check that pipedrive_orgs.json / pipedrive_cj_deals.json cover it and that its most recently updated open Client Journey card is in a prospect stage";
    };
    fail(`--only-orgs names ${missing.length} organisation(s) this run did not compose:\n` + missing.map((org) => `  ${org}: ${why(org)}`).join("\n"));
  }

  // 02/03/04/07 are plain inserts. Re-emitting them for an account that is already a row would
  // duplicate its facts, not update them, so an organisation already in the book is a stop too.
  const already = admitted.filter((a) => a.existing_row || (a.pipedrive_org_id !== null && existingByPdOrg.has(String(a.pipedrive_org_id))));
  if (already.length && !args.allow_existing) {
    fail(
      `--only-orgs names ${already.length} organisation(s) already in pb_accounts:\n` +
        already.map((a) => `  ${a.pipedrive_org_id}: ${a.key}`).join("\n") +
        "\n02/03/04/07 are plain inserts, so applying this run would duplicate their contacts, facts, signals and\n" +
        "candidates rather than update them. Drop those ids, or pass --allow-existing if you have decided the\n" +
        "duplicate rows are what you want.",
    );
  }

  const admittedIds = new Set(admitted.map((a) => a.id));
  const before = { accounts: accounts.length, contacts: contacts.length, facts: facts.length, signals: signals.length, calls: calls.length, deals: deals.length, identity_candidates: candidateRows.length };

  retain(accounts, (a) => admittedIds.has(a.id));
  retain(contacts, (c) => admittedIds.has(c.account_id));
  retain(facts, (f) => admittedIds.has(f.account_id));
  retain(signals, (sg) => admittedIds.has(sg.account_id));
  retain(calls, (c) => c.account_id !== null && admittedIds.has(c.account_id));
  retain(deals, (d) => admittedIds.has(pdKeyToId.get(d.account_key) as string));
  retain(candidateRows, (c) => c.account_id !== null && admittedIds.has(c.account_id));

  scope = {
    only_orgs: args.only_orgs,
    admitted: admitted.map((a) => ({ key: a.key, name: a.name, pipedrive_org_id: a.pipedrive_org_id, book: a.book, already_a_row: a.existing_row })),
    withheld_accounts: before.accounts - accounts.length,
    withheld_rows: {
      contacts: before.contacts - contacts.length,
      facts: before.facts - facts.length,
      signals: before.signals - signals.length,
      calls: before.calls - calls.length,
      deals: before.deals - deals.length,
      identity_candidates: before.identity_candidates - candidateRows.length,
    },
    note: "Scoped run. The composition ran whole — PRO-10, the Notion attach rule and fact precedence were all decided against every source row — and only the named organisations' rows were written. Row counts below describe what was written; the attachment, skip and Orbit tables describe the whole composition the decisions were made in.",
  };
}

/* ================================================================== *
 * 6 · Write the SQL
 * ================================================================== */

for (const f of readdirSync(args.out_dir)) if (/^\d\d_.*\.sql$/.test(f)) unlinkSync(join(args.out_dir, f));

// 01 · accounts
writeInsert(
  "01_accounts",
  "insert into pb_accounts (id, key, name, domain, linkedin_url, pipedrive_org_id, orbit_client_id, notion_client_id, notion_page_id, book, roster_source, roster_certified, relationship_type) values\n",
  accounts.map((a) => row(uuid(a.id), lit(a.key), lit(a.name), lit(a.domain), lit(a.linkedin_url), num(a.pipedrive_org_id), num(a.orbit_client_id), lit(a.notion_client_id), lit(a.notion_page_id), lit(a.book), lit(a.roster_source), bool(a.roster_certified), lit(a.relationship_type))),
  `\non conflict (key) do update set
  name = excluded.name,
  domain = coalesce(pb_accounts.domain, excluded.domain),
  linkedin_url = coalesce(pb_accounts.linkedin_url, excluded.linkedin_url),
  pipedrive_org_id = coalesce(pb_accounts.pipedrive_org_id, excluded.pipedrive_org_id),
  orbit_client_id = coalesce(pb_accounts.orbit_client_id, excluded.orbit_client_id),
  notion_client_id = coalesce(pb_accounts.notion_client_id, excluded.notion_client_id),
  notion_page_id = coalesce(pb_accounts.notion_page_id, excluded.notion_page_id),
  roster_certified = pb_accounts.roster_certified or excluded.roster_certified,
  roster_source = case when excluded.roster_certified and not pb_accounts.roster_certified then excluded.roster_source else pb_accounts.roster_source end,
  relationship_type = coalesce(pb_accounts.relationship_type, excluded.relationship_type),
  book = case when pb_accounts.book in ('promoted', 'merged') then pb_accounts.book else excluded.book end`,
);

// 02 · contacts
writeInsert(
  "02_contacts",
  "insert into pb_contacts (account_id, name, email, title, pipedrive_person_id, is_decision_maker, source) values\n",
  contacts.map((c) => row(uuid(c.account_id), lit(c.name), lit(c.email), lit(c.title), num(c.pipedrive_person_id), bool(c.is_decision_maker), lit(c.source))),
  "",
);

// 03 · facts — explicit created_at, 1 ms apart in emission order, so pb_current_facts is deterministic
const factBaseMs = Date.parse(`${args.as_of}T00:00:00.000Z`);
writeInsert(
  "03_facts",
  "insert into pb_facts (account_id, key, value, evidence_label, source, evidence_url, observed_at, entered_by, stand_in, note, created_at) values\n",
  facts.map((f, i) => row(uuid(f.account_id), lit(f.key), jsonb(f.value), lit(f.evidence_label), lit(f.source), lit(f.evidence_url), date(f.observed_at), lit(f.entered_by), "false", lit(f.note), ts(new Date(factBaseMs + i).toISOString()))),
  "",
);

// 04 · signals
writeInsert(
  "04_signals",
  "insert into pb_signals (account_id, source, type, observed_at, payload, evidence_url, weight, lifespan_days, decays, entered_by) values\n",
  signals.map((s) => row(uuid(s.account_id), lit(s.source), lit(s.type), ts(s.observed_at), jsonb(s.payload), lit(s.evidence_url), num(s.weight), num(s.lifespan_days), bool(s.decays), lit(s.entered_by))),
  "",
);

// 05 · calls
writeInsert(
  "05_calls",
  "insert into pb_calls (account_id, fathom_recording_id, title, held_at, url, recorded_by, attendees, external_domains, summary, transcript_available, fields, extraction_status) values\n",
  calls.map((c) => row(c.account_id === null ? "null" : uuid(c.account_id), lit(c.fathom_recording_id), lit(c.title), ts(c.held_at), lit(c.url), lit(c.recorded_by), jsonb(c.attendees), textArray(c.external_domains), lit(c.summary), "false", "null", "'pending'")),
  "\non conflict (fathom_recording_id) do nothing",
);

// 06 · deals
writeInsert(
  "06_deals",
  "insert into pb_deals (pipedrive_deal_id, account_id, title, pipeline_id, stage_id, stage_name, stage_entered_at, value, currency, close_date, close_date_pushes, status, won_time, lost_time, owner_user_id, is_cj, next_meeting_at, calls_held, raw) values\n",
  deals.map((d) => row(num(d.pipedrive_deal_id), uuid(pdKeyToId.get(d.account_key) as string), lit(d.title), num(d.pipeline_id), num(d.stage_id), lit(d.stage_name), ts(d.stage_entered_at), num(d.value), lit(d.currency), date(d.close_date), "'[]'::jsonb", lit(d.status), ts(d.won_time), ts(d.lost_time), num(d.owner_user_id), "false", ts(d.next_meeting_at), num(d.calls_held), jsonb(d.raw))),
  `\non conflict (pipedrive_deal_id) do update set
  account_id = excluded.account_id, title = excluded.title, pipeline_id = excluded.pipeline_id, stage_id = excluded.stage_id,
  stage_name = excluded.stage_name, stage_entered_at = excluded.stage_entered_at, value = excluded.value, currency = excluded.currency,
  close_date = excluded.close_date, close_date_pushes = pb_deals.close_date_pushes, status = excluded.status, won_time = excluded.won_time,
  lost_time = excluded.lost_time, owner_user_id = excluded.owner_user_id, is_cj = excluded.is_cj, next_meeting_at = excluded.next_meeting_at,
  calls_held = excluded.calls_held, raw = excluded.raw, updated_at = now()`,
);

// 07 · identity candidates (the merge queue; nothing here is merged)
writeInsert(
  "07_identity_candidates",
  "insert into pb_identity_candidates (account_id, source, source_id, source_name, source_domain, matched_on, confidence, status, note) values\n",
  candidateRows.map((c) => row(c.account_id === null ? "null" : uuid(c.account_id), lit(c.source), lit(c.source_id), lit(c.source_name), lit(c.source_domain), lit(c.matched_on), lit(c.confidence), lit(c.status), lit(c.note))),
  "",
);

/* ---- counts for pb_runs and the summary ---- */
const countBy = <T>(items: T[], f: (t: T) => string): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const it of items) bump(c, f(it));
  return sortedCounter(c);
};
const notionSkippedByMapper = nt.skipped;
const counts = {
  as_of: args.as_of,
  uuid_seed: args.uuid_seed !== null,
  scope,
  accounts: {
    total: accounts.length,
    by_roster_source: countBy(accounts, (a) => a.roster_source),
    by_book: countBy(accounts, (a) => a.book),
    pipedrive_with_notion_attached: accounts.filter((a) => a.roster_source === "pipedrive" && a.sources.has("notion_master")).length,
    notion_created: notionCreated.length,
    with_orbit_client_id: accounts.filter((a) => a.orbit_client_id !== null).length,
    with_domain: accounts.filter((a) => a.domain !== null).length,
    existing_rows_reused: existingReused,
    flags: countBy(accounts.flatMap((a) => a.flags), (f) => f),
  },
  contacts: { written: contacts.length, by_source: countBy(contacts, (c) => c.source), deduped: contactsDeduped },
  facts: {
    written: facts.length,
    by_source: countBy(facts, (f) => f.source),
    by_key: countBy(facts, (f) => f.key),
    notion_dropped_by_precedence: sortedCounter(notionDroppedByPrecedence),
    pipedrive_informational_left_out: sortedCounter(pdInformationalDropped),
    precedence: "Notion facts first, Pipedrive facts later (created_at +1 ms per row): Pipedrive supersedes on a shared key; Notion fills keys Pipedrive lacks; wl_signal/stated_ceiling/climb_signals always from Notion",
  },
  signals: { written: signals.length, by_type: countBy(signals, (s) => s.type), by_source: countBy(signals, (s) => s.source), deduped: signalsDeduped, catalog_fallbacks_used: sortedCounter(signalFallbacksUsed) },
  calls: { written: calls.length, attached: calls.filter((c) => c.account_id !== null).length, unattached: calls.filter((c) => c.account_id === null).length, skipped: callsSkipped, other_external_domains_not_in_book: sortedCounter(fathomDomainsNotInBook) },
  deals: { written: deals.length, by_stage: countBy(deals, (d) => d.stage_name ?? "unknown") },
  identity_candidates: { written: candidateRows.length, by_source: countBy(candidateRows, (c) => c.source), by_confidence: countBy(candidateRows, (c) => c.confidence ?? "null"), by_matched_on: countBy(candidateRows, (c) => c.matched_on), merged_duplicates: candidatesMerged },
  skipped: {
    pipedrive_agency_partner: skippedPipedrive,
    pipedrive_mapper_by_reason: sortedCounter(pd.summary.skipped_by_reason),
    notion_agency_partner: skippedNotion,
    notion_mapper: notionSkippedByMapper,
  },
  orbit: {
    lookups_by_match: sortedCounter(orbitLookupCounts),
    orbit_client_ids_attached: orbitIdsAttached,
    lookups_not_seeded: orbitLookupSkipped,
    quotes_total: quotesIn.length,
    quotes_enriched_with_client_id: quotesEnriched,
    quotes_attached: oq.summary.attached,
    quotes_pending_review: oq.summary.pending_review,
    quotes_unmatched: unmatchedQuotes.length,
    agency_partner_quotes_count: agencyPartnerQuotes.length,
    quote_signals_by_type: sortedCounter(oq.summary.by_type),
    quote_amount_facts: oq.facts.length,
    unmatched_quotes: unmatchedQuotes,
    pending_review_quotes: pendingQuotes,
    agency_partner_quotes: agencyPartnerQuotes,
  },
  notion: { rows: notionRaw.length, json_array_cells_parsed: notionAdapted.json_array_cells, attached_to_pipedrive: notionAttached.map((a) => ({ notion: a.notion_name, notion_client_id: a.notion_client_id, account_key: a.account.key, domain: a.domain })), domains_from_prospect_domains_json: notionDomainsSupplemented },
  pipedrive: { roster_orgs: pd.summary.roster_orgs, by_cj_stage: pd.summary.by_cj_stage, p1_only: pd.summary.p1_only, parked: pd.summary.parked },
  fathom: { meetings: meetings.length },
  notes_count: Object.fromEntries(Object.entries(runNotes).map(([k, v]) => [k, v.length])),
};

// 08 · the run record
writeInsert(
  "08_runs",
  "insert into pb_runs (kind, source, triggered_by, started_at, finished_at, status, counts, errors) values\n",
  [row("'seed'", lit(scope === null ? "notion_master+pipedrive+orbit+fathom" : "admit:roster_drift"), "'build-session'", "now()", "now()", "'success'", jsonb(counts), "null")],
  "",
);

/* ================================================================== *
 * 7 · Dry-run summary
 * ================================================================== */

const totalBytes = sqlFiles.reduce((n, f) => n + f.bytes, 0);
writeFileSync(join(args.out_dir, "manifest.json"), JSON.stringify({ as_of: args.as_of, uuid_seed: args.uuid_seed !== null, files: sqlFiles, total_bytes: totalBytes, counts }, null, 1));
writeFileSync(join(args.out_dir, "notes.txt"), Object.entries(runNotes).map(([lane, ns]) => `## ${lane} (${ns.length})\n${ns.map((n) => `- ${n}`).join("\n")}`).join("\n\n") + "\n");

const md: string[] = [];
const h = (s: string) => md.push(`\n## ${s}\n`);
const table = (headers: string[], rows: Array<Array<string | number | null>>) => {
  md.push(`| ${headers.join(" | ")} |`);
  md.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) md.push(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
};
const counterTable = (c: Record<string, number>, label: string) => table([label, "n"], Object.entries(c).map(([k, v]) => [k, v]));

md.push(`# ${scope === null ? "Seed" : "Admission"} dry run — ${args.as_of}`);
md.push(`\nGenerated by \`scripts/seed.ts\` (uuid seed: ${args.uuid_seed !== null ? "yes — ids reproducible" : "no — random ids"}). Nothing was applied. Files are in this directory; apply in lexical order, one \`execute_sql\` call per file.`);

if (scope !== null) {
  h("Scope — this run admits named organisations, it is not a full seed");
  md.push(`\`--only-orgs\` named ${scope.only_orgs.length} Pipedrive organisation(s); ${scope.admitted.length} account(s) were written.\n`);
  table(["pipedrive_org_id", "key", "name", "book", "already a pb_accounts row"], scope.admitted.map((a) => [a.pipedrive_org_id, a.key, a.name, a.book, a.already_a_row ? "yes" : "no"]));
  md.push(`\nWithheld: ${scope.withheld_accounts} accounts and their rows — ${Object.entries(scope.withheld_rows).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  md.push(`\n${scope.note}`);
}

h("SQL files");
table(["file", "rows", "bytes"], sqlFiles.map((f) => [f.name, f.rows, f.bytes]));
md.push(`\nTotal: ${sqlFiles.length} files, ${totalBytes} bytes (${(totalBytes / 1024).toFixed(1)} KB); every file ≤ ${FILE_LIMIT_BYTES} bytes.`);

h("Accounts");
counterTable(counts.accounts.by_roster_source, "roster_source");
md.push("");
counterTable(counts.accounts.by_book, "book");
md.push(`\n- Pipedrive accounts that also carry a Notion row (attached on domain): ${counts.accounts.pipedrive_with_notion_attached}`);
md.push(`- Notion accounts created (no Pipedrive domain match): ${counts.accounts.notion_created}`);
md.push(`- Accounts with orbit_client_id: ${counts.accounts.with_orbit_client_id} · with a domain: ${counts.accounts.with_domain} · existing pb_accounts rows reused: ${existingReused}`);
if (Object.keys(counts.accounts.flags).length) {
  md.push("");
  counterTable(counts.accounts.flags, "flag");
}

h("Notion → Pipedrive attachments (HIGH, domain)");
table(["Notion name", "Client ID", "attached to key", "domain"], notionAttached.map((a) => [a.notion_name, a.notion_client_id, a.account.key, a.domain]));

h("Facts");
md.push(`Written: ${facts.length}. Precedence: ${counts.facts.precedence}.\n`);
counterTable(counts.facts.by_source, "source");
md.push("");
counterTable(counts.facts.by_key, "key");
md.push("\nNotion facts NOT emitted because Pipedrive supplies the key for the same account:\n");
counterTable(counts.facts.notion_dropped_by_precedence, "key");
md.push("\nPipedrive informational facts left out to keep the load small (re-pullable from Pipedrive at any time):\n");
counterTable(counts.facts.pipedrive_informational_left_out, "key");

h("Signals");
md.push(`Written: ${signals.length} (deduped ${signalsDeduped} identical rows; identity = account, type, observed_at, source, payload). Every type is in rubric.signals.catalog.\n`);
counterTable(counts.signals.by_type, "type");
md.push("");
counterTable(counts.signals.by_source, "source");
if (Object.keys(signalFallbacksUsed).length) {
  md.push("\nCatalog fallbacks used by the Pipedrive mapper:\n");
  counterTable(signalFallbacksUsed, "requested → emitted");
}

h("Contacts");
md.push(`Written: ${contacts.length} (deduped ${contactsDeduped} on account + email / person id / name).\n`);
counterTable(counts.contacts.by_source, "source");

h("Calls (Fathom)");
md.push(`Meetings in the back-fill: ${meetings.length}. pb_calls rows: ${calls.length} — attached ${counts.calls.attached}, unattached ${counts.calls.unattached}. Skipped: ${callsSkipped.length}. transcript_available false, extraction_status pending.\n`);
table(["recording", "held_at", "account key", "external domains", "title"], calls.map((c) => [c.fathom_recording_id, c.held_at, c.account_id ? (byId.get(c.account_id) as Acct).key : "— (unattached)", c.external_domains.join(", "), c.title]));
if (callsSkipped.length) {
  md.push("");
  table(["recording", "reason", "title"], callsSkipped.map((c) => [c.recording_id, c.reason, c.title]));
}
if (Object.keys(fathomDomainsNotInBook).length) {
  md.push("\nOther external domains seen on calls that are not in the book (counted, queued only when the call did not attach):\n");
  counterTable(sortedCounter(fathomDomainsNotInBook), "domain");
}

h("Deals");
md.push(`Written: ${deals.length} open pipeline-1 deals (is_cj false).\n`);
counterTable(counts.deals.by_stage, "stage");

h("Identity candidates (merge queue)");
md.push(`Written: ${candidateRows.length} (${candidatesMerged} duplicate proposals folded into an earlier row's note). Nothing is merged by the seed.\n`);
counterTable(counts.identity_candidates.by_source, "source");
md.push("");
counterTable(counts.identity_candidates.by_confidence, "confidence");
md.push("");
counterTable(counts.identity_candidates.by_matched_on, "matched_on");

h("Skipped — PRO-10: already an Agency Partner (Client Book)");
md.push(`Pipedrive roster organisations dropped (with every dependent row): ${skippedPipedrive.length}\n`);
table(["name", "key", "Client Book key", "Client Book name", "matched via", "CJ stage", "org id"], skippedPipedrive.map((s) => [s.name, s.key, s.matched_client_key ?? "", s.matched_client_name ?? "", s.matched_variant ?? "", s.cj_stage ?? "", s.pipedrive_org_id ?? ""]));
md.push(`\nNotion rows dropped: ${skippedNotion.length}\n`);
table(["name", "key", "Client Book key", "Client Book name", "matched via", "Notion Client ID"], skippedNotion.map((s) => [s.name, s.key, s.matched_client_key ?? "", s.matched_client_name ?? "", s.matched_variant ?? "", s.notion_client_id ?? ""]));
md.push(`\nNotion rows the mapper itself skipped: ${notionSkippedByMapper.length}\n`);
table(["name", "reason"], notionSkippedByMapper.map((s) => [s.name, s.reason]));
md.push("\nPipedrive organisations the mapper did not roster, by reason:\n");
counterTable(counts.skipped.pipedrive_mapper_by_reason, "reason");

h("Orbit");
md.push("Client lookups (orbit_clients_for_prospects.json), by best match:\n");
counterTable(counts.orbit.lookups_by_match, "match");
md.push(`\n- orbit_client_id set on ${orbitIdsAttached} accounts (high only); medium/low went to the merge queue.`);
if (orbitLookupSkipped.length) md.push(`- Lookups whose Notion prospect was not seeded: ${orbitLookupSkipped.map((l) => `${l.prospect_name} (${l.match})`).join("; ")}`);
md.push(`\nQuotes: ${quotesIn.length} total · ${agencyPartnerQuotes.length} are Agency Partner quotes (Client Book, not ours; counted only) · ${quoteRows.length} mapped: ${oq.summary.attached} attached (signals written), ${oq.summary.pending_review} pending review (name match only; candidate rows), ${unmatchedQuotes.length} unmatched (listed in pb_runs.counts.unmatched_quotes, not in the merge queue). ${quotesEnriched} quote rows were enriched with an Orbit client id from the lookup file. quote_amount facts: ${oq.facts.length}.\n`);
counterTable(counts.orbit.quote_signals_by_type, "quote signal type");
md.push(`\nUnmatched quotes by client (distinct clients: ${new Set(unmatchedQuotes.map((q) => q.client_name)).size}):\n`);
counterTable(countBy(unmatchedQuotes, (q) => q.client_name ?? "(no client name)"), "client_name");
md.push(`\nAgency Partner quotes by client (distinct: ${new Set(agencyPartnerQuotes.map((q) => q.client_name)).size}):\n`);
counterTable(countBy(agencyPartnerQuotes, (q) => `${q.client_name} → ${q.client_key}`), "client_name → Client Book key");
if (pendingQuotes.length) {
  md.push("\nPending-review quotes by client:\n");
  counterTable(countBy(pendingQuotes, (q) => q.client_name ?? "(no client name)"), "client_name");
}

h("Spot check — 5 accounts with the most sources");
const sample = [...accounts].sort((a, b) => b.sources.size - a.sources.size || (a.key < b.key ? -1 : 1)).slice(0, 5);
for (const a of sample) {
  const fk = facts.filter((f) => f.account_id === a.id).map((f) => `${f.key} (${f.source})`);
  md.push(`\n### ${a.key}\n`);
  md.push(`- name: ${a.name} · roster_source ${a.roster_source} · book ${a.book} · sources: ${[...a.sources].join(", ")} · domain ${a.domain ?? "—"} · pipedrive_org_id ${a.pipedrive_org_id ?? "—"} · orbit_client_id ${a.orbit_client_id ?? "—"} · notion_client_id ${a.notion_client_id ?? "—"}`);
  md.push(`- facts (${fk.length}): ${fk.join("; ")}`);
  md.push(`- signals ${signals.filter((s) => s.account_id === a.id).length} · contacts ${contacts.filter((c) => c.account_id === a.id).length} · deals ${deals.filter((d) => pdKeyToId.get(d.account_key) === a.id).length} · calls ${calls.filter((c) => c.account_id === a.id).length} · candidates ${candidateRows.filter((c) => c.account_id === a.id).length}`);
}

h("Input-shape notes");
md.push(`- Notion export: ${notionAdapted.json_array_cells} multi-select cells arrived as JSON-array strings and were parsed before mapping; "Last edited" is "YYYY-MM-DD HH:MM:SSZ" (parsed as UTC). ${notionDomainsSupplemented} Notion accounts took their domain from prospect_domains.json because the row carries no contact email.`);
md.push(`- Orbit: project timestamps carry no zone; treated as UTC. No quote row carries a client id; ids were joined from the lookup file by exact (case-insensitive) company name.`);
md.push(`- Fathom: records are Markdown-parsed; payloads were rebuilt as {recording_id, title, url: share_url ?? url, created_at: created_iso, recorded_by, calendar_invitees: attendees, default_summary: summary, action_items}. Transcripts were not requested (transcript_available false).`);
md.push(`- Mapper notes: ${Object.entries(counts.notes_count).map(([k, v]) => `${k} ${v}`).join(", ")} — full text in notes.txt.`);

writeFileSync(join(args.out_dir, "SUMMARY.md"), md.join("\n") + "\n");

if (scope !== null) console.log(`seed: SCOPED — --only-orgs named ${scope.only_orgs.length} organisation(s); ${scope.admitted.length} account(s) written, ${scope.withheld_accounts} withheld`);
console.log(`seed: ${accounts.length} accounts · ${contacts.length} contacts · ${facts.length} facts · ${signals.length} signals · ${calls.length} calls · ${deals.length} deals · ${candidateRows.length} candidates`);
console.log(`seed: ${sqlFiles.length} SQL files, ${totalBytes} bytes → ${args.out_dir}`);
console.log(`seed: skipped as Agency Partners — Pipedrive ${skippedPipedrive.length}, Notion ${skippedNotion.length}; unmatched quotes ${unmatchedQuotes.length}; Agency Partner quotes ${agencyPartnerQuotes.length}`);
