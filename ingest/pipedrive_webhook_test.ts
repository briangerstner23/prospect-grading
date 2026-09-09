/**
 * WLIQ Prospect Book — Pipedrive webhooks v2 parser tests.
 *
 * Run:  node --experimental-strip-types ingest/pipedrive_webhook_test.ts
 *   or: deno run ingest/pipedrive_webhook_test.ts
 *
 * Every payload here is synthetic: invented agencies, invented ids, invented field hashes.
 * The field map is passed in exactly as the handler would build it from /v2/dealFields —
 * no hash is a real one.
 */

import {
  isClientJourneyTitle,
  labelCustomFields,
  parsePipedriveEvent,
  primaryEmail,
  stripHtml,
  toIso,
} from "./pipedrive_webhook.ts";
import type { FieldMap, PipedriveV2Event } from "./pipedrive_webhook.ts";
import type { KnownAccount } from "./identity.ts";

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
 * Synthetic world
 * ------------------------------------------------------------------ */

const NOW = "2026-09-09T12:00:00.000Z";
const T0 = "2026-09-09T11:59:30.000Z";

const KNOWN: KnownAccount[] = [
  { id: "acc-harbor", key: "harbor and pine creative", name: "Harbor & Pine Creative", domain: "harborpine.example", pipedrive_org_id: 501, orbit_client_id: null },
  { id: "acc-lumen", key: "lumen studio", name: "Lumen Studio", domain: "lumenstudio.example", pipedrive_org_id: null, orbit_client_id: 77 },
  { id: "acc-north", key: "northfield digital", name: "Northfield Digital", domain: null, pipedrive_org_id: null, orbit_client_id: null },
];

const GRADE_HASH = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_HASH = "89abcdef0123456789abcdef0123456789abcdef";
const BUDGET_HASH = "fedcba9876543210fedcba9876543210fedcba98";
const SERVICES_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WEBSITE_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const FIELD_MAP: FieldMap = {
  deals: {
    [GRADE_HASH]: { label: "Grade", options: { "414": "A — chase now", "415": "B", "416": "C" } },
    [SOURCE_HASH]: { label: "Lead source", options: { "1": "Referral", "2": "Inbound", "3": "Event" } },
    [BUDGET_HASH]: { label: "Stated budget" },
    [SERVICES_HASH]: { label: "Services wanted", options: { "10": "Web build", "11": "SEO", "12": "Paid media" } },
  },
  organizations: {
    [WEBSITE_HASH]: { label: "Website" },
  },
  persons: {},
};

const RUBRIC = {
  signals: {
    catalog: {
      meeting_accepted: { weight: 6, lifespan_days: 14, decays: true },
      manual_note: { weight: 2, lifespan_days: 90, decays: true },
    },
  },
};

function evt(action: string, entity: string, data: Record<string, unknown> | null, previous?: Record<string, unknown> | null, metaExtra: Record<string, unknown> = {}): PipedriveV2Event {
  const id = data && data.id !== undefined ? data.id : metaExtra.entity_id ?? 0;
  return {
    meta: { action, entity, entity_id: String(id), company_id: "1", user_id: "9", timestamp: T0, version: "2.0", webhook_id: "wh-1", is_bulk_edit: false, change_source: "app", attempt: 1, ...metaExtra },
    data,
    previous: previous ?? undefined,
  };
}

const baseDeal = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7001,
  title: "Harbor & Pine — WordPress rebuild",
  org_id: 501,
  person_id: 9001,
  pipeline_id: 1,
  stage_id: 3,
  status: "open",
  value: 18500,
  currency: "USD",
  expected_close_date: "2026-10-15",
  owner_id: 42,
  add_time: "2026-09-01T09:00:00Z",
  update_time: "2026-09-09T11:59:30Z",
  stage_change_time: "2026-09-05T15:30:00Z",
  won_time: null,
  lost_time: null,
  custom_fields: { [GRADE_HASH]: 414, [SOURCE_HASH]: 1, [BUDGET_HASH]: "20k-30k", [SERVICES_HASH]: [10, 12] },
  ...o,
});

/* ------------------------------------------------------------------ *
 * 1 · Deals
 * ------------------------------------------------------------------ */

{
  const r = parsePipedriveEvent(evt("create", "deal", baseDeal()), FIELD_MAP, KNOWN, NOW);
  check("deal create: deal row present, nothing ignored", r.deal !== undefined && r.ignored === undefined, r.ignored);
  eq("deal create: id, title, pipeline, stage", [r.deal?.pipedrive_deal_id, r.deal?.title, r.deal?.pipeline_id, r.deal?.stage_id], [7001, "Harbor & Pine — WordPress rebuild", 1, 3]);
  eq("deal create: value, currency, status, close date, owner", [r.deal?.value, r.deal?.currency, r.deal?.status, r.deal?.close_date, r.deal?.owner_user_id], [18500, "USD", "open", "2026-10-15", 42]);
  eq("deal create: stage_entered_at is meta.timestamp", r.deal?.stage_entered_at, T0);
  eq("deal create: attaches the account by pipedrive_org_id", r.deal?.account_id, "acc-harbor");
  eq("deal create: no identity candidates when the org is known", r.candidates, []);
  eq("deal create: not a CJ card", r.deal?.is_cj, false);
  eq("deal create: no close-date push on create", r.deal?.close_date_push, null);
  eq("deal create: custom fields translated to labels", r.deal?.raw.custom_fields_labelled, {
    "Grade": "A — chase now",
    "Lead source": "Referral",
    "Stated budget": "20k-30k",
    "Services wanted": ["Web build", "Paid media"],
  });
  eq("deal create: grade_label surfaced", r.deal?.raw.grade_label, "A — chase now");
  eq("deal create: raw keeps Pipedrive's own fields", (r.deal?.raw as Record<string, unknown>).org_id, 501);
  eq("deal create: raw.webhook_meta carries action and timestamp", [(r.deal?.raw.webhook_meta as Record<string, unknown>).action, (r.deal?.raw.webhook_meta as Record<string, unknown>).timestamp], ["create", T0]);
  eq("deal create: won/lost null when null", [r.deal?.won_time, r.deal?.lost_time], [null, null]);
}

{
  // change with no stage change: stage_entered_at falls back to Pipedrive's stage_change_time
  const prev = baseDeal({ title: "Harbor & Pine — site rebuild" });
  const r = parsePipedriveEvent(evt("change", "deal", baseDeal(), prev), FIELD_MAP, KNOWN, NOW);
  eq("deal change (title only): stage_entered_at = stage_change_time", r.deal?.stage_entered_at, "2026-09-05T15:30:00.000Z");
  eq("deal change (title only): changed_keys lists title", r.deal?.raw.changed_keys, ["title"]);
  eq("deal change (title only): raw.previous holds only the changed key", r.deal?.raw.previous, { title: "Harbor & Pine — site rebuild" });
  eq("deal change (title only): no push", r.deal?.close_date_push, null);
}

{
  // change with a stage change → meta.timestamp
  const r = parsePipedriveEvent(evt("change", "deal", baseDeal({ stage_id: 4 }), baseDeal({ stage_id: 3 })), FIELD_MAP, KNOWN, NOW);
  eq("deal change (stage): stage_entered_at = meta.timestamp", r.deal?.stage_entered_at, T0);
  eq("deal change (stage): stage_id is the new stage", r.deal?.stage_id, 4);
}

{
  // v2 may send only the changed fields in previous
  const r = parsePipedriveEvent(evt("change", "deal", baseDeal({ stage_id: 4 }), { stage_id: 3 }), FIELD_MAP, KNOWN, NOW);
  eq("deal change (partial previous, stage changed): meta.timestamp", r.deal?.stage_entered_at, T0);
  const r2 = parsePipedriveEvent(evt("change", "deal", baseDeal(), { title: "old" }), FIELD_MAP, KNOWN, NOW);
  eq("deal change (partial previous, stage absent): stage_change_time, not asserted", r2.deal?.stage_entered_at, "2026-09-05T15:30:00.000Z");
  const r3 = parsePipedriveEvent(evt("change", "deal", baseDeal({ stage_change_time: null })), FIELD_MAP, KNOWN, NOW);
  eq("deal change (no previous, no stage_change_time): null = do not overwrite", r3.deal?.stage_entered_at, null);
}

{
  // close-date push
  const r = parsePipedriveEvent(evt("change", "deal", baseDeal({ expected_close_date: "2026-11-30" }), baseDeal({ expected_close_date: "2026-10-15" })), FIELD_MAP, KNOWN, NOW);
  eq("close date pushed: entry {from,to,at}", r.deal?.close_date_push, { from: "2026-10-15", to: "2026-11-30", at: T0 });
  eq("close date pushed: close_date is the new date", r.deal?.close_date, "2026-11-30");
  const pulled = parsePipedriveEvent(evt("change", "deal", baseDeal({ expected_close_date: "2026-10-01" }), baseDeal({ expected_close_date: "2026-10-15" })), FIELD_MAP, KNOWN, NOW);
  eq("close date pulled in is still recorded as a move", pulled.deal?.close_date_push, { from: "2026-10-15", to: "2026-10-01", at: T0 });
  const first = parsePipedriveEvent(evt("change", "deal", baseDeal({ expected_close_date: "2026-10-15" }), baseDeal({ expected_close_date: null })), FIELD_MAP, KNOWN, NOW);
  eq("first close date set is not a push", first.deal?.close_date_push, null);
  const cleared = parsePipedriveEvent(evt("change", "deal", baseDeal({ expected_close_date: null }), baseDeal({ expected_close_date: "2026-10-15" })), FIELD_MAP, KNOWN, NOW);
  eq("close date cleared is a push to null", cleared.deal?.close_date_push, { from: "2026-10-15", to: null, at: T0 });
  eq("close date cleared: close_date null", cleared.deal?.close_date, null);
  const same = parsePipedriveEvent(evt("change", "deal", baseDeal(), baseDeal({ value: 100 })), FIELD_MAP, KNOWN, NOW);
  eq("value change only: no push", same.deal?.close_date_push, null);
}

{
  // CJ cards upsert, flagged, never ignored
  const r = parsePipedriveEvent(evt("create", "deal", baseDeal({ title: "CJ: Harbor & Pine — onboarding" })), FIELD_MAP, KNOWN, NOW);
  eq("CJ title: is_cj true", r.deal?.is_cj, true);
  eq("CJ title: still upserted, not ignored", r.ignored, undefined);
  check("CJ title: a note says so", r.notes.some((n) => n.includes("Client Journey")));
  eq("isClientJourneyTitle: 'CJ - x'", isClientJourneyTitle("CJ - Harbor"), true);
  eq("isClientJourneyTitle: lower case 'cj x'", isClientJourneyTitle("cj harbor"), true);
  eq("isClientJourneyTitle: leading space", isClientJourneyTitle("  CJ Harbor"), true);
  eq("isClientJourneyTitle: 'CJ' alone", isClientJourneyTitle("CJ"), true);
  eq("isClientJourneyTitle: a word beginning with cj is not a card", isClientJourneyTitle("Cjs Barbershop site"), false);
  eq("isClientJourneyTitle: CJ inside the title is not a card", isClientJourneyTitle("Harbor CJ rebuild"), false);
  eq("isClientJourneyTitle: null", isClientJourneyTitle(null), false);
}

{
  // unknown org → account null + candidate matched_on none
  const r = parsePipedriveEvent(evt("create", "deal", baseDeal({ org_id: 999 })), FIELD_MAP, KNOWN, NOW);
  eq("deal on unknown org: account_id null", r.deal?.account_id, null);
  eq("deal on unknown org: one candidate, matched_on none", [r.candidates.length, r.candidates[0]?.matched_on, r.candidates[0]?.source_id, r.candidates[0]?.confidence], [1, "none", "999", null]);
  const noOrg = parsePipedriveEvent(evt("create", "deal", baseDeal({ org_id: null })), FIELD_MAP, KNOWN, NOW);
  eq("deal with no org: account null, no candidate (unknown is not evidence)", [noOrg.deal?.account_id, noOrg.candidates.length], [null, 0]);
}

{
  // v1-shaped payload: org_id as {value,name}, user_id, top-level hash keys, space-separated times
  const v1 = {
    id: 7002, title: "Lumen Studio — landing pages", org_id: { value: 501, name: "Harbor & Pine Creative" }, user_id: { id: 42 },
    stage_id: 2, pipeline_id: 1, status: "won", value: "9500", currency: "USD", expected_close_date: "2026-09-30",
    won_time: "2026-09-09 11:00:00", stage_change_time: "2026-09-08 10:00:00", [GRADE_HASH]: "415",
  };
  const r = parsePipedriveEvent({ meta: { action: "updated", object: "deal", entity: "", entity_id: 7002, timestamp: 1_788_955_170 } as unknown as PipedriveV2Event["meta"], data: v1, previous: null }, FIELD_MAP, KNOWN, NOW);
  eq("v1 shape: org id unwrapped and attached", r.deal?.account_id, "acc-harbor");
  eq("v1 shape: owner from user_id object", r.deal?.owner_user_id, 42);
  eq("v1 shape: value string → number", r.deal?.value, 9500);
  eq("v1 shape: won_time 'YYYY-MM-DD HH:MM:SS' → ISO", r.deal?.won_time, "2026-09-09T11:00:00.000Z");
  eq("v1 shape: top-level hash translated", r.deal?.raw.grade_label, "B");
  eq("v1 shape: 'updated' → change; no previous → stage_change_time", r.deal?.stage_entered_at, "2026-09-08T10:00:00.000Z");
  eq("v1 shape: unix-seconds meta.timestamp → ISO", (r.deal?.raw.webhook_meta as Record<string, unknown>).timestamp, "2026-09-09T11:59:30.000Z");
}

{
  // delete
  const r = parsePipedriveEvent(evt("delete", "deal", null, null, { entity_id: "7001" }), FIELD_MAP, KNOWN, NOW);
  eq("deal delete: status deleted, id from meta.entity_id", [r.deal?.pipedrive_deal_id, r.deal?.status], [7001, "deleted"]);
  eq("deal delete: not ignored", r.ignored, undefined);
  const rd = parsePipedriveEvent(evt("delete", "deal", baseDeal()), FIELD_MAP, KNOWN, NOW);
  eq("deal delete with data: status deleted overrides data.status", [rd.deal?.status, rd.deal?.title], ["deleted", "Harbor & Pine — WordPress rebuild"]);
}

{
  // custom-field edge cases
  const r = labelCustomFields({ custom_fields: {
    [GRADE_HASH]: { id: 416 },
    [SOURCE_HASH]: "2,3",
    [BUDGET_HASH]: { value: 25000, currency: "USD" },
    "cccccccccccccccccccccccccccccccccccccccc": "kept by hash",
    [SERVICES_HASH]: null,
  } }, FIELD_MAP.deals);
  eq("custom: option given as {id} → label", r.labelled["Grade"], "C");
  eq("custom: comma-separated set ids → labels", r.labelled["Lead source"], ["Inbound", "Event"]);
  eq("custom: monetary object kept whole", r.labelled["Stated budget"], { value: 25000, currency: "USD" });
  eq("custom: unknown hash kept under its hash", r.labelled["cccccccccccccccccccccccccccccccccccccccc"], "kept by hash");
  eq("custom: null value stays null", r.labelled["Services wanted"], null);
  eq("custom: grade_label from {id}", r.grade_label, "C");
  const none = labelCustomFields({ custom_fields: { [GRADE_HASH]: null } }, FIELD_MAP.deals);
  eq("custom: null grade → grade_label null", none.grade_label, null);
  const unmapped = labelCustomFields({ custom_fields: { [GRADE_HASH]: 999 } }, FIELD_MAP.deals);
  eq("custom: an option id outside the map is kept as the id", unmapped.labelled["Grade"], "999");
  const twoGrades = labelCustomFields({ custom_fields: { [GRADE_HASH]: 414, [SOURCE_HASH]: 2 } }, {
    [SOURCE_HASH]: { label: "Prospect grade (old)", options: { "2": "Old-B" } },
    [GRADE_HASH]: { label: "Grade", options: { "414": "A" } },
  });
  eq("custom: exact 'Grade' label wins over another /grade/i label", twoGrades.grade_label, "A");
  const noMap = labelCustomFields({ custom_fields: { [GRADE_HASH]: 414 } }, undefined);
  eq("custom: no field map → values kept by hash, no grade", [noMap.labelled[GRADE_HASH], noMap.grade_label], [414, null]);
}

/* ------------------------------------------------------------------ *
 * 2 · Organizations
 * ------------------------------------------------------------------ */

{
  const r = parsePipedriveEvent(evt("create", "organization", { id: 777, name: "Copperline Digital, LLC", address: "12 Quay St, Harbourtown", custom_fields: { [WEBSITE_HASH]: "https://www.copperline.example/about" } }), FIELD_MAP, KNOWN, NOW);
  eq("org create (new): mode create", r.account?.mode, "create");
  eq("org create (new): row", [r.account?.pipedrive_org_id, r.account?.name, r.account?.key, r.account?.domain, r.account?.roster_source, r.account?.roster_certified, r.account?.id],
    [777, "Copperline Digital, LLC", "copperline digital", "copperline.example", "pipedrive", true, null]);
  eq("org create (new): no candidates", r.candidates, []);
  eq("org create (new): no deal/contact/signal", [r.deal, r.contact, r.signal], [undefined, undefined, undefined]);
}

{
  // domain match → attach to the existing row; key never changes
  const r = parsePipedriveEvent(evt("create", "organization", { id: 888, name: "Lumen Studio Inc", website: "lumenstudio.example" }), FIELD_MAP, KNOWN, NOW);
  eq("org create (domain match): mode attach with the existing id", [r.account?.mode, r.account?.id], ["attach", "acc-lumen"]);
  eq("org create (domain match): existing key kept, Pipedrive name carried", [r.account?.key, r.account?.name], ["lumen studio", "Lumen Studio Inc"]);
  eq("org create (domain match): certified by Pipedrive", [r.account?.roster_source, r.account?.roster_certified, r.account?.pipedrive_org_id], ["pipedrive", true, 888]);
  eq("org create (domain match): no candidate for the attached row", r.candidates, []);
}

{
  // org id already on the account → attach (change event)
  const r = parsePipedriveEvent(evt("change", "organization", { id: 501, name: "Harbor and Pine Creative" }, { name: "Harbor & Pine Creative" }), FIELD_MAP, KNOWN, NOW);
  eq("org change (org id known): attach", [r.account?.mode, r.account?.id], ["attach", "acc-harbor"]);
  eq("org change (org id known): domain kept from the account when Pipedrive has none", r.account?.domain, "harborpine.example");
}

{
  // norm(name) match only → review, never create (key would collide)
  const r = parsePipedriveEvent(evt("create", "organization", { id: 999, name: "The Northfield Digital Agency" }), FIELD_MAP, KNOWN, NOW);
  eq("org create (name match only): mode review, nothing inserted", [r.account?.mode, r.account?.id], ["review", null]);
  eq("org create (name match only): candidate is medium name_norm on the resembling account", [r.candidates.length, r.candidates[0]?.account_id, r.candidates[0]?.matched_on, r.candidates[0]?.confidence], [1, "acc-north", "name_norm", "medium"]);
  eq("org create (name match only): candidate carries the source identity", [r.candidates[0]?.source, r.candidates[0]?.source_id, r.candidates[0]?.source_name], ["pipedrive", "999", "The Northfield Digital Agency"]);
}

{
  // trigram resemblance → review too
  const r = parsePipedriveEvent(evt("create", "organization", { id: 1000, name: "Northfield Digitals" }), FIELD_MAP, KNOWN, NOW);
  eq("org create (trigram resemblance): review with a low candidate", [r.account?.mode, r.candidates[0]?.confidence, r.candidates[0]?.matched_on], ["review", "low", "name_trigram"]);
}

{
  // v2 address object; a website label variant; an address that is not a domain
  const r = parsePipedriveEvent(evt("create", "organization", { id: 1001, name: "Quarry Lane Studio", address: { value: "1 Quarry Lane, Stonebridge", country: "GB" }, custom_fields: { [WEBSITE_HASH]: "quarrylane.example" } }), FIELD_MAP, KNOWN, NOW);
  eq("org: address object ignored for domain, custom Website label used", r.account?.domain, "quarrylane.example");
  const noDomain = parsePipedriveEvent(evt("create", "organization", { id: 1002, name: "Quarry Lane Studio", address: "1 Quarry Lane, Stonebridge" }), FIELD_MAP, KNOWN, NOW);
  eq("org: no website anywhere → domain null", noDomain.account?.domain, null);
  const generic = parsePipedriveEvent(evt("create", "organization", { id: 1003, name: "Quarry Lane Studio", website: "gmail.com" }), FIELD_MAP, KNOWN, NOW);
  eq("org: a generic mail domain never becomes the domain", generic.account?.domain, null);
}

{
  const r = parsePipedriveEvent(evt("delete", "organization", null, null, { entity_id: "501" }), FIELD_MAP, KNOWN, NOW);
  check("org delete: ignored with a reason, no account", r.account === undefined && typeof r.ignored === "string" && r.ignored.includes("deleted"), r.ignored);
  const nameless = parsePipedriveEvent(evt("create", "organization", { id: 1004 }), FIELD_MAP, KNOWN, NOW);
  check("org without a name: ignored", nameless.account === undefined && typeof nameless.ignored === "string", nameless.ignored);
  const emptyKey = parsePipedriveEvent(evt("create", "organization", { id: 1005, name: "The Agency Group" }), FIELD_MAP, KNOWN, NOW);
  check("org whose name normalises to nothing: ignored", emptyKey.account === undefined && typeof emptyKey.ignored === "string", emptyKey.ignored);
}

/* ------------------------------------------------------------------ *
 * 3 · Persons
 * ------------------------------------------------------------------ */

{
  const r = parsePipedriveEvent(evt("create", "person", {
    id: 9001, name: "Ops Director", first_name: "Ops", last_name: "Director", org_id: 501, job_title: "Director of Operations",
    emails: [{ value: "old@harborpine.example", primary: false, label: "work" }, { value: "OPS@HarborPine.example", primary: true, label: "work" }],
  }), FIELD_MAP, KNOWN, NOW);
  eq("person create: row", [r.contact?.pipedrive_person_id, r.contact?.name, r.contact?.email, r.contact?.title, r.contact?.account_id, r.contact?.pipedrive_org_id, r.contact?.source],
    [9001, "Ops Director", "ops@harborpine.example", "Director of Operations", "acc-harbor", 501, "pipedrive"]);
  eq("person create: no candidates when attached", r.candidates, []);
}

{
  // no org, but the email domain is known → attach on domain
  const r = parsePipedriveEvent(evt("create", "person", { id: 9002, first_name: "Studio", last_name: "Lead", emails: [{ value: "lead@lumenstudio.example", primary: true }] }), FIELD_MAP, KNOWN, NOW);
  eq("person without org: attached by email domain", r.contact?.account_id, "acc-lumen");
  eq("person without org: name from first + last", r.contact?.name, "Studio Lead");
}

{
  // unknown org → held, candidate
  const r = parsePipedriveEvent(evt("create", "person", { id: 9003, name: "Founder", org_id: 4242, email: [{ value: "founder@copperline.example", primary: true }] }), FIELD_MAP, KNOWN, NOW);
  eq("person on unknown org: account null, candidate for the org", [r.contact?.account_id, r.candidates.length, r.candidates[0]?.source_id, r.candidates[0]?.source_domain, r.candidates[0]?.matched_on], [null, 1, "4242", "copperline.example", "none"]);
  eq("person on unknown org: v1 'email' array still read", r.contact?.email, "founder@copperline.example");
}

{
  // only a personal mailbox and no org → nothing to match on
  const r = parsePipedriveEvent(evt("create", "person", { id: 9004, name: "Someone", emails: [{ value: "someone@gmail.com", primary: true }] }), FIELD_MAP, KNOWN, NOW);
  eq("person with a gmail address and no org: account null, no candidate, email kept", [r.contact?.account_id, r.candidates.length, r.contact?.email], [null, 0, "someone@gmail.com"]);
}

{
  eq("primaryEmail: string form", primaryEmail({ email: "A@B.example" }), "a@b.example");
  eq("primaryEmail: first non-empty when none primary", primaryEmail({ emails: [{ value: "" }, { value: "x@y.example" }] }), "x@y.example");
  eq("primaryEmail: none", primaryEmail({ emails: [] }), null);
  eq("primaryEmail: missing", primaryEmail({}), null);
  const del = parsePipedriveEvent(evt("delete", "person", null, null, { entity_id: "9001" }), FIELD_MAP, KNOWN, NOW);
  check("person delete: ignored", del.contact === undefined && typeof del.ignored === "string", del.ignored);
}

/* ------------------------------------------------------------------ *
 * 4 · Activities → meeting_accepted
 * ------------------------------------------------------------------ */

{
  const r = parsePipedriveEvent(evt("change", "activity", {
    id: 555, type: "meeting", subject: "Discovery call", done: true, due_date: "2026-09-08", due_time: "15:00", marked_as_done_time: "2026-09-08T15:45:00Z", deal_id: 7001, org_id: 501, person_id: 9001,
  }), FIELD_MAP, KNOWN, NOW, { rubric: RUBRIC });
  eq("activity meeting done: signal type and account", [r.signal?.type, r.signal?.account_id, r.signal?.source, r.signal?.entered_by], ["meeting_accepted", "acc-harbor", "pipedrive", "system:pipedrive"]);
  eq("activity meeting done: observed_at = marked_as_done_time", r.signal?.observed_at, "2026-09-08T15:45:00.000Z");
  eq("activity meeting done: weight/lifespan/decays from the rubric catalog, never a constant", [r.signal?.weight, r.signal?.lifespan_days, r.signal?.decays], [6, 14, true]);
  eq("activity meeting done: expires_at = observed_at + lifespan", r.signal?.expires_at, "2026-09-22T15:45:00.000Z");
  eq("activity meeting done: payload carries the activity id for de-duplication", [r.signal?.payload.activity_id, r.signal?.payload.activity_type, r.signal?.payload.done], [555, "meeting", true]);
}

{
  // call due ahead of now → booked; observed at this event
  const r = parsePipedriveEvent(evt("create", "activity", { id: 556, type: "call", done: false, due_date: "2026-09-12", due_time: "10:30", org_id: 501 }), FIELD_MAP, KNOWN, NOW);
  eq("activity call ahead: signal observed at meta.timestamp", [r.signal?.type, r.signal?.observed_at], ["meeting_accepted", T0]);
  eq("activity call ahead: due_at in payload", r.signal?.payload.due_at, "2026-09-12T10:30:00.000Z");
  eq("activity without a rubric: weight fields null for the handler to fill", [r.signal?.weight, r.signal?.lifespan_days, r.signal?.decays, r.signal?.expires_at], [null, null, null, null]);
}

{
  const past = parsePipedriveEvent(evt("change", "activity", { id: 557, type: "meeting", done: false, due_date: "2026-09-01", due_time: "10:00", org_id: 501 }), FIELD_MAP, KNOWN, NOW);
  check("activity meeting in the past, not done: ignored", past.signal === undefined && typeof past.ignored === "string" && past.ignored.includes("passed"), past.ignored);
  const task = parsePipedriveEvent(evt("create", "activity", { id: 558, type: "task", done: true, org_id: 501 }), FIELD_MAP, KNOWN, NOW);
  check("activity of type task: ignored", task.signal === undefined && typeof task.ignored === "string" && task.ignored.includes("task"), task.ignored);
  const noDue = parsePipedriveEvent(evt("create", "activity", { id: 559, type: "meeting", done: false, org_id: 501 }), FIELD_MAP, KNOWN, NOW);
  check("activity not done with no due date: ignored (unknown is not evidence)", noDue.signal === undefined && typeof noDue.ignored === "string", noDue.ignored);
  const nobody = parsePipedriveEvent(evt("create", "activity", { id: 560, type: "meeting", done: true, org_id: 4242, deal_id: 7777 }), FIELD_MAP, KNOWN, NOW);
  check("activity on an unknown org and deal: ignored", nobody.signal === undefined && typeof nobody.ignored === "string", nobody.ignored);
  const viaDeal = parsePipedriveEvent(evt("create", "activity", { id: 561, type: "meeting", done: true, deal_id: 7777, marked_as_done_time: "2026-09-09T09:00:00Z" }), FIELD_MAP, KNOWN, NOW, { deal_accounts: { "7777": "acc-lumen" } });
  eq("activity resolved through opts.deal_accounts", [viaDeal.signal?.account_id, viaDeal.signal?.payload.matched_via], ["acc-lumen", "deal_id"]);
  const deleted = parsePipedriveEvent(evt("delete", "activity", null, null, { entity_id: "555" }), FIELD_MAP, KNOWN, NOW);
  check("activity delete: ignored", deleted.signal === undefined && typeof deleted.ignored === "string", deleted.ignored);
}

/* ------------------------------------------------------------------ *
 * 5 · Notes → manual_note
 * ------------------------------------------------------------------ */

{
  const r = parsePipedriveEvent(evt("create", "note", {
    id: 321, content: "<p>Met at the <b>Agency Builders</b> summit.</p><p>They&#39;re shortlisting vendors &amp; want a quote by Q4.</p>", deal_id: 7001, org_id: 501, user_id: 42, add_time: "2026-09-09T08:00:00Z",
  }), FIELD_MAP, KNOWN, NOW, { rubric: RUBRIC });
  eq("note on a known org: manual_note with plain text", [r.signal?.type, r.signal?.payload.text], ["manual_note", "Met at the Agency Builders summit.\nThey're shortlisting vendors & want a quote by Q4."]);
  eq("note: observed_at from add_time", r.signal?.observed_at, "2026-09-09T08:00:00.000Z");
  eq("note: catalog weight", [r.signal?.weight, r.signal?.lifespan_days], [2, 90]);
  eq("note: payload ids", [r.signal?.payload.note_id, r.signal?.payload.deal_id, r.signal?.payload.org_id], [321, 7001, 501]);
  const unknown = parsePipedriveEvent(evt("create", "note", { id: 322, content: "hello", org_id: 4242, deal_id: 8888 }), FIELD_MAP, KNOWN, NOW);
  check("note on nothing the book knows: ignored", unknown.signal === undefined && typeof unknown.ignored === "string", unknown.ignored);
  const viaDeal = parsePipedriveEvent(evt("create", "note", { id: 323, content: "hello", deal_id: 8888 }), FIELD_MAP, KNOWN, NOW, { deal_accounts: { "8888": "acc-north" } });
  eq("note resolved through opts.deal_accounts", viaDeal.signal?.account_id, "acc-north");
  const empty = parsePipedriveEvent(evt("create", "note", { id: 324, content: "<p>&nbsp;</p>", org_id: 501 }), FIELD_MAP, KNOWN, NOW);
  check("note with empty content: ignored", empty.signal === undefined && typeof empty.ignored === "string", empty.ignored);
  eq("stripHtml: br and entities", stripHtml("a<br>b &lt;c&gt;"), "a\nb <c>");
  eq("stripHtml: null", stripHtml(null), null);
}

/* ------------------------------------------------------------------ *
 * 6 · Malformed and unhandled
 * ------------------------------------------------------------------ */

{
  eq("no meta: ignored", parsePipedriveEvent({} as unknown as PipedriveV2Event, FIELD_MAP, KNOWN, NOW).ignored, "malformed event: missing meta");
  eq("null event: ignored", parsePipedriveEvent(null as unknown as PipedriveV2Event, FIELD_MAP, KNOWN, NOW).ignored, "malformed event: missing meta");
  check("unknown action: ignored", (parsePipedriveEvent(evt("exploded", "deal", baseDeal()), FIELD_MAP, KNOWN, NOW).ignored ?? "").startsWith("unknown action"));
  check("unhandled entity: ignored", (parsePipedriveEvent(evt("create", "product", { id: 1, name: "x" }), FIELD_MAP, KNOWN, NOW).ignored ?? "").includes("product"));
  check("create without data: ignored", (parsePipedriveEvent(evt("create", "deal", null, null, { entity_id: "1" }), FIELD_MAP, KNOWN, NOW).ignored ?? "").includes("without data"));
  const emptyMap = parsePipedriveEvent(evt("create", "deal", baseDeal()), {} as FieldMap, KNOWN, NOW);
  eq("empty field map: custom fields kept by hash, no grade", [(emptyMap.deal?.raw.custom_fields_labelled as Record<string, unknown>)[GRADE_HASH], emptyMap.deal?.raw.grade_label], [414, null]);
  const noKnown = parsePipedriveEvent(evt("create", "deal", baseDeal()), FIELD_MAP, [], NOW);
  eq("no known accounts: deal still parsed, unattached, candidate queued", [noKnown.deal?.pipedrive_deal_id, noKnown.deal?.account_id, noKnown.candidates.length], [7001, null, 1]);
}

/* ------------------------------------------------------------------ *
 * 7 · Determinism and purity
 * ------------------------------------------------------------------ */

{
  const e = evt("change", "deal", baseDeal({ stage_id: 4, expected_close_date: "2026-12-01" }), baseDeal());
  const a = JSON.stringify(parsePipedriveEvent(e, FIELD_MAP, KNOWN, NOW, { rubric: RUBRIC }));
  const b = JSON.stringify(parsePipedriveEvent(e, FIELD_MAP, KNOWN, NOW, { rubric: RUBRIC }));
  eq("parsePipedriveEvent is deterministic", a, b);
  const early = parsePipedriveEvent(evt("create", "activity", { id: 600, type: "meeting", done: false, due_date: "2026-09-10", due_time: "09:00", org_id: 501 }), FIELD_MAP, KNOWN, "2026-09-09T00:00:00Z");
  const late = parsePipedriveEvent(evt("create", "activity", { id: 600, type: "meeting", done: false, due_date: "2026-09-10", due_time: "09:00", org_id: 501 }), FIELD_MAP, KNOWN, "2026-09-11T00:00:00Z");
  eq("`now` is the only clock: the same activity is ahead at one now and past at another", [early.signal?.type, late.ignored !== undefined], ["meeting_accepted", true]);
  eq("toIso: seconds", toIso(1_788_955_170), "2026-09-09T11:59:30.000Z");
  eq("toIso: milliseconds", toIso(1_788_955_170_000), "2026-09-09T11:59:30.000Z");
  eq("toIso: bare date", toIso("2026-09-09"), "2026-09-09T00:00:00.000Z");
  eq("toIso: zero date", toIso("0000-00-00 00:00:00"), null);
  eq("toIso: garbage", toIso("soon"), null);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`pipedrive_webhook_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("pipedrive_webhook_test failed");
  }
} else {
  console.log(`pipedrive_webhook_test: ${passed} checks passed`);
}
