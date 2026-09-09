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
import { chunk } from "./helpers.ts";

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

/** `select <cols> from <table> where <col> in (ids)`, chunked so the URL stays short. */
export async function selectIn(db: DbLike, table: string, col: string, ids: readonly string[], cols = "*", size = 100): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const slice of chunk(ids, size)) {
    const { data, error } = await db.from(table).select(cols).in(col, slice);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) out.push(r as Rec);
  }
  return out;
}

/** Every row of a query, paging past PostgREST's default 1000-row cap. */
export async function selectAll(db: DbLike, table: string, cols: string, apply?: (q: DbLike) => DbLike, page = 1000): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let from = 0; ; from += page) {
    let q = db.from(table).select(cols).range(from, from + page - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as Rec[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}
