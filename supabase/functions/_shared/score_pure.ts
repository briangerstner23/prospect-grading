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

/** The listing columns pb-score refreshes on pb_accounts after each read. */
export function listingPatch(sc: ProspectScorecard): { status: string; effective_tier: string | null; cell: string | null } {
  return { status: sc.status, effective_tier: sc.effective_tier, cell: sc.cell };
}

export interface CurrentRead {
  account_id: string;
  effective_tier: string | null;
  status: string | null;
}

export interface DiffEntry {
  account_id: string;
  name: string;
  from_tier: string | null;
  to_tier: string | null;
  from_status: string | null;
  to_status: string;
  changed: boolean;
}

/** One preview line: the current read (or nothing) against the draft scorecard. */
export function diffEntry(sc: ProspectScorecard, current: CurrentRead | null): DiffEntry {
  const from_tier = current?.effective_tier ?? null;
  const from_status = current?.status ?? null;
  return {
    account_id: sc.account_id,
    name: sc.name,
    from_tier,
    to_tier: sc.effective_tier,
    from_status,
    to_status: sc.status,
    changed: from_tier !== sc.effective_tier || from_status !== sc.status,
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
