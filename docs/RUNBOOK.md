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

**All four are deployed with `verify_jwt = false`.** None of the callers presents a Supabase
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
the four functions' TypeScript closure is too large for that, so `bash scripts/build_functions.sh`
bundles each into one ES module under `dist/functions/<fn>/index.js`; deploy that with
`entrypoint_path = index.js`. Two things to watch, both learned the hard way:

- The payload is JSON, so **every backslash in the bundle must be escaped in it**. A bundle's
  `\uXXXX` — the combining-mark class in `norm()`, for one — sent with a single backslash arrives
  decoded to the character it names. The function still behaves identically, but its deployed
  bytes no longer match the bundle, so the sha256 you recorded stops identifying what is running.
- Emitting ~24–66 KB verbatim is the failure-prone step. Verify the deploy, don't assume it.

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

`pb-fathom-webhook` is deployed and answering, but **the webhook itself could not be created
from a session**: the owner-account Fathom MCP's `create_webhook` returns
`Fathom API error 400: {"error":"Url can't be blank"}` on every call — it drops the destination
URL before Fathom's API sees it, whether the URL is passed as the schema's `destination_url` or
as an explicit `url` beside it. Nothing on this side can supply the field; it needs a fixed MCP,
or Fathom's own API or UI with a token. Parameters, wherever it is created:

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

Pipedrive is connected (9 Sep, ~17:15 UTC, through a new Pipedrive MCP; the old server is
gone). **Webhooks cannot be created through the MCP** — an operator creates them in the
Pipedrive UI, after `pb-pipedrive-webhook` is deployed (§3) and `PB_PIPEDRIVE_WEBHOOK_BASIC`
is in Vault (§1). No Pipedrive API token is involved.

1. Generate the Basic pair and store it as one Vault secret, `user:pass`
   (`select vault.create_secret('<user>:<pass>', 'PB_PIPEDRIVE_WEBHOOK_BASIC', …)`).
2. In Pipedrive: **Settings → Tools and apps → Webhooks → Create new webhook**. One webhook
   per entity, four in all, each with:
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
select started_at, status, counts
from pb_runs where kind = 'score' and triggered_by = 'pg_cron'
order by started_at desc limit 3;

-- anything not clean in the last week
select started_at, kind, source, status, errors
from pb_runs where status <> 'success' and started_at > now() - interval '7 days'
order by started_at desc;
```

`status` is `running` (never finished — investigate), `success`, `partial` (some rows
errored; see `errors`) or `failed`. The seed run's `counts.skipped` lists the organisations
and Notion rows dropped as "already an Agency Partner" by design (PRO-10).

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

---

## 9 · Previewing and activating rubric 0.2.0

`0.2.0` is registered in `pb_rubric_versions` as **draft**, spec sha256
`09d4e8cb36baa1d041968df3165b6e95aefe5a7a0e5ca3ba2538e08095c4f3d1`. **0.1.0 is still active and
nothing has been re-scored.** See `docs/DECISIONS.md` §8 for why ICP was retired as the fit read.

### 9.1 · pb-score must be redeployed first

The deployed `pb-score` predates the criteria path and would take the ICP branch, which 0.2.0
no longer carries — it would throw a `RubricError` naming
`dimension_b.base_tier_from_icp.map.<class>`. Rebuild and redeploy before previewing:

```bash
bash scripts/build_functions.sh          # → dist/functions/pb-score/index.js
```

Deploy that bundle with `entrypoint_path index.js` and `verify_jwt false`. **The bundle
contains 59 backslashes** (regex literals and one `—`); §3's escaping discipline applies —
send them escaped, and confirm with a GET, which must answer `{"ok":true,"service":"pb-score"}`.
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
