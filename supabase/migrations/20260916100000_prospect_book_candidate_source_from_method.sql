-- WLIQ Prospect Book — a candidate's source is where the sentence came from, not where the read ran.
--
-- 20260916090100 stamped every candidate `source = 'website'`, because the pass that produced the
-- reads was a site crawl. That is true of the pass and false of thirteen of the values.
--
-- The reads carry the distinction themselves. A `headcount_named` field records how it was got:
--
--   named_people_on_team_page   52   faces counted on the agency's own /team page
--   stated_number               10   a number written on the agency's own site ("we are 40")
--   call_stated                 13   a founder said it to us, on a recorded WLIQ call
--
-- Under rule 9 the source is not a label, it is precedence: `fathom_call` outranks `website`,
-- which outranks `apollo` and `pipedrive`. Filing a founder's own number under `website` puts it
-- one rank below where it belongs, and when two inferred facts disagree the wrong one wins. That
-- is the same class of bug as DECISIONS §22 — the tiebreak deciding a tier — so it is worth the
-- migration rather than a note.
--
-- What does NOT change: `evidence_label` stays `inferred` for every row this function proposes.
-- A model read the sentence. A founder stating a headcount on a call is stronger testimony than a
-- team page, and a reviewer may well promote it to `evidence` when they confirm it — but the model
-- does not get to make that call about its own reading. Rule 8's shape is unchanged: it proposes
-- with its quote, a person decides.

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
           -- Where the sentence came from, field by field. Only headcount_named carries a method
           -- today; every other field is read off the page, so the default is the page.
           case r.fields -> m.field_key ->> 'method'
             when 'call_stated' then 'fathom_call'
             else 'website'
           end             as source,
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
           'inferred',                       -- a model read a sentence; never 'evidence'
           w.source,
           w.read_id::text,
           left(w.quote, 2000),
           w.read_at::date,
           coalesce(w.confidence, 'medium'),
           w.reader,
           encode(sha256(convert_to(
             w.account_id::text || '|' || w.key || '|' ||
             coalesce(w.value::text, 'null') || '|' || w.source, 'UTF8')), 'hex'),
           w.current_value,
           (w.current_value is not null and w.current_value is distinct from w.value),
           'proposed',
           (case when w.source = 'fathom_call'
                 then 'Stated by the agency on a recorded WLIQ call'
                 else 'Read off the agency''s own site' end)
           || (case when w.current_value is null
                    then '; nothing on file for this key.'
                    else '; disagrees with what is on file (' || w.current_value::text || ').'
               end)
      from worth_asking w
    on conflict (fingerprint) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return v_inserted;
end $function$;

revoke all on function public.pb_candidates_from_reads(timestamptz) from public, anon, authenticated;

comment on function public.pb_candidates_from_reads(timestamptz) is
  'Propose fact candidates from logged reads: quoted, non-null, checker-approved values that differ from what is on file. Source follows the field''s own method (call_stated -> fathom_call, else website), which is what rule 9 breaks ties on. Idempotent. Never writes pb_facts (rule 8).';
