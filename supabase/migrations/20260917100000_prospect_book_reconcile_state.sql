-- prospect_book_reconcile_state
--
-- Everything scripts/reconcile.ts needs to compare what is DECLARED in the repository with what
-- is RUNNING in the database, as one jsonb, callable by anon over PostgREST rpc. On 17 Sep 2026
-- the rubric grading 829 accounts had no file, 33 applied migrations had no file, Fathom had never
-- delivered, and rule 9 had drifted for two days — and every check that read only the repo was
-- green. This function is the other half of that check (DECISIONS §29, §33, §34).
--
-- Aggregates, timestamps and identifiers only: the active rubric spec (already public-readable
-- under DECISIONS §5), migration NAMES, newest-row timestamps per source, and counts. Nothing
-- row-level, nothing from pb_contacts, no secret. `security definer` is what lets it read
-- pb_webhook_inbox and supabase_migrations, which anon may not; the grant below is the only door.
--
-- "External" delivery evidence deliberately excludes pg_net user agents: a row this database posted
-- to itself is not proof a source is alive — that is exactly how PHASE0 carried a false Pass for
-- five days.

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
  'live_accounts', (select count(*) from public.pb_accounts where book in ('prospect','parked'))
);
$$;

revoke all on function public.pb_reconcile_state() from public, anon, authenticated;
grant execute on function public.pb_reconcile_state() to anon, authenticated, service_role;

comment on function public.pb_reconcile_state() is
  'Declared-vs-running facts for scripts/reconcile.ts: active rubric, applied migration names, source liveness (external deliveries only), rule-9 mismatch count. Aggregates only; callable by anon (DECISIONS §34).';
