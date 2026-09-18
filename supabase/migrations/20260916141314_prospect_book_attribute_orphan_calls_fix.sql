-- WLIQ Prospect Book — filed verbatim from supabase_migrations.schema_migrations on 17 Sep 2026.
-- Applied 20260916141314 as "prospect_book_attribute_orphan_calls_fix" by the 16 September session, which pushed its work to its own
-- branch and never filed this one. Recovered with the branch merge; see DECISIONS §38 for the
-- precedent and §45 for why eleven branches existed. Byte-for-byte what ran; do not re-edit here.

-- Corrects the register-note insert in pb_attribute_orphan_calls: the idempotence guard was
-- written as `group by k.account_id and not exists (...)`, which groups by a boolean expression
-- rather than filtering. Postgres does not fully parse a plpgsql body at CREATE time, so it
-- applied and would only have failed on the first real run.
create or replace function public.pb_attribute_orphan_calls(p_dry_run boolean default true)
returns table (calls_attached integer, accounts_touched integer, left_ambiguous integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attached integer := 0;
  v_accounts integer := 0;
  v_ambig    integer := 0;
begin
  create temporary table _cand on commit drop as
  with orphan as (
    select c.id as call_id, unnest(c.external_domains) as dom
    from public.pb_calls c
    where c.account_id is null and c.external_domains is not null
  ),
  d as (select call_id, lower(regexp_replace(dom, '^www\.', '')) as dom from orphan),
  m as (
    select distinct d.call_id, a.id as account_id
    from d
    join public.pb_accounts a
      on lower(regexp_replace(a.domain, '^www\.', '')) = d.dom
    where a.domain is not null and a.domain <> ''
  )
  select call_id, min(account_id) as account_id, count(distinct account_id) as n
  from m group by call_id;

  select count(*) into v_ambig from _cand where n > 1;

  if p_dry_run then
    select count(*), count(distinct account_id) into v_attached, v_accounts
    from _cand where n = 1;
    return query select v_attached, v_accounts, v_ambig;
    return;
  end if;

  update public.pb_calls c
     set account_id = k.account_id, updated_at = now()
    from _cand k
   where k.n = 1 and c.id = k.call_id and c.account_id is null;
  get diagnostics v_attached = row_count;

  select count(distinct account_id) into v_accounts from _cand where n = 1;

  -- One register note per account, not per call: 558 notes would be noise, and the number of
  -- calls is the fact worth reading.
  insert into public.pb_register (account_id, kind, body, author, fingerprint, created_at)
  select g.account_id, 'note',
         'Attributed ' || g.n_calls || ' previously unattached recorded call(s) to this account '
         || 'by exact domain match, after it entered the book from the delivery system '
         || '(DECISIONS §27, §29). No fact was read from them here.',
         'pb_attribute_orphan_calls',
         g.fp,
         now()
    from (
      select k.account_id,
             count(*) as n_calls,
             encode(sha256(convert_to('call_attribution|' || k.account_id::text, 'UTF8')), 'hex') as fp
        from _cand k
       where k.n = 1
       group by k.account_id
    ) g
   where not exists (
     select 1 from public.pb_register r where r.fingerprint = g.fp
   );

  return query select v_attached, v_accounts, v_ambig;
end;
$$;

revoke all on function public.pb_attribute_orphan_calls(boolean) from anon, authenticated;

-- Rule 8's other half: what the function refuses. A call whose external domains match more than
-- one account is never attached — it is proposed here and a person decides. Today every row is
-- one company carrying two account records with the same domain; merging those is an identity
-- decision (pb_identity_candidates), not something call attribution may assume.
create or replace view public.pb_call_attribution_candidates as
with orphan as (
  select c.id as call_id, c.title, c.held_at, unnest(c.external_domains) as dom
  from public.pb_calls c
  where c.account_id is null and c.external_domains is not null
),
d as (select call_id, title, held_at, lower(regexp_replace(dom, '^www\.', '')) as dom from orphan),
m as (
  select distinct d.call_id, d.title, d.held_at, d.dom, a.id as account_id, a.name
  from d
  join public.pb_accounts a
    on lower(regexp_replace(a.domain, '^www\.', '')) = d.dom
  where a.domain is not null and a.domain <> ''
)
select call_id, title, held_at, dom as matched_domain,
       count(distinct account_id) as candidate_accounts,
       string_agg(distinct name, ' | ' order by name) as candidates
from m
group by call_id, title, held_at, dom
having count(distinct account_id) > 1;

comment on view public.pb_call_attribution_candidates is
  'Recorded calls whose external domain matches more than one account. Never auto-attached '
  '(rule 8) — a person resolves the duplicate accounts first.';

revoke all on public.pb_call_attribution_candidates from anon, authenticated;
