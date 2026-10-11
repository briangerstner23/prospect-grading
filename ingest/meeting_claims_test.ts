/**
 * WLIQ Prospect Book — what a sales meeting said about each agency, as proposals, tests.
 *
 * Run:  node --experimental-strip-types ingest/meeting_claims_test.ts
 *
 * Every agency, line and quote here is INVENTED (rule 2). Speakers are S-labels; account ids are
 * made-up words. The removal codes are synthetic on purpose — the module must take whatever the
 * pb_removal_reasons rows say, so the test feeds it codes the live table does not have.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BATCH_SIZE,
  BLOCKING_FLAGS,
  claimsMessage,
  claimsPrompt,
  DEFAULT_OVERRIDE_CODE,
  defaultSelected,
  defaultText,
  hedgeFlags,
  HISTORIC_DAYS,
  MAX_FACTS_PER_AGENCY,
  MAX_READS_PER_AGENCY,
  MODES,
  planBatches,
  PROPOSAL_COLUMNS,
  PROPOSAL_DB_COLUMNS,
  proposalRows,
  reduceClaims,
  segmentPrompt,
  tierNamed,
  verifyMeetingClaims,
} from "./meeting_claims.ts";
import type { Batch, ClusterForBatch, ProposalCluster, ProposalInput, RemovalReason, VerifiedClaim } from "./meeting_claims.ts";
import type { TranscriptLine } from "./meeting_transcript.ts";
import { MAX_AS_SAID, MAX_COMPANIES, MAX_MENTION_LINES, MAX_SEGMENTS } from "./meeting_mentions.ts";
import { EXTRACTABLE, extractorId, keysFor, MEETING_PROMPT_VERSION } from "./notes_sweep.ts";
import type { ClaimShape } from "./notes_sweep.ts";

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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/* ------------------------------------------------------------------ *
 * fixtures: one synthetic meeting, three agencies
 * ------------------------------------------------------------------ */

const TEXT: Array<[string, string, string]> = [
  ["S1", "00:01:00", "First up, Quillfern Digital."],
  ["S2", "00:01:10", "They told us the budget is approved for the rebuild."],
  ["S2", "00:01:20", "Honestly they are a Gold account at this point."],
  ["S1", "00:01:30", "Not a Platinum though, not yet."],
  ["S2", "00:01:40", "They have about forty people on staff, call it 40."],
  ["S1", "00:02:00", "Quillfern and Northgale both asked about hosting this week."],
  ["S3", "00:03:00", "Northgale Creative wants to pause until next year."],
  ["S3", "00:03:10", "Let's take them off the list, they asked us to stop calling."],
  ["S1", "00:03:20", "What if they come back in the spring?"],
  ["S2", "00:03:30", "They would only ever be a Silver opportunity [laughter]"],
  ["S1", "00:04:00", "The Bluebarrow people have twelve developers in house."],
  ["S2", "00:04:10", "Bluebarrow is a Gold standard shop for design work."],
];
const LINES: TranscriptLine[] = TEXT.map(([speaker, at, text], i) => ({ n: i + 1, at, seconds: null, speaker, text }));

const TIERS = ["Bronze", "Silver", "Gold", "Platinum"];
const OVERRIDE_CODES = ["data_wrong", "relationship_known", "timing_known", "other"];
const REASONS: RemovalReason[] = [
  { disposition: "do_not_contact", code: "x_asked", allows_review_date: false, active: true },
  { disposition: "do_not_contact", code: "x_legal", allows_review_date: false, active: false },
  { disposition: "unqualified", code: "x_small", allows_review_date: true, active: true },
  { disposition: "unqualified", code: "other", allows_review_date: true, active: true },
];

const CLUSTERS: Array<ClusterForBatch & ProposalCluster> = [
  { ref: "A1", state: "resolved", said_key: "quillfern|quillfern digital", said_as: ["Quillfern Digital", "Quillfern"], account_id: "quill", matched_on: "name", options: ["quill"], segments: [{ from: 1, to: 6 }] },
  { ref: "A2", state: "resolved", said_key: "northgale|northgale creative", said_as: ["Northgale", "Northgale Creative"], account_id: "ngc", matched_on: "name", options: ["ngc"], segments: [{ from: 6, to: 10 }] },
  { ref: "A3", state: "suggested", said_key: "bluebarrow", said_as: ["Bluebarrow"], account_id: null, matched_on: "token", options: ["blue"], segments: [{ from: 11, to: 12 }] },
  { ref: "A4", state: "unknown", said_key: "brightquay", said_as: ["Brightquay"], account_id: null, matched_on: null, options: [], segments: [{ from: 12, to: 12 }] },
  { ref: "A5", state: "refused", said_key: "wliq", said_as: ["WLIQ"], account_id: null, matched_on: null, options: [], segments: [{ from: 1, to: 12 }] },
];

const PLAN = planBatches(CLUSTERS, LINES);
const BATCH: Batch = PLAN.batches[0];

const verify = (claims: unknown[]) => verifyMeetingClaims({ claims }, {
  lines: LINES, batch: BATCH, owners: PLAN.owners, tiers: TIERS, overrideCodes: OVERRIDE_CODES, removalReasons: REASONS,
});

/* ------------------------------------------------------------------ *
 * 1 · batches and the messages a model sees
 * ------------------------------------------------------------------ */

{
  eq("unknown and refused clusters are never read", PLAN.skipped, [{ ref: "A4", state: "unknown" }, { ref: "A5", state: "refused" }]);
  eq("the three readable agencies fit one batch", PLAN.batches.map((b) => b.items.map((i) => i.ref)), [["A1", "A2", "A3"]]);
  eq("line 6 is owned by two agencies", PLAN.owners[6], ["A1", "A2"]);
  eq("an unknown company still owns its line; a refused one does not", PLAN.owners[12], ["A3", "A4"]);
  eq("owned lines are the segment's", BATCH.items[0].owned, [1, 2, 3, 4, 5, 6]);

  const many: ClusterForBatch[] = Array.from({ length: 10 }, (_, i) => ({
    ref: `A${i + 1}`, state: "resolved", said_key: `k${i}`, said_as: [`K${i}`], account_id: `a${i}`, segments: [{ from: 1, to: 1 }],
  }));
  eq("four agencies to a call", planBatches(many, LINES).batches.map((b) => b.items.length), [4, 4, 2]);
  check("never more than four, whatever is asked", planBatches(many, LINES, { size: 9 }).batches.every((b) => b.items.length <= BATCH_SIZE));
  eq("done refs are not read again", planBatches(many, LINES, { done: ["A1", "A2", "A3", "A4"] }).batches[0].items[0].ref, "A5");

  const msg = claimsMessage({ index: 0, items: [BATCH.items[0]] });
  check("each agency is its own block", msg.includes('<agency ref="A1" said_as="Quillfern Digital; Quillfern">') && msg.includes("</agency>"));
  check("holding only its own excerpt", msg.includes("about forty people") && !msg.includes("twelve developers"));
  check("its padding is marked context", msg.includes("S3 (context): Northgale Creative wants"));
}

/* ------------------------------------------------------------------ *
 * 2 · verification
 * ------------------------------------------------------------------ */

{
  const r = verify([{ ref: "A1", type: "read", topic: "timing", quote: "wants to pause until next year", line_from: 7, line_to: 7, mode: "asserted", confidence: "high" }]);
  eq("a quote from another agency's lines is refused", [r.claims.length, r.counters.other_agency_lines], [0, 1]);
}
{
  const r = verify([{ ref: "A1", type: "read", topic: "fit", quote: "both asked about hosting this week", line_from: 6, line_to: 6, mode: "asserted", confidence: "high" }]);
  eq("a line two agencies own is kept, flagged shared_segment", r.claims.map((c) => c.flags), [["shared_segment"]]);
}
{
  const r = verify([{ ref: "A1", type: "fact", key: "headcount", value: 40, quote: "about forty people on staff, call it 40", line_from: 4, line_to: 5, mode: "asserted", confidence: "high", speaker: "S9", quote_at: "09:09:09" }]);
  eq("quote_at and speaker come from our line, not the model", [r.claims[0].line_from, r.claims[0].speaker, r.claims[0].quote_at], [5, "S2", "00:01:40"]);
  eq("kind is judgement", r.claims[0].kind, "judgement");
}
{
  const r = verify([{ ref: "A1", type: "fact", key: "revenue_band", value: "big", quote: "the budget is approved for the rebuild", line_from: 2, line_to: 2, mode: "asserted" }]);
  eq("a key outside keysFor('sales_meeting') is dropped", [r.claims.length, r.counters.key_not_extractable], [0, 1]);
  const v = verify([{ ref: "A1", type: "fact", key: "headcount", value: "forty", quote: "about forty people on staff", line_from: 5, line_to: 5, mode: "asserted" }]);
  eq("a value out of shape is dropped", [v.claims.length, v.counters.value_out_of_shape], [0, 1]);
  const m = verify([{ ref: "A1", type: "fact", key: "money", value: "present", quote: "the budget is approved for the rebuild", line_from: 2, line_to: 2, mode: "asserted" }]);
  eq("a key and value in shape are kept", [m.claims[0].key, m.claims[0].value], ["money", "present"]);
  const proto = verify([{ ref: "A1", type: "fact", key: "constructor", value: 5, quote: "about forty people on staff", line_from: 5, line_to: 5, mode: "asserted" }]);
  eq("an inherited property name is no key", [proto.claims.length, proto.counters.key_not_extractable], [0, 1]);
  const spaced = verify([{ ref: "A1", type: "read", topic: "price", quote: "  the budget   is approved\nfor the rebuild ", line_from: 2, line_to: 2, mode: "asserted" }]);
  eq("the quote is stored whitespace-collapsed", spaced.claims[0].quote, "the budget is approved for the rebuild");
}
{
  const ok = verify([{ ref: "A1", type: "tier_call", tier: "gold", code: "relationship_known", quote: "Honestly they are a Gold account at this point.", line_from: 3, line_to: 3, mode: "asserted" }]);
  eq("a listed tier named in its quote is a tier call, spelled as the rubric spells it", [ok.claims[0].tier, ok.claims[0].code], ["Gold", "relationship_known"]);
  const notListed = verify([{ ref: "A1", type: "tier_call", tier: "Diamond", quote: "Honestly they are a Gold account at this point.", line_from: 3, line_to: 3, mode: "asserted" }]);
  eq("a tier outside the supplied tiers is dropped", [notListed.claims.length, notListed.counters.tier_not_listed], [0, 1]);
  const notNamed = verify([{ ref: "A1", type: "tier_call", tier: "Silver", quote: "Honestly they are a Gold account at this point.", line_from: 3, line_to: 3, mode: "asserted" }]);
  eq("a tier not named in its quote is dropped", [notNamed.claims.length, notNamed.counters.tier_not_named_in_quote], [0, 1]);
  const negated = verify([{ ref: "A1", type: "tier_call", tier: "Platinum", quote: "Not a Platinum though, not yet.", line_from: 4, line_to: 4, mode: "asserted" }]);
  eq("'not a platinum' gives no tier call", negated.claims.length, 0);
  const idiom = verify([{ ref: "A3", type: "tier_call", tier: "Gold", quote: "Bluebarrow is a Gold standard shop for design work.", line_from: 12, line_to: 12, mode: "asserted" }]);
  eq("'gold standard' gives no tier call", idiom.claims.length, 0);
  const badCode = verify([{ ref: "A1", type: "tier_call", tier: "Gold", code: "because", quote: "they are a Gold account at this point", line_from: 3, line_to: 3, mode: "asserted" }]);
  eq("an override code the rubric does not list is left for the default", badCode.claims[0].code, null);
  check("tierNamed reads 'only ever be a Silver' as naming it", tierNamed("They would only ever be a Silver opportunity", "Silver"));
  check("and 'do not think it is a Gold' as not", !tierNamed("I do not think it is a Gold one", "Gold"));
}
{
  const ok = verify([{ ref: "A2", type: "removal", disposition: "do_not_contact", code: "x_asked", quote: "they asked us to stop calling", line_from: 8, line_to: 8, mode: "asserted" }]);
  eq("an active disposition/code pair is kept", [ok.claims[0].disposition, ok.claims[0].code], ["do_not_contact", "x_asked"]);
  const inactive = verify([{ ref: "A2", type: "removal", disposition: "do_not_contact", code: "x_legal", quote: "they asked us to stop calling", line_from: 8, line_to: 8, mode: "asserted" }]);
  eq("an inactive pair keeps the removal with code null", [inactive.claims.length, inactive.claims[0].code], [1, null]);
  const cross = verify([{ ref: "A2", type: "removal", disposition: "do_not_contact", code: "x_small", quote: "they asked us to stop calling", line_from: 8, line_to: 8, mode: "asserted" }]);
  eq("a code from the other disposition is no pair", cross.claims[0].code, null);
  const noDisp = verify([{ ref: "A2", type: "removal", disposition: "banished", code: "x_asked", quote: "they asked us to stop calling", line_from: 8, line_to: 8, mode: "asserted" }]);
  eq("an unknown disposition leaves both to the owner", [noDisp.claims[0].disposition, noDisp.claims[0].code], [null, null]);
}
{
  const r = verify([{ ref: "A1", type: "read", topic: "price", quote: "the budget is approved for the rebuild", line_from: 2, line_to: 2, confidence: "high", kind: "observation" }]);
  eq("a missing mode is unclear", r.claims[0].mode, "unclear");
  eq("kind is judgement even when the model says observation", [r.claims[0].kind, r.counters.kind_forced_to_judgement], ["judgement", 1]);
  const t = verify([{ ref: "A1", type: "read", topic: "health", quote: "the budget is approved for the rebuild", line_from: 2, line_to: 2, mode: "asserted" }]);
  eq("a topic off the list is 'other'", t.claims[0].topic, "other");
}
{
  const r = verify([
    { ref: "A2", type: "read", topic: "timing", quote: "What if they come back in the spring?", line_from: 9, line_to: 9, mode: "asserted" },
    { ref: "A2", type: "tier_call", tier: "Silver", quote: "They would only ever be a Silver opportunity [laughter]", line_from: 10, line_to: 10, mode: "asserted" },
  ]);
  eq("hedgeFlags flags a trailing '?' and 'what if'", r.claims[0].flags, ["question", "hypothetical"]);
  eq("and '[laughter]'", r.claims[1].flags, ["joke"]);
  eq("without overruling the mode", r.claims.map((c) => c.mode), ["asserted", "asserted"]);
  eq("hedgeFlags of a plain sentence is nothing", hedgeFlags("They have about forty people on staff."), []);
  eq("'suppose', 'imagine', 'kidding', 'haha'", [hedgeFlags("suppose they sign"), hedgeFlags("imagine that"), hedgeFlags("just kidding"), hedgeFlags("haha no")],
    [["hypothetical"], ["hypothetical"], ["joke"], ["joke"]]);
}
{
  const r = verify([
    { ref: "A9", type: "read", topic: "fit", quote: "First up, Quillfern Digital.", line_from: 1, line_to: 1, mode: "asserted" },
    { ref: "A1", type: "rumour", quote: "First up, Quillfern Digital.", line_from: 1, line_to: 1, mode: "asserted" },
    { ref: "A1", type: "read", topic: "fit", quote: "They signed the contract this morning.", line_from: 2, line_to: 2, mode: "asserted" },
    { ref: "A1", type: "read", topic: "fit", quote: "First up, Quillfern Digital.", line_from: 1, line_to: 1, mode: "asserted" },
  ]);
  eq("an unknown ref, an unknown type and an invented quote are dropped and counted",
    [r.claims.length, r.counters.unknown_ref, r.counters.unknown_type, r.counters.quote_not_in_lines], [1, 1, 1, 1]);
  eq("an unreadable reply takes nothing", verifyMeetingClaims("no", { lines: LINES, batch: BATCH, owners: PLAN.owners, tiers: TIERS, overrideCodes: OVERRIDE_CODES, removalReasons: REASONS }).claims, []);
  const flood = verify(Array.from({ length: 45 }, () => ({ ref: "A1", type: "read", topic: "fit", quote: "First up, Quillfern Digital.", line_from: 1, line_to: 1, mode: "asserted" })));
  eq("over 40 claims: only 40 are read", [flood.claims.length, flood.counters.over_claim_cap], [40, 5]);
}

/* ------------------------------------------------------------------ *
 * 3 · the last word
 * ------------------------------------------------------------------ */

let ORDER = 0;
const vc = (o: Partial<VerifiedClaim>): VerifiedClaim => ({
  ref: "A1", type: "fact", key: "headcount", value: 40, tier: null, disposition: null, code: null, topic: null,
  quote: "They have about forty people on staff, call it 40.", line_from: 5, line_to: 5, quote_at: "00:01:40", speaker: "S2",
  mode: "asserted", confidence: "high", kind: "judgement", flags: [], order: ORDER++, ...o,
});

{
  const r = reduceClaims([
    vc({ type: "tier_call", tier: "Gold", line_from: 3 }),
    vc({ type: "tier_call", tier: "Silver", line_from: 10 }),
  ]);
  eq("two tier calls → the last kept", r.claims.map((c) => c.tier), ["Silver"]);
  eq("and counted", r.counters.reduced_tier_call, 1);
  const q = reduceClaims([
    vc({ type: "tier_call", tier: "Gold", line_from: 3 }),
    vc({ type: "tier_call", tier: "Silver", line_from: 10, mode: "question" }),
  ]);
  eq("a later question does not unseat the last asserted word", q.claims.map((c) => c.tier), ["Gold"]);

  const keys = Object.keys(EXTRACTABLE);
  const lots = [
    ...keys.map((k, i) => vc({ key: k, line_from: i + 1 })),
    vc({ key: "headcount", value: 41, line_from: 30 }),
    vc({ type: "removal", disposition: "unqualified", line_from: 2 }),
    vc({ type: "removal", disposition: "do_not_contact", line_from: 8 }),
    ...[1, 2, 3, 4, 5].map((n) => vc({ type: "read", topic: "fit", key: null, line_from: n })),
  ];
  const c = reduceClaims(lots).claims;
  eq("one removal, the last", c.filter((x) => x.type === "removal").map((x) => x.disposition), ["do_not_contact"]);
  eq(`at most ${MAX_FACTS_PER_AGENCY} facts`, c.filter((x) => x.type === "fact").length, MAX_FACTS_PER_AGENCY);
  eq("one per key", new Set(c.filter((x) => x.type === "fact").map((x) => x.key)).size, MAX_FACTS_PER_AGENCY);
  eq("a key said twice keeps its last value", c.find((x) => x.type === "fact" && x.key === "headcount")?.value, 41);
  eq(`at most ${MAX_READS_PER_AGENCY} reads`, c.filter((x) => x.type === "read").map((x) => x.line_from), [3, 4, 5]);
  eq("agencies are reduced separately", reduceClaims([vc({ type: "tier_call", tier: "Gold" }), vc({ ref: "A2", type: "tier_call", tier: "Bronze" })]).claims.length, 2);
}

/* ------------------------------------------------------------------ *
 * 4 · proposal rows
 * ------------------------------------------------------------------ */

const EXTRACTOR = extractorId("model-x", MEETING_PROMPT_VERSION);
const BASE: ProposalInput = {
  meeting: { recording_id: "5001", title: "Sales Standing Connect", held_at: "2026-10-09T19:03:00Z" },
  extractor: EXTRACTOR,
  as_of: "2026-10-10",
  clusters: CLUSTERS,
  claims: [],
  lines: LINES,
  facts: [
    { account_id: "quill", key: "headcount", value: 25, evidence_label: "evidence", source: "website" },
    { account_id: "ngc", key: "headcount", value: 40, evidence_label: "evidence", source: "rater" },
    { account_id: "ngc", key: "money", value: "absent", evidence_label: "evidence", source: "sales_meeting" },
    { account_id: "ngc", key: "climb_signals", value: ["Structural break", "Champion identified"], evidence_label: "evidence", source: "rater" },
  ],
  reads: [
    { account_id: "quill", computed_tier: "Silver", effective_tier: "Gold" },
    { account_id: "ngc", computed_tier: null, effective_tier: null },
  ],
  removed: ["ngc"],
  overrideCodes: OVERRIDE_CODES,
};
const rows = (claims: VerifiedClaim[], o: Partial<ProposalInput> = {}) => proposalRows({ ...BASE, ...o, claims });

eq("the extractor id is meeting@v1+<model>", EXTRACTOR, "meeting@v1+model-x");

{
  const [r] = rows([vc({})]);
  eq("every key is a pb_meeting_proposals column, and every insert column is there", Object.keys(r), [...PROPOSAL_COLUMNS]);
  check("no defaulted column is sent", PROPOSAL_DB_COLUMNS.every((c) => !(c in r)));
  eq("a fact differing from a machine value conflicts, but is still pre-ticked",
    [r.status, r.conflicts, r.current_value, r.current_source, r.flags, r.default_selected], ["proposed", true, 25, "website", [], true]);
  eq("held_on is the meeting's date", r.held_on, "2026-10-09");
  eq("a fact has no prefilled text", r.default_text, null);
  check("context is the cited lines ±2", r.context !== null && r.context.includes("L0003") && r.context.includes("L0007") && !r.context.includes("L0008"));
  eq("display snapshots travel on the row", [r.engine_tier, r.effective_tier], ["Silver", "Gold"]);
}
{
  const [a, b] = rows([vc({ type: "tier_call", tier: "Gold", key: null }), vc({ type: "tier_call", tier: "Silver", key: null, ref: "A1" })]);
  eq("a tier equal to the effective tier → agrees", a.status, "agrees");
  eq("a tier equal to the computed tier → agrees", b.status, "agrees");
  const [c] = rows([vc({ type: "tier_call", tier: "Platinum", key: null })]);
  eq("a different tier is proposed, with the default reason code", [c.kind, c.status, c.reason_code, c.default_selected], ["override", "proposed", DEFAULT_OVERRIDE_CODE, true]);
  eq("the model's code is kept when the rubric lists it", rows([vc({ type: "tier_call", tier: "Platinum", key: null, code: "timing_known" })])[0].reason_code, "timing_known");
  eq("no relationship_known in the rubric → 'other'", rows([vc({ type: "tier_call", tier: "Platinum", key: null })], { overrideCodes: ["data_wrong", "other"] })[0].reason_code, "other");
  check("default_text carries the quote, title and timestamp",
    c.default_text === `"They have about forty people on staff, call it 40." — Sales Standing Connect, 2026-10-09 00:01:40`, String(c.default_text));
  const [d] = rows([vc({ ref: "A2", type: "tier_call", tier: "Gold", key: null, line_from: 10, line_to: 10, quote: "They would only ever be a Gold opportunity" })]);
  eq("no computed tier → flagged and not pre-ticked", [d.status, d.flags, d.default_selected], ["proposed", ["no_computed_tier"], false]);
}
{
  const [r] = rows([vc({ ref: "A2", type: "removal", disposition: "do_not_contact", code: "x_asked", key: null, line_from: 8, line_to: 8 })]);
  eq("a removal of an agency already off the board → agrees", r.status, "agrees");
  const [s] = rows([vc({ type: "removal", disposition: "do_not_contact", code: "x_asked", key: null })]);
  eq("a removal is NEVER default_selected", [s.status, s.default_selected], ["proposed", false]);
  eq("a removal carries its code and disposition, no review date", [s.reason_code, s.disposition, s.review_on], ["x_asked", "do_not_contact", null]);
  check("a removal's text is the quote and the meeting date", s.default_text === `"They have about forty people on staff, call it 40." — sales meeting 2026-10-09`);
  const [t] = rows([vc({ type: "read", topic: "price", key: null })]);
  check("a read's text names its topic", t.default_text?.endsWith("(price)") === true);
}
{
  const [same] = rows([vc({ ref: "A2", key: "headcount", value: 40, line_from: 8, line_to: 8 })]);
  eq("a fact equal to a person-held value → agrees", same.status, "agrees");
  const [mtg] = rows([vc({ ref: "A2", key: "money", value: "absent", line_from: 8, line_to: 8 })]);
  eq("a sales_meeting value is a person's too", mtg.status, "agrees");
  const [list] = rows([vc({ ref: "A2", key: "climb_signals", value: ["Champion identified", "Structural break"], line_from: 8, line_to: 8 })]);
  eq("a list in another order is the same value", list.status, "agrees");
  const [diff] = rows([vc({ ref: "A2", key: "headcount", value: 12, line_from: 8, line_to: 8 })]);
  eq("a fact differing from a person-held value → conflicts_with_person, not pre-ticked",
    [diff.status, diff.flags, diff.conflicts, diff.default_selected], ["proposed", ["conflicts_with_person"], true, false]);
}
{
  const [h] = rows([vc({})], { as_of: "2026-11-01" });
  eq(`held more than ${HISTORIC_DAYS} days before as_of → historic, not pre-ticked`, [h.flags, h.default_selected], [["historic"], false]);
  const [edge] = rows([vc({})], { as_of: "2026-10-30" });
  eq(`exactly ${HISTORIC_DAYS} days is not historic`, edge.flags, []);
}
{
  for (const mode of ["hypothetical", "question", "joke"] as const) {
    const [r] = rows([vc({ mode })]);
    eq(`a ${mode} → not_proposed`, [r.status, r.default_selected], ["not_proposed", false]);
  }
  const [u] = rows([vc({ mode: "unclear" })]);
  eq("an unclear mode is proposed but not pre-ticked", [u.status, u.default_selected], ["proposed", false]);
}
{
  const [s] = rows([vc({ ref: "A3", key: "delivery_headcount", value: 12, line_from: 11, line_to: 11 })]);
  eq("a suggested mention's row carries no account and is not pre-ticked", [s.account_id, s.mention_state, s.options, s.default_selected], [null, "suggested", ["blue"], false]);
  eq("unknown and refused clusters write no rows", rows([vc({ ref: "A4" }), vc({ ref: "A5" })]).length, 0);
}
{
  const a = rows([vc({})])[0].fingerprint;
  eq("the fingerprint is stable across reruns", rows([vc({ value: 41 })])[0].fingerprint, a);
  check("it differs across extractor ids", rows([vc({})], { extractor: extractorId("model-y", MEETING_PROMPT_VERSION) })[0].fingerprint !== a);
  check("it differs for the same key on two agencies", rows([vc({ ref: "A2" })])[0].fingerprint !== a);
  check("it differs for another key", rows([vc({ key: "money", value: "present" })])[0].fingerprint !== a);
  check("two reads of one agency do not collide", new Set(rows([vc({ type: "read", topic: "fit", line_from: 2 }), vc({ type: "read", topic: "fit", line_from: 3 })]).map((r) => r.fingerprint)).size === 2);
  check("it is eight hex characters", /^[0-9a-f]{8}$/.test(a));
}

/* the pre-tick truth table: every flag, every kind, every mode */
{
  const base = { kind: "fact", mode: "asserted", mention_state: "resolved", matched_on: "name", account_id: "quill", flags: [] as string[], status: "proposed" };
  eq("a clean resolved asserted fact is pre-ticked", defaultSelected(base), true);
  for (const f of BLOCKING_FLAGS) eq(`flag ${f} unticks it`, defaultSelected({ ...base, flags: [f] }), false);
  eq("a non-blocking flag does not", defaultSelected({ ...base, flags: ["capped"] }), true);
  eq("a removal is never pre-ticked", defaultSelected({ ...base, kind: "removal" }), false);
  eq("an override and a read are", [defaultSelected({ ...base, kind: "override" }), defaultSelected({ ...base, kind: "read" })], [true, true]);
  eq("reported counts for a fact", defaultSelected({ ...base, mode: "reported" }), true);
  eq("but not for a tier call or a read", [defaultSelected({ ...base, kind: "override", mode: "reported" }), defaultSelected({ ...base, kind: "read", mode: "reported" })], [false, false]);
  for (const m of MODES.filter((x) => x !== "asserted" && x !== "reported")) eq(`mode ${m} is not pre-ticked`, defaultSelected({ ...base, mode: m }), false);
  eq("a suggested or ambiguous mention is not", [defaultSelected({ ...base, mention_state: "suggested" }), defaultSelected({ ...base, mention_state: "ambiguous" })], [false, false]);
  eq("one a person placed is", defaultSelected({ ...base, mention_state: "suggested", matched_on: "person" }), true);
  eq("no account, no tick", defaultSelected({ ...base, account_id: null }), false);
  for (const s of ["agrees", "not_proposed", "approved", "rejected", "superseded"]) eq(`status ${s} is not pre-ticked`, defaultSelected({ ...base, status: s }), false);
  eq("defaultText of a fact is null", defaultText({ kind: "fact", quote: "x", quote_at: "00:00:01" }, { title: "T", held_on: "2026-10-09" }), null);
}

/* ------------------------------------------------------------------ *
 * 4a · lengths as the table counts them (char_length: code points)
 * ------------------------------------------------------------------ */

{
  // pb_meeting_proposals checks quote between 12 and 600 and context at most 1,200 in CHARACTERS.
  // `.length` counts UTF-16 units, so an emoji is two of them and one character to the table; a row
  // measured the wrong way passes here, fails there, and refuses the whole batch it was written in.
  const emoji = "\u{1F44D}";
  const L: TranscriptLine[] = [
    { n: 1, at: "00:00:01", seconds: 1, speaker: "S1", text: `Quillfern then, ok ${emoji.repeat(5)} and they have forty people on staff.` },
    { n: 2, at: "00:00:09", seconds: 9, speaker: "S2", text: `Quillfern ${emoji.repeat(1300)} they want the rebuild before spring.` },
  ];
  const cl: Array<ClusterForBatch & ProposalCluster> = [
    { ref: "A1", state: "resolved", said_key: "quillfern", said_as: ["Quillfern"], account_id: "quill", matched_on: "name", options: ["quill"], segments: [{ from: 1, to: 2 }] },
  ];
  const plan = planBatches(cl, L);
  const v = (quote: string, line: number) => verifyMeetingClaims(
    { claims: [{ ref: "A1", type: "read", topic: "fit", quote, line_from: line, line_to: line, mode: "asserted" }] },
    { lines: L, batch: plan.batches[0], owners: plan.owners, tiers: TIERS, overrideCodes: OVERRIDE_CODES, removalReasons: REASONS },
  );
  const short = `ok ${emoji.repeat(5)}`;
  eq("a quote of 13 UTF-16 units but 8 characters is too short for the table, and refused here",
    [short.length, v(short, 1).claims.length, v(short, 1).counters.quote_length], [13, 0, 1]);
  eq("a quote of 12 real characters is kept", v("forty people", 1).claims.length, 1);

  const [row] = proposalRows({
    ...BASE, clusters: cl, lines: L,
    claims: [vc({ type: "read", key: null, value: null, topic: "timing", quote: "they want the rebuild before spring", line_from: 2, line_to: 2, quote_at: "00:00:09" })],
  });
  const ctx = row.context ?? "";
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  let chars = 0;
  for (const _ of ctx) chars++;
  eq("a context longer than 1,200 characters is clipped to 1,200 characters, not 1,200 UTF-16 units", chars, 1200);
  check("…and never cuts an emoji in half (a lone surrogate the database would refuse)", !lone.test(ctx));
}

/* ------------------------------------------------------------------ *
 * 5 · drift and purity
 * ------------------------------------------------------------------ */

{
  const prompt = claimsPrompt({ tiers: TIERS, overrideCodes: OVERRIDE_CODES, removalReasons: REASONS });
  const after = prompt.split("Keys and the values they may take:\n")[1] ?? "";
  const printed = after.split("\n\n")[0].split("\n").map((l) => l.trim().split(":")[0]);
  eq("the keys claimsPrompt prints are keysFor('sales_meeting')", printed, Object.keys(keysFor("sales_meeting")));
  eq("which is the whole EXTRACTABLE set", Object.keys(keysFor("sales_meeting")), Object.keys(EXTRACTABLE));

  const sample = (s: ClaimShape): unknown =>
    s.kind === "boolean" ? true : s.kind === "enum" ? s.values[0] : s.kind === "enum_list" ? [s.values[0]] : s.min;
  const accepted = Object.entries(keysFor("sales_meeting")).filter(([k, s]) =>
    verify([{ ref: "A1", type: "fact", key: k, value: sample(s), quote: "the budget is approved for the rebuild", line_from: 2, line_to: 2, mode: "asserted" }]).claims.length === 1,
  ).map(([k]) => k);
  eq("and every one of them is what the verifier accepts", accepted, printed);

  const other = claimsPrompt({ tiers: ["Feldspar", "Quartzite"], overrideCodes: ["c_one"], removalReasons: [{ disposition: "do_not_contact", code: "c_two" }] });
  check("tiers come from the input", other.includes('"Feldspar", "Quartzite"') && !/\bGold\b/.test(other) && other.includes('"Not a Quartzite"'));
  check("override codes come from the input", other.includes('"c_one"') && !other.includes("relationship_known"));
  check("removal codes come from the input", other.includes('do_not_contact: "c_two"') && !other.includes("x_asked"));
  check("an inactive code is never offered", !prompt.includes("x_legal"));
  check("the prompt is deterministic", claimsPrompt({ tiers: TIERS, overrideCodes: OVERRIDE_CODES, removalReasons: REASONS }) === prompt);

  const seg = segmentPrompt();
  check("pass 1 states the caps meeting_mentions enforces",
    seg.includes(`At most ${MAX_COMPANIES} companies`) && seg.includes(`up to ${MAX_AS_SAID} spellings`) &&
    seg.includes(`up to ${MAX_SEGMENTS} {`) && seg.includes(`up to ${MAX_MENTION_LINES} line numbers`));
  check("pass 1 is never shown the roster or a tier", !/\b(Bronze|Silver|Gold|Platinum)\b/.test(seg));
}

{
  const tierWords = new Set<string>();
  for (const f of readdirSync(join(root, "core")).filter((f) => /^rubric\..*\.json$/.test(f))) {
    const spec = JSON.parse(readFileSync(join(root, "core", f), "utf8")) as { vocabulary?: { tiers?: string[] } };
    for (const t of spec.vocabulary?.tiers ?? []) tierWords.add(t.toLowerCase());
  }
  check("the rubrics name tiers to look for", tierWords.size >= 4);
  const ALLOWED: Record<string, string[]> = {
    "meeting_transcript.ts": ["./fathom_webhook.ts", "./notes_sweep.ts"],
    "meeting_mentions.ts": ["./name_tokens.ts", "./notes_sweep.ts"],
    "meeting_claims.ts": ["./notes_sweep.ts", "./written_record.ts", "./meeting_transcript.ts"],
  };
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    const src = readFileSync(join(here, file), "utf8");
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    check(`${file} imports only its listed siblings`, imports.length > 0 && imports.every((i) => allowed.includes(i)), JSON.stringify(imports));
    check(`${file} reads no clock, network, randomness or filesystem`,
      !/Date\.now|new Date\(|performance\.now|Math\.random|\bfetch\(|\bDeno\.|\bprocess\.|readFileSync|\bimport\(/.test(src));
    const words = src.toLowerCase().match(/[a-z]+/g) ?? [];
    check(`${file} names no tier (tiers are data)`, !words.some((w) => tierWords.has(w)), [...new Set(words.filter((w) => tierWords.has(w)))].join(","));
    check(`${file} holds no removal code (codes are data)`, !src.includes("they_asked"));
    check(`${file} holds no override expiry (it is the rubric's)`, !/\b90\b/.test(src));
  }
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`meeting_claims_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("meeting_claims_test failed");
  }
} else {
  console.log(`meeting_claims_test: ${passed} checks passed`);
}
