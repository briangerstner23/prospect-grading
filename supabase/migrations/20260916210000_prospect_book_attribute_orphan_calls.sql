-- 826 of 987 recorded calls had no account. The diagnosis was that they are not "unmatched
-- prospect calls" at all — they are DELIVERY calls with companies that were never in the book.
-- Admitting 151 Orbit companies (§27) made 582 of them matchable by exact domain, and every
-- single match lands on a roster_source='orbit' account. The diagnosis was right.
--
-- ATTRIBUTION IS AN IDENTITY DECISION, so rule 8 governs it. The rule used here is the same one
-- the Fathom webhook already applies at ingest: an exact match between a call's external domain
-- and pb_accounts.domain. These calls are orphans only because the account did not exist yet.
-- Exactly one matching account -> attach (high confidence). More than one -> never attach; the
-- call goes to pb_call_attribution_candidates for a person.
--
-- WHAT THIS DOES NOT DO. It does not read a transcript, propose a fact, or touch pb_reads. It
-- says which account a recorded conversation belongs to. The facts inside those conversations
-- are pb-notes' job, through pb_fact_candidates, where a person still approves them.
--
-- THREE BUGS GOT THROUGH `create function` HERE, and the reason is worth keeping: Postgres does
-- not fully resolve a plpgsql body at CREATE time. `group by <uuid> and not exists (...)`,
-- `min(uuid)` (no such function) and the wrong pb_register column names all applied cleanly.
-- Worse, the dry-run branch returns before reaching the insert, so a dry run passed three times
-- while the write path was still broken. A dry run that does not exercise the write path is not
-- a rehearsal of the write path.
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
  select call_id,
         (array_agg(distinct account_id))[1] as account_id,
         count(distinct account_id) as n
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
  insert into public.pb_register (account_id, kind, made_by, text, fingerprint, created_at)
  select g.account_id, 'note', 'pb_attribute_orphan_calls',
         'Attributed ' || g.n_calls || ' previously unattached recorded call(s) to this account '
         || 'by exact domain match, after it entered the book from the delivery system '
         || '(DECISIONS §27, §29). No fact was read from them here.',
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
