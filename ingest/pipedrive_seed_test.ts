/**
 * WLIQ Prospect Book — Pipedrive roster seed tests.
 *
 * Run:  node --experimental-strip-types ingest/pipedrive_seed_test.ts
 *   or: deno run ingest/pipedrive_seed_test.ts
 *
 * Every organisation, card, deal and person here is synthetic. Agency names are invented;
 * people appear only as roles. Record shapes mirror the Pipedrive v2 API with
 * include_option_labels=true (enum values as {id, label}), plus the bare-string form.
 */

import {
  classifyAgencyType,
  isDecisionMakerTitle,
  mapPipedriveRoster,
  midpointFromRange,
  parseBudgetText,
  PipedriveKeys,
  SIGNAL_TYPES,
} from "./pipedrive_seed.ts";
import type { PipedriveActivity, PipedriveDeal, PipedriveOrg, PipedrivePerson, PipedriveRosterResult, PipedriveStage, RosterFact } from "./pipedrive_seed.ts";

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

/* ------------------------------------------------------------------ *
 * Fixture: the shape of core/rubric.prospect.v0.1.json's signal catalog (the entries this
 * mapper reads). verbally_accepted, pa_sent and quote_lost are deliberately absent, as in v0.1.
 * ------------------------------------------------------------------ */

const RUBRIC = {
  version: "0.1.0",
  signals: {
    catalog: {
      referral_warm_intro: { weight: 10, lifespan_days: 90, decays: true },
      quote_sent: { weight: 8, lifespan_days: 30, decays: true },
      orbit_verbally_accepted: { weight: 8, lifespan_days: 30, decays: true },
      orbit_pa_sent: { weight: 8, lifespan_days: 30, decays: true },
      inbound_reply: { weight: 6, lifespan_days: 14, decays: true },
      neg_dark_21_days: { weight: -6, lifespan_days: 90, decays: false },
      prior_grade: { weight: 0, lifespan_days: null, decays: false },
    },
  },
};

const STAGES: PipedriveStage[] = [
  { id: 1, name: "Refine/Discussion", pipeline_id: 1 },
  { id: 4, name: "PA sent", pipeline_id: 1 },
  { id: 11, name: "Discovery", pipeline_id: 1 },
  { id: 12, name: "Quoted", pipeline_id: 1 },
  { id: 46, name: "On Hold", pipeline_id: 1 },
  { id: 68, name: "Unresponsive (30 Days)", pipeline_id: 1 },
  { id: 72, name: "Verbally Accepted", pipeline_id: 1 },
  { id: 57, name: "New", pipeline_id: 9 },
  { id: 58, name: "Schedule Sales Call", pipeline_id: 9 },
  { id: 59, name: "Sales Call Done", pipeline_id: 9 },
  { id: 63, name: "Active Client", pipeline_id: 9 },
  { id: 64, name: "Inactive Client", pipeline_id: 9 },
  { id: 65, name: "Past Client", pipeline_id: 9 },
  { id: 66, name: "Unqualified/DNC", pipeline_id: 9 },
  { id: 67, name: "Lost Client", pipeline_id: 9 },
  { id: 69, name: "Friends of WLIQ", pipeline_id: 9 },
  { id: 70, name: "Quoting", pipeline_id: 9 },
  { id: 71, name: "Quote Lost", pipeline_id: 9 },
];

const D = PipedriveKeys.deal;
const O = PipedriveKeys.org;
const AS_OF = "2026-09-09";

function org(id: number, name: string, extra: Partial<PipedriveOrg> = {}, custom: Record<string, unknown> = {}): PipedriveOrg {
  return { id, name, website: null, linkedin: null, employee_count: null, industry: 14, owner_id: 1, add_time: "2025-01-10T10:00:00Z", update_time: "2026-08-30T12:00:00Z", custom_fields: custom, ...extra };
}

function card(id: number, org_id: number | null, stage_id: number, extra: Partial<PipedriveDeal> = {}, custom: Record<string, unknown> = {}): PipedriveDeal {
  return {
    id,
    title: `CJ - org ${org_id ?? "none"}`,
    value: 0,
    currency: "USD",
    person_id: null,
    org_id,
    stage_id,
    pipeline_id: 9,
    status: "open",
    add_time: "2026-05-01T09:00:00Z",
    update_time: "2026-09-01T09:00:00Z",
    stage_change_time: "2026-08-15T09:00:00Z",
    expected_close_date: null,
    won_time: null,
    lost_time: null,
    lost_reason: null,
    owner_id: 22,
    custom_fields: custom,
    ...extra,
  };
}

function deal(id: number, org_id: number, stage_id: number, extra: Partial<PipedriveDeal> = {}, custom: Record<string, unknown> = {}): PipedriveDeal {
  return {
    id,
    title: `Project ${id}`,
    value: 0,
    currency: "USD",
    person_id: null,
    org_id,
    stage_id,
    pipeline_id: 1,
    status: "open",
    add_time: "2026-07-01T09:00:00Z",
    update_time: "2026-08-25T09:00:00Z",
    stage_change_time: "2026-08-20T09:00:00Z",
    expected_close_date: "2026-10-01",
    won_time: null,
    lost_time: null,
    lost_reason: null,
    owner_id: 33,
    custom_fields: custom,
    ...extra,
  };
}

const ORGS: PipedriveOrg[] = [
  org(101, "Harbor & Pine Creative", { website: "https://www.harborpine.example.com/about" }, {
    [O.organization_type]: { id: 252, label: "Agency" },
    [O.employee_range]: { id: 302, label: "11-50" },
    [O.industry_category]: { id: 401, label: "Marketing & Advertising" },
    [O.services_offered]: "Digital marketing, Web design & development, SEO",
    [O.industries_served]: "B2B, Manufacturing",
    [O.notion_link]: "https://www.notion.so/research/harbor-pine",
  }),
  org(102, "Old Partner Studio", {}, { [O.organization_type]: { id: 252, label: "Agency" } }),
  org(103, "Friendly Folks Co", {}, { [O.organization_type]: { id: 252, label: "Agency" } }),
  org(104, "Bluewater Collective", { employee_count: 12 }, { [O.organization_type]: { id: 253, label: "Direct Client" } }),
  org(105, "Northfield Digital", { website: "northfield.example" }, { [O.organization_type]: "Agency", [O.specialties]: "Boutique brand studio" }),
  org(106, "Quiet Harbor Consulting", {}, { [O.organization_type]: { id: 252, label: "Agency" }, [O.specialties]: "Fractional CMO for founders" }),
  org(107, "White Label IQ", {}, {}),
  org(109, "Sunrise Studio", {}, { [O.organization_type]: { id: 252, label: "Agency" } }),
  org(110, "TBD", {}, {}),
  org(111, "TBD", {}, {}),
  org(112, "Peak Performance Partners", {}, {
    [O.organization_type]: { id: 252, label: "Agency" },
    [O.employee_range]: { id: 306, label: "250+" },
    [O.industry_category]: { id: 402, label: "Digital Marketing" },
    [O.email]: "hello@peakperf.example.org",
  }),
];

const CJ: PipedriveDeal[] = [
  card(9001, 101, 70, { person_id: 701, add_time: "2026-06-02T14:00:00Z", update_time: "2026-09-02T10:00:00Z" }, {
    [D.grade]: { id: 414, label: "High" },
    [D.icp_class]: { id: 370, label: "ICP-2: Ambitious Growing Agency" },
    [D.lead_temperature]: { id: 380, label: "Hot" },
    [D.lead_source]: "AMI/BABA",
    [D.stated_budget]: "$10-20K",
    [D.services_of_interest]: [{ id: 1, label: "Web/WordPress" }, { id: 2, label: "AI" }],
    [D.inbound_inquiry]: "We need a development partner for overflow.",
    [D.salesperson]: { id: 465, label: "Sales Lead" },
    [D.client_stage]: { id: 478, label: "New" },
    [D.clientiq_url]: "https://clientiq.example.com/journey/abc",
    [D.status_summary]: "Quote in review; follow up next week.",
  }),
  card(9002, 102, 63),
  card(9003, 103, 69),
  card(9005, 105, 66, {}, {
    [D.grade]: "Low",
    [D.icp_class]: "ICP-3: Lean Boutique Operator",
    [D.lead_temperature]: "Cold",
    [D.lead_source]: "Contact Us",
    [D.services_of_interest]: ["SEO"],
  }),
  card(9006, 106, 71, { stage_change_time: "2026-08-10T09:00:00Z" }, {
    [D.lead_temperature]: { id: 381, label: "Warm" },
    [D.lost_reason]: { id: 333, label: "Price / Budget" },
    [D.icp_class]: { id: 372, label: "ICP-5: Strategic Consultant" },
  }),
  card(9007, 107, 58),
  card(9008, 999, 58),
  card(9009, 109, 57, { update_time: "2026-09-12T08:00:00Z", add_time: "2026-09-11T08:00:00Z" }, {
    [D.grade]: { id: 414, label: "High" },
    [D.lead_temperature]: { id: 379, label: "Super Hot" },
  }),
  card(9010, 109, 66, { status: "lost", update_time: "2026-09-13T08:00:00Z" }),
  card(9011, 110, 58),
  card(9012, 111, 58),
  card(9013, 112, 59, {}, { [D.lead_temperature]: { id: 381, label: "Warm" } }),
  card(9014, null, 58),
];

const P1: PipedriveDeal[] = [
  deal(5001, 101, 12, { value: 12000, person_id: 701, expected_close_date: "2026-10-15" }, { [D.lead_source]: "Website Contact Form" }),
  deal(5002, 102, 11, { value: 3000 }),
  deal(5003, 104, 72, { value: 8000, stage_change_time: null, add_time: "2026-07-01T09:00:00Z", person_id: 703 }, {
    [D.grade]: { id: 415, label: "Medium" },
    [D.icp_class]: { id: 377, label: "Unclassified (Insufficient Data)" },
  }),
  deal(5004, 112, 68, { value: 0, update_time: "2026-08-01T09:00:00Z" }),
  deal(5005, 112, 4, { value: 20000, update_time: "2026-08-28T09:00:00Z", stage_change_time: "2026-08-27T09:00:00Z" }),
  deal(5006, 112, 46, { value: 5000, update_time: "2026-08-10T09:00:00Z" }),
  deal(5007, 101, 11, { value: 2500, status: "lost", lost_time: "2026-06-01T09:00:00Z" }),
];

const PERSONS: PipedrivePerson[] = [
  { id: 701, name: "Ops Director", first_name: "Ops", last_name: "Director", job_title: "Director of Operations", org_id: 101, update_time: "2026-08-01T09:00:00Z", emails: [{ label: "work", value: "ops@harborpine.example.com", primary: true }, { label: "other", value: "personal@gmail.com", primary: false }] },
  { id: 702, name: "Account Coordinator", job_title: "Account Coordinator", org_id: 101, emails: ["coord@harborpine.example.com"] },
  { id: 703, name: "Owner", job_title: "Owner", org_id: 104, emails: [] },
  { id: 704, name: "Untitled Contact", job_title: null, org_id: 112, emails: [{ value: "someone@gmail.com", primary: true }] },
  { id: 705, name: "Studio Head", job_title: "Founder", org_id: null, emails: [] },
];

const ACTIVITIES: PipedriveActivity[] = [
  { id: 1, type: "meeting", done: true, due_date: "2026-08-15", due_time: "14:00", deal_id: 5001 },
  { id: 2, type: "meeting", done: false, due_date: "2026-09-20", due_time: "10:00", deal_id: 5001 },
  { id: 3, type: "call", done: false, due_date: "2026-09-25", due_time: null, deal_id: 5001 },
  { id: 4, type: "meeting", done: false, due_date: "2026-08-01", due_time: "10:00", deal_id: 5001 },
  { id: 5, type: "email", done: false, due_date: "2026-09-10", due_time: null, deal_id: 5001 },
  { id: 6, type: "meeting", done: false, due_date: "2026-10-01", due_time: null, deal_id: 5005 },
];

function run(overrides: Partial<Parameters<typeof mapPipedriveRoster>[0]> = {}): PipedriveRosterResult {
  return mapPipedriveRoster({
    orgs: ORGS,
    cj_deals: CJ,
    p1_deals: P1,
    persons: { persons: PERSONS, org_persons_index: { "112": [704] } },
    activities: { activities: ACTIVITIES },
    stages: { success: true, data: STAGES },
    rubric: RUBRIC,
    opts: { as_of: AS_OF },
    ...overrides,
  });
}

const R = run();
const factsOf = (key: string, fkey?: string): RosterFact[] => R.facts.filter((f) => f.account_key === key && (fkey === undefined || f.key === fkey));
const fact = (key: string, fkey: string): RosterFact | undefined => factsOf(key, fkey)[0];
const signalsOf = (key: string) => R.signals.filter((s) => s.account_key === key);
const acct = (key: string) => R.accounts.find((a) => a.account_key === key);

/* ------------------------------------------------------------------ *
 * 1 · Roster membership
 * ------------------------------------------------------------------ */

eq("roster is the prospect-stage cards plus pipeline-1-only orgs", R.accounts.map((a) => a.account_key), [
  "harbor and pine creative",
  "bluewater collective",
  "northfield digital",
  "quiet harbor consulting",
  "sunrise studio",
  "tbd",
  "tbd pipedrive-111",
  "peak performance partners",
]);
check("every account is certified Pipedrive roster", R.accounts.every((a) => a.roster_source === "pipedrive" && a.roster_certified === true && a.key === a.account_key));
eq("an Active Client org with an open deal is skipped (PRO-10)", R.skipped.find((s) => s.org_id === 102)?.reason, "CJ client stage: Active Client");
check("...and none of its deals become pb_deals rows", !R.deals.some((d) => d.pipedrive_deal_id === 5002));
eq("a Friends-of-WLIQ org is skipped", R.skipped.find((s) => s.org_id === 103)?.reason, "Friends of WLIQ");
eq("the internal organisation is skipped", R.skipped.find((s) => s.org_id === 107)?.reason, "internal organisation");
eq("a card whose org is missing from the pull is skipped", R.skipped.find((s) => s.org_id === 999)?.reason, "org not in pull");
eq("a card with no org is skipped", R.skipped.find((s) => s.cj_deal_id === 9014)?.reason, "no org on card");
eq("skipped rows carry the card id for the run log", R.skipped.find((s) => s.org_id === 102)?.cj_deal_id, 9002);
eq("a pipeline-1-only org is included with the flag", acct("bluewater collective")?.flags, ["No CJ card"]);
eq("stage 66 lands in the parked book", acct("northfield digital")?.book, "parked");
eq("...with the parked flag", acct("northfield digital")?.flags, ["Parked: Unqualified/DNC"]);
eq("a Quoting org is a prospect", acct("harbor and pine creative")?.book, "prospect");
eq("two orgs with the same name key both stay, the second disambiguated", acct("tbd pipedrive-111")?.flags, ["Duplicate name key"]);
eq("with several cards, the OPEN one rules even when the lost one is newer", R.cj_index["sunrise studio"]?.cj_deal_id, 9009);
check("summary notes mention the several-cards case", R.summary.notes.some((n) => /several Client Journey cards/.test(n)));

/* ------------------------------------------------------------------ *
 * 2 · The account row
 * ------------------------------------------------------------------ */

const harbor = acct("harbor and pine creative");
eq("domain from the website", harbor?.domain, "harborpine.example.com");
eq("pipedrive_org_id carried", harbor?.pipedrive_org_id, 101);
eq("relationship type from the org type", harbor?.relationship_type, "agency");
eq("Direct Client → direct", acct("bluewater collective")?.relationship_type, "direct");
eq("domain falls back to the org email field", acct("peak performance partners")?.domain, "peakperf.example.org");
eq("no website, no org email, no person email → domain null (gmail never counts)", acct("bluewater collective")?.domain, null);

/* ------------------------------------------------------------------ *
 * 3 · Facts — the Quoting org with an open Quoted deal
 * ------------------------------------------------------------------ */

const H = "harbor and pine creative";
eq("money present from the stated budget", fact(H, "money")?.value, "present");
check("...and the note says which", /stated budget/.test(fact(H, "money")?.note ?? ""), fact(H, "money")?.note);
eq("specification present from services of interest", fact(H, "specification")?.value, "present");
eq("authority present from a decision-maker title on a linked person", fact(H, "authority")?.value, "present");
check("authority evidence points at the person", /\/person\/701$/.test(fact(H, "authority")?.evidence_url ?? ""), fact(H, "authority")?.evidence_url ?? "");
eq("service_shape Core from services of interest", fact(H, "service_shape")?.value, "Core");
eq("icp_class from the label prefix", fact(H, "icp_class")?.value, "ICP-2");
eq("Hot → within_1_month", fact(H, "timing")?.value, "within_1_month");
eq("timing_state present when a timeline is stated", fact(H, "timing_state")?.value, "present");
eq("referral true on AMI/BABA", fact(H, "referral_from_network")?.value, true);
eq("headcount from the range midpoint", fact(H, "headcount")?.value, 30);
eq("...labelled inferred with the range note", [fact(H, "headcount")?.evidence_label, fact(H, "headcount")?.note], ["inferred", "Pipedrive organization 101 range midpoint of 11-50"]);
eq("agency_type digital_only from the services text", fact(H, "agency_type")?.value, "digital_only");
eq("deal_size_estimate parsed from the budget (midpoint)", [fact(H, "deal_size_estimate")?.value, fact(H, "deal_size_estimate")?.evidence_label], [15000, "inferred"]);
eq("is_agency true", fact(H, "is_agency")?.value, true);
eq("the CJ card id is kept for write-back", fact(H, "pipedrive_cj_deal_id")?.value, 9001);
eq("the CJ stage name is kept", fact(H, "pipedrive_cj_stage")?.value, "Quoting");
eq("services of interest kept as an array of labels", fact(H, "pipedrive_services_of_interest")?.value, ["Web/WordPress", "AI"]);
eq("card fields win over deal fields (lead source)", fact(H, "pipedrive_lead_source")?.value, "AMI/BABA");
eq("informational facts are kept only when non-empty", fact(H, "pipedrive_account_manager"), undefined);
eq("economics is never emitted", R.facts.filter((f) => f.key === "economics").length, 0);
check("every fact carries the source, entered_by, an evidence URL and a date", R.facts.every((f) => f.source === "pipedrive" && f.entered_by === "system:pipedrive" && typeof f.evidence_url === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.observed_at ?? "")));
eq("card-derived facts date from the card's update_time", fact(H, "icp_class")?.observed_at, "2026-09-02");
eq("org-derived facts date from the org's update_time", fact(H, "headcount")?.observed_at, "2026-08-30");
check("evidence URLs use the default base", (fact(H, "icp_class")?.evidence_url ?? "").startsWith("https://app.pipedrive.com/deal/9001"));

/* ------------------------------------------------------------------ *
 * 4 · Facts — the other rows
 * ------------------------------------------------------------------ */

const B = "bluewater collective";
eq("ICP 'Unclassified' emits no icp_class fact", fact(B, "icp_class"), undefined);
eq("std employee_count > 0 is inferred (CRM-entered, not a primary record)", [fact(B, "headcount")?.value, fact(B, "headcount")?.evidence_label], [12, "inferred"]);
eq("Direct Client → agency_type direct_end_client", fact(B, "agency_type")?.value, "direct_end_client");
eq("Direct Client → is_agency false", fact(B, "is_agency")?.value, false);
check("money present from an open deal with value, note says so", fact(B, "money")?.value === "present" && /value 8000/.test(fact(B, "money")?.note ?? ""), fact(B, "money")?.note);
check("specification present from a deal at Verbally Accepted", fact(B, "specification")?.value === "present" && /Verbally Accepted/.test(fact(B, "specification")?.note ?? ""));
eq("deal_size_estimate from the largest deal value is evidence", [fact(B, "deal_size_estimate")?.value, fact(B, "deal_size_estimate")?.evidence_label], [8000, "evidence"]);
eq("no card → no cj_index entry", R.cj_index[B], undefined);
eq("referral omitted when no lead source is filled", fact("quiet harbor consulting", "referral_from_network"), undefined);
eq("referral false when a source is filled and does not match", fact("northfield digital", "referral_from_network")?.value, false);
eq("Cold → no_timeline", fact("northfield digital", "timing")?.value, "no_timeline");
eq("...and timing_state absent (Cold is 'no timeline', not a date)", fact("northfield digital", "timing_state")?.value, "absent");
eq("Warm → within_3_months", fact("quiet harbor consulting", "timing")?.value, "within_3_months");
eq("Super Hot → within_1_week", fact("sunrise studio", "timing")?.value, "within_1_week");
eq("enum values as bare strings are read (ICP)", fact("northfield digital", "icp_class")?.value, "ICP-3");
eq("multi-enum as bare strings is read (services)", fact("northfield digital", "pipedrive_services_of_interest")?.value, ["SEO"]);
eq("agency_type consultancy from specialties", fact("quiet harbor consulting", "agency_type")?.value, "consultancy");
eq("agency_type boutique from specialties", fact("northfield digital", "agency_type")?.value, "boutique");
eq("lost reason kept from the picklist label", fact("quiet harbor consulting", "pipedrive_lost_reason")?.value, "Price / Budget");
eq("250+ → 300", fact("peak performance partners", "headcount")?.value, 300);
eq("largest open deal value wins for deal_size_estimate", fact("peak performance partners", "deal_size_estimate")?.value, 20000);
eq("no authority fact without a decision-maker title", fact("peak performance partners", "authority"), undefined);

/* ------------------------------------------------------------------ *
 * 5 · Signals
 * ------------------------------------------------------------------ */

const catalogTypes = new Set(Object.keys(RUBRIC.signals.catalog));
check("every emitted signal type exists in the rubric catalog", R.signals.every((s) => catalogTypes.has(s.type)), [...new Set(R.signals.map((s) => s.type))].join(","));
check("every requested type is in the catalog or names a documented fallback", Object.keys(SIGNAL_TYPES).every((t) => catalogTypes.has(t) || SIGNAL_TYPES[t].fallback === null || catalogTypes.has(SIGNAL_TYPES[t].fallback as string)));
check("weights, lifespans and decay come from the catalog", R.signals.every((s) => {
  const c = (RUBRIC.signals.catalog as Record<string, { weight: number; lifespan_days: number | null; decays: boolean }>)[s.type];
  return c.weight === s.weight && c.lifespan_days === s.lifespan_days && c.decays === s.decays;
}));
const cutoff = Date.parse(AS_OF + "T23:59:59.999Z");
check("no signal is observed after as_of", R.signals.every((s) => Date.parse(s.observed_at) <= cutoff));
eq("a card updated after as_of yields no signals", signalsOf("sunrise studio").length, 0);
check("...and the drop is noted", R.summary.notes.some((n) => /dropped: observed_at after as_of/.test(n)));
eq("prior_grade from the Grade label", signalsOf(H).find((s) => s.type === "prior_grade" && s.payload.field === "Grade")?.payload, { field: "Grade", value: "High", deal_id: 9001 });
eq("prior_grade from the Lead temperature label", signalsOf(H).find((s) => s.type === "prior_grade" && s.payload.field === "Lead temperature")?.payload.value, "Hot");
eq("Grade as a bare string still yields a prior_grade", signalsOf("northfield digital").find((s) => s.payload.field === "Grade")?.payload.value, "Low");
const quoteSent = signalsOf(H).find((s) => s.type === "quote_sent");
eq("open deal at Quoted → quote_sent at stage_change_time", quoteSent?.observed_at, "2026-08-20T09:00:00.000Z");
eq("...with the deal payload", quoteSent?.payload, { deal_id: 5001, title: "Project 5001", value: 12000, stage: "Quoted" });
eq("stage 72 → orbit_verbally_accepted (fallback), requested type recorded", signalsOf(B).find((s) => s.type === "orbit_verbally_accepted")?.payload.requested_type, "verbally_accepted");
eq("...observed at add_time when stage_change_time is empty", signalsOf(B).find((s) => s.type === "orbit_verbally_accepted")?.observed_at, "2026-07-01T09:00:00.000Z");
eq("stage 4 → orbit_pa_sent (fallback)", signalsOf("peak performance partners").filter((s) => s.type === "orbit_pa_sent").length, 1);
eq("stage 68 → neg_dark_21_days", signalsOf("peak performance partners").filter((s) => s.type === "neg_dark_21_days").length, 1);
eq("stage 46 On Hold yields no signal", signalsOf("peak performance partners").filter((s) => s.payload.deal_id === 5006).length, 0);
eq("Quote Lost → quote_lost is skipped (not in catalog)", signalsOf("quiet harbor consulting").filter((s) => s.type !== "prior_grade").length, 0);
check("...with a note", R.summary.notes.some((n) => /'quote_lost' is not in the rubric catalog/.test(n)));
const referral = signalsOf(H).find((s) => s.type === "referral_warm_intro");
eq("referral match → referral_warm_intro at the card's add_time", referral?.observed_at, "2026-06-02T14:00:00.000Z");
const inbound = signalsOf(H).find((s) => s.type === "inbound_reply");
eq("inbound inquiry → inbound_reply at add_time, body not copied", [inbound?.observed_at, inbound?.payload.chars, "text" in (inbound?.payload ?? {})], ["2026-06-02T14:00:00.000Z", 43, false]);
eq("a prior_grade from a pipeline-1 deal on a card-less org", signalsOf(B).find((s) => s.type === "prior_grade")?.payload, { field: "Grade", value: "Medium", deal_id: 5003 });
check("every signal carries source, entered_by and an evidence URL", R.signals.every((s) => s.source === "pipedrive" && s.entered_by === "system:pipedrive" && /\/deal\/\d+$/.test(s.evidence_url ?? "")));

/* ------------------------------------------------------------------ *
 * 6 · Contacts
 * ------------------------------------------------------------------ */

const hc = R.contacts.filter((c) => c.account_key === H);
eq("contacts for every person on the org", hc.map((c) => c.pipedrive_person_id), [701, 702]);
eq("primary email object is read", hc[0]?.email, "ops@harborpine.example.com");
eq("emails as bare strings are read", hc[1]?.email, "coord@harborpine.example.com");
eq("decision maker via the title regex", hc.map((c) => c.is_decision_maker), [true, false]);
eq("no title → is_decision_maker null", R.contacts.find((c) => c.pipedrive_person_id === 704)?.is_decision_maker, null);
eq("org_persons_index brings in a person under the org", R.contacts.find((c) => c.pipedrive_person_id === 704)?.account_key, "peak performance partners");
check("a person on no roster org is not a contact", !R.contacts.some((c) => c.pipedrive_person_id === 705));
eq("contact count in the summary", R.summary.contacts, R.contacts.length);

/* ------------------------------------------------------------------ *
 * 7 · pb_deals rows
 * ------------------------------------------------------------------ */

const hd = R.deals.find((d) => d.pipedrive_deal_id === 5001);
eq("an open pipeline-1 deal of a roster org becomes a pb_deals row", hd?.account_key, H);
eq("stage name from the stages list", hd?.stage_name, "Quoted");
eq("stage_entered_at from stage_change_time", hd?.stage_entered_at, "2026-08-20T09:00:00.000Z");
eq("next_meeting_at is the earliest not-done meeting/call on or after as_of", hd?.next_meeting_at, "2026-09-20T10:00:00.000Z");
eq("calls_held counts done meetings/calls", hd?.calls_held, 1);
eq("close date, value, currency, owner, status", [hd?.close_date, hd?.value, hd?.currency, hd?.owner_user_id, hd?.status, hd?.is_cj, hd?.close_date_pushes], ["2026-10-15", 12000, "USD", 33, "open", false, []]);
eq("raw carries the labelled custom fields and the grade label", hd?.raw, { custom_fields_labelled: { lead_source: "Website Contact Form" }, grade_label: null });
eq("a lost pipeline-1 deal is not a row", R.deals.find((d) => d.pipedrive_deal_id === 5007), undefined);
eq("stage_entered_at falls back to add_time when never moved", R.deals.find((d) => d.pipedrive_deal_id === 5003)?.stage_entered_at, "2026-07-01T09:00:00.000Z");
eq("calls_held null when nothing is known", R.deals.find((d) => d.pipedrive_deal_id === 5005)?.calls_held, null);
eq("a date-only due_date reads as midnight UTC", R.deals.find((d) => d.pipedrive_deal_id === 5005)?.next_meeting_at, "2026-10-01T00:00:00.000Z");
eq("three deals for the three-deal org", R.deals.filter((d) => d.account_key === "peak performance partners").length, 3);
eq("cj_index entry for write-back", R.cj_index[H], { cj_deal_id: 9001, stage_id: 70, stage_name: "Quoting", org_id: 101 });

/* ------------------------------------------------------------------ *
 * 8 · Summary and options
 * ------------------------------------------------------------------ */

eq("summary counts the roster", R.summary.roster_orgs, 8);
eq("summary counts by CJ stage", R.summary.by_cj_stage, { Quoting: 1, "Unqualified/DNC": 1, "Quote Lost": 1, New: 1, "Schedule Sales Call": 2, "Sales Call Done": 1 });
eq("summary counts parked and pipeline-1-only", [R.summary.parked, R.summary.p1_only], [1, 1]);
eq("summary counts skipped by reason", R.summary.skipped_by_reason, { "no org on card": 1, "CJ client stage: Active Client": 1, "Friends of WLIQ": 1, "internal organisation": 1, "org not in pull": 1 });
check("summary counts facts and signals by key/type", R.summary.facts_by_key.money === 3 && R.summary.signals_by_type.quote_sent === 1, JSON.stringify(R.summary.facts_by_key));
eq("no money fact is invented for an org with neither budget nor deal", fact("northfield digital", "money"), undefined);
check("mapPipedriveRoster is deterministic", JSON.stringify(run()) === JSON.stringify(R));
{
  const r2 = run({ opts: { as_of: AS_OF, entered_by: "system:pipedrive-nightly", base_url: "https://whitelabeliq.pipedrive.com/", internal_org_names: [] } });
  check("entered_by option is honoured", r2.facts.every((f) => f.entered_by === "system:pipedrive-nightly"));
  check("base_url option is honoured (trailing slash trimmed)", r2.facts.every((f) => (f.evidence_url ?? "").startsWith("https://whitelabeliq.pipedrive.com/")));
  check("an empty internal list rosters the internal org", r2.accounts.some((a) => a.pipedrive_org_id === 107));
}
{
  const cj2 = CJ.map((c) => c.id === 9001 ? { ...c, custom_fields: { ...(c.custom_fields ?? {}), custom_grade_key: { id: 9, label: "Medium" } } } : c);
  const r3 = run({ cj_deals: cj2, opts: { as_of: AS_OF, keys: { deal: { grade: "custom_grade_key" } } } });
  eq("a key override redirects the field read", r3.signals.find((s) => s.account_key === H && s.payload.field === "Grade")?.payload.value, "Medium");
}
{
  const r4 = run({ stages: STAGES, persons: PERSONS, activities: ACTIVITIES });
  eq("bare arrays for stages, persons and activities are accepted", [r4.deals[0]?.stage_name, r4.contacts.length, r4.deals[0]?.calls_held], ["Quoted", R.contacts.length, 1]);
}
{
  let threw = false;
  try {
    run({ opts: { as_of: "" } });
  } catch {
    threw = true;
  }
  check("as_of is required", threw);
}
{
  const empty = mapPipedriveRoster({ orgs: [], cj_deals: [], p1_deals: [], persons: [], activities: [], stages: [], rubric: RUBRIC, opts: { as_of: AS_OF } });
  eq("an empty pull yields an empty roster", [empty.accounts.length, empty.skipped.length], [0, 0]);
}

/* ------------------------------------------------------------------ *
 * 9 · Exported helpers
 * ------------------------------------------------------------------ */

eq("parseBudgetText: $10-20K → 15000", parseBudgetText("$10-20K"), 15000);
eq("parseBudgetText: <$1K → 500", parseBudgetText("<$1K"), 500);
eq("parseBudgetText: $5,000 → 5000", parseBudgetText("$5,000"), 5000);
eq("parseBudgetText: 10k+ → 10000", parseBudgetText("10k+"), 10000);
eq("parseBudgetText: en-dash range with k on both ends", parseBudgetText("$10k–$25k"), 17500);
eq("parseBudgetText: thousands separators in a range", parseBudgetText("5,220 - 6,000"), 5610);
eq("parseBudgetText: a labelled figure with cents", parseBudgetText("Base Project: $23,080.00"), 23080);
eq("parseBudgetText: a range followed by an extra", parseBudgetText("12,000-14,000 plus $3100 for design"), 13000);
eq("parseBudgetText: a small count before the price is skipped", parseBudgetText("2 sites for $5000"), 5000);
eq("parseBudgetText: URLs are ignored", parseBudgetText("Options: https://docs.example.com/d/1NCgd9chphMlQ"), null);
eq("parseBudgetText: words only → null", parseBudgetText("Complimentary audit"), null);
eq("parseBudgetText: empty → null", [parseBudgetText(""), parseBudgetText(null), parseBudgetText(undefined)], [null, null, null]);
eq("midpointFromRange picklist", ["1", "2-10", "11-50", "51-100", "101-250", "250+"].map(midpointFromRange), [1, 6, 30, 75, 175, 300]);
eq("midpointFromRange accepts the {id,label} form", midpointFromRange({ id: 302, label: "11-50" }), 30);
eq("midpointFromRange rejects nonsense", [midpointFromRange("many"), midpointFromRange(null)], [null, null]);
eq("classifyAgencyType precedence", [
  classifyAgencyType(["Full-service digital agency"]),
  classifyAgencyType(["Management Consulting"]),
  classifyAgencyType(["Niche Vertical Specialist"]),
  classifyAgencyType(["Digital Marketing, Web Design"]),
  classifyAgencyType(["Design & Creative Services"]),
  classifyAgencyType(["Marketing & Advertising"]),
  classifyAgencyType([null, undefined, ""]),
], ["full_service", "consultancy", "niche_vertical", "digital_only", "boutique", null, null]);
eq("isDecisionMakerTitle", [
  isDecisionMakerTitle("Founder & CEO"),
  isDecisionMakerTitle("President"),
  isDecisionMakerTitle("Managing Director"),
  isDecisionMakerTitle("Chief Operating Officer"),
  isDecisionMakerTitle("COO"),
  isDecisionMakerTitle("Account Executive"),
  isDecisionMakerTitle("Coordinator"),
  isDecisionMakerTitle(""),
  isDecisionMakerTitle(null),
], [true, true, true, true, true, false, false, null, null]);

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`pipedrive_seed_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("pipedrive_seed_test failed");
  }
} else {
  console.log(`pipedrive_seed_test: ${passed} checks passed`);
}
