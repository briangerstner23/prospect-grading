-- WLIQ Prospect Book — filed verbatim from supabase_migrations.schema_migrations on 17 Sep 2026.
-- Applied 20260916142220 as "prospect_book_chase_board_dedupe_registry_join" by the 16 September session, which pushed its work to its own
-- branch and never filed this one. Recovered with the branch merge; see DECISIONS §32 for the
-- precedent and §39 for why eleven branches existed. Byte-for-byte what ran; do not re-edit here.

-- The chase board returned 852 rows for 849 accounts, and one company appeared twice in the top
-- ten. pb_mdm_resolution carries one row per RECORD, not per company, so a left join on the
-- company name multiplies the account. A fan-out in a ranked list is the worst shape of bug:
-- the total is only three off, the duplicates sit next to each other so they look like a sort
-- quirk, and the thing being multiplied is the thing being counted.
--
-- Fixed by collapsing the registry to one row per normalised name before joining. Where a
-- company's records disagree on entity_type the view keeps the strongest claim — 'client' — so
-- the board never quietly downgrades a company we are actually delivering for.
create or replace view public.pb_chase_board as
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
  'zero on purpose. One row per account — the registry is collapsed per company first, because '
  'pb_mdm_resolution is per record and fans out. DECISIONS §26, §30.';

revoke all on public.pb_chase_board from anon, authenticated;

-- The duplicate account records that keep surfacing — in call attribution (§29), in the quote
-- name join, and now in the chase board. They are one company entered twice, and every pass over
-- the book has to work around them. Naming them once, so a person can merge them.
create or replace view public.pb_duplicate_accounts as
select
  public.pb_norm_company(name) as norm_name,
  count(*)                     as records,
  string_agg(name, ' | ' order by name)                    as names,
  string_agg(coalesce(domain,'(none)'), ' | ' order by name) as domains,
  string_agg(roster_source, ' | ' order by name)           as sources
from public.pb_accounts
group by public.pb_norm_company(name)
having count(*) > 1;

comment on view public.pb_duplicate_accounts is
  'One company, more than one account record. Merging is an identity decision (rule 8) — this '
  'view proposes, a person decides.';

revoke all on public.pb_duplicate_accounts from anon, authenticated;
