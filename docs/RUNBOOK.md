# Runbook — operating the Prospect Book

Operator steps, in the order a fresh deployment needs them. Everything here runs through
the Supabase MCP from a session (`execute_sql`, `apply_migration`, `deploy_edge_function`)
or the equivalent CLI command against project `sgagrmapuovnjwvgsxbp`. Placeholders are in
angle brackets. **Never paste a real secret into a file in this repository.**

Conventions: `<PROJECT_URL>` = `https://sgagrmapuovnjwvgsxbp.supabase.co`;
`<FN>` = `<PROJECT_URL>/functions/v1`.

---

## 1 · Set the Vault secrets

The edge functions and the cron read secrets through `pb_secret()` (service role only).
The MCP has no secrets-set tool, so the secrets go into Supabase Vault by SQL. Run each once
(`execute_sql` or the SQL editor). Generate tokens with something like `openssl rand -hex 32`.

```sql
-- Bearer token accepted by pb-sync and pb-score (and used by the pg_cron nightly job).
select vault.create_secret('<random 64-hex token>', 'PB_SYNC_TOKEN', 'Prospect Book sync/score bearer');

-- Fathom Standard-Webhooks signing secret (the whsec_… value Fathom returns when the webhook is created; see §4).
select vault.create_secret('<whsec_…>', 'PB_FATHOM_WEBHOOK_SECRET', 'Fathom webhook signing secret');

-- HTTP Basic credential the Pipedrive webhook must present, as user:pass.
select vault.create_secret('<user>:<pass>', 'PB_PIPEDRIVE_WEBHOOK_BASIC', 'Pipedrive webhook HTTP Basic user:pass');

-- Pipedrive API token for field-map loading and later back-fill (PRO-6 blocker until a working one exists).
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

`pb-sync` and `pb-score` refuse every request while `PB_SYNC_TOKEN` is unset.

## 2 · Apply the migrations

In order, one `apply_migration` call per file (name = the filename stem, query = the file
content), or `supabase db push --project-ref sgagrmapuovnjwvgsxbp`:

1. `supabase/migrations/20260909120000_prospect_book_schema.sql` — the `pb_*` tables, RLS, views, `pb_secret()`.
2. `supabase/migrations/20260909120100_prospect_book_cron.sql` — `pg_cron` + `pg_net`, the nightly `pb-nightly-score` job at 06:15 UTC.

Both are idempotent. Check afterwards:

```sql
select tablename from pg_tables where schemaname = 'public' and tablename like 'pb\_%' order by 1;
select jobname, schedule, active from cron.job where jobname = 'pb-nightly-score';
```

Then load the rubric as the active version (the engine reads the spec from this row):

```sql
insert into pb_rubric_versions (version, status, spec, spec_sha256, activated_by, activated_at)
values ('0.1.0', 'active', '<contents of core/rubric.prospect.v0.1.json>'::jsonb,
        '<sha256 of the file>', '<owner email>', now())
on conflict (version) do update set spec = excluded.spec, spec_sha256 = excluded.spec_sha256;
```

(`sha256sum core/rubric.prospect.v0.1.json` gives the hash.)

## 3 · Deploy the edge functions

One `deploy_edge_function` call per function with `project_id = sgagrmapuovnjwvgsxbp`,
`name`, `entrypoint_path = index.ts`, and `files` = the function's `index.ts` plus every
file under `supabase/functions/_shared/` it imports (Supabase deploys a function's own files
only). CLI equivalent:

| Function | verify_jwt | Why |
|---|---|---|
| `pb-sync` | true | called with the service bearer from a session |
| `pb-score` | true | called with the service bearer by a session or pg_cron |
| `pb-fathom-webhook` | **false** | Fathom signs with Standard Webhooks, not a Supabase JWT |
| `pb-pipedrive-webhook` | **false** | Pipedrive authenticates with HTTP Basic |

```bash
supabase functions deploy pb-sync              --project-ref sgagrmapuovnjwvgsxbp
supabase functions deploy pb-score             --project-ref sgagrmapuovnjwvgsxbp
supabase functions deploy pb-fathom-webhook    --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-pipedrive-webhook --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
```

Redeploy any function whose `_shared/` copy of a `core/` or `ingest/` module changed.

## 4 · Register the Fathom webhook

Done through the owner-account Fathom MCP (the account whose recordings are shared with the team) (`create_webhook`) once `pb-fathom-webhook`
is deployed. Parameters:

- `url`: `<FN>/pb-fathom-webhook`
- `include_transcript: true`, `include_summary: true`, `include_action_items: true`,
  `include_crm_matches: true` — all four
- `triggered_for`: `["my_recordings", "shared_team_recordings"]`

The response carries the signing secret (`whsec_…`). Put it into Vault as
`PB_FATHOM_WEBHOOK_SECRET` (§1) **before** the first call lands, or every delivery is stored
in `pb_webhook_inbox` with `verified = false` and never becomes a call. Deliveries arriving
before the secret is set are replayable: nothing is discarded.

Check a delivery arrived and verified:

```sql
select received_at, verified, processed_at, error
from pb_webhook_inbox where source = 'fathom' order by received_at desc limit 5;
```

## 5 · Register the Pipedrive webhook (blocked on PRO-6 token)

In Pipedrive: Settings → Tools and apps → Webhooks → create for entity `deal` and
`organization` (and `person` if wanted), event `*`, version 2.0, URL
`<FN>/pb-pipedrive-webhook`, HTTP Basic auth with the `<user>` / `<pass>` you stored in
`PB_PIPEDRIVE_WEBHOOK_BASIC`. Cannot be exercised until the Pipedrive token works.

## 6 · Enable GitHub Pages and publish the page

1. Repo → Settings → Pages → Build and deployment → Source → **GitHub Actions**. Once.
2. Actions → "Deploy Prospect Book page" → Run workflow. It uploads `web/` and nothing else.
3. Note the Pages URL the run prints (`https://<org>.github.io/prospect-grading/`).

## 7 · Add the Pages URL to Supabase Auth

Supabase dashboard → Authentication → URL Configuration:

- **Site URL**: the Pages URL.
- **Redirect URLs**: add the Pages URL (and `https://<org>.github.io/prospect-grading/**`).

Without this the magic link cannot return to the page. Email sign-in (OTP) must be enabled
under Authentication → Providers → Email.

## 8 · Insert `pb_members` rows

Reading needs no row (any signed-in `@whitelabeliq.com` address reads, PRO-7). Writing
does. Lanes per PRO-5: `owner` (overrides, promotions, decisions), `rater` (facts, hand
signals, merge-queue review), `viewer` (no writes).

```sql
insert into pb_members (email, display_name, role) values
  ('<owner>@whitelabeliq.com',  'Owner',        'owner'),
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
06:15 UTC; decay is inside scoring, so one job covers both.

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

## 11 · Add a fact by SQL in an emergency

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
owner enters a fact on a rater's behalf (PRO-5). The fact takes effect at the next score run (§9).

## 12 · Read `pb_runs`

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
errored; see `errors`) or `failed`. A seed run lists "already an Agency Partner — stale
prospect row" entries in `errors` by design (PRO-10).

## 13 · Quick health checks

```sql
select count(*) filter (where book = 'prospect')  as prospects,
       count(*) filter (where book = 'parked')    as parked,
       count(*) filter (where roster_certified)   as certified
from pb_accounts;

select status, count(*) from pb_identity_candidates group by 1;      -- the merge queue
select effective_tier, count(*) from pb_current_reads group by 1;    -- tier spread
```
