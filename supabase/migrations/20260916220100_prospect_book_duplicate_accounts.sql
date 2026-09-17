-- The duplicate account records that keep surfacing — in call attribution (§29), in the quote
-- name join, and in the chase board's fan-out. They are one company entered twice, and every pass
-- over the book has had to work around them. Naming them once, so a person can merge them.
--
-- 25 companies today. Most are a Notion/Pipedrive double-load where one record carries the domain
-- and the other does not; two are the same company entered twice from the delivery system with
-- the SAME domain, which is what made 16 recorded calls unattributable in §29.
create or replace view public.pb_duplicate_accounts as
select
  public.pb_norm_company(name) as norm_name,
  count(*)                     as records,
  string_agg(name, ' | ' order by name)                      as names,
  string_agg(coalesce(domain, '(none)'), ' | ' order by name) as domains,
  string_agg(roster_source, ' | ' order by name)             as sources
from public.pb_accounts
group by public.pb_norm_company(name)
having count(*) > 1;

comment on view public.pb_duplicate_accounts is
  'One company, more than one account record. Merging is an identity decision (rule 8) — this '
  'view proposes, a person decides.';

revoke all on public.pb_duplicate_accounts from anon, authenticated;
