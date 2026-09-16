-- WLIQ Prospect Book — Orbit, the delivery system, read into the book. (Owner ruling, 16 Sep 2026.)
--
-- Orbit is where the work actually happens: who is being delivered to, and what has been quoted.
-- The Prospect Book had never read it, which is why an account being delivered three projects sat
-- at rank 2 of a prospect chase list.
--
-- The owner's ruling shapes what this is FOR. A client is still a prospect; a quote means
-- mid-decision and deserves more attention, not less. So this table answers "what is the state of
-- our relationship" — it never removes an account from anything.
--
-- Like `pb_roster_drift`, it is a re-read, never a re-write. A snapshot with an `observed_at`,
-- refreshed by replacing rows. Nothing here writes a fact or a grade.
--
-- WHY A TABLE, AND NOT AN ANALYSIS DONE IN A SESSION. The first attempt at this overlap was
-- computed against a domain list transcribed BY HAND out of a query result. That transcript
-- contained rows that are not in `pb_accounts` at all — a name from the identity registry merged
-- into a list of account names while typing — and the count it produced was wrong in both
-- directions: it reported 181 accounts in Orbit and 79 with active projects, where the real
-- figures are 203 and 98. Data moves reliably in one direction only: a file on disk can be turned
-- into SQL without a human retyping it, so loads go local-to-database and every join runs here,
-- against the real thing.

create table if not exists public.pb_orbit_clients (
  orbit_id        integer primary key,
  company_name    text not null,
  domain          text,
  client_type     text,                -- Agency · Direct Client · null
  client_status   text,                -- Active · New · Lost · Inactive · Past · Re-engaged
  active_projects integer not null default 0,
  account_manager text,
  observed_at     timestamptz not null default now()
);

comment on table public.pb_orbit_clients is
  'Snapshot of the Orbit client list — the delivery system. A re-read, never a re-write: refreshed by replacing rows, and it writes no fact and no grade. A client here is still a prospect (owner ruling, 16 Sep 2026); this says what the relationship IS, never who leaves the book.';

create index if not exists pb_orbit_clients_domain on public.pb_orbit_clients (lower(domain));
create index if not exists pb_orbit_clients_name   on public.pb_orbit_clients (lower(company_name));

alter table public.pb_orbit_clients enable row level security;
revoke all on public.pb_orbit_clients from anon, authenticated;
grant select on public.pb_orbit_clients to authenticated;
drop policy if exists pb_orbit_clients_select on public.pb_orbit_clients;
create policy pb_orbit_clients_select on public.pb_orbit_clients
  for select to authenticated using (true);

/**
 * Where the book and the delivery system meet.
 *
 * Matched on domain, then on the identity registry's aliases, then on exact name. Reports the
 * relationship and the lane; removes nothing.
 */
create or replace view public.pb_orbit_overlap
with (security_invoker = true) as
select a.id as account_id, a.name as account_name, a.domain,
       o.orbit_id, o.company_name as orbit_name, o.client_type, o.client_status,
       o.active_projects, o.account_manager,
       case
         when lower(a.domain) = lower(o.domain) then 'domain'
         when lower(a.name)   = lower(o.company_name) then 'name'
         else 'registry_alias'
       end as matched_on,
       case
         when o.active_projects > 0 then 'delivering now — nurture through the transition, and every line they are not buying is open'
         when o.client_status in ('Lost','Past','Inactive') then 'was a client — a no is a priced conversation, not a closed door'
         else 'in Orbit with no active project — the relationship exists, the work does not'
       end as lane
  from public.pb_accounts a
  join public.pb_orbit_clients o
    on lower(a.domain) = lower(o.domain)
    or lower(a.name) = lower(o.company_name)
    or exists (
         select 1 from public.pb_mdm_aliases al
         join public.pb_mdm_companies c on c.slug = al.slug
         where lower(c.canonical_name) = lower(o.company_name)
           and ((al.alias_type = 'domain' and lower(al.alias) = lower(a.domain))
             or (al.alias_type = 'name'   and lower(al.alias) = lower(a.name)))
       );

comment on view public.pb_orbit_overlap is
  'Prospect Book accounts that also exist in Orbit, with the delivery state and the lane to work them in. Advisory: it removes nothing (owner ruling, 16 Sep 2026 — a client is still a prospect).';
