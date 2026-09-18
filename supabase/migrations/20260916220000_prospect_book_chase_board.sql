-- SUPERSEDED — NOT WHAT RAN. This file was written by the 16 September session on branch
-- claude/new-session-glwxzh and never applied under this name; the database ran
--   20260916142134_prospect_book_chase_board_v2.sql (then _dedupe_registry_join, then _new_logo_rank_v2)
-- instead. Kept because it is what that session wrote and the reasoning in it is real, but
-- the filed version above is the one that is live. DECISIONS §45.

-- The chase board, rebuilt on evidence (DECISIONS §30).
--
-- The old chase list ranked the 146 accounts that happened to have been researched, on a CRM
-- stage that turns out not to predict contact at all. Of the 184 accounts sitting in "Schedule
-- Sales Call", 7 are in live contact and 140 have nothing recorded against them ever; 155 sit in
-- "Sales Call Done" with 67 in the same state. The stage was ranking the book's own filing, not
-- the prospect's interest. 20 of that old top 100 survive into this one.
--
-- This ranks all 849 on what is now recorded: who replied, who has a quote out, who we are
-- already delivering for. The owner's rulings (§26) are the ordering:
--   * an OPEN QUOTE is the hottest state an account can be in;
--   * a client is still a prospect — delivery is a relationship, not a disqualification, and the
--     handover to an account manager is the moment to nurture hardest, not to stop;
--   * a LOST or old quote is still a signal, "a no is a positive sign";
--   * a stage label means nothing unless a person confirmed it, so it scores ZERO here.
--
-- The stage is still CARRIED, at zero points, because a board that hides the number it refuses to
-- use cannot be argued with. It is `cj_stage`, read from the `pipedrive_cj_stage` fact — NOT from
-- pb_accounts.status, which is the book's own lifecycle (Ranked / Unclassified / Merged / Parked)
-- and is surfaced separately as `account_status`. The first cut of this view named the second one
-- `stage_label` and so reported its own headline finding against the wrong column.
--
-- WEIGHTS ARE DATA, not SQL (rule 4). They live in pb_chase_weights, versioned, so changing the
-- order of the chase is an edit to a table and a new version — never an edit to this view.
--
-- TWO RANKS OVER ONE SET OF EVIDENCE. Ranked purely on contact, 91 of the top 100 are companies
-- we already deliver for — the ruling working as stated, not a bug. But "who do I call today" and
-- "where does the next logo come from" are different questions, and a board that only knows the
-- first will quietly starve the second. So new_logo_rank ranks the same score over accounts with
-- no active delivery work. Both live in the view; neither is a filter someone has to remember.
--
-- ONE ROW PER ACCOUNT. pb_mdm_resolution is per RECORD, not per company, so joining it directly
-- fans accounts out — the first cut returned 852 rows for 849 accounts with one company twice in
-- the top ten. A fan-out inside a ranked list is the worst shape of bug: the total is barely off,
-- the duplicates sort next to each other so they read as a tie, and the thing being multiplied is
-- the thing being counted. The registry is collapsed per company first.
create table if not exists public.pb_chase_weights (
  weights_version text    not null,
  signal          text    not null,
  points          integer not null,
  note            text    not null,
  active          boolean not null default false,
  primary key (weights_version, signal)
);

revoke all on public.pb_chase_weights from anon, authenticated;
alter table public.pb_chase_weights enable row level security;

insert into public.pb_chase_weights (weights_version, signal, points, note, active) values
 ('chase-evidence-0.1','quote_open',        50, 'Quote out within 60 days — the hottest state an account can be in (owner, §26)', true),
 ('chase-evidence-0.1','engaged',           40, 'They replied within 30 days', true),
 ('chase-evidence-0.1','responsive',        25, 'They replied within 90 days', true),
 ('chase-evidence-0.1','quoted_recently',   20, 'Quoted within 180 days — including a no, which is still a signal (owner, §26)', true),
 ('chase-evidence-0.1','delivering',        18, 'Active work in the delivery system — nurture hardest at handover (owner, §26)', true),
 ('chase-evidence-0.1','met_in_person',     12, 'A recorded call exists: they gave us time', true),
 ('chase-evidence-0.1','fading',             8, 'Contact in the last 180 days but no recent reply — re-engage', true),
 ('chase-evidence-0.1','multi_channel',      6, 'Reached on more than one channel', true),
 ('chase-evidence-0.1','pursued_no_reply',  -5, 'We have written and they have never answered', true),
 ('chase-evidence-0.1','dormant',          -10, 'Contact exists but nothing for six months', true),
 ('chase-evidence-0.1','stage_label',        0, 'Deliberately zero: the CRM stage label is unconfirmed and does not predict contact (§26)', true)
on conflict (weights_version, signal) do update
  set points = excluded.points, note = excluded.note, active = excluded.active;

-- One row of weights, so the board reads them as scalars. `filter` attaches only to an aggregate,
-- never to a scalar subquery — which is what the first version of the board got wrong.
create or replace view public.pb_chase_weights_active as
select
  max(points) filter (where signal = 'quote_open')       as w_quote_open,
  max(points) filter (where signal = 'engaged')          as w_engaged,
  max(points) filter (where signal = 'responsive')       as w_responsive,
  max(points) filter (where signal = 'quoted_recently')  as w_quoted_recently,
  max(points) filter (where signal = 'delivering')       as w_delivering,
  max(points) filter (where signal = 'met_in_person')    as w_met,
  max(points) filter (where signal = 'fading')           as w_fading,
  max(points) filter (where signal = 'multi_channel')    as w_multi,
  max(points) filter (where signal = 'pursued_no_reply') as w_pursued,
  max(points) filter (where signal = 'dormant')          as w_dormant
from public.pb_chase_weights where active;

revoke all on public.pb_chase_weights_active from anon, authenticated;

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
    a.status                                        as account_status,
    (select f.value #>> '{}' from public.pb_current_facts f
      where f.account_id = a.id and f.key = 'pipedrive_cj_stage') as cj_stage,
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
  effective_tier, confidence, cj_stage, account_status,
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
  'The CRM stage is carried as cj_stage and scores zero on purpose; account_status is the book''s '
  'own lifecycle, which is a different column and not a stage. DECISIONS §26, §30.';

revoke all on public.pb_chase_board from anon, authenticated;
