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
 * Body size cap — the webhooks refuse anything over it with 413, before storing anything
 * ------------------------------------------------------------------ */

/** The largest webhook body accepted: 1 MB. A Fathom delivery with a transcript is far under it. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** `Content-Length` as a non-negative integer; null when absent or not a plain number. */
export function declaredContentLength(headers: HeaderLike | null | undefined): number | null {
  let v: string | null | undefined = null;
  try {
    v = headers && typeof headers.get === "function" ? headers.get("content-length") : null;
  } catch {
    v = null;
  }
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** True when a declared length is known and over the cap — the handler answers 413 before reading. */
export function exceedsCap(declared: number | null, cap = MAX_WEBHOOK_BODY_BYTES): boolean {
  return declared !== null && declared > cap;
}

export type CappedBody =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "body too large"; bytes: number };

/**
 * Read a body stream up to `cap` bytes. Reading stops — and the stream is cancelled — the moment
 * the running total passes the cap, so an oversize delivery is never held whole. The text is
 * the UTF-8 decode of the bytes exactly as received (a signature is over those bytes; nothing
 * is re-serialised). `bytes` is the length read: the full body when ok, the count at the cut
 * when not.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null | undefined, cap = MAX_WEBHOOK_BODY_BYTES): Promise<CappedBody> {
  if (!body) return { ok: true, text: "", bytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        /* the stream is abandoned either way */
      }
      return { ok: false, reason: "body too large", bytes: total };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(all), bytes: total };
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

/**
 * Drive a paged query to exhaustion, `page` rows at a time.
 *
 * PostgREST caps a response at 1000 rows by default and says so in no way the client can
 * notice: `data` simply arrives 1000 long. The cap is per REQUEST, not per filter value, so
 * "one request for 100 accounts" is capped at 1000 rows whatever those 100 accounts hold — and
 * ~10 facts per account puts 100 accounts exactly on the line. That is not hypothetical: on
 * 12 Sep 2026 pb-score scored two accounts as Unclassified because their `icp_class` sat past
 * row 1000 of their chunk, with the facts present in the table and the view the whole time.
 *
 * Stopping rule: a short page is the last one. A page that comes back exactly `page` long may
 * or may not be the end, so it costs one more request to find out — which is why a total that
 * is an exact multiple of `page` always fetches one empty page. Cheaper than guessing wrong.
 *
 * The caller supplies the fetch, so this stays pure: no clock, no network, no vendor import,
 * and testable with a stub that counts calls.
 */
export async function collectPages<T>(
  page: number,
  fetchPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const size = Math.max(1, Math.floor(page));
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const rows = await fetchPage(from, from + size - 1);
    out.push(...rows);
    if (rows.length < size) return out;
  }
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
