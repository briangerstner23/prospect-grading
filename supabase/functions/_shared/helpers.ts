/**
 * WLIQ Prospect Book — edge-function helpers shared by every function.
 *
 * PURE apart from Web Crypto (`crypto.subtle`, a global in Deno and Node 22). No clock, no
 * network, no filesystem, no `jsr:`/`npm:` imports, so `node --experimental-strip-types`
 * can run `helpers_test.ts` against this file. Handlers stay thin; anything with a branch in
 * it lives here or in one of the *_pure.ts siblings and is tested.
 *
 * The `DbLike` alias is the only concession to the supabase-js client: the pure modules take
 * a client as a parameter and never construct one (that is db.ts's job, and db.ts alone
 * imports `jsr:@supabase/supabase-js@2`).
 */

import { timingSafeEqualString } from "./ingest/webhook_signatures.ts";

// deno-lint-ignore no-explicit-any
export type DbLike = any;

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s.length === 0 ? null : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/** JSON response with the status given. Every handler answers through this. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** `Authorization: Bearer <token>` → the token, or null when absent or not a bearer. */
export function bearerToken(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const m = String(header).trim().match(/^bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

/**
 * Constant-time bearer comparison. An empty or missing secret refuses everything — a
 * function whose token is not configured must never default open.
 */
export function bearerMatches(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  const presented = bearerToken(header);
  if (presented === null) return false;
  return timingSafeEqualString(presented, secret);
}

/** `?a=1&preview=1` → {a: "1", preview: "1"}. Empty values are kept as "". */
export function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(url);
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    /* an unparseable URL has no params */
  }
  return out;
}

/** "1", "true", "yes", "on" (any case) → true. Anything else, including absent, → false. */
export function truthyParam(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

/** The header values worth keeping in pb_webhook_inbox.headers — never the whole set. */
export interface HeaderLike {
  get(name: string): string | null | undefined;
}

export function headerSubset(headers: HeaderLike | null | undefined, names: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const n of names) {
    let v: string | null | undefined = null;
    try {
      v = headers && typeof headers.get === "function" ? headers.get(n) : null;
    } catch {
      v = null;
    }
    out[n] = v === undefined || v === null ? null : String(v);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * JSON, hashing, batching, dates
 * ------------------------------------------------------------------ */

export type ParsedJson = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse without throwing. The inbox stores `{raw}` when this fails, so nothing is lost. */
export function safeJsonParse(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The inbox body: the parsed JSON, or `{raw}` when the payload was not JSON. */
export function inboxBody(rawBody: string, parsed: ParsedJson): unknown {
  if (parsed.ok && parsed.value !== null && typeof parsed.value === "object") return parsed.value;
  return { raw: rawBody };
}

/** SHA-256 of a UTF-8 string, lower-case hex. Web Crypto; async by nature. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Split into slices of at most `size`. `size` < 1 is treated as 1. */
export function chunk<T>(rows: readonly T[], size = 200): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/** ISO timestamp `days` after `iso`; null when `iso` is not a date. */
export function addDays(iso: string, days: number): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !Number.isFinite(days)) return null;
  return new Date(ms + days * 86_400_000).toISOString();
}

/** ISO → YYYY-MM-DD (pb_reads.as_of is a date). null when unparseable. */
export function isoDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Error → message, for pb_runs.errors and inbox.error. Never throws. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Keep the counts jsonb small and stable: every key a number, in a fixed order. */
export function tally<K extends string>(keys: readonly K[], values: Partial<Record<K, number>>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = Number.isFinite(values[k] as number) ? (values[k] as number) : 0;
  return out;
}
