/**
 * WLIQ Prospect Book — which agency a sales meeting was talking about, tests.
 *
 * Run:  node --experimental-strip-types ingest/meeting_mentions_test.ts
 *
 * Every agency, alias, domain and line here is INVENTED (rule 2); domains are .example. People
 * appear only as roles ('Rep A', 'Owner'), plus one role-shaped display name whose second word
 * collides with an invented agency on purpose. The placeholder names are the SHAPES of the live
 * placeholder rows (TBD, None, Test and the like), which carry no prospect data.
 */

import {
  buildRosterIndex,
  clusterMentions,
  domainLabel,
  FILLER_WORDS,
  OWN_NAMES,
  resolveMention,
  resolveSurface,
  saidKeyOf,
  speechKey,
  STOPLIST,
  surfaceOnLine,
  verifySegments,
} from "./meeting_mentions.ts";
import type { MentionResolution, RosterAccount, RosterInput, VerifiedMention } from "./meeting_mentions.ts";
import { FIRST_TOKEN_ALLOW, GENERIC } from "./name_tokens.ts";

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
 * the synthetic roster
 * ------------------------------------------------------------------ */

const acct = (id: string, name: string, o: Partial<RosterAccount> = {}): RosterAccount =>
  ({ id, name, domain: null, book: "prospect", merged_into: null, ...o });

const ACCOUNTS: RosterAccount[] = [
  acct("quill", "Quillfern Digital", { domain: "quillfern.example" }),
  acct("ngc", "Northgale Creative", { domain: "northgalecreative.example" }),
  acct("ngl", "Northgale Labs, Inc", { domain: "ngl.example", book: "parked" }),
  acct("blue", "Bluebarrow Ashgrove Media", { domain: "bba.example" }),
  acct("weak", "Weather"),
  acct("k1", "Kestrelmoor Interactive"),
  acct("k2", "Kestrelmore Studio"),
  acct("salt", "Saltmarsh Kiteworks"),
  acct("shift", "Shift Larkspur Partners"),
  acct("fern", "Fernhollow Media", { book: "merged", merged_into: "quill" }),
  acct("old", "Oldmill Partners", { book: "merged", merged_into: "gone" }),
  acct("gone", "Gonebye Design", { book: "promoted" }),
  // placeholder and junk rows: never a match, never an option
  acct("p1", "TBD"), acct("p2", "None"), acct("p3", "Test"), acct("p4", "Individual"),
  acct("p5", "Confidential"), acct("p6", "better"),
  acct("own", "White Label IQ"),
  acct("abc", "ABC"),
  acct("junk1", "Lorem Placeholder Co"),
  acct("junk2", "Driftwillow Studio", { domain: "junkdomain.example" }),
];

const ROSTER: RosterInput = {
  accounts: ACCOUNTS,
  resolution: [
    { account_id: "blue", slug: "bluebarrow-ashgrove" },
    { account_id: "k1", slug: "kestrelmoor" },
    { account_id: "k2", slug: "kestrelmore" },
    { account_id: "ngc", slug: "northgale-creative" },
  ],
  aliases: [
    { slug: "bluebarrow-ashgrove", alias: "BB Ashgrove", alias_type: "name", authoritative: true },
    { slug: "northgale-creative", alias: "NGC Studio", alias_type: "name", authoritative: false },
    { slug: "bluebarrow-ashgrove", alias: "https://www.bluebarrowgroup.example/", alias_type: "domain", authoritative: true },
  ],
  learned: [
    { said_key: "q fern", account_id: "quill", active: true },
    { said_key: "northy", account_id: "ngc", active: true },
    { said_key: "northy", account_id: "ngl", active: true },
    { said_key: "retired name", account_id: "quill", active: false },
  ],
  junk: [
    { kind: "name", value: "Lorem Placeholder Co" },
    { kind: "domain", value: "junkdomain.example" },
  ],
  poison_pairs: [{ slug_a: "kestrelmoor", slug_b: "kestrelmore" }],
  people: ["Rep A", "Rep Saltmarsh", "Owner"],
};

const INDEX = buildRosterIndex(ROSTER);
const R = (s: string) => resolveSurface(s, INDEX);

/* ------------------------------------------------------------------ *
 * 1 · keys
 * ------------------------------------------------------------------ */

eq("speechKey lowercases, folds & and drops a leading 'the'", speechKey("The Harbor & Pine Folks"), "harbor and pine folks");
eq("speechKey strips a possessive", speechKey("Quillfern’s"), "quillfern");
eq("speechKey turns punctuation into spaces", speechKey("Bluebarrow-Ashgrove, Inc."), "bluebarrow ashgrove inc");
eq("speechKey folds accents", speechKey("Café Ñandú"), "cafe nandu");
eq("speechKey is idempotent", speechKey(speechKey("  The  Quill   guys ")), speechKey("  The  Quill   guys "));
eq("domainLabel reads the registrable label", [domainLabel("https://www.quillfern.example/about"), domainLabel("studio.co.uk"), domainLabel("x")], ["quillfern", "studio", null]);
eq("saidKeyOf sorts and dedupes", saidKeyOf(["quill", "quillfern", "quill"]), "quill|quillfern");
check("the filler words are the spoken ones", FILLER_WORDS.includes("folks") && FILLER_WORDS.includes("guys"));
check("the matcher reads the names check's own lists", GENERIC.has("shift") && FIRST_TOKEN_ALLOW.has("weather"));

/* ------------------------------------------------------------------ *
 * 2 · refusals
 * ------------------------------------------------------------------ */

for (const p of ["TBD", "None", "Test", "Individual", "Confidential", "Better", "n/a", "Unknown"]) {
  eq(`the placeholder '${p}' never matches`, R(p).state, "refused");
}
for (const id of ["p1", "p2", "p3", "p4", "p5", "p6", "own", "junk1", "junk2"]) {
  check(`placeholder, own-name and junk rows are never options (${id})`, !INDEX.accounts.has(id));
}
for (const s of OWN_NAMES) eq(`our own name '${s}' never matches`, [R(s).state, R(s).reason], ["refused", "own_name"]);
eq("WLIQ in capitals is still us", R("WLIQ").reason, "own_name");
eq("STOPLIST words are refused", ["agency", "client", "prospect"].every((w) => STOPLIST.includes(w) && R(w).state === "refused"), true);
eq("a key under 4 characters is refused", [R("ABC").state, R("ABC").reason], ["refused", "short"]);
eq("a GENERIC single word as a sole key is refused", [R("Shift").state, R("Shift").reason], ["refused", "ordinary_word"]);
eq("an ordinary word is refused too", R("digital").state, "refused");
eq("a speaker's or invitee's name word equal to an agency token is refused", [R("Saltmarsh").state, R("Saltmarsh").reason], ["refused", "person"]);
eq("but the agency's whole name still resolves", [R("Saltmarsh Kiteworks").state, R("Saltmarsh Kiteworks").account_id], ["resolved", "salt"]);
eq("a junk name is refused", [R("Lorem Placeholder").state, R("Lorem Placeholder").reason], ["refused", "junk"]);
eq("a junk domain's label is refused", R("junkdomain").state, "refused");
eq("a junk-domain account's own name does not resolve", R("Driftwillow Studio").state, "unknown");

{
  eq("a merged row redirects to merged_into", [R("Fernhollow").state, R("Fernhollow").account_id], ["resolved", "quill"]);
  eq("a merged row whose target is not live contributes nothing", R("Oldmill Partners").state, "unknown");
  eq("a row in no live book is not matched", R("Gonebye Design").state, "unknown");
  check("a parked row is live", INDEX.accounts.has("ngl"));
}

/* ------------------------------------------------------------------ *
 * 3 · resolution
 * ------------------------------------------------------------------ */

{
  const r = R("the Quillfern folks");
  eq("'the Quillfern folks' → resolved on the name", [r.state, r.account_id, r.matched_on, r.key], ["resolved", "quill", "name", "quillfern"]);
  eq("the full name resolves too", R("Quillfern Digital").account_id, "quill");
  const b = R("Bluebarrow");
  eq("'Bluebarrow' (a distinctive token) → suggested, never resolved", [b.state, b.account_id, b.matched_on, b.options], ["suggested", null, "token", ["blue"]]);
  const p = R("the Quill guys");
  eq("'the Quill guys' → a prefix suggestion offering Quillfern", [p.state, p.account_id, p.matched_on, p.options], ["suggested", null, "prefix", ["quill"]]);
  eq("a prefix under half the token is nothing", R("Kest").state, "unknown");
  const n = R("Northgale");
  eq("'Northgale' → ambiguous with both", [n.state, n.account_id, n.options, n.reason], ["ambiguous", null, ["ngc", "ngl"], "shared"]);
  eq("'Northgale Creative' is one account", [R("Northgale Creative").state, R("Northgale Creative").account_id], ["resolved", "ngc"]);
  eq("a legal suffix is no part of the name", R("Northgale Labs").account_id, "ngl");
  const w = R("Weather");
  eq("the weak ordinary-word name is offered, never resolved", [w.state, w.account_id, w.options, w.reason], ["ambiguous", null, ["weak"], "weak_name"]);
  eq("a learned alias → resolved", [R("Q Fern").state, R("Q Fern").account_id, R("Q Fern").matched_on], ["resolved", "quill", "learned"]);
  const two = R("Northy");
  eq("two accounts learning one alias → ambiguous", [two.state, two.options], ["ambiguous", ["ngc", "ngl"]]);
  eq("an inactive learned alias is ignored", R("retired name").state, "unknown");
  eq("an authoritative alias → resolved", [R("BB Ashgrove").state, R("BB Ashgrove").account_id, R("BB Ashgrove").matched_on], ["resolved", "blue", "alias"]);
  eq("a non-authoritative alias only suggests", [R("NGC Studio").state, R("NGC Studio").matched_on], ["suggested", "alias"]);
  eq("a domain label suggests", [R("quillfern").state, R("Bluebarrowgroup").state, R("Bluebarrowgroup").matched_on], ["resolved", "suggested", "domain"]);
  eq("a split compound reaches the label", [R("Bluebarrow Group").state, R("Bluebarrow Group").matched_on], ["suggested", "domain"]);
  const k = R("Kestrelmoor Interactive");
  eq("either side of a poison pair → ambiguous, both offered", [k.state, k.options, k.reason], ["ambiguous", ["k1", "k2"], "poison_pair"]);
  eq("nothing → unknown", R("Brightquay Collective").state, "unknown");
  eq("resolution is deterministic", JSON.stringify(R("Northgale")), JSON.stringify(R("Northgale")));
}

/* ------------------------------------------------------------------ *
 * 4 · mentions: verifySegments, resolveMention, clusterMentions
 * ------------------------------------------------------------------ */

const LINES = [
  { n: 1, text: "Okay, first up is Quillfern Digital." },
  { n: 2, text: "The Quill guys said the budget is approved." },
  { n: 3, text: "They want to start this month." },
  { n: 4, text: "Northgale next. Northgale Creative is still quiet." },
  { n: 5, text: "Nothing since the call." },
  { n: 6, text: "We should move the CRM to the new tool." },
  { n: 7, text: "Back to Quillfern for a second, they asked about hosting." },
  { n: 8, text: "Brightquay Collective came up on the partner call." },
];

{
  const v = verifySegments({
    companies: [
      { ref: "C1", as_said: ["Quillfern Digital", "the Quill guys", "Quillfern", "Quilferne"], kind: "agency",
        segments: [{ from: 1, to: 3 }, { from: 7, to: 7 }], mention_lines: [1, 2, 7] },
      { ref: "C2", as_said: ["Northgale", "Northgale Creative"], kind: "agency", segments: [{ from: 4, to: 5 }, { from: 6, to: 6 }], mention_lines: [4] },
      { ref: "C3", as_said: ["Brightquay Collective"], kind: "unclear", segments: [{ from: 8, to: 8 }], mention_lines: [8] },
      { ref: "C4", as_said: ["the new tool"], kind: "tool", segments: [{ from: 6, to: 6 }], mention_lines: [6] },
      { ref: "C5", as_said: ["their client"], kind: "agency_client", segments: [{ from: 3, to: 3 }], mention_lines: [3] },
      { ref: "C6", as_said: ["WLIQ"], kind: "wliq", segments: [{ from: 1, to: 1 }], mention_lines: [1] },
      { ref: "C7", as_said: ["Rep A"], kind: "person", segments: [{ from: 1, to: 1 }], mention_lines: [1] },
      { ref: "C8", as_said: ["Phantom Works"], kind: "agency", segments: [{ from: 5, to: 5 }], mention_lines: [5] },
      { ref: "C9", as_said: ["Northgale"], kind: "agency", segments: [{ from: 1, to: 2 }], mention_lines: [9, 4] },
    ],
  }, LINES);
  eq("the agency_client, tool, wliq and person kinds are dropped", [v.counters.kind_tool, v.counters.kind_agency_client, v.counters.kind_wliq, v.counters.kind_person], [1, 1, 1, 1]);
  const c1 = v.mentions.find((m) => m.ref === "C1") as VerifiedMention;
  eq("a surface not on any cited line is dropped", c1.as_said, ["Quillfern Digital", "the Quill guys", "Quillfern"]);
  eq("and counted (this one, and the invented company below)", v.counters.as_said_not_on_line, 2);
  eq("both segments of a twice-discussed agency survive", c1.segments, [{ from: 1, to: 3 }, { from: 7, to: 7 }]);
  const c2 = v.mentions.find((m) => m.ref === "C2") as VerifiedMention;
  eq("a segment with no verified mention line is dropped", c2.segments, [{ from: 4, to: 5 }]);
  check("an unclear company is kept for a person", v.mentions.some((m) => m.ref === "C3"));
  check("a mention whose words are on no cited line is dropped", !v.mentions.some((m) => m.ref === "C8"));
  check("a segment holding none of the company's verified lines is dropped", !v.mentions.some((m) => m.ref === "C9"));
  eq("verified mentions are counted", v.counters.mentions_verified, 3);
  eq("an unreadable reply takes nothing", verifySegments("nope", LINES).mentions, []);

  const res = v.mentions.map((m) => resolveMention(m, INDEX));
  const r1 = res.find((m) => m.ref === "C1") as MentionResolution;
  eq("all three forms of Quillfern resolve to one account", [r1.state, r1.account_id], ["resolved", "quill"]);
  const r2 = res.find((m) => m.ref === "C2") as MentionResolution;
  eq("'Northgale' beside 'Northgale Creative' is not ambiguous", [r2.state, r2.account_id], ["resolved", "ngc"]);
  const r3 = res.find((m) => m.ref === "C3") as MentionResolution;
  eq("an outside company not in the book is unknown", r3.state, "unknown");

  const second = resolveMention({ ref: "C1", as_said: ["Quillfern"], kind: "agency", segments: [{ from: 7, to: 7 }], mention_lines: [7] }, INDEX);
  const clusters = clusterMentions([res[2], res[1], { ...r1, segments: [{ from: 1, to: 3 }] }, second]);
  eq("one cluster per account, in discussion order, refs A1..", clusters.map((c) => [c.ref, c.account_id, c.state]),
    [["A1", "quill", "resolved"], ["A2", "ngc", "resolved"], ["A3", null, "unknown"]]);
  eq("a cluster merges every resolved mention's segments", clusters[0].segments, [{ from: 1, to: 3 }, { from: 7, to: 7 }]);
  eq("said_key is the sorted speech keys", clusters[0].said_key, "quill|quillfern|quillfern digital");
  eq("said_key is stable whatever the input order", clusterMentions([second, { ...r1 }])[0].said_key, clusters[0].said_key);
}

{
  const amb = (ref: string, line: number): VerifiedMention =>
    ({ ref, as_said: ["Northgale"], kind: "agency", segments: [{ from: line, to: line }], mention_lines: [line] });
  const lines = [{ n: 1, text: "Northgale first." }, { n: 2, text: "Then Northgale again." }];
  const cl = clusterMentions([resolveMention(amb("X", 2), INDEX), resolveMention(amb("Y", 1), INDEX)]);
  eq("the same unplaced name said twice is one 'Who is this?' chip", cl.length, 1);
  eq("it keeps its options", [cl[0].state, cl[0].options, cl[0].said_key], ["ambiguous", ["ngc", "ngl"], "northgale"]);
  check("verifySegments sees whole words only", !surfaceOnLine("Northgalet Labs", "Northgale") && surfaceOnLine(lines[1].text, "northgale"));
}

{
  const refusedOnly = resolveMention({ ref: "C1", as_said: ["WLIQ", "TBD"], kind: "agency", segments: [{ from: 1, to: 1 }], mention_lines: [1] }, INDEX);
  eq("a mention every form of which is refused is refused", [refusedOnly.state, refusedOnly.reason], ["refused", "own_name"]);
  const mixed = resolveMention({ ref: "C1", as_said: ["WLIQ", "Quillfern"], kind: "agency", segments: [{ from: 1, to: 1 }], mention_lines: [1] }, INDEX);
  eq("a refused form beside a good one does not spoil it", [mixed.state, mixed.account_id, mixed.said_key], ["resolved", "quill", "quillfern"]);
  const conflict = resolveMention({ ref: "C1", as_said: ["Quillfern", "Bluebarrow Ashgrove"], kind: "agency", segments: [{ from: 1, to: 1 }], mention_lines: [1] }, INDEX);
  eq("two accounts named in one mention → ambiguous", [conflict.state, conflict.options], ["ambiguous", ["quill", "blue"]]);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`meeting_mentions_test: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
    (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
  } else {
    throw new Error("meeting_mentions_test failed");
  }
} else {
  console.log(`meeting_mentions_test: ${passed} checks passed`);
}
