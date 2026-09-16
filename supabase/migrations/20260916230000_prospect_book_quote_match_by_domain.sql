-- A quote whose client name IS the account's domain.
--
-- The quote sweep (§29) joins the delivery system's spelling to the book's by normalised name,
-- and reports what it cannot match rather than dropping it. Three names were left. One of them is
-- not a spelling variant at all: the delivery system carries the company under its DOMAIN instead
-- of its name, so no amount of name normalisation will ever reach it.
--
-- An exact domain match is the `high` confidence bar rule 8 sets, and it is the same test the
-- Fathom webhook already applies to decide which account a call belongs to. So it joins, as a
-- RULE rather than as a hand-entered alias row: nothing here asserts that two names mean the same
-- company, only that a string which is exactly an account's domain identifies that account.
--
-- The other two unmatched names stay unmatched, deliberately. One is a one-character typo in the
-- source and one is a parenthetical naming the agency behind a sub-brand. Both are probably right
-- and neither is mechanical, so both remain in pb_orbit_quote_unmatched for a person to rule on.
-- A regex loose enough to catch a typo is loose enough to merge two companies that differ by a
-- letter, and the book would never know which it had done.
create or replace view public.pb_orbit_quote_unmatched as
select q.client_name, q.last_quoted
from public.pb_orbit_quote_sweep q
where not exists (
  select 1 from public.pb_accounts a
  where public.pb_norm_company(a.name) = public.pb_norm_company(q.client_name)
     or lower(a.domain) = lower(q.client_name)
);

comment on view public.pb_orbit_quote_unmatched is
  'Quoted companies whose delivery-system name matches no account, by normalised name or by exact '
  'domain. Never dropped silently — a person rules on what is left.';

revoke all on public.pb_orbit_quote_unmatched from anon, authenticated;

create or replace function public.pb_contact_events_from_quotes()
returns table (inserted integer, matched_accounts integer, unmatched_names integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after  integer;
  v_accts  integer;
  v_unm    integer;
begin
  select count(*) into v_before from public.pb_contact_events where channel = 'quote';

  insert into public.pb_contact_events
    (account_id, occurred_at, channel, direction, source, counterparty, subject, fingerprint)
  select a.id, q.last_quoted, 'quote', 'outbound', 'orbit', q.client_name, null,
         'quote:' || a.id::text || ':' ||
           to_char(q.last_quoted at time zone 'UTC', 'YYYY-MM-DD')
    from public.pb_orbit_quote_sweep q
    join public.pb_accounts a
      on public.pb_norm_company(a.name) = public.pb_norm_company(q.client_name)
      or lower(a.domain) = lower(q.client_name)
  on conflict (fingerprint) do nothing;

  select count(*) into v_after from public.pb_contact_events where channel = 'quote';
  select count(distinct account_id) into v_accts
    from public.pb_contact_events where channel = 'quote';
  select count(*) into v_unm from public.pb_orbit_quote_unmatched;

  return query select v_after - v_before, v_accts, v_unm;
end;
$$;

revoke all on function public.pb_contact_events_from_quotes() from anon, authenticated;
