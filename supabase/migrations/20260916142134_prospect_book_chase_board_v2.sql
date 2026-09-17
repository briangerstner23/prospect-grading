-- WLIQ Prospect Book — filed verbatim from supabase_migrations.schema_migrations on 17 Sep 2026.
-- Applied 20260916142134 as "prospect_book_chase_board_v2" by the 16 September session, which pushed its work to its own
-- branch and never filed this one. Recovered with the branch merge; see DECISIONS §32 for the
-- precedent and §39 for why eleven branches existed. Byte-for-byte what ran; do not re-edit here.

-- The chase board, rebuilt on evidence (DECISIONS §30).
--
-- The old chase list ranked 146 accounts that happened to have been researched, on a stage label
-- that turned out to mean nothing: of 62 accounts marked Hot or Super Hot, 5 were in live contact
-- and 30 had nothing recorded at all; of 458 marked Cold, 17 were in live contact. The label was
-- ranking the book's attention, not the prospect's interest.
--
-- This ranks all 849 on what is now recorded: who replied, who has a quote out, who we are
-- already delivering for. The owner's rulings (§26) are the ordering:
--   * an OPEN QUOTE is the hottest state an account can be in;
--   * a client is still a prospect — delivery is a relationship, not a disqualification, and the
--     handover to an account manager is the moment to nurture hardest, not to stop;
--   * a LOST or old quote is still a signal, "a no is a positive sign";
--   * a stage label means nothing unless a person confirmed it, so it scores ZERO here.
--
-- WEIGHTS ARE DATA, not SQL (rule 4). They live in pb_chase_weights, versioned, so changing the
-- order of the chase is an edit to a table and a new version — never an edit to this view.
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

-- One row of weights, so the view can read them as scalars without a correlated subquery per
-- account. `filter` does not attach to a scalar subquery — only to an aggregate — which is what
-- the first version of this view got wrong.
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

create or replace view public.pb_chase_board as
with sig as (
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
  left join public.pb_engagement       e  on e.account_id  = a.id
  left join public.pb_engagement_shape s  on s.account_id  = a.id
  left join public.pb_orbit_clients    oc on oc.orbit_id   = a.orbit_client_id
  left join public.pb_mdm_resolution   m  on public.pb_norm_company(m.canonical_name)
                                           = public.pb_norm_company(a.name)
  left join public.pb_current_reads    r  on r.account_id  = a.id
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
  'Chase order over every account, scored from recorded contact rather than CRM stage. Weights '
  'are data (pb_chase_weights), not SQL. The stage label is carried for comparison and scores '
  'zero on purpose — DECISIONS §26, §30.';

revoke all on public.pb_chase_board from anon, authenticated;
