/**
 * pb-pipedrive-webhook — HTTP Basic check → pb_webhook_inbox → pb_deals / pb_accounts /
 * pb_contacts / pb_signals / pb_identity_candidates (DESIGN.md §4d).
 *
 *   GET   → {ok:true, service:'pb-pipedrive-webhook'}    reachability
 *   POST  → a Webhooks v2 delivery {meta, data, previous}
 *
 * Order of work:
 *   0. Body cap, 1 MB (MAX_WEBHOOK_BODY_BYTES). A Content-Length over the cap is answered 413
 *      before the body is read; without one the body is read up to the cap and cut off there —
 *      also 413. Nothing over the cap is stored.
 *   1. Raw body → JSON (or {raw}).
 *   2. verifyBasicAuth(Authorization, PB_PIPEDRIVE_WEBHOOK_BASIC) — the Vault value is
 *      `user:pass`. Unset secret → never verified.
 *   3. ALWAYS inbox {source 'pipedrive', headers (content-type, user-agent, has-authorization —
 *      never the credential), body, verified, error}. What `body` holds (webhook_pure.inboxRow):
 *        verified                 the parsed JSON (or {raw})
 *        secret not configured    the parsed JSON (or {raw}), kept whole for replay
 *        verification failed      a digest only — {stored:'digest', body_sha256, body_bytes,
 *                                 reason}. A caller without the credential does not fill the inbox.
 *   4. Status codes, and why:
 *        200  verified, or NO Authorization header at all, or secret unset — the payload (or its
 *             digest) is stored and Pipedrive is not told to retry / auto-disable the hook
 *        401  an Authorization header IS present and is WRONG — a misconfigured credential
 *             must surface in Pipedrive's webhook log so the operator sees it; a digest of the
 *             delivery is in the inbox
 *        413  over the body cap; nothing stored
 *        500  the inbox insert failed, or the secret could not be READ from Vault (a fault on
 *             our side; only a digest was kept, so Pipedrive's retry is wanted)
 *   5. If verified: field map from Vault (PB_PIPEDRIVE_FIELD_MAP, JSON written by the
 *      collector; empty map when absent — hash keys are never hard-coded), active rubric for
 *      signal weights, known accounts and the deal → account map; parsePipedriveEvent; then
 *        deal      upsert on pipedrive_deal_id, close_date_push appended to close_date_pushes
 *        account   attach (patch the existing row; PRO-6 certifies it) | create | review (nothing)
 *        contact   update by pipedrive_person_id or insert; skipped when no account resolves
 *        signal    insert (weights from the rubric; skipped when no active rubric)
 *        candidates insert
 *   6. Mark inbox processed_at, write pb_runs (kind webhook, source pipedrive), return 200.
 *
 * Deploy with verify_jwt = false: Pipedrive authenticates with HTTP Basic, not a Supabase JWT.
 * Cannot be exercised live until the Pipedrive token is fixed (PRO-6 blocker).
 */

import { serviceClient, insertBatches } from "../_shared/db.ts";
import { getSecret } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { loadRubric } from "../_shared/rubric.ts";
import { declaredContentLength, errorMessage, exceedsCap, json, MAX_WEBHOOK_BODY_BYTES, readBodyCapped, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  accountAttachPatch,
  accountCreateRow,
  accountIdForOrg,
  candidateRows,
  contactRow,
  dealAccountsMap,
  inboxRow,
  mergeDealUpsert,
  parseFieldMap,
  pipedriveInboxHeaders,
} from "../_shared/webhook_pure.ts";
import { verifyBasicAuth } from "../_shared/ingest/webhook_signatures.ts";
import { parsePipedriveEvent } from "../_shared/ingest/pipedrive_webhook.ts";
import type { PipedriveV2Event } from "../_shared/ingest/pipedrive_webhook.ts";
import type { KnownAccount } from "../_shared/ingest/identity.ts";

const SERVICE = "pb-pipedrive-webhook";
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

  /* ---- 1. body, read up to the cap ---- */
  const read = await readBodyCapped(req.body, MAX_WEBHOOK_BODY_BYTES);
  if (!read.ok) return tooLarge(read.bytes);
  const rawBody = read.text;
  const parsed = safeJsonParse(rawBody);

  /* ---- 2. verify ---- */
  const authHeader = req.headers.get("authorization");
  let verified = false;
  let reason: string | null = null;
  let secretConfigured: boolean | null = null;
  try {
    const secret = await getSecret(db, "PB_PIPEDRIVE_WEBHOOK_BASIC");
    if (secret === null) {
      secretConfigured = false;
      reason = "secret not configured (PB_PIPEDRIVE_WEBHOOK_BASIC); stored unverified for replay";
    } else {
      secretConfigured = true;
      verified = verifyBasicAuth(authHeader, secret);
      if (!verified) reason = authHeader ? "basic auth mismatch" : "missing Authorization header";
    }
  } catch (e) {
    secretConfigured = null;
    reason = `verification error: ${errorMessage(e)}`;
  }

  /* ---- 3. inbox, always — the whole body only when verified or when no secret is set ---- */
  const inbox = await inboxRow({
    source: "pipedrive",
    headers: pipedriveInboxHeaders(req.headers),
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
    return json({ ok: false, error: `inbox insert failed: ${errorMessage(e)}` }, 500);
  }

  /* ---- 4. status for the unverified cases ---- */
  if (!verified) {
    console.log(`${SERVICE}: unverified delivery inboxed (${inboxId}, ${inbox.storage}): ${reason}`);
    // The secret could not be read — our fault, and only a digest was kept: ask Pipedrive to retry.
    if (secretConfigured === null) return json({ ok: false, inbox_id: inboxId, verified: false, stored: inbox.storage, reason }, 500);
    const wrongCredential = secretConfigured === true && authHeader !== null && authHeader.length > 0;
    return json({ ok: !wrongCredential, inbox_id: inboxId, verified: false, stored: inbox.storage, reason }, wrongCredential ? 401 : 200);
  }
  if (!parsed.ok) {
    await markInbox(db, inboxId, `body is not JSON: ${parsed.error}`);
    return json({ ok: true, inbox_id: inboxId, verified: true, processed: false, reason: "body is not JSON" });
  }

  /* ---- 5. parse → rows ---- */
  const counts: Rec = { deals: 0, accounts: 0, contacts: 0, signals: 0, candidates: 0, ignored: 0 };
  const errors: string[] = [];
  const notes: string[] = [];
  let runId: string | null = null;
  try {
    runId = await startRun(db, "webhook", "pipedrive", SERVICE);

    const fieldMapText = await getSecret(db, "PB_PIPEDRIVE_FIELD_MAP");
    const fm = parseFieldMap(fieldMapText);
    if (fm.note) notes.push(fm.note);

    const rubric = await loadRubric(db, null);
    if (rubric === null) notes.push("no active rubric; any signal on this event is skipped");

    const { data: knownRows, error: knownErr } = await db.from("pb_accounts").select(KNOWN_COLS);
    if (knownErr) throw new Error(`pb_accounts: ${knownErr.message}`);
    const known = (knownRows ?? []) as KnownAccount[];

    const { data: dealRows, error: dealErr } = await db.from("pb_deals").select("pipedrive_deal_id,account_id").not("account_id", "is", null);
    if (dealErr) throw new Error(`pb_deals: ${dealErr.message}`);
    const dealAccounts = dealAccountsMap((dealRows ?? []) as Rec[]);

    const now = new Date().toISOString();
    const result = parsePipedriveEvent(parsed.value as PipedriveV2Event, fm.map, known, now, {
      deal_accounts: dealAccounts,
      rubric: rubric ? rubric.spec : undefined,
    });
    notes.push(...result.notes);

    if (result.ignored) {
      counts.ignored = 1;
      notes.push(`ignored: ${result.ignored}`);
    }

    /* account */
    if (result.account) {
      const acct = result.account;
      if (acct.mode === "attach" && acct.id) {
        const { data: existing, error: exErr } = await db.from("pb_accounts").select("id,name,domain").eq("id", acct.id).maybeSingle();
        if (exErr) errors.push(`pb_accounts select: ${exErr.message}`);
        else {
          const { error } = await db.from("pb_accounts").update(accountAttachPatch(acct, existing ?? null)).eq("id", acct.id);
          if (error) errors.push(`pb_accounts attach: ${error.message}`);
          else {
            counts.accounts = 1;
            notes.push(`account ${acct.id} attached to pipedrive_org_id ${acct.pipedrive_org_id} (roster certified, PRO-6)`);
          }
        }
      } else if (acct.mode === "create") {
        const { error } = await db.from("pb_accounts").insert(accountCreateRow(acct));
        if (error) errors.push(`pb_accounts create: ${error.message}`);
        else {
          counts.accounts = 1;
          notes.push(`account created from pipedrive_org_id ${acct.pipedrive_org_id} (roster_source pipedrive)`);
        }
      } else {
        notes.push(`organization ${acct.pipedrive_org_id} resembles an existing account; left for review (candidates written)`);
      }
    }

    /* deal */
    if (result.deal) {
      const { data: existing, error: exErr } = await db
        .from("pb_deals")
        .select("pipedrive_deal_id,close_date_pushes")
        .eq("pipedrive_deal_id", result.deal.pipedrive_deal_id)
        .maybeSingle();
      if (exErr) errors.push(`pb_deals select: ${exErr.message}`);
      else {
        const row = mergeDealUpsert(result.deal as unknown as Rec, existing ?? null);
        const { error } = await db.from("pb_deals").upsert(row, { onConflict: "pipedrive_deal_id" });
        if (error) errors.push(`pb_deals upsert: ${error.message}`);
        else counts.deals = 1;
      }
    }

    /* contact */
    if (result.contact) {
      const row = contactRow(result.contact, accountIdForOrg(known, result.contact.pipedrive_org_id));
      if (row === null) {
        notes.push(`person ${result.contact.pipedrive_person_id}: no account resolves for its organization; not stored`);
      } else {
        const { data: existing, error: exErr } = await db
          .from("pb_contacts")
          .select("id")
          .eq("pipedrive_person_id", result.contact.pipedrive_person_id)
          .limit(1);
        if (exErr) errors.push(`pb_contacts select: ${exErr.message}`);
        else if (Array.isArray(existing) && existing.length > 0) {
          const { error } = await db.from("pb_contacts").update(row).eq("id", existing[0].id);
          if (error) errors.push(`pb_contacts update: ${error.message}`);
          else counts.contacts = 1;
        } else {
          const { error } = await db.from("pb_contacts").insert(row);
          if (error) errors.push(`pb_contacts insert: ${error.message}`);
          else counts.contacts = 1;
        }
      }
    }

    /* signal */
    if (result.signal) {
      if (result.signal.weight === null || result.signal.weight === undefined) {
        notes.push(`signal ${result.signal.type} skipped: no active rubric to weight it`);
      } else {
        const { error } = await db.from("pb_signals").insert(result.signal);
        if (error) errors.push(`pb_signals insert: ${error.message}`);
        else counts.signals = 1;
      }
    }

    /* identity candidates */
    if (result.candidates.length) {
      const r = await insertBatches(db, "pb_identity_candidates", candidateRows(result.candidates));
      counts.candidates = r.wrote;
      errors.push(...r.errors);
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }

  /* ---- 6. bookkeeping ---- */
  try {
    await markInbox(db, inboxId, errors.length ? errors.join("; ") : null);
    if (runId !== null) {
      const written = (Object.values(counts) as unknown[]).reduce<number>((a, b) => a + Number(b), 0);
      await finishRun(db, runId, runStatus(written, errors.length), { ...counts, notes }, errors);
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }
  if (errors.length) console.error(`${SERVICE}: inbox ${inboxId}: ${errors.join("; ")}`);

  return json({ ok: errors.length === 0, inbox_id: inboxId, run_id: runId, verified: true, processed: true, counts, errors, notes });
});
