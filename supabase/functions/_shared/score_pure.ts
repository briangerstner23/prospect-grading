/**
 * WLIQ Prospect Book — pb-score's logic, pure.
 *
 * pb-score loads every scorable account with its current facts, live signals, open deals and
 * register overrides, resolves features, grades, and writes reads. The shaping around the
 * engine is here and tested under Node: grouping rows per account, the pb_reads row, the
 * pb_accounts listing patch, the preview diff, and the counts. The engine itself is
 * ./core/engine.ts, untouched.
 */

import type { ProspectScorecard } from "./core/prospect_types.ts";
import type { Rec } from "./helpers.ts";
import { isoDate, toStr } from "./helpers.ts";

/** Rows keyed by one column (account_id). Rows without the column are dropped. */
export function groupBy<T extends object>(rows: readonly T[], column: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = toStr((r as Record<string, unknown>)[column]);
    if (k === null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** The pb_accounts columns the resolver reads, shaped as it wants them. */
export function toResolveAccount(row: Rec): {
  id: string;
  name: string;
  relationship_type: string | null;
  roster_source: string | null;
  roster_certified: boolean | null;
  lineage: string | null;
} {
  return {
    id: String(row.id),
    name: toStr(row.name) ?? "",
    relationship_type: toStr(row.relationship_type),
    roster_source: toStr(row.roster_source),
    roster_certified: typeof row.roster_certified === "boolean" ? row.roster_certified : null,
    lineage: toStr(row.lineage),
  };
}

/** A pb_reads row from a scorecard. `as_of` becomes a date; the scorecard keeps the full timestamp. */
export function buildReadRow(sc: ProspectScorecard, runId: string | null, scorecardSha256: string): Rec {
  return {
    account_id: sc.account_id,
    run_id: runId,
    rubric_version: sc.rubric_version,
    rubric_fingerprint: sc.rubric_fingerprint,
    as_of: isoDate(sc.as_of) ?? sc.as_of,
    status: sc.status,
    effective_tier: sc.effective_tier,
    computed_tier: sc.fit?.computed_tier ?? null,
    confidence: sc.fit?.confidence ?? null,
    // Null until a rubric defining confidence_grade is active (0.1.1 is a draft): an absent
    // spec is not a grade of F.
    confidence_grade: sc.confidence_grade ?? null,
    computed_confidence_grade: sc.computed_confidence_grade ?? null,
    confidence_overridden: sc.confidence_override !== null && sc.confidence_override !== undefined,
    qualification_label: sc.qualification?.label ?? null,
    facts_present: typeof sc.qualification?.present_count === "number" ? sc.qualification.present_count : null,
    ceiling: sc.potential?.ceiling ?? null,
    headroom_band: sc.potential?.headroom_band ?? null,
    year1_band: sc.potential?.year1_band ?? null,
    urgency: sc.signals?.urgency ?? null,
    cell: sc.cell,
    reason: sc.reason,
    flags: Array.isArray(sc.flags) ? sc.flags : [],
    scorecard: sc,
    scorecard_sha256: scorecardSha256,
  };
}

/**
 * The pb_potential_snapshots row for one scorecard, or null when the row is not ranked.
 *
 * DECISIONS §36. The snapshot records what the engine CLAIMED on `as_of`, in the shape the
 * research asked for (p10/p50/p90, two binaries), filled only where the active rubric actually
 * produces a value: p10_12m and p90_12m are the year-one band's edges (the lowest band's floor
 * is 0; the top band is open, so its p90 is null); p50, the 24-month interval and the two
 * probabilities are null — PRO-16 dropped the point estimate and no estimator for the rest
 * exists yet. A null here is an explicit "not estimated", never a zero. Every input a later
 * estimator could re-derive from is kept in `assumptions`, so the accumulation starts now and
 * the estimator can be replaced without losing the history (the `estimator` column names it).
 *
 * The band edges are read from the rubric that graded the card, never typed here.
 */
export function buildSnapshotRow(sc: ProspectScorecard, rubric: unknown, runId: string | null): Rec | null {
  if (sc.status !== "Ranked" && sc.status !== "Overridden") return null;
  const takenAt = isoDate(sc.as_of) ?? sc.as_of;
  const pot = sc.potential;
  const bands = ((rubric as { potential?: { year1_bands?: unknown } })?.potential?.year1_bands ?? []) as Array<{ label?: string; min?: number; max?: number }>;
  const band = pot?.year1_band && pot.year1_band !== "unknown" ? bands.find((b) => b.label === pot.year1_band) ?? null : null;
  const p10 = band ? (typeof band.min === "number" ? band.min : 0) : null;
  const p90 = band ? (typeof band.max === "number" ? band.max : null) : null;
  return {
    account_id: sc.account_id,
    taken_at: takenAt,
    estimator: `year1_band_edges@${sc.rubric_version}`,
    p10_12m: p10,
    p50_12m: null,
    p90_12m: p90,
    p10_24m: null,
    p50_24m: null,
    p90_24m: null,
    p_35k_12m: null,
    p_100k_24m: null,
    assumptions: {
      run_id: runId,
      rubric_version: sc.rubric_version,
      rubric_fingerprint: sc.rubric_fingerprint,
      status: sc.status,
      effective_tier: sc.effective_tier,
      year1_band: pot?.year1_band ?? null,
      year1_basis: pot?.year1_basis ?? null,
      headroom: pot?.headroom ?? null,
      headroom_band: pot?.headroom_band ?? null,
      ceiling: pot?.ceiling ?? null,
      ceiling_proposed: pot?.ceiling_proposed ?? null,
      wallet: pot?.wallet ?? null,
      winnable_share: pot?.winnable_share ?? null,
      winnable_basis: pot?.winnable_basis ?? null,
      potential_confidence: pot?.confidence ?? null,
      facts_present: typeof sc.qualification?.present_count === "number" ? sc.qualification.present_count : null,
      urgency: sc.signals?.urgency ?? null,
      not_estimated: "p50_12m, the 24-month interval and the two probabilities: no estimator yet (PRO-16 dropped the point estimate; DECISIONS §36)",
    },
  };
}

/** The listing columns pb-score refreshes on pb_accounts after each read. */
export function listingPatch(sc: ProspectScorecard): { status: string; effective_tier: string | null; cell: string | null } {
  return { status: sc.status, effective_tier: sc.effective_tier, cell: sc.cell };
}

/** The listing columns as a pb_accounts row holds them before tonight's write. */
export interface Listing {
  status: string | null;
  effective_tier: string | null;
  cell: string | null;
}

/** One `update pb_accounts set <patch> where id in (<ids>)`. */
export interface ListingUpdate {
  patch: { status: string; effective_tier: string | null; cell: string | null };
  ids: string[];
}

/**
 * The listing writes tonight's scorecards need, in as few calls as possible.
 *
 * Until 10 Nov 2026 pb-score sent one `update … where id = …` per scored account, every night,
 * whether or not anything had changed: 1,078 round trips after the reads were written. Each one
 * costs the worker CPU to build and parse, and an edge function has a CPU-time ceiling, not only
 * a wall clock. On 11 of 18 nights from 24 Oct the gateway answered 546 "CPU Time exceeded"
 * part-way through that loop (858 of 1,078 on 10 Nov): the reads had landed, but the rest of the listing, the day's
 * potential snapshots and the run row's finish never did, so each of those nights left a `running`
 * row and a watchdog row behind.
 *
 * So: an account whose row already shows the scorecard's listing is left alone, and the rest are
 * grouped by the patch they take — every account moving to the same status, tier and cell is one
 * call — with at most `size` ids to a call so the `in (…)` list keeps the URL short (the same
 * bound selectIn uses). An account missing from `current` (no row read back) is always written.
 * The order is fixed (by patch, then id) so the same inputs make the same calls.
 */
export function listingUpdates(
  cards: readonly ProspectScorecard[],
  current: ReadonlyMap<string, Listing>,
  size = 100,
): ListingUpdate[] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`listingUpdates: size must be a positive integer, got ${size}`);
  const groups = new Map<string, ListingUpdate>();
  for (const sc of cards) {
    const patch = listingPatch(sc);
    const now = current.get(sc.account_id);
    if (now && now.status === patch.status && now.effective_tier === patch.effective_tier && now.cell === patch.cell) continue;
    const key = JSON.stringify([patch.status, patch.effective_tier, patch.cell]);
    const g = groups.get(key);
    if (g) g.ids.push(sc.account_id);
    else groups.set(key, { patch, ids: [sc.account_id] });
  }
  const out: ListingUpdate[] = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    const ids = [...new Set(g.ids)].sort();
    for (let i = 0; i < ids.length; i += size) out.push({ patch: g.patch, ids: ids.slice(i, i + size) });
  }
  return out;
}

/** A pb_accounts row's listing columns, as `listingUpdates` compares them. */
export function toListing(row: Rec): Listing {
  return { status: toStr(row.status), effective_tier: toStr(row.effective_tier), cell: toStr(row.cell) };
}

export interface CurrentRead {
  account_id: string;
  effective_tier: string | null;
  status: string | null;
  /** Null on every row written before rubric 0.1.1, and on any read from a rubric without the block. */
  confidence_grade?: string | null;
  /** The current read's chase key (scorecard->chase_rank_key), so the preview can report ORDER changes. */
  chase_rank_key?: unknown;
}

export interface DiffEntry {
  account_id: string;
  name: string;
  from_tier: string | null;
  to_tier: string | null;
  from_status: string | null;
  to_status: string;
  from_confidence_grade: string | null;
  to_confidence_grade: string | null;
  changed: boolean;
  /** Position among the previewed accounts under the CURRENT reads' keys (1 = first); null when the account has no current read. */
  from_rank: number | null;
  /** Position among the previewed accounts under the draft's keys. */
  to_rank: number | null;
  /** True when the account's position moved. A rubric that reorders the whole book without moving a tier previewed as "0 changed" until 18 Sep (DECISIONS §10, §52). */
  order_changed: boolean;
}

export type KeyElement = number | string;

/**
 * Chase-key comparison, best first. Element by element: numbers ascending, strings by locale;
 * a shorter key is exhausted first and sorts after a longer one that agrees on every shared
 * element; a missing or malformed key sorts last. Keys of different shapes only meet across
 * rubric versions (the five-term key before 0.1.7, the rubric-ordered key after), and the
 * shared prefix still decides most of the order.
 */
export function compareKey(a: unknown, b: unknown): number {
  const ka = Array.isArray(a) ? (a as KeyElement[]) : null;
  const kb = Array.isArray(b) ? (b as KeyElement[]) : null;
  if (ka === null && kb === null) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    if (i >= ka.length) return 1;
    if (i >= kb.length) return -1;
    const x = ka[i], y = kb[i];
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
      continue;
    }
    const sx = String(x), sy = String(y);
    if (sx !== sy) return sx < sy ? -1 : 1;
  }
  return 0;
}

/**
 * Ranks for the preview: where each account sits under the current reads' keys and under the
 * draft's keys, counted over the accounts in this run only. Ties keep account_id order so the
 * result is deterministic.
 */
export function rankDiff(
  cards: readonly ProspectScorecard[],
  currentBy: Map<string, CurrentRead>,
): Map<string, { from_rank: number | null; to_rank: number | null }> {
  const byId = (p: string, q: string) => (p < q ? -1 : p > q ? 1 : 0);
  const to = [...cards].sort((x, y) => compareKey(x.chase_rank_key, y.chase_rank_key) || byId(x.account_id, y.account_id));
  const from = cards
    .map((c) => currentBy.get(c.account_id))
    .filter((c): c is CurrentRead => c !== undefined && Array.isArray(c.chase_rank_key))
    .sort((x, y) => compareKey(x.chase_rank_key, y.chase_rank_key) || byId(x.account_id, y.account_id));
  const out = new Map<string, { from_rank: number | null; to_rank: number | null }>();
  to.forEach((c, i) => out.set(c.account_id, { from_rank: null, to_rank: i + 1 }));
  from.forEach((c, i) => {
    const e = out.get(c.account_id);
    if (e) e.from_rank = i + 1;
  });
  return out;
}

/** One preview line: the current read (or nothing) against the draft scorecard. */
/**
 * One preview line. The confidence grade is part of `changed` on purpose: a rubric whose only
 * difference IS the grade — 0.1.1 is exactly that — would otherwise preview as "0 changed" and
 * rule 4's look-before-you-activate step would report that nothing happens when every account
 * gets a grade.
 */
export function diffEntry(
  sc: ProspectScorecard,
  current: CurrentRead | null,
  ranks: { from_rank: number | null; to_rank: number | null } | null = null,
): DiffEntry {
  const from_tier = current?.effective_tier ?? null;
  const from_status = current?.status ?? null;
  const from_confidence_grade = current?.confidence_grade ?? null;
  const to_confidence_grade = sc.confidence_grade ?? null;
  const from_rank = ranks?.from_rank ?? null;
  const to_rank = ranks?.to_rank ?? null;
  return {
    account_id: sc.account_id,
    name: sc.name,
    from_tier,
    to_tier: sc.effective_tier,
    from_status,
    to_status: sc.status,
    from_confidence_grade,
    to_confidence_grade,
    changed: from_tier !== sc.effective_tier
      || from_status !== sc.status
      || from_confidence_grade !== to_confidence_grade,
    from_rank,
    to_rank,
    order_changed: from_rank !== null && to_rank !== null && from_rank !== to_rank,
  };
}

export const COUNT_KEYS = ["scored", "parked", "unclassified", "overridden", "ranked", "errors"] as const;
export type Counts = Record<(typeof COUNT_KEYS)[number], number>;

/** Status tallies plus the error count, every key present. */
export function tallyScorecards(cards: readonly ProspectScorecard[], errors: number): Counts {
  const c: Counts = { scored: cards.length, parked: 0, unclassified: 0, overridden: 0, ranked: 0, errors };
  for (const sc of cards) {
    if (sc.status === "Parked") c.parked++;
    else if (sc.status === "Unclassified") c.unclassified++;
    else if (sc.status === "Overridden") c.overridden++;
    else if (sc.status === "Ranked") c.ranked++;
  }
  return c;
}

/** Stable JSON for hashing: the scorecard as the engine emitted it, no re-ordering. */
export function scorecardJson(sc: ProspectScorecard): string {
  return JSON.stringify(sc);
}
