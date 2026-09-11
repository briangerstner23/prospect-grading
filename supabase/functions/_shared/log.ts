/**
 * WLIQ Prospect Book — pb_runs bookkeeping.
 *
 *   startRun(db, kind, source, triggered_by) → run id
 *   finishRun(db, id, status, counts, errors)
 *
 * Every ingest, score and webhook delivery leaves a row: what ran, who asked, what it wrote,
 * what went wrong. `kind` must be one of the pb_runs check values; an unknown kind is coerced
 * to 'ingest' with a note in the errors rather than failing the run it is meant to record.
 */

import type { DbLike, Rec } from "./helpers.ts";

export const RUN_KINDS = ["ingest", "score", "decay", "seed", "webhook", "enrich", "export"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ["running", "success", "partial", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunKind(v: unknown): v is RunKind {
  return typeof v === "string" && (RUN_KINDS as readonly string[]).includes(v);
}

/** success when nothing failed; partial when something was written and something failed; failed otherwise. */
export function runStatus(wrote: number, errors: number): RunStatus {
  if (errors === 0) return "success";
  return wrote > 0 ? "partial" : "failed";
}

export async function startRun(db: DbLike, kind: RunKind | string, source: string | null, triggered_by: string | null): Promise<string> {
  const row: Rec = {
    kind: isRunKind(kind) ? kind : "ingest",
    source,
    triggered_by,
    status: "running",
  };
  const { data, error } = await db.from("pb_runs").insert(row).select("id").single();
  if (error) throw new Error(`pb_runs insert: ${error.message}`);
  return String(data.id);
}

/**
 * A row left in `running` is a lie: the function was killed before it could report, and nothing
 * else will ever close it. The next run does, marked `failed` with the reason, so the history
 * reads "killed" rather than "still going" a month later. Whatever the dead run wrote is kept —
 * it was written record by record and the watermark says how far it got.
 *
 * The cutoff is what makes this safe: a run still legitimately in flight is younger than it.
 */
export async function closeAbandonedRuns(
  db: DbLike,
  source: string,
  olderThanMs = 15 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await db
    .from("pb_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [`Never reported. Killed before it could finish; anything it wrote is kept and the watermark says how far it got. Closed by a later run at ${new Date().toISOString()}.`],
    })
    .eq("source", source)
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");
  if (error) return 0; // bookkeeping must never fail the run it is bookkeeping for
  return Array.isArray(data) ? data.length : 0;
}

export async function finishRun(
  db: DbLike,
  id: string,
  status: RunStatus,
  counts: Rec,
  errors: unknown[],
): Promise<void> {
  const { error } = await db
    .from("pb_runs")
    .update({
      status,
      counts,
      errors: errors.length ? errors : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`pb_runs update: ${error.message}`);
}
