-- WLIQ Prospect Book — stop re-fetching pages that already answered 404.
--
-- `pb_website_fetch_begin` decided a page was due on `last_ok`, the newest completed read with
-- status 200. A page that 404s never sets it, so it stayed due forever: every batch re-queued the
-- same dead URLs and the crawl never advanced. Measured on the first real pass — 742 completed
-- `/about` rows across 397 accounts, all but 256 of them 404, while `/team` got 23 hits because
-- the batches never reached it.
--
-- The test is now the newest **completed attempt**, whatever it returned. A 404 is an answer: that
-- path does not exist on that site, and asking again tomorrow will not change it. A page is due
-- when nothing has ever come back for it, or when the last answer is older than `p_stale_days`.
--
-- Everything else about the function is unchanged.

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
           -- The newest ANSWER, not the newest success. A 404 is an answer.
           (select max(r.completed_at) from public.pb_website_reads r
             where r.account_id = a.id and r.path = p.path) as last_tried
      from public.pb_accounts a
      cross join unnest(p_paths) as p(path)
     where a.book = 'prospect'
       and a.domain is not null
       and not exists (
             select 1 from public.pb_website_reads r
              where r.account_id = a.id and r.path = p.path and r.completed_at is null)
       and (p.path = '/' or exists (
             select 1 from public.pb_website_reads r
              where r.account_id = a.id and r.path = '/' and r.status_code = 200))
  ),
  due as (
    select * from candidate
     where last_tried is null or last_tried < now() - make_interval(days => p_stale_days)
     order by last_tried nulls first
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

-- Clear the duplicate 404 rows the old rule produced, keeping the newest answer per page. They
-- cost nothing to store but they make the read counts in DECISIONS §22 and RUNBOOK §25 unreadable.
delete from public.pb_website_reads r
 using public.pb_website_reads keep
 where r.account_id = keep.account_id
   and r.path = keep.path
   and r.completed_at is not null
   and keep.completed_at is not null
   and (keep.completed_at, keep.id) > (r.completed_at, r.id);
