-- Prospects ranked by POTENTIAL, not by contact (DECISIONS §33).
--
-- pb_chase_board ranks on recorded contact. That answers "who do I call today" and it is the
-- wrong list for "who are the best prospects": it put exactly ONE of the 61 highest-potential
-- prospects in its top 100, and buried the worst of them at rank 816. Thirty-five scored zero
-- or less and were invisible.
--
-- Two mistakes underneath that, both mine:
--
--   1. It ranked on engagement. The owner's §20 ruling says potential is what they could be
--      worth and engagement is whether they are live right now, and neither touches the other.
--      A board that multiplies them cannot answer either question.
--   2. It invented an ordering. The rubric ALREADY defines the chase order — `chase_rank_key`,
--      tier then how real the deal is then urgency then year-one band — and grade() computes it
--      into every scorecard. Rule 4 says the rubric is data; a weights table competing with the
--      rubric's own key is a second source of truth for the same decision.
--
-- So this view does not order anything itself. It reads the five elements of the engine's
-- `chase_rank_key` out of the scorecard and sorts on them. Change the chase order by editing the
-- rubric and re-scoring; nothing here needs to move.
--
-- Note what the key already does with engagement: urgency is the THIRD element, after tier and
-- qualification. Liveness is a tiebreak between equals, never a reason to outrank a bigger
-- prospect. That is §20 expressed as an ordering, and it was in the rubric all along.
--
-- ONE ROW PER COMPANY, and the company's potential is the BEST-evidenced read among its records
-- — picked by the same key, so a duplicate pair is resolved the way everything else is rather
-- than by whichever record happens to lead. That promotes one company whose Platinum read sits
-- on its non-lead record.
--
-- NEVER SUMMED (PRO-0). The output is a rank, a Tier × Ceiling cell and bands. No composite
-- number; pb_chase_board's score was one, and that was a third thing wrong with it.
create or replace view public.pb_prospect_board as
with grp as (
  select b.norm_name, b.name, b.account_ids, b.records, b.duplicate_records,
         b.engagement, b.quote_state, b.crm_urgency, b.cj_stage,
         b.they_last_replied, b.last_quoted, b.entity_type
    from public.pb_chase_board b
   where b.active_projects = 0
),
best as (
  select distinct on (g.norm_name)
         g.norm_name, r.account_id,
         r.effective_tier, r.cell, r.ceiling, r.headroom_band, r.year1_band,
         r.facts_present, r.qualification_label, r.confidence, r.confidence_grade,
         r.urgency, r.status, r.flags,
         (r.scorecard->'chase_rank_key'->>0)::numeric as k0,
         (r.scorecard->'chase_rank_key'->>1)::numeric as k1,
         (r.scorecard->'chase_rank_key'->>2)::numeric as k2,
         (r.scorecard->'chase_rank_key'->>3)::numeric as k3,
         (r.scorecard->'chase_rank_key'->>4)          as k4
    from grp g
    join public.pb_current_reads r on r.account_id = any(g.account_ids)
   order by g.norm_name,
            (r.scorecard->'chase_rank_key'->>0)::numeric,
            (r.scorecard->'chase_rank_key'->>1)::numeric,
            (r.scorecard->'chase_rank_key'->>2)::numeric,
            (r.scorecard->'chase_rank_key'->>3)::numeric,
            (r.scorecard->'chase_rank_key'->>4)
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
  'work, ordered by the engine''s own chase_rank_key — tier, then how real the deal is, then '
  'urgency, then year-one band — which the rubric defines and grade() computes, so the order is '
  'never restated in SQL (rule 4). Engagement is carried in its own columns and never sets the '
  'rank: potential is what they could be worth, engagement is whether they are live right now, '
  'and neither touches the other (DECISIONS §20). No composite score: the output is a rank, a '
  'Tier × Ceiling cell and bands (PRO-0). pb_chase_board remains the contact-ordered board — '
  'who to call today — and answers a different question.';

revoke all on public.pb_prospect_board from anon, authenticated;
