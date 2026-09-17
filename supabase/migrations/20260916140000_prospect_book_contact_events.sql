-- WLIQ Prospect Book — engagement is contact, not a dropdown. (Owner ruling, 16 Sep 2026.)
--
-- Until now `urgency` came from a Pipedrive stage label: "Super Hot", "Sales Call Done", "Cold".
-- It is the heaviest input in every chase ordering, and it is a field a person last touched at an
-- unknown date for an unknown reason. The owner, 16 September: *"for 5 and the stage labels, yes
-- make this change, it does not seem accurate."*
--
-- What it costs to be wrong, measured on this book:
--
--   * one account read Cold while the owner was in active conversation with them
--   * one read Hot for three months while it was being delivered — they had ended the relationship
--   * 22 of the top 60 sat at "Sales Call Done" with no call on file at all
--   * one has been "Super Hot" for seven months with nothing recorded behind it
--
-- `pb_contact_events` is the fix: one row per *recorded* contact, whatever the channel — a call
-- in `pb_calls`, an email thread, a CRM note, a quote raised in the delivery system. It is an
-- observation with a date and a direction, never a judgement. Engagement is then derived from it
-- (`pb_engagement`), and the stage label becomes a tiebreak rather than the answer.
--
-- Three properties this has that a stage label does not:
--
--   1. it has a DATE, so it can decay honestly rather than sitting Hot forever;
--   2. it has a DIRECTION, so "they replied" outranks "we sent";
--   3. it has a SOURCE and an external id, so any row can be traced back and re-checked.
--
-- Rule 5 still holds: no contact recorded is not evidence of a cold account, it is absence of
-- evidence. `pb_engagement` says `unknown`, never `cold`, when nothing is on file — the two are
-- different and the old label conflated them.
--
-- Rule 6 also holds: nothing here writes `pb_reads`. pb-score reads this view; the nightly run
-- still computes the grade.

create table if not exists public.pb_contact_events (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.pb_accounts(id) on delete cascade,
  occurred_at   timestamptz not null,
  channel       text not null check (channel in
                  ('call','email','crm_note','quote','meeting_invite','delivery')),
  direction     text not null check (direction in ('inbound','outbound','mutual')),
  -- 'mutual' is a meeting: both sides showed up, which is stronger than either alone.
  source        text not null,          -- gmail · fathom · pipedrive · orbit
  source_id     text,                   -- thread id, recording id, note id, project id
  counterparty  text,                   -- the external address or name, never a WLIQ one
  subject       text,
  observed_at   timestamptz not null default now(),
  -- One row per (source, source_id, occurred_at): re-running a sweep adds nothing twice.
  fingerprint   text not null unique
);

comment on table public.pb_contact_events is
  'One recorded contact with an account: a call, an email, a note, a quote. Dated and directional. Engagement is derived from these, never from a CRM stage label (DECISIONS, 16 Sep 2026).';

create index if not exists pb_contact_events_account_time
  on public.pb_contact_events (account_id, occurred_at desc);
create index if not exists pb_contact_events_channel
  on public.pb_contact_events (channel, occurred_at desc);

alter table public.pb_contact_events enable row level security;

-- CLAUDE.md: a new pb_ table arrives with anon AND authenticated holding everything. Both revoked.
revoke all on public.pb_contact_events from anon, authenticated;
grant select on public.pb_contact_events to authenticated;

drop policy if exists pb_contact_events_select on public.pb_contact_events;
create policy pb_contact_events_select on public.pb_contact_events
  for select to authenticated using (true);

/**
 * Engagement, derived.
 *
 * `last_*` are observations. `engagement` is the label the rubric will read, and it is deliberately
 * conservative: a reply from them beats anything we sent, a meeting beats an email, and silence
 * is `unknown` rather than `cold` (rule 5).
 */
create or replace view public.pb_engagement
with (security_invoker = true) as
with ev as (
  select e.account_id,
         max(e.occurred_at)                                              as last_contact,
         max(e.occurred_at) filter (where e.direction = 'inbound')       as last_inbound,
         max(e.occurred_at) filter (where e.direction = 'outbound')      as last_outbound,
         max(e.occurred_at) filter (where e.channel in ('call','meeting_invite')) as last_meeting,
         max(e.occurred_at) filter (where e.channel = 'quote')           as last_quote,
         count(*)                                                        as events,
         count(*) filter (where e.direction = 'inbound')                 as inbound_events,
         count(distinct e.channel)                                       as channels
    from public.pb_contact_events e
   group by e.account_id
)
select a.id as account_id,
       a.name,
       ev.last_contact, ev.last_inbound, ev.last_outbound, ev.last_meeting, ev.last_quote,
       coalesce(ev.events, 0)         as events,
       coalesce(ev.inbound_events, 0) as inbound_events,
       coalesce(ev.channels, 0)       as channels,
       (now()::date - ev.last_contact::date) as days_since_contact,
       (now()::date - ev.last_inbound::date) as days_since_reply,
       case
         when ev.last_contact is null then 'unknown'
         -- They came back to us recently. The strongest thing an account can do.
         when ev.last_inbound >= now() - interval '30 days'  then 'engaged'
         when ev.last_inbound >= now() - interval '90 days'  then 'responsive'
         -- We are talking at them and they have not answered.
         when ev.last_outbound >= now() - interval '30 days' then 'pursued'
         when ev.last_contact  >= now() - interval '180 days' then 'fading'
         else 'dormant'
       end as engagement,
       -- What the CRM believed, kept alongside so the two can be compared rather than swapped.
       (select r.urgency from public.pb_reads r
         where r.account_id = a.id order by r.as_of desc limit 1) as stage_label
  from public.pb_accounts a
  left join ev on ev.account_id = a.id;

comment on view public.pb_engagement is
  'Engagement derived from recorded contact: engaged / responsive / pursued / fading / dormant, or unknown when nothing is on file. Never cold-by-default — absence of contact is not evidence of a cold account (rule 5). stage_label carries what the CRM believed, for comparison.';
