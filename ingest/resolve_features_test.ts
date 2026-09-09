/**
 * WLIQ Prospect Book — feature resolver tests.
 *
 * Run:  node --experimental-strip-types ingest/resolve_features_test.ts
 *   or: deno run --allow-read ingest/resolve_features_test.ts
 *
 * Every row here is synthetic ("Harbor & Pine Creative" is an invented agency). The rubric is
 * the real v0.1 JSON so the catalog weights, aliases and reason codes under test are the ones
 * the engine will see.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveFeatures } from "./resolve_features.ts";
import type { DealRow, FactRow, RegisterRow, ResolveInput, SignalRow } from "./resolve_features.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUBRIC = JSON.parse(readFileSync(join(here, "../core/rubric.prospect.v0.1.json"), "utf8"));

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

const AS_OF = "2026-09-09";

const ACCOUNT = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Harbor & Pine Creative",
  relationship_type: "agency",
  roster_source: "notion_master",
  roster_certified: false,
  lineage: null,
};

let seq = 0;
function factRow(key: string, value: unknown, o: Partial<FactRow> = {}): FactRow {
  seq++;
  return {
    key,
    value,
    evidence_label: o.evidence_label ?? "inferred",
    observed_at: o.observed_at ?? "2026-09-01",
    source: o.source ?? "notion_master",
    created_at: o.created_at ?? `2026-09-01T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    ...o,
  };
}

function signalRow(type: string, o: Partial<SignalRow> = {}): SignalRow {
  return {
    source: o.source ?? "manual",
    type,
    observed_at: o.observed_at ?? "2026-09-01T12:00:00Z",
    payload: o.payload ?? null,
    weight: o.weight === undefined ? null : o.weight,
    lifespan_days: o.lifespan_days === undefined ? null : o.lifespan_days,
    decays: o.decays === undefined ? null : o.decays,
    expires_at: o.expires_at === undefined ? null : o.expires_at,
    evidence_url: o.evidence_url ?? null,
  };
}

function dealRow(id: number, o: Partial<DealRow> = {}): DealRow {
  return {
    pipedrive_deal_id: id,
    title: o.title ?? `Deal ${id}`,
    stage_name: o.stage_name ?? "Proposal",
    stage_entered_at: o.stage_entered_at ?? "2026-08-20T00:00:00Z",
    close_date: o.close_date ?? "2026-09-30",
    close_date_pushes: o.close_date_pushes ?? [],
    status: o.status ?? "open",
    is_cj: o.is_cj ?? false,
    last_buyer_touch_at: o.last_buyer_touch_at ?? null,
    buyer_email_velocity_7d: o.buyer_email_velocity_7d ?? null,
    next_meeting_at: o.next_meeting_at ?? null,
    decision_maker_engaged: o.decision_maker_engaged ?? null,
    buyer_contacts_30d: o.buyer_contacts_30d ?? null,
    price_discussed: o.price_discussed ?? null,
    calls_held: o.calls_held ?? null,
    ...o,
  };
}

function overrideRow(o: Partial<RegisterRow> & { payload?: Record<string, unknown> | null } = {}): RegisterRow {
  return {
    kind: o.kind ?? "override",
    payload: o.payload === undefined
      ? { tier: "Gold", reason_code: "relationship_known", reason: "Met the founder at a peer group", expires_at: "2026-12-01T00:00:00Z" }
      : o.payload,
    made_by: o.made_by ?? "owner@example.test",
    created_at: o.created_at ?? "2026-09-05T10:00:00Z",
    expires_at: o.expires_at === undefined ? "2026-12-01T00:00:00Z" : o.expires_at,
    reason_code: o.reason_code,
    text: o.text ?? "Met the founder at a peer group",
  };
}

function run(partial: Partial<ResolveInput> = {}) {
  return resolveFeatures({
    account: ACCOUNT,
    facts: [],
    signals: [],
    deals: [],
    override_rows: [],
    as_of: AS_OF,
    rubric: RUBRIC,
    ...partial,
  });
}

/* ------------------------------------------------------------------ *
 * 1 · Empty inputs: every unknown is null, nothing is invented
 * ------------------------------------------------------------------ */
{
  const r = run();
  const f = r.features;
  eq("account fields carried", [f.account_id, f.name, f.as_of], [ACCOUNT.id, ACCOUNT.name, AS_OF]);
  eq("relationship_type from the account", f.relationship_type, "agency");
  eq("roster_source and roster_certified from the account", [f.roster_source, f.roster_certified], ["notion_master", false]);
  eq("lineage null", f.lineage, null);
  eq("no facts → icp_class null with label unknown", [f.icp_class, f.icp_class_label], [null, "unknown"]);
  eq("no facts → headcount null with label unknown", [f.headcount, f.headcount_label], [null, "unknown"]);
  eq("Dimension A defaults to unknown, not absent", [f.money, f.authority, f.specification, f.timing, f.timing_state], ["unknown", "unknown", "unknown", null, "unknown"]);
  eq("trailing_12m_revenue defaults to 0", f.trailing_12m_revenue, 0);
  eq("climb_signals defaults to an empty list", f.climb_signals, []);
  eq("signals, deals, prior_grades empty", [f.signals, f.deals, f.prior_grades], [[], [], []]);
  eq("no override", r.override, null);
  eq("no notes on clean empty input", r.notes, []);
  const nullKeys = ["is_agency", "agency_type", "revenue_band", "vertical_depth", "wl_signal", "service_shape", "economics",
    "deal_size_estimate", "hourly_rate_accepted", "broker_character", "referral_from_network", "icp4_vertical_proven",
    "recurring_revenue_share", "niche_positioning", "am_pm_separated", "platform_partner_badge", "peer_network_member",
    "ai_posture", "avg_project_size", "already_outsources", "owner_does_everything", "inhouse_dev_team", "dev_archetype",
    "shrinking", "archetype", "serviceable_share", "n_vendors", "our_rank", "quote_amount", "stated_ceiling"] as const;
  check("every optional feature is null when no fact exists", nullKeys.every((k) => (f as Record<string, unknown>)[k] === null),
    nullKeys.filter((k) => (f as Record<string, unknown>)[k] !== null).join(","));
}

/* ------------------------------------------------------------------ *
 * 2 · Facts: latest wins, labels, coercions, vocabulary
 * ------------------------------------------------------------------ */
{
  const r = run({
    facts: [
      factRow("headcount", 12, { evidence_label: "inferred", created_at: "2026-08-01T00:00:00Z" }),
      factRow("headcount", 18, { evidence_label: "evidence", created_at: "2026-09-02T00:00:00Z", source: "apollo" }),
      factRow("headcount", 15, { evidence_label: "inferred", created_at: "2026-08-15T00:00:00Z" }),
    ],
  });
  eq("latest fact per key wins regardless of input order", r.features.headcount, 18);
  eq("headcount_label comes from the winning fact", r.features.headcount_label, "evidence");
  eq("no notes for a clean multi-row history", r.notes, []);
}
{
  const r = run({ facts: [factRow("icp_class", "ICP-2", { evidence_label: "evidence" })] });
  eq("icp_class resolved with its label", [r.features.icp_class, r.features.icp_class_label], ["ICP-2", "evidence"]);
}
{
  const r = run({ facts: [factRow("icp_class", "icp 4"), factRow("wl_signal", "very high"), factRow("service_shape", "Adjacent"), factRow("stated_ceiling", "Seat at the table")] });
  eq("icp spelling variants are accepted", r.features.icp_class, "ICP-4");
  eq("wl_signal is case-insensitive", r.features.wl_signal, "Very High");
  eq("service_shape Notion alias Adjacent → Complement (from the rubric)", r.features.service_shape, "Complement");
  eq("stated_ceiling alias Seat at the table → Embedded (from the rubric)", r.features.stated_ceiling, "Embedded");
  eq("aliases produce no notes", r.notes, []);
}
{
  const r = run({ facts: [factRow("service_shape", "Neither"), factRow("service_shape", "Unknown", { created_at: "2026-09-03T00:00:00Z" })] });
  eq("a Notion 'Unknown' alias is a recorded unknown, not a value", r.features.service_shape, null);
  eq("...and not a note", r.notes, []);
}
{
  const r = run({ facts: [factRow("icp_class", "ICP-9"), factRow("wl_signal", "Extreme"), factRow("headcount", "twelve")] });
  eq("out-of-vocabulary values are null", [r.features.icp_class, r.features.wl_signal, r.features.headcount], [null, null, null]);
  eq("...with the label unknown", [r.features.icp_class_label, r.features.headcount_label], ["unknown", "unknown"]);
  eq("...and one note each", r.notes.length, 3);
  check("notes name the key and say 'treated as unknown'", r.notes.every((n) => n.includes("treated as unknown")) && r.notes.some((n) => n.startsWith("fact icp_class")));
}
{
  const r = run({ facts: [factRow("headcount", null, { evidence_label: "evidence" })] });
  eq("a null value is a recorded unknown: null, label unknown, no note", [r.features.headcount, r.features.headcount_label, r.notes], [null, "unknown", []]);
}
{
  const r = run({ facts: [factRow("headcount", "24"), factRow("deal_size_estimate", "$12,500"), factRow("recurring_revenue_share", "0.4"), factRow("n_vendors", 3), factRow("our_rank", "2")] });
  eq("numeric strings parse", [r.features.headcount, r.features.deal_size_estimate, r.features.recurring_revenue_share, r.features.n_vendors, r.features.our_rank], [24, 12500, 0.4, 3, 2]);
  eq("clean numeric parsing leaves no notes", r.notes, []);
}
{
  const r = run({ facts: [factRow("recurring_revenue_share", 40), factRow("serviceable_share", 1.5), factRow("headcount", -3), factRow("headcount", 2.5, { created_at: "2026-09-04T00:00:00Z" })] });
  eq("a percent-shaped ratio is refused, never rescaled", r.features.recurring_revenue_share, null);
  eq("a ratio above 1 is refused", r.features.serviceable_share, null);
  eq("a fractional headcount is refused", r.features.headcount, null);
  eq("three refusals, three notes", r.notes.length, 3);
}
{
  const r = run({ facts: [factRow("referral_from_network", "Yes"), factRow("already_outsources", "no"), factRow("shrinking", true), factRow("dev_archetype", "Unknown"), factRow("niche_positioning", "maybe")] });
  eq("booleans accept true/false and yes/no words", [r.features.referral_from_network, r.features.already_outsources, r.features.shrinking], [true, false, true]);
  eq("'Unknown' is null without a note; 'maybe' is null with a note", [r.features.dev_archetype, r.features.niche_positioning, r.notes.length], [null, null, 1]);
}
{
  const r = run({ facts: [factRow("money", "Yes"), factRow("authority", "No"), factRow("specification", "present"), factRow("timing", "Hot")] });
  eq("Dimension A Notion aliases map through the rubric", [r.features.money, r.features.authority, r.features.specification], ["present", "absent", "present"]);
  eq("timing Lead-priority alias Hot → within_1_month", r.features.timing, "within_1_month");
  eq("timing_state derives present from a dated timing", r.features.timing_state, "present");
}
{
  const r = run({ facts: [factRow("timing", "no_timeline")] });
  eq("no_timeline → timing_state absent", [r.features.timing, r.features.timing_state], ["no_timeline", "absent"]);
}
{
  const r = run({ facts: [factRow("timing", "within_1_week"), factRow("timing_state", "absent")] });
  eq("an explicit timing_state fact wins over the derivation", r.features.timing_state, "absent");
}
{
  const r = run({ facts: [factRow("climb_signals", ["multi_thread", "Strategy question asked", "made_up_signal", "second_project_scoped", "multi_thread"])] });
  eq("climb_signals map through the rubric aliases, keep canonical names, dedupe, drop unknowns",
    r.features.climb_signals, ["2nd person engaged", "Strategy question asked", "2nd project scoped"]);
  eq("the unknown entry is one note", r.notes.length, 1);
  check("...naming the entry", r.notes[0].includes("made_up_signal"));
}
{
  const r = run({ facts: [factRow("climb_signals", "refers_others")] });
  eq("a single-string climb_signals fact becomes a one-item list", r.features.climb_signals, ["Referred someone"]);
}
{
  const r = run({ facts: [factRow("notion_status", "Active"), factRow("notion_current_am", "role: AM")] });
  eq("informational fact keys never become features and are noted once", r.notes, ["ignored non-feature fact keys: notion_current_am, notion_status"]);
}
{
  const r = run({ facts: [factRow("headcount", 30, { evidence_label: "guessed" })] });
  eq("an out-of-vocabulary evidence label is unknown", r.features.headcount_label, "unknown");
  eq("...and noted", r.notes.length, 1);
}
{
  const r = run({ facts: [factRow("trailing_12m_revenue", 4200), factRow("quote_amount", "$9,800")] });
  eq("trailing_12m_revenue and quote_amount are money", [r.features.trailing_12m_revenue, r.features.quote_amount], [4200, 9800]);
}
{
  const r = run({ account: { ...ACCOUNT, relationship_type: null }, facts: [factRow("relationship_type", "Direct-to-client")] });
  eq("relationship_type falls back to a fact when the account column is null", r.features.relationship_type, "direct");
}
{
  const r = run({ account: { ...ACCOUNT, relationship_type: "partner", roster_source: "carrier_pigeon", roster_certified: null, lineage: "lapsed_client" } });
  eq("bad account vocab → null with notes; lineage lapsed_client kept", [r.features.relationship_type, r.features.roster_source, r.features.roster_certified, r.features.lineage], [null, null, false, "lapsed_client"]);
  eq("two account notes", r.notes.length, 2);
}

/* ------------------------------------------------------------------ *
 * 3 · Signals: expiry, catalog fill, row authority, prior grades
 * ------------------------------------------------------------------ */
{
  const r = run({
    signals: [
      signalRow("quote_sent", { source: "orbit", observed_at: "2026-09-01T00:00:00Z" }),
      signalRow("referral_warm_intro", { source: "manual", observed_at: "2026-08-20T00:00:00Z", weight: 7, lifespan_days: 45, decays: true }),
      signalRow("neg_champion_left", { source: "fathom", observed_at: "2026-08-25T00:00:00Z" }),
    ],
  });
  const s = r.features.signals;
  eq("three live signals, newest first", s.map((x) => x.type), ["quote_sent", "neg_champion_left", "referral_warm_intro"]);
  const qs = s.find((x) => x.type === "quote_sent");
  eq("null weight filled from the catalog (weight, lifespan, decays)", [qs?.weight, qs?.lifespan_days, qs?.decays], [8, 30, true]);
  const neg = s.find((x) => x.type === "neg_champion_left");
  eq("a non-decaying negative keeps decays=false from the catalog", [neg?.weight, neg?.lifespan_days, neg?.decays], [-8, 90, false]);
  const ref = s.find((x) => x.type === "referral_warm_intro");
  eq("a row that carries its own weight is authoritative over the catalog", [ref?.weight, ref?.lifespan_days, ref?.decays], [7, 45, true]);
  eq("no notes", r.notes, []);
}
{
  const r = run({
    signals: [
      signalRow("quote_sent", { expires_at: "2026-09-08T23:59:59Z" }),
      signalRow("meeting_accepted", { expires_at: "2026-09-09T00:00:00Z" }),
      signalRow("inbound_reply", { expires_at: "2026-10-01T00:00:00Z" }),
      signalRow("next_step_agreed", { expires_at: null }),
    ],
  });
  eq("expired signals (expires_at < as_of) are dropped; = as_of, later and null are kept",
    r.features.signals.map((x) => x.type).sort(), ["inbound_reply", "meeting_accepted", "next_step_agreed"]);
}
{
  const r = run({ signals: [signalRow("quote_sent", { weight: "8.5", lifespan_days: "30" })] });
  eq("numeric strings from PostgREST are coerced", [r.features.signals[0].weight, r.features.signals[0].lifespan_days], [8.5, 30]);
}
{
  const r = run({ signals: [signalRow("peer_group_attendance", { weight: 3, lifespan_days: null, decays: false })] });
  eq("a row lifespan of null is honoured (never expires), not replaced from the catalog", r.features.signals[0].lifespan_days, null);
}
{
  const r = run({ signals: [signalRow("signal_nobody_catalogued")] });
  eq("an unknown type with no weight is dropped, not guessed", r.features.signals, []);
  check("...with a note", r.notes.length === 1 && r.notes[0].includes("signal_nobody_catalogued"));
}
{
  const r = run({ signals: [signalRow("signal_nobody_catalogued", { weight: 2 })] });
  eq("an unknown type WITH a weight is kept: the row is authoritative", r.features.signals.map((x) => [x.type, x.weight, x.lifespan_days, x.decays]), [["signal_nobody_catalogued", 2, null, true]]);
}
{
  const r = run({
    signals: [
      signalRow("prior_grade", { source: "notion_master", observed_at: "2026-07-01T00:00:00Z", payload: { field: "Prospect grade (effective)", value: "A-" } }),
      signalRow("prior_grade", { source: "gotham", observed_at: "2026-05-01T00:00:00Z", payload: { value: "Gold" } }),
      signalRow("prior_grade", { source: "tier1_book", payload: { field: "Grade" } }),
    ],
  });
  eq("prior_grade signals become prior_grades (value, source, observed_at), newest first",
    r.features.prior_grades, [
      { source: "notion_master", value: "A-", observed_at: "2026-07-01T00:00:00Z" },
      { source: "gotham", value: "Gold", observed_at: "2026-05-01T00:00:00Z" },
    ]);
  eq("prior grades are not also in signals", r.features.signals, []);
  check("a prior_grade without payload.value is dropped with a note", r.notes.length === 1 && r.notes[0].includes("tier1_book"));
}
{
  const r = run({ signals: [signalRow("quote_sent", { observed_at: "not a date" })] });
  eq("a signal without a parseable observed_at is dropped", r.features.signals, []);
  eq("...with one note", r.notes.length, 1);
}
{
  const r = run({ signals: [signalRow("quote_sent", { observed_at: "2026-09-20T00:00:00Z", payload: { project_id: 7 }, evidence_url: "https://example.test/q/7" })] });
  eq("a future-dated signal is kept and noted", [r.features.signals.length, r.notes.length], [1, 1]);
  eq("payload and evidence_url pass through", [r.features.signals[0].payload, r.features.signals[0].evidence_url], [{ project_id: 7 }, "https://example.test/q/7"]);
}

/* ------------------------------------------------------------------ *
 * 4 · Deals: open, non-CJ, mapped
 * ------------------------------------------------------------------ */
{
  const r = run({
    deals: [
      dealRow(30, { status: "won" }),
      dealRow(20, { status: "open", is_cj: true, title: "CJ · Onboarding" }),
      dealRow(10, {
        status: "open",
        close_date_pushes: [
          { from: "2026-08-01", to: "2026-08-15", at: "2026-07-30T00:00:00Z" },
          { from: "2026-08-15", to: "2026-09-30", at: "2026-08-14T00:00:00Z" },
        ],
        last_buyer_touch_at: "2026-09-01T00:00:00Z",
        buyer_email_velocity_7d: 2,
        decision_maker_engaged: true,
        buyer_contacts_30d: 3,
        price_discussed: false,
        calls_held: 2,
      }),
      dealRow(40, { status: "lost" }),
      dealRow(5, { status: "open", is_cj: null }),
    ],
  });
  eq("only open, non-CJ deals survive, ordered by id", r.features.deals.map((d) => d.deal_id), ["5", "10"]);
  const d = r.features.deals.find((x) => x.deal_id === "10")!;
  eq("close_date_pushes is the count of the jsonb list", d.close_date_pushes, 2);
  eq("largest_push_days is the biggest from→to gap", d.largest_push_days, 46);
  eq("stage_median_days is null (rubric default applies in the engine)", d.stage_median_days, null);
  eq("known columns map 1:1", [d.title, d.stage_name, d.close_date, d.last_buyer_touch_at, d.buyer_email_velocity_7d, d.decision_maker_engaged, d.buyer_contacts_30d, d.price_discussed, d.calls_held],
    ["Deal 10", "Proposal", "2026-09-30", "2026-09-01T00:00:00Z", 2, true, 3, false, 2]);
  eq("fields pb_deals does not carry are null, never guessed", [d.critical_event_captured, d.indecision_level, d.risk_words_present, d.competitor_named_late], [null, null, null, null]);
  const d5 = r.features.deals.find((x) => x.deal_id === "5")!;
  eq("a deal with no pushes has 0 pushes and null largest", [d5.close_date_pushes, d5.largest_push_days], [0, null]);
  eq("unknown deal fields stay null", [d5.decision_maker_engaged, d5.calls_held, d5.next_meeting_at], [null, null, null]);
}
{
  const r = run({ deals: [dealRow(1, { close_date_pushes: 3, indecision_level: "high", critical_event_captured: false })] });
  eq("a plain numeric push count is accepted defensively", [r.features.deals[0].close_date_pushes, r.features.deals[0].largest_push_days], [3, null]);
  eq("Fathom-derived fields pass through when a row carries them", [r.features.deals[0].indecision_level, r.features.deals[0].critical_event_captured], ["high", false]);
}

/* ------------------------------------------------------------------ *
 * 5 · Override: latest live register row of kind override
 * ------------------------------------------------------------------ */
{
  const r = run({
    override_rows: [
      overrideRow({ created_at: "2026-09-01T00:00:00Z", payload: { tier: "Silver", reason_code: "data_wrong", reason: "older", expires_at: null }, expires_at: null }),
      overrideRow({ created_at: "2026-09-05T10:00:00Z" }),
      overrideRow({ kind: "note", created_at: "2026-09-08T00:00:00Z", payload: { tier: "Platinum" } }),
    ],
  });
  eq("the latest override wins; other kinds are ignored", r.override, {
    tier: "Gold",
    reason_code: "relationship_known",
    reason: "Met the founder at a peer group",
    approver: "owner@example.test",
    set_at: "2026-09-05T10:00:00Z",
    expires_at: "2026-12-01T00:00:00Z",
  });
}
{
  const r = run({ override_rows: [overrideRow({ expires_at: "2026-09-01T00:00:00Z", payload: { tier: "Gold", reason_code: "other", reason: "x", expires_at: "2026-09-01T00:00:00Z" } })] });
  eq("an expired override is not applied", r.override, null);
  eq("...silently (expiry is expected)", r.notes, []);
}
{
  const r = run({ override_rows: [overrideRow({ expires_at: "2026-09-09T00:00:00Z" })] });
  eq("an override expiring exactly at as_of is still live", r.override?.tier, "Gold");
}
{
  const r = run({ override_rows: [overrideRow({ expires_at: null, payload: { tier: "Gold", reason_code: "other", reason: "x" } })] });
  eq("a never-expiring override applies with expires_at null", [r.override?.tier, r.override?.expires_at], ["Gold", null]);
}
{
  const r = run({
    override_rows: [
      overrideRow({ created_at: "2026-09-06T00:00:00Z", expires_at: "2026-09-02T00:00:00Z", payload: { tier: "Platinum", reason_code: "other", reason: "expired newer" } }),
      overrideRow({ created_at: "2026-09-03T00:00:00Z", expires_at: null, payload: { tier: "Silver", reason_code: "conflict", reason: "live older" } }),
    ],
  });
  eq("an expired newer row does not shadow a live older one", [r.override?.tier, r.override?.reason_code], ["Silver", "conflict"]);
}
{
  const r = run({ override_rows: [overrideRow({ payload: { tier: "Diamond", reason_code: "other", reason: "x" } })] });
  eq("an unknown tier is not applied", r.override, null);
  check("...and noted", r.notes.length === 1 && r.notes[0].includes("Diamond"));
}
{
  const r = run({ override_rows: [overrideRow({ payload: { tier: "Gold", reason: "no code" }, reason_code: null })] });
  eq("a missing reason_code is not applied", r.override, null);
  check("...and noted", r.notes.length === 1 && r.notes[0].includes("reason_code"));
}
{
  const r = run({ override_rows: [overrideRow({ payload: { tier: "Gold", reason: "code on the row" }, reason_code: "timing_known", text: "Row text" })] });
  eq("reason_code falls back to the register column", r.override?.reason_code, "timing_known");
  eq("reason comes from payload.reason when present", r.override?.reason, "code on the row");
}
{
  const r = run({ override_rows: [overrideRow({ payload: { tier: "Gold", reason_code: "other" }, text: "Row text" })] });
  eq("reason falls back to the register text", r.override?.reason, "Row text");
}

/* ------------------------------------------------------------------ *
 * 6 · Determinism and shape
 * ------------------------------------------------------------------ */
{
  const input: ResolveInput = {
    account: ACCOUNT,
    facts: [factRow("headcount", 18, { evidence_label: "evidence" }), factRow("icp_class", "ICP-1"), factRow("climb_signals", ["multi_thread"])],
    signals: [signalRow("quote_sent", { source: "orbit" }), signalRow("prior_grade", { source: "gotham", payload: { value: "B" } })],
    deals: [dealRow(1), dealRow(2, { is_cj: true })],
    override_rows: [overrideRow()],
    as_of: AS_OF,
    rubric: RUBRIC,
  };
  const a = JSON.stringify(resolveFeatures(input));
  const b = JSON.stringify(resolveFeatures(input));
  eq("resolveFeatures is deterministic", a, b);
  const r = resolveFeatures(input);
  eq("as_of is passed through untouched", r.features.as_of, AS_OF);
  const shuffled: ResolveInput = { ...input, facts: [...input.facts].reverse(), signals: [...input.signals].reverse(), deals: [...input.deals].reverse() };
  eq("input order does not change the result", JSON.stringify(resolveFeatures(shuffled)), a);
  const keys = Object.keys(r.features);
  check("every ProspectFeatures key is present on the output", [
    "account_id", "name", "as_of", "relationship_type", "roster_source", "roster_certified", "lineage", "icp_class", "icp_class_label",
    "is_agency", "agency_type", "headcount", "headcount_label", "revenue_band", "vertical_depth", "wl_signal", "service_shape", "economics",
    "deal_size_estimate", "hourly_rate_accepted", "broker_character", "referral_from_network", "icp4_vertical_proven", "recurring_revenue_share",
    "niche_positioning", "am_pm_separated", "platform_partner_badge", "peer_network_member", "ai_posture", "avg_project_size", "already_outsources",
    "owner_does_everything", "inhouse_dev_team", "dev_archetype", "shrinking", "money", "authority", "specification", "timing", "timing_state",
    "archetype", "serviceable_share", "n_vendors", "our_rank", "trailing_12m_revenue", "quote_amount", "stated_ceiling", "climb_signals",
    "signals", "deals", "prior_grades",
  ].every((k) => keys.includes(k)));
  check("no undefined leaks into the features (every value is JSON-stable)", Object.values(r.features).every((v) => v !== undefined));
}
{
  const r = run({ as_of: "garbage" });
  check("an unparseable as_of is noted and nothing is dropped on it", r.notes.some((n) => n.startsWith("as_of")));
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`resolve_features_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("resolve_features_test failed");
  }
} else {
  console.log(`resolve_features_test: ${passed} checks passed`);
}
