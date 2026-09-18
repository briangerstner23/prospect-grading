-- The front page was describing a queue that no longer exists.
--
-- pb_dashboard's queue block was written before §50 and §52 and carried its OWN copy of the
-- "is this clear?" test: high confidence, a quote, nothing on file. That test is now one of four
-- lanes, it is no longer the only way a claim qualifies, and it knows nothing about the 373 claims
-- the audit refused. So dashboard.html and method.html — two of the four pages the owner actually
-- reads — were showing a `confirmable_together` count derived from a rule the book had stopped
-- using, beside a `by_reason` histogram that could not mention the commonest reason of all.
--
-- That is the drift this repository keeps re-learning: a second implementation of a rule is a
-- second rule. pb_fact_candidate_lanes IS the rule, so the dashboard now reads it and restates
-- nothing.
--
-- `confirmable_together` is kept, as an alias for what the book will actually take, because two
-- published pages read that key by name and a rename would blank a number rather than correct it.
-- Its MEANING has changed, so the pages that render it have had their captions changed with it —
-- a number whose label is stale is worse than no number.

create or replace function public.pb_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with lanes as (
    select lane, reason_code, why, lane_enabled, support from pb_fact_candidate_lanes
  ),
  byreason as (
    -- Grouped on the REASON CODE, not the sentence: the sentence names the account's key and would
    -- shatter the histogram into one bar per claim.
    select case reason_code
             when 'no_quote'             then 'no quote in the source'
             when 'unsupported_sentence' then 'audited: the sentence does not say it'
             when 'disagrees_with_book'  then 'disagrees with what is on file'
             when 'corroborates_book'    then 'already on record — nothing to write'
             when 'records_disagree'     then 'the records disagree with each other'
             when 'judgement'            then 'the sentence is an assessment'
             when 'unchecked_reader'     then 'rated high by a reader nobody has checked'
             when 'high_quote_open_key'  then 'clear — the book will take it'
             when 'corroborated_records' then 'clear — corroborated across sources'
             when 'medium_observation'   then 'medium, but called an observation'
             else 'the extractor was unsure and nothing corroborates it'
           end as reason,
           count(*) as n
      from lanes group by 1
  )
  select jsonb_build_object(

    'queue', jsonb_build_object(
      'total',            (select count(*) from lanes),
      -- What the book will take on its own, at the next 06:00 run. This is the number that used to
      -- be computed here from a private copy of §45's gate.
      'automatic',        (select count(*) from lanes where lane_enabled and lane <> 'needs_a_person'),
      'confirmable_together',
                          (select count(*) from lanes where lane_enabled and lane <> 'needs_a_person'),
      'needs_a_person',   (select count(*) from lanes where lane = 'needs_a_person'),
      -- Sitting in a lane the owner has NOT switched on: a decision waiting, not a backlog.
      'lane_off',         (select count(*) from lanes where lane <> 'needs_a_person' and not lane_enabled),
      'by_reason',        coalesce((select jsonb_object_agg(reason, n) from byreason), '{}'::jsonb),
      'audited', jsonb_build_object(
        'states',      (select count(*) from lanes where support = 'states'),
        'implies',     (select count(*) from lanes where support = 'implies'),
        'unsupported', (select count(*) from pb_fact_candidates
                         where status = 'proposed' and support = 'unsupported'),
        'unaudited',   (select count(*) from lanes where support is null))),

    -- What the book has already taken without a person, and whether it can still be taken back.
    'autoconfirm', (
      select jsonb_build_object(
        'facts_live',  (select count(*) from pb_autoconfirm_log
                         where undone_at is null and action = 'confirmed'),
        'closed',      (select count(*) from pb_autoconfirm_log
                         where undone_at is null and action = 'closed'),
        'batches',     (select count(distinct batch_id) from pb_autoconfirm_log where undone_at is null),
        'last_run_at', (select max(ran_at) from pb_autoconfirm_log where undone_at is null),
        'lanes', coalesce((select jsonb_object_agg(lane, enabled)
                             from pb_fact_autoconfirm_policy), '{}'::jsonb))),

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
         where source in ('pb-score', 'pb-notes', 'pb-sync', 'verify_support')
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

comment on function public.pb_dashboard() is
  'The front page, read live. Its queue block reads pb_fact_candidate_lanes rather than carrying a '
  'second copy of the lane rules — a second implementation of a rule is a second rule, and this '
  'one had already drifted past §50 and §52. Returns counts only, never a claim, which is why it '
  'is SECURITY DEFINER over a table that stays closed to anon. confirmable_together is retained as '
  'an alias of `automatic` because two published pages read it by name. DECISIONS §50, §52.';
