-- The first cut of this view grouped by (call, domain) and asked whether THAT DOMAIN matched
-- more than one account. That finds one kind of ambiguity and hides the other. A call can carry
-- two different external domains that each match a different account — a three-way call with two
-- agencies on it — and per-domain grouping reports each as unambiguous while the call as a whole
-- is not. The function was always right (it groups per call); the view under-reported it, which
-- is worse than a wrong number: it is a review queue that silently drops the harder half.
--
-- 24 calls are ambiguous today: 16 where one company sits in the book under two records sharing
-- a domain, and 8 genuinely multi-party. Attributing either to a single account would be a guess.
drop view if exists public.pb_call_attribution_candidates;

create view public.pb_call_attribution_candidates as
with orphan as (
  select c.id as call_id, c.title, c.held_at, unnest(c.external_domains) as dom
  from public.pb_calls c
  where c.account_id is null and c.external_domains is not null
),
d as (
  select call_id, title, held_at, lower(regexp_replace(dom, '^www\.', '')) as dom
  from orphan
),
m as (
  select distinct d.call_id, d.title, d.held_at, d.dom, a.id as account_id, a.name
  from d
  join public.pb_accounts a
    on lower(regexp_replace(a.domain, '^www\.', '')) = d.dom
  where a.domain is not null and a.domain <> ''
)
select
  call_id,
  title,
  held_at,
  count(distinct account_id) as candidate_accounts,
  count(distinct dom)        as matched_domains,
  case when count(distinct dom) = 1
       then 'duplicate account records share one domain — resolve identity first'
       else 'multi-party call: two different companies were present'
  end as why,
  string_agg(distinct dom,  ' | ' order by dom)  as domains,
  string_agg(distinct name, ' | ' order by name) as candidates
from m
group by call_id, title, held_at
having count(distinct account_id) > 1;

comment on view public.pb_call_attribution_candidates is
  'Recorded calls whose external domains match more than one account, grouped PER CALL. Never '
  'auto-attached (rule 8). Two shapes, and the view names which: duplicate account records '
  'sharing a domain, or a genuinely multi-party call. Grouping per (call, domain) instead — '
  'the first version of this view — hides the second shape entirely.';

revoke all on public.pb_call_attribution_candidates from anon, authenticated;
