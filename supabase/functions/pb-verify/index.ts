/**
 * pb-verify — asking, one claim at a time, whether the sentence actually says it.
 *
 *   POST /functions/v1/pb-verify
 *   Authorization: Bearer <PB_SYNC_TOKEN>        (Vault, read through pb_secret())
 *   { limit?: number, source?: string, dry_run?: boolean, model?: string }
 *
 * DECISIONS §54. §53 found that four of ten claims the website reader had rated `high` were
 * inferences wearing a verbatim quote, and gated that reader out of the automatic lanes wholesale
 * — the only move available, because nobody had checked the claims one by one. This is the check.
 *
 * It re-reads what the book already has. It NEVER reads a source record, never pulls a new note,
 * never extracts a claim and never writes a fact. It takes the quote that is already stored beside
 * a candidate, puts it next to the key and value that quote was offered for, and asks whether the
 * sentence states that. The answer lands in pb_fact_candidates.support and nothing else moves.
 *
 * That narrowness is the safety story, and it is a much easier one to tell than the sweep's. The
 * sweep can add work for a person; this cannot even do that. The worst a wrong verdict does is
 * hold a true claim back for someone to read, or let a claim through to a lane it was already in
 * before anybody asked. There is no path from here to a fact that was not already one gate away.
 *
 * WHAT IT CANNOT DO, enforced rather than intended:
 *   · it selects only `support is null` rows, so it never revises a verdict already given;
 *   · it writes exactly five columns, none of which any lane reads as a licence on its own;
 *   · an unreadable reply leaves the row untouched, to be asked again — never marked unsupported;
 *   · the lexicon in verify_support.ts may overrule the reader DOWNWARD only.
 *
 * Costs one model call per batch of at most 25 claims, so the whole queue is tens of calls rather
 * than a thousand. A re-run costs nothing for anything already audited.
 *
 * Deploy with verify_jwt = false: the bearer is our own token.
 */

import { serviceClient } from "../_shared/db.ts";
import { bearerOk, getSecret, SECRET_NOT_CONFIGURED } from "../_shared/auth.ts";
import { finishRun, runStatus, startRun } from "../_shared/log.ts";
import { errorMessage, isRec, json, safeJsonParse } from "../_shared/helpers.ts";
import type { DbLike, Rec } from "../_shared/helpers.ts";
import {
  auditorId,
  batchClaims,
  supportPayload,
  supportPrompt,
  verifySupport,
} from "../_shared/ingest/verify_support.ts";
import type { SupportClaim } from "../_shared/ingest/verify_support.ts";

/** Same default as the sweep, and overridable the same way, so both readers move together. */
const DEFAULT_MODEL = "claude-sonnet-5";

/** One batch, one model call. Returns whatever came back; verifySupport decides what it is worth. */
async function auditBatch(apiKey: string, model: string, claims: readonly SupportClaim[]): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // Same reasoning as pb-notes: thinking is billed inside max_tokens, and a budget spent
      // before the first text block arrives looks exactly like an honest empty answer.
      max_tokens: 16000,
      // No `temperature` — the current models reject it, and determinism here comes from the
      // prompt, the three-word enum and the lexicon, not from a sampling knob.
      system: supportPrompt(),
      messages: [{ role: "user", content: `<claims>\n${supportPayload(claims)}\n</claims>` }],
    }),
  });
  if (!res.ok) throw new Error(`auditor returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = Array.isArray(body?.content)
    ? body.content.map((b: Rec) => (b?.type === "text" ? String(b.text ?? "") : "")).join("")
    : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(
      `no JSON in the reply (stop_reason ${String(body?.stop_reason ?? "?")}, ` +
      `${text.length} chars of text): ${text.slice(0, 160)}`,
    );
  }
  const slice = text.slice(start, end + 1);
  const parsed = safeJsonParse(slice);
  if (parsed.ok) return parsed.value;

  // A reply cut off mid-array is still worth its complete entries; the rest are asked again next
  // run, because an unaudited row is the harmless state.
  const lastWhole = slice.lastIndexOf("},");
  if (lastWhole > 0) {
    const repaired = safeJsonParse(slice.slice(0, lastWhole + 1) + "]}");
    if (repaired.ok) return repaired.value;
  }
  throw new Error(`reply was not JSON (${parsed.error}): ${text.slice(0, 160)}`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const db: DbLike = serviceClient();
  const syncToken = await getSecret(db, "PB_SYNC_TOKEN");
  if (syncToken === null) return json({ ok: false, error: SECRET_NOT_CONFIGURED }, 503);
  if (!bearerOk(req, syncToken)) return json({ ok: false, error: "unauthorized" }, 401);

  const raw = await req.text();
  const parsedBody = raw ? safeJsonParse(raw) : { ok: true as const, value: {} };
  const body: Rec = parsedBody.ok && isRec(parsedBody.value) ? parsedBody.value as Rec : {};

  const dryRun = body.dry_run === true;
  const limit = Math.max(1, Math.min(2000, Number(body.limit) || 200));
  const source = typeof body.source === "string" && body.source ? body.source : null;

  const apiKey = await getSecret(db, "PB_ANTHROPIC_API_KEY");
  if (apiKey === null) return json({ ok: false, error: "PB_ANTHROPIC_API_KEY is not configured" }, 503);
  const model = (typeof body.model === "string" && body.model) ||
    (await getSecret(db, "PB_EXTRACTOR_MODEL")) || DEFAULT_MODEL;
  const auditor = auditorId(model);

  const runId = await startRun(db, "ingest", "verify_support", dryRun ? "pb-verify (dry run)" : "pb-verify");
  const notes: string[] = [];
  const counters: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counters[k] = (counters[k] ?? 0) + n; };

  try {
    // Only unaudited, still-open claims with a sentence to judge. A verdict is never revised here:
    // changing one's mind about a claim is a decision, and this function does not make decisions.
    let q = db.from("pb_fact_candidates")
      .select("id,key,value,quote,source")
      .eq("status", "proposed")
      .is("support", null)
      .not("quote", "is", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (source) q = q.eq("source", source);

    const { data, error } = await q;
    if (error) throw new Error(`could not read the queue: ${error.message}`);

    const claims: SupportClaim[] = (data ?? [])
      .filter((r: Rec) => typeof r.quote === "string" && String(r.quote).trim() !== "")
      .map((r: Rec) => ({
        id: String(r.id),
        key: String(r.key),
        value: r.value,
        quote: String(r.quote),
      }));

    bump("claims_selected", claims.length);
    if (claims.length === 0) {
      notes.push("Nothing to audit: every open claim with a sentence already has a verdict.");
      await finishRun(db, runId, "success", counters, notes);
      return json({ ok: true, dry_run: dryRun, audited: 0, counters, notes });
    }

    const batches = batchClaims(claims);
    bump("batches", batches.length);
    notes.push(`${claims.length} claim(s) in ${batches.length} batch(es), audited by ${auditor}.`);

    if (dryRun) {
      notes.push("Dry run: no model was called and nothing was written.");
      await finishRun(db, runId, "success", counters, notes);
      return json({ ok: true, dry_run: true, would_audit: claims.length, batches: batches.length, counters, notes });
    }

    let written = 0;
    let errors = 0;
    const byVerdict: Record<string, number> = {};

    for (const batch of batches) {
      let reply: unknown;
      try {
        reply = await auditBatch(apiKey, model, batch);
      } catch (e) {
        // A failed batch leaves every row in it untouched and therefore re-askable. That is the
        // whole reason nothing here defaults to a verdict.
        errors++;
        bump("batch_failed");
        notes.push(`A batch of ${batch.length} failed and was left unaudited: ${errorMessage(e)}`);
        continue;
      }

      const result = verifySupport(batch, reply);
      for (const [k, v] of Object.entries(result.counters)) bump(k, v);
      for (const n of result.notes.slice(0, 5)) notes.push(n);

      const checkedAt = new Date().toISOString();
      for (const v of result.verdicts) {
        const { error: upErr } = await db.from("pb_fact_candidates")
          .update({
            support: v.support,
            support_reason: v.reason,
            support_basis: v.basis,
            support_checked_at: checkedAt,
            support_auditor: auditor,
          })
          .eq("id", v.id)
          .eq("status", "proposed")
          .is("support", null);
        if (upErr) {
          errors++;
          bump("write_failed");
          notes.push(`Could not record a verdict: ${upErr.message}`);
          continue;
        }
        written++;
        byVerdict[v.support] = (byVerdict[v.support] ?? 0) + 1;
      }
      if (result.unresolved.length) {
        bump("left_unaudited", result.unresolved.length);
      }
    }

    notes.push(
      `Wrote ${written} verdict(s): ` +
      Object.entries(byVerdict).map(([k, n]) => `${n} ${k}`).join(", ") + ".",
    );

    await finishRun(db, runId, runStatus(written, errors), { ...counters, written, errors }, notes);
    return json({ ok: true, dry_run: false, audited: written, by_verdict: byVerdict, errors, counters, notes });
  } catch (e) {
    const msg = errorMessage(e);
    notes.push(msg);
    await finishRun(db, runId, "failed", counters, notes);
    return json({ ok: false, error: msg, counters, notes }, 500);
  }
});
