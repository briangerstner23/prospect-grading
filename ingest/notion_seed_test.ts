/**
 * WLIQ Prospect Book — Notion master seed mapper tests.
 *
 * Run:  node --experimental-strip-types ingest/notion_seed_test.ts
 *   or: deno run --allow-read ingest/notion_seed_test.ts
 *
 * Every row here is synthetic. Agency names are invented; people appear only as roles.
 */

import { mapNotionProspect, mapNotionProspects, parseContactEntry, PROPERTY, STALE_PROSPECT_REASON } from "./notion_seed.ts";
import type { NotionProspectRow, SeedFact } from "./notion_seed.ts";

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

/* ---- a rubric with exactly the sections the mapper reads (the shape of core/rubric.prospect.v0.1.json) ---- */
const RUBRIC = {
  version: "0.1.0",
  vocabulary: {
    ceilings: ["Project", "Embedded", "Partner"],
    ceiling_aliases: { "A job": "Project", "Seat at the table": "Embedded", Partnership: "Partner" },
  },
  gates: { items: { service_shape: { notion_aliases: { Core: "Core", Adjacent: "Complement", Neither: "Off", Unknown: null } } } },
  dimension_a: {
    notion_aliases: {
      money: { from: "Gate: can afford us", Yes: "present", No: "absent", Unknown: "unknown" },
      authority: { from: "Key decision maker?", Yes: "present", No: "absent", Unknown: "unknown" },
      timing: { from: "Lead priority", "Super Hot": "within_1_week", Hot: "within_1_month", Warm: "within_3_months", Cold: "no_timeline" },
      specification: {
        from: "Active project / immediate need?",
        Yes: "present",
        No: "absent",
        Unknown: "unknown",
        note: "Approximation flagged at seed: an immediate need is not a written scope. Treated as inferred.",
      },
    },
  },
  dimension_b: { base_tier_from_icp: { map: { "ICP-1": "Gold", "ICP-2": "Gold", "ICP-4": "Gold", "ICP-6": "Silver", "ICP-3": "Bronze", "ICP-5": "Bronze" } } },
  potential: { outsourceable_share_by_wl: { "Very High": 0.3, High: 0.3, Medium: 0.2, Low: 0.1, default: 0.2 } },
  signals: {
    urgency: { from_timing: { within_1_week: "Super Hot", within_1_month: "Hot", within_3_months: "Warm", no_timeline: "Cold" } },
    catalog: {
      prior_grade: { weight: 0, lifespan_days: null, decays: false },
      manual_note: { weight: 2, lifespan_days: 90, decays: true },
    },
  },
};

const OPTS = { rubric: RUBRIC };

const fullRow: NotionProspectRow = {
  "Client Name": "Harbor & Pine Creative",
  "Client ID": 1042,
  "Record type": "Prospect",
  "Business Status": "Prospect",
  "T12M billings $": 0,
  "Last edited": "2026-09-01T14:30:00.000Z",
  "Relationship type": "Agency partner",
  "ICP class": "ICP-2",
  "Agency type": "Full-service digital agency",
  Headcount: 24,
  "WL signal": "High",
  "Gate: needs what we do": "Adjacent",
  "Gate: can afford us": "Yes",
  "Gate: decent to deal with": "Pass",
  "Key decision maker?": "Yes",
  "Lead priority": "Hot",
  "Active project / immediate need?": "Yes",
  Ceiling: "Seat at the table",
  "Proof of growth": ["2nd person engaged", "Strategy question asked"],
  "Est Year-1 $": "$16K–46K",
  "Referral source": "Met the founder at the AMI summit",
  "Trigger event": "Hired a head of delivery in August",
  "Prospect grade (effective)": "A-",
  "SQL grade (auto)": "B+",
  "Grade adjustment (rule)": "+1 referral",
  "Override reason": "",
  "Headroom / vendor rank": "#1 of 3 — one other vendor on retainer",
  "Contact name": "Founder (name withheld)",
  "Contact title": "Founder & CEO",
  "Contact email": "founder@harborpine.com",
  "Additional contacts": "Ops Lead <ops@harborpine.com>, COO; Delivery Lead (Head of Delivery)",
  Status: "Active",
  "Current AM": "Account manager A",
};

const factBy = (facts: SeedFact[], key: string): SeedFact | undefined => facts.find((f) => f.key === key);
const factsBy = (facts: SeedFact[], key: string): SeedFact[] => facts.filter((f) => f.key === key);

/* ------------------------------------------------------------------ *
 * 1 · the full row: account
 * ------------------------------------------------------------------ */
{
  const r = mapNotionProspect(fullRow, OPTS);
  eq("full row is not skipped", r.skip, null);
  eq("account key is norm(name)", r.account?.key, "harbor and pine creative");
  eq("account name is verbatim", r.account?.name, "Harbor & Pine Creative");
  eq("account domain comes from the contact email", r.account?.domain, "harborpine.com");
  eq("notion_client_id is the Client ID as text", r.account?.notion_client_id, "1042");
  eq("roster_source / certified / book are the PRO-6 defaults", [r.account?.roster_source, r.account?.roster_certified, r.account?.book], ["notion_master", false, "prospect"]);
  eq("relationship_type Agency partner → agency", r.account?.relationship_type, "agency");
  check("no notes on a clean row", r.notes.length === 0, JSON.stringify(r.notes));

  /* ---- facts ---- */
  const f = r.facts;
  check("every fact carries the source, entered_by and observed date", f.every((x) => x.source === "notion_master" && x.entered_by === "system:notion_master" && x.observed_at === "2026-09-01"), JSON.stringify(f.map((x) => [x.source, x.entered_by, x.observed_at])));
  check("every fact note names its Notion property verbatim", f.every((x) => /^Notion "[^"]+" = /.test(x.note)), JSON.stringify(f.map((x) => x.note)));
  eq("relationship_type fact", [factBy(f, "relationship_type")?.value, factBy(f, "relationship_type")?.evidence_label], ["agency", "inferred"]);
  eq("icp_class fact", factBy(f, "icp_class")?.value, "ICP-2");
  eq("agency_type keyword map: full-service wins over digital", factBy(f, "agency_type")?.value, "full_service");
  eq("headcount is a number", factBy(f, "headcount")?.value, 24);
  eq("wl_signal", factBy(f, "wl_signal")?.value, "High");
  eq("Gate: needs what we do Adjacent → service_shape Complement", factBy(f, "service_shape")?.value, "Complement");
  eq("Gate: can afford us Yes → money present", factBy(f, "money")?.value, "present");
  eq("Gate: can afford us Yes → economics pass", factBy(f, "economics")?.value, "pass");
  eq("Gate: decent to deal with Pass → broker_character pass", factBy(f, "broker_character")?.value, "pass");
  eq("Key decision maker? Yes → authority present", factBy(f, "authority")?.value, "present");
  eq("Lead priority Hot → timing within_1_month", factBy(f, "timing")?.value, "within_1_month");
  eq("Active project Yes → specification present", factBy(f, "specification")?.value, "present");
  check("specification note flags the approximation", /approximation/i.test(factBy(f, "specification")?.note ?? ""), factBy(f, "specification")?.note);
  eq("Ceiling Seat at the table → stated_ceiling Embedded", factBy(f, "stated_ceiling")?.value, "Embedded");
  eq("Proof of growth → climb_signals verbatim strings", factBy(f, "climb_signals")?.value, ["2nd person engaged", "Strategy question asked"]);
  eq("Referral source mentioning AMI → referral_from_network true", factBy(f, "referral_from_network")?.value, true);
  eq("Headroom / vendor rank '#1 of 3' → our_rank 1", factBy(f, "our_rank")?.value, 1);
  eq("Headroom / vendor rank '#1 of 3' → n_vendors 3", factBy(f, "n_vendors")?.value, 3);
  eq("Status → notion_status", factBy(f, "notion_status")?.value, "Active");
  eq("Current AM → notion_current_am", factBy(f, "notion_current_am")?.value, "Account manager A");
  check("every mapped fact is labelled inferred", f.every((x) => x.evidence_label === "inferred"), JSON.stringify(f.map((x) => [x.key, x.evidence_label])));
  check("no quote_amount is ever seeded from Notion", factBy(f, "quote_amount") === undefined);
  check("no fact key is written for Est Year-1 $", f.every((x) => !/year/i.test(x.key)));

  /* ---- signals ---- */
  const s = r.signals;
  const priors = s.filter((x) => x.type === "prior_grade");
  eq("one prior_grade per non-empty grade field plus Est Year-1 $ (Override reason is empty)", priors.map((x) => x.payload.field), ["Prospect grade (effective)", "SQL grade (auto)", "Grade adjustment (rule)", "Est Year-1 $"]);
  eq("prior_grade payload shape", priors[0].payload, { field: "Prospect grade (effective)", value: "A-", source: "notion_master" });
  const year1 = priors.find((x) => x.payload.field === "Est Year-1 $");
  eq("Est Year-1 $ is a prior_grade payload value, not a quote", year1?.payload.value, "$16K–46K");
  eq("prior_grade weight / lifespan / decays come from the catalog", [priors[0].weight, priors[0].lifespan_days, priors[0].decays], [0, null, false]);
  const note = s.find((x) => x.type === "manual_note");
  eq("Trigger event → manual_note payload text", note?.payload.text, "Hired a head of delivery in August");
  eq("manual_note weight / lifespan / decays from the catalog", [note?.weight, note?.lifespan_days, note?.decays], [2, 90, true]);
  check("signals observed_at is the last-edited timestamp", s.every((x) => x.observed_at === "2026-09-01T14:30:00.000Z"), JSON.stringify(s.map((x) => x.observed_at)));
  check("signals carry source and entered_by", s.every((x) => x.source === "notion_master" && x.entered_by === "system:notion_master"));

  /* ---- contacts ---- */
  eq("primary contact", r.contacts[0], { account_key: "harbor and pine creative", name: "Founder (name withheld)", email: "founder@harborpine.com", title: "Founder & CEO", source: "notion_master" });
  eq("additional contact with <email>, title", r.contacts[1], { account_key: "harbor and pine creative", name: "Ops Lead", email: "ops@harborpine.com", title: "COO", source: "notion_master" });
  eq("additional contact with (title) and no email", r.contacts[2], { account_key: "harbor and pine creative", name: "Delivery Lead", email: null, title: "Head of Delivery", source: "notion_master" });
}

/* ------------------------------------------------------------------ *
 * 2 · skip rules
 * ------------------------------------------------------------------ */
{
  const r = mapNotionProspect({ ...fullRow, "Business Status": "Client" }, OPTS);
  eq("Business Status Client → skipped with the PRO-10 reason", r.skip, { reason: STALE_PROSPECT_REASON });
  eq("...the exact reason text", r.skip?.reason, "already an Agency Partner — stale prospect row");
  check("...nothing seeded", r.facts.length === 0 && r.signals.length === 0 && r.contacts.length === 0);
  eq("...but the account is still described for the run log", r.account?.name, "Harbor & Pine Creative");
}
{
  const r = mapNotionProspect({ ...fullRow, "T12M billings $": "$4,250" }, OPTS);
  eq("T12M billings > 0 (as a dollar string) → skipped", r.skip?.reason, STALE_PROSPECT_REASON);
}
{
  const r = mapNotionProspect({ ...fullRow, "T12M billings $": 0 }, OPTS);
  eq("T12M billings 0 → not skipped", r.skip, null);
}
{
  const r = mapNotionProspect({ ...fullRow, "T12M billings $": null, "Business Status": null }, OPTS);
  eq("null Business Status and null T12M → not skipped (unknown is never evidence)", r.skip, null);
}
{
  const r = mapNotionProspect({ ...fullRow, "Record type": "Client" }, OPTS);
  check("Record type other than Prospect → skipped", r.skip !== null && /Record type/.test(r.skip.reason), JSON.stringify(r.skip));
}
{
  const r = mapNotionProspect({ "Client Name": "   " }, OPTS);
  check("empty Client Name → skipped, account null", r.skip !== null && r.account === null, JSON.stringify(r));
}

/* ------------------------------------------------------------------ *
 * 3 · unknown is never evidence
 * ------------------------------------------------------------------ */
{
  const r = mapNotionProspect(
    {
      "Client Name": "Northfield Digital",
      "Last edited": "2026-08-15",
      "Relationship type": "Unknown",
      "Gate: needs what we do": "Unknown",
      "Gate: can afford us": "Unknown",
      "Gate: decent to deal with": "Unknown",
      "Key decision maker?": "Unknown",
      "Active project / immediate need?": "Unknown",
    },
    OPTS,
  );
  eq("Relationship type Unknown → account relationship_type null", r.account?.relationship_type, null);
  eq("service_shape Unknown → recorded unknown (null value, label unknown)", [factBy(r.facts, "service_shape")?.value, factBy(r.facts, "service_shape")?.evidence_label], [null, "unknown"]);
  eq("money Unknown → FactState 'unknown', label unknown", [factBy(r.facts, "money")?.value, factBy(r.facts, "money")?.evidence_label], ["unknown", "unknown"]);
  eq("economics Unknown → null", factBy(r.facts, "economics")?.value, null);
  eq("broker_character Unknown → null", factBy(r.facts, "broker_character")?.value, null);
  eq("authority Unknown → 'unknown'", factBy(r.facts, "authority")?.value, "unknown");
  eq("specification Unknown → 'unknown'", factBy(r.facts, "specification")?.value, "unknown");
  check("no value fires anything: no true/false/present/pass among the unknowns", r.facts.every((f) => f.value === null || f.value === "unknown"), JSON.stringify(r.facts.map((f) => [f.key, f.value])));
  eq("no contacts, no domain when none given", [r.contacts.length, r.account?.domain], [0, null]);
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Last edited": "2026-08-15" }, OPTS);
  eq("empty properties produce no facts at all", r.facts, []);
  eq("...and no signals", r.signals, []);
}
{
  const r = mapNotionProspect(
    { "Client Name": "Bluewater Collective", "Last edited": "2026-08-15", "Gate: needs what we do": "Sort of", "ICP class": "ICP-9", "WL signal": "Extreme", Headcount: "11-50", "Agency type": "Hybrid studio" },
    OPTS,
  );
  eq("an unrecognised gate option is recorded as unknown", [factBy(r.facts, "service_shape")?.value, factBy(r.facts, "service_shape")?.evidence_label], [null, "unknown"]);
  eq("an unrecognised ICP class is recorded as unknown", factBy(r.facts, "icp_class")?.value, null);
  eq("an unrecognised WL level is recorded as unknown", factBy(r.facts, "wl_signal")?.value, null);
  eq("a headcount range is not parsed (never invented)", factBy(r.facts, "headcount")?.value, null);
  eq("unmapped agency-type text is kept as note, value unknown", [factBy(r.facts, "agency_type")?.value, /Hybrid studio/.test(factBy(r.facts, "agency_type")?.note ?? "")], [null, true]);
  check("each unmapped value is reported in notes", r.notes.length === 5, JSON.stringify(r.notes));
}

/* ------------------------------------------------------------------ *
 * 4 · aliases and spellings
 * ------------------------------------------------------------------ */
{
  const row = (extra: NotionProspectRow): NotionProspectRow => ({ "Client Name": "Bluewater Collective", "Last edited": "2026-08-15", ...extra });
  eq("Direct-to-client → direct", mapNotionProspect(row({ "Relationship type": "Direct-to-client" }), OPTS).account?.relationship_type, "direct");
  eq("relationship alias is case-insensitive", mapNotionProspect(row({ "Relationship type": "agency PARTNER" }), OPTS).account?.relationship_type, "agency");
  eq("Core → Core", factBy(mapNotionProspect(row({ "Gate: needs what we do": "Core" }), OPTS).facts, "service_shape")?.value, "Core");
  eq("Neither → Off", factBy(mapNotionProspect(row({ "Gate: needs what we do": "Neither" }), OPTS).facts, "service_shape")?.value, "Off");
  eq("can afford No → money absent + economics fail", mapNotionProspect(row({ "Gate: can afford us": "No" }), OPTS).facts.map((f) => [f.key, f.value]), [["money", "absent"], ["economics", "fail"]]);
  eq("decent Flag → broker_character flag", factBy(mapNotionProspect(row({ "Gate: decent to deal with": "Flag" }), OPTS).facts, "broker_character")?.value, "flag");
  eq("Key decision maker No → authority absent", factBy(mapNotionProspect(row({ "Key decision maker?": "No" }), OPTS).facts, "authority")?.value, "absent");
  eq("Super Hot → within_1_week", factBy(mapNotionProspect(row({ "Lead priority": "Super Hot" }), OPTS).facts, "timing")?.value, "within_1_week");
  eq("Warm → within_3_months", factBy(mapNotionProspect(row({ "Lead priority": "Warm" }), OPTS).facts, "timing")?.value, "within_3_months");
  eq("Cold → no_timeline", factBy(mapNotionProspect(row({ "Lead priority": "cold" }), OPTS).facts, "timing")?.value, "no_timeline");
  eq("A job → Project", factBy(mapNotionProspect(row({ Ceiling: "A job" }), OPTS).facts, "stated_ceiling")?.value, "Project");
  eq("Partnership → Partner", factBy(mapNotionProspect(row({ Ceiling: "Partnership" }), OPTS).facts, "stated_ceiling")?.value, "Partner");
  eq("a canonical ceiling word passes through", factBy(mapNotionProspect(row({ Ceiling: "Embedded" }), OPTS).facts, "stated_ceiling")?.value, "Embedded");
  eq("ICP class spelled 'icp 3' → ICP-3", factBy(mapNotionProspect(row({ "ICP class": "icp 3" }), OPTS).facts, "icp_class")?.value, "ICP-3");
  eq("ICP class as a number → ICP-6", factBy(mapNotionProspect(row({ "ICP class": 6 }), OPTS).facts, "icp_class")?.value, "ICP-6");
  {
    const labelled = factBy(mapNotionProspect(row({ "ICP class": "ICP-6: Direct End-Client" }), OPTS).facts, "icp_class");
    eq("ICP class with a label 'ICP-6: Direct End-Client' → ICP-6", labelled?.value, "ICP-6");
    check("...and the verbatim text stays in the note", /ICP-6: Direct End-Client/.test(labelled?.note ?? ""), labelled?.note);
    eq("ICP class 'ICP-12' is not a class (no digit may follow)", factBy(mapNotionProspect(row({ "ICP class": "ICP-12" }), OPTS).facts, "icp_class")?.value, null);
  }
  eq("WL signal 'very high' → Very High", factBy(mapNotionProspect(row({ "WL signal": "very high" }), OPTS).facts, "wl_signal")?.value, "Very High");
  eq("headcount as a numeric string", factBy(mapNotionProspect(row({ Headcount: "12" }), OPTS).facts, "headcount")?.value, 12);
  eq("Proof of growth as a comma-separated export string", factBy(mapNotionProspect(row({ "Proof of growth": "Referred someone, Structural break" }), OPTS).facts, "climb_signals")?.value, ["Referred someone", "Structural break"]);

  /* agency-type keyword map */
  const at = (text: string) => factBy(mapNotionProspect(row({ "Agency type": text }), OPTS).facts, "agency_type")?.value;
  eq("boutique → boutique", at("Boutique creative shop"), "boutique");
  eq("digital → digital_only", at("Digital"), "digital_only");
  eq("niche → niche_vertical", at("Niche B2B specialist"), "niche_vertical");
  eq("vertical → niche_vertical", at("Vertical: healthcare"), "niche_vertical");
  eq("consult → consultancy", at("Marketing consultancy"), "consultancy");
  eq("fractional → consultancy", at("Fractional CMO"), "consultancy");
  eq("full service (spaced) → full_service", at("full service"), "full_service");

  /* referral keyword rule */
  const ref = (text: string) => factBy(mapNotionProspect(row({ "Referral source": text }), OPTS).facts, "referral_from_network")?.value;
  eq("Brian → true", ref("Intro from Brian"), true);
  eq("BABA → true", ref("BABA member list"), true);
  eq("Agency Builders → true", ref("agency builders slack"), true);
  eq("AMIN → true", ref("AMIN network"), true);
  eq("'referral' → true", ref("Client referral"), true);
  eq("'referred' → true", ref("Referred by a former client"), true);
  eq("'family' does not contain the word AMI", ref("Family friend"), null);
  eq("'Reference call' is not a referral", ref("Reference call with vendor"), null);
  eq("'referring' → true", ref("Referring partner in Denver"), true);
  eq("inbound form → null, note only", ref("Website inbound form"), null);
  check("...and the text is kept in the note", /Website inbound form/.test(factBy(mapNotionProspect(row({ "Referral source": "Website inbound form" }), OPTS).facts, "referral_from_network")?.note ?? ""));

  /* headroom / vendor rank */
  const rank = (text: string) => {
    const f = mapNotionProspect(row({ "Headroom / vendor rank": text }), OPTS).facts;
    return [factBy(f, "our_rank")?.value ?? null, factBy(f, "n_vendors")?.value ?? null, factBy(f, "notion_headroom_vendor_rank")?.value ?? null];
  };
  eq("'#2 of 3' parses", rank("#2 of 3"), [2, 3, null]);
  eq("'ranked #1/2' parses", rank("We are ranked #1/2 on dev work"), [1, 2, null]);
  eq("'#4 of 3' is out of range → informational note only", rank("#4 of 3"), [null, null, "#4 of 3"]);
  eq("free text → informational note only", rank("Plenty of headroom, no other vendor named"), [null, null, "Plenty of headroom, no other vendor named"]);
}

/* ------------------------------------------------------------------ *
 * 5 · observed_at, entered_by, catalog
 * ------------------------------------------------------------------ */
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Trigger event": "Lost their dev lead", Status: "New" }, OPTS);
  eq("no Last edited and no as_of → facts carry observed_at null", factBy(r.facts, "notion_status")?.observed_at, null);
  eq("...and signals are dropped (observed_at is NOT NULL)", r.signals, []);
  check("...with a note", r.notes.some((n) => /Last edited/.test(n)), JSON.stringify(r.notes));
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Trigger event": "Lost their dev lead" }, { ...OPTS, as_of: "2026-09-09" });
  eq("no Last edited but as_of → signal observed_at from as_of", r.signals[0]?.observed_at, "2026-09-09T00:00:00.000Z");
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Last edited time": "2026-07-04T09:00:00Z", Status: "Stale" }, OPTS);
  eq("'Last edited time' is accepted as the last-edited property", factBy(r.facts, "notion_status")?.observed_at, "2026-07-04");
}
{
  const r = mapNotionProspect({ ...fullRow }, { ...OPTS, entered_by: "seed-runner@example.test" });
  check("entered_by option flows to facts and signals", r.facts.every((f) => f.entered_by === "seed-runner@example.test") && r.signals.every((s) => s.entered_by === "seed-runner@example.test"));
}
{
  const r = mapNotionProspect({ ...fullRow }, { rubric: { signals: { catalog: {} } } });
  eq("a rubric without catalog entries drops the signals (never invents a weight)", r.signals, []);
  check("...and says so", r.notes.some((n) => /catalog/.test(n)));
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Last edited": "2026-08-15", Website: "https://www.bluewater-collective.com/about" }, OPTS);
  eq("a Website property (when present) sets the domain", r.account?.domain, "bluewater-collective.com");
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Last edited": "2026-08-15", "Contact email": "someone@gmail.com" }, OPTS);
  eq("a generic mail domain never becomes the account domain", r.account?.domain, null);
  eq("...but the contact is kept", r.contacts[0]?.email, "someone@gmail.com");
}
{
  const r = mapNotionProspect({ "Client Name": "Bluewater Collective", "Last edited": "2026-08-15", "Est Year-1 $": 25000 }, OPTS);
  eq("a numeric Est Year-1 $ stays a number in the prior_grade payload", r.signals[0]?.payload.value, 25000);
  eq("...and its type is prior_grade", r.signals[0]?.type, "prior_grade");
}
{
  const a = JSON.stringify(mapNotionProspect(fullRow, OPTS));
  const b = JSON.stringify(mapNotionProspect(fullRow, OPTS));
  eq("mapNotionProspect is deterministic", a, b);
}

/* ------------------------------------------------------------------ *
 * 6 · parseContactEntry shapes
 * ------------------------------------------------------------------ */
eq("bare email", parseContactEntry("ops@northfield.digital"), { name: null, email: "ops@northfield.digital", title: null });
eq("name - title", parseContactEntry("Ops Lead - Head of Ops"), { name: "Ops Lead", email: null, title: "Head of Ops" });
eq("name, title, email", parseContactEntry("Ops Lead, COO, ops@northfield.digital"), { name: "Ops Lead", email: "ops@northfield.digital", title: "COO" });
eq("empty → null", parseContactEntry("   "), null);

/* ------------------------------------------------------------------ *
 * 7 · mapNotionProspects (batch)
 * ------------------------------------------------------------------ */
{
  const rows: NotionProspectRow[] = [
    fullRow,
    { "Client Name": "Northfield Digital", "Last edited": "2026-08-15", "ICP class": "ICP-3", "Trigger event": "Posted two dev roles" },
    { "Client Name": "Old Partner Studio", "Last edited": "2026-08-15", "Business Status": "Client" },
    { "Client Name": "The Northfield Digital Group, LLC", "Last edited": "2026-08-16" },
    { "Client Name": "" },
  ];
  const b = mapNotionProspects(rows, OPTS);
  eq("two accounts seeded", b.accounts.map((a) => a.key), ["harbor and pine creative", "northfield digital"]);
  eq("skipped list carries name and reason", b.skipped.map((s) => s.name), ["Old Partner Studio", "The Northfield Digital Group, LLC", "row 5"]);
  eq("the stale row carries the PRO-10 reason", b.skipped[0].reason, STALE_PROSPECT_REASON);
  check("a duplicate key is skipped, never merged", /duplicate key/.test(b.skipped[1].reason), b.skipped[1].reason);
  check("facts are keyed to their account", b.facts.every((f) => f.account_key === "harbor and pine creative" || f.account_key === "northfield digital"));
  eq("facts for the second account", factsBy(b.facts.filter((f) => f.account_key === "northfield digital"), "icp_class").map((f) => f.value), ["ICP-3"]);
  eq("signals for both accounts", b.signals.filter((s) => s.account_key === "northfield digital").map((s) => s.type), ["manual_note"]);
  eq("contacts only from the first row", b.contacts.length, 3);
  check("PROPERTY lists the verbatim names", PROPERTY.active_project === "Active project / immediate need?" && PROPERTY.est_year1 === "Est Year-1 $");
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`notion_seed_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("notion_seed_test failed");
  }
} else {
  console.log(`notion_seed_test: ${passed} checks passed`);
}
