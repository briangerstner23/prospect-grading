-- Every quote-stage project in the delivery system, read across all 11 pages: 213 projects,
-- 80 distinct companies. Owner ruling (DECISIONS §26): a quote is engagement of the strongest
-- kind, an open quote is the hottest state an account can be in, and a LOST quote is still a
-- signal — "a no is a positive sign." So the whole history is loaded, not just the fresh end.
--
-- Same discipline as the email sweep (§28): the sweep carries a NAME and a DATE, and the join to
-- an account happens in the database. Names here are the delivery system's spelling, which is not
-- the book's — one company is entered with a typo, several differ by a leading "The", an
-- ampersand, or a parenthetical. So the join normalises, and anything it cannot match is
-- REPORTED in pb_orbit_quote_unmatched rather than dropped. A quote sweep that silently loses
-- companies is worse than no quote sweep: it looks complete.
create table if not exists public.pb_orbit_quote_sweep (
  client_name  text primary key,
  last_quoted  timestamptz not null,
  observed_at  timestamptz not null default now()
);

comment on table public.pb_orbit_quote_sweep is
  'Newest quote-stage project per client in the delivery system. Staging only — Orbit is read, '
  'never written (rule 11); this is a snapshot of what its read endpoints returned.';

revoke all on public.pb_orbit_quote_sweep from anon, authenticated;
alter table public.pb_orbit_quote_sweep enable row level security;

create or replace view public.pb_orbit_quote_unmatched as
select q.client_name, q.last_quoted
from public.pb_orbit_quote_sweep q
where not exists (
  select 1 from public.pb_accounts a
  where public.pb_norm_company(a.name) = public.pb_norm_company(q.client_name)
);

comment on view public.pb_orbit_quote_unmatched is
  'Quoted companies whose delivery-system name matches no account. Never dropped silently.';

revoke all on public.pb_orbit_quote_unmatched from anon, authenticated;
