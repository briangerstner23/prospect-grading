-- WLIQ Prospect Book — does the book actually move?
--
-- The grade is meant to change as a pursuit progresses: a call lands, a note is read, a signal
-- decays, and tomorrow's chase order differs from today's. Nothing measured whether that was
-- happening. Answering "did anything move last night" took an ad-hoc window query over pb_reads,
-- which means nobody could ask it without writing SQL — so in practice nobody asked.
--
-- Two views. Both are read-only derivations of tables the page already reads, so they inherit
-- PRO-7-as-implemented (public read) without widening anything.
--
-- `pb_source_watermarks` is deliberately NOT read here. anon holds nothing on it, and these
-- views are `security_invoker = true` (the house rule — a view must not become a way around the
-- RLS of the table under it, see 20260911180000). A pulse view that joined it would return
-- nothing for the anonymous reader the page actually uses, which is worse than omitting it.
--
-- One subtlety worth recording: `pb_reads.run_at` is the row's INSERT time, not the run's time.
-- pb-score writes in batches, so a single run lands rows a second or two apart and grouping by
-- run_at splits one run into two. Group by `run_id`, which is the run's identity, and carry
-- min(run_at) as its clock. Getting this wrong doesn't error — it silently doubles the row count
-- and halves every movement figure.

-- ── per scoring run: what changed against each account's PREVIOUS read ────────────────────────
create or replace view pb_movement with (security_invoker = true) as
with seq as (
  select run_id, account_id, run_at, effective_tier, urgency, status, facts_present,
         row_number() over (partition by account_id order by run_at, run_id) as rn
  from pb_reads
),
pairs as (
  select a.run_id,
         b.effective_tier as prev_tier,    a.effective_tier as tier,
         b.urgency        as prev_urgency, a.urgency        as urgency,
         b.status         as prev_status,  a.status         as status,
         b.facts_present  as prev_facts,   a.facts_present  as facts
  from seq a
  join seq b on b.account_id = a.account_id and b.rn = a.rn - 1
),
runs as (
  select run_id, min(run_at) as run_at, count(*) as accounts
  from pb_reads
  group by run_id
)
select
  r.run_id,
  r.run_at,
  r.accounts,
  count(p.*) filter (where p.tier is distinct from p.prev_tier) as tier_moved,
  -- coalesce to 0 is load-bearing, not defensive. An Unclassified read carries effective_tier
  -- NULL, array_position returns NULL for it, and `NULL > 2` is NULL — not false and never true.
  -- Without the coalesce every Unclassified -> Bronze move counts in tier_moved and in NEITHER
  -- direction, so the two columns silently fail to sum to it. Rank 0 also says the right thing:
  -- Unclassified sits below Bronze, and becoming rankable is a promotion.
  count(p.*) filter (
    where coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.tier), 0)
        > coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.prev_tier), 0)
  ) as promoted,
  count(p.*) filter (
    where coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.tier), 0)
        < coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.prev_tier), 0)
  ) as demoted,
  count(p.*) filter (where p.urgency is distinct from p.prev_urgency) as urgency_moved,
  count(p.*) filter (
    where coalesce(array_position(array['Cold','Warm','Hot','Super Hot'], p.urgency), 0)
        > coalesce(array_position(array['Cold','Warm','Hot','Super Hot'], p.prev_urgency), 0)
  ) as urgency_up,
  count(p.*) filter (where p.facts is distinct from p.prev_facts)     as facts_changed,
  count(p.*) filter (where p.status = 'Ranked'       and p.prev_status <> 'Ranked')       as newly_ranked,
  count(p.*) filter (where p.status = 'Unclassified' and p.prev_status <> 'Unclassified') as newly_unclassified
from runs r
left join pairs p on p.run_id = r.run_id
group by r.run_id, r.run_at, r.accounts;

comment on view pb_movement is
  'One row per pb-score run: how many accounts changed tier, urgency, status or fact count '
  'against their own previous read. The first run of an account has no predecessor and so '
  'contributes to `accounts` but never to a movement count.';

-- ── one row: is the book alive right now, and what is waiting on a person ─────────────────────
create or replace view pb_pulse with (security_invoker = true) as
select
  (select max(run_at) from pb_reads)                                       as last_scored_at,
  (select round(extract(epoch from (now() - max(run_at))) / 3600.0, 1)
     from pb_reads)                                                        as hours_since_score,
  (select accounts      from pb_movement order by run_at desc limit 1)     as last_run_accounts,
  (select tier_moved    from pb_movement order by run_at desc limit 1)     as last_run_tier_moved,
  (select promoted      from pb_movement order by run_at desc limit 1)     as last_run_promoted,
  (select demoted       from pb_movement order by run_at desc limit 1)     as last_run_demoted,
  (select urgency_moved from pb_movement order by run_at desc limit 1)     as last_run_urgency_moved,
  -- what arrived recently: the inputs that are SUPPOSED to move the order
  (select count(*) from pb_facts   where created_at > now() - interval '7 days')  as facts_7d,
  (select count(*) from pb_signals where created_at > now() - interval '7 days')  as signals_7d,
  (select count(*) from pb_calls   where created_at > now() - interval '7 days')  as calls_7d,
  (select count(*) from pb_calls)                                                 as calls_total,
  -- what is stuck waiting on a human: the rate limiter on everything a rater contributes
  (select count(*) from pb_fact_candidates     where status = 'proposed')  as facts_awaiting_review,
  (select count(*) from pb_identity_candidates where status = 'proposed')  as merges_awaiting_review,
  -- how much of the book is inert
  (select count(*) from pb_accounts where book in ('prospect','parked'))   as accounts,
  (select count(*) from pb_current_reads where urgency = 'Cold')           as cold,
  (select count(distinct account_id) from pb_signals
     where expires_at is null or expires_at > now())                       as accounts_with_live_signal;

comment on view pb_pulse is
  'A single row answering "is this thing moving, and what is it waiting on". Movement figures '
  'come from the most recent pb-score run; the arrival counts are the inputs meant to cause '
  'movement; the review counts are what a person has to clear before rater judgement can land.';

-- ── grants. Reads are public (DECISIONS.md §5); writes are refused for both roles. ────────────
-- Supabase's stock default privileges grant every verb on a new object in `public` to anon AND
-- authenticated, so the revoke is not belt-and-braces — without it these views are writable by
-- anyone signed in. A view over a view needs it as much as a table does.
revoke all on public.pb_movement, public.pb_pulse from anon, authenticated;
grant select on public.pb_movement, public.pb_pulse to anon, authenticated;
