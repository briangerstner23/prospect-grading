/**
 * WLIQ Prospect Book — authentication for the edge functions.
 *
 * Two mechanisms, both fed from Supabase Vault through the `pb_secret(name)` RPC (service
 * role only; see the schema migration):
 *
 *   bearerOk(req, secret)   pb-sync and pb-score: `Authorization: Bearer <PB_SYNC_TOKEN>`,
 *                           compared in constant time. An unset secret refuses everything —
 *                           the caller answers 503 "secret not configured; refusing", never
 *                           defaults open.
 *   getSecret(db, name)     the Vault value, or null when it is not set. Never throws on a
 *                           missing secret; throws on an RPC failure so a broken database is
 *                           distinguishable from an unset key.
 *
 * The webhook functions use verifyStandardWebhook / verifyBasicAuth from
 * ./ingest/webhook_signatures.ts with secrets read through getSecret().
 */

import type { DbLike } from "./helpers.ts";
import { bearerMatches } from "./helpers.ts";

export const SECRET_NOT_CONFIGURED = "secret not configured; refusing";

/** True only when the request carries `Authorization: Bearer <secret>` and the secret is set. */
export function bearerOk(req: { headers: { get(name: string): string | null } }, secret: string | null | undefined): boolean {
  let header: string | null = null;
  try {
    header = req.headers.get("authorization");
  } catch {
    header = null;
  }
  return bearerMatches(header, secret);
}

/** Vault lookup through `public.pb_secret(secret_name)`. null = unset or empty. */
export async function getSecret(db: DbLike, name: string): Promise<string | null> {
  const { data, error } = await db.rpc("pb_secret", { secret_name: name });
  if (error) throw new Error(`pb_secret(${name}): ${error.message}`);
  if (data === null || data === undefined) return null;
  const s = String(data);
  return s.length === 0 ? null : s;
}
