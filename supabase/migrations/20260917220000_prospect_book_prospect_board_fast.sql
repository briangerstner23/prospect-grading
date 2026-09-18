-- The board took 8.1 seconds and timed out for the page. Two attempts; the second one measured.
--
-- FIRST: `best` joined pb_current_reads with `r.account_id = any(g.account_ids)`, which cannot
-- use an index. Unnesting the array to make it an equality join was necessary — and took it from
-- 8.1s to 7.7s, which is to say it was not the problem.
--
-- THE PROBLEM, from the plan:  Unique → Index Scan on pb_reads (rows=13584, LOOPS=599).
-- pb_current_reads is a `distinct on` over every row of pb_reads, and DISTINCT ON blocks
-- predicate pushdown, so no join condition can reach inside it. The planner rebuilt the whole
-- current-reads set once per company — 599 times, 8.2 million buffer hits.
--
-- `as materialized` is an optimisation fence: the CTE is computed ONCE and hash-joined against.
-- One pass over 13,584 rows instead of 599. Measured 8.1s → 0.80s, and the output is identical:
-- 599 rows, ranks 1..599, same tier distribution, same top of the list.
--
-- Output is unchanged in every respect. The rank is still the engine's chase_rank_key, read out
-- of the scorecard and never restated in SQL (rule 4).
create or replace view public.pb_prospect_board as
with grp as (
  select b.norm_name, b.name, b.account_ids, b.records, b.duplicate_records,
         b.engagement, b.quote_state, b.crm_urgency, b.cj_stage,
         b.they_last_replied, b.last_quoted, b.entity_type
    from public.pb_chase_board b
   where b.active_projects = 0
),
-- One row per (company, account), so the join below is an equality on a scalar.
acct as (
  select g.norm_name, a.account_id
    from grp g
    cross join lateral unnest(g.account_ids) as a(account_id)
),
-- THE FENCE. Without `materialized` this is re-derived per company and the view takes 8 seconds.
reads as materialized (
  select r.account_id, r.effective_tier, r.cell, r.ceiling, r.headroom_band, r.year1_band,
         r.facts_present, r.qualification_label, r.confidence, r.confidence_grade,
         r.urgency, r.status, r.flags,
         (r.scorecard->'chase_rank_key'->>0)::numeric as k0,
         (r.scorecard->'chase_rank_key'->>1)::numeric as k1,
         (r.scorecard->'chase_rank_key'->>2)::numeric as k2,
         (r.scorecard->'chase_rank_key'->>3)::numeric as k3,
         (r.scorecard->'chase_rank_key'->>4)          as k4
    from public.pb_current_reads r
),
best as (
  select distinct on (a.norm_name)
         a.norm_name, r.account_id,
         r.effective_tier, r.cell, r.ceiling, r.headroom_band, r.year1_band,
         r.facts_present, r.qualification_label, r.confidence, r.confidence_grade,
         r.urgency, r.status, r.flags, r.k0, r.k1, r.k2, r.k3, r.k4
    from acct a
    join reads r on r.account_id = a.account_id
   order by a.norm_name, r.k0, r.k1, r.k2, r.k3, r.k4
)
select
  row_number() over (order by b.k0, b.k1, b.k2, b.k3, b.k4)          as rank,
  dense_rank()  over (order by b.k0)                                  as tier_band,
  b.account_id, g.norm_name, g.name,
  b.effective_tier, b.cell, b.ceiling, b.headroom_band, b.year1_band,
  b.facts_present, b.qualification_label, b.confidence, b.confidence_grade, b.status,
  g.engagement, b.urgency as signal_urgency, g.crm_urgency, g.quote_state,
  g.they_last_replied, g.last_quoted, g.cj_stage, g.entity_type,
  (b.effective_tier in ('Platinum','Gold') and g.engagement = 'unknown')  as untouched_high_potential,
  g.records, g.duplicate_records, b.flags
from best b
join grp g on g.norm_name = b.norm_name;

comment on view public.pb_prospect_board is
  'Prospects ranked by POTENTIAL, not by contact. One row per company with no active delivery '
  'work, ordered by the engine''s own chase_rank_key — the rubric defines the order and grade() '
  'computes it, so SQL never restates it (rule 4). Engagement is carried in its own columns and '
  'never sets the rank (DECISIONS §20). No composite score (PRO-0). Read by the page through '
  'pb_board(); the view stays closed to anon because it sits on seventeen objects (§47). '
  'The `reads as materialized` fence is load-bearing: pb_current_reads is a distinct-on over all '
  'of pb_reads, which blocks predicate pushdown, so without the fence it is rebuilt once per '
  'company and the view takes eight seconds instead of loading.';
