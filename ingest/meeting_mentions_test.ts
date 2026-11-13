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
  const J = (ws: VerifiedMention[][], idx = JOIN) => joinAcrossWindows(ws.map((w) => w.map((mm) => res(mm, idx))), idx);
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
    eq("the overlap: 'Vorn' on lines the first window placed beside 'Vorn Digital' is joined", S(at(j, "W2.C1")), ["resolved", "vorn", "name", ["vorn"]]);
    eq("…counted as the same sighting", j.counters, { joined_same_lines: 1 });
    const cl = clusterMentions(j.resolutions);
    eq("…and the two windows are one card", cl.map((c) => [c.state, c.account_id, c.sources]), [["resolved", "vorn", ["W1.C1", "W2.C1"]]]);
  }
  {
    /* The overlap line carries ANOTHER company too: only the words the other window grouped with the account are its. */
    const other = J([[m("W1.C1", ["Vorn Digital"], [290])], [m("W2.C1", ["Zell"], [290])]]);
    eq("the overlap: another company's short form on a line the first window placed is not joined to it", S(at(other, "W2.C1")), ["unknown", null, null, []]);
    eq("…nothing counted", other.counters, {});
    const besideToo = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [280, 290])], [m("W2.C1", ["Zell"], [290])]]);
    eq("…not even when the first window said a short form of its own there", S(at(besideToo, "W2.C1")), ["unknown", null, null, []]);
    const named = J([[m("W1.C1", ["Vorn Digital"], [290])], [m("W2.C1", ["Zell"], [290])], [m("W3.C1", ["Zell Creative"], [700])]]);
    eq("…and when the other company is named in full elsewhere, it joins THAT account, not the line's", S(at(named, "W2.C1")), ["resolved", "zell", "name", ["zell"]]);
  }
  {
    /* A token two accounts share, re-read in the overlap: the first window grouped those very words on those very lines. */
    const j = J([[m("W1.C1", ["Kestrelvane Studio", "Kestrelvane"], [280, 290])], [m("W2.C1", ["Kestrelvane"], [290])]]);
    eq("the overlap: a shared token on the lines the first window placed is that account", S(at(j, "W2.C1")), ["resolved", "kvs", "name", ["kvs"]]);
  }

  /* Window 1, then window 3, by a short form. */
  {
    const j = J([[m("W1.C1", ["Vorn Digital", "Vorn"], [270, 290])], [], [m("W3.C1", ["Vorn"], [800, 805])]]);
    eq("window 1 → 3: 'Vorn', said beside the name in window 1, is joined in window 3", S(at(j, "W3.C1")), ["resolved", "vorn", "name", ["vorn"]]);
    eq("…counted as joined by name", j.counters, { joined_by_name: 1 });
    eq("…one card with both discussions", clusterMentions(j.resolutions).map((c) => [c.account_id, c.segments]), [["vorn", [{ from: 268, to: 295 }, { from: 798, to: 810 }]]]);
  }
  {
    const j = J([[m("W1.C1", ["Zell Creative"], [100])], [], [m("W3.C1", ["Zell"], [700])]]);
    eq("window 1 → 3: the account's own short name joins though window 1 never said it alone", S(at(j, "W3.C1")), ["resolved", "zell", "name", ["zell"]]);
  }
  {
    const j = J([[m("W1.C1", ["Brindlecot Harrow Media"], [120])], [], [m("W3.C1", ["Brindlecot"], [760])]]);
    eq("window 1 → 3: a distinctive token that only suggested the account this meeting named is joined", S(at(j, "W3.C1")), ["resolved", "bh", "name", ["bh"]]);
  }
  {
    const beside = J([[m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])], [], [m("W3.C1", ["Orange"], [750])]]);
    eq("window 1 → 3: an ordinary word of the name, said beside it, is joined", S(at(beside, "W3.C1")), ["resolved", "orange", "name", ["orange"]]);
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
    const ORANGES = buildRosterIndex({ accounts: [acct("ow", "Orange Wyvernhold"), acct("of", "Orange Fieldcrest")] });
    const j = J([
      [m("W1.C1", ["Orange Wyvernhold", "Orange"], [400, 402])],
      [m("W2.C1", ["Orange Fieldcrest"], [520])],
      [m("W3.C1", ["Orange"], [800])],
    ], ORANGES);
    eq("never: an ordinary word of two accounts' names, said beside one of them", [at(j, "W3.C1").state, at(j, "W3.C1").reason, at(j, "W3.C1").account_id], ["refused", "ordinary_word", null]);
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
    eq("joined where the account was resolved only on a learned alias: placed, on its own evidence, never 'learned'", S(at(j, "W3.C1")), ["resolved", "vorn", "token", ["vorn"]]);
    const first = J([[m("W1.C1", ["Vorn"], [270])], [], [m("W3.C1", ["Vornie"], [800])]], LEARNED);
    eq("…and when the joined mention heads the card, the card does not claim a person confirmed it", clusterMentions(first.resolutions).map((c) => [c.account_id, c.matched_on, c.sources]), [["vorn", "token", ["W1.C1", "W3.C1"]]]);
    const named = J([[m("W1.C1", ["Vornie"], [270]), m("W1.C2", ["Vorn Digital"], [280])], [], [m("W3.C1", ["Vorn"], [800])]], LEARNED);
    eq("…while a whole name resolved too, it takes that basis", at(named, "W3.C1").matched_on, "name");
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
