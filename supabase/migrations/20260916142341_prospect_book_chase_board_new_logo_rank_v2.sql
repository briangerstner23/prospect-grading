-- WLIQ Prospect Book — filed verbatim from supabase_migrations.schema_migrations on 17 Sep 2026.
-- Applied 20260916142341 as "prospect_book_chase_board_new_logo_rank_v2" by the 16 September session, which pushed its work to its own
-- branch and never filed this one. Recovered with the branch merge; see DECISIONS §38 for the
-- precedent and §45 for why eleven branches existed. Byte-for-byte what ran; do not re-edit here.

-- A second rank on the same evidence, and the reason it has to exist.
--
-- Ranked purely on recorded contact, 91 of the top 100 are companies we are ALREADY DELIVERING
-- FOR. That is not a bug — it is the owner's ruling working exactly as stated (§26: a client is
-- still a prospect, and the handover is the moment to nurture hardest). People already talking
-- to you really are the people most likely to buy again.
--
-- But one number cannot answer two different questions. "Who should I call today" and "where does
-- the next logo come from" have different answers, and a board that only knows the first will
-- quietly starve the second. So the board carries both ranks over identical evidence and
-- identical weights: chase_rank over everyone, new_logo_rank over accounts with no active
-- delivery work. Neither is a filter applied afterwards — both are in the view, so nobody has to
-- remember to apply one.
--
-- 151 accounts with no active project still show a positive signal, so the new-logo lane is not
-- thin. It is quieter than the delivery lane, which is the whole point of separating them.
--
-- (Dropped and recreated rather than replaced: Postgres cannot add a column to the middle of an
-- existing view's column list. Same constraint this book hit twice before, on renames.)
drop view if exists public.pb_chase_board;

create view public.pb_chase_board as
with mdm as (
  select
    public.pb_norm_company(canonical_name) as norm_name,
    case when bool_or(entity_type = 'client') then 'client'
         else min(entity_type) end                as entity_type
  from public.pb_mdm_resolution
  group by public.pb_norm_company(canonical_name)
),
sig as (
  select
    a.id   as account_id,
    a.name,
    a.status                                        as stage_label,
    e.engagement,
    s.quote_state,
    e.last_engaged,
    e.last_contact,
    e.last_quote,
    e.channels,
    coalesce(oc.active_projects, 0)                 as active_projects,
    m.entity_type,
    r.effective_tier,
    r.confidence,
    (s.quote_state = 'quote_open')                  as f_quote_open,
    (e.engagement = 'engaged')                      as f_engaged,
    (e.engagement = 'responsive')                   as f_responsive,
    (s.quote_state = 'quoted_recently')             as f_quoted_recently,
    (coalesce(oc.active_projects, 0) > 0)           as f_delivering,
    exists (select 1 from public.pb_contact_events ce
             where ce.account_id = a.id and ce.channel = 'call') as f_met,
    (e.engagement = 'fading')                       as f_fading,
    (coalesce(e.channels, 0) > 1)                   as f_multi,
    (e.engagement = 'pursued')                      as f_pursued_no_reply,
    (e.engagement = 'dormant')                      as f_dormant
  from public.pb_accounts a
  left join public.pb_engagement       e  on e.account_id = a.id
  left join public.pb_engagement_shape s  on s.account_id = a.id
  left join public.pb_orbit_clients    oc on oc.orbit_id  = a.orbit_client_id
  left join mdm                        m  on m.norm_name  = public.pb_norm_company(a.name)
  left join public.pb_current_reads    r  on r.account_id = a.id
),
scored as (
  select sig.*,
      (case when f_quote_open       then w.w_quote_open      else 0 end)
    + (case when f_engaged          then w.w_engaged         else 0 end)
    + (case when f_responsive       then w.w_responsive      else 0 end)
    + (case when f_quoted_recently  then w.w_quoted_recently else 0 end)
    + (case when f_delivering       then w.w_delivering      else 0 end)
    + (case when f_met              then w.w_met             else 0 end)
    + (case when f_fading           then w.w_fading          else 0 end)
    + (case when f_multi            then w.w_multi           else 0 end)
    + (case when f_pursued_no_reply then w.w_pursued         else 0 end)
    + (case when f_dormant          then w.w_dormant         else 0 end)
    as score
  from sig cross join public.pb_chase_weights_active w
)
select
  account_id, name, score,
  dense_rank() over (order by score desc) as rank_band,
  row_number()  over (order by score desc, last_engaged desc nulls last, name) as chase_rank,
  case when active_projects = 0 then
    row_number() over (partition by (active_projects = 0)
                       order by score desc, last_engaged desc nulls last, name)
  end as new_logo_rank,
  engagement, quote_state, entity_type, active_projects,
  effective_tier, confidence, stage_label,
  last_engaged::date as they_last_replied,
  last_quote::date   as last_quoted,
  nullif(array_to_string(array_remove(array[
    case when f_quote_open       then 'quote open'     end,
    case when f_engaged          then 'replied <30d'   end,
    case when f_responsive       then 'replied <90d'   end,
    case when f_quoted_recently  then 'quoted <180d'   end,
    case when f_delivering       then 'delivering now' end,
    case when f_met              then 'recorded call'  end,
    case when f_fading           then 'fading'         end,
    case when f_multi            then 'multi-channel'  end,
    case when f_pursued_no_reply then 'never answered' end,
    case when f_dormant          then 'dormant'        end
  ], null), ' · '), '') as why
from scored;

comment on view public.pb_chase_board is
  'Chase order over every account, scored from recorded contact rather than CRM stage. Two ranks '
  'over identical evidence: chase_rank over everyone, new_logo_rank over accounts with no active '
  'delivery work — because "who do I call today" and "where does the next logo come from" are '
  'different questions and one number cannot answer both. Weights are data (pb_chase_weights). '
  'The stage label scores zero on purpose. DECISIONS §26, §30.';

revoke all on public.pb_chase_board from anon, authenticated;
