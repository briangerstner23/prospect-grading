-- Does the sentence actually SAY it? (DECISIONS §52)
--
-- §50 gated the website reader out of the automatic lanes because four of ten of its
-- high-confidence claims were inferences wearing a verbatim quote. That gate is per READER, which
-- is the only thing that could be checked at the time: nobody had asked, claim by claim, whether
-- the quoted sentence states the value it was attached to.
--
-- `kind` cannot answer that and was never meant to. It asks whether the SENTENCE is checkable, not
-- whether the sentence supports the VALUE. "a list of ~7 prospects" is a perfectly checkable
-- observation and still does not mean the agency has seven clients.
--
-- So: a second, narrower column. Three words, one question.
--
--   states       the sentence says it outright — "Current client load: ~15 personal injury firms"
--   implies      a fair reading gets there; the sentence does not say it
--   unsupported  the sentence is about something else
--
-- WHAT THIS UNLOCKS, and it is the point. §50's source gate says a lane trusts a reader whose
-- ratings somebody has checked against its own quotes. A per-claim verdict IS that check, done one
-- claim at a time instead of one reader at a time — so `support = 'states'` stands in for being on
-- the allow-list, and a website claim that has been audited and holds up is admissible on exactly
-- the terms a call summary already was. The gate stops being a blanket ban on a source and becomes
-- what it should have been: a demand for evidence about the evidence.
--
-- And in the other direction, `unsupported` is a new hard refusal, above every lane. A claim whose
-- own sentence does not bear on it is not automatic under ANY rule, however many records repeat it
-- — corroboration between two sentences that both fail to say the thing is not corroboration.
--
-- NULL means nobody has asked yet, and changes nothing. Rule 5 all the way down: unknown is never
-- evidence, and it is never a finding either.
--
-- The view is DROPPED rather than replaced: create-or-replace cannot insert a column in the middle
-- of a view's output, and putting the audit beside the claim it is about is worth one drop.

alter table public.pb_fact_candidates
  add column if not exists support            text,
  add column if not exists support_reason     text,
  add column if not exists support_basis      text,
  add column if not exists support_checked_at timestamptz,
  add column if not exists support_auditor    text;

alter table public.pb_fact_candidates
  drop constraint if exists pb_fact_candidates_support_check;
alter table public.pb_fact_candidates
  add constraint pb_fact_candidates_support_check
  check (support is null or support in ('states', 'implies', 'unsupported'));

alter table public.pb_fact_candidates
  drop constraint if exists pb_fact_candidates_support_basis_check;
alter table public.pb_fact_candidates
  add constraint pb_fact_candidates_support_basis_check
  check (support_basis is null or support_basis in ('model', 'lexicon'));

comment on column public.pb_fact_candidates.support is
  'Does the stored quote STATE this value for this key? states / implies / unsupported, decided by '
  'ingest/verify_support.ts — the model answers and a lexicon may overrule it DOWNWARD only. NULL '
  'means nobody has audited it, which is not a finding about the sentence.';
comment on column public.pb_fact_candidates.support_basis is
  'model when the reader decided it; lexicon when a rule overruled the reader downward.';

create index if not exists pb_fact_candidates_support_idx
  on public.pb_fact_candidates (support) where status = 'proposed';
create index if not exists pb_fact_candidates_unaudited_idx
  on public.pb_fact_candidates (created_at) where status = 'proposed' and support is null;

drop view if exists public.pb_fact_candidate_lanes;

create view public.pb_fact_candidate_lanes
with (security_invoker = true) as
with p as (
  select c.id, c.account_id, c.key, c.value, c.quote, c.confidence, c.kind,
         c.source, c.source_id, c.observed_at, c.extractor, c.created_at,
         c.support, c.support_reason, c.support_basis,
         f.value as held_value, f.source as held_source,
         (f.key is not null) as book_holds
    from public.pb_fact_candidates c
    left join public.pb_current_facts f
      on f.account_id = c.account_id and f.key = c.key
   where c.status = 'proposed'
),
-- Corroboration counts RECORDS, not rows: two extractors reading the same note are one witness.
-- A sentence already judged not to bear on the claim may not corroborate anything either.
agree as (
  select account_id, key, value,
         count(distinct coalesce(source_id, id::text)) as records,
         count(distinct source)                        as systems
    from p
   where quote is not null and btrim(quote) <> ''
     and support is distinct from 'unsupported'
   group by 1, 2, 3
),
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
codes as (
  select p.*, coalesce(a.records, 1) as records, coalesce(a.systems, 1) as systems,
         s.values_proposed,
         case
           when p.quote is null or btrim(p.quote) = ''                     then 'no_quote'
           -- Above every lane: its own sentence does not bear on it.
           when p.support = 'unsupported'                                  then 'unsupported_sentence'
           when p.book_holds and p.held_value is not distinct from p.value  then 'corroborates_book'
           when p.book_holds                                               then 'disagrees_with_book'
           when s.values_proposed > 1                                      then 'records_disagree'
           when p.kind = 'judgement'                                       then 'judgement'
           when coalesce(a.records, 1) >= pol.min_recs
            and coalesce(a.systems, 1) >= pol.min_sys                      then 'corroborated_records'
           -- An audited claim that holds up stands in for the reader being on the allow-list:
           -- the gate asks for evidence about the evidence, and this IS that evidence.
           when p.confidence = 'high'
            and (pol.high_sources is null
                 or p.source = any(pol.high_sources)
                 or p.support = 'states')                                  then 'high_quote_open_key'
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
  c.support, c.support_reason, c.support_basis,
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
    when 'unsupported_sentence' then 'Audited: the sentence does not bear on this — ' || coalesce(c.support_reason, 'no reason recorded') || '.'
    when 'corroborates_book'    then 'The book already holds this value from ' || coalesce(c.held_source, 'another source') || '; there is nothing to write.'
    when 'disagrees_with_book'  then 'Disagrees with what ' || coalesce(c.held_source, 'the book') || ' holds — a disagreement is never settled automatically.'
    when 'records_disagree'     then 'The records disagree with each other about ' || c.key || '; someone reads both.'
    when 'judgement'            then 'The sentence behind it is an assessment, not something a reader could check.'
    when 'corroborated_records' then c.records || ' records in ' || c.systems || ' separate systems say this, each with its own quote, and nothing says otherwise.'
    when 'high_quote_open_key'  then case
                                       when c.support = 'states'
                                         then 'Rated high, and the sentence was audited and does state it; the book holds nothing for ' || c.key || '.'
                                       else 'Rated high by a reader whose rating has been checked, quoted, and the book holds nothing for ' || c.key || '.'
                                     end
    when 'unchecked_reader'     then 'Rated high, but by the ' || c.source || ' reader, whose rating has not been checked against its own quotes. Audit the sentence, find a second source, or read it.'
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
  'Every proposed fact candidate, in exactly one lane, with the reason in plain words. Five '
  'refusals sit above every lane and none is switchable: no quote, a sentence audited as not '
  'bearing on the claim, disagreement with what the book holds, two records proposing different '
  'values for one key, and an explicit judgement. Corroboration is tested before confidence, and '
  'an audited support = states stands in for the reader being on the lane''s allow-list. Which '
  'lanes run and what they demand is pb_fact_autoconfirm_policy. DECISIONS §50, §52.';

revoke all on public.pb_fact_candidate_lanes from anon;
revoke all on public.pb_fact_candidate_lanes from authenticated;
grant select on public.pb_fact_candidate_lanes to authenticated;
