-- WLIQ Prospect Book — turning a logged read into a reviewable proposal.
--
-- `pb_account_reads` (20260916090000) holds every structured read WHOLE: each field with the
-- verbatim quote behind it and the checker's verdict beside it. That is the record and it is kept
-- complete. This is the other half — the part a person can actually work.
--
-- The distinction is the point. Logging everything and queueing everything are different jobs.
-- 431 fact candidates were already unreviewed before today; proposing all ~1,600 field-values from
-- 146 reads would bury the queue and nothing would get decided. So:
--
--   the RECORD is complete   — pb_account_reads, nothing filtered, nothing lost
--   the QUEUE is selective   — only a value that would CHANGE what the engine believes
--
-- A read whose value already matches what is on file is still logged; it just does not ask for
-- anyone's attention. Confirmation of what we already knew is not free information, but it is not
-- a decision either.
--
-- Rule 8 is untouched: this writes to pb_fact_candidates, never pb_facts. A machine read a page,
-- it proposes with its quote, a person decides. Rule 5 too: a null is never proposed, because
-- unknown is not evidence of anything.
--
-- Source precedence (DECISIONS §22) is what makes this worth doing. `website` outranks `apollo`
-- and `pipedrive`, so a confirmed team-page headcount immediately beats an inflated LinkedIn-
-- derived one — a counted 35 rather than Apollo's 68, a counted 10 rather than 30.
--
-- Idempotent: `fingerprint` is unique per (account, key, value, source), so re-running proposes
-- nothing twice.

/**
 * Derive fact candidates from logged reads.
 *
 * `p_since` limits to reads logged at or after a timestamp; null means all live reads.
 * Returns the number of candidates inserted.
 */
create or replace function public.pb_candidates_from_reads(p_since timestamptz default null)
returns int
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inserted int := 0;
begin
  with mapping(field_key, fact_key) as (
    values
      ('is_agency',            'is_agency'),
      ('agency_type',          'agency_type'),
      ('headcount_named',      'headcount'),
      ('delivery_headcount',   'delivery_headcount'),
      ('sells_build_work',     'sells_build_work'),
      ('build_capacity_gap',   'build_demand_exceeds_capacity'),
      ('recurring_work_shape', 'recurring_work_shape'),
      ('client_budget_size',   'client_budget_size'),
      ('white_label_signal',   'wl_signal'),
      ('founded_year',         'years_operating')
  ),
  candidate as (
    select r.id            as read_id,
           r.account_id,
           m.fact_key      as key,
           r.fields -> m.field_key -> 'value'  as value,
           r.fields -> m.field_key ->> 'quote' as quote,
           r.reader,
           r.read_at,
           r.confidence,
           -- What the book believes right now, so a reviewer sees both without a second query.
           (select f.value from public.pb_current_facts f
             where f.account_id = r.account_id and f.key = m.fact_key) as current_value
      from public.pb_account_reads r
      cross join mapping m
     where r.superseded_at is null
       and (p_since is null or r.read_at >= p_since)
       -- The field was read, survived the checker, and carries its quote.
       and r.fields ? m.field_key
       and jsonb_typeof(r.fields -> m.field_key -> 'value') is distinct from 'null'
       and r.fields -> m.field_key -> 'value' is not null
       and (r.fields -> m.field_key ->> 'dropped') is null
       and coalesce(r.fields -> m.field_key ->> 'quote', '') <> ''
  ),
  worth_asking as (
    -- Only what would change an answer: a value that differs from what is on file, or one that
    -- fills a gap the engine is currently defaulting through.
    select * from candidate c
     where c.current_value is null
        or c.current_value is distinct from c.value
  ),
  ins as (
    insert into public.pb_fact_candidates
      (account_id, key, value, evidence_label, source, source_id, quote, observed_at,
       confidence, extractor, fingerprint, current_value, conflicts, status, note)
    select w.account_id,
           w.key,
           w.value,
           'inferred',                       -- a machine read a public page; never 'evidence'
           'website',
           w.read_id::text,
           left(w.quote, 2000),
           w.read_at::date,
           coalesce(w.confidence, 'medium'),
           w.reader,
           encode(sha256(convert_to(
             w.account_id::text || '|' || w.key || '|' ||
             coalesce(w.value::text, 'null') || '|website', 'UTF8')), 'hex'),
           w.current_value,
           (w.current_value is not null and w.current_value is distinct from w.value),
           'proposed',
           case when w.current_value is null
                then 'Read off the agency''s own site; nothing on file for this key.'
                else 'Read off the agency''s own site; disagrees with what is on file ('
                     || w.current_value::text || ').' end
      from worth_asking w
    on conflict (fingerprint) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return v_inserted;
end $function$;

revoke all on function public.pb_candidates_from_reads(timestamptz) from public, anon, authenticated;

comment on function public.pb_candidates_from_reads(timestamptz) is
  'Propose fact candidates from logged reads: quoted, non-null, checker-approved values that differ from what is on file. Idempotent. Never writes pb_facts (rule 8).';
