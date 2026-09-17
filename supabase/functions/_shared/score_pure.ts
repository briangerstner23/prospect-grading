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

export interface CurrentRead {
  account_id: string;
  effective_tier: string | null;
  status: string | null;
  /** Null on every row written before rubric 0.1.1, and on any read from a rubric without the block. */
  confidence_grade?: string | null;
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
}

/** One preview line: the current read (or nothing) against the draft scorecard. */
/**
 * One preview line. The confidence grade is part of `changed` on purpose: a rubric whose only
 * difference IS the grade — 0.1.1 is exactly that — would otherwise preview as "0 changed" and
 * rule 4's look-before-you-activate step would report that nothing happens when every account
 * gets a grade.
 */
export function diffEntry(sc: ProspectScorecard, current: CurrentRead | null): DiffEntry {
  const from_tier = current?.effective_tier ?? null;
  const from_status = current?.status ?? null;
  const from_confidence_grade = current?.confidence_grade ?? null;
  const to_confidence_grade = sc.confidence_grade ?? null;
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
