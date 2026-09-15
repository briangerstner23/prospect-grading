-- WLIQ Prospect Book — read the team page, not just the front page.
--
-- 20260915090000 fetched one URL per account: `https://<domain>`. A homepage sells; it rarely
-- says how many people work there. The number the wallet wants — and the one the owner asked for
-- on 15 Sep, *"use the site and do what is needed for accuracy"* — lives on /about or /team,
-- where an agency lists the people it is willing to be judged by.
--
-- Why that source outranks the ones we have: Apollo's headcount is a count of LinkedIn profiles
-- claiming the employer, so it carries ex-employees and contractors. Against the nine accounts
-- where someone stated a headcount on a recorded call, Apollo is exact twice, within 25% four
-- times of seven, and 4× high once (400 against a stated 100 — a decade of alumni). A team page
-- is a claim the agency makes in public about itself. 20260915120000 ranks `website` above both
-- Apollo and Pipedrive for exactly that reason.
--
-- This migration adds `path`, so a row is one fetch of one page, and lets the caller name which
-- paths to try. The extra paths are only queued for an account whose front page already came
-- back 200 — no point spending five requests on a domain that does not resolve.
--
--   select public.pb_website_fetch_begin(200, 30, '{/}');                       -- front pages
--   select public.pb_website_fetch_step();                                      -- harvest
--   select public.pb_website_fetch_begin(200, 30, '{/about,/about-us,/team,/our-team}');
--
-- The step function is unchanged and needs no redeploy of anything: this is all in-database.

alter table public.pb_website_reads add column if not exists path text not null default '/';

-- Existing rows were all front pages.
update public.pb_website_reads set path = '/' where path is distinct from '/';

comment on column public.pb_website_reads.path is
  'The path fetched, e.g. / or /team. One row is one page, so an account has several.';

drop index if exists public.pb_website_reads_account_idx;
create index if not exists pb_website_reads_account_path_idx
  on public.pb_website_reads (account_id, path, requested_at desc);

-- The 2-argument version has to go, or pb_website_fetch_begin(25) becomes ambiguous.
drop function if exists public.pb_website_fetch_begin(int, int);

/**
 * Queue and dispatch a batch of fetches, one row per (account, path).
 *
 * Picks pages that are in the prospect book, carry a domain, have nothing in flight for that
 * exact path, and have not been read successfully inside `p_stale_days`. Oldest-read first, so a
 * repeated call walks the book rather than re-reading the same twenty pages. Any path other than
 * '/' additionally requires that the account's front page has already returned 200.
 */
create or replace function public.pb_website_fetch_begin(
  p_limit      int default 25,
  p_stale_days int default 30,
  p_paths      text[] default array['/']
)
returns int
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_queued int := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit must be between 1 and 200, got %', p_limit;
  end if;
  if p_paths is null or cardinality(p_paths) = 0 then
    raise exception 'p_paths must name at least one path';
  end if;
  if exists (select 1 from unnest(p_paths) p where p !~ '^/[A-Za-z0-9/_.-]*$') then
    raise exception 'every path must start with / and stay in [A-Za-z0-9/_.-]';
  end if;

  with candidate as (
    select a.id as account_id,
           p.path,
           'https://' || a.domain || (case when p.path = '/' then '' else p.path end) as url,
           (select max(r.completed_at) from public.pb_website_reads r
             where r.account_id = a.id and r.path = p.path and r.status_code = 200) as last_ok
      from public.pb_accounts a
      cross join unnest(p_paths) as p(path)
     where a.book = 'prospect'
       and a.domain is not null
       and not exists (
             select 1 from public.pb_website_reads r
              where r.account_id = a.id and r.path = p.path and r.completed_at is null)
       -- Only chase a sub-page when the front page answered.
       and (p.path = '/' or exists (
             select 1 from public.pb_website_reads r
              where r.account_id = a.id and r.path = '/' and r.status_code = 200))
  ),
  due as (
    select * from candidate
     where last_ok is null or last_ok < now() - make_interval(days => p_stale_days)
     order by last_ok nulls first
     limit p_limit
  ),
  dispatched as (
    insert into public.pb_website_reads (account_id, url, path, request_id)
    select d.account_id, d.url, d.path,
           net.http_get(
             url := d.url,
             headers := jsonb_build_object(
               'User-Agent', 'WLIQ-ProspectBook/1.0 (+https://whitelabeliq.com; reading your public site to grade a partnership fit)',
               'Accept', 'text/html'),
             timeout_milliseconds := 15000)
      from due d
    returning 1
  )
  select count(*) into v_queued from dispatched;

  return v_queued;
end $function$;

revoke all on function public.pb_website_fetch_begin(int, int, text[]) from public, anon, authenticated;
