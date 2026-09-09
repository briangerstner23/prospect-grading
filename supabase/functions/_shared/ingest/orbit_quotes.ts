/**
 * WLIQ Prospect Book — Orbit quotes mapper (DESIGN.md §4c).
 *
 *   Orbit list_projects rows with status Quote (+ life_cycle_status, + payment cost where readable)
 *     → pb_signals (one per quote) + pb_facts quote_amount (where the cost is > 0)
 *     + pb_identity_candidates rows for every client the book cannot attach on its own
 *
 * PURE. No clock, no network, no filesystem, no dependencies. Runs under Deno and under
 * `node --experimental-strip-types`.
 *
 * Identity follows §4a through identity.ts: only a HIGH match (orbit_client_id, or a domain —
 * Orbit project rows carry neither unless the client list has been loaded) attaches a quote to
 * an account. A norm(client_name) match is MEDIUM and a trigram match is LOW: both become
 * pb_identity_candidates rows for a person, and the quote's signal is held until the match is
 * confirmed. A client that matches nothing becomes a candidate row with matched_on "none", so the
 * acceptance test can list every quote as attached, pending review, or unmatched.
 *
 * Signal weight, lifespan and decay come from rubric.signals.catalog; never hard-coded. The
 * life_cycle_status → signal-type map is a source mapping (DESIGN §4c), not a threshold, and lives
 * here. observed_at is the project's created_at (the quote was requested then), never a clock.
 */

import type { Rubric } from "../core/prospect_types.ts";
import type { KnownAccount, MatchCandidate, MatchConfidence, MatchedOn } from "./identity.ts";
import { norm, proposeMatches } from "./identity.ts";

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/** One Orbit `list_projects` row, plus the payment cost when `get_project_payment_details` was readable. */
export interface OrbitProjectRow {
  id: number | string;
  title?: string | null;
  /** The project's URL slug (or a full URL; the last path segment is then the slug). */
  url?: string | null;
  project_number?: string | number | null;
  status?: string | null;
  life_cycle_status?: string | null;
  project_type?: string | null;
  client_name?: string | null;
  sub_client_name?: string | null;
  quoted_hours?: number | string | null;
  created_at?: string | null;
  project_start_date?: string | null;
  project_due_date?: string | null;
  /** get_project_payment_details.payment_details.project_payment_cost, dollars. */
  project_payment_cost?: number | string | null;
  /** Orbit client id, when the client list has been loaded and joined (attaches HIGH). */
  client_id?: number | string | null;
}

export interface OrbitQuotesOptions {
  /** pb_signals.entered_by / pb_facts.entered_by. Default "system:orbit". */
  entered_by?: string;
  /** Fallback observed_at when a row has neither created_at nor project_start_date. Never a clock. */
  as_of?: string;
}

export const ORBIT_SOURCE = "orbit";
export const DEFAULT_ENTERED_BY = "system:orbit";
export const ORBIT_PROJECT_URL_BASE = "https://app.whitelabeliq.com/93640173/project/";

/** DESIGN §4c: life_cycle_status → pb_signals.type. not_set / missing / unrecognised → quote_requested. */
export const LIFE_CYCLE_TO_SIGNAL: Readonly<Record<string, string>> = {
  quoted: "quote_sent",
  refine: "quote_sent",
  verbally_accepted: "orbit_verbally_accepted",
  pa_sent: "orbit_pa_sent",
  pa_signed: "orbit_pa_signed",
  not_set: "quote_requested",
};
export const DEFAULT_SIGNAL_TYPE = "quote_requested";

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export interface OrbitSignal {
  account_id: string;
  type: string;
  /** ISO timestamp — the project's created_at. */
  observed_at: string;
  payload: Record<string, unknown>;
  source: "orbit";
  weight: number;
  lifespan_days: number | null;
  decays: boolean;
  entered_by: string;
  evidence_url: string | null;
}

export interface OrbitQuoteFact {
  account_id: string;
  key: "quote_amount";
  /** Dollars. */
  value: number;
  evidence_label: "evidence";
  source: "orbit";
  /** ISO date (YYYY-MM-DD) — pb_facts.observed_at is a date. */
  observed_at: string | null;
  entered_by: string;
  evidence_url: string | null;
  note: string;
}

/** A pb_identity_candidates row for a client that matched nothing. */
export interface OrbitUnmatched {
  source: "orbit";
  source_id: string | null;
  source_name: string | null;
  source_domain: null;
  matched_on: "none";
  confidence: "low";
  note: string;
}

/** A pb_identity_candidates row for a medium / low match (or a second account that also matched). */
export interface OrbitCandidate {
  account_id: string;
  source: "orbit";
  source_id: string | null;
  source_name: string | null;
  source_domain: null;
  matched_on: MatchedOn;
  confidence: MatchConfidence;
  note: string;
}

export interface OrbitQuotesSummary {
  /** Quote rows attached to an account (a signal was written). */
  attached: number;
  /** Quote rows whose client matched nothing (a matched_on "none" candidate row was written). */
  unmatched: number;
  /** Quote rows whose client matched only at medium / low: candidate rows written, signal held. */
  pending_review: number;
  /** Rows not processed: status not Quote, or no date to observe them at. */
  skipped: number;
  /** Signals written, by type. */
  by_type: Record<string, number>;
}

export interface OrbitQuotesResult {
  signals: OrbitSignal[];
  facts: OrbitQuoteFact[];
  unmatched: OrbitUnmatched[];
  candidates: OrbitCandidate[];
  summary: OrbitQuotesSummary;
  /** Everything skipped or defaulted, in plain words, for the run log. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fold(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-–—]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** A number from a number or a numeric string ("12", "$12,500.00"). Null when empty or not numeric. */
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** DESIGN §4c map, fold-insensitive ("PA Sent" → pa_sent). Missing or unrecognised → quote_requested. */
export function signalTypeForLifeCycle(life_cycle_status: string | null | undefined): { type: string; recognised: boolean } {
  const f = fold(life_cycle_status);
  if (f.length === 0) return { type: DEFAULT_SIGNAL_TYPE, recognised: true };
  const mapped = LIFE_CYCLE_TO_SIGNAL[f];
  if (mapped !== undefined) return { type: mapped, recognised: true };
  return { type: DEFAULT_SIGNAL_TYPE, recognised: false };
}

/** The slug and the evidence URL for a project's `url` (a slug, or a full URL whose last segment is the slug). */
export function projectEvidence(url: string | null | undefined): { slug: string | null; evidence_url: string | null } {
  const raw = asText(url);
  if (raw === null) return { slug: null, evidence_url: null };
  if (/^https?:\/\//i.test(raw)) {
    const path = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const seg = path.split("/").pop() ?? "";
    return { slug: seg.length > 0 ? seg : null, evidence_url: raw };
  }
  const slug = raw.replace(/^\/+|\/+$/g, "");
  if (slug.length === 0) return { slug: null, evidence_url: null };
  return { slug, evidence_url: ORBIT_PROJECT_URL_BASE + slug };
}

function catalogEntry(rubric: Rubric, type: string): { weight: number; lifespan_days: number | null; decays: boolean } | null {
  const cat = (rubric as Record<string, any>)?.signals?.catalog?.[type];
  if (!cat || typeof cat !== "object") return null;
  const weight = asNumber(cat.weight);
  if (weight === null) return null;
  return { weight, lifespan_days: asNumber(cat.lifespan_days), decays: typeof cat.decays === "boolean" ? cat.decays : true };
}

function describeProject(row: OrbitProjectRow): string {
  const title = asText(row.title);
  const num = asText(row.project_number);
  return `Orbit quote ${JSON.stringify(title ?? `project ${row.id}`)}${num !== null ? ` (project ${num})` : ` (id ${row.id})`}`;
}

/* ------------------------------------------------------------------ *
 * mapOrbitQuotes
 * ------------------------------------------------------------------ */

export function mapOrbitQuotes(
  rows: OrbitProjectRow[],
  known: KnownAccount[],
  rubric: Rubric,
  opts: OrbitQuotesOptions = {},
): OrbitQuotesResult {
  const entered_by = opts.entered_by && opts.entered_by.trim().length > 0 ? opts.entered_by.trim() : DEFAULT_ENTERED_BY;
  const notes: string[] = [];
  const signals: OrbitSignal[] = [];
  const facts: OrbitQuoteFact[] = [];
  const summary: OrbitQuotesSummary = { attached: 0, unmatched: 0, pending_review: 0, skipped: 0, by_type: {} };

  /** One candidate row per (client, account) and one unmatched row per client; the note lists every project. */
  const unmatchedByClient = new Map<string, { row: OrbitUnmatched; projects: string[] }>();
  const candidateByClientAccount = new Map<string, { row: OrbitCandidate; projects: string[]; conflict: boolean }>();

  for (const row of rows ?? []) {
    const what = describeProject(row);

    const status = asText(row.status);
    if (status !== null && fold(status) !== "quote") {
      summary.skipped++;
      notes.push(`${what}: status ${JSON.stringify(status)} is not Quote; skipped`);
      continue;
    }

    let observedMs = parseMs(row.created_at);
    if (observedMs === null) {
      observedMs = parseMs(row.project_start_date);
      if (observedMs !== null) notes.push(`${what}: created_at missing; observed_at taken from project_start_date`);
    }
    if (observedMs === null) {
      observedMs = parseMs(opts.as_of);
      if (observedMs !== null) notes.push(`${what}: created_at and project_start_date missing; observed_at taken from as_of`);
    }
    if (observedMs === null) {
      summary.skipped++;
      notes.push(`${what}: no created_at, project_start_date or as_of; skipped (a signal needs an observed_at)`);
      continue;
    }
    const observedTs = new Date(observedMs).toISOString();
    const observedDate = observedTs.slice(0, 10);

    const { type, recognised } = signalTypeForLifeCycle(row.life_cycle_status);
    if (!recognised) notes.push(`${what}: life_cycle_status ${JSON.stringify(row.life_cycle_status)} is not in the §4c map; treated as ${DEFAULT_SIGNAL_TYPE}`);

    const { slug, evidence_url } = projectEvidence(row.url);
    const cost = asNumber(row.project_payment_cost);
    const quotedHours = asNumber(row.quoted_hours);
    const clientName = asText(row.client_name);
    const clientId = asText(row.client_id);
    const sourceId = clientId ?? String(row.id);
    const clientKey = clientId !== null ? `id:${clientId}` : clientName !== null ? `name:${norm(clientName)}` : `project:${row.id}`;
    const projectLabel = `${asText(row.project_number) ?? row.id}${asText(row.title) !== null ? ` ${JSON.stringify(asText(row.title))}` : ""}`;

    const proposal = proposeMatches(
      { source: ORBIT_SOURCE, source_id: row.id, name: clientName, orbit_client_id: clientId },
      known,
    );

    const addCandidate = (c: MatchCandidate, conflictWith: KnownAccount | null) => {
      const k = `${clientKey}|${c.account_id}`;
      const existing = candidateByClientAccount.get(k);
      if (existing) {
        existing.projects.push(projectLabel);
        existing.conflict = existing.conflict || conflictWith !== null;
        return;
      }
      candidateByClientAccount.set(k, {
        row: {
          account_id: c.account_id,
          source: ORBIT_SOURCE,
          source_id: sourceId,
          source_name: clientName,
          source_domain: null,
          matched_on: c.matched_on,
          confidence: c.confidence,
          note: "",
        },
        projects: [projectLabel],
        conflict: conflictWith !== null,
      });
    };

    if (proposal.attach !== null) {
      const attach = proposal.attach;
      const cat = catalogEntry(rubric, type);
      if (cat === null) {
        summary.skipped++;
        notes.push(`${what}: no rubric.signals.catalog entry for "${type}"; skipped`);
        continue;
      }
      signals.push({
        account_id: attach.id,
        type,
        observed_at: observedTs,
        payload: {
          project_id: row.id,
          url_slug: slug,
          title: asText(row.title),
          project_number: asText(row.project_number),
          project_type: asText(row.project_type),
          life_cycle_status: asText(row.life_cycle_status),
          client_name: clientName,
          sub_client_name: asText(row.sub_client_name),
          quoted_hours: quotedHours,
          project_payment_cost: cost,
        },
        source: ORBIT_SOURCE,
        weight: cat.weight,
        lifespan_days: cat.lifespan_days,
        decays: cat.decays,
        entered_by,
        evidence_url,
      });
      summary.attached++;
      summary.by_type[type] = (summary.by_type[type] ?? 0) + 1;

      if (cost !== null && cost > 0) {
        facts.push({
          account_id: attach.id,
          key: "quote_amount",
          value: cost,
          evidence_label: "evidence",
          source: ORBIT_SOURCE,
          observed_at: observedDate,
          entered_by,
          evidence_url,
          note: `${what}: project_payment_cost ${cost}${slug !== null ? ` — ${slug}` : ""}`,
        });
      } else if (cost === null && row.project_payment_cost !== null && row.project_payment_cost !== undefined) {
        notes.push(`${what}: project_payment_cost ${JSON.stringify(row.project_payment_cost)} is not a number; no quote_amount fact`);
      }

      // Any OTHER account that also matched is a conflict a person must see (identity.ts contract).
      for (const c of proposal.candidates) if (c.account_id !== attach.id) addCandidate(c, attach);
      continue;
    }

    if (proposal.candidates.length > 0) {
      summary.pending_review++;
      for (const c of proposal.candidates) addCandidate(c, null);
      continue;
    }

    summary.unmatched++;
    const existing = unmatchedByClient.get(clientKey);
    if (existing) {
      existing.projects.push(projectLabel);
    } else {
      unmatchedByClient.set(clientKey, {
        row: {
          source: ORBIT_SOURCE,
          source_id: sourceId,
          source_name: clientName,
          source_domain: null,
          matched_on: "none",
          confidence: "low",
          note: "",
        },
        projects: [projectLabel],
      });
    }
  }

  const unmatched: OrbitUnmatched[] = [];
  for (const { row, projects } of unmatchedByClient.values()) {
    const who = row.source_name !== null ? `client ${JSON.stringify(row.source_name)}` : "a project with no client name";
    row.note = `Orbit: no pb_accounts row matches ${who}; ${projects.length} quote${projects.length === 1 ? "" : "s"}: ${projects.join("; ")}`;
    unmatched.push(row);
  }

  const candidates: OrbitCandidate[] = [];
  for (const { row, projects, conflict } of candidateByClientAccount.values()) {
    const who = row.source_name !== null ? `client ${JSON.stringify(row.source_name)}` : `client id ${row.source_id}`;
    const how = `${row.confidence} match on ${row.matched_on}`;
    row.note = conflict
      ? `Orbit: ${who} attached elsewhere on a high key but ALSO matched this account (${how}) — a conflict a person must see; ${projects.length} quote${projects.length === 1 ? "" : "s"}: ${projects.join("; ")}`
      : `Orbit: ${who} — ${how}; not attached (only high attaches); ${projects.length} quote${projects.length === 1 ? "" : "s"} held until confirmed: ${projects.join("; ")}`;
    candidates.push(row);
  }

  return { signals, facts, unmatched, candidates, summary, notes };
}
