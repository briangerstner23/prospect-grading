/**
 * WLIQ Prospect Book — tests for pb-score's pure shaping, starting with the potential snapshot row.
 *
 * Run:  node --experimental-strip-types supabase/functions/_shared/score_pure_test.ts
 *
 * The scorecards come from the real engine over the synthetic golden fixtures under the ACTIVE
 * rubric, so what is asserted here is what pb-score would write tonight. Nothing imports `jsr:`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { grade } from "./core/engine.ts";
import type { ProspectFeatures, ProspectScorecard } from "./core/prospect_types.ts";
import { buildSnapshotRow, compareKey, diffEntry, rankDiff } from "./score_pure.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(join(here, p), "utf8"));

// The active rubric, by the same name the ledger pins (scripts/conformance_test.ts holds it there).
const RUBRIC_FILE = "rubric.prospect.v0.1.4.json";
const rubric = load(`../../../core/${RUBRIC_FILE}`); // the rubric JSON lives in core/ only; _shared/core holds the .ts copies
const golden = load("../../../fixtures/golden.json") as Array<{ id: string; features: ProspectFeatures }>;

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

const cardOf = (id: string): ProspectScorecard => {
  const fx = golden.find((g) => g.id === id);
  if (!fx) throw new Error(`fixture ${id} missing`);
  return grade(fx.features, rubric, {});
};
const bands = rubric.potential.year1_bands as Array<{ label: string; min?: number; max?: number }>;

/* ---- 1 · a ranked card produces one row shaped for the table, from the rubric's own edges ---- */
const cards = golden.map((g) => grade(g.features, rubric, {}));
const ranked = cards.filter((c) => c.status === "Ranked" || c.status === "Overridden");
const unranked = cards.filter((c) => c.status !== "Ranked" && c.status !== "Overridden");
check("fixtures include ranked and unranked cards", ranked.length > 0 && unranked.length > 0, `${ranked.length} ranked, ${unranked.length} not`);

for (const sc of ranked) {
  const row = buildSnapshotRow(sc, rubric, "run-1");
  check(`${sc.name}: ranked card yields a row`, row !== null);
  if (!row) continue;
  check(`${sc.name}: account, day, estimator`, row.account_id === sc.account_id && row.taken_at === sc.as_of.slice(0, 10) && row.estimator === `year1_band_edges@${rubric.version}`, JSON.stringify([row.account_id, row.taken_at, row.estimator]));
  const band = bands.find((b) => b.label === sc.potential.year1_band);
  if (sc.potential.year1_band === "unknown") {
    check(`${sc.name}: unknown band → p10 and p90 null (unknown is never evidence)`, row.p10_12m === null && row.p90_12m === null);
  } else {
    check(`${sc.name}: band ${sc.potential.year1_band} is in the rubric`, band !== undefined);
    check(`${sc.name}: p10 is the band floor`, row.p10_12m === (band?.min ?? 0), `${row.p10_12m} vs ${band?.min ?? 0}`);
    check(`${sc.name}: p90 is the band ceiling or null when open`, row.p90_12m === (band?.max ?? null), `${row.p90_12m} vs ${band?.max ?? null}`);
  }
  check(`${sc.name}: no point estimate, no 24m, no probabilities (PRO-16)`, row.p50_12m === null && row.p10_24m === null && row.p50_24m === null && row.p90_24m === null && row.p_35k_12m === null && row.p_100k_24m === null);
  const a = row.assumptions as Record<string, unknown>;
  check(`${sc.name}: assumptions carry the re-derivable inputs`, a.run_id === "run-1" && a.rubric_fingerprint === sc.rubric_fingerprint && a.year1_band === sc.potential.year1_band && a.ceiling === sc.potential.ceiling && a.headroom === sc.potential.headroom && a.effective_tier === sc.effective_tier);
}

/* ---- 2 · not ranked, no row ---- */
for (const sc of unranked) {
  check(`${sc.name} (${sc.status}): no snapshot`, buildSnapshotRow(sc, rubric, "run-1") === null);
}

/* ---- 3 · the edges come from the rubric handed in, not from anywhere else ---- */
{
  const sc = ranked.find((c) => c.potential.year1_band !== "unknown");
  if (sc) {
    const moved = JSON.parse(JSON.stringify(rubric));
    for (const b of moved.potential.year1_bands) { if (typeof b.min === "number") b.min += 1; if (typeof b.max === "number") b.max += 1; }
    const before = buildSnapshotRow(sc, rubric, null)!;
    const after = buildSnapshotRow(sc, moved, null)!;
    const shifted = (typeof before.p10_12m === "number" ? after.p10_12m === (before.p10_12m as number) + 1 : after.p10_12m === before.p10_12m)
      && (typeof before.p90_12m === "number" ? after.p90_12m === (before.p90_12m as number) + 1 : after.p90_12m === before.p90_12m);
    check("moving a band edge in the rubric moves the snapshot's edge", shifted, `${JSON.stringify([before.p10_12m, before.p90_12m])} → ${JSON.stringify([after.p10_12m, after.p90_12m])}`);
  }
  check("a rubric with no year1_bands yields nulls rather than throwing", (() => { const r = buildSnapshotRow(ranked[0], {}, null); return r !== null && r.p10_12m === null && r.p90_12m === null; })());
}

/* ---- 4 · deterministic ---- */
check("same card, same row", JSON.stringify(buildSnapshotRow(ranked[0], rubric, "x")) === JSON.stringify(buildSnapshotRow(ranked[0], rubric, "x")));


/* ------------------------------------------------------------------ *
 * the order-aware preview (DECISIONS §10, §50): a rubric that reorders the whole book without
 * moving a tier previewed as "0 changed" until 18 Sep. compareKey orders keys best first across
 * the two shapes the book has produced; rankDiff says where each account sits before and after.
 * ------------------------------------------------------------------ */
{
  check("compareKey: the first differing number decides", compareKey([0, -3], [1, -3]) < 0 && compareKey([1, -3], [0, -3]) > 0);
  check("compareKey: equal numbers fall through to the next term", compareKey([0, -3, "a"], [0, -3, "b"]) < 0);
  check("compareKey: equal keys are equal", compareKey([0, -3, "a"], [0, -3, "a"]) === 0);
  check("compareKey: a shorter key that agrees on its prefix sorts after the longer one", compareKey([0, -3], [0, -3, 5]) > 0);
  check("compareKey: a missing key sorts last", compareKey(null, [0]) > 0 && compareKey([0], undefined) < 0 && compareKey(null, null) === 0);
  check("compareKey: the five-term key and the seven-term key still order by their shared prefix", compareKey([-3, -4, -3, -4, "x"], [-2, 0, 0, 0, 100000, -1, "y"]) < 0);
  check("compareKey: a number against a string compares as text rather than throwing", typeof compareKey([1], ["a"]) === "number");

  const card = (id: string, key: Array<number | string>): ProspectScorecard => ({ ...cardOf("PB04"), account_id: id, name: id, chase_rank_key: key });
  const cards = [card("a", [2, -3, 0]), card("b", [0, -3, -2]), card("c", [3, 0, 0])];
  const current = new Map([
    ["a", { account_id: "a", effective_tier: "Platinum", status: "Ranked", chase_rank_key: [-3, 0, 0, -2, "a"] }],
    ["c", { account_id: "c", effective_tier: "Bronze", status: "Ranked", chase_rank_key: [0, 0, 0, -1, "c"] }],
  ]);
  const ranks = rankDiff(cards, current);
  check("rankDiff: the draft order is b, a, c", [ranks.get("b")?.to_rank, ranks.get("a")?.to_rank, ranks.get("c")?.to_rank].join() === "1,2,3", JSON.stringify([...ranks]));
  check("rankDiff: the current order counts only accounts with a current key", ranks.get("a")?.from_rank === 1 && ranks.get("c")?.from_rank === 2 && ranks.get("b")?.from_rank === null, JSON.stringify([...ranks]));
  const d = diffEntry(cards[0], current.get("a")!, ranks.get("a")!);
  check("diffEntry: tier unchanged but the position moved → order_changed, not changed", d.changed === false && d.order_changed === true && d.from_rank === 1 && d.to_rank === 2, JSON.stringify(d));
  const dNew = diffEntry(cards[1], null, ranks.get("b")!);
  check("diffEntry: an account with no current read has no from_rank and no order change", dNew.from_rank === null && dNew.order_changed === false && dNew.changed === true, JSON.stringify(dNew));
  const dSame = diffEntry(cards[2], current.get("c")!, { from_rank: 3, to_rank: 3 });
  check("diffEntry: the same position is not an order change", dSame.order_changed === false, JSON.stringify(dSame));
  const dLegacy = diffEntry(cards[2], current.get("c")!);
  check("diffEntry: without ranks the old shape still works, with nulls", dLegacy.from_rank === null && dLegacy.to_rank === null && dLegacy.order_changed === false);
}

console.log(`score_pure_test: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
