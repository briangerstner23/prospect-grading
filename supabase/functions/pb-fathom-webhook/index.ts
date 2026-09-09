/**
 * pb-fathom-webhook — Standard-Webhooks signature check → pb_webhook_inbox → pb_calls
 * (DESIGN.md §4e).
 *
 *   GET   → {ok:true, service:'pb-fathom-webhook'}       reachability
 *   POST  → the delivery
 *
 * Order of work, and why:
 *   0. Body cap, 1 MB (MAX_WEBHOOK_BODY_BYTES). A Content-Length over the cap is answered 413
 *      before the body is read; without one the body is read up to the cap and cut off there —
 *      also 413. Nothing over the cap is stored.
 *   1. Read the raw body as text (re-serialising JSON would break the MAC).
 *   2. Verify with verifyStandardWebhook against PB_FATHOM_WEBHOOK_SECRET (Vault). An unset
 *      secret is "not verified — secret not configured", never a pass.
 *   3. ALWAYS insert pb_webhook_inbox {source 'fathom', headers (webhook-id, webhook-timestamp,
 *      has-signature — never the signature), body, verified, error}. What `body` holds depends
 *      on the outcome (webhook_pure.inboxRow):
 *        verified                 the parsed JSON (or {raw})
 *        secret not configured    the parsed JSON (or {raw}), kept whole for replay once the
 *                                 secret is set
 *        verification failed      a digest only — {stored:'digest', body_sha256, body_bytes,
 *                                 reason}. An unauthenticated sender does not fill the inbox.
 *      Only inboxing failing itself returns non-2xx.
 *   4. If verified: parseFathomWebhook with the known accounts. If the call is external: upsert
 *      pb_calls on fathom_recording_id and insert identity candidates. Internal-only calls are
 *      skipped and counted. NO signal is raised from an inbound call in Phase 1 — the pb_calls
 *      row is the record; the seven-field extraction (later, confirmed by a person) is what may
 *      read it.
 *   5. Mark the inbox row processed_at and write a pb_runs row (kind webhook, source fathom).
 *   6. Return 200. Fathom retries on any non-2xx, which would re-deliver the same payload; an
 *      unverified delivery is therefore answered 200 with verified:false and left in the inbox
 *      (whole, or as a digest). The exceptions: 413 over the cap; 500 when the inbox insert
 *      failed; 500 when the secret could not be READ from Vault (a fault on our side — only a
 *      digest was kept, so the retry is wanted).
 *
 * Deploy with verify_jwt = false: Fathom signs with Standard Webhooks, not a Supabase JWT.
 */

import { serviceClient, insertBatches } from "../_shared/db.ts";
import { getSecret } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { declaredContentLength, errorMessage, exceedsCap, json, MAX_WEBHOOK_BODY_BYTES, readBodyCapped, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import { callRowForUpsert, candidateRows, fathomInboxHeaders, inboxRow } from "../_shared/webhook_pure.ts";
import { verifyStandardWebhook } from "../_shared/ingest/webhook_signatures.ts";
import { parseFathomWebhook } from "../_shared/ingest/fathom_webhook.ts";
import type { FathomWebhookPayload } from "../_shared/ingest/fathom_webhook.ts";
import type { KnownAccount } from "../_shared/ingest/identity.ts";

const SERVICE = "pb-fathom-webhook";
const KNOWN_COLS = "id,key,name,domain,pipedrive_org_id,orbit_client_id";

function tooLarge(bytes: number | null): Response {
  return json({ ok: false, error: "payload too large", max_bytes: MAX_WEBHOOK_BODY_BYTES, bytes }, 413);
}

async function markInbox(db: DbLike, inboxId: string, error: string | null): Promise<void> {
  await db.from("pb_webhook_inbox").update({ processed_at: new Date().toISOString(), error }).eq("id", inboxId);
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json({ ok: true, service: SERVICE });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  /* ---- 0. cap: a declared length over it is refused before anything is read ---- */
  const declared = declaredContentLength(req.headers);
  if (exceedsCap(declared)) return tooLarge(declared);

  let db: DbLike;
  try {
    db = serviceClient();
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  /* ---- 1. raw body, read up to the cap ---- */
  const read = await readBodyCapped(req.body, MAX_WEBHOOK_BODY_BYTES);
  if (!read.ok) return tooLarge(read.bytes);
  const rawBody = read.text;
  const parsed = safeJsonParse(rawBody);

  /* ---- 2. verify ---- */
  let verified = false;
  let reason: string | null = null;
  let secretConfigured: boolean | null = null;
  try {
    const secret = await getSecret(db, "PB_FATHOM_WEBHOOK_SECRET");
    if (secret === null) {
      secretConfigured = false;
      reason = "secret not configured (PB_FATHOM_WEBHOOK_SECRET); stored unverified for replay";
    } else {
      secretConfigured = true;
      const v = await verifyStandardWebhook(rawBody, req.headers, secret, Math.floor(Date.now() / 1000));
      verified = v.ok;
      reason = v.ok ? null : v.reason;
    }
  } catch (e) {
    secretConfigured = null;
    reason = `verification error: ${errorMessage(e)}`;
  }

  /* ---- 3. inbox, always — the whole body only when verified or when no secret is set ---- */
  const inbox = await inboxRow({
    source: "fathom",
    headers: fathomInboxHeaders(req.headers),
    rawBody,
    parsed,
    bodyBytes: read.bytes,
    verified,
    secretConfigured,
    reason,
  });
  let inboxId: string;
  try {
    const { data, error } = await db.from("pb_webhook_inbox").insert(inbox.row).select("id").single();
    if (error) throw new Error(error.message);
    inboxId = String(data.id);
  } catch (e) {
    // The one non-2xx on a well-formed delivery: nothing was stored, so Fathom's retry is wanted.
    return json({ ok: false, error: `inbox insert failed: ${errorMessage(e)}` }, 500);
  }

  if (!verified) {
    console.log(`${SERVICE}: unverified delivery inboxed (${inboxId}, ${inbox.storage}): ${reason}`);
    // The secret could not be read — our fault, and only a digest was kept: ask Fathom to retry.
    if (secretConfigured === null) return json({ ok: false, inbox_id: inboxId, verified: false, stored: inbox.storage, reason }, 500);
    return json({ ok: true, inbox_id: inboxId, verified: false, stored: inbox.storage, reason });
  }
  if (!parsed.ok) {
    await markInbox(db, inboxId, `body is not JSON: ${parsed.error}`);
    return json({ ok: true, inbox_id: inboxId, verified: true, processed: false, reason: "body is not JSON" });
  }

  /* ---- 4. parse → rows (no signal: the pb_calls row is the record) ---- */
  const counts: Rec = { calls: 0, candidates: 0, skipped: 0 };
  const errors: string[] = [];
  const notes: string[] = [];
  let runId: string | null = null;
  try {
    runId = await startRun(db, "webhook", "fathom", SERVICE);

    const { data: knownRows, error: knownErr } = await db.from("pb_accounts").select(KNOWN_COLS);
    if (knownErr) throw new Error(`pb_accounts: ${knownErr.message}`);
    const known = (knownRows ?? []) as KnownAccount[];

    const result = parseFathomWebhook(parsed.value as FathomWebhookPayload, known);
    notes.push(...result.notes);

    if (result.skip_reason !== null || !result.external) {
      counts.skipped = 1;
      notes.push(`skipped: ${result.skip_reason ?? "no external attendee"}`);
    } else {
      const accountId = result.attach ? result.attach.id : result.call.account_id;
      const callRow = callRowForUpsert(result.call, accountId);
      const { error: callErr } = await db.from("pb_calls").upsert(callRow, { onConflict: "fathom_recording_id" });
      if (callErr) errors.push(`pb_calls upsert: ${callErr.message}`);
      else counts.calls = 1;

      const cands = candidateRows(result.candidates);
      if (cands.length) {
        const r = await insertBatches(db, "pb_identity_candidates", cands);
        counts.candidates = r.wrote;
        errors.push(...r.errors);
      }

      if (accountId === null) notes.push("call not attached to an account (no high domain match); candidates written");
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }

  /* ---- 5. bookkeeping ---- */
  try {
    await markInbox(db, inboxId, errors.length ? errors.join("; ") : null);
    if (runId !== null) {
      const written = Number(counts.calls) + Number(counts.candidates);
      await finishRun(db, runId, runStatus(written + Number(counts.skipped), errors.length), { ...counts, notes }, errors);
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }
  if (errors.length) console.error(`${SERVICE}: inbox ${inboxId}: ${errors.join("; ")}`);

  /* ---- 6. 200 always after inboxing ---- */
  return json({ ok: errors.length === 0, inbox_id: inboxId, run_id: runId, verified: true, processed: true, counts, errors, notes });
});
