/**
 * WLIQ Prospect Book — signal decay, urgency and routing.
 *
 * PURE. `as_of` is an input; nothing here reads a clock. Shared by the engine and, by copy,
 * the edge functions. The formula and every threshold come from rubric.signals.
 *
 *   decay_formula: weight_now = decays
 *       ? weight * max(0, 1 - age_days / lifespan_days)
 *       : (age_days <= lifespan_days ? weight : 0)
 *   lifespan_days null → never expires; the weight counts as given.
 */

import type { SignalInput, SignalTask, SignalTrace, Timing, Urgency } from "./prospect_types.ts";

// deno-lint-ignore no-explicit-any
type Rubric = any;

const DAY_MS = 86_400_000;

/** Whole days from `fromIso` to `toIso`, floored, never negative. NaN dates → 0 (unknown is not evidence). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / DAY_MS));
}

/** ISO timestamp `hours` after `iso`. */
export function addHours(iso: string, hours: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + hours * 3_600_000).toISOString();
}

/** The rubric's decay formula for one signal. */
export function weightNow(s: SignalInput, ageDays: number): number {
  if (s.lifespan_days === null || s.lifespan_days === undefined) return s.weight;
  if (s.lifespan_days <= 0) return 0;
  if (s.decays) {
    const factor = Math.max(0, 1 - ageDays / s.lifespan_days);
    return round4(s.weight * factor);
  }
  return ageDays <= s.lifespan_days ? s.weight : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function traceOf(s: SignalInput, asOf: string): SignalTrace {
  const age = daysBetween(s.observed_at, asOf);
  return {
    type: s.type,
    source: s.source,
    observed_at: s.observed_at,
    weight: s.weight,
    weight_now: weightNow(s, age),
    age_days: age,
  };
}

function byWeightNowDesc(a: SignalTrace, b: SignalTrace): number {
  if (b.weight_now !== a.weight_now) return b.weight_now - a.weight_now;
  if (a.observed_at !== b.observed_at) return a.observed_at < b.observed_at ? 1 : -1;
  return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
}

export interface DecayedSignals {
  /** Sum of weight_now over every signal, negatives included. */
  total: number;
  /** Live positive signals, strongest first (at most `top_n`, default 5). */
  top: SignalTrace[];
  /** Every negative-weight signal with its current weight (0 once its lifespan has passed). */
  negatives: SignalTrace[];
  /** Every signal's trace, in input order. */
  traces: SignalTrace[];
  /** True when at least one signal still carries a non-zero weight. */
  has_live: boolean;
}

export function decaySignals(signals: SignalInput[], asOf: string, rubric: Rubric): DecayedSignals {
  const topN = typeof rubric?.signals?.top_n === "number" ? rubric.signals.top_n : 5;
  const traces = (signals ?? []).map((s) => traceOf(s, asOf));
  const total = round4(traces.reduce((acc, t) => acc + t.weight_now, 0));
  const top = traces.filter((t) => t.weight_now > 0).sort(byWeightNowDesc).slice(0, topN);
  const negatives = traces
    .filter((t) => t.weight < 0)
    .sort((a, b) => a.weight_now - b.weight_now || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return { total, top, negatives, traces, has_live: traces.some((t) => t.weight_now !== 0) };
}

/**
 * Urgency: a stated timing fact wins; else the decayed-total ladder when any live signal
 * exists; else Cold with basis `none`.
 */
export function computeUrgency(
  timing: Timing | null,
  decayed: { total: number; has_live: boolean },
  rubric: Rubric,
): { urgency: Urgency; basis: "stated_timing" | "computed" | "none" } {
  const u = rubric?.signals?.urgency ?? {};
  if (timing && u.stated_timing_wins !== false && u.from_timing?.[timing]) {
    return { urgency: u.from_timing[timing] as Urgency, basis: "stated_timing" };
  }
  if (decayed.has_live && Array.isArray(u.from_decayed_total)) {
    for (const band of u.from_decayed_total) {
      if (decayed.total >= band.min) return { urgency: band.label as Urgency, basis: "computed" };
    }
  }
  return { urgency: "Cold", basis: "none" };
}

/**
 * Routing (rubric.signals.routing): inside the window, one strong signal (weight ≥ strong_min)
 * makes a task with the signal's catalog sla_hours (or the default), due from observed_at; two
 * or more medium signals (≥ medium_min, < strong_min) make one task, due from the latest of
 * them. A single medium signal is a note; weak signals only update the profile. Negative and
 * expired signals never route.
 */
export function routeTasks(signals: SignalInput[], asOf: string, rubric: Rubric): SignalTask[] {
  const r = rubric?.signals?.routing ?? {};
  const catalog = rubric?.signals?.catalog ?? {};
  const window = typeof r.window_days === "number" ? r.window_days : 30;
  const strongMin = typeof r.strong_min_weight === "number" ? r.strong_min_weight : 8;
  const mediumMin = typeof r.medium_min_weight === "number" ? r.medium_min_weight : 4;
  const defaultSla = typeof r.default_sla_hours === "number" ? r.default_sla_hours : 120;

  const inWindow = (signals ?? [])
    .map((s) => ({ s, age: daysBetween(s.observed_at, asOf) }))
    .filter(({ s, age }) => s.weight > 0 && age <= window && weightNow(s, age) > 0);

  const tasks: SignalTask[] = [];
  const mediums: SignalInput[] = [];
  for (const { s } of inWindow) {
    if (s.weight >= strongMin) {
      const sla = typeof catalog[s.type]?.sla_hours === "number" ? catalog[s.type].sla_hours : defaultSla;
      tasks.push({
        signal: s.type,
        sla_hours: sla,
        due_by: addHours(s.observed_at, sla),
        reason: `Strong signal (${catalog[s.type]?.label ?? s.type}, weight ${s.weight}) inside the ${window}-day window.`,
      });
    } else if (s.weight >= mediumMin) {
      mediums.push(s);
    }
  }
  if (mediums.length >= 2) {
    const sorted = [...mediums].sort((a, b) => (a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0));
    const latest = sorted[sorted.length - 1];
    const slas = sorted.map((s) => catalog[s.type]?.sla_hours).filter((x): x is number => typeof x === "number");
    const sla = slas.length ? Math.min(...slas) : defaultSla;
    tasks.push({
      signal: sorted.map((s) => s.type).join(" + "),
      sla_hours: sla,
      due_by: addHours(latest.observed_at, sla),
      reason: `${sorted.length} medium signals inside the ${window}-day window.`,
    });
  }
  tasks.sort((a, b) => (a.due_by < b.due_by ? -1 : a.due_by > b.due_by ? 1 : a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0));
  return tasks;
}
