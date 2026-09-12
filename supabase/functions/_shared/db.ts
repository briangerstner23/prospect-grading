/**
 * WLIQ Prospect Book — the service-role database client and batched writers.
 *
 * The ONLY file under supabase/functions that imports `jsr:@supabase/supabase-js@2`. Every
 * other module takes the client as a parameter (typed DbLike) so it can run under Node in
 * tests. The service role bypasses RLS: every write an edge function makes is therefore a
 * deliberate one, and the functions write only what their contract names.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { DbLike, Rec } from "./helpers.ts";
import { chunk, collectPages } from "./helpers.ts";

export function serviceClient(): DbLike {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in the function environment");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface BatchResult {
  wrote: number;
  errors: string[];
}

/** Upsert in slices of `size`; a failed slice is recorded and the next one still runs. */
export async function upsertBatches(db: DbLike, table: string, rows: Rec[], onConflict: string, size = 200): Promise<BatchResult> {
  const out: BatchResult = { wrote: 0, errors: [] };
  for (const slice of chunk(rows, size)) {
    const { error } = await db.from(table).upsert(slice, { onConflict });
    if (error) out.errors.push(`${table} upsert (${slice.length} rows): ${error.message}`);
    else out.wrote += slice.length;
  }
  return out;
}

/** Insert in slices of `size`; a failed slice is recorded and the next one still runs. */
export async function insertBatches(db: DbLike, table: string, rows: Rec[], size = 200): Promise<BatchResult> {
  const out: BatchResult = { wrote: 0, errors: [] };
  for (const slice of chunk(rows, size)) {
    const { error } = await db.from(table).insert(slice);
    if (error) out.errors.push(`${table} insert (${slice.length} rows): ${error.message}`);
    else out.wrote += slice.length;
  }
  return out;
}

/**
 * `select <cols> from <table> where <col> in (ids)` — chunked so the URL stays short AND paged
 * so the answer is all of it.
 *
 * THE CHUNKING AND THE PAGING SOLVE DIFFERENT PROBLEMS AND BOTH ARE REQUIRED. `size` bounds the
 * `in (…)` list so the request URL does not grow past what the gateway accepts. `page` gets past
 * PostgREST's 1000-row response cap, which applies per request and not per id — so a slice of
 * 100 accounts is capped at 1000 rows however many rows those accounts actually have.
 *
 * This function had the chunking and not the paging until 12 Sep 2026, and the book carries
 * about ten facts per account: 100 accounts is ~1000 rows, exactly the cap. pb-score read
 * `pb_current_facts` this way and silently scored the tail of four of its seven chunks on facts
 * it never received — two accounts lost their `icp_class` and were published as Unclassified
 * with the fact sitting in the table and the view the whole time. Nothing errored. The rule that
 * unknown is never evidence cannot hold if a known fact can arrive as absent.
 *
 * `order_by` must be UNIQUE or a page boundary can drop or repeat a row: paging an unordered
 * query is undefined. `id` is present on every table and view this is called with.
 */
export async function selectIn(
  db: DbLike,
  table: string,
  col: string,
  ids: readonly string[],
  cols = "*",
  size = 100,
  orderBy = "id",
  page = 1000,
): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const slice of chunk(ids, size)) {
    const rows = await collectPages<Rec>(page, async (from, to) => {
      const { data, error } = await db.from(table).select(cols).in(col, slice).order(orderBy).range(from, to);
      if (error) throw new Error(`${table}: ${error.message}`);
      return (data ?? []) as Rec[];
    });
    out.push(...rows);
  }
  return out;
}

/**
 * Every row of a query, paging past PostgREST's default 1000-row cap. Same cap, same loop as
 * selectIn — shared through collectPages so the stopping rule lives in one tested place.
 *
 * Callers that will ever exceed one page should add a unique `order` through `apply`; paging an
 * unordered query is undefined. Every current caller is either single-page or ordered.
 */
export async function selectAll(db: DbLike, table: string, cols: string, apply?: (q: DbLike) => DbLike, page = 1000): Promise<Rec[]> {
  return await collectPages<Rec>(page, async (from, to) => {
    let q = db.from(table).select(cols).range(from, to);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as Rec[];
  });
}
