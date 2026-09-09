/**
 * WLIQ Prospect Book — webhook signature checks (DESIGN.md §4d, §4e).
 *
 * PURE apart from Web Crypto (`crypto.subtle`, a global in Deno and in Node 22). No clock —
 * `nowSeconds` is an input. No network, no filesystem, no dependencies. Runs under Deno and
 * under `node --experimental-strip-types`.
 *
 * Two endpoints, two schemes:
 *
 *   Fathom     → Standard Webhooks (https://www.standardwebhooks.com). Headers `webhook-id`,
 *                `webhook-timestamp`, `webhook-signature`; signed content is
 *                `${id}.${timestamp}.${body}`; HMAC-SHA256 with the secret; the header holds
 *                space-separated `v1,<base64>` entries (any one matching passes). The secret
 *                Fathom returns is `whsec_<base64>`; the prefix is stripped and the remainder
 *                base64-decoded into the key. A `whsec_` prefix promises base64: a remainder
 *                that is not base64 is refused with its own reason, never silently used as
 *                text. A secret WITHOUT the prefix is base64-decoded when it is base64 and
 *                otherwise used as raw UTF-8 — a plain-string secret still works.
 *   Pipedrive  → HTTP Basic against a stored `user:pass` pair.
 *
 * The stored secret is trimmed once, at this boundary: a Vault value pasted with a trailing
 * newline is the same secret. The presented credential is never trimmed.
 *
 * Every comparison is constant-time. Every refusal carries a reason the handler writes to
 * `pb_webhook_inbox.error`; an unverified delivery is stored and never processed.
 */

/* ------------------------------------------------------------------ *
 * Bytes, text, base64
 * ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

export function utf8Bytes(s: string): Uint8Array {
  return utf8.encode(s);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

/** Standard base64 (RFC 4648 §4) with padding. */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += rem === 2 ? B64[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

/**
 * Strict standard-alphabet base64 decode. Padding is optional; whitespace, the URL-safe
 * alphabet and any other character are refused with null. Callers use null to fall back —
 * nothing here throws.
 */
export function base64Decode(s: string): Uint8Array | null {
  if (typeof s !== "string") return null;
  let body = s;
  let pad = 0;
  while (body.endsWith("=") && pad < 2) {
    body = body.slice(0, -1);
    pad++;
  }
  if (body.length === 0) return pad === 0 ? new Uint8Array(0) : null;
  if (body.length % 4 === 1) return null;
  if (pad > 0 && (body.length + pad) % 4 !== 0) return null;
  for (const ch of body) if (!(ch in B64_INDEX)) return null;
  const outLen = Math.floor((body.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of body) {
    acc = (acc << 6) | B64_INDEX[ch];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Constant-time byte comparison. Runs over the longer input regardless of where the first
 * difference is, and folds the length difference into the result rather than returning early.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

/** Constant-time comparison of two strings by their UTF-8 bytes. */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(utf8Bytes(a), utf8Bytes(b));
}

/* ------------------------------------------------------------------ *
 * HMAC-SHA256
 * ------------------------------------------------------------------ */

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("webhook_signatures: crypto.subtle is not available in this runtime");
  // Web Crypto refuses a zero-length HMAC key in some runtimes; HMAC defines an empty key as
  // equivalent to a block of zero bytes, so substitute one byte of zero — the same result.
  const keyBytes = key.length === 0 ? new Uint8Array(1) : key;
  const k = await subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle.sign("HMAC", k, message as BufferSource);
  return new Uint8Array(sig);
}

/** HMAC-SHA256 of `body` under the UTF-8 bytes of `secret`, lower-case hex. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  return hexEncode(await hmacSha256(utf8Bytes(secret), utf8Bytes(body)));
}

/* ------------------------------------------------------------------ *
 * Standard Webhooks
 * ------------------------------------------------------------------ */

export const STANDARD_WEBHOOK_SECRET_PREFIX = "whsec_";

/** The refusal reason for a `whsec_`-prefixed secret whose remainder is not base64. */
export const REASON_SECRET_NOT_BASE64 = "secret has the whsec_ prefix but is not base64";

/** The stored secret as this module reads it: trimmed once, here, and nowhere else. */
function trimSecret(secret: unknown): string {
  return String(secret ?? "").trim();
}

/**
 * Why a Standard Webhooks secret cannot be used, or null when it can:
 *   empty after trimming                              → "secret not configured"
 *   `whsec_` prefix, remainder not (non-empty) base64 → REASON_SECRET_NOT_BASE64
 * A secret without the prefix is always usable (base64 when it decodes, raw UTF-8 otherwise).
 */
export function standardWebhookSecretProblem(secret: string): string | null {
  const s = trimSecret(secret);
  if (s.length === 0) return "secret not configured";
  if (s.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)) {
    const decoded = base64Decode(s.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length));
    if (decoded === null || decoded.length === 0) return REASON_SECRET_NOT_BASE64;
  }
  return null;
}

/**
 * The HMAC key for a Standard Webhooks secret (trimmed): strip `whsec_`, base64-decode the
 * remainder; when there is no prefix and the secret is not base64, its raw UTF-8 bytes.
 * verifyStandardWebhook refuses a `whsec_` secret that is not base64 before reaching here
 * (standardWebhookSecretProblem); for such a secret this function still answers with the raw
 * bytes so a caller that skipped that check gets a deterministic key, never a throw.
 */
export function standardWebhookKey(secret: string): Uint8Array {
  const s = trimSecret(secret);
  const stripped = s.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX) ? s.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length) : s;
  const decoded = base64Decode(stripped);
  if (decoded !== null && decoded.length > 0) return decoded;
  return utf8Bytes(s);
}

/** The `v1,<base64>` entry a sender would put in `webhook-signature` for this delivery. */
export async function signStandardWebhook(
  webhookId: string,
  timestampSeconds: number | string,
  rawBody: string,
  secret: string,
): Promise<string> {
  const content = `${webhookId}.${String(timestampSeconds)}.${rawBody}`;
  const mac = await hmacSha256(standardWebhookKey(secret), utf8Bytes(content));
  return `v1,${base64Encode(mac)}`;
}

export interface HeaderReader {
  get(name: string): string | null | undefined;
}

export interface VerifyResult {
  ok: boolean;
  /** "ok", or the reason the delivery is refused — written to pb_webhook_inbox.error. */
  reason: string;
}

function headerValue(headers: HeaderReader, name: string): string | null {
  if (!headers || typeof headers.get !== "function") return null;
  const v = headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Verify a Standard Webhooks delivery.
 *
 *   rawBody           the request body EXACTLY as received (re-serialising JSON breaks the MAC)
 *   headers           anything with get(name) — a fetch Headers object or a plain adapter
 *   secret            the stored `whsec_…` (or plain) secret, trimmed here; an empty secret
 *                     refuses everything, a `whsec_` secret that is not base64 refuses with
 *                     REASON_SECRET_NOT_BASE64
 *   nowSeconds        the receiver's clock, unix seconds, passed in
 *   toleranceSeconds  |now − webhook-timestamp| beyond this is refused (default 300)
 */
export async function verifyStandardWebhook(
  rawBody: string,
  headers: HeaderReader,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<VerifyResult> {
  const secretProblem = typeof secret === "string" ? standardWebhookSecretProblem(secret) : "secret not configured";
  if (secretProblem !== null) return { ok: false, reason: secretProblem };
  if (typeof rawBody !== "string") return { ok: false, reason: "body is not a string" };

  const id = headerValue(headers, "webhook-id");
  if (id === null) return { ok: false, reason: "missing header webhook-id" };
  const ts = headerValue(headers, "webhook-timestamp");
  if (ts === null) return { ok: false, reason: "missing header webhook-timestamp" };
  const sigHeader = headerValue(headers, "webhook-signature");
  if (sigHeader === null) return { ok: false, reason: "missing header webhook-signature" };

  if (!/^\d+$/.test(ts)) return { ok: false, reason: "invalid webhook-timestamp" };
  const tsNum = Number(ts);
  if (!Number.isFinite(nowSeconds)) return { ok: false, reason: "invalid receiver clock" };
  const tol = Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0 ? toleranceSeconds : 300;
  if (Math.abs(nowSeconds - tsNum) > tol) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = await hmacSha256(standardWebhookKey(secret), utf8Bytes(`${id}.${ts}.${rawBody}`));

  let sawV1 = false;
  let matched = false;
  for (const entry of sigHeader.split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma < 0) continue;
    const version = entry.slice(0, comma);
    const value = entry.slice(comma + 1);
    if (version !== "v1") continue; // v1a (asymmetric) and unknown versions are not checked here
    sawV1 = true;
    const given = base64Decode(value);
    // Compare even an undecodable entry against something, so the work done does not depend
    // on which entry is malformed.
    const ok = timingSafeEqual(given ?? new Uint8Array(0), expected);
    matched = matched || ok;
  }
  if (!sawV1) return { ok: false, reason: "no v1 signature" };
  return matched ? { ok: true, reason: "ok" } : { ok: false, reason: "signature mismatch" };
}

/* ------------------------------------------------------------------ *
 * HTTP Basic
 * ------------------------------------------------------------------ */

/**
 * `Authorization: Basic <base64(user:pass)>` against the stored `user:pass`, which is trimmed
 * once here (a Vault value with a trailing newline is the same pair; the presented credential
 * is compared byte for byte). Constant-time on the credential bytes. An empty expected value
 * refuses everything (secret not configured).
 */
export function verifyBasicAuth(header: string | null | undefined, expectedUserColonPass: string): boolean {
  if (typeof expectedUserColonPass !== "string") return false;
  const expected = trimSecret(expectedUserColonPass);
  if (expected.length === 0) return false;
  if (header === null || header === undefined) return false;
  const m = String(header).trim().match(/^basic\s+(\S+)\s*$/i);
  if (!m) return false;
  const decoded = base64Decode(m[1]);
  if (decoded === null) return false;
  return timingSafeEqual(decoded, utf8Bytes(expected));
}

/** The header value a client sends for `user:pass` — for tests and for documentation. */
export function basicAuthHeader(userColonPass: string): string {
  return `Basic ${base64Encode(utf8Bytes(userColonPass))}`;
}
