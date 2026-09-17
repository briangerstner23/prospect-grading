-- The chase board ranks COMPANIES, not account records (DECISIONS §31).
--
-- 25 companies are in the book twice. Seven of those pairs touch the top 100 and seven have a
-- 30-point-plus gap between their two records, because the evidence is SPLIT: one record holds the
-- reply, the other holds the quote. On two pairs the two records disagree outright — one says
-- `quote_open`, the other says `pursued`, which the board rendered as "quote open" on one row and
-- "never answered" on another, for the same company, nine ranks apart.
--
-- Ranking those records separately is wrong twice over. Both rows understate the relationship,
-- and neither is the company. So the board groups by normalised name and derives engagement from
-- the UNION of the group's contact events.
--
-- The union is taken over EVENTS, never over the derived flags. OR-ing the flags is the obvious
-- shortcut and it produces states that cannot exist: `engaged` and `pursued` together, "replied
-- <30d · never answered" on one line. Engagement is a case expression over dated observations, so
-- the only correct way to merge two accounts' engagement is to merge their observations and run
-- the expression once. pb_company_engagement is pb_engagement's derivation verbatim, grouped one
-- level up; the thresholds are not restated anywhere.
--
-- THIS IS NOT A MERGE. Nothing is written to pb_accounts, no identity is asserted, and every
-- grouped row carries `records` and `record_names` so the duplication stays visible rather than
-- being quietly absorbed. pb_duplicate_accounts still lists all 25 for a person to rule on
-- (rule 8). If the grouping is wrong for some pair, the fix is to drop this view, not to unpick a
-- write that already happened.
create or replace view public.pb_company_engagement
with (security_invoker = true) as
with grp as (
  select public.pb_norm_company(a.name) as norm_name, a.id as account_id
    from public.pb_accounts a
),
ev as (
  select g.norm_name,
         max(e.occurred_at)                                              as last_contact,
         max(e.occurred_at) filter (where e.direction = 'inbound')       as last_reply,
         max(e.occurred_at) filter (where e.direction in ('inbound','mutual')) as last_engaged,
         max(e.occurred_at) filter (where e.direction = 'outbound')      as last_outbound,
         max(e.occurred_at) filter (where e.channel in ('call','meeting_invite')) as last_meeting,
         max(e.occurred_at) filter (where e.channel = 'call')            as last_call,
         max(e.occurred_at) filter (where e.channel = 'quote')           as last_quote,
         count(*)                                                        as events,
         count(*) filter (where e.direction in ('inbound','mutual'))     as engaged_events,
         count(distinct e.channel)                                       as channels
    from grp g
    join public.pb_contact_events e on e.account_id = g.account_id
   group by g.norm_name
)
select g.norm_name,
       ev.last_contact, ev.last_reply, ev.last_engaged, ev.last_outbound,
       ev.last_meeting, ev.last_call, ev.last_quote,
       coalesce(ev.events, 0)         as events,
       coalesce(ev.engaged_events, 0) as engaged_events,
       coalesce(ev.channels, 0)       as channels,
       -- Verbatim from pb_engagement (migration 20260916140100). Same thresholds, one level up.
       case
         when ev.last_contact is null then 'unknown'
         when ev.last_engaged  >= now() - interval '30 days'  then 'engaged'
         when ev.last_engaged  >= now() - interval '90 days'  then 'responsive'
         when ev.last_outbound >= now() - interval '30 days'  then 'pursued'
         when ev.last_contact  >= now() - interval '180 days' then 'fading'
         else 'dormant'
       end as engagement,
       -- Verbatim from pb_engagement_shape (migration 20260916170000).
       case
         when ev.last_quote >= now() - interval '60 days'  then 'quote_open'
         when ev.last_quote >= now() - interval '180 days' then 'quoted_recently'
         else null
       end as quote_state
  from (select distinct norm_name from grp) g
  left join ev on ev.norm_name = g.norm_name;

comment on view public.pb_company_engagement is
  'pb_engagement, grouped by normalised company instead of by account record, so two records for '
  'one company stop splitting its evidence. Derived from the UNION of contact events, never from '
  'OR-ing the per-record flags — that produces states that cannot exist. Asserts no identity: '
  'pb_duplicate_accounts still proposes the merges and a person still decides (rule 8).';

revoke all on public.pb_company_engagement from anon, authenticated;

drop view if exists public.pb_chase_board;

create view public.pb_chase_board as
with grp as (
  select public.pb_norm_company(a.name) as norm_name, a.*
    from public.pb_accounts a
),
-- The display name is the record the book actually knows: most contact events, then longest name
-- (the fuller spelling), then alphabetical. Deterministic, and never invents a name.
lead_rec as (
  select distinct on (g.norm_name)
         g.norm_name, g.id as lead_account_id, g.name as display_name
    from grp g
    left join (select account_id, count(*) n from public.pb_contact_events group by 1) c
      on c.account_id = g.id
   order by g.norm_name, coalesce(c.n, 0) desc, length(g.name) desc, g.name
),
roll as (
  select g.norm_name,
         count(*)                                                   as records,
         array_agg(g.id order by g.name)                            as account_ids,
         string_agg(g.name, ' | ' order by g.name)                  as record_names,
         -- distinct orbit ids: two records pointing at one delivery client is not two projects
         coalesce((select sum(oc.active_projects)
                     from public.pb_orbit_clients oc
                    where oc.orbit_id in (
                      select distinct g2.orbit_client_id from grp g2
                       where g2.norm_name = g.norm_name and g2.orbit_client_id is not null)), 0)
                                                                    as active_projects,
         nullif(string_agg(distinct nullif(cr.effective_tier,''), ' / '), '')     as tiers,
         nullif(string_agg(distinct nullif(g.status,''), ' / '), '')              as account_status
    from grp g
    left join public.pb_current_reads cr on cr.account_id = g.id
   group by g.norm_name
),
labels as (
  select g.norm_name,
         nullif(string_agg(distinct f.value #>> '{}', ' / '), '')    as cj_stage,
         nullif(string_agg(distinct e.stage_label, ' / '), '')       as crm_urgency
    from grp g
    left join public.pb_current_facts f
      on f.account_id = g.id and f.key = 'pipedrive_cj_stage'
    left join public.pb_engagement e on e.account_id = g.id
   group by g.norm_name
),
mdm as (
  select public.pb_norm_company(canonical_name) as norm_name,
         case when bool_or(entity_type = 'client') then 'client'
              else min(entity_type) end as entity_type
    from public.pb_mdm_resolution
   group by public.pb_norm_company(canonical_name)
),
sig as (
  select r.norm_name, l.display_name as name, l.lead_account_id as account_id,
         r.records, r.record_names, r.account_ids, r.active_projects,
         r.tiers, r.account_status, lb.cj_stage, lb.crm_urgency,
         m.entity_type,
         ce.engagement, ce.quote_state, ce.last_engaged, ce.last_contact,
         ce.last_quote, ce.channels,
         (ce.quote_state = 'quote_open')                  as f_quote_open,
         (ce.engagement  = 'engaged')                     as f_engaged,
         (ce.engagement  = 'responsive')                  as f_responsive,
         (ce.quote_state = 'quoted_recently')             as f_quoted_recently,
         (r.active_projects > 0)                          as f_delivering,
         (ce.last_call is not null)                       as f_met,
         (ce.engagement  = 'fading')                      as f_fading,
         (coalesce(ce.channels, 0) > 1)                   as f_multi,
         (ce.engagement  = 'pursued')                     as f_pursued_no_reply,
         (ce.engagement  = 'dormant')                     as f_dormant
    from roll r
    join lead_rec l on l.norm_name = r.norm_name
    left join labels lb on lb.norm_name = r.norm_name
    left join mdm m on m.norm_name = r.norm_name
    left join public.pb_company_engagement ce on ce.norm_name = r.norm_name
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
  account_id, norm_name, name, score,
  dense_rank() over (order by score desc) as rank_band,
  row_number()  over (order by score desc, last_engaged desc nulls last, name) as chase_rank,
  case when active_projects = 0 then
    row_number() over (partition by (active_projects = 0)
                       order by score desc, last_engaged desc nulls last, name)
  end as new_logo_rank,
  engagement, quote_state, entity_type, active_projects,
  tiers as effective_tier, cj_stage, crm_urgency, account_status,
  records, case when records > 1 then record_names end as duplicate_records, account_ids,
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
  'Chase order over every COMPANY in the book, scored from recorded contact rather than a CRM '
  'label. One row per normalised company name: two account records for one company have their '
  'contact events unioned before engagement is derived, so a split relationship stops being two '
  'weak rows. `records` and `duplicate_records` keep the duplication visible; the merge itself is '
  'still a person''s call (rule 8, pb_duplicate_accounts). Two ranks over identical evidence: '
  'chase_rank over everyone, new_logo_rank over companies with no active delivery work. Weights '
  'are data (pb_chase_weights). Both stage labels are carried at zero points — cj_stage is the '
  'Pipedrive pipeline stage, crm_urgency is the Hot/Warm/Cold read. DECISIONS §26, §30, §31.';

revoke all on public.pb_chase_board from anon, authenticated;
