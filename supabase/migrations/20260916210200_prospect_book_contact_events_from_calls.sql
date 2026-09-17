-- Contact events for every attributed call that does not have one yet. A recorded call is
-- `mutual` by construction (DECISIONS §24 — the first cut of pb_engagement tested
-- direction = 'inbound' and read an account with 19 recorded calls as merely `pursued`,
-- because a call is neither inbound nor outbound: both sides were there).
--
-- Fingerprint is the call's own id, which is stable and unique, so this is idempotent and cannot
-- collide with the earlier ad-hoc backfill of the 161 originally-attributed calls — those carry
-- a different fingerprint and are matched here by (account_id, channel, occurred_at) instead,
-- so they are not duplicated either.
create or replace function public.pb_contact_events_from_calls()
returns table (inserted integer, accounts_touched integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after  integer;
  v_accts  integer;
begin
  select count(*) into v_before from public.pb_contact_events where channel = 'call';

  insert into public.pb_contact_events
    (account_id, occurred_at, channel, direction, source, counterparty, subject, fingerprint)
  select c.account_id, c.held_at, 'call', 'mutual', 'fathom',
         (select lower(regexp_replace(d, '^www\.', ''))
            from unnest(c.external_domains) d limit 1),
         c.title,
         'call:' || c.id::text
    from public.pb_calls c
   where c.account_id is not null
     and c.held_at is not null
     and not exists (
       select 1 from public.pb_contact_events e
        where e.account_id = c.account_id
          and e.channel = 'call'
          and e.occurred_at = c.held_at
     )
  on conflict (fingerprint) do nothing;

  select count(*) into v_after from public.pb_contact_events where channel = 'call';
  select count(distinct account_id) into v_accts
    from public.pb_contact_events where channel = 'call';

  return query select v_after - v_before, v_accts;
end;
$$;

revoke all on function public.pb_contact_events_from_calls() from anon, authenticated;
