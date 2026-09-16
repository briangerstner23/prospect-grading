-- Quote events from the delivery-system sweep. Direction is `outbound`: a quote is us reaching
-- toward them. That matters for pb_engagement, which counts a reply (inbound or mutual) as
-- engagement and an outbound-only account as merely `pursued` — correctly. A quote nobody
-- answered is pursuit, not a relationship. What makes the quote hot is pb_engagement_shape's
-- quote_state (§26), which reads the same event and asks how recent it is.
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
  on conflict (fingerprint) do nothing;

  select count(*) into v_after from public.pb_contact_events where channel = 'quote';
  select count(distinct account_id) into v_accts
    from public.pb_contact_events where channel = 'quote';
  select count(*) into v_unm from public.pb_orbit_quote_unmatched;

  return query select v_after - v_before, v_accts, v_unm;
end;
$$;

revoke all on function public.pb_contact_events_from_quotes() from anon, authenticated;
