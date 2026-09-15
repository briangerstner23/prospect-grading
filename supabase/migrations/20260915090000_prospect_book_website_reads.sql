-- WLIQ Prospect Book — reading the agency's own website.
--
-- Three features now exist that nothing collects: `client_budget_size` (§ the fit read),
-- `build_demand_exceeds_capacity` (DECISIONS §19) and `delivery_headcount` / `years_operating`
-- (§21). All four are answerable from an agency's own site — a services list, a client list, a
-- team page, a "founded 1998" line — and none is answerable from a CRM field. The rubric says so
-- itself about the first: *"No API supplies this; a person reads the work page in ninety seconds
-- or records unknown."*
--
-- 418 of 499 prospects have never had a call and 370 of those carry a domain. A portfolio read is
-- the only way they are ever graded on anything but a stale label.
--
-- THIS MIGRATION IS THE FETCH HALF ONLY. It pulls each site and stores its text. It reads nothing
-- out of that text and writes not one fact: extraction belongs to pb-notes, which already owns the
-- quote check, the judgement check and the candidate queue (rule 8 — nothing a machine read
-- becomes a fact on a machine's say-so). Splitting it here is deliberate; the fetch is blocked on
-- nothing, the extractor is blocked on a redeploy.
--
-- Two steps, for the reason the roster crawl is a stepper: pg_net dispatches only after the
-- calling transaction commits, so nothing can fetch and harvest in one call.
--
--   select public.pb_website_fetch_begin(25);   -- queue + dispatch a batch
--   -- a few seconds later, in a SEPARATE statement:
--   select public.pb_website_fetch_step();      -- harvest whatever has come back
--
-- Run the step repeatedly; it is idempotent and no-ops once every in-flight row is harvested.

create table if not exists public.pb_website_reads (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.pb_accounts(id) on delete cascade,
  url          text not null,
  requested_at timestamptz not null default now(),
  request_id   bigint,
  completed_at timestamptz,
  status_code  int,
  bytes        int,
  -- The page stripped to text. Capped: the extractor reads prose, and a 2 MB marketing site is
  -- mostly markup and inlined data either way.
  text         text,
  error        text
);

comment on table public.pb_website_reads is
  'One row per fetch of a prospect''s own website. Raw material for the notes sweep; never a fact. Service role only.';

create index if not exists pb_website_reads_account_idx on public.pb_website_reads (account_id, requested_at desc);
-- The in-flight queue is "dispatched but not harvested", so it needs to be cheap to find.
create index if not exists pb_website_reads_inflight_idx on public.pb_website_reads (request_id) where completed_at is null;

alter table public.pb_website_reads enable row level security;

-- Default-deny with no policy at all: this is scraped third-party content, read by the extractor
-- under the service role and by nobody else. CLAUDE.md: a new pb_ table arrives with anon AND
-- authenticated holding everything, so both must be revoked explicitly — the RLS default-deny
-- alone would not stop TRUNCATE, which no row policy can refuse.
revoke all on public.pb_website_reads from anon, authenticated;

/**
 * Queue and dispatch a batch of fetches.
 *
 * Picks accounts that are in the prospect book, carry a domain, have nothing in flight, and have
 * not been read successfully inside `p_stale_days`. Oldest-read first, so a repeated call walks
 * the book rather than re-reading the same twenty sites.
 */
create or replace function public.pb_website_fetch_begin(
  p_limit      int default 25,
  p_stale_days int default 30
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

  with candidate as (
    select a.id as account_id,
           'https://' || a.domain as url,
           (select max(r.completed_at) from public.pb_website_reads r
             where r.account_id = a.id and r.status_code = 200) as last_ok
      from public.pb_accounts a
     where a.book = 'prospect'
       and a.domain is not null
       and not exists (
             select 1 from public.pb_website_reads r
              where r.account_id = a.id and r.completed_at is null)
  ),
  due as (
    select * from candidate
     where last_ok is null or last_ok < now() - make_interval(days => p_stale_days)
     order by last_ok nulls first
     limit p_limit
  ),
  dispatched as (
    insert into public.pb_website_reads (account_id, url, request_id)
    select d.account_id, d.url,
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

/**
 * Harvest whatever has come back, and strip it to text.
 *
 * pg_net garbage-collects `net._http_response`, so a row whose reply has already been reaped is
 * closed with an error rather than left in flight forever — an unharvestable row would otherwise
 * block that account from ever being queued again.
 */
create or replace function public.pb_website_fetch_step()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_ok      int := 0;
  v_failed  int := 0;
  v_pending int := 0;
  v_lost    int := 0;
  r         record;
  v_status  int;
  v_body    text;
  v_err     text;
  v_text    text;
begin
  for r in
    select id, request_id, requested_at
      from public.pb_website_reads
     where completed_at is null and request_id is not null
     order by requested_at
       for update skip locked
  loop
    select resp.status_code, resp.content, resp.error_msg
      into v_status, v_body, v_err
      from net._http_response resp where resp.id = r.request_id;

    if not found then
      -- Still in flight, or reaped. Older than ten minutes it can never arrive.
      if r.requested_at < now() - interval '10 minutes' then
        update public.pb_website_reads
           set completed_at = now(), error = 'no reply recorded; pg_net response was reaped before it was harvested'
         where id = r.id;
        v_lost := v_lost + 1;
      else
        v_pending := v_pending + 1;
      end if;
      continue;
    end if;

    if v_status is distinct from 200 then
      update public.pb_website_reads
         set completed_at = now(), status_code = v_status,
             error = coalesce(v_err, 'HTTP ' || coalesce(v_status::text, 'error'))
       where id = r.id;
      v_failed := v_failed + 1;
      continue;
    end if;

    /* Strip to prose: scripts and styles carry no claims and are most of the bytes.
     *
     * NOTE THE `[^>]*?`. PostgreSQL takes the greediness of the WHOLE expression from its FIRST
     * quantifier, so a greedy `[^>]*` makes the following `.*?` greedy too and each match runs
     * from the first <script> to the LAST </script> — swallowing the entire page. The first cut
     * of this function did exactly that: 424 KB of HTML reduced to zero characters, and the row
     * was filed as "probably a client-rendered page". Proof, which is also the regression test:
     *
     *   select regexp_replace('A<script>x</script>B<script>y</script>C',
     *                         '<script[^>]*>.*?</script>',  '|', 'gis');  -- A|C   (wrong)
     *   select regexp_replace('A<script>x</script>B<script>y</script>C',
     *                         '<script[^>]*?>.*?</script>', '|', 'gis');  -- A|B|C (right)
     *
     * The back-reference is gone with it: one alternation per tag is clearer than `\1` and does
     * not tempt the same mistake. The patterns below are safe as written — each begins with its
     * own non-greedy quantifier, or has only one quantifier at all. */
    v_text := regexp_replace(v_body, '<script[^>]*?>.*?</script>', ' ', 'gis');
    v_text := regexp_replace(v_text, '<style[^>]*?>.*?</style>', ' ', 'gis');
    v_text := regexp_replace(v_text, '<noscript[^>]*?>.*?</noscript>', ' ', 'gis');
    v_text := regexp_replace(v_text, '<svg[^>]*?>.*?</svg>', ' ', 'gis');
    v_text := regexp_replace(v_text, '<!--.*?-->', ' ', 'gs');
    v_text := regexp_replace(v_text, '<[^>]+>', ' ', 'g');
    v_text := replace(replace(replace(replace(v_text, '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>');
    v_text := btrim(regexp_replace(v_text, '\s+', ' ', 'g'));

    update public.pb_website_reads
       set completed_at = now(), status_code = 200,
           bytes = length(v_body),
           text  = left(v_text, 40000),
           error = case when length(v_text) < 200
                        then 'fetched, but under 200 characters of text — probably a client-rendered page'
                        else null end
     where id = r.id;
    v_ok := v_ok + 1;
  end loop;

  return jsonb_build_object(
    'harvested', v_ok, 'failed', v_failed, 'still_in_flight', v_pending, 'lost', v_lost
  );
end $function$;

revoke all on function public.pb_website_fetch_begin(int, int) from public, anon, authenticated;
revoke all on function public.pb_website_fetch_step() from public, anon, authenticated;
