/**
 * WLIQ Prospect Book — the rubric as the edge functions see it.
 *
 * The engine reads every threshold from the versioned spec in `pb_rubric_versions`; the
 * functions load that row and hand the spec through untouched. The signal catalog helpers
 * here fill `weight` / `lifespan_days` / `decays` / `expires_at` on incoming signal rows from
 * `rubric.signals.catalog[type]` — never from a constant in this file.
 *
 * No `jsr:` import: the loader takes the client as a parameter, so the pure parts are
 * testable under Node.
 */

import type { Rubric } from "./core/prospect_types.ts";
import type { DbLike, Rec } from "./helpers.ts";
import { addDays, isRec, toStr } from "./helpers.ts";

export interface RubricRow {
  version: string;
  status: "draft" | "active" | "retired" | string;
  spec: Rubric;
  spec_sha256: string | null;
}

/**
 * The active rubric, or the named version. null when none exists (the caller answers 503 or
 * 404 — the engine never runs on a rubric it cannot name).
 */
export async function loadRubric(db: DbLike, version: string | null): Promise<RubricRow | null> {
  let q = db.from("pb_rubric_versions").select("version,status,spec,spec_sha256");
  q = version === null ? q.eq("status", "active") : q.eq("version", version);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`pb_rubric_versions: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || !isRec(row.spec)) return null;
  return {
    version: String(row.version),
    status: String(row.status),
    spec: row.spec,
    spec_sha256: row.spec_sha256 ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Signal catalog (pure)
 * ------------------------------------------------------------------ */

export interface CatalogEntry {
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
  sla_hours: number | null;
  label: string | null;
}

function catalogOf(rubric: Rubric): Rec {
  const c = rubric?.signals?.catalog;
  return isRec(c) ? c : {};
}

/** Every type the rubric names. Empty when the rubric has no catalog. */
export function catalogTypes(rubric: Rubric): string[] {
  return Object.keys(catalogOf(rubric)).sort();
}

/** The catalog entry for a type, coerced; null when the type is not in the catalog. */
export function catalogEntry(rubric: Rubric, type: string | null | undefined): CatalogEntry | null {
  const t = toStr(type);
  if (t === null) return null;
  const e = catalogOf(rubric)[t];
  if (!isRec(e)) return null;
  const weight = typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : null;
  if (weight === null) return null;
  const lifespan = typeof e.lifespan_days === "number" && Number.isFinite(e.lifespan_days) ? e.lifespan_days : null;
  return {
    weight,
    lifespan_days: lifespan,
    decays: e.decays === undefined || e.decays === null ? true : Boolean(e.decays),
    sla_hours: typeof e.sla_hours === "number" && Number.isFinite(e.sla_hours) ? e.sla_hours : null,
    label: toStr(e.label),
  };
}

export interface SignalFill {
  row: Rec;
  /** The fields the catalog supplied, for the run's notes. */
  filled: string[];
  /** Non-null when the row cannot be inserted as-is. */
  error: string | null;
}

/**
 * Fill weight / lifespan_days / decays / expires_at on a pb_signals row when they are null or
 * absent, from the catalog. A type outside the catalog is an error (pb-sync answers 400 with
 * the list). A row that already carries a value keeps it — the catalog fills gaps, it does not
 * overrule a source that stated a weight.
 */
export function fillSignalFromCatalog(row: Rec, rubric: Rubric): SignalFill {
  const type = toStr(row.type);
  if (type === null) return { row, filled: [], error: "signal has no type" };
  const cat = catalogEntry(rubric, type);
  if (cat === null) return { row, filled: [], error: `signal type '${type}' is not in the rubric catalog` };

  const out: Rec = { ...row, type };
  const filled: string[] = [];
  const missing = (k: string) => out[k] === null || out[k] === undefined;

  if (missing("weight")) {
    out.weight = cat.weight;
    filled.push("weight");
  }
  if (missing("lifespan_days")) {
    out.lifespan_days = cat.lifespan_days;
    filled.push("lifespan_days");
  }
  if (missing("decays")) {
    out.decays = cat.decays;
    filled.push("decays");
  }
  const observed = toStr(out.observed_at);
  if (observed === null) return { row: out, filled, error: `signal '${type}' has no observed_at` };
  if (missing("expires_at")) {
    const life = out.lifespan_days;
    if (typeof life === "number" && Number.isFinite(life) && life > 0) {
      const exp = addDays(observed, life);
      if (exp === null) return { row: out, filled, error: `signal '${type}': observed_at ${JSON.stringify(observed)} is not a date` };
      out.expires_at = exp;
    } else {
      out.expires_at = null;
    }
    filled.push("expires_at");
  }
  return { row: out, filled, error: null };
}
