# Runbook — operating the Prospect Book

Operator steps, in the order a fresh deployment needs them, with the state of project
`sgagrmapuovnjwvgsxbp` as of the evening of 9 September 2026 noted where a step is already
done. Everything here runs through the Supabase MCP from a session (`execute_sql`,
`apply_migration`, `deploy_edge_function`) or the equivalent CLI command. Placeholders are in
angle brackets. **Never paste a real secret into a file in this repository.**

Conventions: `<PROJECT_URL>` = `https://sgagrmapuovnjwvgsxbp.supabase.co`;
`<FN>` = `<PROJECT_URL>/functions/v1`.

---

## 1 · Set the Vault secrets

The edge functions and the cron read secrets through `pb_secret()` (service role only).
The MCP has no secrets-set tool, so the secrets go into Supabase Vault by SQL. Run each once
(`execute_sql` or the SQL editor). Generate tokens with something like `openssl rand -hex 32`
— or in-database, `encode(gen_random_bytes(32), 'hex')`, so the value never leaves Postgres.

| Secret | State on 9 Sep | Used by |
|---|---|---|
| `PB_SYNC_TOKEN` | **set** (generated in-database) | pb-sync, pb-score, the pg_cron nightly job |
| `PB_FATHOM_WEBHOOK_SECRET` | after the webhook is created (§4) | pb-fathom-webhook |
| `PB_PIPEDRIVE_WEBHOOK_BASIC` | generate before the webhook is created (§5) | pb-pipedrive-webhook |
| `PB_PIPEDRIVE_FIELD_MAP` | optional; cannot be collected yet (§5) | pb-pipedrive-webhook |
| `PB_PIPEDRIVE_API_TOKEN` | **pending — Brian.** The Pipedrive MCP is an OAuth grant the app cannot reuse; a token is needed only for the field-map collector and, later, write-back. Not needed for the seed or the webhook. | collector (later phase) |

```sql
-- Bearer token accepted by pb-sync and pb-score (and used by the pg_cron nightly job). DONE 9 Sep.
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'PB_SYNC_TOKEN', 'Prospect Book sync/score bearer');

-- Fathom Standard-Webhooks signing secret (the whsec_… value Fathom returns when the webhook is created; see §4).
select vault.create_secret('<whsec_…>', 'PB_FATHOM_WEBHOOK_SECRET', 'Fathom webhook signing secret');

-- HTTP Basic credential the Pipedrive webhook must present, as user:pass (see §5).
select vault.create_secret('<user>:<pass>', 'PB_PIPEDRIVE_WEBHOOK_BASIC', 'Pipedrive webhook HTTP Basic user:pass');

-- Optional: the custom-field map the webhook parser labels fields with (JSON; see §5).
select vault.create_secret('<{"deals":{…},"organizations":{…},"persons":{…}}>', 'PB_PIPEDRIVE_FIELD_MAP', 'Pipedrive custom-field map');

-- Pipedrive API token for the field-map collector and later write-back. Pending Brian.
select vault.create_secret('<pipedrive api token>', 'PB_PIPEDRIVE_API_TOKEN', 'Pipedrive API token');
```

To rotate a secret, update rather than re-create:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'PB_SYNC_TOKEN'),
  '<new value>', 'PB_SYNC_TOKEN', 'Prospect Book sync/score bearer');
```

Verify a secret exists without printing it:

```sql
select name, created_at from vault.secrets where name like 'PB_%' order by name;
```

`pb-sync` and `pb-score` refuse every request while `PB_SYNC_TOKEN` is unset. The webhooks
store every delivery unverified while their secret is unset; nothing is discarded.

## 2 · Apply the migrations

**All six are applied to `sgagrmapuovnjwvgsxbp` (9–10 Sep).** They are idempotent, so
re-applying is safe. For a fresh project: in order, one `apply_migration` call per file
(name = the filename stem, query = the file content), or
`supabase db push --project-ref sgagrmapuovnjwvgsxbp`. Applied migrations are history and
are never edited; a correction is a new file that supersedes.

1. `20260909120000_prospect_book_schema.sql` — the `pb_*` tables, default-deny RLS, the two views, `pb_me()` / `pb_is_wliq()` / `pb_role()`, `pb_secret()`.
2. `20260909120100_prospect_book_cron.sql` — `pg_cron` + `pg_net`, the nightly `pb-nightly-score` job at 06:15 UTC (bearer read from Vault at fire time).
3. `20260909120200_prospect_book_merge.sql` — `book = 'merged'` and `merged_into` on `pb_accounts`; the first `pb_merge_accounts`.
4. `20260909120300_prospect_book_fixes.sql` — `pb_role()` becomes `SECURITY DEFINER` (the INVOKER version recursed through its own `pb_members` policy); the identity-review guard freezes `id` and every key column and tests `current_user`; a `BEFORE INSERT` trigger takes hand-signal weight / lifespan / decay from the active rubric's catalog; the views deny `anon` on their own; `pb_merge_accounts` re-issued as `(p_source, p_target, p_note)`.
5. `20260909120400_prospect_book_candidate_review.sql` — `pb_review_candidate(p_candidate, p_decision, p_note)`, which carries a merge-queue decision through (§12).
6. `20260910141528_prospect_book_touch_search_path.sql` — pins `pb_touch_updated_at()`'s `search_path`, clearing the last security-advisor warning of ours. The remaining advisor notes on `pb_*` are all intended: `pb_webhook_inbox` has RLS with no policy (service-role only, default deny), and `pb_role` / `pb_merge_accounts` / `pb_review_candidate` are `SECURITY DEFINER` and callable by signed-in users because each re-checks the caller's lane and raises when it is not owner or rater.

Check afterwards:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename like 'pb\_%' order by 1;
select jobname, schedule, active from cron.job where jobname = 'pb-nightly-score';
select proname, prosecdef from pg_proc where proname in ('pb_role','pb_merge_accounts','pb_review_candidate');  -- prosecdef = true for all three
```

**The rubric row is loaded and active (`0.1.0`, 9 Sep).** For a fresh project, load it either
through pb-sync's `rubric` pack (`supabase/functions/README.md`) or by SQL:

```sql
insert into pb_rubric_versions (version, status, spec, spec_sha256, activated_by, activated_at)
values ('0.1.0', 'active', '<contents of core/rubric.prospect.v0.1.json>'::jsonb,
        '<sha256 of the file>', '<owner email>', now())
on conflict (version) do update set spec = excluded.spec, spec_sha256 = excluded.spec_sha256;
```

(`sha256sum core/rubric.prospect.v0.1.json` gives the hash.) Check: `select version, status
from pb_rubric_versions;` — exactly one `active`.

## 3 · Deploy the edge functions

One `deploy_edge_function` call per function with `project_id = sgagrmapuovnjwvgsxbp`,
`name`, `entrypoint_path = index.ts`, **`verify_jwt = false`**, and `files` = the function's
`index.ts` plus every file under `supabase/functions/_shared/` it imports (Supabase deploys a
function's own files only; the per-function file lists are in
`supabase/functions/README.md`). Run `bash scripts/sync_shared.sh` first so the `_shared/`
copies of `core/` and `ingest/` match their originals (`npm test` fails on drift).

**All five are deployed with `verify_jwt = false`.** None of the callers presents a Supabase
JWT: pb-sync and pb-score carry the Prospect Book's own bearer (`PB_SYNC_TOKEN`, checked in
constant time inside the function) — and that is exactly the header the pg_cron job sends —
so with `verify_jwt = true` the gateway would reject the nightly run before the function ran.

| Function | verify_jwt | Who calls it, and with what |
|---|---|---|
| `pb-sync` | **false** | a session, with `Authorization: Bearer <PB_SYNC_TOKEN>` |
| `pb-score` | **false** | a session or pg_cron, with the same bearer |
| `pb-fathom-webhook` | **false** | Fathom, signed with Standard Webhooks |
| `pb-pipedrive-webhook` | **false** | Pipedrive, with HTTP Basic |

```bash
supabase functions deploy pb-sync              --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-score             --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-fathom-webhook    --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-pipedrive-webhook --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
```

**Deploying from a session instead of the CLI.** The MCP takes every file inline in one call, and
each function's TypeScript closure is too large for that, so `bash scripts/build_functions.sh`
bundles each into one ES module under `dist/functions/<fn>/index.js`; deploy that with
`entrypoint_path = index.js`. Two things to watch, both learned the hard way:

- The payload is JSON, so **every backslash in the bundle must be escaped in it**. A bundle's
  `\uXXXX` — the combining-mark class in `norm()`, for one — sent with a single backslash arrives
  decoded to the character it names. The function still behaves identically, but its deployed
  bytes no longer match the bundle, so the sha256 you recorded stops identifying what is running.
- Emitting ~24–66 KB verbatim is the failure-prone step. Verify the deploy, don't assume it.
- **A trailing newline is easy to drop and worth keeping.** esbuild ends each bundle with `\n`;
  omit it from the payload and the function is byte-identical apart from that one character, so it
  behaves the same and boots the same — but its sha256 is not the bundle's, which is the one thing
  the recorded hash exists to prove. pb-score v6 (14 Sep) was deployed this way; its deployed bytes
  hash to `8d968901…`, the bundle to `5d922866…`.
- **A bundle over ~30 KB will not come back from one shell read** — the harness saves it to a file
  and shows you a 2 KB preview, which is not something you can paste. Read it in two halves
  (`head -c N` then `tail -c +N+1`) and splice them. pb-pipedrive-webhook (38,522 bytes) needs this;
  pb-sync (21,280) does not. Splicing by hand is the riskiest thing in this section, so treat the
  boot check below as mandatory rather than optional after one.

**Catching up a stale function (14 Sep 2026).** pb-sync and pb-pipedrive-webhook had been left on
v1 since 12–13 Sep, both missing the `helpers.ts` / `db.ts` paging fixes. Both were rebuilt from
`53fb656` — the bundles reproduced the recorded hashes exactly, `b189f501…` and `b8b4c1d6…`, which
is the cheapest proof that the tree still builds what the last session said it built — and deployed
as **v2**. Both were then boot-checked through `pg_net` (below): pb-sync answers
`405 {"error":"POST only"}`, pb-pipedrive-webhook `200 {"ok":true,"service":"pb-pipedrive-webhook"}`.
That proves each deployed source parsed, booted and routed. It does **not** prove byte-identity with
the bundle, and for a hand-spliced payload nothing short of reading the deployed source back does —
so no sha256 is recorded for these two.

**Which functions are actually stale.** Comparing commit dates against the deploy date over
`supabase/functions/<fn>` and all of `_shared/` over-reports: each function imports only part of
`_shared/`, so a change to a file it never imports is not drift. Ask esbuild what the function
really imports, then ask git what changed in exactly those files since it was deployed:

```bash
npx esbuild@0.24.2 supabase/functions/<fn>/index.ts --bundle --format=esm --platform=neutral \
  --target=esnext --external:'jsr:*' --external:'npm:*' --external:'https://*' --external:'node:*' \
  --metafile=/tmp/meta.json --outfile=/dev/null
git log --oneline --since=<deploy timestamp, from list_edge_functions updated_at> -- \
  $(python3 -c "import json;print(' '.join(json.load(open('/tmp/meta.json'))['inputs']))")
```

`updated_at` on `list_edge_functions` is epoch **milliseconds**. Pass the timestamp to `--since` as
a whole quoted string: splitting `fn:2026-09-13T14:09:52Z` on the last `:` in shell leaves `--since
52`, which git accepts as an approxidate and silently answers the wrong question.

Redeploy any function whose `_shared/` copy of a `core/` or `ingest/` module changed.

**Check a deploy landed.** `curl -sS <FN>/pb-fathom-webhook` and `curl -sS <FN>/pb-pipedrive-webhook`
answer `{"ok":true,"service":…}` on GET — which proves the deployed source parsed and booted, not
merely that it was accepted. From a session with no route to `*.supabase.co`, ask Postgres to make
the request instead:

```sql
select net.http_get(url := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-fathom-webhook');
-- then, a moment later, with the id it returned:
select status_code, content from net._http_response where id = <id>;
```

## 4 · Register the Fathom webhook

**Done, 12 Sep 2026** — the webhook exists (created in the Fathom UI) and
`PB_FATHOM_WEBHOOK_SECRET` is set: a `whsec_` whose 32 base64 characters decode to a 24-byte
key, checked with `decode(substring(d from 7),'base64')` rather than assumed.

Three things were learned getting there, because the obvious routes all fail differently:

- **The Fathom MCP's `create_webhook` is still broken.** Re-tested 12 Sep: it returns
  `Fathom API error 400: {"error":"Url can't be blank"}` whether the URL is passed as the
  schema's `destination_url` or as an explicit `url` beside it. It drops the field before
  Fathom's API sees it. The error says *blank*, not *invalid*, so reformatting the URL cannot
  help.
- **The REST API does work, and from `pg_net` rather than from a session.** This container has
  no egress to `developers.fathom.ai` or to `*.supabase.co`, but Postgres does:
  `POST https://api.fathom.ai/external/v1/webhooks` with an `X-Api-Key` header, sent by
  `net.http_post` reading the key out of Vault, so the key never enters a transcript or a file.
  An unauthenticated POST to that path answers 401, which is the cheap way to prove the host
  is reachable and the path right before spending anything.
- **There is no list endpoint.** `GET` on that same path answers a routing `404`, so webhooks
  cannot be enumerated — there is no way to confirm from SQL how many exist or where they
  point. That has to be eyeballed in the Fathom UI, and it is the one step a session cannot do.

A `whsec_…` is the *signing secret*, not an API key: it will 401 against the API. If
`vault.create_secret` errors on a re-run it is refusing a name that already exists — use
`vault.update_secret` (§1), which also renames.

Parameters, wherever it is created:

- `url`: `<FN>/pb-fathom-webhook`
- `include_transcript: true`, `include_summary: true`, `include_action_items: true`,
  `include_crm_matches: true` — all four
- `triggered_for`: `["my_recordings", "shared_team_recordings"]`

The response carries the signing secret (`whsec_…`). Put it into Vault as
`PB_FATHOM_WEBHOOK_SECRET` (§1) **before** the first call lands, or every delivery is stored
in `pb_webhook_inbox` with `verified = false` and never becomes a call. Never paste that value
into a file in this repository — it goes straight into `vault.create_secret(...)`. Deliveries arriving
before the secret is set are kept in full and are replayable; once the secret is set, a
delivery that fails verification is kept as a hash only. Bodies over 1 MB are refused. In
Phase 1 a call becomes a
`pb_calls` row and, where its external domain is unknown, a merge-queue row — **never a
signal** (not from attendance, not from action items).

Check a delivery arrived and verified:

```sql
select received_at, verified, processed_at, error
from pb_webhook_inbox where source = 'fathom' order by received_at desc limit 5;
```

## 5 · Register the Pipedrive webhook

**Done, 14 Sep 2026.** Four webhooks exist — `Prospect Book - deal` / `- organization` /
`- person` / `- activity`, ids 3167379 / 3167377 / 3167378 / 3167376 — all `event_action = *`,
version 2.0, pointing at `<FN>/pb-pipedrive-webhook` with HTTP Basic. The receiver was proved to
verify the stored pair before any real delivery: a deliberately ignorable body
(`{"meta":{"action":"change","entity":"note"},"data":{}}`) posted from `pg_net` with the Basic
header came back `verified: true, processed: true, ignored: 1` and wrote nothing.

Pipedrive is connected (9 Sep, ~17:15 UTC, through a new Pipedrive MCP; the old server is
gone). **The MCP has no webhook tool** — but `PB_PIPEDRIVE_API_TOKEN` has been in Vault since
12 Sep, and Pipedrive's REST API does, so the whole thing runs from the database and nobody
has to fill in four forms. This section used to say "no Pipedrive API token is involved"; that
was true when it was written and is not any more.

1. Generate the Basic pair and store it as one Vault secret, `user:pass`. Use hex, so the value
   contains exactly one colon and splits unambiguously on the first one:

   ```sql
   select vault.create_secret('pbhook:' || encode(gen_random_bytes(24), 'hex'),
                              'PB_PIPEDRIVE_WEBHOOK_BASIC', '<why and when>');
   ```

2. Create the four webhooks from the database, reading both secrets through `pb_secret()` so
   neither is ever typed out (`x-api-token` as a header, not in the URL, so the token stays out
   of any request log):

   ```sql
   with cred as (
     select public.pb_secret('PB_PIPEDRIVE_WEBHOOK_BASIC') as pair,
            public.pb_secret('PB_PIPEDRIVE_API_TOKEN')     as token
   ), parts as (
     select split_part(pair, ':', 1) as usr,
            substring(pair from position(':' in pair) + 1) as pwd, token from cred
   ), objs as (select unnest(array['deal','organization','person','activity']) as obj)
   select o.obj, net.http_post(
     url := 'https://api.pipedrive.com/v1/webhooks',
     body := jsonb_build_object(
       'name', 'Prospect Book - ' || o.obj,
       'subscription_url', '<FN>/pb-pipedrive-webhook',
       'event_action', '*', 'event_object', o.obj, 'version', '2.0',
       'http_auth_user', p.usr, 'http_auth_password', p.pwd),
     headers := jsonb_build_object('Content-Type','application/json','x-api-token', p.token))
   from objs o cross join parts p;
   -- then read net._http_response for the four ids: 201 each, with the new webhook id in the body
   ```

   `GET https://api.pipedrive.com/v1/webhooks` first — the account already carries an unrelated
   `Orbit deal sync` webhook pointing at the PM system, and the point of looking is to not
   disturb it.

   **Or, by hand if the token is ever withdrawn:** Pipedrive **Settings → Tools and apps →
   Webhooks → Create new webhook**. One webhook per entity, four in all, each with:
   - **Version**: 2 (v2 payloads: `{meta, data, previous}`).
   - **Event action**: `*` · **Event object**: `deal`, then `organization`, then `person`,
     then `activity` (i.e. `deal.*`, `organization.*`, `person.*`, `activity.*`).
   - **Endpoint URL**: `<FN>/pb-pipedrive-webhook`.
   - **HTTP Auth**: the `<user>` and `<pass>` halves of the Vault value.
3. Prove it end to end: change any field on one deal, then

   ```sql
   select received_at, verified, processed_at, error, headers ->> 'x-pipedrive-webhook-id' as hook
   from pb_webhook_inbox where source = 'pipedrive' order by received_at desc limit 5;
   select started_at, status, counts from pb_runs where source = 'pipedrive' order by started_at desc limit 3;
   ```

   `verified = true` and a `pb_runs` row (kind `webhook`) are the acceptance evidence (PHASE0
   P0-1). A `401` in Pipedrive's webhook log means the Basic pair on the webhook differs from
   the Vault value; the delivery is recorded in the inbox as unverified (once the secret is
   set, only a hash of the body is kept). Fix the pair; the next delivery verifies.

**Custom-field labels (`PB_PIPEDRIVE_FIELD_MAP`).** Pipedrive keys custom fields by a 40-hex
hash. The webhook parser never hard-codes one: it takes a field map passed in from the Vault
secret `PB_PIPEDRIVE_FIELD_MAP` (JSON `{deals:{<hash>:{label,options}}, organizations:{…},
persons:{…}}`). The new MCP has no field-definitions endpoint, so that map cannot be
collected in-session yet; until an API token exists (§1) and the collector reads
`/v2/dealFields`, `/v1/organizationFields` and `/v1/personFields`, leave the secret unset.
Webhook deliveries still land and are processed; custom fields pass through unlabelled and the
Grade label is not surfaced on webhook deals. The one-time **seed** does not use this map: its
keys are the inferred set in `ingest/pipedrive_seed.ts` (`PipedriveKeys`, overridable per run
through `opts.keys`) — the Grade field `79d0a04a…` (High 414 / Medium 415 / Low 416) is
confirmed live on the Client Journey cards.

## 6 · Enable GitHub Pages and publish the page

1. Repo → Settings → Pages → Build and deployment → Source → **GitHub Actions**. Once.
2. Actions → "Deploy Prospect Book page" → Run workflow. It uploads `web/` and nothing else.
3. Note the Pages URL the run prints (`https://<org>.github.io/prospect-grading/`).

Both steps are done for `briangerstner23/prospect-grading` (10 Sep): Pages is on, run 1 of the
workflow succeeded, and the page is served at **https://briangerstner23.github.io/prospect-grading/**.
Dispatching the workflow needs the **Actions tab** in the repo's top navigation — Settings →
Actions is a different page (General / Runners / Policies / OIDC) and does not list workflows.

## 7 · Add the Pages URL to Supabase Auth

**Reading the book needs none of this** since 10 Sep 2026 — the page is public
(`docs/DECISIONS.md` §5, migration `20260910190000`). This section is what makes *signing in*
work, which is how a rater or the owner gets a lane to write with.

Supabase dashboard → Authentication → URL Configuration → **Redirect URLs** → Add URL:

```
https://<org>.github.io/prospect-grading/**
```

**Leave Site URL alone.** This project is shared with the Client Book and the momentum
dashboard, and Site URL is one global setting for all of them — pointing it here would send
their sign-ins to this page. The allow-list is additive and affects nothing else.

Until the Pages URL is on that list the magic link cannot return to the page: the page asks
Supabase to send the signer back to its own URL, Supabase honours that only for an allowed
redirect, and otherwise falls back to Site URL — which on a fresh project is
`http://localhost:3000`, so the link lands on "site can't be reached". A link is single-use, so
request a fresh one after fixing the list. Email sign-in (OTP) must be enabled under
Authentication → Providers → Email.

This step cannot be done from a session: the setting is GoTrue platform config rather than a
table, so `execute_sql` cannot reach it, the MCP has no tool for it, and `api.supabase.com` is
blocked from the build container. A person does it in the dashboard.

## 8 · Insert `pb_members` rows

**The owner rows are in (9 Sep); the two rater rows wait on their email addresses.** Reading
needs no row (any signed-in `@whitelabeliq.com` address reads, PRO-7). Writing does. Lanes
per PRO-5: `owner` (overrides, promotions, decisions, merges), `rater` (facts, hand signals,
merge-queue review, merges), `viewer` (no writes).

```sql
insert into pb_members (email, display_name, role) values
  ('<rater-1>@whitelabeliq.com','Sales rater 1','rater'),
  ('<rater-2>@whitelabeliq.com','Sales rater 2','rater')
on conflict (email) do update set role = excluded.role, active = true;
```

Emails are matched lower-cased against the JWT. Deactivate with `update pb_members set active = false where email = '…'`.

## 9 · Run a manual score

Scores every `pb_accounts` row with `book in ('prospect','parked')` under the active rubric,
inserts `pb_reads`, refreshes the listing columns and writes a `pb_runs` row:

```bash
curl -sS -X POST "<FN>/pb-score" \
  -H "Authorization: Bearer <PB_SYNC_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"triggered_by":"<your email>","kind":"score"}'
```

One account: append `?account=<pb_accounts.id>`. The nightly cron does the same call at
06:15 UTC; decay is inside scoring, so one job covers both. The bearer is the Prospect Book's
own token, not a Supabase JWT — which is why the function is deployed with `verify_jwt = false`.

Push a pack of rows (accounts, facts, signals, contacts, deals, calls, identity candidates)
with the same bearer:

```bash
curl -sS -X POST "<FN>/pb-sync" \
  -H "Authorization: Bearer <PB_SYNC_TOKEN>" \
  -H "Content-Type: application/json" \
  -d @pack.json     # { "run": {"kind":"ingest","source":"orbit","triggered_by":"…"}, "signals": [...] }
```

## 10 · Preview a draft rubric before activating it

1. Insert the new version as `draft`:
   ```sql
   insert into pb_rubric_versions (version, status, spec, spec_sha256)
   values ('0.2.0', 'draft', '<json>'::jsonb, '<sha256>');
   ```
2. Score under it **without writing reads** and read the tier diff:
   ```bash
   curl -sS -X POST "<FN>/pb-score?rubric=0.2.0&preview=1" \
     -H "Authorization: Bearer <PB_SYNC_TOKEN>" -H "Content-Type: application/json" -d '{}'
   ```
   The response lists every account whose tier, status or cell would change.
3. If accepted, record the diff and activate — one active version at a time:
   ```sql
   update pb_rubric_versions set status = 'retired' where status = 'active';
   update pb_rubric_versions
      set status = 'active', activated_by = '<owner email>', activated_at = now(),
          preview_diff = '<the diff JSON>'::jsonb
    where version = '0.2.0';
   ```
4. Regenerate `docs/METHOD.md` (`node --experimental-strip-types explain/generate_method.ts`)
   and run a manual score (§9).

## 11 · Running the seed

The one-time seed composes the four intake sources — the certified Pipedrive roster, the
Notion master's prospect rows, Orbit client ids and quotes, the Fathom back-fill — into one
consistent set of `pb_*` rows. It is **generate only**: `scripts/seed.ts` reads the collected
pulls from a scratch directory (never the repository), writes numbered SQL files, and the
operator applies them through `execute_sql`, one file per call, in lexical order. The full
procedure, the inputs and where each came from, the fact-precedence rule and the PRO-10
cross-check are in **`scripts/seed_README.md`**. In short:

```bash
node --experimental-strip-types scripts/seed.ts \
  --in <scratch>/pulls --out <scratch>/pulls/seed --as-of 2026-09-09 --uuid-seed <text>
# read <out>/SUMMARY.md, then apply <out>/01_*.sql … 08_*.sql with execute_sql, one per call, in order
```

Afterwards run a manual score (§9) and check `select started_at, status, counts from pb_runs
where kind = 'seed' order by started_at desc limit 1;`. The seed never merges: everything it
could not attach on a high key is in the merge queue (§12).

## 11b · Clearing a class of fact claims at once (`#queue`)

The per-account sheet asks "what is waiting on **this** agency", which is the right question
when you are confirming a claim and the wrong one when an extractor has proposed a value the
book cannot hold across forty sheets. The page's **`#queue`** view (linked from the roster's
count line, reviewers only) groups every `proposed` row in `pb_fact_candidates` by key and then
by the value proposed, and rejects a group at a time through
**`pb_reject_fact_candidates(p_candidates uuid[], p_note text default null)`**.

**Open a group and you get the claims themselves** — each with its verbatim sentence, the
agency (linked to its sheet), the source, the extractor, the date, what the book currently holds
where they disagree, a link to the source, and its own **Confirm** and **Reject** buttons calling
`pb_review_fact_candidate`. The grouping is for scanning and for bulk rejection; the judgement
still happens one claim at a time, which is the only way it can happen.

**Only rejection goes in bulk, and that asymmetry is the point.** Rule 8 says nothing a machine
read becomes a fact on a machine's say-so, so there is no bulk confirm and there should never be
one — confirming stays one claim at a time with its sentence in front of you. Rejecting writes no
fact, so the same objection does not run in reverse; the worst a wrong rejection costs is a
proposal the next sweep offers again.

Selection is **per claim**, not per group. A group's checkbox is a select-all for its claims and
shows an indeterminate state when only some are taken, so fifteen of seventeen is a normal thing
to do and a partly-taken group never looks whole. This matters: the first cut of this view
selected whole groups only and showed no sentences, which made it impossible to tell what you
were agreeing to — the complaint that produced this paragraph.

What it keeps from the one-at-a-time path: the same owner/rater lane check, `proposed` rows
only, and **one register row per claim** — deciding twenty at once makes the clicking cheaper,
not the record thinner. Each row's payload carries a shared `batch_id` and `batch_size`, so the
register can still say these went together. A candidate someone else decided in the meantime is
skipped and counted in the return value rather than failing the batch, and at most 1000 go in
one call.

The worked example this was built for: on 14 Sep 2026 the queue held 17 `reseller` and 3
`referral` proposals for `relationship_type`, values `resolve_features` rejects, from the
extractor prompt fixed in `e053ff7` and deployed as pb-notes v11. Twenty rows, two clicks.

## 12 · Reviewing the merge queue

`pb_identity_candidates` holds every match below `high` confidence, plus the Orbit and Fathom
rows the mappers could not attach, `status = proposed`. A person decides; the decision is carried
through by **`pb_review_candidate(p_candidate uuid, p_decision text, p_note text default
null)`** (migration 5), owner and rater lanes only, `p_decision` = `merged` or `rejected`:

| Candidate `source` | Effect of `merged` |
|---|---|
| `orbit` | the account takes `orbit_client_id` (if it has none) |
| `pipedrive` | if another row already carries that Pipedrive organisation, the reviewed account is merged **into** it (`pb_merge_accounts`; the certified row survives); otherwise the account takes `pipedrive_org_id` and becomes `roster_certified` (PRO-6) |
| `notion_master` | the account takes `notion_client_id` |
| `fathom` | the `pb_calls` rows carrying that recording attach to the account |
| anything else | recorded only |

`rejected` records the decision and moves nothing. Either way a `pb_register` row of kind
`decision` is written under the reviewer's name. Whichever path is used, the decision must go
through the procedure: a bare status update on the candidate row records the review but
carries nothing through (no `orbit_client_id`, no merge).

**On the page**: the account sheet's *Merge queue* group lists the proposed rows with
*Confirm match* / *Reject* controls for the owner and rater lanes. **By SQL** (service role
or a signed-in owner / rater):

```sql
-- what is waiting
select id, account_id, source, source_name, source_domain, matched_on, confidence, note
from pb_identity_candidates where status = 'proposed' order by created_at;

-- decide one
select pb_review_candidate('<candidate id>', 'merged',   'same company — confirmed with the AM');
select pb_review_candidate('<candidate id>', 'rejected', 'different agency with a similar name');

-- the decision, on the record
select created_at, made_by, text, payload from pb_register
where kind = 'decision' order by created_at desc limit 5;
```

Over PostgREST RPC the arguments are named: `{p_candidate, p_decision, p_note}`. A candidate
with no `account_id` cannot be confirmed until an account exists to attach to. After a
confirmation that changed keys or merged rows, score the account (§9, `?account=`).

## 13 · Merging two rows

When two `pb_accounts` rows turn out to be one company, **`pb_merge_accounts(p_source uuid,
p_target uuid, p_note text default null)`** (migration 4) carries out the merge — owner and
rater lanes only, never from the page alone:

- moves every fact, signal, contact, call, deal, register row (except `decision`) and
  candidate from `p_source` onto `p_target`; marks proposed candidates that pointed at the
  duplicate's identity `merged`;
- **reads are not moved** — they were computed for the row as it was and stay its history;
  the next scoring run reads the merged row;
- the survivor takes any identity key it lacked (`domain`, `pipedrive_org_id`,
  `orbit_client_id`, `apollo_org_id`, `notion_client_id`, `notion_page_id`), becomes
  `roster_certified` if either row was, and keeps its own keys where both had one;
- the duplicate keeps its row (history) with `book = 'merged'`, `merged_into = p_target`,
  `status = 'Merged'`, its `pipedrive_org_id` cleared so the survivor may carry it;
- a `pb_register` row of kind `decision` records who merged what, with the moved counts.

```sql
-- the certified Pipedrive row is normally the target
select id, key, name, domain, pipedrive_org_id, roster_source, roster_certified, book
from pb_accounts where key in ('<norm(name) A>', '<norm(name) B>');

select pb_merge_accounts('<duplicate id>', '<survivor id>', 'same company: Notion row and Pipedrive organisation');

-- afterwards
select id, book, merged_into from pb_accounts where id = '<duplicate id>';   -- book = merged
```

Over PostgREST RPC: `{p_source, p_target, p_note}`. Refused when either id is unknown, the
two are the same row, or either is already merged. Then score the survivor (§9, `?account=`).

## 14 · Add a fact by SQL in an emergency

Prefer the page (RLS records the rater under their own name). When the page is down, the
service role can insert directly. Facts are append-only; the latest row per key wins
(`pb_current_facts`). `value` is JSON; `null` records a real "unknown".

```sql
insert into pb_facts (account_id, key, value, evidence_label, source, evidence_url, observed_at, entered_by, stand_in, note)
values (
  (select id from pb_accounts where key = '<norm(name)>'),
  'headcount', '24'::jsonb, 'evidence', 'rater', '<url of the primary record>',
  '2026-09-09', '<rater email>', false, 'Entered by SQL — page unavailable');
```

`key` must be a `ProspectFeatures` key (snake_case, see `core/prospect_types.ts`);
`evidence_label` is `evidence` / `inferred` / `unknown`. Set `stand_in = true` when the
owner enters a fact on a rater's behalf (PRO-5). The fact takes effect at the next score run
(§9). Hand-entered **signals** take their weight, lifespan and decay from the active rubric's
catalog (migration 4's trigger); a type outside the catalog is refused.

## 15 · Read `pb_runs`

Every ingest, score, webhook and seed run writes a row. `counts` and `errors` are JSON.

```sql
-- the last ten runs
select started_at, finished_at, kind, source, triggered_by, status, counts, errors
from pb_runs order by started_at desc limit 10;

-- did last night's score happen, and did it finish?
-- No triggered_by filter, deliberately: `= 'pg_cron'` hides a hand-run recovery AND hides the
-- watchdog row, which says triggered_by = 'pb-nightly-watchdog'. Read `source` instead —
-- 'pb-score' is a run that happened, 'watchdog' is a night that did not.
select started_at, status, source, triggered_by, counts
from pb_runs where kind = 'score' order by started_at desc limit 5;

-- anything not clean in the last week
select started_at, kind, source, status, errors
from pb_runs where status <> 'success' and started_at > now() - interval '7 days'
order by started_at desc;
```

Since 12 Sep a **`pb-nightly-watchdog`** job at 07:00 UTC asks this question for you and writes
a `failed` row with `source = 'watchdog'` for any nightly job that left no finished run that
morning, carrying what `pg_cron` and `pg_net` saw while they still remember it. So a silent
night now leaves a row after all, and `select … where status <> 'success'` above finds it.
A `watchdog` row is a record, never an attempt and never a retry — re-run the job by hand.
Call `select public.pb_nightly_watchdog();` to run the check early; it returns how many rows
it wrote and will not write a second one for the same night.

**A missed night is an ABSENCE, and no query above shows an absence.** Every check here reads the
rows that exist; a night on which the job never wrote a row at all looks exactly like a night that
has scrolled off a `limit 3`. That is not hypothetical — see the 12 Sep 2026 entry below. Ask for
the gap instead of the rows:

```sql
-- nights in the last fortnight with no finished score. Rows here are missed nights.
select d::date as night
from generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
where not exists (
  select 1 from pb_runs r
  where r.kind = 'score'
    and r.status in ('success', 'partial')
    and r.started_at >= d + interval '6 hours'
    and r.started_at <  d + interval '9 hours'
)
order by night;
```

`pg_cron` keeps its own account of whether the job fired at all, and `pg_net` of what came back.
Those two and `pb_runs` answer three different questions, and a silent night is when they
disagree — the job fired, the request was made, and no run row exists:

```sql
-- did the jobs fire, and what did the function answer?
select case when d.command like '%/pb-score%' then 'score'
            when d.command like '%/pb-notes%' then 'notes' else 'other' end as job,
       d.status as cron_status, d.start_time,
       r.status_code, coalesce(r.error_msg, left(r.content, 80)) as answer
from cron.job_run_details d
left join net._http_response r
       on r.created between d.start_time and d.start_time + interval '5 minutes'
where d.command like '%functions/v1/pb-%' and d.start_time > now() - interval '4 days'
order by d.start_time desc;
```

Two things about that query, both of which cost an hour to learn:

- **Match on `d.command`, not on the job name.** `cron.job_run_details` keeps the `jobid`, and
  amending a job here means `cron.unschedule` then `cron.schedule`, which issues a **new** jobid —
  so `join cron.job using (jobid)` silently drops every firing that happened under the old one.
  After `20260912130000` the score job is jobid 4; join by name and its 10 and 11 Sep history
  disappears. The command text is in the run row itself and survives the re-schedule.
- **`cron_status = 'succeeded'` means the POST was *sent*, not that the function worked.** It
  reports `net.http_post` returning a request id, nothing more. The function's actual answer is in
  `net._http_response`, which **pg_net prunes after about six hours** — so this query is a
  same-morning tool. `pb_runs` is the durable record, which is exactly why a night with no
  `pb_runs` row is worth noticing.

> **12 Sep 2026 — both nightly jobs failed and only one of them said so.** At 05:45 and 06:15 UTC
> `pb-notes` and `pb-score` each answered **500** and wrote **no `pb_runs` row**, so the book went
> a day unscored with nothing in its own record to say so. The cause was one transient
> **504 Gateway Timeout** on `public.pb_secret('PB_SYNC_TOKEN')` — the first call each function
> makes, made before either has written anything — and Postgres logged no error at all, because
> the query never reached it. The sweep's failure was legible because
> `20260911150000` had given that job `timeout_milliseconds := 150000` and `pg_net` captured the
> 500; the score's was not, because its job still carried `pg_net`'s 5000 ms default and had been
> recording "Timeout of 5000 ms reached" on every night, good and bad alike, since
> `20260909120100`. `20260912130000_prospect_book_score_cron_timeout` gives it the same 150 s.
> The score was re-run by hand the same day (680 scored, 601 ranked, 0 errors — unchanged counts).

> **12 Sep 2026, later the same day — the reads were right about the wrong facts.** Two accounts
> went Ranked → Unclassified after a Pipedrive sweep that had written them nothing. `selectIn`
> chunked ids for URL length and never paged rows, so PostgREST's 1000-row cap — which is per
> *request*, not per filter value — silently truncated four of pb-score's seven chunks. The fix
> is in **pb-score v5**; a `?preview=1` run proved it before anything was written, and the real
> run that followed moved **14 accounts Unclassified → Ranked** (7 Bronze, 4 Gold, 3 Silver),
> nothing in the other direction and no tier moved among the accounts already ranked. Every read
> published between the seed and that run was computed from a truncated window: 72 unclassified
> where 58 was the truth. The lesson for the next reader is the shape of it — a truncation is
> *invisible* (200 OK, `content-range: 0-999/*`), so what surfaces is a downstream nonsense like
> a tier flip, and the trace is what turns that into a diagnosis (`icp_derivation` went "stated"
> → "none" while the fact sat in `pb_current_facts` the whole time).

`status` is `running` (never finished — investigate), `success`, `partial` (some rows
errored; see `errors`) or `failed`. The seed run's `counts.skipped` lists the organisations
and Notion rows dropped as "already an Agency Partner" by design (PRO-10).

## 18 · Pull the closed-deal history from Pipedrive

`pb_deals` was seeded with **open** deals only, because the roster was derived from Client
Journey cards and open pipeline-1 deals (DESIGN §4d). Pipedrive holds the closed ones, and they
are the only outcome record either book has. Re-run this whenever the outcome question comes up;
it is read-only against Pipedrive and idempotent against `pb_deals`.

**Scope.** Pipeline 1 is the deal pipeline. Pipeline 9 (Client Journey) holds **no** closed
deals — its cards stay `open` and carry their state in the stage — so pipeline 1 is the whole
closed universe. Verify that before widening:

```
getDeals status=won  pipeline_id=9 limit=2     -> expect data: []
```

**Paging.** `getDeals` caps at 500 per page and returns `additional_data.next_cursor`; a
response of 500 with a cursor is a floor, never a total. Page until `next_cursor` is null —
two pages each for won and lost as of 12 Sep 2026. Each page is ~1 MB, so read it from the
saved tool-result file rather than into the conversation.

```
getDeals status=won  pipeline_id=1 limit=500 sort_by=add_time sort_direction=desc [cursor=...]
getDeals status=lost pipeline_id=1 limit=500 sort_by=add_time sort_direction=desc [cursor=...]
```

**What to load, and what not to.** Join each deal's `org_id` to `pb_accounts.pipedrive_org_id`
— that is a `high` key under `ingest/identity.ts`, so it attaches automatically. **Load only
the deals that match a book account.** Most closed deals belong to organisations that are
Agency Partners under PRO-10 and are deliberately not in the book; importing their deal history
would put client data in the prospect system and cut against PRO-17. Their outcomes are analysis
input, not book rows.

**Safety.** `pb-score` filters `status === "open" && is_cj !== true` before grading
(`pb-score/index.ts`), so closed rows are inert in the scoring path. Confirm with a
`?preview=1` run: the counts must not move. If they do, something else changed.

**Two casting traps in the load SQL.** A `VALUES` list whose column holds a quoted timestamp
*and* a `null` resolves to `text`, and the insert fails with *"column is of type timestamp with
time zone but expression is of type text"*. Cast in the select — `v.won_time::timestamptz` —
rather than trusting inference. `close_date::date` from the same unknown literal is fine.
Upsert on the primary key `pipedrive_deal_id`.

### What the history is worth

Two things, and it is worth being clear which is which.

**Deal-motion thresholds — immediately usable.** The rubric defaults every stage median to
**21 days** "until WLIQ's own are known" (METHOD §12). They are now knowable. Measured over
1,355 closed pipeline-1 deals on 12 Sep 2026, creation to close:

| | n | p25 | median | p75 |
|---|---|---|---|---|
| Won | 589 | 1 d | **8 d** | 34 d |
| Lost | 667 | 36 d | **97 d** | 257 d |

The placeholder sits between the two and is a poor stand-in for either. Three quarters of wins
close inside 34 days, which is the shape of the finding: a deal still open well past a month is
already behaving like a loss. Changing the rubric on this is a new version, previewed and
owner-activated (rule 4) — not an edit in place.

**A conversion cohort — not from pipeline 1, and this is the trap.** Pipeline-1 deals record
whether a piece of *work* was won. They are mostly repeat projects for existing partners, and
the project motion has since moved to Orbit. Of the 133 organisations with a won pipeline-1
deal, **1** is in the book, because PRO-10 removed the rest long ago. A conversion test built
on them would have one positive case.

### The Client Journey cards are the conversion record (§18b)

One card per company, pipeline 9, always `status = open` — the state lives in the stage. A
prospect becoming an Agency Partner IS a card moving into a client stage, which is the PRO-10
event. Pull all of them the same way (two pages on 12 Sep 2026, 943 cards):

```
getDeals status=open pipeline_id=9 limit=500 sort_by=add_time sort_direction=desc [cursor=...]
```

| Stage | Cards | Reads as |
|---|---|---|
| Active Client 63 · Lost Client 67 · Past 65 · Inactive 64 | 113 · 89 · 27 · 20 | **converted — 249** |
| Unqualified/DNC 66 · Quote Lost 71 | 172 · 75 | **did not convert — 247** |
| Schedule Sales Call 58 · Sales Call Done 59 · Quoting 70 · New 57 | 185 · 158 · 51 · 22 | in flight — 416 |
| Friends of WLIQ 69 | 31 | not a sales relationship |

**249 converted against 247 not.** `docs/BASELINE.md` records the available cohort as n = 31 and
notes adequate power needs ~110. This is sixteen times that, and clears every vendor training
minimum. It is the single most useful thing either pull produced.

The 247 non-converters are **already in the book and already graded** — PRO-10 only removes
winners — so a partial check runs today with no new data. Grading in-book accounts by how the
relationship ended (12 Sep 2026): Gold rate is 35% at Sales Call Done, 13% Quoting, 11% Schedule
Sales Call, 7% Quote Lost, 3% Unqualified/DNC.

**Do not report that as validation.** It is confounded twice: accounts further along carry more
facts and facts feed the grade (average facts present falls with the Gold rate, 1.06 → 0.52),
and an agency marked Unqualified was marked so by a person whose judgement also seeded its ICP
class. It says the sign is not obviously wrong. It cannot settle PRO-8.

**What is still missing** is the pre-conversion feature snapshot for the 249 winners: they are
not in the book, and each needs evidence dated before its card reached a client stage. That is
the pre-signing harvest PRO-8 has always recorded as unrun. Also missing is *when* each card
changed stage — the pull captures stage membership, not stage history, so the cohort is not yet
dated. Pipedrive keeps a changelog; reading it is a separate job.

### Deal health is pointed at the wrong system

Project deals are now run in **Orbit**, not Pipedrive. The book holds 31 open Pipedrive deals,
**none** with a `last_buyer_touch_at` and **none** carrying a health verdict. Every deal-health
rule needs a field that is null and unknown never warns, so the read is silent by construction
rather than because the deals are healthy. Re-grounding the stage medians matters much less
than pointing the read at whichever system now holds the motion.

## 19 · Is the book actually moving?

The grade is supposed to change as a pursuit progresses — a call lands, a note is read, a signal
decays, tomorrow's chase order differs from today's. Nothing measured whether that happened, so
the question needed an ad-hoc window query and in practice nobody asked it. Two views answer it
now, both public-read like the rest of the page's data.

```sql
select * from pb_pulse;                                -- one row: alive? waiting on what?
select run_at::timestamp(0), accounts, tier_moved, promoted, demoted, urgency_moved,
       facts_changed, newly_ranked
from pb_movement order by run_at desc limit 14;        -- per scoring run
```

`pb_pulse` carries: hours since the last score, what moved on that run, the inputs that arrived
in the last 7 days (facts, signals, calls), the two review queues, and how much of the book is
Cold. Read it as *did anything happen, and what is blocked*.

**What it said on first run (13 Sep 2026), and why it matters.** Across eight scoring runs and
three days over 680 accounts: **8, 1, 0, 0, 2 tier moves** on business evidence, and every one of
them a **demotion**. The only promotions in the book's history are the 14 from the fact-paging
fix on 12 Sep. Urgency moved for about a dozen accounts in total. The machinery runs nightly;
almost nothing flows through it.

That is an input problem, not an engine problem. Of the three `pb-notes` channels only
`fathom_call` is live — `pipedrive_note` and `email` are dark for want of their credentials
(§17) — so emails and CRM notes never reach the book. `pb_calls` holds 12 rows, because the
Fathom webhook is future-only and the back-fill has not run. And 440 of 680 accounts read Cold,
so most have no live signal to decay in the first place.

### Two traps these views exist to document

**Group by `run_id`, never `run_at`.** `pb_reads.run_at` is the row's INSERT time and pb-score
writes in batches, so one run lands rows a second or two apart. Grouping by `run_at` splits a
single run in two, doubling the row count and halving every movement figure. It does not error.

**`coalesce(array_position(...), 0)` is load-bearing.** An Unclassified read carries
`effective_tier` NULL; `array_position` returns NULL for it and `NULL > 2` is NULL — not false
and never true. Without the coalesce, an Unclassified → Bronze move counts in `tier_moved` and
in *neither* `promoted` nor `demoted`, so the columns silently fail to sum. That is the same
NULL-comparison failure §16 records for the grants check, met a second time in a different
place. `promoted + demoted = tier_moved` is the assertion worth re-running after any edit:

```sql
select count(*) from pb_movement where promoted + demoted <> tier_moved;   -- expect 0
```

Rank 0 for NULL also says the right thing: Unclassified sits below Bronze, and becoming
rankable is a promotion.

### What is deliberately not in these views

`pb_source_watermarks`, which would say which note channels ran and when. `anon` holds nothing
on it and both views are `security_invoker = true`, so joining it would return nothing for the
anonymous reader the page actually uses. Channel state comes from `pb_runs` instead (§15).

## 16 · Quick health checks

```sql
select count(*) filter (where book = 'prospect')  as prospects,
       count(*) filter (where book = 'parked')    as parked,
       count(*) filter (where book = 'merged')    as merged,
       count(*) filter (where roster_certified)   as certified
from pb_accounts;

select status, source, count(*) from pb_identity_candidates group by 1, 2 order by 1, 2;  -- the merge queue
select effective_tier, count(*) from pb_current_reads group by 1;                          -- tier spread
select source, verified, count(*) from pb_webhook_inbox group by 1, 2;                    -- inbound deliveries
```

**Check both `anon` and `authenticated`.** Supabase's default privileges on `public` hand
insert, update, delete and truncate on anything created after they were set, to **both** roles.
Three tables made on 11 Sep arrived that way for `anon`
(`20260911170000_prospect_book_revoke_anon_writes`); every one of the twenty `pb_` objects had
it for `authenticated` until `20260912140000_prospect_book_revoke_authenticated_writes`, which
went unnoticed for as long as it did because the check here asked about `anon` alone. The
defaults belong to a project shared with other WLIQ systems, so they stay as they are and
**each new table carries its own revoke, for both roles**.

RLS default-deny refuses these over PostgREST — with one exception. **TRUNCATE is not subject
to RLS**: Postgres checks the privilege and nothing else, so no row policy ever refused it, and
the only thing between a signed-in user and an empty `pb_reads` was that PostgREST does not
expose TRUNCATE. That is a property of the client, not of our permissions.

`authenticated` writes legitimately where a policy says so, so its expected set is not simply
`SELECT`. Six policies, six verbs, read out of `pg_policy` rather than assumed: insert on
`pb_facts`, `pb_signals`, `pb_register`, `pb_promotions`; update on `pb_fact_candidates` and
`pb_identity_candidates`. Everything else is select, and the three service-role-only tables
(`pb_apollo_enrichment`, `pb_source_watermarks`, `pb_webhook_inbox`) hold nothing for either
role. This returns nothing when the book is in order:

```sql
select grantee, table_name, privs, expected
from (
  select grantee, table_name,
         string_agg(privilege_type, ',' order by privilege_type) as privs,
         case
           when grantee = 'authenticated'
            and table_name in ('pb_facts','pb_signals','pb_register','pb_promotions')
           then 'INSERT,SELECT'
           when grantee = 'authenticated'
            and table_name in ('pb_fact_candidates','pb_identity_candidates')
           then 'SELECT,UPDATE'
           else 'SELECT'
         end as expected
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated')
    and table_name like 'pb\_%'
  group by 1, 2
) g
where privs <> expected;
```

Compare against a computed `expected` rather than writing the exceptions into
`having … not in (…, case … end)`. When that `case` falls through to NULL the whole comparison
is NULL rather than true and the row is silently dropped — a check that hides precisely the
findings it exists to surface.

To prove a revoke took without breaking a lane, try the write as the role and read the error:
**`permission denied for table …` is the grant refusing, `new row violates row-level security
policy …` is RLS refusing a grant that is still there.** The second is what a lane's table must
say — a real signed-in rater carries a JWT and passes the policy. Run it inside a transaction
and roll back. `reset role` before writing the results anywhere, or the probe cannot record
itself:

```sql
begin;
set local role authenticated;
insert into pb_facts(account_id, key, value, evidence_label, source)
  values ('00000000-0000-0000-0000-000000000000','is_agency','true'::jsonb,'evidence','manual');
--  expect: new row violates row-level security policy   (grant kept, policy gating)
insert into pb_reads(account_id, rubric_version)
  values ('00000000-0000-0000-0000-000000000000','0.1.0');
--  expect: permission denied for table pb_reads          (grant gone — CLAUDE.md rule 6)
rollback;
```

**Both views must keep `security_invoker = true`.** `create or replace view` **resets a view's
options** when it is replaced without a `WITH` clause, so rewriting one silently turns it into a
definer's-rights view that enforces the creator's RLS rather than the caller's — which is how
`pb_current_facts` lost the setting when the fact-precedence migration rewrote it, and how it
got it back in `20260911180000_prospect_book_restore_view_invoker`. Rewrite a view and re-check:

```sql
select c.relname,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'not set') as security_invoker
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'pb\_%';
```

Both rows must read `true`. `ALTER VIEW … SET (security_invoker = true)` restores it without
restating the definition.

Supabase's own linter catches both of these — `get_advisors(type: security)` through the MCP.
Its other `pb_` findings are intended and stay: RLS-with-no-policy on the service-role-only
tables (`pb_apollo_enrichment`, `pb_source_watermarks`, `pb_webhook_inbox`), public reads under
DECISIONS §5, and the four `SECURITY DEFINER` functions, each of which re-checks the caller's
lane before doing anything. Findings on tables without a `pb_` prefix belong to other WLIQ
systems sharing this project — not ours to change.

---

## 9 · Previewing and activating rubric 0.2.0

`0.2.0` is registered in `pb_rubric_versions` as **draft**, spec sha256
`09d4e8cb36baa1d041968df3165b6e95aefe5a7a0e5ca3ba2538e08095c4f3d1`. **0.1.0 is still active and
nothing has been re-scored.** See `docs/DECISIONS.md` §8 for why ICP was retired as the fit read.

### 9.1 · pb-score must be redeployed first — **done 11 Sep 2026 (version 3)**

This section was right, and the cost of skipping it is worth recording. The preview was run
against the old `pb-score` first: it answered `ok:false` with an error on **every ranked row** —
`'dimension_b.base_tier_from_icp.map.ICP-3' must be one of … (got nothing)` — because the
deployed engine predated the criteria path and still took the ICP branch, which 0.2.0 no longer
carries. Nothing was wrong with the draft; its stored spec matched the repo byte for byte.
**The version in `pb_rubric_versions` says nothing about which engine is live**, so a rubric that
moves a decision into a new spec key is not previewable until the function is redeployed.

Version 3 was deployed and then checked against the ACTIVE rubric before being trusted: a 0.1.0
run immediately before and after the redeploy returned identical counts (scored / ranked /
parked / unclassified all equal, zero errors). That check is the point — a redeploy that changes
nothing under the live rubric is the only kind that is safe to make outside a release.

To rebuild and redeploy:

```bash
bash scripts/build_functions.sh          # → dist/functions/pb-score/index.js
```

Deploy that bundle with `entrypoint_path index.js` and `verify_jwt false`. **The bundle
contains 59 backslashes** (regex literals and one `—`); §3's escaping discipline applies.

Confirm with a GET — but expect **405 `{"error":"POST only"}`, not a health body**. Only the two
webhooks carry a `GET` health branch; `pb-sync`, `pb-score` and `pb-notes` never have. A 405 with
that JSON is still the proof you want: an unparseable or non-booting bundle answers a boot error
instead, so reaching the method check at all means the source parsed and the function started.
The conclusive check for pb-score is a real run against the ACTIVE rubric whose counts match the
run before the redeploy (§9.1 above).
Where the Supabase CLI is available it deploys the TypeScript directly and sidesteps this:

```bash
supabase functions deploy pb-score --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
```

### 9.2 · Preview — writes nothing

```
POST $FN/pb-score?rubric=0.2.0&preview=1     # same bearer as the nightly run
```

No `pb_reads` rows, no `pb_runs` row. The response carries the counts and a per-account diff
against the current reads. That diff is the thing to read before activating: decision 8 projects
roughly half the warm list moving, with about 37 of 57 current Golds dropping and about 53 of 97
Bronzes rising.

### 9.3 · What the criteria can answer today

Six criteria; fact coverage across all 680 accounts as of 11 Sep 2026:

| Criterion | Accounts with the fact |
|---|---|
| `sells_build_work` | 175 |
| `no_inhouse_dev_team` (or the older `inhouse_dev_team`) | 159 |
| `headcount` → `size_band_fit` | 463 |
| `is_agency` | 558 |
| `client_budget_size` | **0** |
| `recurring_work_shape` | **0** |

The two empty criteria are the ones no API supplies. `client_budget_size` needs a person reading
the agency's work page — ninety seconds each, or record unknown. Until they are answered, the
best any account can score is 4 of 6, so **no account outside the enriched warm slice can reach
the Gold band (5+)**, and most of the book will sit on one or two answered criteria.

That is the correct behaviour, not a defect — unknown is never evidence — but it means
**activating 0.2.0 before the rater pass would flatten most of the book to Bronze**. Preview
first, read the diff, and consider answering `client_budget_size` on the warm 200 before
activating.

### 9.4 · Activating

Activation is a deliberate step, not a side effect of previewing:

```sql
update pb_rubric_versions set status = 'retired' where version = '0.1.0';
update pb_rubric_versions set status = 'active', activated_by = '<owner email>',
       activated_at = now() where version = '0.2.0';
```

`pb_reads` is append-only, so the v0.1.0 baseline run survives activation untouched
(`docs/BASELINE.md`). To go back, reverse the two statements and re-run `pb-score`.

---

## 17 · The nightly notes sweep (`pb-notes`)

Reads the written record into facts and a review queue. Runs at **05:45 UTC**, half an hour
before the nightly score, so something read in the morning changes that morning's tier.

Three channels, swept in one run: `fathom_call` (the summaries the webhook already wrote into
`pb_calls`), `pipedrive_note`, and `email`. Each has its own watermark row and its own
credential, and **a channel with no credential is skipped and said so in the run's notes** — it
is not an error.

### Before it can run

`pb-notes` answers **503 and writes no `pb_runs` row** without `PB_ANTHROPIC_API_KEY`; that one
key is the whole sweep. Everything else only decides how many channels do work. Check the real
state rather than this table:

```sql
select name from vault.secrets where name like 'PB_%' order by name;
```

| Secret | Channel it opens | State (11 Sep 2026) |
|---|---|---|
| `PB_ANTHROPIC_API_KEY` | all of them — without it the function 503s | **set** |
| *(none)* | `fathom_call` — reads `pb_calls`, which the webhook fills | always on |
| `PB_PIPEDRIVE_API_TOKEN` | `pipedrive_note` | not set |
| `PB_GMAIL_REFRESH_TOKEN` + `_CLIENT_ID` + `_CLIENT_SECRET` | `email` | not set |
| `PB_EXTRACTOR_MODEL` | optional; defaults to `claude-sonnet-5` | not set |

Gmail wants a **refresh** token, not an access token: an access token dies in an hour and the
job runs at 05:45. The function exchanges the refresh token for an access token on each run.
The scope is **`https://www.googleapis.com/auth/gmail.readonly`** — `gmail.metadata` is not
enough, because it withholds the body and the sweep reads the message, not the headers.

> **Done — the redeploy this step used to wait for happened on 12 Sep 2026.** `pb-notes` is
> **version 9**, which is the first deployed build with the full-body read and the quoted-reply
> trim; v8 had neither, and while the channel has no credential the drift is invisible, so the
> trap was real: the moment those secrets existed an un-redeployed v8 would have read
> ~200-character previews and dated quoted passages by the reply that quoted them. The deploy was
> confirmed three ways — GET answered 405 `{"ok":false,"error":"POST only"}` (pb-notes has no
> health branch; see §9.1), a `dry_run` sweep ran the whole handler green, and the deployed source
> was read back and checked character by character at every one of its 38 regex backslashes.
> **The three Gmail secrets can now be added whenever you like.**

Minting the refresh token, end to end:

1. **Google Cloud Console → APIs & Services → Library** → *Gmail API* → **Enable**.
2. **OAuth consent screen** → **Internal** (a Workspace org; External would need verification
   for a restricted scope) → name and support email → Save.
3. **Credentials → Create Credentials → OAuth client ID** → type **Web application**.
4. Add the authorised redirect URI exactly: `https://developers.google.com/oauthplayground`
5. Keep the **Client ID** and **Client secret**.
6. At **developers.google.com/oauthplayground**: gear icon → tick *Use your own OAuth
   credentials* → paste both. In *Input your own scopes* put
   `https://www.googleapis.com/auth/gmail.readonly`. **Authorise APIs**, sign in **as the mailbox
   to be read**, allow, then **Exchange authorization code for tokens** and keep the
   **refresh** token.
7. Store all three with §1's `vault.create_secret` form — after the redeploy above.

The refresh token is bound to the account that authorised it, so step 6 decides whose mail the
sweep reads. It lasts until it is revoked or the consent screen changes; a `400` from the token
exchange at run time means exactly that, and the run says so rather than guessing.

Two things about that channel are worth knowing before you set the OAuth up. It asks Gmail for
`format=full` and walks the MIME tree for `text/plain`, falling back to `text/html` through the
same stripHtml the CRM notes use, and skipping attachments. And it **cuts the quoted history off
every reply** before anything reads it: a thread repeats itself in each message, so leaving it in
would read the same sentences once per reply and — the real fault — date each copy by the reply
that quoted it instead of the message that said it, which is rule 4 backwards. The markers are
heuristics (`On … wrote:`, Outlook's header block, `>` lines); a message with none of them is
kept whole, because keeping too much only costs tokens while cutting too much loses evidence.

Add a missing one the same way as the others:

```sql
select vault.create_secret('sk-ant-…', 'PB_ANTHROPIC_API_KEY', 'pb-notes extractor');
-- rotate instead of re-adding:
-- select vault.update_secret((select id from vault.secrets where name = 'PB_ANTHROPIC_API_KEY'), 'sk-ant-…');
```

Never paste a key into a repo file. `pb_secret()` reads it; the service role is the only reader.

### Run it by hand

```bash
FN=https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1

# See what it WOULD do. Writes nothing, moves no watermark, but does spend model calls.
curl -sS -X POST "$FN/pb-notes" -H "Authorization: Bearer $PB_SYNC_TOKEN" \
  -H "Content-Type: application/json" --data '{"dry_run":true,"max_notes":10}'

# A real run, capped.
curl -sS -X POST "$FN/pb-notes" -H "Authorization: Bearer $PB_SYNC_TOKEN" \
  -H "Content-Type: application/json" --data '{"max_notes":50}'

# One channel only, and a longer self-imposed deadline.
curl -sS -X POST "$FN/pb-notes" -H "Authorization: Bearer $PB_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"sources":["fathom_call"],"max_notes":12,"budget_ms":150000,"concurrency":3}'

# Re-read EVERYTHING from the beginning (a new extractor version, say). Expensive: one model
# call per record with prose in it, across the whole roster. The watermark carries what one
# run cannot finish, so this is several runs, not one.
curl -sS -X POST "$FN/pb-notes" -H "Authorization: Bearer $PB_SYNC_TOKEN" \
  -H "Content-Type: application/json" --data '{"since":null,"max_notes":250}'
```

From this build container there is no route to `*.supabase.co`; call the function through
`pg_net` instead and read the reply out of `net._http_response`:

```sql
select net.http_post(
  url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                  where name = 'PB_SYNC_TOKEN' limit 1)),
  body    := jsonb_build_object('sources', jsonb_build_array('fathom_call'),
                                'max_notes', 8, 'budget_ms', 110000),
  timeout_milliseconds := 150000) as request_id;

-- a minute or two later, with the id that returned
select status_code, content from net._http_response where id = <request_id>;
```

### What bounds a run, and what happens at each edge

| Bound | What it does | What carries the rest |
|---|---|---|
| the watermark | a run reads only what changed since last time | — |
| `max_notes` (default 120) | caps records read in one run | the watermark |
| `budget_ms` (default 110 000) | **a self-imposed deadline**, reserving headroom for the next batch | the watermark |
| `concurrency` (default 3, max 6) | how many records are read at once | — |

**Concurrency is why the budget buys anything.** A record costs one model call — about fifty
seconds of waiting on a network round trip and almost no CPU — so reading one at a time spends
the budget on idling. Records are read in small concurrent batches and then processed strictly
in time order, one at a time. A batch never holds two records for the same account: that is
the one place sequence matters, because a record must see what an earlier record on the same
account already wrote. The batch closes at the first repeat rather than reaching past it, so
time order survives.

The deadline is the important one. The platform kills a long function without warning, and a
run killed mid-flight loses every model call it paid for and leaves `pb_runs` saying `running`
forever — which is exactly what happened on 11 Sep before this was added. So the sweep stops
*itself*, and it checks the clock **with the next batch's cost in hand**, not just the clock:
a run 109s into a 110s budget that starts a 50s batch finishes at 159s, which is the overrun
the budget existed to prevent. So the check reserves headroom — the slowest batch this run has
taken — and stops when starting another would cross the line. A little budget goes unused; the
watermark carries the rest, so that costs a night, never a record. When it stops it finishes
the run cleanly, sets `stopped_on_time`, and leaves the watermark where the last finished
record put it.

That works because **each record is written as it is read**, not accumulated to the end. The
order is: read → write facts and candidates → *then* advance the watermark. A record is never
marked read until its rows are in the database, and a failed write stops the run rather than
stepping over it.

The one exception is a record the model cannot be read from at all — a truncated or unparseable
reply. That failure is deterministic, so holding the watermark there would wedge the channel on
one bad record forever and nothing after it would ever be read. Instead the run **skips past
it**: `<source>.extractor_failed` goes up and the run's notes name the record and say
`SKIPPED — re-read it with since:null once the cause is fixed`. Re-reading is cheap to write
(the fingerprint refuses a duplicate) and costs one model call per record.

A re-run over the same text costs nothing to write — the fingerprint over
(record id · updated_at · extractor · key) already refuses it — but it does re-spend the model
call, so prefer the watermark over `since: null`.

### Read the result

```sql
-- where each channel got to
select source, last_seen_at, last_run_at, note from pb_source_watermarks
where source in ('fathom_call','pipedrive_note','email') order by source;

-- the last few runs, with the counters. Counters are prefixed by channel.
select started_at, finished_at, status, counts, errors
from pb_runs order by started_at desc limit 5;
```

**`errors` is the run's whole commentary, not just its failures.** A successful run fills it
with ordinary remarks — which quote was refused, which claim went to a person, where the budget
ran out. `status` and `counts.errors` are what say whether anything went wrong; the column is a
log, and a long one on a `success` row is the sweep explaining itself, not a problem.

The counters worth looking at:

| Counter | Means |
|---|---|
| `quote_verified` | claims whose sentence really was in the note — these can become facts |
| `quote_not_in_note` | **the model invented a sentence.** The claim was kept for review and can never be written. A rising count means the prompt or the model needs attention. |
| `observations` / `judgements` | how the run split what it read. A note full of judgements is a screening summary; one full of observations is a profile. |
| `queued_judgement` | the sentence was real but it was somebody's assessment, so a person decides. Not a fault — this is the system working. |
| `judgement_caught_by_lexicon` | the model called an opinion an observation and was overruled. A rising count means the prompt is drifting; a count near zero across many runs means the lexicon may be doing nothing and is worth re-reading. |
| `already_on_record` | a note restated what it had already told us; nothing written, nothing queued |
| `key_not_extractable`, `value_out_of_shape` | the model returned something outside the contract; dropped |
| `deferred_to_human` | a person already recorded that key and the note disagreed |
| `org_not_in_book` | a note on an organisation with no account — usually a roster gap, not an error |
| `extractor_failed` | the reply could not be read at all. **The record is skipped, not retried** — the run names it; re-read it with `since: null`. |
| `stopped_on_time` | the run hit `budget_ms` and ended itself. Not a failure: everything read was written, and the watermark carries the rest. |
| a run stuck in `running` | the function was killed before it could report. The next run closes it as `failed` with that reason — whatever it wrote is kept, and the watermark says how far it got. A rising count of these means `budget_ms` is set past what the caller's timeout allows. |
| `over_run_cap` | more records were waiting than `max_notes` allowed; the watermark carries them |

**A failed *write* stops the run where it stands** and the watermark does not pass the record,
so the next run reads it again — a partial write must not look complete. A failed *read* is the
other way round (see above): the record is skipped and named, because retrying it forever would
cost the whole channel.

### What a rater does with it

Signed in, the roster shows a count per account (`N waiting on a person`) and a filter for the
rows where a claim disagrees with what the book holds. On the account sheet, **Waiting on a
person** shows each claim with its verbatim sentence, the current value, and a link to the source.

Confirming calls `pb_review_fact_candidate`, which in one transaction writes the fact under the
reviewer's name **dated by the note**, closes every other open proposal for that key, and writes a
register row. Rejecting writes no fact and still writes the register row. Owner and rater lanes
only; a decision already made is not re-made.

```sql
-- the queue, oldest first
select a.name, c.key, c.value, c.current_value, c.conflicts, c.confidence, c.quote
from pb_fact_candidates c join pb_accounts a on a.id = c.account_id
where c.status = 'proposed' order by c.created_at;

-- how the readings are landing, per key — the standing measure of extractor quality
select key, extractor, status, count(*)
from pb_fact_candidates group by key, extractor, status order by key;
```

### Choosing the model, and comparing two

The reader is `PB_EXTRACTOR_MODEL` in Vault, defaulting to `claude-sonnet-5`. Change it without
a redeploy:

```sql
select vault.create_secret('claude-haiku-4-5', 'PB_EXTRACTOR_MODEL', 'pb-notes reader');
-- already set? update instead:
-- select vault.update_secret((select id from vault.secrets where name='PB_EXTRACTOR_MODEL'), 'claude-haiku-4-5');
```

**Why Sonnet is the default.** Every guard in this pipeline protects *precision*: the quote
check, the whitelist, the judgement rule and the review queue all stop a wrong fact from being
written. **Nothing protects recall.** A claim the reader fails to notice leaves no trace — no
counter moves, no queue row appears, and silence is indistinguishable from an honest "the note
does not say it". Noticing is the part worth paying for, and at this volume the difference
between readers is pennies a month.

**To compare two readers on the same corpus**, run one against the other with `model` in the
body. The extractor id is `<prompt version>+<model>`, and it is part of every fingerprint, so
the two readings do not collide — both sets of candidates sit side by side:

```bash
curl -sS -X POST "$FN/pb-notes" -H "Authorization: Bearer $PB_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"since":null,"max_notes":40,"model":"claude-haiku-4-5"}'
```

```sql
-- what each reader found, per key. Recall differences show up as missing rows, not wrong ones.
select extractor, key, count(*) as claims,
       count(*) filter (where quote is not null) as quote_backed
from pb_fact_candidates group by extractor, key order by key, extractor;

-- and what each wrote as fact
select entered_by as extractor, key, count(*)
from pb_facts where source in ('pipedrive_note','fathom_call','email')
group by entered_by, key order by key, extractor;
```

Read the *union* first: a key one reader found and the other did not is the finding. A reader
that produces fewer claims is not being careful — the guards already handle carefulness — it is
missing things.

### Changing what it reads

`EXTRACTABLE`, `JUDGEMENT_MARKERS` and `extractionPrompt()` live together in
`ingest/notes_sweep.ts` so the prompt can never ask for something the validator will not accept.
Change either and bump `PROMPT_VERSION` — it is half of the extractor id, so a new prompt
re-reads every record instead of silently mixing two readings (the model is the other half).

**Tuning the judgement lexicon.** A false positive costs one row in the review queue; a false
negative puts somebody's opinion in the book as evidence. Tune for the cheap mistake — when in
doubt, add the phrase. Check a candidate phrase against the real corpus before adding it:

```sql
-- how often a phrase appears in sentences we have already written as facts
select count(*) from pb_facts
where source = 'pipedrive_note' and note ilike '%<phrase>%';
```

If that returns rows, the phrase would have blocked facts you already accepted — look at them
before adding it. Change either and **bump
`EXTRACTOR_VERSION`** — it is part of every fingerprint, so a new version re-reads every note
instead of silently mixing two readings. Then `bash scripts/sync_shared.sh`, rebuild, redeploy.

## 20 · The Fathom back-fill

The webhook has only ever been told about meetings recorded since it was created on
12 September 2026. Everything before that sits in Fathom and nowhere else — and Fathom
is the only place the book holds a conversation rather than a CRM field.

### Why it runs inside Postgres

Two constraints, both load-bearing:

- **The API key never leaves Vault.** The build container has no route to
  `api.fathom.ai` in any case; Postgres does, through `pg_net`. So the crawl reads
  `PB_FATHOM_API_KEY` through `pb_secret()` and nobody — no log line, no checked-in
  file, no operator — ever handles it.
- **There is no second parser.** Each staged meeting is **replayed through the live
  `pb-fathom-webhook`** with a real Standard Webhooks signature. Domain attribution,
  `meeting_key` and the identity-candidate rules are therefore the production ones by
  construction, and every delivery is audited in `pb_webhook_inbox` like live traffic.
  A back-fill that parsed payloads its own way would be a second implementation of
  `ingest/fathom_webhook.ts`, free to drift from it silently.

### Running it

Three temporary `pg_cron` jobs do the whole wave. Schedule them, walk away, come back:

```sql
select cron.schedule('pb-fathom-crawl',    '10 seconds', $$select public.pb_fathom_crawl_step(50)$$);
select cron.schedule('pb-fathom-guard',    '20 seconds', $$select public.pb_fathom_crawl_guard()$$);
select cron.schedule('pb-fathom-backfill', '30 seconds', $$select public.pb_fathom_backfill_tick(60)$$);
```

Watch it:

```sql
select pages, done, misses, last_note,
       (select count(*) from pb_fathom_backfill) as staged,
       (select min(held_at) from pb_fathom_backfill)::date as oldest
from pb_fathom_crawl;

select status, count(*) from pb_fathom_backfill group by 1 order by 2 desc;
```

Take them down when `pb_fathom_backfill` holds no `pending` or `sent` row:

```sql
select cron.unschedule(jobname) from cron.job
where jobname in ('pb-fathom-crawl','pb-fathom-guard','pb-fathom-backfill');
```

`pb-fathom-crawl` unschedules itself through the guard; the other two do not.

### Two things that will bite

**Ten seconds, not five.** Fathom rate-limits at roughly ten requests a minute. At
five-second spacing the crawl spends the budget and collects 429s. It recovers — a
spent attempt clears the request and the next step re-fires the same cursor, so
nothing is skipped — but it wastes the run.

**pg_net dispatches on commit.** A transaction can never read its own HTTP response,
which is why the crawl is a stepper and not a loop. Waiting inside the transaction is
precisely what guarantees the response never arrives. If you drive it by hand, one
`select pb_fathom_crawl_step(50);` per statement, and the first call only fires — it
lands nothing.

### How far back

`pb_fathom_crawl_guard()` stops the crawl twelve months back. The rubric picks the
number: the longest signal lifespan in `core/rubric.prospect.v0.1.json` is 180 days
(`quote_lost`) and every other signal decays inside 90, so a meeting older than half a
year cannot contribute a live signal at all. Facts outlive signals — who decides, what
they spend, how big they are — so twelve months buys the facts a wide margin and still
terminates. Pass a date to widen it: `select pb_fathom_crawl_guard('2024-01-01')`.

### Afterwards

The replay writes `pb_calls` rows. A meeting whose external domain matches no account
lands with `account_id` null **and** an identity candidate — no account is ever created
by the back-fill, because identity never auto-merges (rule 8). Then:

1. Work the candidate queue (§12) — that is where a company you meet with but have
   never had a row for becomes an account.
2. Run `pb-notes` (§17), which reads the new summaries into facts.
3. Run `pb-score` (§9), which turns them into reads.

In that order. A note read after the score is a note that changes nothing until the
next night.

---

## 21 · Triaging unattributed call domains

`pb_calls` rows with no `account_id` accumulate an open identity candidate per external attendee.
The queue looks alarming — roughly 900 candidates across 180-odd domains as of 13 September — and
most of it is not work. `docs/DECISIONS.md` §15 measured it: 69% of the meeting volume is with
companies whose Client Journey card is in a partner stage, which PRO-10 excludes from this book.

Before proposing that any of those domains become accounts, triage them. The queue is only a
question about identity; whether the company belongs in the book at all is a roster question, and
the roster answers it first.

**Step 1 — regenerate the domain list.**

```sql
with c as (
  select lower(source_domain) dom, count(*) candidates
  from pb_identity_candidates
  where status='proposed' and source='fathom' and source_domain is not null
  group by 1),
m as (
  select unnest(external_domains) dom,
         count(distinct coalesce(meeting_key, fathom_recording_id)) meetings,
         max(held_at)::date last_met
  from pb_calls where account_id is null group by 1)
select c.dom, coalesce(m.meetings,0) meetings, m.last_met, c.candidates
from c left join m on m.dom = c.dom
where c.dom not in ('gmail.com','yahoo.com','hotmail.com','outlook.com',
                    'icloud.com','aol.com','me.com','comcast.net')
order by meetings desc nulls last;
```

**Step 2 — pull the three reference sets.** All read-only, all through the MCPs. None of this
lands in the repo; work in the session scratchpad.

| Set | Call | Notes |
|---|---|---|
| Orbit clients | `mcp__Orbit__list_clients` | ~600 rows, one call. `client_type` is sparse (about 1 in 6); match on `website_link` and `company_email` domains, fall back to name. |
| Pipedrive organisations | `mcp__Pipedrive__getOrganizations`, `limit: 500` | Page the `next_cursor`; ~2,300 rows over five calls. `website` is populated on about 70% of them. |
| Client Journey cards | `mcp__Pipedrive__getDeals`, `pipeline_id: 9`, `limit: 500` | Two pages, ~950 cards. Keep `org_id`, `stage_id`, `status`, `update_time`. |

Each of these overflows the tool-result limit and is written to a file instead; read them with
`jq`, never inline. Reduce to TSV first — id, name, website — and the matching is a few seconds of
Python.

**Step 3 — decide each domain by its card, not by its meeting count.** For every domain matching
a Pipedrive organisation, take the most recently updated **open** card and read `stage_id`:

| Stage ids | Stage | Verdict |
|---|---|---|
| 57, 58, 59, 70, 71, 66 | New, Schedule Sales Call, Sales Call Done, Quoting, Quote Lost, Unqualified/DNC | Prospect stage — belongs in the book. Absent means a genuine roster miss. |
| 63, 64, 65, 67 | Active, Inactive, Past, Lost Client | Agency Partner. PRO-10: never enters. Close the candidates. |
| 69 | Friends of WLIQ | Not a sales relationship. Not a prospect. |

Stage ids are stable but not guaranteed; confirm with `getStages` for `pipeline_id: 9` before a
run. The rule these implement is stated once, in `scripts/seed_README.md` — read it there rather
than trusting this table.

What is left after that — a prospect-stage card missing from the book, or a domain with real
meeting volume and no record in Pipedrive, Orbit or `pb_accounts` — is the actual queue, and it
is small. On 13 September it was five roster misses and one domain with double-digit meetings and
no CRM footprint at all.

**Two traps.**

A domain that matches an account whose `domain` column is blank is not a new company; it is an
attribution failure on an account that already exists. 103 accounts had no domain on 13
September. Check `pb_accounts` by name before proposing anything new.

An account with no `pipedrive_org_id` is **not** reliably a Notion-intake row: `pb_merge_accounts`
clears that column on the duplicate it retires, so every already-merged row looks like one too.
Filter on `book <> 'merged'` or the count comes back wildly high — on 13 September it read 23 open
duplicate pairs where five were open and eighteen had been merged in an earlier session (§15).

A live Notion-intake row may still duplicate a certified account under the same name. Resolving
one is a merge for a person, never an insert, and an exact name match is not on its own enough to
propose one: of the five open on 13 September, the names matched exactly in all five and the
domains agreed in none, and two turned out to be different companies that share a name. Settle
which it is from evidence about the companies — one client record carrying both domains, a site
publishing the other domain as its own contact address — before proposing anything.

Rule 8 governs the whole exercise: identity never auto-merges below high confidence, and neither
this procedure nor its result is permission to write an account row.

---

## 22 · The nightly roster re-read (`pb_roster_drift`)

The seed read the Client Journey once, on 9 September. §21's triage found five prospect-stage
organisations absent from the book and one account whose card had moved the other way, and none
of that was a seed defect — the roster is a live thing and the book had read it once. Migration
`20260913220000` re-reads it every night.

**What runs, and when.** Three cron jobs, all inside the database:

| Job | UTC | What it does |
|---|---|---|
| `pb-roster-begin` | 05:00 | `pb_roster_crawl_reset()` — clears `pb_roster_cards`, starts a crawl |
| `pb-roster-step` | 05:01–05:10 | `pb_roster_crawl_step()` — settles the last page, fires the next |
| `pb-roster-report` | 05:12 | `pb_roster_drift_refresh()` — recomputes `pb_roster_drift` |

It is a stepper for the same structural reason the Fathom crawl is one (§20): pg_net dispatches
only after the calling transaction commits, so no single transaction can read its own response.
About 950 cards is two pages at `limit=500`; the step returns immediately once `done`, so the
eight spare ticks cost nothing. The crawl runs in Postgres so `PB_PIPEDRIVE_API_TOKEN` never
leaves Vault — and because the build container has no route to `api.pipedrive.com` anyway.

**What it reports.** `pb_roster_drift`, one open row per direction per organisation:

- `missing` — the most recently updated **open** card is in a prospect stage (New, Schedule Sales
  Call, Sales Call Done, Quoting, Quote Lost, Unqualified/DNC) and no live `pb_accounts` row
  points at that organisation. Expect a steady trickle of Unqualified/DNC here; those belong in
  the `parked` book, not the prospect book, so they are the least urgent rows in the table.
- `departed` — a live account (`book in ('prospect','parked')`) whose card has moved to Active,
  Inactive, Past or Lost Client, or to Friends of WLIQ. PRO-10 says it is no longer this book's.

A row that stops drifting is marked `resolved` by the next refresh rather than deleted. Work the
queue by setting `status` to `actioned` or `dismissed` with a `reviewed_by` and a `note`; a
refresh leaves those alone.

```sql
select direction, stage_name, org_name, pipedrive_org_id, account_id
from pb_roster_drift where status = 'open'
order by direction, stage_name, org_name;
```

**It reports; it does not act, and that is deliberate.** Two rulings forbid it. PRO-18's
confirmation lane is still open, so nothing may promote an account out of the book because a card
moved. And the seed's PRO-10 cross-check runs against the Client Book's keys, which this
repository may never import — a row this function invented would skip that check. So the table is
to the roster what `pb_identity_candidates` is to identity: it proposes, a person decides.
Acting on a `missing` row means composing it through `scripts/seed.ts` and `pb-sync` like every
other account; acting on a `departed` row is a PRO-18 promotion in the owner lane.

**Running it by hand.**

```sql
select public.pb_roster_crawl_reset();
select * from public.pb_roster_crawl_step();   -- repeat until finished = true
select * from public.pb_roster_drift_refresh();
```

Each call must be its own transaction — that commit is what sends the request the previous call
queued. `pb_roster_drift_refresh()` refuses to run on an unfinished or empty crawl: half a
roster would read as half the book having departed.

**When it goes wrong.** `pb_roster_crawl.last_error` holds the reason and the step clears
`request_id` so the next tick re-fires the same cursor. A 429 arrives as a real
`net._http_response` row with a null body, which reads exactly like "still in flight" — the step
asks whether the row exists before trusting the body, which is the lesson that parked the Fathom
crawl at page 19. Each refresh writes a `pb_runs` row (`kind = 'ingest'`, `source =
'roster_drift'`) carrying the counts.

**Stage ids** are `pb_cj_stage_name()` and `pb_cj_stage_class()`. They are stable but not
guaranteed; confirm with `getStages` for `pipeline_id: 9` if the classes ever look wrong. The
rule they implement is stated once, in `scripts/seed_README.md`.

## 23 · Admitting a `missing` roster-drift row into the book

§22's queue proposes; this is how a person acts on a `missing` row. The rule it obeys is the one
§22 states and does not implement: **an account arrives through the composer or it does not
arrive.** A bare `insert into pb_accounts` produces a row with no facts, no signals and no
contacts — an account graded on nothing, which the page will happily print an anticipated tier
for. Worse, it skips the PRO-10 cross-check against the Client Book, which is the only thing
standing between this book and an Agency Partner.

`scripts/seed.ts --only-orgs` is that path. The whole composition still runs — the same PRO-10
cross-check, the same Notion attach rule, the same fact precedence — and only the named
organisations' rows are written out. Scoping is an output filter on purpose: attach decisions
depend on the whole set, so they are made against the whole set and only the emission is
narrowed.

**1 · Take the queue.**

```sql
select pipedrive_org_id, org_name, stage_name
from pb_roster_drift
where status = 'open' and direction = 'missing'
order by stage_name, org_name;
```

Decide which rows you are admitting. Unqualified/DNC rows land in the `parked` book; they are
still admissions, just low-priority ones. Save the ids you chose to the scratchpad as JSON — a
`pb_roster_drift` export works unchanged, `--only-orgs` reads `pipedrive_org_id` out of it.

**2 · Collect the pulls.** Exactly as `scripts/seed_README.md` describes — the same eleven input
files plus the reference pull. There is no shortcut here: the composer refuses to run without
them, and it is the completeness of the pulls that makes the admitted account a real account
rather than a name. Save `client_book_keys.json` into the `--out` directory first, including the
current `pb_accounts` rows, so ids stay stable and the next step can tell a new organisation
from one already in the book.

**3 · Compose.**

```bash
node --experimental-strip-types scripts/seed.ts \
  --in <pulls dir> --out <pulls dir>/admit --as-of <YYYY-MM-DD> \
  --uuid-seed admit-<date> --only-orgs @<pulls dir>/drift.json
```

The run stops rather than half-doing the job when an id does not resolve, and the message says
which it is:

- *"PRO-10: the cross-check reads it as an Agency Partner"* — the answer, not an error. Dismiss
  the drift row with that note; the card's stage and the Client Book disagree and PRO-10 wins.
- *"not in this run's composed roster"* — the pulls do not cover it, or its most recently updated
  open card is not in a prospect stage. Re-pull, or re-read the card.
- *"already in pb_accounts"* — `02`/`03`/`04`/`07` are plain inserts, so applying the run would
  duplicate that account's facts rather than update them. Drop the id. `--allow-existing` exists
  for the case where you have decided the duplicate rows are what you want; it is rarely that.

**4 · Read `admit/SUMMARY.md` before applying anything.** It is headed *Admission dry run* and
opens with the scope table: every organisation admitted, its key, its book, and whether it was
already a row. Check the account count is the number you meant to admit.

**5 · Apply**, one `execute_sql` call per file, in lexical order, each file once (§the seed
README's "Applying the SQL"). `01`, `05` and `06` are idempotent; the rest are plain inserts.

**6 · Score, then close the queue.**

```sql
-- after a manual pb-score run (§9)
update pb_roster_drift
   set status = 'actioned', reviewed_by = '<you>', reviewed_at = now(),
       note = 'admitted via scripts/seed.ts --only-orgs on <date>'
 where direction = 'missing' and pipedrive_org_id in (…);
```

The next refresh would mark them `resolved` on its own once the account exists, but saying who
admitted them and when is worth the one statement.

**What this does not do.** It does not touch a `departed` row — that is a PRO-18 promotion in the
owner lane, and PRO-18's confirmation lane is an open ruling. Nothing here decides cohort scoping
either: an organisation whose card sits in a partner stage is still refused, by PRO-10, exactly as
it was before.

## 24 · Confidence as a grade, and overriding it

The book prints two confidences today — one on the fit read, one on potential — each High /
Medium / Low. Rubric **0.1.1** adds a third thing they do not give you: one letter for the whole
read, A to F, on a scale nobody has to be taught.

**What the letter means.** It is about the INPUTS, never about the prospect. **F means the book
knows nothing about this account yet** — rule 5 printed rather than hidden — and says nothing
about whether the account is worth chasing. A busy, promising agency the book has never had a
real conversation with is an F, and that is the letter doing its job.

The bands are rubric data (`confidence_grade.rules`), walked top to bottom like the existing
confidence ladders:

| Grade | The rubric's band, in words |
|---|---|
| A | all four Dimension A facts present, ICP class on evidence, Pipedrive-certified row |
| B | three facts on an evidence class, or four on an inferred one |
| C | two facts and a class |
| D | one fact |
| F | otherwise |

Change the bands by editing the rubric, never the engine. A rubric that defines no
`confidence_grade` block produces **null**, not F.

**It is a draft.** 0.1.1 is `status: DRAFT` and v0.1.0 is byte-identical to what it was — its
pinned fingerprint still matches — so nothing in the live book has moved. Preview it the way
§9 previews any version:

```
?rubric=0.1.1&preview=1
```

Read the diff before activating. `pb_reads.confidence_grade` stays null until it is active.

**Overriding it.** A person moves the grade when they know something the book does not. It is
deliberately not a second mechanism — it signs the same contract the tier override signs:

- owner lane, and the approver is recorded;
- a reason code from the rubric's one list (`override.reason_codes`);
- a **written reason** — refused without one;
- an expiry, defaulting to `confidence_grade.override.expiry_default_days`;
- **one grade of movement**, and the engine refuses more rather than applying it.

Set it on the account page, *Set confidence override* (owner lane, signed in). That writes a
`pb_register` row of kind `override` whose payload names `confidence_grade` — which is exactly
what tells it apart from a tier override, since both live under the same kind:

```sql
select made_by, reason_code, text, payload, expires_at, created_at
from pb_register
where kind = 'override' and payload ? 'confidence_grade' and account_id = '<uuid>'
order by created_at desc;
```

Nothing changes on the spot. Rule 6 still holds: `pb_reads` is written by `pb-score` and by
nothing else, so the grade moves on the next run — or is refused there, loudly. A refusal lands
in the read's flags (`Confidence override refused: beyond cap`) and in the trace notes, never
silently.

**Reading the result.** `pb_reads.confidence_grade` is the letter after any override,
`computed_confidence_grade` is what the bands produced before it, and `confidence_overridden`
says whether a person moved it. The reason and the approver live on the register row, never on
the read — the read records what, the register records why.

```sql
select confidence_grade, computed_confidence_grade, count(*)
from (select distinct on (account_id) * from pb_reads order by account_id, run_at desc) l
group by 1, 2 order by 1, 2;
```
