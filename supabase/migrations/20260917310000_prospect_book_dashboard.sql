-- The front dashboard needs four things the board does not: how deep the review queue is and why,
-- whether the machinery actually ran, what the active rubric is, and what MOVED on the last run.
--
-- The last one is the point. The owner's standing complaint is that the screens change under him
-- (DECISIONS §46). pb_movement has counted tier moves per run since 13 Sep and nothing has ever
-- shown them, so a tier could change overnight and the only way to notice was to have remembered
-- where it was. A number on the front page is not the whole answer — naming WHICH accounts moved
-- is the rest of it, and that is still open — but it is the difference between a silent change
-- and a visible one.
--
-- SECURITY DEFINER for the same reason as pb_board() and pb_dossier() (§41): pb_fact_candidates
-- is closed to anon and stays closed. This returns COUNTS of it, grouped by the reason each claim
-- is waiting, and never a claim.
create or replace function public.pb_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(

    -- What is waiting on a person, grouped by WHY, in the same words the reviewer screen uses.
    'queue', (
      select jsonb_build_object(
        'total', count(*),
        'confirmable_together', count(*) filter (
          where c.confidence = 'high' and c.quote is not null and btrim(c.quote) <> '' and f.key is null),
        'by_reason', coalesce(jsonb_object_agg(reason, n), '{}'::jsonb))
      from (
        select case
                 when c.confidence <> 'high' then 'the extractor itself said ' || c.confidence
                 when c.quote is null or btrim(c.quote) = '' then 'no quote in the source'
                 when f.key is not null and f.value is distinct from c.value then 'disagrees with what is on file'
                 when f.key is not null then 'already on record'
                 else 'clear — can be confirmed together'
               end as reason,
               count(*) as n
          from pb_fact_candidates c
          left join pb_current_facts f on f.account_id = c.account_id and f.key = c.key
         where c.status = 'proposed'
         group by 1
      ) g
      full join lateral (select 1) _ on true
      -- the aggregate above needs the raw rows too, so re-derive the two scalars from them
      cross join lateral (select 1) __
      , lateral (select 0) ___
      , pb_fact_candidates c
      left join pb_current_facts f on f.account_id = c.account_id and f.key = c.key
      where c.status = 'proposed'),

    'rubric', (
      select jsonb_build_object(
        'version', v.version, 'activated_at', v.activated_at,
        'fingerprint', (select r.rubric_fingerprint from pb_current_reads r
                         where r.rubric_version = v.version limit 1),
        'accounts_scored', (select count(*) from pb_current_reads r where r.rubric_version = v.version))
      from pb_rubric_versions v where v.status = 'active'
      order by v.created_at desc limit 1),

    'runs', coalesce((
      select jsonb_object_agg(source, jsonb_build_object(
        'finished_at', finished_at, 'status', status, 'counts', counts))
      from (
        select distinct on (source) source, finished_at, status, counts
          from pb_runs
         where source in ('pb-score', 'pb-notes', 'pb-sync')
         order by source, finished_at desc nulls last
      ) x), '{}'::jsonb),

    'movement', (
      select jsonb_build_object(
        'run_at', m.run_at, 'accounts', m.accounts,
        'tier_moved', m.tier_moved, 'promoted', m.promoted, 'demoted', m.demoted,
        'urgency_moved', m.urgency_moved, 'facts_changed', m.facts_changed,
        'newly_ranked', m.newly_ranked, 'newly_unclassified', m.newly_unclassified)
      from pb_movement m order by m.run_at desc limit 1),

    'overrides', (
      select jsonb_build_object(
        'live', count(*) filter (where expires_at is null or expires_at > now()),
        'expiring_30d', count(*) filter (where expires_at is not null
                                           and expires_at > now() and expires_at < now() + interval '30 days'))
      from pb_register where kind = 'override')
  );
$$;

revoke all on function public.pb_dashboard() from public;
grant execute on function public.pb_dashboard() to anon, authenticated, service_role;

comment on function public.pb_dashboard() is
  'Everything the front dashboard needs that the board does not already carry: the review queue '
  'grouped by WHY each claim waits, the active rubric and its fingerprint, the last run of each '
  'job, what moved on the last scoring run, and how many overrides are live or about to lapse. '
  'SECURITY DEFINER because pb_fact_candidates is closed to anon and stays closed — this returns '
  'counts, never a claim. web/CONTRACT.json names the sections it feeds.';
