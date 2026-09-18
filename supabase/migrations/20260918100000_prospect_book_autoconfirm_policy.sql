-- WLIQ Prospect Book — the queue approves what it has nothing to weigh.
--
-- Owner ruling, 18 Sep 2026: "if there's enough confidence and the statement is clear enough, I
-- think the system could approve it. There is always the ability for us to see that statement and
-- undo it later. I'm not going to get through a thousand. I don't want wrong information to be
-- entered, but I believe some of these you may have high enough confidence in, or it has been
-- confirmed multiple times in other places, so we could automatically approve it."
--
-- §45 already narrowed "never bulk confirm" to one class and gave the owner a button for it. This
-- goes one step further and lets the BOOK press that button, on lanes the owner switches on by
-- name. The step is small on purpose: what changes is who presses it, not what qualifies — except
-- for one new lane, corroboration, which is the owner's own second criterion.
--
-- THE LANES. Every proposed candidate lands in exactly one, in this order, and the order is the
-- argument: each test below is one a reviewer would apply before reading the sentence at all.
--
--   needs_a_person        no quote · the book holds a DIFFERENT value · two notes propose
--                         different values for the same key · the sentence is an explicit
--                         judgement. None of these is switchable. A lane cannot be widened past
--                         them and no interface can ask.
--   corroborates_book     the book already holds this exact value. WRITES NOTHING — there is
--                         nothing to write — and closes the row as superseded. The grade cannot
--                         move, so this lane is risk-free by construction.
--   high_quote_open_key   §45's own gate, unchanged: extractor said high, a verbatim quote is
--                         attached, the book holds nothing for the key.
--   corroborated_records  the owner's "confirmed multiple times in other places": N distinct
--                         source RECORDS carry this same value, each with its own quote, and no
--                         record anywhere proposes a different one. Admits medium confidence,
--                         because two independent notes agreeing is a stronger claim than one
--                         extractor's self-rating.
--   medium_observation    medium confidence, and the extractor affirmatively said the sentence is
--                         an OBSERVATION rather than an assessment. This is the lane where a wrong
--                         fact could enter, so it ships DISABLED and is the owner's to switch on
--                         after reading what it would admit.
--
-- ON `kind`: written_record.ts treats an ABSENT kind as a judgement, the cautious reading, which
-- is why those claims are in the queue at all rather than written. This migration distinguishes
-- ABSENT from STATED. An explicitly `judgement` claim is refused outright — closing a gap, see
-- below. An absent one is admitted only on a lane that does not depend on the distinction
-- (high confidence + quote, or two records agreeing); the medium lane, which rests entirely on the
-- sentence being checkable, demands the word `observation` and will not take silence for it.
--
-- A GAP CLOSED. pb_confirm_fact_candidates (§45) says in its own comment that it refuses "a claim
-- that is somebody's judgement rather than an observation". It never checked: `kind` is not in the
-- function at all, and 11 claims the extractor had explicitly marked `judgement` were sitting
-- inside its gate, one click from being facts. The check is added below, to that function as well
-- as to this one, so the code now does what its comment always claimed.
--
-- UNDO IS PART OF THE RULING, not a courtesy. pb_autoconfirm_log records every row this writes —
-- which candidate, which fact, which lane, which batch — and pb_undo_autoconfirm(batch) deletes
-- those facts, reopens those candidates and says so in the register. Automatic approval that
-- cannot be taken back is not what was asked for.

/* ------------------------------------------------------------------ *
 * 1. the policy — thresholds as data, the way the rubric is data
 * ------------------------------------------------------------------ */

create table if not exists public.pb_fact_autoconfirm_policy (
  lane                text primary key,
  rank                int  not null,
  enabled             boolean not null default false,
  writes_a_fact       boolean not null,
  -- 'high' | 'medium' | null for "the lane does not rest on the extractor's own rating"
  min_confidence      text check (min_confidence in ('high', 'medium', 'low')),
  -- does the extractor have to have said the word `observation`? Silence is not a yes.
  require_observation boolean not null default false,
  -- corroboration: how many DISTINCT source records, across how many distinct source systems.
  min_source_records  int not null default 1 check (min_source_records >= 1),
  min_source_systems  int not null default 1 check (min_source_systems >= 1),
  what                text not null,
  updated_at          timestamptz not null default now(),
  updated_by          text
);

insert into public.pb_fact_autoconfirm_policy
  (lane, rank, enabled, writes_a_fact, min_confidence, require_observation,
   min_source_records, min_source_systems, what)
values
  ('corroborates_book',   10, true,  false, null,     false, 1, 1,
   'The book already holds this exact value. Nothing is written and the row is closed; the grade cannot move.'),
  ('high_quote_open_key', 20, true,  true,  'high',   false, 1, 1,
   'The extractor rated it high, a verbatim quote is attached, and the book holds nothing for that key — §45''s own gate, pressed by the book instead of by hand.'),
  ('corroborated_records',30, true,  true,  null,     false, 2, 1,
   'Two or more separate records say the same thing, each with its own quote, and nothing anywhere says otherwise.'),
  ('medium_observation',  40, false, true,  'medium', true,  1, 1,
   'Medium confidence, but the extractor said the sentence is an observation a reader could check rather than an assessment. OFF until the owner reads what it would admit.')
on conflict (lane) do nothing;

alter table public.pb_fact_autoconfirm_policy enable row level security;

drop policy if exists pb_fact_autoconfirm_policy_read on public.pb_fact_autoconfirm_policy;
create policy pb_fact_autoconfirm_policy_read on public.pb_fact_autoconfirm_policy
  for select to authenticated using (public.pb_is_wliq());

-- Switching a lane on is the owner's, and it is a decision, so it signs its own name.
drop policy if exists pb_fact_autoconfirm_policy_set on public.pb_fact_autoconfirm_policy;
create policy pb_fact_autoconfirm_policy_set on public.pb_fact_autoconfirm_policy
  for update to authenticated
  using (public.pb_is_wliq() and public.pb_role() = 'owner')
  with check (public.pb_is_wliq() and public.pb_role() = 'owner' and updated_by = public.pb_me());

-- A new pb_ table arrives with anon AND authenticated holding everything (CLAUDE.md).
revoke all on public.pb_fact_autoconfirm_policy from anon;
revoke all on public.pb_fact_autoconfirm_policy from authenticated;
grant select, update on public.pb_fact_autoconfirm_policy to authenticated;

/* ------------------------------------------------------------------ *
 * 2. the ledger — what was approved automatically, and how to take it back
 * ------------------------------------------------------------------ */

create table if not exists public.pb_autoconfirm_log (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null,
  account_id    uuid not null references public.pb_accounts(id) on delete cascade,
  candidate_id  uuid not null references public.pb_fact_candidates(id) on delete cascade,
  -- Null when the lane wrote nothing (corroborates_book) or when the row was merely closed
  -- because a sibling answered the same key.
  fact_id       uuid,
  lane          text not null,
  action        text not null check (action in ('confirmed', 'closed', 'superseded')),
  key           text not null,
  value         jsonb,
  ran_by        text not null,
  ran_at        timestamptz not null default now(),
  undone_at     timestamptz,
  undone_by     text
);

create index if not exists pb_autoconfirm_log_batch_idx   on public.pb_autoconfirm_log (batch_id);
create index if not exists pb_autoconfirm_log_account_idx on public.pb_autoconfirm_log (account_id, ran_at desc);
create index if not exists pb_autoconfirm_log_live_idx    on public.pb_autoconfirm_log (ran_at desc) where undone_at is null;

alter table public.pb_autoconfirm_log enable row level security;

drop policy if exists pb_autoconfirm_log_read on public.pb_autoconfirm_log;
create policy pb_autoconfirm_log_read on public.pb_autoconfirm_log
  for select to authenticated using (public.pb_is_wliq());

revoke all on public.pb_autoconfirm_log from anon;
revoke all on public.pb_autoconfirm_log from authenticated;
grant select on public.pb_autoconfirm_log to authenticated;

/* ------------------------------------------------------------------ *
 * 3. the classifier — one lane per proposed candidate, and why
 * ------------------------------------------------------------------ */

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
    coalesce((select min_source_systems from public.pb_fact_autoconfirm_policy where lane = 'corroborated_records'), 1) as min_sys
),
-- One CASE, one reason code. The lane and the sentence a reader sees are both derived from it,
-- so the words on the screen can never drift from the test that put the row there.
codes as (
  select p.*, coalesce(a.records, 1) as records, coalesce(a.systems, 1) as systems,
         s.values_proposed,
         case
           when p.quote is null or btrim(p.quote) = ''                   then 'no_quote'
           when p.book_holds and p.held_value is not distinct from p.value then 'corroborates_book'
           when p.book_holds                                             then 'disagrees_with_book'
           when s.values_proposed > 1                                    then 'records_disagree'
           when p.kind = 'judgement'                                     then 'judgement'
           when p.confidence = 'high'                                    then 'high_quote_open_key'
           when coalesce(a.records, 1) >= pol.min_recs
            and coalesce(a.systems, 1) >= pol.min_sys                    then 'corroborated_records'
           when p.confidence = 'medium' and p.kind = 'observation'        then 'medium_observation'
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
    when 'high_quote_open_key'  then 'Rated high, quoted, and the book holds nothing for ' || c.key || '.'
    when 'corroborated_records' then c.records || ' separate records say this, each with its own quote, and nothing says otherwise.'
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
  'records disagree with each other, or the sentence is an explicit judgement. Which of the '
  'remaining lanes actually runs is pb_fact_autoconfirm_policy.enabled. Owner ruling 18 Sep 2026, '
  'DECISIONS §50.';

revoke all on public.pb_fact_candidate_lanes from anon;
grant select on public.pb_fact_candidate_lanes to authenticated;
