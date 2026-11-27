-- WLIQ Prospect Book — the outreach guard, and the roster certified only from the Client Journey (DECISIONS §70).
--
-- A second system shares this database: an OpenAI-built pipeline that screens a ~72,000-row LinkedIn
-- export and a New York review queue in schema prospect_intake (and in Notion). It is cold outreach to
-- people who may never have heard of WLIQ. The book is the opposite: the Pipedrive roster, most of it on
-- the Client Journey pipeline as sales-qualified leads. On 27 Nov 14 of the queue's ~1,880 companies were
-- already book accounts and 9 were WLIQ clients (4 delivering). Nothing told the queue so.
--
-- 1 · pb_outreach_guard — every company the book or Orbit knows, with a status and a plain instruction,
--     for ANY outreach pipeline to check before contact. It reads only book objects; it writes nothing
--     and it is not an admission path. A materialised view refreshed each morning after the roster crawl,
--     because the Orbit match underneath (pb_orbit_overlap) costs ~5 s on this shared CPU and a pipeline
--     checking lead by lead must not pay that per lead. Statuses, the first that holds:
--       do_not_contact   the owner removed it with disposition do_not_contact (§50)
--       client_active    Orbit shows active projects, or its Client Journey card is Active Client
--       client_former    Inactive / Past / Lost Client card, or known to Orbit with no active project
--       friends          Friends of WLIQ
--       unqualified_dnc  Client Journey card Unqualified/DNC, or the parked book
--       removed          any other owner removal
--       sales_pipeline   a Client Journey card at New, Schedule Sales Call, Sales Call Done, Quoting or
--                        Quote Lost: a sales-qualified lead the team is working
--       in_book_no_stage on the book with no Client Journey card
--     Every status means "not a cold lead". Matching is by domain, else by pb_norm_company(name); a match
--     on one common word ("brand", "amplify") is weak and needs a person. The Orbit side is the 16 Sep
--     snapshot (pb_orbit_clients), never refreshed — read orbit_snapshot_at.
--
-- 2 · pb_certify_from_roster_cards() — PRO-6 makes the Client Journey pipeline the roster. From §70 the
--     Pipedrive webhook creates a new organisation UNCERTIFIED (anyone, or any system, can add an
--     organisation to Pipedrive); this certifies a pipedrive-sourced account the morning its org has a
--     card in pb_roster_cards, the crawl pb-roster-begin fills 05:00–05:10. It only ever certifies.
--
-- 3 · cron pb-roster-guard 05:14 UTC: certify, then refresh the guard. After pb-roster-report (05:12)
--     and pb-nightly-attribution (05:13), before the notes sweep (05:15) and the score (06:15).

-- 1 · the guard ----------------------------------------------------------------------------------
drop materialized view if exists public.pb_outreach_guard;

create materialized view public.pb_outreach_guard as
with card as (
  select distinct on (c.org_id) c.org_id, c.stage_id, c.status, c.crawled_at
    from public.pb_roster_cards c
   order by c.org_id, (c.status = 'open') desc, c.update_time desc nulls last
),
ovr as materialized (
  select account_id, orbit_id, active_projects from public.pb_orbit_overlap
),
ov as (
  select account_id, max(coalesce(active_projects, 0)) as active from ovr group by account_id
),
g as (
  select 'acct:' || a.id::text                 as guard_key,
         a.id                                  as account_id,
         null::integer                         as orbit_id,
         a.name,
         nullif(lower(a.domain), '')           as domain,
         public.pb_norm_company(a.name)        as norm_name,
         a.book,
         a.roster_certified,
         card.stage_id,
         card.status                           as card_status,
         coalesce(ov.active, 0)                as orbit_active_projects,
         (ov.account_id is not null)           as in_orbit,
         rm.disposition                        as removal
    from public.pb_accounts a
    left join card on card.org_id = a.pipedrive_org_id
    left join ov   on ov.account_id = a.id
    left join public.pb_removals rm on rm.account_id = a.id
   where a.merged_into is null
  union all
  select 'orbit:' || oc.orbit_id::text, null, oc.orbit_id, oc.company_name,
         nullif(lower(oc.domain), ''), public.pb_norm_company(oc.company_name),
         null, null, null, null, coalesce(oc.active_projects, 0), true, null
    from public.pb_orbit_clients oc
   where not exists (select 1 from ovr where ovr.orbit_id = oc.orbit_id)
),
s as (
  select g.*,
         case
           when removal = 'do_not_contact'                       then 'do_not_contact'
           when orbit_active_projects > 0 or stage_id = 63       then 'client_active'
           when stage_id in (64, 65, 67) or in_orbit             then 'client_former'
           when stage_id = 69                                    then 'friends'
           when stage_id = 66 or book = 'parked'                 then 'unqualified_dnc'
           when removal is not null                              then 'removed'
           when stage_id in (57, 58, 59, 70, 71)                 then 'sales_pipeline'
           else                                                       'in_book_no_stage'
         end as guard_status
    from g
)
select s.guard_key,
       s.guard_status,
       case s.guard_status
         when 'do_not_contact'   then 'The owner removed this agency with "do not contact". No outreach of any kind.'
         when 'client_active'    then 'A current WLIQ client. Never cold outreach; anything goes through its account manager.'
         when 'client_former'    then 'A former client, or a company Orbit knows with no active project. A warm conversation through the owner, never cold outreach.'
         when 'friends'          then 'Friends of WLIQ. Not a sales target; ask the owner first.'
         when 'unqualified_dnc'  then 'Unqualified / do not contact on the Client Journey. No outreach.'
         when 'removed'          then 'The owner took this agency off the board. No outreach without the owner.'
         when 'sales_pipeline'   then 'On the Client Journey at ' || coalesce(public.pb_cj_stage_name(s.stage_id), 'a sales stage') || ': a sales-qualified lead the team is working. Route to its deal owner; never cold outreach.'
         else                         'In the Prospect Book with no Client Journey card: known to the team, not cold. Check with sales before any contact.'
       end                                         as guard_reason,
       s.name,
       s.domain,
       s.norm_name,
       s.account_id,
       s.orbit_id,
       public.pb_cj_stage_name(s.stage_id)         as sales_stage,
       s.card_status,
       s.book,
       s.roster_certified,
       s.orbit_active_projects,
       (select max(crawled_at) from public.pb_roster_cards)      as cards_crawled_at,
       (select max(observed_at) from public.pb_orbit_clients)    as orbit_snapshot_at,
       now()                                                      as refreshed_at
  from s;

create unique index pb_outreach_guard_key_idx    on public.pb_outreach_guard (guard_key);
create index        pb_outreach_guard_domain_idx on public.pb_outreach_guard (domain);
create index        pb_outreach_guard_name_idx   on public.pb_outreach_guard (norm_name);

-- A new relation arrives holding everything for anon AND authenticated (CLAUDE.md, Supabase). The guard
-- names companies; it is for operators and outreach pipelines, never a public read.
revoke all on public.pb_outreach_guard from public, anon, authenticated;

comment on materialized view public.pb_outreach_guard is
  'Every company the Prospect Book or Orbit knows, with guard_status and a plain instruction, for any outreach pipeline (the prospect_intake NYC screening first) to check BEFORE contact: match on domain, else norm_name = pb_norm_company(name). Every status means "not a cold lead". Read-only; not an admission path; no API role may read it. Refreshed 05:14 UTC by pb-roster-guard; a removal made today appears tomorrow unless refreshed by hand. Orbit side is the 16 Sep snapshot (orbit_snapshot_at). DECISIONS §70.';

-- 2 · certification from the Client Journey ------------------------------------------------------
create or replace function public.pb_certify_from_roster_cards() returns integer
language sql volatile security invoker set search_path = public as
$$
  with certified as (
    update public.pb_accounts a
       set roster_certified = true
     where a.merged_into is null
       and a.roster_certified = false
       and a.roster_source = 'pipedrive'
       and a.pipedrive_org_id is not null
       and exists (select 1 from public.pb_roster_cards c where c.org_id = a.pipedrive_org_id)
    returning a.id
  )
  select count(*)::integer from certified;
$$;
revoke all on function public.pb_certify_from_roster_cards() from public, anon, authenticated;

comment on function public.pb_certify_from_roster_cards() is
  'Certifies a pipedrive-sourced account (roster_certified = true) once its organisation has a Client Journey card in pb_roster_cards. The Pipedrive webhook creates new organisations uncertified (DECISIONS §70); PRO-6 makes the Client Journey the roster. Only ever certifies; returns how many. Run by cron pb-roster-guard.';

-- 3 · the schedule -------------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'pb-roster-guard';
select cron.schedule('pb-roster-guard', '14 5 * * *',
  $cron$select public.pb_certify_from_roster_cards(); refresh materialized view concurrently public.pb_outreach_guard;$cron$);