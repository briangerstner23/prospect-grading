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
  joinAcrossWindows,
  MENTION_LEAD_LINES,
  MENTION_REACH_LINES,
  nearMentions,
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

/* A range cannot carry a company onto the next discussion: its lines reach only so far from a line
   its name was verified on, and the rest are cut and counted. */
{
  eq("the reach is five lines before a name and thirty after it", [MENTION_LEAD_LINES, MENTION_REACH_LINES], [5, 30]);
  eq("nearMentions: a range inside the reach is whole", nearMentions(10, 30, [12]), [{ from: 10, to: 30 }]);
  eq("nearMentions: a range running on is cut thirty lines after its name", nearMentions(10, 200, [12]), [{ from: 10, to: 42 }]);
  eq("nearMentions: and five lines before it", nearMentions(1, 50, [40]), [{ from: 35, to: 50 }]);
  eq("nearMentions: two names far apart keep their own stretches, not the gap", nearMentions(10, 300, [12, 200]), [{ from: 10, to: 42 }, { from: 195, to: 230 }]);
  eq("nearMentions: names close together are one stretch", nearMentions(10, 300, [12, 40]), [{ from: 10, to: 70 }]);

  const text = (n: number) =>
    n === 10 ? "Next is Quillfern Digital, they asked about a rebuild."
    : n === 120 ? "Back to Quillfern, they signed."
    : n === 60 ? "Other topic now: the conference in the spring."
    : `Line ${n} of the meeting.`;
  const long = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, text: text(i + 1) }));
  const v = verifySegments({
    companies: [
      { ref: "C1", as_said: ["Quillfern Digital", "Quillfern"], kind: "agency", segments: [{ from: 8, to: 130 }], mention_lines: [10, 120] },
      { ref: "C2", as_said: ["Quillfern"], kind: "agency", segments: [{ from: 115, to: 125 }], mention_lines: [120] },
    ],
  }, long);
  const c1 = v.mentions.find((m) => m.ref === "C1") as VerifiedMention;
  eq("a model's range over another discussion keeps only the lines near its names", c1.segments, [{ from: 8, to: 40 }, { from: 115, to: 130 }]);
  check("…so the talk between them is nobody's, not this company's", !c1.segments.some((sg) => sg.from <= 60 && sg.to >= 60));
  eq("the lines cut are counted, once per trimmed range", [v.counters.segment_trimmed, v.counters.segment_lines_trimmed], [1, 123 - 33 - 16]);
  const c2 = v.mentions.find((m) => m.ref === "C2") as VerifiedMention;
  eq("a range inside the reach is untouched", c2.segments, [{ from: 115, to: 125 }]);
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
 * 5 · one company across pass-1 windows: joinAcrossWindows
 *
 * A long meeting goes to pass 1 in overlapping windows, each a call that sees only its own lines.
 * One window puts "Vorn Digital" and "Vorn" in one entry; a window that only hears "Vorn" cannot.
 * These pin what is joined back, and — as much — what is not. All names INVENTED.
 * ------------------------------------------------------------------ */

{
  const JOIN = buildRosterIndex({
    accounts: [
      acct("vorn", "Vorn Digital"),
      acct("zell", "Zell Creative"),
      acct("orange", "Orange Wyvernhold"),
      acct("kvi", "Kestrelvane Interactive"),
      acct("kvs", "Kestrelvane Studio"),
      acct("bh", "Brindlecot Harrow Media"),
    ],
    people: ["Rep A", "Owner"],
  });
  const m = (ref: string, as_said: string[], lines: number[]): VerifiedMention => ({
    ref, as_said, kind: "agency",
    segments: [{ from: Math.min(...lines) - 2, to: Math.max(...lines) + 5 }],
    mention_lines: [...lines].sort((a, b) => a - b),
  });
  const res = (mm: VerifiedMention, idx = JOIN): MentionResolution => resolveMention(mm, idx);
  const J = (ws: VerifiedMention[][], idx = JOIN, ranges?: { from: number; to: number }[]) =>
    joinAcrossWindows(ws.map((w) => w.map((mm) => res(mm, idx))), idx, ranges);
  const at = (j: { resolutions: MentionResolution[] }, ref: string) => j.resolutions.find((r) => r.ref === ref) as MentionResolution;
  const S = (r: MentionResolution) => [r.state, r.account_id, r.matched_on, r.options];

  /* The short forms on their own: none of them resolves, so a window that hears only it cannot place it. */
  eq("join precondition: 'Vorn' alone is unknown (one word under the token length)", [resolveSurface("Vorn", JOIN).state], ["unknown"]);
  eq("join precondition: 'Zell' alone is unknown", resolveSurface("Zell", JOIN).state, "unknown");
  eq("join precondition: 'Orange' alone is an ordinary word", [resolveSurface("Orange", JOIN).state, resolveSurface("Orange", JOIN).reason], ["refused", "ordinary_word"]);
  eq("join precondition: 'Brindlecot' alone only suggests", [resolveSurface("Brindlecot", JOIN).state, resolveSurface("Brindlecot", JOIN).options], ["suggested", ["bh"]]);
  eq("join precondition: 'Kestrelvane' alone is shared by two accounts", [resolveSurface("Kestrelvane", JOIN).state, resolveSurface("Kestrelvane", JOIN).options], ["ambiguous", ["kvi", "kvs"]]);

  /* One window: nothing is joined, whatever the model listed apart. */
  {
    const one = [[m("C1", ["Vorn Digital", "Vorn"], [270, 290]), m("C2", ["Vorn"], [600])]];
    const j = J(one);
    eq("one window comes back exactly as resolveMention gave it", j.resolutions, one[0].map((mm) => res(mm)));
    eq("…with no counters", j.counters, {});
  }

  /* Across a seam / in the overlap: the second window re-reads lines the first one already placed. */
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290, 305])], [m("W2.C1", ["Vorn"], [290, 305])]]);
    eq("the overlap: 'Vorn' on lines the first window placed beside 'Vorn Digital' is the same sighting: placed", S(at(j, "W2.C1")), ["resolved", "vorn", "name", ["vorn"]]);
    eq("…counted as the same sighting", j.counters, { joined_same_lines: 1 });
    const cl = clusterMentions(j.resolutions);
    eq("…and the two windows are one card, so no line is owned twice", cl.map((c) => [c.state, c.account_id, c.sources]), [["resolved", "vorn", ["W1.C1", "W2.C1"]]]);
  }
  {
    /* The overlap line carries ANOTHER company too: only the words the other window grouped with the account are its. */
    const other = J([[m("W1.C1", ["Vorn Digital"], [290])], [m("W2.C1", ["Zell"], [290])]]);
    eq("the overlap: another company's short form on a line the first window placed is not joined to it", S(at(other, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing counted", other.counters, {});
    const besideToo = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [280, 290])], [m("W2.C1", ["Zell"], [290])]]);
    eq("…not even when the first window said a short form of its own there", S(at(besideToo, "W2.C1")), ["unknown", null, null, []]);
    const named = J([[m("W1.C1", ["Vorn Digital"], [290])], [m("W2.C1", ["Zell"], [290])], [m("W3.C1", ["Zell Creative"], [700])]]);
    eq("…and when the other company is named in full elsewhere, it suggests THAT account, not the line's", S(at(named, "W2.C1")), ["suggested", null, "token", ["zell"]]);
  }
  {
    /* The same sighting is ONE mention's: the lines one resolved mention cited and the words another
       carried, elsewhere in the meeting, are never pooled into one. */
    const pooled = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])],
      [m("W2.C1", ["Zell"], [290])],
      [m("W3.C1", ["Vorn Digital", "Zell"], [800, 801]), m("W3.C2", ["Zell Creative"], [820])],
    ]);
    eq("never: the overlap line from one mention and a word another window grouped elsewhere", S(at(pooled, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing joined on the same lines", pooled.counters.joined_same_lines, undefined);
    eq("…Vorn Digital's card holds only the mentions that named it", clusterMentions(pooled.resolutions).filter((c) => c.account_id === "vorn").map((c) => c.sources), [["W1.C1", "W3.C1"]]);
    const pooledOnly = J([
      [m("W1.C1", ["Vorn Digital"], [320])],
      [m("W2.C1", ["Zell"], [320])],
      [m("W3.C1", ["Vorn Digital", "Zell"], [700, 701])],
    ]);
    eq("never: pooled, even with Zell Creative not named in this meeting", S(at(pooledOnly, "W2.C1")), ["unknown", null, null, []]);
    eq("…no counters", pooledOnly.counters, {});
    const sharedPooled = J([
      [m("W1.C1", ["Kestrelvane Studio"], [320])],
      [m("W2.C1", ["Kestrelvane"], [320])],
      [m("W3.C1", ["Kestrelvane Studio", "Kestrelvane"], [700, 701])],
    ]);
    eq("never: a shared token on a line one mention cited, grouped with the account only on other lines", S(at(sharedPooled, "W2.C1")), ["ambiguous", null, null, ["kvs", "kvi"]]);
    eq("…counted only as offered first", sharedPooled.counters, { offered_first: 1 });
  }
  {
    /* A token two accounts share, re-read in the overlap: the first window grouped those very words on those very lines. */
    const j = J([[m("W1.C1", ["Kestrelvane Studio", "Kestrelvane"], [280, 290])], [m("W2.C1", ["Kestrelvane"], [290])]]);
    eq("the overlap: a shared token on the lines the first window placed is that account: the same sighting", S(at(j, "W2.C1")), ["resolved", "kvs", "name", ["kvs"]]);
  }

  /* THE RULE (13 Nov 2026): the join never places. Across every case below, a mention the join touched
     is 'suggested' with no account, never 'resolved' — what was resolved came resolved from its own window. */
  {
    const ws = [
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290, 305]), m("W1.C2", ["Zell Creative"], [100])],
      [m("W2.C1", ["Vorn"], [290, 305]), m("W2.C2", ["Brindlecot Harrow Media"], [400])],
      [m("W3.C1", ["Vorn"], [800]), m("W3.C2", ["Zell"], [820]), m("W3.C3", ["Brindlecot"], [840]), m("W3.C4", ["Orange"], [860])],
    ];
    const before = ws.map((w) => w.map((mm) => res(mm)));
    const j = J(ws);
    const resolvedBefore = new Set(before.flat().filter((r) => r.state === "resolved").map((r) => r.ref));
    check("the join resolves nothing its own window did not, but the same sighting (the overlap read twice)",
      j.resolutions.every((r) => r.state !== "resolved" || resolvedBefore.has(r.ref) || r.ref === "W2.C1"),
      JSON.stringify(j.resolutions.map((r) => [r.ref, r.state])));
    eq("…which is placed: the same words on the same lines another window resolved", S(at(j, "W2.C1")), ["resolved", "vorn", "name", ["vorn"]]);
    const touched = j.resolutions.filter((r) => r.reason === "named_in_another_window");
    eq("…the mentions it suggested are exactly the later short forms", touched.map((r) => r.ref).sort(), ["W3.C1", "W3.C2", "W3.C3"]);
    check("…and every one carries no account", touched.every((r) => r.account_id === null && r.state === "suggested"));
    check("…while the ones it suggested are read by pass 2 (suggested, not unknown)", ["W3.C1", "W3.C2", "W3.C3"].every((ref) => at(j, ref).state === "suggested"),
      JSON.stringify(j.resolutions.map((r) => [r.ref, r.state])));
  }

  /* The same sighting, window-aware (13 Nov 2026). Lines the naming window could see must be ones its
     mention cited, and only those are placed. A cited line past its edge is a sighting that window never
     heard: it is split off with its own reach and read on as a mention of its own — never placed by the
     token it shares (review of 53249b8). */
  {
    const ranges = [{ from: 1, to: 315 }, { from: 276, to: 589 }];
    const ws = [[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290, 305])], [m("W2.C1", ["Vorn"], [290, 305, 320])]];
    const aware = J(ws, JOIN, ranges);
    const parts = aware.resolutions.filter((r) => r.ref === "W2.C1");
    eq("past the overlap: the lines both windows saw are placed, the line past the edge is asked about",
      parts.map((r) => [r.state, r.account_id, r.mention_lines, r.segments]),
      [["resolved", "vorn", [290, 305], [{ from: 288, to: 325 }]], ["suggested", null, [320], [{ from: 315, to: 325 }]]]);
    eq("…counted: one same sighting, one split, the split part suggested by name", aware.counters, { joined_same_lines: 1, split_past_edge: 1, suggested_by_name: 1 });
    eq("…two cards: the placed discussion, and a question for the line only the later window heard",
      clusterMentions(aware.resolutions).map((c) => [c.state, c.account_id, c.sources]), [["resolved", "vorn", ["W1.C1", "W2.C1"]], ["suggested", null, ["W2.C1"]]]);
    const whole = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290, 305])], [m("W2.C1", ["Vorn"], [290, 305])]], JOIN, ranges);
    eq("all of its lines inside the naming window: placed whole, no split", [S(at(whole, "W2.C1")), whole.counters], [["resolved", "vorn", "name", ["vorn"]], { joined_same_lines: 1 }]);
    eq("…without the ranges, the strict rule: a question card", S(at(J(ws), "W2.C1"))[0], "suggested");
    const unseen = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [m("W2.C1", ["Vorn"], [290, 300, 320])]], JOIN, ranges);
    eq("never: a line the naming window could see but did not cite", S(at(unseen, "W2.C1"))[0], "suggested");
    const none = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [m("W2.C1", ["Vorn"], [400, 420])]], JOIN, ranges);
    eq("never: no line shared with the naming window's mention", S(at(none, "W2.C1"))[0], "suggested");

    /* A token two accounts share, past the edge: the later sighting stays a "Who is this?" card. */
    const kv = J([[m("W1.C1", ["Kestrelvane Studio", "Kestrelvane"], [280, 290])], [m("W2.C1", ["Kestrelvane"], [290, 500])]], JOIN, ranges);
    const kvParts = kv.resolutions.filter((r) => r.ref === "W2.C1");
    eq("a shared token past the edge: the overlap line placed, the far line still ambiguous, the named account first",
      kvParts.map((r) => [r.state, r.account_id, r.mention_lines, r.options[0]]), [["resolved", "kvs", [290], "kvs"], ["ambiguous", null, [500], "kvs"]]);
    const kvCards = clusterMentions(kv.resolutions);
    check("…and no resolved card owns the far line or its reach", kvCards.filter((c) => c.state === "resolved").every((c) =>
      !c.mention_lines.includes(500) && c.segments.every((g) => g.to < 495)), JSON.stringify(kvCards.map((c) => [c.state, c.account_id, c.segments])));

    /* A word another live account has, past the edge: never carried onto the account the overlap placed. */
    const VPG = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("vpg", "Vorn Partners Group")], people: ["Rep A", "Owner"] });
    const vp = J([[m("W1.C1", ["Vorn Partners Group"], [100]), m("W1.C2", ["Vorn Digital", "Vorn"], [270, 300])], [m("W2.C1", ["Vorn"], [300, 550])]], VPG, ranges);
    const vpParts = vp.resolutions.filter((r) => r.ref === "W2.C1");
    eq("a word two accounts have, past the edge: the overlap line placed, the far line a question, the placed account first",
      vpParts.map((r) => [r.state, r.account_id, r.mention_lines, r.options[0], r.reason]), [["resolved", "vorn", [300], "vorn", null], ["ambiguous", null, [550], "vorn", "split_past_edge"]]);
    check("…and no resolved card owns line 550", clusterMentions(vp.resolutions).filter((c) => c.state === "resolved").every((c) =>
      c.segments.every((g) => g.to < 545)));

    /* A split part that would have stayed refused (ordinary words, one shared) is made a question, so it
       owns its reach: otherwise the line past the edge is the placed card's alone (review of b77acfd). */
    const OS = buildRosterIndex({
      accounts: [acct("os", "Orange Social"), acct("vorn", "Vorn Digital"), acct("bms", "Brackmoor Social")],
      people: ["Rep A", "Owner"],
    });
    const os = J([[m("W1.C1", ["Orange Social", "Orange", "Social"], [268, 272, 290])], [m("W2.C1", ["Orange", "Social"], [290, 318])]], OS, ranges);
    const osParts = os.resolutions.filter((r) => r.ref === "W2.C1");
    eq("ordinary words past the edge, one shared: the far part is a question, never left refused",
      osParts.map((r) => [r.state, r.account_id, r.mention_lines, r.reason]), [["resolved", "os", [290], null], ["ambiguous", null, [318], "split_past_edge"]]);
    eq("…offering the placed account first, then the other one the word could mean", osParts[1]?.options.slice(0, 2), ["os", "bms"]);
    const osCards = clusterMentions(os.resolutions);
    check("…and both cards reach line 318", osCards.filter((c) => c.segments.some((g) => g.from <= 318 && g.to >= 318)).length === 2,
      JSON.stringify(osCards.map((c) => [c.state, c.segments])));
    eq("…with a name of its own words", osCards.find((c) => c.state === "ambiguous")?.said_key, "orange|social");

    /* Past-edge lines no stretch of discussion reaches are dropped, never a card read with nothing to read. */
    const bare = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])],
      [{ ref: "W2.C1", as_said: ["Vorn"], kind: "agency", segments: [{ from: 285, to: 300 }], mention_lines: [290, 340] }]], JOIN, ranges);
    eq("a past-edge line with no reach: dropped, the overlap line placed", [bare.resolutions.filter((r) => r.ref === "W2.C1").map((r) => [r.state, r.mention_lines]), bare.counters],
      [[["resolved", [290]]], { joined_same_lines: 1, split_no_reach: 1 }]);
    check("…and no card carries the line or an empty stretch", clusterMentions(bare.resolutions).every((c) => !c.mention_lines.includes(340) && c.segments.length > 0));
  }

  /* Question cards born from ordinary words keep their own names (13 Nov 2026): two of them must never
     share a card key, or they become one card, one fingerprint, one click for two agencies. */
  {
    const ORD = buildRosterIndex({
      accounts: [acct("vorn", "Vorn Digital"), acct("orange", "Orange Wyvernhold"), acct("silver", "Silver Quenmarsh")],
      people: ["Rep A", "Owner"],
    });
    const j = J([
      [m("W1.C1", ["Orange Wyvernhold", "Orange"], [100, 110]), m("W1.C2", ["Silver Quenmarsh", "Silver"], [200, 210])],
      [],
      [m("W3.C1", ["Orange"], [800]), m("W3.C2", ["Silver"], [850])],
    ], ORD);
    const asks = clusterMentions(j.resolutions).filter((c) => c.state === "suggested");
    eq("ordinary-word questions: one card each, under their own spoken names", asks.map((c) => [c.said_key, c.options[0]]).sort(), [["orange", "orange"], ["silver", "silver"]]);
    check("…and no card pass 2 reads has an empty name", clusterMentions(j.resolutions).every((c) => c.state === "resolved" || c.state === "refused" || c.state === "unknown" || c.said_key !== ""),
      JSON.stringify(clusterMentions(j.resolutions).map((c) => [c.state, c.said_key])));

    const PPL = buildRosterIndex({
      accounts: [acct("vorn", "Vorn Digital"), acct("orange", "Orange Wyvernhold")],
      people: ["Rep A", "Owner", "Dana Example"],
    });
    const withPerson = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [100, 110])], [], [m("W3.C1", ["Orange", "Dana"], [800])]], PPL);
    eq("…a person at the meeting never enters a question's name (it would be learned)",
      clusterMentions(withPerson.resolutions).filter((c) => c.state === "suggested").map((c) => c.said_key), ["orange"]);
    const placedOrd = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [270, 290])], [m("W2.C1", ["Orange"], [290])]], ORD,
      [{ from: 1, to: 315 }, { from: 276, to: 589 }]);
    eq("…a same sighting of an ordinary word leaves the resolved card's name as its live forms make it",
      clusterMentions(placedOrd.resolutions).map((c) => [c.state, c.account_id, c.said_key]), [["resolved", "orange", "orange wyvernhold"]]);
  }

  /* One rule groups and names a question card (review of b77acfd): "Orange" heard with a fragment in one
     window and alone in another is one card named "orange", not two cards with one name and one
     fingerprint, one of them dropped. */
  {
    const ORD2 = buildRosterIndex({
      accounts: [acct("vorn", "Vorn Digital"), acct("orange", "Orange Wyvernhold")],
      people: ["Rep A", "Owner"],
    });
    eq("precondition: 'OQ' alone is refused as too short", [resolveSurface("OQ", ORD2).state, resolveSurface("OQ", ORD2).reason], ["refused", "short"]);
    const j = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [100, 110])], [m("W2.C1", ["Orange", "OQ"], [400])], [m("W3.C1", ["Orange"], [800])]], ORD2);
    eq("the same ordinary name with and without a fragment: ONE question card",
      clusterMentions(j.resolutions).filter((c) => c.state === "suggested").map((c) => [c.said_key, c.sources]), [["orange", ["W2.C1", "W3.C1"]]]);
    const keys = clusterMentions(j.resolutions).map((c) => `${c.state}:${c.account_id ?? c.said_key}`);
    eq("…and no two cards share a state and a name", keys.length, new Set(keys).size);
  }

  /* One card per name pass 2 reads, whatever state each mention came out in (review of 4d16910): a short
     form ambiguous in one window (both accounts named only elsewhere) and suggested in another (its own
     window named one) is ONE card, as cautious as its most cautious mention — never two cards whose
     claims share a fingerprint, the later one dropped on insert. */
  {
    const BB = buildRosterIndex({
      accounts: [acct("bh", "Brindlecot Harrow Media"), acct("bw", "Brindlewood Harrow Studio"), acct("zd", "Zarquell Digital")],
      people: ["Rep A"],
    });
    const j = J([[m("W1.C1", ["Brindlecot Harrow Media", "Brindle"], [100, 110])], [m("W2.C1", ["Brindle"], [400])],
      [m("W3.C1", ["Brindlewood Harrow Studio"], [700]), m("W3.C2", ["Brindle"], [800])]], BB);
    eq("precondition: the one short form comes out in two states", ["W2.C1", "W3.C2"].map((ref) => at(j, ref).state), ["ambiguous", "suggested"]);
    const readable = clusterMentions(j.resolutions).filter((c) => c.state === "suggested" || c.state === "ambiguous");
    eq("…ONE card for the name, ambiguous, both mentions on it, both agencies offered",
      readable.map((c) => [c.said_key, c.state, c.reason, c.sources, [...c.options].sort()]), [["brindle", "ambiguous", "conflicting_names", ["W2.C1", "W3.C2"], ["bh", "bw"]]]);
    const names = readable.map((c) => c.said_key);
    eq("…no two cards pass 2 reads share a name (so none can share a fingerprint)", names.length, new Set(names).size);
    const unread = J([[m("W1.C1", ["Vorn Digital"], [100])], [m("W2.C1", ["Quorvath"], [400])], [m("W3.C1", ["Quorvath"], [800])]], BB);
    check("…while an unread mention never joins a read card", clusterMentions(unread.resolutions).every((c) => c.state === "unknown" || c.state === "resolved" || c.state === "refused"),
      JSON.stringify(clusterMentions(unread.resolutions).map((c) => [c.state, c.said_key])));
  }

  /* Remembering a name never teaches an ordinary word (review of 53249b8): a learned alias places with no
     person, and "orange" learned for one agency would place every later "Orange" on it. The rest of a
     remembered key is still learned. */
  {
    const L = buildRosterIndex({
      accounts: [acct("vorn", "Vorn Digital"), acct("orange", "Orange Wyvernhold"), acct("ofc", "Orange Fieldcrest")],
      learned: [{ said_key: "orange", account_id: "orange" }, { said_key: "orange|vornie", account_id: "vorn" }],
      people: ["Rep A"],
    });
    eq("learned: an ordinary word is not learned", [resolveSurface("Orange", L).state, resolveSurface("Orange", L).reason], ["refused", "ordinary_word"]);
    eq("…the rest of the key is", [resolveSurface("Vornie", L).state, resolveSurface("Vornie", L).account_id, resolveSurface("Vornie", L).matched_on], ["resolved", "vorn", "learned"]);
    eq("…and another account's full name said beside the word still resolves",
      [resolveMention({ ref: "C1", as_said: ["Orange Fieldcrest", "Orange"], kind: "agency", segments: [{ from: 1, to: 5 }], mention_lines: [2] }, L).state,
       resolveMention({ ref: "C1", as_said: ["Orange Fieldcrest", "Orange"], kind: "agency", segments: [{ from: 1, to: 5 }], mention_lines: [2] }, L).account_id],
      ["resolved", "ofc"]);
  }

  /* Window 1, then window 3, by a short form. */
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vorn"], [800, 805])]]);
    eq("window 1 → 3: 'Vorn', said beside the name in window 1, is suggested in window 3, that account first — never placed", S(at(j, "W3.C1")), ["suggested", null, "token", ["vorn"]]);
    eq("…counted as suggested by name", j.counters, { suggested_by_name: 1 });
    eq("…two cards: the named discussion settled, the later one asking, both read", clusterMentions(j.resolutions).map((c) => [c.state, c.account_id, c.segments]), [["resolved", "vorn", [{ from: 268, to: 295 }]], ["suggested", null, [{ from: 798, to: 810 }]]]);
  }
  {
    const j = J([[m("W1.C1", ["Zell Creative"], [100])], [], [m("W3.C1", ["Zell"], [700])]]);
    eq("window 1 → 3: the account's own short name joins though window 1 never said it alone", S(at(j, "W3.C1")), ["suggested", null, "token", ["zell"]]);
  }
  {
    const j = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindlecot"], [760])]]);
    eq("window 1 → 3: a distinctive token that only suggested the account this meeting named is joined", S(at(j, "W3.C1")), ["suggested", null, "token", ["bh"]]);
  }
  {
    const beside = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])], [], [m("W3.C1", ["Orange"], [750])]]);
    eq("window 1 → 3: an ordinary word of the name, said beside it, is joined", S(at(beside, "W3.C1")), ["suggested", null, "token", ["orange"]]);
    const never = J([[m("W1.C1", ["Orange Wyvernhold"], [400])], [], [m("W3.C1", ["Orange"], [750])]]);
    eq("…but an ordinary word never said beside the name stays refused", [at(never, "W3.C1").state, at(never, "W3.C1").reason], ["refused", "ordinary_word"]);
    /* No account on this roster has the word, so only the word-of-its-own-name rule refuses it. */
    const NO_ORANGE = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("zell", "Zell Creative")] });
    eq("ordinary-word precondition: 'Orange' alone is refused on a roster none of whose names has it", [resolveSurface("Orange", NO_ORANGE).state, resolveSurface("Orange", NO_ORANGE).reason], ["refused", "ordinary_word"]);
    const notItsName = J([[m("W1.C1", ["Vorn Digital", "Orange"], [270, 271])], [], [m("W3.C1", ["Orange"], [800])]], NO_ORANGE);
    eq("never: an ordinary word said beside a name it is not a word of", [at(notItsName, "W3.C1").state, at(notItsName, "W3.C1").reason, at(notItsName, "W3.C1").account_id], ["refused", "ordinary_word", null]);
    eq("…nothing joined", notItsName.counters, {});
  }
  {
    /* The own short name is no key while another account holds that word as a key (here a registry alias). */
    const ALIASED = buildRosterIndex({
      accounts: [acct("zell", "Zell Creative"), acct("qs", "Quarrystone Partners")],
      aliases: [{ slug: "qs-slug", alias: "Zell", alias_type: "name", authoritative: false }],
      resolution: [{ account_id: "qs", slug: "qs-slug" }],
    });
    eq("aliased precondition: 'Zell' alone suggests the account whose alias it is", [resolveSurface("Zell", ALIASED).state, resolveSurface("Zell", ALIASED).options], ["suggested", ["qs"]]);
    const j = J([[m("W1.C1", ["Zell Creative"], [100])], [], [m("W3.C1", ["Zell"], [700])]], ALIASED);
    eq("never: an own short name another account holds as a key — the mention stays as it was", S(at(j, "W3.C1")), ["suggested", null, "alias", ["qs"]]);
    eq("…nothing joined, nothing made ambiguous", j.counters, {});
  }
  {
    const j = J([[m("W1.C1", ["Kestrelvane Studio", "Kestrelvane"], [150, 152])], [], [m("W3.C1", ["Kestrelvane"], [720])]]);
    eq("window 1 → 3: a token two accounts share is never joined — it stays 'Who is this?'", [at(j, "W3.C1").state, at(j, "W3.C1").account_id], ["ambiguous", null]);
    eq("…with the account this meeting named offered first", at(j, "W3.C1").options, ["kvs", "kvi"]);
    eq("…counted", j.counters, { offered_first: 1 });
  }
  {
    /* Offered first is decided per CARD: clusterMentions merges every unplaced mention of one spoken name. */
    const apart = J([
      [m("W1.C1", ["Kestrelvane Studio"], [150]), m("W1.C2", ["Kestrelvane"], [160])],
      [],
      [m("W3.C1", ["Kestrelvane"], [720])],
    ]);
    const card = clusterMentions(apart.resolutions).find((c) => c.state === "ambiguous");
    eq("per card: listed apart in the window that named the account, the card keeps the roster's order", [card?.options, card?.sources], [["kvi", "kvs"], ["W1.C2", "W3.C1"]]);
    eq("…every mention of it carries that order", [at(apart, "W1.C2").options, at(apart, "W3.C1").options], [["kvi", "kvs"], ["kvi", "kvs"]]);
    eq("…and nothing is counted as offered first", apart.counters, {});
    const later = J([
      [m("W1.C1", ["Kestrelvane Studio", "Kestrelvane"], [150, 152])],
      [m("W2.C1", ["Kestrelvane"], [500])],
      [m("W3.C1", ["Kestrelvane"], [720])],
    ]);
    const card2 = clusterMentions(later.resolutions).find((c) => c.state === "ambiguous");
    eq("per card: heard alone in two later windows, the card offers the account first", [card2?.options, card2?.sources], [["kvs", "kvi"], ["W2.C1", "W3.C1"]]);
    eq("…counted once, for the one card", later.counters, { offered_first: 1 });
    /* The reverse order: the card's FIRST mention would offer the account first, a later one would not. */
    const reverse = J([
      [m("W1.C1", ["Kestrelvane"], [100])],
      [],
      [m("W3.C1", ["Kestrelvane Studio"], [700]), m("W3.C2", ["Kestrelvane"], [720])],
    ]);
    const card3 = clusterMentions(reverse.resolutions).find((c) => c.state === "ambiguous");
    eq("per card, reverse order: a later mention listed apart in the naming window keeps the roster's order", [card3?.options, card3?.sources], [["kvi", "kvs"], ["W1.C1", "W3.C2"]]);
    eq("…every mention of it carries that order", [at(reverse, "W1.C1").options, at(reverse, "W3.C2").options], [["kvi", "kvs"], ["kvi", "kvs"]]);
    eq("…and nothing is counted as offered first", reverse.counters, {});
  }
  {
    /* A form said beside one account that the roster ALSO offers for another: both hold it. */
    const BRINDLEMOOR = buildRosterIndex({ accounts: [acct("bh", "Brindlecot Harrow Media"), acct("bm", "Brindlemoor Studio")] });
    eq("offered-with precondition: 'Brindle' suggests both accounts by prefix", [resolveSurface("Brindle", BRINDLEMOOR).state, resolveSurface("Brindle", BRINDLEMOOR).options], ["suggested", ["bh", "bm"]]);
    const j = J([
      [m("W1.C1", ["Brindlecot Harrow Media", "Brindle"], [120, 121])],
      [m("W2.C1", ["Brindlemoor Studio"], [400])],
      [m("W3.C1", ["Brindle"], [760])],
    ], BRINDLEMOOR);
    eq("never: a form said beside one account that the roster offers for another this meeting named — ambiguous", [at(j, "W3.C1").state, at(j, "W3.C1").options, at(j, "W3.C1").reason], ["ambiguous", ["bh", "bm"], "conflicting_names"]);
    eq("…counted as conflicting", j.counters, { conflicting_names: 1 });
  }

  /* What is never joined. */
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vron"], [800])]]);
    eq("never: a mistranscription heard only in a later window (the known limit) stays unknown", S(at(j, "W3.C1")), ["unknown", null, null, []]);
  }
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vorn Labs", "Vorn"], [800, 801])]]);
    eq("never: a mention with a form that points nowhere ('Vorn Labs') stays as it was", at(j, "W3.C1").state, "unknown");
  }
  {
    const j = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])],
      [m("W2.C1", ["Vorn Digital"], [400]), m("W2.C2", ["Vorn"], [500])],
    ]);
    eq("never: a form its own window listed apart from the account it placed", at(j, "W2.C2").state, "unknown");
    /* The guard itself: a form pointing at the account its OWN window resolved stops the mention, even
       when another of its forms points at an account resolved elsewhere. */
    const mixed = J([
      [m("W1.C1", ["Brindlecot Harrow Media"], [120])],
      [m("W2.C1", ["Vorn Digital"], [400]), m("W2.C2", ["Vorn", "Brindlecot"], [500])],
    ]);
    eq("never: a mention carrying a form of the account its own window resolved, beside another account's", S(at(mixed, "W2.C2")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", mixed.counters, {});
  }
  {
    /* The window that NAMED the account listed the short form apart from it: that judgement holds in every other window. */
    const overlap = J([
      [m("W1.C1", ["Brindlecot Harrow Media"], [270]), m("W1.C2", ["Brindlecot"], [280])],
      [m("W2.C1", ["Brindlecot"], [280])],
    ]);
    eq("never: the overlap's copy of a line whose short form the naming window listed apart", S(at(overlap, "W2.C1")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", overlap.counters, {});
    eq("…one 'Who is this?' card holds both copies of the line, and the account's card does not", clusterMentions(overlap.resolutions).map((c) => [c.state, c.account_id, c.sources, c.mention_lines]),
      [["resolved", "bh", ["W1.C1"], [270]], ["suggested", null, ["W1.C2", "W2.C1"], [280]]]);
    const vorn = J([
      [m("W1.C1", ["Vorn Digital"], [270]), m("W1.C2", ["Vorn"], [280])],
      [m("W2.C1", ["Vorn"], [280])],
    ]);
    eq("never: …nor an own short name the naming window listed apart", S(at(vorn, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", vorn.counters, {});
    const later = J([
      [m("W1.C1", ["Brindlecot Harrow Media"], [120]), m("W1.C2", ["Brindlecot"], [130])],
      [],
      [m("W3.C1", ["Brindlecot"], [760])],
    ]);
    eq("never: a short form the naming window listed apart, heard again in a later window", S(at(later, "W3.C1")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", later.counters, {});
    const sighted = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 280]), m("W1.C2", ["Vorn"], [500])],
      [m("W2.C1", ["Vorn"], [280])],
    ]);
    eq("never: a same sighting, while the naming window also listed the word apart", S(at(sighted, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", sighted.counters, {});
    /* Listed apart in a window that never named the account is no judgement about it. */
    const blind = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [m("W2.C1", ["Vorn"], [520])], [m("W3.C1", ["Vorn"], [800])]]);
    eq("still: a short form heard alone in two windows that never named the account joins both", [S(at(blind, "W2.C1")), S(at(blind, "W3.C1")), blind.counters], [["suggested", null, "token", ["vorn"]], ["suggested", null, "token", ["vorn"]], { suggested_by_name: 2 }]);
  }
  {
    const PEOPLE = buildRosterIndex({ accounts: [acct("zell", "Zell Creative")], people: ["Rep A", "Rik Zell"] });
    const j = J([[m("W1.C1", ["Zell Creative", "Zell"], [100, 101])], [], [m("W3.C1", ["Zell"], [700])]], PEOPLE);
    eq("never: a word of anyone at the meeting", [at(j, "W3.C1").state, at(j, "W3.C1").reason], ["refused", "person"]);
  }
  {
    const TWO = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("vpg", "Vorn Partners Group")] });
    const own = J([[m("W1.C1", ["Vorn Digital"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], TWO);
    eq("never: an own short name another live account also has as a word", at(own, "W3.C1").state, "unknown");
    const both = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 271])],
      [m("W2.C1", ["Vorn Partners Group", "Vorn"], [400, 401])],
      [m("W3.C1", ["Vorn"], [800])],
    ], TWO);
    eq("never: a short form said beside two accounts' names", at(both, "W3.C1").state, "unknown");

    /* Said beside ONE of the two names: the roster still holds the word for the other. */
    const oneWindow = J([[
      m("C1", ["Vorn Digital", "Vorn"], [270, 290]), m("C2", ["Vorn Partners Group"], [520]), m("C3", ["Vorn"], [800]),
    ]], TWO);
    eq("shared word, one window: the bare 'Vorn' listed apart is unknown", at(oneWindow, "C3").state, "unknown");
    const otherNamed = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])],
      [m("W2.C1", ["Vorn Partners Group"], [520])],
      [m("W3.C1", ["Vorn"], [800])],
    ], TWO);
    eq("never: a word said beside one name while another account with that word is named in full elsewhere", S(at(otherNamed, "W3.C1")), ["unknown", null, null, []]);
    eq("…no counters", otherNamed.counters, {});
    eq("…two cards: the bare 'Vorn' does not join Vorn Digital's", clusterMentions(otherNamed.resolutions).map((c) => [c.state, c.account_id, c.sources]),
      [["resolved", "vorn", ["W1.C1"]], ["resolved", "vpg", ["W2.C1"]], ["unknown", null, ["W3.C1"]]]);
    const sameWindow = J([
      [m("W1.C1", ["Vorn Digital", "Vorn"], [270, 271])],
      [],
      [m("W3.C1", ["Vorn Partners Group"], [790]), m("W3.C2", ["Vorn"], [800])],
    ], TWO);
    eq("never: a word said beside one name, heard ten lines after the other account's full name", S(at(sameWindow, "W3.C2")), ["unknown", null, null, []]);
    const unnamed = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vorn"], [800])]], TWO);
    eq("never: a word said beside one name while another LIVE account has it, named in this meeting or not", at(unnamed, "W3.C1").state, "unknown");
  }
  {
    /* The roster knows a name for ANOTHER account that has the word: a merged row, an alias, a learned alias. */
    const base = [acct("vorn", "Vorn Digital"), acct("quill", "Quillfern Digital")];
    const holders: Array<[string, RosterInput, string]> = [
      ["a merged row's name", { accounts: [...base, acct("vp", "Vorn Partners", { book: "merged", merged_into: "quill" })] }, "resolved"],
      ["an authoritative alias", {
        accounts: base, resolution: [{ account_id: "quill", slug: "q-slug" }],
        aliases: [{ slug: "q-slug", alias: "Vorn Partners", alias_type: "name", authoritative: true }],
      }, "resolved"],
      ["a non-authoritative alias", {
        accounts: base, resolution: [{ account_id: "quill", slug: "q-slug" }],
        aliases: [{ slug: "q-slug", alias: "Vorn Partners", alias_type: "name", authoritative: false }],
      }, "suggested"],
      ["a learned alias", { accounts: base, learned: [{ said_key: "vorn partners", account_id: "quill" }] }, "resolved"],
    ];
    for (const [what, input, state] of holders) {
      const idx = buildRosterIndex(input);
      const pre = resolveSurface("Vorn Partners", idx);
      eq(`${what} precondition: 'Vorn Partners' speaks for the other account`, [pre.state, pre.options], [state, ["quill"]]);
      const own = J([[m("W1.C1", ["Vorn Digital"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], idx);
      eq(`never: an own short name that is a word of ${what} of another account`, S(at(own, "W3.C1")), ["unknown", null, null, []]);
      eq(`…nothing joined (${what})`, own.counters, {});
      const said = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 271])], [], [m("W3.C1", ["Vorn"], [800])]], idx);
      eq(`never: a word said beside the name that is a word of ${what} of another account`, S(at(said, "W3.C1")), ["unknown", null, null, []]);
    }
    /* A merged duplicate of the SAME account holds nothing against it. */
    const SELF = buildRosterIndex({ accounts: [...base, acct("vd2", "Vorn Partners", { book: "merged", merged_into: "vorn" })] });
    const self = J([[m("W1.C1", ["Vorn Digital"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], SELF);
    eq("still: a merged row of the account itself does not stop its own short name", S(at(self, "W3.C1")), ["suggested", null, "token", ["vorn"]]);
  }
  {
    const ORANGES = buildRosterIndex({ accounts: [acct("ow", "Orange Wyvernhold"), acct("of", "Orange Fieldcrest")] });
    const j = J([
      [m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])],
      [m("W2.C1", ["Orange Fieldcrest"], [520])],
      [m("W3.C1", ["Orange"], [800])],
    ], ORANGES);
    eq("never: an ordinary word of two accounts' names, said beside one of them", [at(j, "W3.C1").state, at(j, "W3.C1").reason, at(j, "W3.C1").account_id], ["refused", "ordinary_word", null]);
    /* Beside another account's short form, the shared ordinary word still points away from it. */
    const VORN_ORANGES = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("ow", "Orange Wyvernhold"), acct("of", "Orange Fieldcrest")] });
    const mixed = J([
      [m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])],
      [m("W2.C1", ["Vorn Digital"], [500])],
      [m("W3.C1", ["Vorn", "Orange"], [800])],
    ], VORN_ORANGES);
    eq("never: a short form beside an ordinary word this meeting said beside another account, which the roster shares", S(at(mixed, "W3.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", mixed.counters, {});
    const VORN_ORANGE = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("ow", "Orange Wyvernhold")] });
    const mixedOne = J([
      [m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])],
      [m("W2.C1", ["Vorn Digital"], [500])],
      [m("W3.C1", ["Vorn", "Orange"], [800])],
    ], VORN_ORANGE);
    eq("…with one account holding the word, two accounts named: ambiguous, never placed", [at(mixedOne, "W3.C1").state, at(mixedOne, "W3.C1").options, at(mixedOne, "W3.C1").reason], ["ambiguous", ["vorn", "ow"], "conflicting_names"]);
    /* The overlap copy of a shared ordinary word is not a sighting by itself, whatever the window grouped. */
    const overlap = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])], [m("W2.C1", ["Orange"], [402])]], ORANGES);
    eq("never: a shared ordinary word alone on an overlap line", [at(overlap, "W2.C1").state, at(overlap, "W2.C1").account_id], ["refused", null]);
    const overlapMixed = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [400, 402])], [m("W2.C1", ["Vorn", "Orange"], [402])], [m("W3.C1", ["Orange Wyvernhold", "Orange"], [700, 702])]], VORN_ORANGES);
    eq("never: an overlap sighting whose shared ordinary word the other window did not carry", S(at(overlapMixed, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", overlapMixed.counters, {});
  }
  {
    /* One window's model groups another live account's short name with the wrong whole name. */
    const wrong = J([[m("W1.C1", ["Vorn Digital", "Zell"], [270, 271])], [], [m("W3.C1", ["Zell"], [800])]]);
    eq("never: a word of another live account's name, grouped by one window with this account", S(at(wrong, "W3.C1")), ["unknown", null, null, []]);
    const both = J([
      [m("W1.C1", ["Vorn Digital", "Zell"], [270, 271])],
      [m("W2.C1", ["Zell Creative"], [500])],
      [m("W3.C1", ["Zell"], [800])],
    ]);
    eq("never: …nor on the account it names, while one window grouped it with another", S(at(both, "W3.C1")), ["unknown", null, null, []]);
  }
  {
    /* A prefix the roster offers to two accounts is shared, whichever of them this meeting named in full. */
    const BRINDLES = buildRosterIndex({ accounts: [acct("bh", "Brindlecot Harrow Media"), acct("bw", "Brindlewood Partners")] });
    eq("shared prefix precondition: 'Brindle' alone suggests both accounts", [resolveSurface("Brindle", BRINDLES).state, resolveSurface("Brindle", BRINDLES).matched_on, resolveSurface("Brindle", BRINDLES).options], ["suggested", "prefix", ["bh", "bw"]]);
    const one = J([[m("C1", ["Brindlecot Harrow Media"], [120]), m("C2", ["Brindle"], [760])]], BRINDLES);
    eq("shared prefix, one window: listed apart it stays a suggestion of both", S(at(one, "C2")), ["suggested", null, "prefix", ["bh", "bw"]]);
    const j = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindle"], [760])]], BRINDLES);
    eq("never: a prefix two accounts share is placed on the one this meeting named", S(at(j, "W3.C1")), ["suggested", null, "prefix", ["bh", "bw"]]);
    eq("…nothing joined", j.counters, {});
    eq("…its own card, still 'Who is this?'", clusterMentions(j.resolutions).map((c) => [c.state, c.account_id, c.sources]), [["resolved", "bh", ["W1.C1"]], ["suggested", null, ["W3.C1"]]]);
    const other = J([[m("W1.C1", ["Brindlewood Partners"], [120])], [], [m("W3.C1", ["Brindle"], [760])]], BRINDLES);
    eq("…the account this meeting named is offered first", S(at(other, "W3.C1")), ["suggested", null, "prefix", ["bw", "bh"]]);
    eq("…counted", other.counters, { offered_first: 1 });
  }
  {
    /* A distinctive word the token index offers to one account, but another live name has it too. */
    const LATER = buildRosterIndex({ accounts: [acct("bh", "Brindlecot Harrow Media"), acct("hb", "Harrow Brindlecot Studio")] });
    eq("later-word precondition: 'Brindlecot' alone suggests only the account whose FIRST word it is", [resolveSurface("Brindlecot", LATER).state, resolveSurface("Brindlecot", LATER).options], ["suggested", ["bh"]]);
    const j = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindlecot"], [760])]], LATER);
    eq("never: a suggestion whose word another live account's name has", S(at(j, "W3.C1")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", j.counters, {});
    /* The transcript splits the word: resolveSurface matches it on its de-spaced form. */
    eq("split-word precondition: 'Brindle Cot' suggests the account on the de-spaced token", [resolveSurface("Brindle Cot", LATER).state, resolveSurface("Brindle Cot", LATER).key, resolveSurface("Brindle Cot", LATER).options], ["suggested", "brindle cot", ["bh"]]);
    const split = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [m("W2.C1", ["Harrow Brindlecot Studio"], [400])], [m("W3.C1", ["Brindle Cot"], [760])]], LATER);
    eq("never: a split word another live account's name has, while that account is named in full", S(at(split, "W3.C1")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", split.counters, {});
    const splitUnnamed = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindle Cot"], [760])]], LATER);
    eq("never: a split word another live account's name has, named in this meeting or not", S(at(splitUnnamed, "W3.C1")), ["suggested", null, "token", ["bh"]]);
    const splitBeside = J([[m("W1.C1", ["Brindlecot Harrow Media", "Brindle Cot"], [120, 121])], [], [m("W3.C1", ["Brindle Cot"], [760])]], LATER);
    eq("never: a split word said beside the name, when another live account's name has the word", S(at(splitBeside, "W3.C1")), ["suggested", null, "token", ["bh"]]);
    eq("…nothing joined", splitBeside.counters, {});
  }
  {
    /* A prefix the matcher did not offer: a domain label matched first, or the word is not a first word. */
    const HIDDEN = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital", { domain: "brindle.example" }), acct("bh", "Brindlecot Harrow Media")] });
    eq("hidden-prefix precondition: 'Brindle' suggests the account whose domain label it is", [resolveSurface("Brindle", HIDDEN).state, resolveSurface("Brindle", HIDDEN).matched_on, resolveSurface("Brindle", HIDDEN).options], ["suggested", "domain", ["vorn"]]);
    const hidden = J([[m("W1.C1", ["Vorn Digital"], [100]), m("W1.C2", ["Brindlecot Harrow Media"], [140])], [], [m("W3.C1", ["Brindle"], [760])]], HIDDEN);
    eq("never: a domain-label suggestion that starts another account's word, while that account is named", S(at(hidden, "W3.C1")), ["suggested", null, "domain", ["vorn"]]);
    eq("…nothing joined", hidden.counters, {});
    const hiddenUnnamed = J([[m("W1.C1", ["Vorn Digital"], [100])], [], [m("W3.C1", ["Brindle"], [760])]], HIDDEN);
    eq("never: …named in this meeting or not", S(at(hiddenUnnamed, "W3.C1")), ["suggested", null, "domain", ["vorn"]]);
    const LATERWORD = buildRosterIndex({ accounts: [acct("bh", "Brindlecot Harrow Media"), acct("hw", "Harrow Brindlewood Studio")] });
    eq("later-word prefix precondition: 'Brindle' suggests only the account whose FIRST word it starts", [resolveSurface("Brindle", LATERWORD).state, resolveSurface("Brindle", LATERWORD).matched_on, resolveSurface("Brindle", LATERWORD).options], ["suggested", "prefix", ["bh"]]);
    const laterWord = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindle"], [760])]], LATERWORD);
    eq("never: a prefix suggestion that also starts a later word of another account's name", S(at(laterWord, "W3.C1")), ["suggested", null, "prefix", ["bh"]]);
    eq("…nothing joined", laterWord.counters, {});
    const SHADOW = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("hv", "Harrow Vornholt Studio")] });
    eq("shadow precondition: 'Vorn' alone is unknown (no first word it starts)", resolveSurface("Vorn", SHADOW).state, "unknown");
    const shadowOwn = J([[m("W1.C1", ["Vorn Digital"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], SHADOW);
    eq("never: an own short name that starts another account's word", S(at(shadowOwn, "W3.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", shadowOwn.counters, {});
    const shadowBeside = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 271])], [], [m("W3.C1", ["Vorn"], [800])]], SHADOW);
    eq("never: a word said beside the name that starts another account's word", S(at(shadowBeside, "W3.C1")), ["unknown", null, null, []]);
    eq("…nothing joined", shadowBeside.counters, {});
  }
  {
    const PREFIX = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital"), acct("vornholt", "Vornholt Studio")] });
    eq("conflict precondition: 'Vorn' alone suggests another account by prefix", [resolveSurface("Vorn", PREFIX).state, resolveSurface("Vorn", PREFIX).options], ["suggested", ["vornholt"]]);
    const j = J([[m("W1.C1", ["Vorn Digital"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], PREFIX);
    eq("conflict: a roster suggestion for another account → ambiguous, this meeting's account first", [at(j, "W3.C1").state, at(j, "W3.C1").options, at(j, "W3.C1").reason], ["ambiguous", ["vorn", "vornholt"], "conflicting_names"]);
  }
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vorn"], [800])]]);
    check("a joined mention never claims a person confirmed it", at(j, "W3.C1").matched_on !== "learned" && at(j, "W3.C1").matched_on !== "person");
    eq("the output keeps window order", j.resolutions.map((r) => r.ref), ["W1.C1", "W3.C1"]);
  }
  {
    /* The meeting resolved the account ONLY on a name a person confirmed before. */
    const LEARNED = buildRosterIndex({ accounts: [acct("vorn", "Vorn Digital")], learned: [{ said_key: "vornie", account_id: "vorn" }] });
    eq("learned precondition: 'Vornie' resolves on a learned alias", [resolveSurface("Vornie", LEARNED).state, resolveSurface("Vornie", LEARNED).matched_on], ["resolved", "learned"]);
    const j = J([[m("W1.C1", ["Vornie"], [270])], [], [m("W3.C1", ["Vorn"], [800])]], LEARNED);
    eq("joined where the account was resolved only on a learned alias: suggested, on its own evidence, never 'learned'", S(at(j, "W3.C1")), ["suggested", null, "token", ["vorn"]]);
    const first = J([[m("W1.C1", ["Vorn"], [270])], [], [m("W3.C1", ["Vornie"], [800])]], LEARNED);
    eq("…and when the joined mention heads the card, the card does not claim a person confirmed it", clusterMentions(first.resolutions).map((c) => [c.account_id, c.matched_on, c.sources]), [[null, "token", ["W1.C1"]], ["vorn", "learned", ["W3.C1"]]]);
    const named = J([[m("W1.C1", ["Vornie"], [270]), m("W1.C2", ["Vorn Digital"], [280])], [], [m("W3.C1", ["Vorn"], [800])]], LEARNED);
    eq("…and a whole name resolved too gives it no basis of the account's: its own evidence", at(named, "W3.C1").matched_on, "token");
    /* The same sighting, where the account was resolved only on the learned alias. */
    const sighted = J([[m("W1.C1", ["Vornie", "Vorn"], [318, 320])], [m("W2.C1", ["Vorn"], [320])]], LEARNED);
    eq("the same sighting of an account resolved only on a learned alias: placed on 'token', never 'learned'", S(at(sighted, "W2.C1")), ["resolved", "vorn", "token", ["vorn"]]);
    eq("…counted as the same sighting", sighted.counters, { joined_same_lines: 1 });
    const sightedFirst = J([[m("W1.C1", ["Vorn"], [320])], [m("W2.C1", ["Vornie", "Vorn"], [318, 320])]], LEARNED);
    eq("…and when it heads the card, the card does not claim a person confirmed it", clusterMentions(sightedFirst.resolutions).map((c) => [c.account_id, c.matched_on, c.sources]), [["vorn", "token", ["W1.C1", "W2.C1"]]]);
  }
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
