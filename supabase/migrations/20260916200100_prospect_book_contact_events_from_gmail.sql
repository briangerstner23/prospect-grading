-- Turn the email sweep into contact events. The join is on pb_accounts.domain, in the
-- database, because the one time this book matched companies to domains by hand it produced
-- a wrong number in a headline (20260916180000).
--
-- Two events per account at most: the newest message FROM them (inbound — they answered) and
-- the newest message TO them (outbound — we chased). That is all engagement recency needs,
-- and it is all the sweep can honestly claim: page-1 results, so a missing date means nothing
-- recent was found, never that nothing exists (pb_gmail_sweep.truncated is true on every row).
create or replace function public.pb_contact_events_from_gmail()
returns table (inserted integer, matched_accounts integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after  integer;
  v_accts  integer;
begin
  select count(*) into v_before from public.pb_contact_events where source = 'gmail';

  with m as (
    select a.id as account_id, s.last_inbound, s.last_outbound
    from public.pb_accounts a
    join public.pb_gmail_sweep s
      on s.domain = lower(regexp_replace(a.domain, '^www\.', ''))
    where a.domain is not null and a.domain <> ''
  ),
  ev as (
    select account_id, last_inbound as occurred_at, 'inbound' as direction from m
    where last_inbound is not null
    union all
    select account_id, last_outbound, 'outbound' from m
    where last_outbound is not null
  )
  insert into public.pb_contact_events
    (account_id, occurred_at, channel, direction, source, counterparty, subject, fingerprint)
  select account_id, occurred_at, 'email', direction, 'gmail', null, null,
         'gmail:' || account_id::text || ':' || direction || ':' ||
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from ev
  on conflict (fingerprint) do nothing;

  select count(*) into v_after from public.pb_contact_events where source = 'gmail';
  select count(distinct a.id) into v_accts
  from public.pb_accounts a
  join public.pb_gmail_sweep s on s.domain = lower(regexp_replace(a.domain, '^www\.', ''));

  return query select v_after - v_before, v_accts;
end;
$$;

comment on function public.pb_contact_events_from_gmail() is
  'Derives email contact events from pb_gmail_sweep by joining on pb_accounts.domain. '
  'Idempotent on the fingerprint; re-run after each sweep pass.';

revoke all on function public.pb_contact_events_from_gmail() from anon, authenticated;
