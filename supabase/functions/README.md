# Edge functions — the Prospect Book's write paths

Four Supabase Edge Functions (Deno) and their shared helpers. Every function is thin —
parse → verify → call a pure module → write rows — and every decision with a branch in it
lives in `_shared/*_pure.ts` / `_shared/rubric.ts` / `_shared/helpers.ts`, which run under
Node and are tested by `_shared/helpers_test.ts`. Deno is not installed in the build
container, so the handlers themselves are syntax-checked and type-checked, not executed, here.

```
supabase/functions/
  pb-sync/index.ts               bearer-token bulk ingest of packs (+ rubric version upsert)
  pb-score/index.ts              score every account → pb_reads; preview a draft rubric
  pb-notes/index.ts              nightly sweep of notes, calls and email → pb_facts / pb_fact_candidates
  pb-fathom-webhook/index.ts     Standard-Webhooks check → pb_webhook_inbox → pb_calls
  pb-pipedrive-webhook/index.ts  HTTP Basic check → pb_webhook_inbox → pb_deals / pb_accounts / pb_contacts
  _shared/
    db.ts            serviceClient() — the ONLY file importing jsr:@supabase/supabase-js@2; batched writers
    auth.ts          bearerOk(req, secret) constant-time; getSecret(db, name) via the pb_secret() RPC
    log.ts           startRun / finishRun → pb_runs
    rubric.ts        loadRubric(db, version|null); signal-catalog fill (weight, lifespan, decays, expires_at)
    helpers.ts       json(), bearer parsing, sha256Hex, chunk, safeJsonParse, header subsets, the 1 MB body cap
    sync_pure.ts     pb-sync's validation, column allow-lists, account_key → account_id, row preparation
    score_pure.ts    pb-score's grouping, pb_reads row, listing patch, preview diff, counts
    webhook_pure.ts  inbox header subsets, the inbox row (full body or digest), deal merge, field map
    helpers_test.ts  node --experimental-strip-types supabase/functions/_shared/helpers_test.ts
    core/            byte-identical COPIES of core/*.ts + the rubric JSON   (scripts/sync_shared.sh)
    ingest/          byte-identical COPIES of ingest/*.ts                  (scripts/sync_shared.sh)
```

**Never edit `_shared/core` or `_shared/ingest` by hand.** Edit the originals under `core/`
and `ingest/`, run `bash scripts/sync_shared.sh`, redeploy. `bash scripts/sync_shared.sh
--check` (and `helpers_test.ts`) fail when a copy drifts.

## Secrets (Supabase Vault, read through `public.pb_secret(name)`, service role only)

| Secret | Used by | Value |
|---|---|---|
| `PB_SYNC_TOKEN` | pb-sync, pb-score, the pg_cron nightly job | random bearer token |
| `PB_FATHOM_WEBHOOK_SECRET` | pb-fathom-webhook | the `whsec_…` Fathom returns when the webhook is created |
| `PB_PIPEDRIVE_WEBHOOK_BASIC` | pb-pipedrive-webhook | `user:pass` configured on the Pipedrive webhook |
| `PB_PIPEDRIVE_API_TOKEN` | pb-notes | Pipedrive API token; the sweep pulls `/v1/notes` with it |
| `PB_GMAIL_REFRESH_TOKEN` | pb-notes | Google OAuth refresh token for the mailbox to read. An access token lasts an hour, so the run exchanges this for one each time. **Not yet set** |
| `PB_GMAIL_CLIENT_ID` | pb-notes | the OAuth client the refresh token belongs to. **Not yet set** |
| `PB_GMAIL_CLIENT_SECRET` | pb-notes | its secret. **Not yet set** |
| `PB_ANTHROPIC_API_KEY` | pb-notes | reads a note into claims. **Not yet set** — until it is, pb-notes answers 503 and writes no run row, so the nightly job is silent rather than failing |
| `PB_PIPEDRIVE_FIELD_MAP` | pb-pipedrive-webhook | JSON `{deals:{<hash>:{label,options}}, organizations:{…}, persons:{…}}` written by the collector that reads `/v2/dealFields` and `/v1/organizationFields`; absent → custom fields pass through unlabelled |

`select vault.create_secret('<value>', '<NAME>', '<description>');` — see `docs/RUNBOOK.md` §1.
**No function ever defaults open**: pb-sync and pb-score answer `503 secret not configured;
refusing` while `PB_SYNC_TOKEN` is unset; the webhooks store every delivery unverified until
their secret is set.

## Deploy

All five are deployed with **`verify_jwt = false`**, and for each of them that is a
requirement, not a convenience:

- **pb-sync, pb-score and pb-notes must be deployed with `verify_jwt = false`.** They carry the Prospect
  Book's own bearer — `Authorization: Bearer <PB_SYNC_TOKEN>`, checked in constant time by
  `bearerOk` — not a Supabase JWT. The pg_cron job in `20260909120100_prospect_book_cron.sql`
  sends exactly that header every night — `pb-nightly-score` at 06:15 UTC and `pb-nightly-notes`
  at 05:45, half an hour earlier so a note read in the morning changes that morning's tier. With
  `verify_jwt = true` the gateway would reject the call before the function ran and no reads would
  ever be written. The token check *is* the
  authentication: there is no anonymous path (503 while the token is unset, 401 when it is wrong).
- **pb-fathom-webhook and pb-pipedrive-webhook** likewise: Fathom signs with Standard
  Webhooks and Pipedrive sends HTTP Basic — neither can present a Supabase JWT.


Through the Supabase MCP, one `deploy_edge_function` call per function with
`project_id = sgagrmapuovnjwvgsxbp`, `name`, `entrypoint_path = "index.ts"`,
`verify_jwt = false`, and `files` = the function's `index.ts` plus every `_shared` file it
imports, keeping the relative layout (`index.ts` at the function root, shared files under
`../_shared/…`). File lists, as repo paths:

**pb-sync**
```
supabase/functions/pb-sync/index.ts
supabase/functions/_shared/db.ts  auth.ts  log.ts  rubric.ts  helpers.ts  sync_pure.ts
supabase/functions/_shared/ingest/webhook_signatures.ts
supabase/functions/_shared/core/prospect_types.ts
```

**pb-score**
```
supabase/functions/pb-score/index.ts
supabase/functions/_shared/db.ts  auth.ts  log.ts  rubric.ts  helpers.ts  score_pure.ts
supabase/functions/_shared/ingest/webhook_signatures.ts  resolve_features.ts
supabase/functions/_shared/core/prospect_types.ts  engine.ts  classify.ts  decay.ts  reason.ts
```

**pb-fathom-webhook**
```
supabase/functions/pb-fathom-webhook/index.ts
supabase/functions/_shared/db.ts  auth.ts  log.ts  rubric.ts  helpers.ts  sync_pure.ts  webhook_pure.ts
supabase/functions/_shared/ingest/webhook_signatures.ts  fathom_webhook.ts  identity.ts  pipedrive_webhook.ts
supabase/functions/_shared/core/prospect_types.ts
```

**pb-pipedrive-webhook**
```
supabase/functions/pb-pipedrive-webhook/index.ts
supabase/functions/_shared/db.ts  auth.ts  log.ts  rubric.ts  helpers.ts  sync_pure.ts  webhook_pure.ts
supabase/functions/_shared/ingest/webhook_signatures.ts  pipedrive_webhook.ts  identity.ts  fathom_webhook.ts
supabase/functions/_shared/core/prospect_types.ts
```

(`webhook_pure.ts` imports types from both parsers and `dealRowForUpsert` from `sync_pure.ts`,
hence both parsers and `sync_pure.ts` ship with each webhook. Type-only imports are erased at
runtime, but shipping the file is harmless and keeps the deploy list mechanical.)

CLI equivalent, from the repo root:

```bash
supabase functions deploy pb-sync              --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-score             --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-fathom-webhook    --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-pipedrive-webhook --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
```

Below, `FN=https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1`.

---

## pb-sync — bulk ingest (DESIGN.md §4f)

`POST $FN/pb-sync` · `Authorization: Bearer $PB_SYNC_TOKEN` · body:

```json
{
  "run": { "kind": "seed", "source": "notion_master", "triggered_by": "session <id>" },
  "accounts": [ { "key": "harbor pine creative", "name": "Harbor & Pine Creative", "domain": "harborpine.example",
                  "roster_source": "notion_master", "roster_certified": false, "book": "prospect" } ],
  "contacts": [ { "account_key": "harbor pine creative", "name": "Ops Lead", "email": "ops@harborpine.example", "source": "notion_master" } ],
  "facts":    [ { "account_key": "harbor pine creative", "key": "headcount", "value": 24, "evidence_label": "inferred",
                  "source": "notion_master", "observed_at": "2026-09-01", "note": "Headcount" } ],
  "signals":  [ { "account_key": "harbor pine creative", "type": "quote_sent", "observed_at": "2026-09-01T00:00:00Z",
                  "source": "orbit", "payload": { "project_id": 1 } } ],
  "deals": [], "calls": [], "identity_candidates": [],
  "rubric": { "version": "0.1.0", "spec": { "...": "core/rubric.prospect.v0.1.json" }, "activate": true }
}
```

| Pack | Write | Key |
|---|---|---|
| `accounts` | upsert | `key` |
| `contacts` | insert | — |
| `facts` | insert (append-only) | — ; `entered_by` defaults to `system:<run.source>`, `stand_in` to false |
| `signals` | insert (append-only) | — ; `type` must be in `rubric.signals.catalog` else **400** `{bad_types}`; `weight` / `lifespan_days` / `decays` / `expires_at` filled from the catalog when absent |
| `deals` | upsert | `pipedrive_deal_id` ; a `close_date_push` is appended to `close_date_pushes` |
| `calls` | upsert | `fathom_recording_id` |
| `identity_candidates` | insert | — ; `status` defaults to `proposed` |
| `rubric` | upsert `pb_rubric_versions` | `version` ; `spec_sha256` = SHA-256 of `JSON.stringify(spec)`; `activate: true` retires every other active version |

Rows in `contacts` / `facts` / `signals` may name the account by `account_key`
(`pb_accounts.key`) instead of `account_id`; keys resolve after the accounts pack lands. Rows
that name no account, an unknown key, an unknown signal type or a bad evidence label are
refused and listed in `errors` — never guessed at. Non-column keys are dropped and noted.
Batches of 200. `run.kind` ∈ `ingest | score | decay | seed | webhook | enrich | export`
(default `ingest`); `run.source` is required.

Response: `{ok, run_id, status, wrote: {accounts, contacts, facts, signals, deals, calls,
identity_candidates, rubric}, errors, notes}` — 200 when `errors` is empty, 500 otherwise (the
counts are still returned; a `pb_runs` row records the run as success / partial / failed).

```bash
curl -sS -X POST "$FN/pb-sync" \
  -H "Authorization: Bearer $PB_SYNC_TOKEN" -H "Content-Type: application/json" \
  --data @pack.json

# load / activate the rubric
jq -n --slurpfile spec core/rubric.prospect.v0.1.json \
  '{run:{kind:"ingest",source:"operator",triggered_by:"<you>"}, rubric:{version:$spec[0].version, spec:$spec[0], activate:true}}' \
| curl -sS -X POST "$FN/pb-sync" -H "Authorization: Bearer $PB_SYNC_TOKEN" -H "Content-Type: application/json" --data @-
```

Statuses: `405` not POST · `503` `PB_SYNC_TOKEN` unset, or no active rubric when signals are
sent · `401` wrong bearer · `400` bad body / bad signal types · `500` a write failed.

## pb-score — score under the active rubric (DESIGN.md §4g)

`POST $FN/pb-score[?account=<uuid>][&rubric=<version>&preview=1]` · same bearer · optional body
`{ "triggered_by": "...", "as_of": "2026-09-09T06:15:00Z" }` (`as_of` defaults to now; the
engine never reads a clock).

Loads the active `pb_rubric_versions` row (or `?rubric=`), every `pb_accounts` row with `book
in (prospect, parked)` (or the one `?account=`), `pb_current_facts`, signals with `expires_at`
null or ≥ `as_of`, open non-CJ `pb_deals`, and `pb_register` rows of kind `override`. Per
account `resolveFeatures` → `grade`; a per-account failure lands in `errors` and the run
continues. Then:

- **default** — inserts `pb_reads` (`scorecard_sha256` = SHA-256 of `JSON.stringify(scorecard)`),
  updates `pb_accounts.status / effective_tier / cell`, writes `pb_runs` with counts
  `{scored, parked, unclassified, overridden, ranked, errors}`. Response `{ok, run_id, status,
  rubric_version, as_of, counts, errors, notes}`.
- **`preview=1`** — writes **nothing** (no reads, no run) and returns `{preview: true, rubric_version,
  rubric_status, counts, changed, diff: [{account_id, name, from_tier, to_tier, from_status,
  to_status, changed}], errors}` against `pb_current_reads`. A non-active (`draft` / `retired`)
  rubric can **only** be scored with `preview=1` (else 400): reads are the record and carry the
  active version only. Activate with pb-sync's `rubric.activate` once the diff is accepted.

```bash
curl -sS -X POST "$FN/pb-score" -H "Authorization: Bearer $PB_SYNC_TOKEN"                       # nightly run, by hand
curl -sS -X POST "$FN/pb-score?account=<uuid>" -H "Authorization: Bearer $PB_SYNC_TOKEN"        # one account
curl -sS -X POST "$FN/pb-score?rubric=0.2.0&preview=1" -H "Authorization: Bearer $PB_SYNC_TOKEN" # diff a draft
```

Statuses: `405` · `503` token unset / no active rubric · `401` · `400` bad `as_of`, non-active
rubric without preview · `404` named rubric missing · `500` a load or write failed.

## The webhooks: body cap, and what the inbox keeps

Both webhook functions are public endpoints; two rules keep an unauthenticated caller from
using them against us. Both live in pure code (`helpers.ts`, `webhook_pure.ts`) and are tested.

**Body cap — 1 MB (`MAX_WEBHOOK_BODY_BYTES = 1_048_576`).** A `Content-Length` over the cap is
answered **413** before the body is read. Without a usable `Content-Length` the body is read
through `readBodyCapped`, which stops — and cancels the stream — the moment the running total
passes the cap, and the delivery is answered **413** on the read length instead. Nothing over
the cap is stored or verified. (A Fathom delivery carrying a transcript is far under 1 MB.)

**What the inbox keeps (`inboxRow`).** `pb_webhook_inbox.body` holds the whole delivery only
when it is safe to keep:

| Outcome | `body` | `verified` | `error` |
|---|---|---|---|
| verified | the parsed JSON (or `{raw}` when not JSON) | true | null, or `body is not JSON: …` |
| secret **not configured** | the parsed JSON (or `{raw}`) — the **replay** case: set the secret, then process the stored body | false | `secret not configured (…)` |
| secret configured, verification **failed** (or the secret could not be read) | a **digest only**: `{stored: "digest", body_sha256, body_bytes, reason}` | false | the reason |

`headers` is always the small subset (`content-type`, `content-length`, `user-agent`, the
source's id headers, and a `has-signature` / `has-authorization` boolean — never the signature
or credential). The digest row proves a delivery happened and lets a redelivered body be
matched by hash, without letting anyone who lacks the secret fill the table with bodies.

## pb-fathom-webhook — "new meeting content ready" (DESIGN.md §4e)

`GET $FN/pb-fathom-webhook` → `{ok:true, service:"pb-fathom-webhook"}` (reachability).
`POST` → the delivery, headers `webhook-id`, `webhook-timestamp`, `webhook-signature`.

0. Body cap (above): `Content-Length` over 1 MB → **413** before reading; otherwise the body
   is read up to the cap and cut off there → **413**.
1. Raw body is read as text (re-serialising would break the MAC).
2. `verifyStandardWebhook` against `PB_FATHOM_WEBHOOK_SECRET` (HMAC-SHA256 over
   `${id}.${timestamp}.${body}`, 5-minute tolerance). The stored secret is trimmed once; a
   `whsec_` secret whose remainder is not base64 is refused with its own reason. Unset secret →
   not verified.
3. **Always** `insert pb_webhook_inbox {source: 'fathom', headers: {webhook-id,
   webhook-timestamp, content-type, content-length, user-agent, has-signature}, body, verified,
   error}` — `body` per the table above: whole when verified or when the secret is unset, a
   digest when verification failed. The signature value itself is never stored.
4. If verified: `parseFathomWebhook(body, known accounts)`. Internal-only calls are skipped and
   counted. External calls: upsert `pb_calls` on `fathom_recording_id`; insert
   `pb_identity_candidates`. **No signal is raised from an inbound call in Phase 1** — the
   `pb_calls` row is the record, and the seven-field extraction (a later step, confirmed by a
   person) is what may read it. The payload's `action_items` are noted by the parser and not
   stored.
5. `processed_at` on the inbox row; a `pb_runs` row (kind `webhook`, source `fathom`).
6. **200 always after inboxing.** Fathom retries on any non-2xx and would re-deliver the same
   payload, so an unverified delivery is answered `200 {verified:false, stored, reason}` and
   left in the inbox (whole, or as a digest). The non-2xx cases: **413** over the cap; **500**
   when the inbox insert failed (nothing was stored, so the retry is wanted); **500** when the
   secret could not be *read* from Vault (a fault on our side — only a digest was kept, so the
   retry is wanted too).

```bash
curl -sS "$FN/pb-fathom-webhook"                                      # reachability
# a signed test delivery (secret whsec_…, body in body.json):
ID=msg_test_1; TS=$(date +%s); BODY=$(cat body.json)
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:$(printf '%s' "${WHSEC#whsec_}" | base64 -d | xxd -p -c 256) -binary | base64)
curl -sS -X POST "$FN/pb-fathom-webhook" -H "Content-Type: application/json" \
  -H "webhook-id: $ID" -H "webhook-timestamp: $TS" -H "webhook-signature: v1,$SIG" --data "$BODY"
```

Check: `select received_at, verified, processed_at, error from pb_webhook_inbox where source='fathom' order by received_at desc limit 5;`

## pb-pipedrive-webhook — Webhooks v2 (DESIGN.md §4d)

`GET $FN/pb-pipedrive-webhook` → reachability. `POST` → `{meta, data, previous}` with HTTP
Basic auth.

0. Body cap (above): `Content-Length` over 1 MB → **413** before reading; otherwise the body
   is read up to the cap and cut off there → **413**.
1. Raw body → JSON (or `{raw}`).
2. `verifyBasicAuth(Authorization, PB_PIPEDRIVE_WEBHOOK_BASIC)` — constant time; the stored
   `user:pass` is trimmed once (the presented credential is not); unset secret → not verified.
3. **Always** inbox `{source: 'pipedrive', headers: {content-type, content-length, user-agent,
   x-pipedrive-webhook-id, has-authorization}, body, verified, error}` — `body` per the table
   above: whole when verified or when the secret is unset, a digest when verification failed.
   The credential is never stored.
4. Status codes:
   - **200** verified; or **no** `Authorization` header at all; or the secret is unset — the
     payload (or its digest) is stored and Pipedrive is not told to retry or to auto-disable the hook.
   - **401** an `Authorization` header **is present and wrong** — a misconfigured credential
     must surface in Pipedrive's webhook log so the operator sees it. A digest of the delivery
     is in the inbox.
   - **413** over the body cap; nothing stored.
   - **500** the inbox insert failed, or the secret could not be *read* from Vault (a fault on
     our side; only a digest was kept, so Pipedrive's retry is wanted).
5. If verified: field map from Vault (`PB_PIPEDRIVE_FIELD_MAP`, empty map when absent — hash
   keys are never hard-coded), the active rubric (signal weights), known accounts, and the
   deal → account map; `parsePipedriveEvent`; then
   - **deal** — upsert `pb_deals` on `pipedrive_deal_id`; a `close_date_push` is appended to the
     existing `close_date_pushes`; a null `stage_entered_at` is not written (means "unchanged");
     `CJ…` titles carry `is_cj = true`.
   - **account** — `attach`: patch the existing row with `pipedrive_org_id`, `roster_source =
     pipedrive`, `roster_certified = true` (PRO-6), fill `name`/`domain` only where empty, never
     touch `key`. `create`: insert. `review`: nothing (the candidates say why).
   - **contact** — update by `pipedrive_person_id` or insert; skipped with a note when no
     account resolves (pb_contacts.account_id is NOT NULL).
   - **signal** — insert (`meeting_accepted` from an activity, `manual_note` from a note); skipped
     with a note when there is no active rubric to weight it.
   - **identity_candidates** — insert.
6. `processed_at`; a `pb_runs` row (kind `webhook`, source `pipedrive`); 200.

```bash
curl -sS "$FN/pb-pipedrive-webhook"                                   # reachability
curl -sS -X POST "$FN/pb-pipedrive-webhook" -u "$PD_USER:$PD_PASS" -H "Content-Type: application/json" \
  --data '{"meta":{"action":"change","entity":"deal","entity_id":"77","version":"2.0","timestamp":"2026-09-09T12:00:00Z"},
           "data":{"id":77,"title":"Site rebuild","org_id":900,"status":"open","expected_close_date":"2026-11-01"},
           "previous":{"expected_close_date":"2026-10-01"}}'
```

**Cannot be exercised live until the Pipedrive token is fixed (PRO-6 blocker).**

---

## Tests

```bash
node --experimental-strip-types supabase/functions/_shared/helpers_test.ts   # every pure helper, the cap, the inbox row
bash scripts/sync_shared.sh --check                                          # copies match originals
```

`helpers_test.ts` also asserts that no pure helper reads a clock or imports `jsr:`/`npm:`, that
every `_shared/core` and `_shared/ingest` copy is byte-identical to its original, that
`webhook_pure.ts` and `pb-fathom-webhook` derive no signal from a delivery, and that both
webhook handlers go through the cap and `inboxRow`.
