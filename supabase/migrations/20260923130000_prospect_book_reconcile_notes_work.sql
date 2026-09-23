-- prospect_book_reconcile_notes_work
--
-- pb_reconcile_state() learns to say whether the notes sweep DID any work, not only whether it
-- finished. On 22 and 23 Sep 2026 the Anthropic API credit ran out: every extractor call failed
-- (8 on each night), pb-notes wrote no fact and no candidate, and still recorded status 'success'
-- — because an unusable reply is counted, not raised. scripts/reconcile.ts's notes_run check asked
-- only for the newest finished run with status success/partial, so it stayed green, and nothing
-- else looked. The owner ruled (23 Sep): the monitoring must see a run that did no work.
--
-- One new top-level key, `notes_work`; every existing key is unchanged, byte for byte, so a
-- consumer of the old shape keeps working and an old reconcile.ts simply ignores the new one.
--
--   notes_work.latest       the newest FINISHED written_record run, of any status (a halted run
--                           is 'failed' or 'partial' after the 23 Sep pb-notes change, and must be
--                           visible here even though notes_run.newest_success_finished_at skips it):
--                           status, started_at, finished_at, and the numeric work counters —
--                           facts, candidates, wrote, errors, halted, and the SUMS of every
--                           `<channel>.extractor_failed`, `<channel>.extractor_halted`,
--                           `<channel>.pulled` and `<channel>.planned` key present in counts.
--                           A counter absent from counts is null, never a guessed zero.
--   notes_work.newest_productive_finished_at
--                           the newest finished run that wrote at least one fact or candidate.
--   notes_work.runs_since_productive / finished_runs_7d
--                           how many finished runs came after it / in the last seven days — so
--                           "nothing written for three days WHILE runs keep happening" can be told
--                           apart from "the sweep has stopped running" (notes_run's check).
--
-- Aggregates only. pb_runs.counts is read through jsonb_each filtered to NUMBER values, and
-- pb_runs.errors is not read at all: both can carry record labels (agency and person names), and
-- this function is callable by anon. status is pb-notes' own fixed vocabulary. The body is
-- otherwise the live definition read back with pg_get_functiondef on 23 Sep — same signature,
-- return type, language, volatility, security definer and search_path — and the grants below are
-- the ones the live function holds (anon + authenticated EXECUTE: CI calls it with the page's
-- publishable key, DECISIONS §34).

create or replace function public.pb_reconcile_state() returns jsonb
language sql stable security definer set search_path = public, supabase_migrations as
$$
with active as (
  select version, spec, activated_at
  from public.pb_rubric_versions where status = 'active'
  order by activated_at desc nulls last limit 1
),
rule9 as (
  select count(*) filter (where v.id <> r.id) as mismatches
  from public.pb_current_facts v
  join (
    select distinct on (account_id, key) id, account_id, key
    from public.pb_facts
    order by account_id, key,
      case evidence_label when 'evidence' then 0 when 'inferred' then 1 else 2 end,
      case source when 'rater' then 0 when 'fathom_call' then 1 when 'pipedrive_note' then 2
                  when 'website' then 3 when 'notion_master' then 4 when 'apollo' then 5
                  when 'pipedrive' then 6 else 7 end,
      created_at desc, observed_at desc nulls last
  ) r on r.account_id = v.account_id and r.key = v.key
),
notes_runs as (
  select id, status, started_at, finished_at,
         (case when jsonb_typeof(counts->'facts') = 'number' then (counts->>'facts')::numeric else 0 end)
       + (case when jsonb_typeof(counts->'candidates') = 'number' then (counts->>'candidates')::numeric else 0 end)
           as written
  from public.pb_runs
  where kind = 'ingest' and source = 'written_record' and finished_at is not null
),
notes_latest as (
  select r.id, r.status, r.started_at, r.finished_at, r.counts
  from public.pb_runs r
  join (select id from notes_runs order by finished_at desc limit 1) l on l.id = r.id
),
notes_num as (
  select e.key as k, (e.value #>> '{}')::numeric as n
  from notes_latest l, jsonb_each(coalesce(l.counts, '{}'::jsonb)) e
  where jsonb_typeof(e.value) = 'number'
),
notes_productive as (
  select max(finished_at) as at from notes_runs where written > 0
)
select jsonb_build_object(
  'generated_at', now(),
  'active_rubric', (select jsonb_build_object('version', version, 'activated_at', activated_at, 'spec', spec) from active),
  'reads_on_active', (select jsonb_build_object('accounts', count(*), 'fingerprints', coalesce(jsonb_agg(distinct cr.rubric_fingerprint), '[]'::jsonb))
                        from public.pb_current_reads cr, active a where cr.rubric_version = a.version),
  'applied_migrations', (select coalesce(jsonb_agg(name order by version), '[]'::jsonb)
                           from supabase_migrations.schema_migrations where name ilike 'prospect_book%'),
  'sources', jsonb_build_object(
    'fathom', jsonb_build_object(
      'newest_call_held_at', (select max(held_at) from public.pb_calls),
      'newest_external_verified_delivery_at', (select max(received_at) from public.pb_webhook_inbox
         where source = 'fathom' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%'),
      'external_verified_deliveries', (select count(*) from public.pb_webhook_inbox
         where source = 'fathom' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%')),
    'pipedrive', jsonb_build_object(
      'newest_external_verified_delivery_at', (select max(received_at) from public.pb_webhook_inbox
         where source = 'pipedrive' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%'),
      'external_verified_deliveries', (select count(*) from public.pb_webhook_inbox
         where source = 'pipedrive' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%')),
    'score_run', jsonb_build_object('newest_success_finished_at',
      (select max(finished_at) from public.pb_runs where kind = 'score' and status = 'success')),
    'notes_run', jsonb_build_object('newest_success_finished_at',
      (select max(finished_at) from public.pb_runs where kind = 'ingest' and source = 'written_record' and status in ('success','partial')))
  ),
  'rule9_mismatches', (select mismatches from rule9),
  'live_accounts', (select count(*) from public.pb_accounts where book in ('prospect','parked')),
  'notes_work', jsonb_build_object(
    'latest', (select jsonb_build_object(
        'status', l.status,
        'started_at', l.started_at,
        'finished_at', l.finished_at,
        'facts',            (select n from notes_num where k = 'facts'),
        'candidates',       (select n from notes_num where k = 'candidates'),
        'wrote',            (select n from notes_num where k = 'wrote'),
        'errors',           (select n from notes_num where k = 'errors'),
        'halted',           (select n from notes_num where k = 'halted'),
        'extractor_failed', (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.extractor_failed$'),
        'extractor_halted', (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.extractor_halted$'),
        'pulled',           (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.pulled$'),
        'planned',          (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.planned$'))
      from notes_latest l),
    'newest_productive_finished_at', (select at from notes_productive),
    'runs_since_productive', (select count(*) from notes_runs, notes_productive p
                                where p.at is null or notes_runs.finished_at > p.at),
    'finished_runs_7d', (select count(*) from notes_runs where finished_at > now() - interval '7 days'))
);
$$;

revoke all on function public.pb_reconcile_state() from public, anon, authenticated;
grant execute on function public.pb_reconcile_state() to anon, authenticated, service_role;

comment on function public.pb_reconcile_state() is
  'Declared-vs-running facts for scripts/reconcile.ts: active rubric, applied migration names, source liveness (external deliveries only), rule-9 mismatch count, and whether the latest notes run did any work (numeric counters only, never pb_runs.errors). Aggregates only; callable by anon (DECISIONS §34).';
