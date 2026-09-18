-- The source gate — added the same day, before a single row was approved, because the spot check
-- said it had to be.
--
-- The lanes went in believing the extractor's own `confidence`. Twelve rows from each writing lane
-- were then read by hand against their quotes, and the website reader failed badly. Four of ten
-- sampled `high_quote_open_key` claims were inferences wearing a quote:
--
--   delivery_headcount = 0        from a team page that happened to list one person
--   sells_build_work = false      from a sentence about being a "strategic partner for growth"
--   client_budget_size = buys_real_projects  from a case-study headline naming the CLIENT's
--                                 pipeline, not the agency's budget
--   wl_signal = Low               from a sentence about staff certifications
--
-- Each is a verbatim sentence really on the page, so rule 8's receipt is satisfied and every gate
-- the book had still passed it. What the receipt proves is provenance, not that the sentence says
-- what the extractor decided it says — the exact failure written_record.ts rule 3 exists to catch,
-- and rule 3 could not catch it because the site reader emits no `kind` at all.
--
-- 191 of the 193 claims in that lane were website reads. So the lane was not admitting §45's class;
-- it was admitting one unvalidated extractor's self-rating, 191 times.
--
-- The gate is therefore per SOURCE, not per confidence: a lane names the readers whose rating has
-- been checked against their own quotes. Today that is the two channels where a PERSON wrote the
-- sentence — a call summary and a CRM note — and the website reader is not among them. It is not
-- shut out: a website claim still reaches a lane by being CORROBORATED, which is now raised to two
-- distinct source SYSTEMS, since two pages of one site are one witness and were corroborating each
-- other 97 times.
--
-- This narrows §45's manual button not at all; that button is a person's decision and stays theirs.
-- It narrows what the book does on its own, which is the only thing that runs unattended.

alter table public.pb_fact_autoconfirm_policy
  add column if not exists sources text[];

comment on column public.pb_fact_autoconfirm_policy.sources is
  'Which readers this lane trusts on their own say-so. Null means any. A reader belongs here once '
  'its confidence rating has been checked by hand against its own quotes — not before.';

update public.pb_fact_autoconfirm_policy
   set sources = array['fathom_call', 'pipedrive_note'],
       what = 'The extractor rated it high, a verbatim quote is attached, and the book holds nothing for that key — §45''s own gate, pressed by the book instead of by hand, and only for the readers whose rating has been checked.',
       updated_at = now(), updated_by = 'spot check, 18 Sep 2026'
 where lane = 'high_quote_open_key';

update public.pb_fact_autoconfirm_policy
   set min_source_systems = 2,
       what = 'Two or more separate records in two or more separate SYSTEMS say the same thing, each with its own quote, and nothing anywhere says otherwise. Two pages of one website are one witness.',
       updated_at = now(), updated_by = 'spot check, 18 Sep 2026'
 where lane = 'corroborated_records';

update public.pb_fact_autoconfirm_policy
   set sources = array['fathom_call', 'pipedrive_note'],
       updated_at = now(), updated_by = 'spot check, 18 Sep 2026'
 where lane = 'medium_observation';

create or replace view public.pb_fact_candidate_lanes
with (security_invoker = true) as
with p as (
  select c.id, c.account_id, c.key, c.value, c.quote, c.confidence, c.kind,
         c.source, c.source_id, c.observed_at, c.extractor, c.created_at,
         f.value as held_value, f.source as held_source,
         (f.key is not null) as book_holds
    from public.pb_fact_candidates c
    left join public.pb_current_facts f
      on f.account_id = c.account_id and f.key = c.key
   where c.status = 'proposed'
),
-- Corroboration counts RECORDS, not rows: two extractors reading the same note are one witness.
-- Only quote-backed rows may corroborate — an unevidenced claim does not gain evidence by repetition.
agree as (
  select account_id, key, value,
         count(distinct coalesce(source_id, id::text)) as records,
         count(distinct source)                        as systems
    from p
   where quote is not null and btrim(quote) <> ''
   group by 1, 2, 3
),
-- Do the notes disagree with each OTHER? If so nothing here is automatic, whatever each row says.
spread as (
  select account_id, key, count(distinct value) as values_proposed
    from p group by 1, 2
),
pol as (
  select
    coalesce((select min_source_records from public.pb_fact_autoconfirm_policy where lane = 'corroborated_records'), 2) as min_recs,
    coalesce((select min_source_systems from public.pb_fact_autoconfirm_policy where lane = 'corroborated_records'), 2) as min_sys,
    (select sources from public.pb_fact_autoconfirm_policy where lane = 'high_quote_open_key')    as high_sources,
    (select sources from public.pb_fact_autoconfirm_policy where lane = 'medium_observation')     as med_sources
),
-- One CASE, one reason code. The lane and the sentence a reader sees are both derived from it,
-- so the words on the screen can never drift from the test that put the row there.
--
-- Corroboration is tested BEFORE confidence on purpose: two systems agreeing is evidence about the
-- world, and one extractor's self-rating is evidence about the extractor.
codes as (
  select p.*, coalesce(a.records, 1) as records, coalesce(a.systems, 1) as systems,
         s.values_proposed,
         case
           when p.quote is null or btrim(p.quote) = ''                     then 'no_quote'
           when p.book_holds and p.held_value is not distinct from p.value  then 'corroborates_book'
           when p.book_holds                                               then 'disagrees_with_book'
           when s.values_proposed > 1                                      then 'records_disagree'
           when p.kind = 'judgement'                                       then 'judgement'
           when coalesce(a.records, 1) >= pol.min_recs
            and coalesce(a.systems, 1) >= pol.min_sys                      then 'corroborated_records'
           when p.confidence = 'high'
            and (pol.high_sources is null or p.source = any(pol.high_sources))
                                                                           then 'high_quote_open_key'
           when p.confidence = 'high'                                      then 'unchecked_reader'
           when p.confidence = 'medium' and p.kind = 'observation'
            and (pol.med_sources is null or p.source = any(pol.med_sources))
                                                                           then 'medium_observation'
           else 'unsupported'
         end as reason_code
    from p
    cross join pol
    join spread s on s.account_id = p.account_id and s.key = p.key
    left join agree a
      on a.account_id = p.account_id and a.key = p.key and a.value = p.value
)
select
  c.id, c.account_id, c.key, c.value, c.quote, c.confidence, c.kind, c.source, c.source_id,
  c.observed_at, c.extractor, c.created_at, c.held_value, c.held_source, c.book_holds,
  c.records as agreeing_records, c.systems as agreeing_systems, c.values_proposed,
  c.reason_code,
  case c.reason_code
    when 'corroborates_book'    then 'corroborates_book'
    when 'high_quote_open_key'  then 'high_quote_open_key'
    when 'corroborated_records' then 'corroborated_records'
    when 'medium_observation'   then 'medium_observation'
    else 'needs_a_person'
  end as lane,
  case c.reason_code
    when 'no_quote'             then 'No quote in the source — a person reads the original before this is a fact.'
    when 'corroborates_book'    then 'The book already holds this value from ' || coalesce(c.held_source, 'another source') || '; there is nothing to write.'
    when 'disagrees_with_book'  then 'Disagrees with what ' || coalesce(c.held_source, 'the book') || ' holds — a disagreement is never settled automatically.'
    when 'records_disagree'     then 'The records disagree with each other about ' || c.key || '; someone reads both.'
    when 'judgement'            then 'The sentence behind it is an assessment, not something a reader could check.'
    when 'corroborated_records' then c.records || ' records in ' || c.systems || ' separate systems say this, each with its own quote, and nothing says otherwise.'
    when 'high_quote_open_key'  then 'Rated high by a reader whose rating has been checked, quoted, and the book holds nothing for ' || c.key || '.'
    when 'unchecked_reader'     then 'Rated high, but by the ' || c.source || ' reader, whose rating has not been checked against its own quotes. One more source, or a person.'
    when 'medium_observation'   then 'Medium confidence, but the extractor called the sentence an observation rather than an assessment.'
    else 'The extractor itself said ' || coalesce(c.confidence, 'nothing about its confidence') || ', and nothing else corroborates it.'
  end as why,
  coalesce(pl.enabled, false) as lane_enabled
from codes c
left join public.pb_fact_autoconfirm_policy pl
  on pl.lane = case c.reason_code
                 when 'corroborates_book'    then 'corroborates_book'
                 when 'high_quote_open_key'  then 'high_quote_open_key'
                 when 'corroborated_records' then 'corroborated_records'
                 when 'medium_observation'   then 'medium_observation'
                 else 'needs_a_person'
               end;

comment on view public.pb_fact_candidate_lanes is
  'Every proposed fact candidate, in exactly one lane, with the reason in plain words. The four '
  'refusals at the top of the CASE are not switchable: no quote, disagrees with the book, the '
  'records disagree with each other, or the sentence is an explicit judgement. Corroboration is '
  'tested before confidence, because two systems agreeing is evidence about the world and one '
  'extractor''s self-rating is evidence about the extractor. Which lanes run, which readers they '
  'trust and how much corroboration counts are all pb_fact_autoconfirm_policy. Owner ruling '
  '18 Sep 2026, DECISIONS §50.';

revoke all on public.pb_fact_candidate_lanes from anon;
grant select on public.pb_fact_candidate_lanes to authenticated;
