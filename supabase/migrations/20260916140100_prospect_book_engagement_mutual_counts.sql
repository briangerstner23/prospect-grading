-- A meeting they attended is them engaging.
--
-- The first cut of pb_engagement tested `direction = 'inbound'` for "they came back to us". A
-- recorded call is stored as `mutual` — both sides showed up — so an account with nineteen calls
-- and no email read as `pursued`, which is exactly the false-negative this view exists to remove.
-- Attending a call is at least as strong as replying to an email, so both count.
--
-- Kept separate in the output: `last_reply` is what they wrote back, `last_engaged` is the
-- stronger of a reply and a meeting. The rubric reads `engagement`; a reviewer can see both.

drop view if exists public.pb_engagement;

create view public.pb_engagement
with (security_invoker = true) as
with ev as (
  select e.account_id,
         max(e.occurred_at)                                              as last_contact,
         max(e.occurred_at) filter (where e.direction = 'inbound')       as last_reply,
         max(e.occurred_at) filter (where e.direction in ('inbound','mutual')) as last_engaged,
         max(e.occurred_at) filter (where e.direction = 'outbound')      as last_outbound,
         max(e.occurred_at) filter (where e.channel in ('call','meeting_invite')) as last_meeting,
         max(e.occurred_at) filter (where e.channel = 'quote')           as last_quote,
         count(*)                                                        as events,
         count(*) filter (where e.direction in ('inbound','mutual'))     as engaged_events,
         count(distinct e.channel)                                       as channels
    from public.pb_contact_events e
   group by e.account_id
)
select a.id as account_id,
       a.name,
       ev.last_contact, ev.last_reply, ev.last_engaged, ev.last_outbound,
       ev.last_meeting, ev.last_quote,
       coalesce(ev.events, 0)         as events,
       coalesce(ev.engaged_events, 0) as engaged_events,
       coalesce(ev.channels, 0)       as channels,
       (now()::date - ev.last_contact::date) as days_since_contact,
       (now()::date - ev.last_engaged::date) as days_since_engaged,
       case
         when ev.last_contact is null then 'unknown'
         when ev.last_engaged  >= now() - interval '30 days'  then 'engaged'
         when ev.last_engaged  >= now() - interval '90 days'  then 'responsive'
         when ev.last_outbound >= now() - interval '30 days'  then 'pursued'
         when ev.last_contact  >= now() - interval '180 days' then 'fading'
         else 'dormant'
       end as engagement,
       (select r.urgency from public.pb_reads r
         where r.account_id = a.id order by r.as_of desc limit 1) as stage_label
  from public.pb_accounts a
  left join ev on ev.account_id = a.id;

comment on view public.pb_engagement is
  'Engagement derived from recorded contact: engaged / responsive / pursued / fading / dormant, or unknown when nothing is on file. A reply OR a meeting they attended counts as engaging; sending at them does not. Never cold-by-default — absence of contact is not evidence of a cold account (rule 5). stage_label carries what the CRM believed, for comparison.';
