/**
 * pb-fathom-webhook — Standard-Webhooks signature check → pb_webhook_inbox → pb_calls
 * (DESIGN.md §4e).
 *
 *   GET   → {ok:true, service:'pb-fathom-webhook'}       reachability
 *   POST  → the delivery
 *
 * Order of work, and why:
 *   1. Read the raw body as text (re-serialising JSON would break the MAC).
 *   2. Verify with verifyStandardWebhook against PB_FATHOM_WEBHOOK_SECRET (Vault). An unset
 *      secret is "not verified — secret not configured", never a pass.
 *   3. ALWAYS insert pb_webhook_inbox {source 'fathom', headers (webhook-id, webhook-timestamp,
 *      has-signature — never the signature), body (parsed JSON or {raw}), verified, error}. This
 *      is the durable copy; nothing that reaches this function is lost, even before the secret
 *      is set. Only inboxing failing itself returns non-2xx.
 *   4. If verified: parseFathomWebhook with the known accounts. If the call is external:
 *      upsert pb_calls on fathom_recording_id, insert identity candidates, and — when the call
 *      attached to an account — insert ONE signal of type next_step_agreed ONLY if the payload
 *      carries non-empty action_items (a documented approximation; the extraction step
 *      supersedes it). Internal-only calls are skipped and counted.
 *   5. Mark the inbox row processed_at and write a pb_runs row (kind webhook, source fathom).
 *   6. Return 200. Fathom retries on any non-2xx, which would re-inbox the same payload; an
 *      unverified delivery is therefore answered 200 with verified:false and left in the inbox
 *      for replay once the secret is right.
 *
 * Deploy with verify_jwt = false: Fathom signs with Standard Webhooks, not a Supabase JWT.
 */

import { serviceClient, insertBatches } from "../_shared/db.ts";
import { getSecret } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { loadRubric } from "../_shared/rubric.ts";
import { errorMessage, inboxBody, json, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import { callRowForUpsert, candidateRows, fathomInboxHeaders, fathomNextStepSignal } from "../_shared/webhook_pure.ts";
import { verifyStandardWebhook } from "../_shared/ingest/webhook_signatures.ts";
import { parseFathomWebhook } from "../_shared/ingest/fathom_webhook.ts";
import type { FathomWebhookPayload } from "../_shared/ingest/fathom_webhook.ts";
import type { KnownAccount } from "../_shared/ingest/identity.ts";

const SERVICE = "pb-fathom-webhook";
const KNOWN_COLS = "id,key,name,domain,pipedrive_org_id,orbit_client_id";

async function markInbox(db: DbLike, inboxId: string, error: string | null): Promise<void> {
  await db.from("pb_webhook_inbox").update({ processed_at: new Date().toISOString(), error }).eq("id", inboxId);
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json({ ok: true, service: SERVICE });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let db: DbLike;
  try {
    db = serviceClient();
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }

  /* ---- 1. raw body ---- */
  const rawBody = await req.text();
  const parsed = safeJsonParse(rawBody);

  /* ---- 2. verify ---- */
  let verified = false;
  let reason = "";
  try {
    const secret = await getSecret(db, "PB_FATHOM_WEBHOOK_SECRET");
    if (secret === null) {
      reason = "secret not configured (PB_FATHOM_WEBHOOK_SECRET); stored unverified for replay";
    } else {
      const v = await verifyStandardWebhook(rawBody, req.headers, secret, Math.floor(Date.now() / 1000));
      verified = v.ok;
      reason = v.ok ? "" : v.reason;
    }
  } catch (e) {
    reason = `verification error: ${errorMessage(e)}`;
  }

  /* ---- 3. inbox, always ---- */
  let inboxId: string;
  try {
    const { data, error } = await db
      .from("pb_webhook_inbox")
      .insert({
        source: "fathom",
        headers: fathomInboxHeaders(req.headers),
        body: inboxBody(rawBody, parsed),
        verified,
        error: verified ? (parsed.ok ? null : `body is not JSON: ${parsed.error}`) : reason,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    inboxId = String(data.id);
  } catch (e) {
    // The one non-2xx: nothing was stored, so Fathom's retry is wanted.
    return json({ ok: false, error: `inbox insert failed: ${errorMessage(e)}` }, 500);
  }

  if (!verified) {
    console.log(`${SERVICE}: unverified delivery inboxed (${inboxId}): ${reason}`);
    return json({ ok: true, inbox_id: inboxId, verified: false, reason });
  }
  if (!parsed.ok) {
    await markInbox(db, inboxId, `body is not JSON: ${parsed.error}`);
    return json({ ok: true, inbox_id: inboxId, verified: true, processed: false, reason: "body is not JSON" });
  }

  /* ---- 4. parse → rows ---- */
  const counts: Rec = { calls: 0, candidates: 0, signals: 0, skipped: 0 };
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

      if (accountId !== null) {
        const rubric = await loadRubric(db, null);
        if (rubric === null) {
          notes.push("no active rubric; next_step_agreed signal not raised");
        } else {
          const signal = fathomNextStepSignal(result.call, accountId, parsed.value, rubric.spec);
          if (signal === null) {
            notes.push("no non-empty action_items on the delivery; no signal raised");
          } else {
            // Fathom may redeliver; one signal per recording.
            const { data: dup, error: dupErr } = await db
              .from("pb_signals")
              .select("id")
              .eq("source", "fathom")
              .eq("type", "next_step_agreed")
              .eq("payload->>recording_id", result.call.fathom_recording_id)
              .limit(1);
            if (dupErr) errors.push(`pb_signals dedupe: ${dupErr.message}`);
            else if (Array.isArray(dup) && dup.length > 0) notes.push("next_step_agreed already recorded for this recording; not duplicated");
            else {
              const { error: sigErr } = await db.from("pb_signals").insert(signal);
              if (sigErr) errors.push(`pb_signals insert: ${sigErr.message}`);
              else counts.signals = 1;
            }
          }
        }
      } else {
        notes.push("call not attached to an account (no high domain match); candidates written, no signal");
      }
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }

  /* ---- 5. bookkeeping ---- */
  try {
    await markInbox(db, inboxId, errors.length ? errors.join("; ") : null);
    if (runId !== null) {
      const written = Number(counts.calls) + Number(counts.candidates) + Number(counts.signals);
      await finishRun(db, runId, runStatus(written + Number(counts.skipped), errors.length), { ...counts, notes }, errors);
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }
  if (errors.length) console.error(`${SERVICE}: inbox ${inboxId}: ${errors.join("; ")}`);

  /* ---- 6. 200 always after inboxing ---- */
  return json({ ok: errors.length === 0, inbox_id: inboxId, run_id: runId, verified: true, processed: true, counts, errors, notes });
});
