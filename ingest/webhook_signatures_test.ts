/**
 * WLIQ Prospect Book — webhook signature tests.
 *
 * Run:  node --experimental-strip-types ingest/webhook_signatures_test.ts
 *   or: deno run ingest/webhook_signatures_test.ts
 *
 * Vectors are computed here with Web Crypto directly (never through the module under test),
 * plus three published fixed vectors: the Standard Webhooks specification example, RFC 4231
 * test case 2 and the HMAC-SHA256 example on the HMAC Wikipedia page.
 */

import {
  base64Decode,
  base64Encode,
  basicAuthHeader,
  hmacSha256Hex,
  REASON_SECRET_NOT_BASE64,
  signStandardWebhook,
  standardWebhookKey,
  standardWebhookSecretProblem,
  timingSafeEqual,
  verifyBasicAuth,
  verifyStandardWebhook,
} from "./webhook_signatures.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

/* ---- independent HMAC, straight from Web Crypto ---- */
const enc = new TextEncoder();
async function refHmacBase64(key: Uint8Array, content: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(content)));
  // btoa is a global in Deno and Node 18+; used only here so the module's own encoder is not trusted.
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
function refBase64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function main() {
  /* ------------------------------------------------------------------ *
   * 1 · base64 and constant-time compare
   * ------------------------------------------------------------------ */

  eq("base64Encode of 'hi'", base64Encode(enc.encode("hi")), "aGk=");
  eq("base64Encode of 'hello'", base64Encode(enc.encode("hello")), "aGVsbG8=");
  eq("base64Encode of three bytes has no padding", base64Encode(enc.encode("abc")), "YWJj");
  eq("base64Decode round-trips", Array.from(base64Decode("aGVsbG8=") ?? []), Array.from(enc.encode("hello")));
  eq("base64Decode accepts missing padding", Array.from(base64Decode("aGVsbG8") ?? []), Array.from(enc.encode("hello")));
  eq("base64Decode refuses URL-safe alphabet", base64Decode("a-b_"), null);
  eq("base64Decode refuses whitespace", base64Decode("aGVs bG8="), null);
  eq("base64Decode refuses a lone character", base64Decode("a"), null);
  eq("base64Decode of empty is empty", base64Decode("")?.length, 0);
  check("timingSafeEqual: equal", timingSafeEqual(enc.encode("abc"), enc.encode("abc")));
  check("timingSafeEqual: different bytes", !timingSafeEqual(enc.encode("abc"), enc.encode("abd")));
  check("timingSafeEqual: different length", !timingSafeEqual(enc.encode("abc"), enc.encode("abcd")));
  check("timingSafeEqual: both empty", timingSafeEqual(new Uint8Array(0), new Uint8Array(0)));

  /* ------------------------------------------------------------------ *
   * 2 · hmacSha256Hex against published vectors
   * ------------------------------------------------------------------ */

  eq(
    "RFC 4231 test case 2",
    await hmacSha256Hex("Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  eq(
    "Wikipedia HMAC_SHA256 example",
    await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  eq("hmacSha256Hex is 64 lower-case hex chars", /^[0-9a-f]{64}$/.test(await hmacSha256Hex("k", "m")), true);

  /* ------------------------------------------------------------------ *
   * 3 · Standard Webhooks — the specification's own example
   * ------------------------------------------------------------------ */

  const SPEC = {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    ts: "1614265330",
    body: '{"test": 2432232314}',
    sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  };
  const specHeaders = new Headers({ "webhook-id": SPEC.id, "webhook-timestamp": SPEC.ts, "webhook-signature": SPEC.sig });
  eq("spec example verifies", await verifyStandardWebhook(SPEC.body, specHeaders, SPEC.secret, Number(SPEC.ts)), { ok: true, reason: "ok" });
  eq("signStandardWebhook reproduces the spec signature", await signStandardWebhook(SPEC.id, SPEC.ts, SPEC.body, SPEC.secret), SPEC.sig);
  eq(
    "standardWebhookKey strips whsec_ and base64-decodes",
    Array.from(standardWebhookKey(SPEC.secret)),
    Array.from(refBase64ToBytes("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")),
  );

  /* ------------------------------------------------------------------ *
   * 4 · Standard Webhooks — vectors computed here
   * ------------------------------------------------------------------ */

  const rawKey = enc.encode("harbor-and-pine-signing-key-0123456789");
  const secret = "whsec_" + base64Encode(rawKey);
  const id = "msg_2Xb7Qk9Ls";
  const now = 1_757_400_000; // unix seconds, any fixed instant
  const body = '{"recording_id":9001,"title":"Discovery — Harbor & Pine Creative"}';
  const ts = String(now - 10);
  const good = "v1," + (await refHmacBase64(rawKey, `${id}.${ts}.${body}`));
  const H = (o: Record<string, string>) => new Headers(o);

  eq("valid signature passes", await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, now), { ok: true, reason: "ok" });
  eq("header lookup is case-insensitive", (await verifyStandardWebhook(body, H({ "Webhook-Id": id, "Webhook-Timestamp": ts, "Webhook-Signature": good }), secret, now)).ok, true);
  eq("tampered body fails", (await verifyStandardWebhook(body.replace("9001", "9002"), H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, now)).reason, "signature mismatch");
  eq("wrong secret fails", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), "whsec_" + base64Encode(enc.encode("other")), now)).reason, "signature mismatch");
  eq("different id fails", (await verifyStandardWebhook(body, H({ "webhook-id": "msg_other", "webhook-timestamp": ts, "webhook-signature": good }), secret, now)).reason, "signature mismatch");
  eq("too old fails", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, now + 400)).reason, "timestamp outside tolerance");
  eq("too far in the future fails", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, now - 400)).reason, "timestamp outside tolerance");
  eq("exactly at tolerance passes", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, Number(ts) + 300)).ok, true);
  eq("one past tolerance fails", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, Number(ts) + 301)).ok, false);
  eq("custom tolerance is honoured", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret, Number(ts) + 30, 20)).reason, "timestamp outside tolerance");
  eq("missing webhook-id", (await verifyStandardWebhook(body, H({ "webhook-timestamp": ts, "webhook-signature": good }), secret, now)).reason, "missing header webhook-id");
  eq("missing webhook-timestamp", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-signature": good }), secret, now)).reason, "missing header webhook-timestamp");
  eq("missing webhook-signature", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts }), secret, now)).reason, "missing header webhook-signature");
  eq("non-numeric timestamp", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": "yesterday", "webhook-signature": good }), secret, now)).reason, "invalid webhook-timestamp");
  eq("empty secret refuses everything", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), "", now)).reason, "secret not configured");
  eq("multiple entries, one valid, passes", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good}` }), secret, now)).ok, true);
  eq("v1a entries are ignored; no v1 present", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1a,abcdef" }), secret, now)).reason, "no v1 signature");
  eq("a malformed v1 entry alone fails", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1,not*base64" }), secret, now)).reason, "signature mismatch");
  eq("a plain (non-base64) secret is used as raw UTF-8", (await verifyStandardWebhook(
    body,
    H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1," + (await refHmacBase64(enc.encode("plain secret with spaces!"), `${id}.${ts}.${body}`)) }),
    "plain secret with spaces!",
    now,
  )).ok, true);
  eq("a base64 secret without the whsec_ prefix is decoded", (await verifyStandardWebhook(
    body,
    H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }),
    base64Encode(rawKey),
    now,
  )).ok, true);
  eq("signStandardWebhook and verify agree", (await verifyStandardWebhook(
    body,
    H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": await signStandardWebhook(id, ts, body, secret) }),
    secret,
    now,
  )).ok, true);
  eq("a plain object with get() works as headers", (await verifyStandardWebhook(
    body,
    { get: (n: string) => ({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good } as Record<string, string>)[n.toLowerCase()] ?? null },
    secret,
    now,
  )).ok, true);

  /* the stored secret is trimmed once, at the boundary */
  eq("a secret with a trailing newline verifies", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), secret + "\n", now)).ok, true);
  eq("a secret with surrounding whitespace verifies", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), `  ${secret}\r\n`, now)).ok, true);
  eq("standardWebhookKey trims before decoding", Array.from(standardWebhookKey(secret + "\n")), Array.from(rawKey));
  eq("a plain secret with a trailing newline is trimmed too", (await verifyStandardWebhook(
    body,
    H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1," + (await refHmacBase64(enc.encode("plain secret with spaces!"), `${id}.${ts}.${body}`)) }),
    "plain secret with spaces!\n",
    now,
  )).ok, true);
  eq("a whitespace-only secret is 'secret not configured'", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), " \n", now)).reason, "secret not configured");

  /* a whsec_ prefix promises base64 */
  eq("whsec_ with a non-base64 remainder is refused with its own reason", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), "whsec_not*base64", now)).reason, REASON_SECRET_NOT_BASE64);
  eq("a bare 'whsec_' is refused the same way", (await verifyStandardWebhook(body, H({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": good }), "whsec_", now)).reason, REASON_SECRET_NOT_BASE64);
  eq("the not-base64 reason is distinct from a mismatch and from unconfigured", [REASON_SECRET_NOT_BASE64 !== "signature mismatch", REASON_SECRET_NOT_BASE64 !== "secret not configured"], [true, true]);
  eq(
    "standardWebhookSecretProblem: good whsec_ / good plain / empty / bad whsec_ / trimmed whsec_",
    [standardWebhookSecretProblem(secret), standardWebhookSecretProblem("plain secret with spaces!"), standardWebhookSecretProblem("   "), standardWebhookSecretProblem("whsec_%%%"), standardWebhookSecretProblem(secret + "\n")],
    [null, null, "secret not configured", REASON_SECRET_NOT_BASE64, null],
  );

  /* ------------------------------------------------------------------ *
   * 5 · HTTP Basic
   * ------------------------------------------------------------------ */

  const pair = "pb-webhook:s3cr3t-pass";
  const header = basicAuthHeader(pair);
  eq("basicAuthHeader encodes user:pass", header, "Basic " + btoa(pair));
  check("valid Basic header passes", verifyBasicAuth(header, pair));
  check("scheme is case-insensitive", verifyBasicAuth("basic " + btoa(pair), pair));
  check("surrounding whitespace tolerated", verifyBasicAuth("  Basic " + btoa(pair) + "  ", pair));
  check("wrong password fails", !verifyBasicAuth(basicAuthHeader("pb-webhook:wrong"), pair));
  check("wrong user fails", !verifyBasicAuth(basicAuthHeader("other:s3cr3t-pass"), pair));
  check("prefix of the credential fails", !verifyBasicAuth(basicAuthHeader("pb-webhook:s3cr3t-pas"), pair));
  check("Bearer scheme fails", !verifyBasicAuth("Bearer " + btoa(pair), pair));
  check("null header fails", !verifyBasicAuth(null, pair));
  check("undefined header fails", !verifyBasicAuth(undefined, pair));
  check("empty header fails", !verifyBasicAuth("", pair));
  check("undecodable credential fails", !verifyBasicAuth("Basic not*base64", pair));
  check("empty expected refuses everything", !verifyBasicAuth(basicAuthHeader(""), ""));
  check("whitespace-only expected refuses everything", !verifyBasicAuth(basicAuthHeader(" "), " \n"));
  check("password with a colon works", verifyBasicAuth(basicAuthHeader("u:p:q"), "u:p:q"));
  check("expected value with a trailing newline is trimmed", verifyBasicAuth(header, pair + "\n"));
  check("expected value with surrounding whitespace is trimmed", verifyBasicAuth(header, `  ${pair}\r\n`));
  check("the presented credential is NOT trimmed (a newline inside it is a mismatch)", !verifyBasicAuth(basicAuthHeader(pair + "\n"), pair));

  /* ------------------------------------------------------------------ *
   * report
   * ------------------------------------------------------------------ */

  const total = passed + failures.length;
  if (failures.length > 0) {
    console.error(`webhook_signatures_test: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    if (typeof (globalThis as { process?: { exit: (c: number) => void } }).process !== "undefined") {
      (globalThis as unknown as { process: { exit: (c: number) => void } }).process.exit(1);
    } else {
      throw new Error("webhook_signatures_test failed");
    }
  } else {
    console.log(`webhook_signatures_test: ${passed} checks passed`);
  }
}

await main();
