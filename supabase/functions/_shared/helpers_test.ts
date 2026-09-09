/**
 * WLIQ Prospect Book — tests for the edge functions' pure helpers.
 *
 * Run:  node --experimental-strip-types supabase/functions/_shared/helpers_test.ts
 *
 * Deno is not installed in the build container, so the handlers (index.ts) cannot run here;
 * every decision they make lives in these pure modules and is exercised below. Nothing in this
 * file imports `jsr:` or `npm:`. All fixtures are synthetic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  addDays,
  bearerMatches,
  bearerToken,
  chunk,
  errorMessage,
  headerSubset,
  inboxBody,
  isoDate,
  json,
  queryParams,
  safeJsonParse,
  sha256Hex,
  tally,
  truthyParam,
} from "./helpers.ts";
import { catalogEntry, catalogTypes, fillSignalFromCatalog } from "./rubric.ts";
import { bearerOk } from "./auth.ts";
import { isRunKind, runStatus } from "./log.ts";
import {
  accountKeys,
  COLUMNS,
  dealRowForUpsert,
  pickColumns,
  prepareAccounts,
  prepareCalls,
  prepareCandidates,
  prepareContacts,
  prepareDeals,
  prepareFacts,
  prepareSignals,
  resolveAccountRef,
  validateSyncBody,
} from "./sync_pure.ts";
import { buildReadRow, diffEntry, groupBy, listingPatch, tallyScorecards, toResolveAccount } from "./score_pure.ts";
import {
  accountAttachPatch,
  accountCreateRow,
  accountIdForOrg,
  actionItemCount,
  candidateRows,
  contactRow,
  dealAccountsMap,
  fathomInboxHeaders,
  fathomNextStepSignal,
  hasNonEmptyActionItems,
  mergeDealUpsert,
  parseFieldMap,
  pipedriveInboxHeaders,
} from "./webhook_pure.ts";
import { grade } from "./core/engine.ts";
import { resolveFeatures } from "./ingest/resolve_features.ts";
import { parseFathomWebhook } from "./ingest/fathom_webhook.ts";
import type { CallRow } from "./ingest/fathom_webhook.ts";
import type { ProspectScorecard } from "./core/prospect_types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUBRIC = JSON.parse(readFileSync(join(here, "core", "rubric.prospect.v0.1.json"), "utf8"));

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

class FakeHeaders {
  private m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.m.get(name.toLowerCase()) ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * helpers.ts
 * ------------------------------------------------------------------ */

eq("bearerToken: parses", bearerToken("Bearer abc123"), "abc123");
eq("bearerToken: case-insensitive scheme", bearerToken("bearer abc"), "abc");
eq("bearerToken: not bearer", bearerToken("Basic abc"), null);
eq("bearerToken: absent", bearerToken(null), null);
check("bearerMatches: right token", bearerMatches("Bearer s3cret", "s3cret"));
check("bearerMatches: wrong token", !bearerMatches("Bearer s3cre", "s3cret"));
check("bearerMatches: unset secret refuses (never default open)", !bearerMatches("Bearer ", ""));
check("bearerMatches: null secret refuses", !bearerMatches("Bearer x", null));
check("bearerOk: reads the request header", bearerOk({ headers: new FakeHeaders({ Authorization: "Bearer tok" }) }, "tok"));
check("bearerOk: refuses when unset", !bearerOk({ headers: new FakeHeaders({ Authorization: "Bearer tok" }) }, null));

eq("queryParams", queryParams("https://x.test/fn?account=abc&preview=1&rubric=0.2.0"), { account: "abc", preview: "1", rubric: "0.2.0" });
eq("queryParams: bad url", queryParams("not a url"), {});
check("truthyParam", truthyParam("1") && truthyParam("true") && truthyParam("YES") && !truthyParam("0") && !truthyParam(null) && !truthyParam(""));

eq("headerSubset", headerSubset(new FakeHeaders({ "Webhook-Id": "w1" }), ["webhook-id", "webhook-timestamp"]), { "webhook-id": "w1", "webhook-timestamp": null });
eq("headerSubset: null headers", headerSubset(null, ["a"]), { a: null });

const okJson = safeJsonParse('{"a":1}');
check("safeJsonParse ok", okJson.ok && JSON.stringify(okJson.value) === '{"a":1}');
const badJson = safeJsonParse("{nope");
check("safeJsonParse bad", !badJson.ok);
eq("inboxBody: object", inboxBody('{"a":1}', okJson), { a: 1 });
eq("inboxBody: raw when not JSON", inboxBody("{nope", badJson), { raw: "{nope" });
eq("inboxBody: raw when JSON scalar", inboxBody("42", safeJsonParse("42")), { raw: "42" });

eq("sha256Hex(abc)", await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq("sha256Hex('')", await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

eq("chunk: 5 by 2", chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
eq("chunk: empty", chunk([], 200), []);
eq("chunk: size<1 → 1", chunk([1, 2], 0), [[1], [2]]);
eq("chunk: default 200", chunk(Array.from({ length: 401 }, (_, i) => i)).map((c) => c.length), [200, 200, 1]);

eq("addDays", addDays("2026-09-01T00:00:00.000Z", 30), "2026-10-01T00:00:00.000Z");
eq("addDays: bad date", addDays("never", 30), null);
eq("isoDate", isoDate("2026-09-09T14:22:00Z"), "2026-09-09");
eq("isoDate: bad", isoDate("x"), null);
eq("errorMessage: Error", errorMessage(new Error("boom")), "boom");
eq("errorMessage: string", errorMessage("s"), "s");
eq("errorMessage: object", errorMessage({ a: 1 }), '{"a":1}');
eq("tally: fixed keys, zeros", tally(["a", "b"] as const, { b: 2 }), { a: 0, b: 2 });

{
  const r = json({ ok: true }, 201);
  check("json: status", r.status === 201);
  check("json: content-type", (r.headers.get("content-type") ?? "").startsWith("application/json"));
  eq("json: body", await r.json(), { ok: true });
}

/* ------------------------------------------------------------------ *
 * rubric.ts — catalog
 * ------------------------------------------------------------------ */

check("catalogTypes: has next_step_agreed and prior_grade", catalogTypes(RUBRIC).includes("next_step_agreed") && catalogTypes(RUBRIC).includes("prior_grade"));
eq("catalogTypes: sorted", catalogTypes(RUBRIC), [...catalogTypes(RUBRIC)].sort());
{
  const e = catalogEntry(RUBRIC, "next_step_agreed");
  check("catalogEntry: reads weight from the JSON", e !== null && e.weight === RUBRIC.signals.catalog.next_step_agreed.weight);
  check("catalogEntry: lifespan", e !== null && e.lifespan_days === RUBRIC.signals.catalog.next_step_agreed.lifespan_days);
  check("catalogEntry: decays", e !== null && e.decays === true);
  eq("catalogEntry: unknown type", catalogEntry(RUBRIC, "made_up"), null);
  eq("catalogEntry: null type", catalogEntry(RUBRIC, null), null);
  const pg = catalogEntry(RUBRIC, "prior_grade");
  check("catalogEntry: prior_grade never expires", pg !== null && pg.lifespan_days === null && pg.decays === false && pg.weight === 0);
  eq("catalogEntry: no catalog", catalogEntry({}, "quote_sent"), null);
}
{
  const f = fillSignalFromCatalog({ account_id: "a", type: "quote_sent", observed_at: "2026-09-01T00:00:00.000Z" }, RUBRIC);
  check("fill: no error", f.error === null, f.error ?? "");
  const cat = RUBRIC.signals.catalog.quote_sent;
  check("fill: weight from catalog", f.row.weight === cat.weight);
  check("fill: lifespan from catalog", f.row.lifespan_days === cat.lifespan_days);
  check("fill: decays from catalog", f.row.decays === cat.decays);
  eq("fill: expires_at = observed + lifespan", f.row.expires_at, addDays("2026-09-01T00:00:00.000Z", cat.lifespan_days));
  eq("fill: filled list", f.filled, ["weight", "lifespan_days", "decays", "expires_at"]);
}
{
  const f = fillSignalFromCatalog({ type: "quote_sent", observed_at: "2026-09-01T00:00:00.000Z", weight: 3, lifespan_days: 5, decays: false, expires_at: "2026-09-03T00:00:00.000Z" }, RUBRIC);
  check("fill: stated values are kept (catalog fills gaps only)", f.row.weight === 3 && f.row.lifespan_days === 5 && f.row.decays === false && f.row.expires_at === "2026-09-03T00:00:00.000Z");
  eq("fill: nothing filled", f.filled, []);
}
{
  const f = fillSignalFromCatalog({ type: "prior_grade", observed_at: "2026-09-01T00:00:00.000Z" }, RUBRIC);
  check("fill: null lifespan → expires_at null", f.error === null && f.row.expires_at === null && f.row.lifespan_days === null);
}
check("fill: unknown type is an error", fillSignalFromCatalog({ type: "made_up", observed_at: "2026-09-01" }, RUBRIC).error !== null);
check("fill: missing type is an error", fillSignalFromCatalog({ observed_at: "2026-09-01" }, RUBRIC).error !== null);
check("fill: missing observed_at is an error", fillSignalFromCatalog({ type: "quote_sent" }, RUBRIC).error !== null);
check("fill: unparseable observed_at is an error", fillSignalFromCatalog({ type: "quote_sent", observed_at: "yesterday" }, RUBRIC).error !== null);

/* ------------------------------------------------------------------ *
 * log.ts
 * ------------------------------------------------------------------ */

check("isRunKind", isRunKind("score") && isRunKind("webhook") && !isRunKind("nightly") && !isRunKind(null));
eq("runStatus: success", runStatus(5, 0), "success");
eq("runStatus: partial", runStatus(5, 1), "partial");
eq("runStatus: failed", runStatus(0, 1), "failed");
eq("runStatus: nothing to do, no errors", runStatus(0, 0), "success");

/* ------------------------------------------------------------------ *
 * sync_pure.ts
 * ------------------------------------------------------------------ */

{
  const v = validateSyncBody(null);
  check("validate: non-object", !v.ok);
  check("validate: missing run", !validateSyncBody({ accounts: [] }).ok);
  check("validate: missing source", !validateSyncBody({ run: { kind: "seed" }, accounts: [{ key: "a", name: "A" }] }).ok);
  check("validate: bad kind", !validateSyncBody({ run: { kind: "nightly", source: "x" }, accounts: [{ key: "a", name: "A" }] }).ok);
  check("validate: nothing to write", !validateSyncBody({ run: { source: "x" } }).ok);
  check("validate: pack not array", !validateSyncBody({ run: { source: "x" }, facts: {} }).ok);
  check("validate: pack row not object", !validateSyncBody({ run: { source: "x" }, facts: [1] }).ok);
  check("validate: unknown packs ignored, empty packs fine when another has rows", validateSyncBody({ run: { source: "x" }, bogus: [1], facts: [], accounts: [{ key: "a", name: "A" }] }).ok);
  const ok = validateSyncBody({ run: { source: "notion_master", triggered_by: "session" }, accounts: [{ key: "harbor pine creative", name: "Harbor & Pine Creative" }] });
  check("validate: ok", ok.ok);
  if (ok.ok) {
    eq("validate: run defaults kind ingest", ok.body.run, { kind: "ingest", source: "notion_master", triggered_by: "session" });
    eq("validate: no rubric", ok.body.rubric, null);
  }
  const rb = validateSyncBody({ run: { source: "operator" }, rubric: { version: "0.1.0", spec: RUBRIC, activate: true } });
  check("validate: rubric ok", rb.ok && rb.body.rubric !== null && rb.body.rubric.activate === true && rb.body.rubric.version === "0.1.0");
  const rbv = validateSyncBody({ run: { source: "operator" }, rubric: { spec: RUBRIC } });
  check("validate: rubric version from spec", rbv.ok && rbv.body.rubric?.version === "0.1.0");
  check("validate: rubric version mismatch refused", !validateSyncBody({ run: { source: "operator" }, rubric: { version: "0.2.0", spec: RUBRIC } }).ok);
  check("validate: rubric without spec refused", !validateSyncBody({ run: { source: "operator" }, rubric: { version: "0.2.0" } }).ok);
  check("validate: activate defaults false", (() => { const r = validateSyncBody({ run: { source: "o" }, rubric: { version: "0.1.0", spec: RUBRIC } }); return r.ok && r.body.rubric?.activate === false; })());
}

{
  const p = pickColumns("pb_contacts", { account_id: "a", name: "n", pipedrive_org_id: 5, account_key: "k" });
  eq("pickColumns: keeps columns", p.row, { account_id: "a", name: "n" });
  eq("pickColumns: names dropped", p.dropped, ["pipedrive_org_id", "account_key"]);
  eq("pickColumns: unknown table drops all", pickColumns("nope", { a: 1 }).row, {});
  check("COLUMNS: pb_facts has stand_in and never account_key", COLUMNS.pb_facts.includes("stand_in") && !COLUMNS.pb_facts.includes("account_key"));
  check("COLUMNS: pb_deals has close_date_pushes not close_date_push", COLUMNS.pb_deals.includes("close_date_pushes") && !COLUMNS.pb_deals.includes("close_date_push"));
}

const KEY_MAP = { "harbor pine creative": "11111111-1111-1111-1111-111111111111", "juniper lane studio": "22222222-2222-2222-2222-222222222222" };
eq("accountKeys: union across packs, sorted", accountKeys({
  accounts: [{ key: "juniper lane studio", name: "Juniper Lane Studio" }],
  facts: [{ account_key: "harbor pine creative" }],
  signals: [{ account_key: "juniper lane studio" }, { account_id: "x" }],
}), ["harbor pine creative", "juniper lane studio"]);

{
  const r = resolveAccountRef({ account_key: "harbor pine creative", key: "headcount" }, KEY_MAP);
  eq("resolveAccountRef: key → id, key removed", r, { row: { key: "headcount", account_id: KEY_MAP["harbor pine creative"] }, error: null });
  check("resolveAccountRef: id wins", resolveAccountRef({ account_id: "z", account_key: "unknown" }, KEY_MAP).row.account_id === "z");
  check("resolveAccountRef: neither → error", resolveAccountRef({ key: "x" }, KEY_MAP).error !== null);
  check("resolveAccountRef: unknown key → error, never invented", resolveAccountRef({ account_key: "nobody" }, KEY_MAP).error !== null);
}

{
  const p = prepareAccounts([
    { key: "harbor pine creative", name: "Harbor & Pine Creative", domain: "harborpine.example", roster_source: "notion_master", roster_certified: false, book: "prospect", extra: 1 },
    { name: "No Key" },
  ]);
  eq("prepareAccounts: one row, extra dropped", p.rows, [{ key: "harbor pine creative", name: "Harbor & Pine Creative", domain: "harborpine.example", roster_source: "notion_master", roster_certified: false, book: "prospect" }]);
  check("prepareAccounts: missing key is an error", p.errors.length === 1);
  check("prepareAccounts: note names the dropped key", p.notes.some((n) => n.includes("extra")));
}

{
  const run = { kind: "seed", source: "notion_master", triggered_by: "t" };
  const p = prepareFacts([
    { account_key: "harbor pine creative", key: "headcount", value: 24, evidence_label: "inferred", source: "notion_master", observed_at: "2026-09-01", note: "Headcount" },
    { account_id: "z", key: "wl_signal", value: "High", evidence_label: "evidence", entered_by: "rater@example.test", stand_in: true },
    { account_key: "harbor pine creative", key: "x", evidence_label: "guess" },
    { account_key: "harbor pine creative", evidence_label: "inferred" },
    { account_key: "nobody", key: "k", evidence_label: "unknown" },
  ], run, KEY_MAP);
  check("prepareFacts: two rows", p.rows.length === 2, JSON.stringify(p.errors));
  eq("prepareFacts: entered_by default system:<source>", p.rows[0].entered_by, "system:notion_master");
  eq("prepareFacts: stated entered_by kept", p.rows[1].entered_by, "rater@example.test");
  eq("prepareFacts: source defaults to run.source", p.rows[1].source, "notion_master");
  check("prepareFacts: stand_in kept / defaulted", p.rows[1].stand_in === true && p.rows[0].stand_in === false);
  check("prepareFacts: value null when absent", "value" in p.rows[0] && p.rows[0].value === 24);
  check("prepareFacts: three errors (bad label, no key, unknown account)", p.errors.length === 3, JSON.stringify(p.errors));
  check("prepareFacts: note on defaulted entered_by", p.notes.some((n) => n.includes("entered_by defaulted")));
}

{
  const run = { kind: "seed", source: "orbit", triggered_by: "t" };
  const p = prepareSignals([
    { account_key: "harbor pine creative", type: "quote_sent", observed_at: "2026-09-01T00:00:00.000Z", payload: { project: 1 } },
    { account_id: "z", type: "prior_grade", observed_at: "2026-08-01T00:00:00.000Z", entered_by: "system:notion_master", source: "notion_master" },
  ], run, RUBRIC, KEY_MAP);
  check("prepareSignals: two rows, no bad types", p.rows.length === 2 && p.bad_types.length === 0, JSON.stringify(p.errors));
  check("prepareSignals: weight filled", p.rows[0].weight === RUBRIC.signals.catalog.quote_sent.weight);
  eq("prepareSignals: expires_at filled", p.rows[0].expires_at, addDays("2026-09-01T00:00:00.000Z", RUBRIC.signals.catalog.quote_sent.lifespan_days));
  eq("prepareSignals: entered_by default", p.rows[0].entered_by, "system:orbit");
  eq("prepareSignals: source default", p.rows[0].source, "orbit");
  check("prepareSignals: prior_grade never expires", p.rows[1].expires_at === null && p.rows[1].weight === 0);
  check("prepareSignals: account_key removed", !("account_key" in p.rows[0]));

  const bad = prepareSignals([
    { account_key: "harbor pine creative", type: "made_up", observed_at: "2026-09-01T00:00:00.000Z" },
    { account_key: "harbor pine creative", type: "also_made_up", observed_at: "2026-09-01T00:00:00.000Z" },
    { account_key: "harbor pine creative", type: "made_up", observed_at: "2026-09-01T00:00:00.000Z" },
    { account_key: "harbor pine creative", observed_at: "2026-09-01T00:00:00.000Z" },
  ], run, RUBRIC, KEY_MAP);
  eq("prepareSignals: bad types unique + sorted", bad.bad_types, ["also_made_up", "made_up"]);
  check("prepareSignals: nothing written when bad", bad.rows.length === 0 && bad.errors.length === 4);
}

{
  const p = prepareContacts([
    { account_key: "harbor pine creative", name: "Ops Lead", email: "ops@harborpine.example", title: "COO", source: "notion_master" },
    { name: "Nobody" },
  ], KEY_MAP);
  check("prepareContacts: one row + one error", p.rows.length === 1 && p.errors.length === 1);
  eq("prepareContacts: account resolved", p.rows[0].account_id, KEY_MAP["harbor pine creative"]);
}

{
  const row = dealRowForUpsert({
    pipedrive_deal_id: 77, title: "Site rebuild", close_date: "2026-11-01", close_date_push: { from: "2026-10-01", to: "2026-11-01", at: "2026-09-09T00:00:00.000Z" },
    stage_entered_at: null, is_cj: false, raw: { a: 1 },
  }, [{ from: "2026-09-01", to: "2026-10-01", at: "2026-08-20T00:00:00.000Z" }]);
  check("dealRowForUpsert: close_date_push removed", !("close_date_push" in row));
  eq("dealRowForUpsert: pushes appended in order", row.close_date_pushes, [
    { from: "2026-09-01", to: "2026-10-01", at: "2026-08-20T00:00:00.000Z" },
    { from: "2026-10-01", to: "2026-11-01", at: "2026-09-09T00:00:00.000Z" },
  ]);
  check("dealRowForUpsert: null stage_entered_at omitted (do not overwrite)", !("stage_entered_at" in row));
  const kept = dealRowForUpsert({ pipedrive_deal_id: 1, stage_entered_at: "2026-09-01T00:00:00.000Z" });
  check("dealRowForUpsert: stage_entered_at kept when given", kept.stage_entered_at === "2026-09-01T00:00:00.000Z");
  eq("dealRowForUpsert: is_cj defaults false; pushes []", [kept.is_cj, kept.close_date_pushes], [false, []]);
  const p = prepareDeals([{ pipedrive_deal_id: 5, title: "x", bogus: 1 }, { title: "no id" }]);
  check("prepareDeals: one row, one error, bogus noted", p.rows.length === 1 && p.errors.length === 1 && p.notes.some((n) => n.includes("bogus")));
}

{
  const p = prepareCalls([{ fathom_recording_id: 123, title: "Discovery", attendees: [], external_domains: [], transcript_available: true, extra: 1 }, { title: "no id" }]);
  check("prepareCalls: id coerced to string, extra dropped, missing id refused", p.rows.length === 1 && p.rows[0].fathom_recording_id === "123" && !("extra" in p.rows[0]) && p.errors.length === 1);
  const c = prepareCandidates([{ source: "orbit", source_name: "Juniper Lane Studio", matched_on: "none", confidence: "low", note: "n" }, { source_name: "no source" }]);
  check("prepareCandidates: status defaults proposed; missing source refused", c.rows.length === 1 && c.rows[0].status === "proposed" && c.errors.length === 1);
}

/* ------------------------------------------------------------------ *
 * score_pure.ts — around a real grade()
 * ------------------------------------------------------------------ */

{
  const g = groupBy([{ account_id: "a", v: 1 }, { account_id: "b", v: 2 }, { account_id: "a", v: 3 }, { v: 4 }], "account_id");
  eq("groupBy: buckets", [...g.keys()], ["a", "b"]);
  eq("groupBy: order kept", g.get("a")?.map((r) => r.v), [1, 3]);
}

const ACCOUNT = { id: "33333333-3333-3333-3333-333333333333", key: "harbor pine creative", name: "Harbor & Pine Creative", relationship_type: "agency", roster_source: "notion_master", roster_certified: false, lineage: null, book: "prospect" };
eq("toResolveAccount", toResolveAccount(ACCOUNT), { id: ACCOUNT.id, name: ACCOUNT.name, relationship_type: "agency", roster_source: "notion_master", roster_certified: false, lineage: null });

const AS_OF = "2026-09-09T06:15:00.000Z";
const FACTS = [
  { key: "icp_class", value: "ICP-1", evidence_label: "inferred", observed_at: "2026-09-01", source: "notion_master", created_at: "2026-09-02T00:00:00.000Z" },
  { key: "service_shape", value: "Core", evidence_label: "inferred", observed_at: "2026-09-01", source: "notion_master", created_at: "2026-09-02T00:00:00.000Z" },
  { key: "headcount", value: 30, evidence_label: "inferred", observed_at: "2026-09-01", source: "notion_master", created_at: "2026-09-02T00:00:00.000Z" },
  { key: "money", value: "present", evidence_label: "evidence", observed_at: "2026-09-01", source: "rater", created_at: "2026-09-02T00:00:00.000Z" },
];
const resolved = resolveFeatures({ account: toResolveAccount(ACCOUNT), facts: FACTS, signals: [], deals: [], override_rows: [], as_of: AS_OF, rubric: RUBRIC });
const SC: ProspectScorecard = grade(resolved.features, RUBRIC, { override: resolved.override });
check("grade: a scorecard came back", SC.account_id === ACCOUNT.id && SC.anticipated === true && SC.validation === "UNVALIDATED");

{
  const sha = await sha256Hex(JSON.stringify(SC));
  const row = buildReadRow(SC, "run-1", sha);
  eq("buildReadRow: as_of is a date", row.as_of, "2026-09-09");
  eq("buildReadRow: identity columns", [row.account_id, row.run_id, row.rubric_version, row.rubric_fingerprint], [ACCOUNT.id, "run-1", SC.rubric_version, SC.rubric_fingerprint]);
  eq("buildReadRow: listing columns mirror the scorecard", [row.status, row.effective_tier, row.computed_tier, row.confidence, row.qualification_label, row.facts_present, row.ceiling, row.year1_band, row.urgency, row.cell],
    [SC.status, SC.effective_tier, SC.fit.computed_tier, SC.fit.confidence, SC.qualification.label, SC.qualification.present_count, SC.potential.ceiling, SC.potential.year1_band, SC.signals.urgency, SC.cell]);
  check("buildReadRow: reason and flags", row.reason === SC.reason && Array.isArray(row.flags));
  check("buildReadRow: scorecard + sha", row.scorecard === SC && row.scorecard_sha256 === sha && /^[0-9a-f]{64}$/.test(sha));
  eq("listingPatch", listingPatch(SC), { status: SC.status, effective_tier: SC.effective_tier, cell: SC.cell });
}

{
  const d0 = diffEntry(SC, null);
  check("diffEntry: no current read → changed", d0.changed && d0.from_tier === null && d0.to_tier === SC.effective_tier && d0.to_status === SC.status);
  const same = diffEntry(SC, { account_id: SC.account_id, effective_tier: SC.effective_tier, status: SC.status });
  check("diffEntry: same → unchanged", !same.changed);
  const moved = diffEntry(SC, { account_id: SC.account_id, effective_tier: "Bronze", status: SC.status });
  check("diffEntry: tier move → changed", moved.changed && moved.from_tier === "Bronze");
  eq("diffEntry: shape", Object.keys(d0), ["account_id", "name", "from_tier", "to_tier", "from_status", "to_status", "changed"]);
}

{
  const parked = { ...SC, status: "Parked" } as ProspectScorecard;
  const uncl = { ...SC, status: "Unclassified" } as ProspectScorecard;
  const over = { ...SC, status: "Overridden" } as ProspectScorecard;
  const ranked = { ...SC, status: "Ranked" } as ProspectScorecard;
  eq("tallyScorecards", tallyScorecards([parked, uncl, over, ranked, ranked], 2), { scored: 5, parked: 1, unclassified: 1, overridden: 1, ranked: 2, errors: 2 });
  eq("tallyScorecards: empty", tallyScorecards([], 0), { scored: 0, parked: 0, unclassified: 0, overridden: 0, ranked: 0, errors: 0 });
}

/* ------------------------------------------------------------------ *
 * webhook_pure.ts
 * ------------------------------------------------------------------ */

{
  const h = fathomInboxHeaders(new FakeHeaders({ "webhook-id": "msg_1", "webhook-timestamp": "1757400000", "webhook-signature": "v1,abc", "content-type": "application/json" }));
  eq("fathomInboxHeaders: subset + has-signature, never the signature", h, { "webhook-id": "msg_1", "webhook-timestamp": "1757400000", "content-type": "application/json", "user-agent": null, "has-signature": true });
  check("fathomInboxHeaders: no signature", fathomInboxHeaders(new FakeHeaders({}))["has-signature"] === false);
  const p = pipedriveInboxHeaders(new FakeHeaders({ Authorization: "Basic dXNlcjpwYXNz", "user-agent": "Pipedrive-Webhooks" }));
  check("pipedriveInboxHeaders: has-authorization, credential absent", p["has-authorization"] === true && !JSON.stringify(p).includes("dXNlcjpwYXNz"));
  check("pipedriveInboxHeaders: none", pipedriveInboxHeaders(null)["has-authorization"] === false);
}

check("hasNonEmptyActionItems: array", hasNonEmptyActionItems({ action_items: [{ text: "Send the SOW" }] }));
check("hasNonEmptyActionItems: empty array", !hasNonEmptyActionItems({ action_items: [] }));
check("hasNonEmptyActionItems: absent", !hasNonEmptyActionItems({}));
check("hasNonEmptyActionItems: null", !hasNonEmptyActionItems({ action_items: null }));
check("hasNonEmptyActionItems: string", hasNonEmptyActionItems({ action_items: "- send the SOW\n- book the call" }));
check("hasNonEmptyActionItems: blank string", !hasNonEmptyActionItems({ action_items: "   " }));
check("hasNonEmptyActionItems: array of blanks", !hasNonEmptyActionItems({ action_items: ["", " "] }));
check("hasNonEmptyActionItems: object with items", hasNonEmptyActionItems({ action_items: { items: [1] } }) && !hasNonEmptyActionItems({ action_items: { items: [] } }));
check("hasNonEmptyActionItems: non-object payload", !hasNonEmptyActionItems("x") && !hasNonEmptyActionItems(null));
eq("actionItemCount", [actionItemCount({ action_items: [1, 2] }), actionItemCount({ action_items: "a\nb\n" }), actionItemCount({}), actionItemCount({ action_items: { items: [1, 2, 3] } })], [2, 2, null, 3]);

const CALL: CallRow = {
  fathom_recording_id: "rec_42", account_id: null, title: "Harbor & Pine — discovery", held_at: "2026-09-08T15:00:00.000Z",
  url: "https://fathom.video/calls/42", recorded_by: "sales@whitelabeliq.com", attendees: [], external_domains: ["harborpine.example"],
  summary: null, transcript_available: true, fields: null, extraction_status: "pending",
};
{
  const cat = RUBRIC.signals.catalog.next_step_agreed;
  const s = fathomNextStepSignal(CALL, ACCOUNT.id, { action_items: [{ text: "Send proposal" }] }, RUBRIC);
  check("fathomNextStepSignal: raised", s !== null);
  if (s) {
    eq("fathomNextStepSignal: shape", [s.account_id, s.source, s.type, s.observed_at, s.evidence_url, s.entered_by, s.contact_id], [ACCOUNT.id, "fathom", "next_step_agreed", CALL.held_at, CALL.url, "system:fathom", null]);
    check("fathomNextStepSignal: weight/lifespan/decays from catalog", s.weight === cat.weight && s.lifespan_days === cat.lifespan_days && s.decays === cat.decays);
    eq("fathomNextStepSignal: expires_at", s.expires_at, addDays(CALL.held_at as string, cat.lifespan_days));
    check("fathomNextStepSignal: payload names the approximation", typeof (s.payload as Record<string, unknown>).approximation === "string" && (s.payload as Record<string, unknown>).recording_id === "rec_42");
  }
  eq("fathomNextStepSignal: not attached → none", fathomNextStepSignal(CALL, null, { action_items: [1] }, RUBRIC), null);
  eq("fathomNextStepSignal: no action items → none", fathomNextStepSignal(CALL, ACCOUNT.id, { action_items: [] }, RUBRIC), null);
  eq("fathomNextStepSignal: absent action items → none (unknown is not evidence)", fathomNextStepSignal(CALL, ACCOUNT.id, {}, RUBRIC), null);
  eq("fathomNextStepSignal: no catalog → none", fathomNextStepSignal(CALL, ACCOUNT.id, { action_items: [1] }, {}), null);
  eq("fathomNextStepSignal: no held_at → none", fathomNextStepSignal({ ...CALL, held_at: null }, ACCOUNT.id, { action_items: [1] }, RUBRIC), null);
}

{
  // End to end through the real parser: an external call to a known domain attaches and would raise the signal.
  const known = [{ id: ACCOUNT.id, key: ACCOUNT.key, name: ACCOUNT.name, domain: "harborpine.example", pipedrive_org_id: null, orbit_client_id: null }];
  const payload = {
    recording_id: 42, title: "Discovery", url: "https://fathom.video/calls/42", created_at: "2026-09-08T15:00:00.000Z",
    recorded_by: { name: "Sales", email: "sales@whitelabeliq.com" },
    calendar_invitees: [{ name: "Ops Lead", email: "ops@harborpine.example", is_external: true }, { name: "Sales", email: "sales@whitelabeliq.com", is_external: false }],
    action_items: [{ description: "Send proposal by Friday" }],
  };
  const r = parseFathomWebhook(payload, known);
  check("fathom e2e: external, attached", r.external && r.skip_reason === null && r.attach?.id === ACCOUNT.id);
  const sig = fathomNextStepSignal(r.call, r.attach?.id ?? null, payload, RUBRIC);
  check("fathom e2e: signal raised on attach + action_items", sig !== null && sig.account_id === ACCOUNT.id);
  const internal = parseFathomWebhook({ ...payload, calendar_invitees: [{ email: "sales@whitelabeliq.com", is_external: false }] }, known);
  check("fathom e2e: internal-only skipped", !internal.external && internal.skip_reason !== null);
}

{
  const rows = candidateRows([{ account_id: null, source: "fathom", source_id: "rec_1", source_name: null, source_domain: "x.example", matched_on: "none", confidence: null, note: "n" }]);
  eq("candidateRows: status proposed", rows[0].status, "proposed");
  eq("candidateRows: columns only", Object.keys(rows[0]).sort(), ["account_id", "confidence", "matched_on", "note", "source", "source_domain", "source_id", "source_name", "status"]);
}

{
  const fm = parseFieldMap(JSON.stringify({ deals: { abc123: { label: "Grade", options: { "414": "A" } } }, junk: 1 }));
  check("parseFieldMap: deals kept, junk dropped, no note", fm.note === null && fm.map.deals?.abc123?.label === "Grade" && !("junk" in fm.map));
  check("parseFieldMap: absent → {} + note", parseFieldMap(null).note !== null && Object.keys(parseFieldMap(null).map).length === 0);
  check("parseFieldMap: not JSON → {} + note", parseFieldMap("{nope").note !== null);
  check("parseFieldMap: JSON array → {} + note", parseFieldMap("[1]").note !== null);
}

{
  const acct = { mode: "attach" as const, id: ACCOUNT.id, pipedrive_org_id: 900, name: "Harbor & Pine Creative LLC", key: "harbor pine creative", domain: "harborpine.example", roster_source: "pipedrive" as const, roster_certified: true as const };
  eq("accountAttachPatch: certifies, fills missing domain, never key", accountAttachPatch(acct, { id: ACCOUNT.id, name: "Harbor & Pine Creative", domain: null }), { pipedrive_org_id: 900, roster_source: "pipedrive", roster_certified: true, domain: "harborpine.example" });
  eq("accountAttachPatch: existing name/domain kept", accountAttachPatch(acct, { id: ACCOUNT.id, name: "Harbor & Pine Creative", domain: "hp.example" }), { pipedrive_org_id: 900, roster_source: "pipedrive", roster_certified: true });
  eq("accountAttachPatch: no existing row → minimal patch", accountAttachPatch(acct, null), { pipedrive_org_id: 900, roster_source: "pipedrive", roster_certified: true });
  eq("accountCreateRow", accountCreateRow({ ...acct, mode: "create", id: null }), { key: "harbor pine creative", name: "Harbor & Pine Creative LLC", domain: "harborpine.example", pipedrive_org_id: 900, roster_source: "pipedrive", roster_certified: true, book: "prospect" });
}

{
  const c = { account_id: null, name: "Ops Lead", email: "ops@harborpine.example", title: "COO", pipedrive_person_id: 55, pipedrive_org_id: 900, source: "pipedrive" as const };
  eq("contactRow: resolved account, org id dropped", contactRow(c, ACCOUNT.id), { account_id: ACCOUNT.id, name: "Ops Lead", email: "ops@harborpine.example", title: "COO", pipedrive_person_id: 55, source: "pipedrive" });
  eq("contactRow: no account → null", contactRow(c, null), null);
  check("contactRow: own account_id wins", contactRow({ ...c, account_id: "own" }, ACCOUNT.id)?.account_id === "own");
  eq("accountIdForOrg", accountIdForOrg([{ id: "a", pipedrive_org_id: "900" }, { id: "b", pipedrive_org_id: null }], 900), "a");
  eq("accountIdForOrg: miss / null", [accountIdForOrg([{ id: "a", pipedrive_org_id: 1 }], 2), accountIdForOrg([{ id: "a", pipedrive_org_id: 1 }], null)], [null, null]);
  eq("dealAccountsMap", dealAccountsMap([{ pipedrive_deal_id: 7, account_id: "a" }, { pipedrive_deal_id: 8, account_id: null }]), { "7": "a" });
}

{
  const deal = { pipedrive_deal_id: 77, account_id: ACCOUNT.id, title: "Site rebuild", close_date: "2026-11-01", close_date_push: { from: "2026-10-01", to: "2026-11-01", at: "2026-09-09T00:00:00.000Z" }, stage_entered_at: null, is_cj: false, raw: {} };
  const merged = mergeDealUpsert(deal, { pipedrive_deal_id: 77, close_date_pushes: [{ from: "2026-09-01", to: "2026-10-01", at: "2026-08-20T00:00:00.000Z" }] });
  check("mergeDealUpsert: two pushes, no close_date_push, no null stage", Array.isArray(merged.close_date_pushes) && (merged.close_date_pushes as unknown[]).length === 2 && !("close_date_push" in merged) && !("stage_entered_at" in merged));
  const fresh = mergeDealUpsert(deal, null);
  check("mergeDealUpsert: no existing → one push", (fresh.close_date_pushes as unknown[]).length === 1);
  const none = mergeDealUpsert({ ...deal, close_date_push: null }, { close_date_pushes: "not-an-array" });
  eq("mergeDealUpsert: no push, bad existing → []", none.close_date_pushes, []);
}

/* ------------------------------------------------------------------ *
 * The copies in _shared/core and _shared/ingest are byte-identical to the originals
 * ------------------------------------------------------------------ */

{
  const repo = join(here, "..", "..", "..");
  const files = ["core/engine.ts", "core/classify.ts", "core/decay.ts", "core/reason.ts", "core/prospect_types.ts", "core/rubric.prospect.v0.1.json",
    "ingest/identity.ts", "ingest/resolve_features.ts", "ingest/notion_seed.ts", "ingest/orbit_quotes.ts", "ingest/pipedrive_webhook.ts", "ingest/fathom_webhook.ts", "ingest/webhook_signatures.ts"];
  for (const f of files) {
    let same = false;
    try {
      same = readFileSync(join(repo, f)).equals(readFileSync(join(here, f)));
    } catch {
      same = false;
    }
    check(`_shared copy is byte-identical: ${f}`, same, "run scripts/sync_shared.sh");
  }
}

/* ------------------------------------------------------------------ *
 * No clock reads in the pure helpers
 * ------------------------------------------------------------------ */

for (const f of ["helpers.ts", "rubric.ts", "sync_pure.ts", "score_pure.ts", "webhook_pure.ts", "auth.ts"]) {
  const src = readFileSync(join(here, f), "utf8");
  check(`no Date.now()/new Date() in ${f}`, !/Date\.now\(\)|new Date\(\)/.test(src));
  check(`no jsr:/npm: import in ${f}`, !/from\s+["'](jsr|npm):/.test(src));
}

/* ------------------------------------------------------------------ */

console.log(`helpers_test: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
