-- The medium lane, restricted by FIELD as well as by reader (DECISIONS §60)
--
-- Owner, 18 Sep 2026, asked for automatic approval and was told no. That answer was too broad and
-- this migration narrows it to what was actually meant. Three lanes are on and sound. The fourth,
-- `medium_observation`, holds 77 claims, and a hand read of all 77 found roughly one in three
-- attaching a genuine quote to the wrong FIELD or the wrong COMPANY — our own follow-up commitment
-- recorded as the prospect's timeline, "no competitors were mentioned" recorded as "no competing
-- vendor". Neither the quote check nor §54's support verdict catches that class: both ask about the
-- sentence, and the error is in what the sentence was filed AGAINST.
--
-- So the lane opens on the only axis that bounds the damage rather than describing it: the FIELD.
-- A claim on a key the active rubric never reads cannot move a tier, a rank or a band, however
-- wrong it is. That is not a judgement about the extractor — it is arithmetic.
--
-- The list is DATA, like `sources` beside it (rule 4). Widening it is an owner decision and an
-- update, never an edit here.
--
-- MEASURED, not assumed. Of the 77: five keys appear NOWHERE in rubric 0.1.7 or in engine.ts,
-- classify.ts, decay.ts or reason.ts — 32 claims across 5 keys. The other 45 sit on keys that
-- decide the deal reads, the ICP class, the size ceiling or confidence, and stay with a person.
--
-- READ THIS BEFORE ACTIVATING 0.2.1. Three of the five are read by the registered 0.2.1 draft:
-- recurring_work_shape (16 claims), sells_build_work (3) and client_budget_size (2). They are inert
-- under 0.1.7 and become grade-bearing the day 0.2.1 activates — 21 of the 32 admitted here.
-- The runbook already demands a preview before any activation, which would SHOW the movement; what
-- it would not say is that the facts underneath were admitted without a person. Either re-audit
-- those keys before activating 0.2.1, or narrow this list to the two keys no rubric reads at all
-- (competitive_overlap, client_evidence_count) and accept 11 instead of 32.

alter table public.pb_fact_autoconfirm_policy
  add column if not exists keys text[];

comment on column public.pb_fact_autoconfirm_policy.keys is
  'Fact keys this lane may admit. NULL means no restriction, exactly as `sources` does. Used to '
  'open a lane on fields the active rubric does not read, so a wrong claim cannot move a grade.';

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
    (select sources from public.pb_fact_autoconfirm_policy where lane = 'medium_observation')     as med_sources,
    (select keys    from public.pb_fact_autoconfirm_policy where lane = 'medium_observation')     as med_keys
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
            and (pol.med_keys    is null or p.key    = any(pol.med_keys))
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
    when 'medium_observation'   then 'Medium confidence, the extractor called the sentence an observation, and ' || c.key || ' is a key the active rubric does not read — so this cannot move a grade.'
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
  'an audited support = states stands in for the reader being on the lane''s allow-list. The '
  'medium lane is additionally restricted to keys the active rubric does not read, so a wrong '
  'admission there cannot move a grade. Which lanes run and what they demand is '
  'pb_fact_autoconfirm_policy. DECISIONS §50, §52, §60.';

revoke all on public.pb_fact_candidate_lanes from anon;
revoke all on public.pb_fact_candidate_lanes from authenticated;
grant select on public.pb_fact_candidate_lanes to authenticated;

-- Switched ON, restricted to the five keys rubric 0.1.7 does not read.
update public.pb_fact_autoconfirm_policy
   set enabled    = true,
       keys       = array['recurring_work_shape','competitive_overlap','client_evidence_count',
                          'sells_build_work','client_budget_size'],
       what       = 'Medium confidence, the extractor called the sentence an observation, AND the key '
                    || 'is one the active rubric never reads — so a wrong admission cannot move a tier, '
                    || 'a rank or a band. Opened on the FIELD because a hand read of all 77 found about '
                    || 'one in three filed against the wrong field or company, which no sentence-level '
                    || 'check can catch. Widening the key list is an owner decision.',
       updated_by = 'owner instruction, 18 Sep 2026',
       updated_at = now()
 where lane = 'medium_observation';
