/**
 * WLIQ Prospect Book — the sales-meeting reader's four layers agree on every name (DECISIONS §65).
 *
 * The reader is written in four places that cannot see each other: the migration (four tables,
 * their check constraints, six definer functions), the pure core (ingest/meeting_*.ts), the pb-notes
 * orchestration (meetings.ts, meetings_pure.ts) and the review screen (web/index.html#meetings).
 * Each has its own tests. This one reads all four and fails when they disagree about a NAME:
 *
 *   · a column one layer writes, reads or filters on that the table does not have;
 *   · a value one layer emits — a status, a kind, a mode, a basis — that a check constraint refuses,
 *     or one the table allows that the screen has nowhere to show;
 *   · an rpc argument the function does not take, or a required one the caller leaves out;
 *   · an item or edit key the page sends that pb_decide_meeting_card never reads (a silent no-op),
 *     or a result key the page waits for that the function never returns;
 *   · a format the table checks (quote_at, speaker, lengths, option count) that the core does not
 *     produce, and the schedule's body against the options pb-notes parses.
 *
 * Every one of those is a mistake the database would report only at the first real write — as a
 * refused batch, a refused card, or as nothing at all. The objects are read from the NEWEST
 * migration that defines them, so the file keeps working once the drafts are re-filed under their
 * applied versions. Values are collected by RUNNING the pure code where it can be run, and from
 * the source text only where it cannot (meetings.ts needs Deno).
 *
 * Synthetic throughout (rule 2): accounts are ids, speakers are roles, quotes are invented.
 *
 * Run: node --experimental-strip-types scripts/meeting_contract_test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import vm from "node:vm";

import {
  CONTEXT_MAX_CHARS,
  MODES,
  proposalRows,
  READ_STATES,
  READ_TOPICS,
} from "../ingest/meeting_claims.ts";
import type { ProposalCluster, ProposalRow, VerifiedClaim } from "../ingest/meeting_claims.ts";
import { MATCHED_ON, MAX_OPTIONS, MENTION_STATES } from "../ingest/meeting_mentions.ts";
import {
  clockText,
  LOCKED_STATUSES,
  QUOTE_MAX_CHARS,
  QUOTE_MIN_CHARS,
  selectMeeting,
  transcriptLines,
} from "../ingest/meeting_transcript.ts";
import {
  CLAIMABLE_STATUSES,
  DEFAULT_BUDGET_MS,
  LEASE_MS,
  MAX_CONCURRENCY,
  MEETING_BODY_KEYS,
  meetingRoute,
  parseMeetingBody,
  planRegistration,
  REREADABLE_STATUSES,
} from "../supabase/functions/pb-notes/meetings_pure.ts";
import type { NewRecording, RegisteredMeeting } from "../supabase/functions/pb-notes/meetings_pure.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
function sameSet(name: string, a: Iterable<string>, b: Iterable<string>): void {
  const x = sorted(a), y = sorted(b);
  check(name, JSON.stringify(x) === JSON.stringify(y), `${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
}
function subset(name: string, part: Iterable<string>, whole: Iterable<string>): void {
  const w = new Set(whole);
  const extra = sorted(part).filter((x) => !w.has(x));
  check(name, extra.length === 0, `not allowed: ${JSON.stringify(extra)}; allowed: ${JSON.stringify(sorted(w))}`);
}

/* ------------------------------------------------------------------ *
 * reading the sources
 * ------------------------------------------------------------------ */

/** SQL with its line comments removed, so prose is never read as code. */
const sqlCode = (sql: string) => sql.replace(/--[^\n]*/g, "");
const migDir = join(root, "supabase/migrations");
const migFiles = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
const migs = migFiles.map((f) => ({ file: f, sql: sqlCode(readFileSync(join(migDir, f), "utf8")) }));

/** The text inside the bracket that opens at `open` — quotes respected, nesting counted. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced bracket at ${open}`);
}

/** Split at the commas that are not inside a bracket or a string. */
function topLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** The keys of a JS object literal's text (spreads left out, shorthand kept). */
function objectKeys(objText: string): string[] {
  const keys: string[] = [];
  for (const seg of topLevel(objText)) {
    if (seg.startsWith("...")) continue;
    const m = /^(?:([A-Za-z_$][\w$]*)|["']([\w$]+)["'])\s*(?::|$)/.exec(seg);
    if (m) keys.push(m[1] ?? m[2]);
  }
  return keys;
}

/** The newest migration's CREATE TABLE body for `table`, plus every later `add column`. */
function tableDdl(table: string): { body: string; columns: string[] } {
  let body = "";
  const added: string[] = [];
  for (const { sql } of migs) {
    const m = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(`, "i").exec(sql);
    if (m) body = balanced(sql, m.index + m[0].length - 1);
    for (const a of sql.matchAll(new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${table}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_]+)`, "gi"))) added.push(a[1]);
  }
  const columns = topLevel(body)
    .map((seg) => /^([a-z_]+)\s/.exec(seg)?.[1] ?? "")
    .filter((c) => c !== "" && !["constraint", "primary", "unique", "check", "foreign"].includes(c));
  return { body, columns: [...new Set([...columns, ...added])] };
}

/** `check (col in ('a', 'b'))` → { col: [a, b] } over a CREATE TABLE body. */
function checkLists(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/check\s*\(\s*([a-z_]+)\s+in\s*\(([^)]*)\)\s*\)/gi)) {
    out[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  }
  return out;
}

/** The newest definition of a function: its parameters and its body. */
function sqlFunction(name: string): { params: Array<{ name: string; optional: boolean }>; body: string } {
  let hit = { params: [] as Array<{ name: string; optional: boolean }>, body: "" };
  for (const { sql } of migs) {
    const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "gi");
    for (const m of sql.matchAll(re)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const params = topLevel(balanced(sql, open)).map((p) => ({
        name: (/^([a-z_][a-z0-9_]*)\s/i.exec(p)?.[1] ?? p).toLowerCase(),
        optional: /\bdefault\b/i.test(p),
      }));
      const rest = sql.slice(open);
      const start = rest.indexOf("$$");
      const end = start >= 0 ? rest.indexOf("$$", start + 2) : -1;
      hit = { params, body: start >= 0 && end > start ? rest.slice(start + 2, end) : "" };
    }
  }
  return hit;
}

/** Every key a `jsonb_build_object(...)` in `body` names, at any depth. */
function builtKeys(body: string): string[] {
  const keys: string[] = [];
  for (const m of body.matchAll(/jsonb_build_object\s*\(/gi)) {
    const args = topLevel(balanced(body, (m.index ?? 0) + m[0].length - 1));
    for (let i = 0; i < args.length; i += 2) {
      const k = /^'([^']+)'$/.exec(args[i]);
      if (k) keys.push(k[1]);
    }
  }
  return keys;
}

const meetingsTs = readFileSync(join(root, "supabase/functions/pb-notes/meetings.ts"), "utf8");
const page = readFileSync(join(root, "web/index.html"), "utf8");

/** `const NAME = "..." (+ "...")` in a source file, resolved to its string. */
function constString(src: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) return "";
  let out = "";
  for (const part of m[1].split("+").map((s) => s.trim())) {
    const lit = /^"([^"]*)"$/.exec(part);
    if (lit) out += lit[1];
    else out += constString(src, part);
  }
  return out;
}
const cols = (s: string) => s.split(",").map((c) => c.trim()).filter(Boolean).map((c) => c.replace(/^[a-z_]+:/, "").split("->")[0]);

/**
 * Every query on `table` in `src`: each `.from("table")` with the method chain that follows it, and
 * each selectAll / selectIn call naming it — so a statement that builds five queries at once is
 * read as five, each against its own table.
 */
function statementsOn(src: string, table: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`\\.from\\(\\s*"${table}"\\s*\\)`, "g"))) {
    let i = (m.index ?? 0) + m[0].length;
    let text = m[0];
    for (;;) {
      const link = /^\s*\.([A-Za-z_]\w*)\s*\(/.exec(src.slice(i));
      if (!link) break;
      const open = i + link[0].length - 1;
      const inner = balanced(src, open);
      text += `.${link[1]}(${inner})`;
      i = open + inner.length + 2;
    }
    out.push(text);
  }
  for (const m of src.matchAll(new RegExp(`select(?:All|In)\\(\\s*db\\s*,\\s*"${table}"`, "g"))) {
    const open = (m.index ?? 0) + m[0].indexOf("(");
    out.push(`${m[0].slice(0, m[0].indexOf("("))}(${balanced(src, open)})`);
  }
  return out;
}

/** The columns a query statement selects (string literal or a known constant) and filters on. */
function queryColumns(stmt: string, src: string): { select: string[]; filter: string[] } {
  const select: string[] = [];
  for (const m of stmt.matchAll(/\.select\(\s*(?:"([^"]*)"|([A-Z_]+))/g)) {
    const s = m[1] !== undefined ? m[1] : constString(src, m[2]);
    if (s !== "*") select.push(...cols(s));
  }
  for (const m of stmt.matchAll(/selectAll\([^,]+,\s*"[a-z_]+",\s*(?:"([^"]*)"|([A-Z_]+))/g)) select.push(...cols(m[1] ?? constString(src, m[2])));
  for (const m of stmt.matchAll(/selectIn\([^,]+,\s*"[a-z_]+",\s*"([a-z_]+)",[^,]+,\s*(?:"([^"]*)"|([A-Z_]+))(?:,\s*\d+,\s*"([a-z_]+)")?/g)) {
    select.push(m[1], ...cols(m[2] ?? constString(src, m[3])));
    if (m[4]) select.push(m[4]);
  }
  const filter = [...stmt.matchAll(/\.(?:eq|neq|in|is|lt|lte|gt|gte|order)\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  return { select, filter };
}

/* The page's pure block, evaluated with nothing else in scope (as page_pure_test does). */
function pageHelpers(): Record<string, unknown> {
  const startMark = page.indexOf("@pure-start");
  const endMark = page.indexOf("@pure-end");
  const block = page.slice(page.indexOf("*/", startMark) + 2, page.lastIndexOf("/*", endMark));
  const declared = [...block.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm)].map((m) => m[1] ?? m[2]);
  return vm.runInNewContext(`(function () {\n${block}\nreturn { ${declared.join(", ")} };\n})()`, {}, { filename: "web/index.html#pure" });
}
// deno-lint-ignore no-explicit-any
const P = pageHelpers() as Record<string, any>;

/* ------------------------------------------------------------------ *
 * the tables
 * ------------------------------------------------------------------ */

const meetings = tableDdl("pb_meetings");
const proposals = tableDdl("pb_meeting_proposals");
const titleRules = tableDdl("pb_meeting_title_rules");
const aliases = tableDdl("pb_meeting_aliases");
const watermarks = tableDdl("pb_source_watermarks");
const removalReasons = tableDdl("pb_removal_reasons");
const mChecks = checkLists(meetings.body);
const pChecks = checkLists(proposals.body);

check("the four meeting tables and their neighbours are found in the migrations",
  [meetings, proposals, titleRules, aliases, watermarks, removalReasons].every((t) => t.columns.length > 0));
for (const c of ["status", "selected_by", "skip_reason"]) check(`pb_meetings.${c} has a value list`, (mChecks[c] ?? []).length > 0);
for (const c of ["mention_state", "matched_on", "kind", "confidence", "disposition", "topic", "mode", "status"]) {
  check(`pb_meeting_proposals.${c} has a value list`, (pChecks[c] ?? []).length > 0);
}

/* ------------------------------------------------------------------ *
 * 1 · columns: what pb-notes and the page touch exists
 * ------------------------------------------------------------------ */
{
  // Registration, run: every key an insert or a relabel carries.
  const rec = (id: string, o: Partial<NewRecording> = {}): NewRecording => ({
    recording_id: id, inbox_id: `inbox-${id}`, title: "Sales Standing Connect", title_norm: "sales standing connect",
    held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T20:00:00.000Z", url: `https://fathom.example/calls/${id}`, ...o,
  });
  const reg = (id: string, o: Partial<RegisteredMeeting> = {}): RegisteredMeeting => ({
    recording_id: id, title_norm: "sales standing connect", held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T19:30:00.000Z",
    status: "waiting", include: null, duplicate_of: null, read_started_at: null, progress: null, ...o,
  });
  const plans = [
    planRegistration({ candidates: [rec("1"), rec("2", { held_at: "2026-10-09T19:01:00.000Z", ended_at: "2026-10-09T19:58:00.000Z" })], existing: [], rules: [], now_ms: 0 }),
    planRegistration({ candidates: [rec("3")], existing: [reg("4"), reg("5", { status: "duplicate", duplicate_of: "4" })], rules: [], now_ms: 0 }),
    planRegistration({ candidates: [rec("6", { title: "Weekly sync", title_norm: "weekly sync" })], existing: [], rules: [], now_ms: 0 }),
  ];
  const written = plans.flatMap((p) => [...p.inserts.flatMap((r) => Object.keys(r)), ...p.updates.flatMap((u) => Object.keys(u.patch))]);
  check("registration was exercised (inserts and relabels)", plans.some((p) => p.updates.length > 0) && plans.some((p) => p.inserts.length > 0));
  subset("pb_meetings holds every column registration writes", written, meetings.columns);

  // The read: every object meetings.ts hands to a pb_meetings write.
  const patchKeys: string[] = [];
  for (const m of meetingsTs.matchAll(/(?:guarded|finishWith)\(\s*\{/g)) patchKeys.push(...objectKeys(balanced(meetingsTs, (m.index ?? 0) + m[0].length - 1)));
  for (const m of meetingsTs.matchAll(/(?:const\s+patch:\s*Rec\s*=\s*|Object\.assign\(patch,\s*|const\s+bookkeeping\s*=\s*\(\):\s*Rec\s*=>\s*\()\{/g)) {
    patchKeys.push(...objectKeys(balanced(meetingsTs, (m.index ?? 0) + m[0].length - 1)));
  }
  check("meetings.ts patches were found", patchKeys.length >= 10, String(patchKeys.length));
  subset("pb_meetings holds every column meetings.ts patches (lease, pass 1, progress, close)", patchKeys, meetings.columns);

  // Reads and filters, statement by statement.
  for (const [table, ddl] of [["pb_meetings", meetings], ["pb_meeting_proposals", proposals], ["pb_meeting_title_rules", titleRules],
                              ["pb_meeting_aliases", aliases], ["pb_source_watermarks", watermarks], ["pb_removal_reasons", removalReasons]] as const) {
    for (const [who, src] of [["meetings.ts", meetingsTs], ["web/index.html", page]] as const) {
      const used = statementsOn(src, table).map((s) => queryColumns(s, src));
      if (used.length === 0) continue;
      subset(`${who}: ${table} holds every column it selects`, used.flatMap((u) => u.select), ddl.columns);
      subset(`${who}: ${table} holds every column it filters or sorts on`, used.flatMap((u) => u.filter), ddl.columns);
    }
  }
  // The lease is taken with two filters written apart from their statement.
  const claimFn = meetingsTs.slice(meetingsTs.indexOf("async function claim("), meetingsTs.indexOf("interface ReadContext"));
  subset("the lease's own filters are pb_meetings columns", [...claimFn.matchAll(/\.(?:eq|in|is|lt)\(\s*"([a-z_]+)"/g)].map((m) => m[1]), meetings.columns);

  // The cursor and the upserts' conflict targets.
  const mark = /from\("pb_source_watermarks"\)\.upsert\(\{([\s\S]*?)\}\s*,\s*\{\s*onConflict:\s*"([a-z_]+)"/.exec(meetingsTs);
  check("meetings.ts upserts its watermark", mark !== null);
  if (mark) {
    subset("pb_source_watermarks holds every column the cursor writes", objectKeys(mark[1]), watermarks.columns);
    check("…on its primary key", mark[2] === "source" && /source\s+text\s+primary\s+key/i.test(watermarks.body));
  }
  check("proposals are upserted on fingerprint, which is unique", /from\("pb_meeting_proposals"\)\s*\.upsert\(rows,\s*\{\s*onConflict:\s*"fingerprint"/.test(meetingsTs) &&
    /fingerprint\s+text\s+not\s+null\s+unique/i.test(proposals.body));
  check("meetings are upserted on recording_id, the primary key", /from\("pb_meetings"\)\s*\.upsert\(plan\.inserts,\s*\{\s*onConflict:\s*"recording_id"/.test(meetingsTs) &&
    /recording_id\s+text\s+primary\s+key/i.test(meetings.body));

  // The page's two column lists.
  const pageList = constString(page, "MEETING_LIST_COLS");
  const pageFull = constString(page, "MEETING_COLS");
  check("the page's meeting column lists were found", pageList !== "" && pageFull.startsWith(pageList));
  subset("pb_meetings holds every column the page lists", cols(pageFull), meetings.columns);
  check("the page reads none of the operator columns (notes, usage, progress, inbox_id)",
    !cols(pageFull).some((c) => ["notes", "usage", "progress", "inbox_id"].includes(c)));
}

/* ------------------------------------------------------------------ *
 * 2 · values: what the code emits, the checks allow, and the screen shows
 * ------------------------------------------------------------------ */
{
  // pb_meetings.selected_by and skip_reason, from every branch of selectMeeting.
  const rules = [{ title_norm: "always", read: true }, { title_norm: "never", read: false }];
  const sels = [
    selectMeeting({ title: "x", include: true }), selectMeeting({ title: "x", include: false }),
    selectMeeting({ title: "always", rules }), selectMeeting({ title: "never", rules }),
    selectMeeting({ title: "Sales Standing Connect" }), selectMeeting({ title: "Weekly sync" }),
  ];
  sameSet("selectMeeting's selected_by values are exactly pb_meetings' check", sels.map((s) => s.selected_by), mChecks.selected_by ?? []);

  const skipLiterals = [...meetingsTs.matchAll(/skip_reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const skipEmitted = [...sels.map((s) => s.skip_reason).filter((x): x is "not_selected" | "owner_excluded" => x !== null), ...skipLiterals];
  sameSet("every skip_reason pb-notes writes, and no other, is in pb_meetings' check", skipEmitted, mChecks.skip_reason ?? []);
  sameSet("the page has words for exactly the skip reasons the table allows", Object.keys(evalConst("SKIP_WORDS")), mChecks.skip_reason ?? []);

  // pb_meetings.status: registration, the read's literals, the exported lists.
  const regStatuses = [
    ...planRegistration({ candidates: [{ recording_id: "1", inbox_id: "i1", title: "Sales", title_norm: "sales", held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T20:00:00.000Z", url: null },
      { recording_id: "2", inbox_id: "i2", title: "Sales", title_norm: "sales", held_at: "2026-10-09T19:00:00.000Z", ended_at: "2026-10-09T19:40:00.000Z", url: null },
      { recording_id: "3", inbox_id: "i3", title: "Lunch", title_norm: "lunch", held_at: "2026-10-09T12:00:00.000Z", ended_at: "2026-10-09T13:00:00.000Z", url: null }],
      existing: [], rules: [], now_ms: 0 }).inserts.map((r) => String(r.status)),
  ];
  const readLiterals = [
    ...[...meetingsTs.matchAll(/status:\s*"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...(/const status = progress[^;]*;/.exec(meetingsTs)?.[0] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...meetingsTs.matchAll(/settle\("([a-z_]+)"\)/g)].map((m) => m[1]),
  ];
  check("the read's status literals were found", readLiterals.length >= 5, JSON.stringify(readLiterals));
  subset("every pb_meetings status pb-notes writes is in the table's check",
    [...regStatuses, ...readLiterals, ...CLAIMABLE_STATUSES, ...REREADABLE_STATUSES, ...LOCKED_STATUSES], mChecks.status ?? []);
  const pageStatusLists = [...page.matchAll(/from\("pb_meetings"\)[^;]*?\.in\("status",\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  subset("every pb_meetings status the page asks for is in the table's check", pageStatusLists, mChecks.status ?? []);
  sameSet("the page lists every status but 'duplicate' (a duplicate is read through its representative)",
    pageStatusLists, (mChecks.status ?? []).filter((s) => s !== "duplicate"));

  // pb_meeting_proposals: the lists the core holds as data.
  sameSet("MODES is exactly pb_meeting_proposals.mode", MODES, pChecks.mode ?? []);
  sameSet("READ_TOPICS plus 'other' is exactly pb_meeting_proposals.topic", [...READ_TOPICS, "other"], pChecks.topic ?? []);
  sameSet("MATCHED_ON is exactly pb_meeting_proposals.matched_on", MATCHED_ON, pChecks.matched_on ?? []);
  sameSet("READ_STATES (the states pass 2 reads) is exactly pb_meeting_proposals.mention_state", READ_STATES, pChecks.mention_state ?? []);
  subset("…each of them a state the matcher produces", READ_STATES, MENTION_STATES);
  sameSet("the page has words for exactly the bases the table allows", Object.keys(evalConst("BASIS_WORDS")), pChecks.matched_on ?? []);
  sameSet("the page's card order names exactly the table's kinds", P.MEETING_KIND_ORDER, pChecks.kind ?? []);

  // proposalRows, run over every state, type, mode and topic it can see.
  const cl: ProposalCluster[] = [
    { ref: "A1", state: "resolved", said_as: ["Quillfern"], said_key: "quillfern", account_id: "acc-1", matched_on: "name", options: ["acc-1"] },
    { ref: "A2", state: "suggested", said_as: ["Bluebarrow"], said_key: "bluebarrow", account_id: null, matched_on: "token", options: ["acc-2", "acc-3"] },
    { ref: "A3", state: "ambiguous", said_as: ["Northgale"], said_key: "northgale", account_id: null, matched_on: null, options: ["acc-4", "acc-5"] },
    { ref: "A4", state: "unknown", said_as: ["Brightquay"], said_key: "brightquay", account_id: null, matched_on: null, options: [] },
  ];
  let order = 0;
  const claims: VerifiedClaim[] = [];
  const base = { key: null, value: null, tier: null, disposition: null, code: null, topic: null, quote: "they said it plainly enough",
    line_from: 3, line_to: 4, quote_at: "00:01:00", speaker: "S2", kind: "judgement" as const, flags: [] as string[] };
  for (const ref of ["A1", "A2", "A3", "A4"]) {
    for (const mode of MODES) {
      for (const confidence of ["high", "medium", "low"] as const) {
        claims.push({ ...base, ref, type: "fact", key: "headcount", value: 40, mode, confidence, order: order++ });
        claims.push({ ...base, ref, type: "tier_call", tier: "Gold", code: null, mode, confidence, order: order++ });
        claims.push({ ...base, ref, type: "tier_call", tier: "Silver", code: "timing_known", mode, confidence, order: order++ });
        claims.push({ ...base, ref, type: "removal", disposition: "unqualified", code: "too_small", mode, confidence, order: order++ });
        claims.push({ ...base, ref, type: "removal", disposition: null, code: null, mode, confidence, order: order++ });
        for (const topic of [...READ_TOPICS, "other"]) { const at = 3 + order % 7; claims.push({ ...base, ref, type: "read", topic, mode, confidence, line_from: at, line_to: at + 1, order: order++ }); }
      }
    }
  }
  const rows: ProposalRow[] = proposalRows({
    meeting: { recording_id: "rec-1", title: "Sales Standing Connect", held_at: "2026-09-01T19:00:00Z" },
    extractor: "meeting@v1+model-x", as_of: "2026-10-10", clusters: cl, claims,
    facts: [{ account_id: "acc-1", key: "headcount", value: 40, evidence_label: "evidence", source: "rater" }],
    reads: [{ account_id: "acc-1", computed_tier: "Gold", effective_tier: "Gold" }],
    removed: ["acc-1"], overrideCodes: ["data_wrong", "relationship_known", "timing_known", "other"],
  });
  check("proposalRows was exercised", rows.length > 500, String(rows.length));
  const values = (k: keyof ProposalRow) => rows.map((r) => r[k]).filter((v): v is string => typeof v === "string");
  subset("every kind proposalRows emits is in the table's check", values("kind"), pChecks.kind ?? []);
  sameSet("…and it emits every kind the table allows", values("kind"), pChecks.kind ?? []);
  subset("every status proposalRows emits is in the table's check", values("status"), pChecks.status ?? []);
  sameSet("…which are exactly the three a reader writes (proposed, not_proposed, agrees)", values("status"), ["proposed", "not_proposed", "agrees"]);
  subset("every mode is in the table's check", values("mode"), pChecks.mode ?? []);
  subset("every topic is in the table's check", values("topic"), pChecks.topic ?? []);
  subset("every confidence is in the table's check", values("confidence"), pChecks.confidence ?? []);
  subset("every mention_state is in the table's check", values("mention_state"), pChecks.mention_state ?? []);
  subset("every matched_on is in the table's check", values("matched_on"), pChecks.matched_on ?? []);
  subset("every disposition is in the table's check", values("disposition"), pChecks.disposition ?? []);
  const broken = (name: string, ok: (r: ProposalRow) => boolean) => {
    const bad = rows.filter((r) => !ok(r));
    check(name, bad.length === 0, bad.slice(0, 2).map((r) => JSON.stringify({ kind: r.kind, state: r.mention_state, account: r.account_id })).join(" "));
  };
  check("the table carries the placement check", /pb_meeting_proposals_placed_check\s+check\s*\(\s*\(\s*account_id\s+is\s+not\s+null\s*\)\s*=\s*\(\s*mention_state\s*=\s*'resolved'\s*\)\s*\)/i.test(proposals.body));
  broken("placed_check: a row carries an account exactly when its mention is resolved", (r) => (r.account_id !== null) === (r.mention_state === "resolved"));
  broken("fact_check: a fact carries a key and a value", (r) => r.kind !== "fact" || (r.key !== null && r.value !== null && r.value !== undefined));
  broken("override_check: a tier call carries its tier", (r) => r.kind !== "override" || r.tier !== null);
  broken("read_check: a read carries its topic", (r) => r.kind !== "read" || r.topic !== null);
  broken("lines_check: line_from ≥ 1 and line_to ≥ line_from", (r) => r.line_from >= 1 && r.line_to >= r.line_from);
  broken("options: at most five", (r) => r.options.length <= 5);
  check("no row of an unknown mention is ever written", !rows.some((r) => r.said_key === "brightquay"));

  // Every status the table allows has a place on the screen — none can vanish.
  const pageRows = (pChecks.status ?? []).map((status, i) => ({ id: `p${i}`, recording_id: "rec-1", account_id: "acc-1", said_key: "q", said_as: ["Q"],
    mention_state: "resolved", matched_on: "name", options: [], kind: "fact", key: "headcount", value: 40, line_from: i + 1, line_to: i + 1,
    quote_at: "00:00:01", speaker: "S1", mode: "asserted", flags: [], status }));
  const card = P.groupMeetingCards(pageRows).cards[0];
  const shown = [...card.open, ...card.agrees, ...card.unsaid, ...card.decided].map((r: { status: string }) => r.status);
  sameSet("the screen files every status the table allows in exactly one place", shown, pChecks.status ?? []);
  check("…and none twice", shown.length === pageRows.length);
}

/* ------------------------------------------------------------------ *
 * 3 · formats the table checks
 * ------------------------------------------------------------------ */
{
  const qa = /quote_at\s+text\s+not\s+null\s+check\s*\(\s*quote_at\s*~\s*'([^']+)'\s*\)/i.exec(proposals.body)?.[1] ?? "";
  const sp = /speaker\s+text\s+not\s+null\s+check\s*\(\s*speaker\s*~\s*'([^']+)'\s*\)/i.exec(proposals.body)?.[1] ?? "";
  check("the quote_at and speaker patterns were found", qa !== "" && sp !== "");
  const qaRe = new RegExp(qa), spRe = new RegExp(sp);
  const clocks = [0, 59, 61, 3599, 3600, 35999, 86399, 360000].map(clockText);
  check("every clock the transcript writes meets quote_at's pattern (hours past 99 too)", clocks.every((c) => qaRe.test(c)), JSON.stringify(clocks));
  const tl = transcriptLines(Array.from({ length: 14 }, (_, i) => ({ text: `line ${i}`, timestamp: `00:00:${String(i).padStart(2, "0")}`, speaker: { display_name: `Role ${i}` } })));
  check("every speaker label meets speaker's pattern (S1 … S14)", tl.speakers.length === 14 && tl.lines.every((l) => spRe.test(l.speaker)), JSON.stringify(tl.speakers.map((s) => s.label)));
  const between = /quote\s+text\s+not\s+null\s+check\s*\(\s*char_length\(quote\)\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i.exec(proposals.body);
  check("quote's length check is QUOTE_MIN_CHARS..QUOTE_MAX_CHARS", between !== null && Number(between[1]) === QUOTE_MIN_CHARS && Number(between[2]) === QUOTE_MAX_CHARS,
    between ? `${between[1]}..${between[2]}` : "not found");
  const ctx = /context\s+text\s+check\s*\(\s*char_length\(context\)\s*<=\s*(\d+)\s*\)/i.exec(proposals.body);
  check("context's length check is CONTEXT_MAX_CHARS", ctx !== null && Number(ctx[1]) === CONTEXT_MAX_CHARS);
  const card = /cardinality\(options\)\s*<=\s*(\d+)/i.exec(proposals.body);
  check("options' cardinality check holds MAX_OPTIONS", card !== null && MAX_OPTIONS <= Number(card[1]));
}

/* ------------------------------------------------------------------ *
 * 4 · the functions: arguments, items, edits, results
 * ------------------------------------------------------------------ */
{
  const fns = ["pb_decide_meeting_card", "pb_assign_meeting_mention", "pb_meeting_include", "pb_meeting_title_rule", "pb_dismiss_meeting", "pb_meeting_supersede"];
  const defs = Object.fromEntries(fns.map((f) => [f, sqlFunction(f)]));
  for (const f of fns) check(`${f} is defined`, defs[f].body !== "");

  // Every rpc call, in the page and in pb-notes.
  const calls: Array<{ who: string; fn: string; keys: string[] }> = [];
  for (const [who, src] of [["web/index.html", page], ["meetings.ts", meetingsTs]] as const) {
    for (const m of src.matchAll(/\.rpc\(\s*"(pb_[a-z_]+)"\s*,\s*\{/g)) {
      if (!fns.includes(m[1])) continue;
      calls.push({ who, fn: m[1], keys: objectKeys(balanced(src, (m.index ?? 0) + m[0].length - 1)) });
    }
  }
  sameSet("every meeting function but the service-role one is called by the page, and pb_meeting_supersede by pb-notes",
    calls.map((c) => c.fn), fns);
  for (const c of calls) {
    const params = defs[c.fn].params;
    subset(`${c.who} → ${c.fn}: every argument is a parameter`, c.keys, params.map((p) => p.name));
    subset(`${c.who} → ${c.fn}: every required parameter is passed`, params.filter((p) => !p.optional).map((p) => p.name), c.keys);
  }
  check("meetings.ts calls pb_meeting_supersede with exactly its one argument",
    calls.some((c) => c.who === "meetings.ts" && c.fn === "pb_meeting_supersede" && JSON.stringify(c.keys) === '["p_recording_id"]'));

  // pb_decide_meeting_card: the items the page builds, against what the function reads.
  const decide = defs.pb_decide_meeting_card.body;
  const itemKeys = sorted([...decide.matchAll(/(?:v_item|\be)\s*->>?\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const decisions = /not\s+in\s*\(\s*('approve'[^)]*)\)/i.exec(decide)?.[1].match(/'([a-z_]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  const branch = (kind: string) => {
    const at = decide.search(new RegExp(`(?:if|elsif)\\s+p\\.kind\\s*=\\s*'${kind}'`));
    const next = decide.slice(at + 10).search(/\belsif\s+p\.kind\b|\bend\s+if\s*;\s*\n\s*\n?\s*update\s+public\.pb_meeting_proposals/);
    return at < 0 ? "" : decide.slice(at, next < 0 ? undefined : at + 10 + next);
  };
  const editKeysOf = (text: string) => sorted([...text.matchAll(/v_edit\s*(?:\?|->>|->)\s*'([a-z_]+)'/g)].map((m) => m[1]));
  check("the decide function's item keys and decisions were found", itemKeys.length >= 4 && decisions.length === 3, `${itemKeys} / ${decisions}`);

  const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
  const REASONS = [
    { disposition: "do_not_contact", code: "asked", label: "Asked", allows_review_date: false, sort: 10, active: true },
    { disposition: "unqualified", code: "small", label: "Small", allows_review_date: true, sort: 10, active: true },
  ];
  const prow = (id: string, extra: Record<string, unknown>) => ({
    id, recording_id: "rec-1", account_id: "acc-1", said_key: "q", said_as: ["Q"], mention_state: "resolved", matched_on: "name", options: [],
    kind: "fact", key: "headcount", value: 40, tier: null, reason_code: null, disposition: null, review_on: null, topic: null,
    quote: "an invented sentence of the meeting", context: null, line_from: 1, line_to: 1, quote_at: "00:00:01", speaker: "S1",
    mode: "asserted", flags: [], default_selected: true, held_on: "2026-10-09", current_value: null, current_source: null, conflicts: false,
    engine_tier: "Gold", effective_tier: "Gold", default_text: "\"an invented sentence\" — sales meeting", status: "proposed", ...extra,
  });
  const rows = [
    prow("f1", {}), prow("f2", { flags: ["conflicts_with_person"] }), prow("f3", {}),
    prow("o1", { kind: "override", tier: "Silver", key: null, value: null }),
    prow("x1", { kind: "removal", key: null, value: null, disposition: "unqualified", reason_code: "small" }),
    prow("r1", { kind: "read", topic: "price", key: null, value: null }),
  ];
  const choice = {
    f1: { ticked: true, edit: { value: 45, changed: true } }, f2: { ticked: true, edit: {} }, f3: { ticked: false },
    o1: { ticked: true, edit: { tier: "Platinum", reason_code: "timing_known", expires_on: "2027-01-08", text: "\"they are silver\"" } },
    x1: { chosen: true, edit: { disposition: "unqualified", reason_code: "small", review_on: "2027-03-01", text: "\"take them off\"", expires_at: "2027-01-01T00:00:00Z" } },
    r1: { ticked: true, edit: { text: "an edited read", changed: true } },
  };
  const sent = [
    ...P.cardItems(rows, choice, { mode: "approve", lane: "owner", reasons: REASONS }),
    ...P.cardItems(rows, choice, { mode: "approve", lane: "rater", reasons: REASONS }),
    ...P.cardItems(rows, choice, { mode: "reject", lane: "owner", reasons: REASONS }),
    ...P.cardItems(rows, choice, { mode: "removal", only: "x1", lane: "owner", reasons: REASONS }),
  ];
  check("cardItems was exercised on every kind", ["f1", "f2", "o1", "x1", "r1"].every((id) => sent.some((i: { id: string; decision: string }) => i.id === id && i.decision === "approve")));
  const inline = [...page.matchAll(/p_items:\s*\[\s*\{([^}]*)\}\s*\]/g)].map((m) => objectKeys(m[1]));
  const inlineDecisions = [...page.matchAll(/p_items:\s*\[\s*\{[^}]*decision:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  subset("every item key the page sends is one pb_decide_meeting_card reads", [...sent.flatMap((i: Record<string, unknown>) => Object.keys(i)), ...inline.flat()], itemKeys);
  subset("every decision the page sends is one the function takes", [...sent.map((i: { decision: string }) => i.decision), ...inlineDecisions], decisions);
  sameSet("…and the page sends every decision the function takes", [...sent.map((i: { decision: string }) => i.decision), ...inlineDecisions], decisions);
  const kindOf = (id: string) => rows.find((r) => r.id === id)?.kind as string;
  for (const kind of ["fact", "override", "removal", "read"]) {
    const keys = sent.filter((i: { id: string; edit?: Record<string, unknown> }) => kindOf(i.id) === kind && i.edit).flatMap((i: { edit: Record<string, unknown> }) => Object.keys(i.edit));
    subset(`a ${kind}'s edit carries only keys its branch of pb_decide_meeting_card reads`, keys, editKeysOf(branch(kind)));
  }
  check("a removal's edit never carries expires_at (rule 7a), though the guard would refuse it anyway",
    !sent.some((i: { id: string; edit?: Record<string, unknown> }) => kindOf(i.id) === "removal" && i.edit && "expires_at" in i.edit));

  // What the page reads back.
  const decideReturns = builtKeys(decide.slice(decide.lastIndexOf("return jsonb_build_object")));
  const decidedWords = String(P.decidedWords);
  const wants = [...decidedWords.matchAll(/n\("([a-z_]+)"\)/g)].map((m) => m[1]);
  check("decidedWords reads counts", wants.length >= 5);
  subset("every count decidedWords reads is one pb_decide_meeting_card returns", wants, decideReturns);
  const dismiss = /rpc\("pb_dismiss_meeting"[\s\S]{0,400}?data\?\.([a-z_]+)/.exec(page)?.[1];
  check("the page reads pb_dismiss_meeting's count", dismiss !== undefined);
  subset("…which pb_dismiss_meeting returns", [dismiss ?? "(none)"], builtKeys(defs.pb_dismiss_meeting.body));
  const include = page.slice(page.indexOf('rpc("pb_meeting_include"'), page.indexOf('rpc("pb_meeting_include"') + 600);
  subset("every key the page reads from pb_meeting_include is one it returns",
    [...include.matchAll(/data\.([a-z_]+)/g)].map((m) => m[1]), builtKeys(defs.pb_meeting_include.body));

  // Assign: the decisions the page sends are the ones the function takes.
  const assignTakes = /not\s+in\s*\(\s*('assign'[^)]*)\)/i.exec(defs.pb_assign_meeting_mention.body)?.[1].match(/'([a-z_]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  const assignSent = [
    ...[...page.matchAll(/place\("([a-z_]+)"/g)].map((m) => m[1]),
    ...[...page.matchAll(/rpc\("pb_assign_meeting_mention",[^)]*p_decision:\s*"([a-z_]+)"/g)].map((m) => m[1]),
  ];
  sameSet("the page sends every placement decision pb_assign_meeting_mention takes, and no other", assignSent, assignTakes);
}

/* ------------------------------------------------------------------ *
 * 5 · the schedule's body is one pb-notes parses, whole
 * ------------------------------------------------------------------ */
{
  const cron = migs.filter((m) => /cron\.schedule\s*\(\s*'pb-meetings'/.test(m.sql)).pop()?.sql ?? "";
  check("a migration schedules pb-meetings", cron !== "");
  const bodyAt = /body\s*:=\s*jsonb_build_object\s*\(/.exec(cron);
  const args = bodyAt ? topLevel(balanced(cron, bodyAt.index + bodyAt[0].length - 1)) : [];
  const body: Record<string, unknown> = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = /^'([a-z_]+)'$/.exec(args[i])?.[1];
    if (!k) continue;
    const v = args[i + 1];
    const arr = /^jsonb_build_array\((.*)\)$/s.exec(v);
    body[k] = arr ? topLevel(arr[1]).map((x) => x.replace(/^'|'$/g, "")) : /^\d+$/.test(v) ? Number(v) : v;
  }
  subset("every key the schedule sends is one the meeting reader reads", Object.keys(body), MEETING_BODY_KEYS);
  check("the schedule's body routes to the meeting reader", meetingRoute(body.sources) === "meetings", JSON.stringify(body.sources));
  const parsed = parseMeetingBody(body, "2026-10-11");
  check("…parses with no refusal and no note", parsed.ok && parsed.notes.length === 0, JSON.stringify(parsed));
  if (parsed.ok) {
    check("…at the reader's own budget and concurrency", parsed.opts.budget_ms === DEFAULT_BUDGET_MS && parsed.opts.concurrency === MAX_CONCURRENCY);
    check("…and reads the next meeting (no recording, no dry run, no register-only)", parsed.opts.recording_id === null && !parsed.opts.dry_run && !parsed.opts.register_only);
  }
  const lease = /interval\s+'(\d+)\s+seconds'/.exec(cron);
  check("the schedule's dead-lease test is LEASE_MS", lease !== null && Number(lease[1]) * 1000 === LEASE_MS, lease?.[1] ?? "none");
  const timeout = /timeout_milliseconds\s*:=\s*(\d+)/.exec(cron);
  check("pg_net waits longer than the run's own budget", timeout !== null && Number(timeout[1]) > DEFAULT_BUDGET_MS);
}

/* ------------------------------------------------------------------ *
 * helpers that need the page's non-pure constants
 * ------------------------------------------------------------------ */

/** A `const NAME = { … }` object literal of the page, outside the pure block, as a value. */
function evalConst(name: string): Record<string, unknown> {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(page);
  if (!m) return {};
  const text = balanced(page, m.index + m[0].length - 1);
  return vm.runInNewContext(`({${text}})`, {}) as Record<string, unknown>;
}

console.log(`meeting_contract_test: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length) process.exit(1);
