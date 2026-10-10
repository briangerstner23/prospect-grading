/**
 * pb-notes — the one model call, shared by every channel.
 *
 *   callExtractor(apiKey, model, system, user) → { value, usage, stop_reason }
 *
 * Moved out of index.ts unchanged in behaviour (DECISIONS §65), so the nightly notes sweep and the
 * sales-meeting reader (meetings.ts) make exactly the same call and salvage the reply the same way:
 * a raw fetch to /v1/messages, max_tokens 16000, no temperature, the text blocks joined, the
 * outermost {…} parsed, and a reply cut off mid-array salvaged to its last complete entry.
 *
 * Three ways it can end, and the caller tells them apart:
 *
 *   ExtractorApiError    the API refused the call (status ≠ 2xx). Says nothing about the record;
 *                        notes_sweep.classifyExtractorFailure decides whether that halts the run.
 *   ExtractorReplyError  the reply arrived — and was billed — but held no usable JSON. Its message
 *                        is the one index.ts has always thrown; it also carries the usage, so a
 *                        meeting read can count what an unusable reply cost.
 *   a value              whatever came back; the verifiers decide what it is worth.
 *
 * Pure apart from fetch: parseReplyJson, replyText and usageOf take no clock, no network and no
 * filesystem, and meetings_pure_test.ts runs them under Node.
 */

import { isRec, safeJsonParse } from "../_shared/helpers.ts";
import type { Rec } from "../_shared/helpers.ts";

/**
 * The API refused the call (no credit, bad key, rate limit, overload, server error). Unlike an
 * unusable reply, this says nothing about the record — so the record must not be marked read.
 */
export class ExtractorApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`extractor returned ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

/** Tokens one call spent, as the API reported them. Zero when it reported none. */
export interface ExtractorUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Why a reply that arrived could not be used. */
export type ReplyFailure = "no_json" | "not_json";

/**
 * The reply arrived but held no usable JSON. The message is the text index.ts has always thrown
 * (it quotes the start of the reply, so it is for an operator, never for a stored note); `reason`,
 * `stop_reason` and `text_chars` say the same thing without quoting anything.
 */
export class ExtractorReplyError extends Error {
  reason: ReplyFailure;
  stop_reason: string | null;
  text_chars: number;
  usage: ExtractorUsage;
  constructor(message: string, reason: ReplyFailure, stop_reason: string | null, text_chars: number, usage: ExtractorUsage) {
    super(message);
    this.reason = reason;
    this.stop_reason = stop_reason;
    this.text_chars = text_chars;
    this.usage = usage;
  }
}

export interface ExtractorResult {
  value: unknown;
  usage: ExtractorUsage;
  stop_reason: string | null;
}

/** The text of a Messages API reply: every text block, joined. Thinking blocks are not text. */
export function replyText(body: unknown): string {
  const content = isRec(body) ? (body as Rec).content : null;
  return Array.isArray(content)
    ? content.map((b: Rec) => (b?.type === "text" ? String(b.text ?? "") : "")).join("")
    : "";
}

/** The usage block of a Messages API reply, as two counts. */
export function usageOf(body: unknown): ExtractorUsage {
  const u = isRec(body) && isRec((body as Rec).usage) ? ((body as Rec).usage as Rec) : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens) };
}

export type ParsedReply =
  | { ok: true; value: unknown }
  | { ok: false; reason: ReplyFailure; message: string };

/**
 * The JSON salvage, exactly as index.ts did it: the outermost {…} of the text, parsed; failing
 * that, the array closed after its last complete entry; failing that, an error that says WHY.
 */
export function parseReplyJson(text: string, stop_reason: unknown): ParsedReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    // Say WHY there was no JSON. "No claims array" is indistinguishable from an honest empty
    // read, and that ambiguity cost a whole run to diagnose: stop_reason "max_tokens" means
    // the budget was spent, not that the record said nothing.
    return {
      ok: false,
      reason: "no_json",
      message: `no JSON in the reply (stop_reason ${String(stop_reason ?? "?")}, ` +
        `${text.length} chars of text): ${text.slice(0, 160)}`,
    };
  }
  const body_text = text.slice(start, end + 1);
  const parsed = safeJsonParse(body_text);
  if (parsed.ok) return { ok: true, value: parsed.value };

  /* A reply cut off mid-array is still worth its complete entries. Close the array after the
     last entry that finished and keep those; the guards downstream judge each one exactly as
     they would have. Salvaging beats discarding a record's whole reading over its last claim —
     but say so, because the claims past the cut are lost and that is recall, silently gone. */
  const lastWhole = body_text.lastIndexOf("},");
  if (lastWhole > 0) {
    const repaired = safeJsonParse(body_text.slice(0, lastWhole + 1) + "]}");
    if (repaired.ok) return { ok: true, value: repaired.value };
  }
  return { ok: false, reason: "not_json", message: `reply was not JSON (${parsed.error}): ${text.slice(0, 160)}` };
}

/**
 * One model call. Returns whatever came back, with what it cost; the caller's verifier decides
 * what it is worth.
 */
export async function callExtractor(apiKey: string, model: string, system: string, user: string): Promise<ExtractorResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // The current models think before they answer, and thinking is billed and counted inside
      // max_tokens. At 1500 the budget was spent before any text block arrived, so every
      // response parsed as "no claims array" — an empty answer that looked like an honest
      // "the note says nothing". Leave room for both.
      max_tokens: 16000,
      // No `temperature`: sampling parameters are removed on the current models and a request
      // carrying one is rejected with a 400. Determinism comes from the prompt and the
      // validator, not from a sampling knob.
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new ExtractorApiError(res.status, await res.text());
  const body = await res.json();
  const usage = usageOf(body);
  const stop = isRec(body) && typeof (body as Rec).stop_reason === "string" ? String((body as Rec).stop_reason) : null;
  const text = replyText(body);
  const parsed = parseReplyJson(text, isRec(body) ? (body as Rec).stop_reason : undefined);
  if (!parsed.ok) throw new ExtractorReplyError(parsed.message, parsed.reason, stop, text.length, usage);
  return { value: parsed.value, usage, stop_reason: stop };
}
