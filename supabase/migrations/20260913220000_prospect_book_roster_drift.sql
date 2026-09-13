-- WLIQ Prospect Book — the roster, re-read every night.
--
-- The seed read the Client Journey once, on 9 September, and nothing has re-read it
-- since. By 13 September five organisations had moved into a prospect stage and were
-- absent from the book, and one account in the book had moved the other way into a
-- partner stage (DECISIONS.md §15). Neither gap is a defect in the seed. Both are the
-- same missing habit: the roster is a live thing and the book read it once.
--
-- This migration closes that by re-reading the Client Journey nightly and reporting
-- the drift in both directions. It reports; it does not act. Two rulings say it must
-- not:
--
--   * PRO-18's confirmation lane is still open (CLAUDE.md, "Open rulings"), so nothing
--     here may promote an account out of the book on a card movement.
--   * The seed's PRO-10 cross-check runs against the Client Book's keys, which this
--     repository may never import (CLAUDE.md, "What this is"). A row this function
--     invented would skip that check.
--
-- So the output is a queue a person works, in the shape rule 8 already establishes for
-- identity: propose, never write. `pb_roster_drift` is to the roster what
-- `pb_identity_candidates` is to identity.
--
-- The crawl runs inside Postgres so PB_PIPEDRIVE_API_TOKEN never leaves Vault, and
-- because the build container has no route to api.pipedrive.com in any case. It is a
-- stepper for the reason the Fathom crawl is one: pg_net dispatches only after the
-- calling transaction commits, so a single transaction can never read its own
-- response (migration 20260913210100).

-- ── stage vocabulary ────────────────────────────────────────────────────────────────
-- The ids are stable but not guaranteed; scripts/seed_README.md is where the rule they
-- implement is actually stated, and getStages for pipeline 9 is where they are checked.

create or replace function public.pb_cj_stage_name(stage_id int)
returns text language sql immutable set search_path = public as $$
  select case stage_id
    when 57 then 'New'            when 58 then 'Schedule Sales Call'
    when 59 then 'Sales Call Done' when 70 then 'Quoting'
    when 71 then 'Quote Lost'      when 66 then 'Unqualified/DNC'
    when 63 then 'Active Client'   when 64 then 'Inactive Client'
    when 65 then 'Past Client'     when 67 then 'Lost Client'
    when 69 then 'Friends of WLIQ'
    else null end
$$;

-- prospect → belongs in the book (Unqualified/DNC lands in the parked book).
-- partner  → PRO-10: an Agency Partner, never enters.
-- friends  → not a sales relationship.
create or replace function public.pb_cj_stage_class(stage_id int)
returns text language sql immutable set search_path = public as $$
  select case
    when stage_id in (57, 58, 59, 70, 71, 66) then 'prospect'
    when stage_id in (63, 64, 65, 67)         then 'partner'
    when stage_id = 69                        then 'friends'
    else null end
$$;

-- ── crawl state ─────────────────────────────────────────────────────────────────────

create table if not exists public.pb_roster_crawl (
  id          int primary key default 1 check (id = 1),
  cursor_next text,
  request_id  bigint,
  pages       int not null default 0,
  done        boolean not null default true,   -- idle until pb_roster_crawl_reset()
  started_at  timestamptz,
  last_error  text,
  updated_at  timestamptz not null default now()
);
insert into public.pb_roster_crawl (id) values (1) on conflict (id) do nothing;

-- One row per Client Journey card, replaced wholesale by each crawl.
create table if not exists public.pb_roster_cards (
  deal_id     bigint primary key,
  org_id      bigint,
  stage_id    int,
  status      text,
  title       text,
  update_time timestamptz,
  crawled_at  timestamptz not null default now()
);
create index if not exists pb_roster_cards_org_idx on public.pb_roster_cards (org_id);

-- The queue. One open row per (direction, organisation); history is kept by status.
create table if not exists public.pb_roster_drift (
  id               uuid primary key default gen_random_uuid(),
  direction        text not null check (direction in ('missing', 'departed')),
  pipedrive_org_id bigint not null,
  org_name         text,
  stage_id         int,
  stage_name       text,
  account_id       uuid references public.pb_accounts(id),
  detected_at      timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'open'
                   check (status in ('open', 'actioned', 'dismissed', 'resolved')),
  reviewed_by      text,
  reviewed_at      timestamptz,
  note             text,
  unique (direction, pipedrive_org_id)
);
create index if not exists pb_roster_drift_open_idx
  on public.pb_roster_drift (direction, last_seen_at desc) where status = 'open';

-- Every new pb_ table arrives with anon AND authenticated holding everything
-- (CLAUDE.md, Supabase). These three are service-role only.
revoke all on public.pb_roster_crawl from anon, authenticated;
revoke all on public.pb_roster_cards from anon, authenticated;
revoke all on public.pb_roster_drift from anon, authenticated;
alter table public.pb_roster_crawl enable row level security;
alter table public.pb_roster_cards enable row level security;
alter table public.pb_roster_drift enable row level security;

-- ── the crawl ───────────────────────────────────────────────────────────────────────

-- Ask Pipedrive for one page of pipeline 9. Returns the pg_net request id; the response
-- is NOT readable in this transaction.
create or replace function public.pb_roster_fetch_page(
  after_cursor text default null, page_limit int default 500)
returns bigint
language plpgsql security definer set search_path = public as $$
declare rid bigint; u text;
begin
  u := 'https://api.pipedrive.com/api/v2/deals?pipeline_id=9&limit='
       || greatest(1, least(page_limit, 500));
  if after_cursor is not null then u := u || '&cursor=' || after_cursor; end if;
  select net.http_get(url := u,
           headers := jsonb_build_object('x-api-token', public.pb_secret('PB_PIPEDRIVE_API_TOKEN')),
           timeout_milliseconds := 30000) into rid;
  return rid;
end $$;

-- Begin a crawl. Clears the staging table so a page that vanishes from Pipedrive
-- vanishes here too rather than lingering as a stale card.
create or replace function public.pb_roster_crawl_reset()
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.pb_roster_cards;
  update public.pb_roster_crawl
     set cursor_next = null, request_id = null, pages = 0, done = false,
         started_at = now(), last_error = null, updated_at = now()
   where id = 1;
end $$;

-- One transaction per page: settle the page the last call asked for, fire the next.
-- A 429 arrives as a real net._http_response row with a null body, which reads exactly
-- like "still in flight" — so ask whether the ROW exists before trusting the body
-- (the lesson that parked the Fathom crawl at page 19).
create or replace function public.pb_roster_crawl_step(page_limit int default 500)
returns table (landed int, cards int, pages int, finished boolean, error text)
language plpgsql security definer set search_path = public as $$
declare st record; resp record; body jsonb; n int := 0; nxt text;
begin
  select * into st from public.pb_roster_crawl where id = 1 for update;

  if st.request_id is not null then
    select * into resp from net._http_response where id = st.request_id;

    if resp.id is null then
      -- genuinely still in flight; come back next tick
      return query select 0, (select count(*)::int from public.pb_roster_cards),
                          st.pages, st.done, st.last_error;
      return;
    end if;

    if resp.status_code is distinct from 200 or resp.content is null then
      update public.pb_roster_crawl
         set request_id = null, updated_at = now(),
             last_error = format('page %s: HTTP %s %s', st.pages + 1,
                                 coalesce(resp.status_code, 0),
                                 coalesce(left(resp.content, 200), resp.error_msg, ''))
       where id = 1
       returning * into st;
      return query select 0, (select count(*)::int from public.pb_roster_cards),
                          st.pages, st.done, st.last_error;
      return;
    end if;

    begin
      body := resp.content::jsonb;
    exception when others then
      update public.pb_roster_crawl
         set request_id = null, last_error = 'page ' || (st.pages + 1) || ': body is not JSON',
             updated_at = now()
       where id = 1
       returning * into st;
      return query select 0, (select count(*)::int from public.pb_roster_cards),
                          st.pages, st.done, st.last_error;
      return;
    end;

    insert into public.pb_roster_cards (deal_id, org_id, stage_id, status, title, update_time)
    select (d->>'id')::bigint,
           nullif(d->>'org_id', '')::bigint,
           nullif(d->>'stage_id', '')::int,
           d->>'status',
           d->>'title',
           nullif(d->>'update_time', '')::timestamptz
    from jsonb_array_elements(coalesce(body->'data', '[]'::jsonb)) d
    where d->>'id' is not null
    on conflict (deal_id) do update
      set org_id = excluded.org_id, stage_id = excluded.stage_id, status = excluded.status,
          title = excluded.title, update_time = excluded.update_time, crawled_at = now();
    get diagnostics n = row_count;

    nxt := nullif(body #>> '{additional_data,next_cursor}', '');
    update public.pb_roster_crawl
       set cursor_next = nxt, request_id = null, pages = st.pages + 1,
           done = (nxt is null), last_error = null, updated_at = now()
     where id = 1
     returning * into st;
  end if;

  if not st.done then
    update public.pb_roster_crawl
       set request_id = public.pb_roster_fetch_page(st.cursor_next, page_limit),
           updated_at = now()
     where id = 1
     returning * into st;
  end if;

  return query select n, (select count(*)::int from public.pb_roster_cards),
                      st.pages, st.done, st.last_error;
end $$;

-- ── the report ──────────────────────────────────────────────────────────────────────

-- Recompute both directions from the staged cards. Refuses to run on an unfinished or
-- empty crawl: half a roster would read as half the book having departed.
create or replace function public.pb_roster_drift_refresh()
returns table (missing int, departed int, resolved int)
language plpgsql security definer set search_path = public as $$
declare st record; n_missing int := 0; n_departed int := 0; n_resolved int := 0; run_id uuid;
begin
  select * into st from public.pb_roster_crawl where id = 1;
  if not st.done then
    raise exception 'pb_roster_drift_refresh: crawl is still running (page %)', st.pages;
  end if;
  if (select count(*) from public.pb_roster_cards) = 0 then
    raise exception 'pb_roster_drift_refresh: no cards staged — run pb_roster_crawl_reset() first';
  end if;

  insert into public.pb_runs (kind, source, triggered_by, started_at, status)
  values ('ingest', 'roster_drift', 'pb_roster_drift_refresh', now(), 'running')
  returning id into run_id;

  create temp table _latest on commit drop as
  select distinct on (org_id) org_id, stage_id, title, update_time
  from public.pb_roster_cards
  where status = 'open' and org_id is not null
  order by org_id, update_time desc nulls last;

  -- missing: a prospect-stage card with no live account pointing at it
  with found as (
    select l.org_id, l.stage_id,
           nullif(btrim(regexp_replace(l.title, '^\s*CJ\s*-\s*', '')), '') as org_name
    from _latest l
    where public.pb_cj_stage_class(l.stage_id) = 'prospect'
      and not exists (select 1 from public.pb_accounts a
                       where a.pipedrive_org_id = l.org_id and a.book <> 'merged')
  ), up as (
    insert into public.pb_roster_drift
      (direction, pipedrive_org_id, org_name, stage_id, stage_name, last_seen_at)
    select 'missing', org_id, org_name, stage_id, public.pb_cj_stage_name(stage_id), now()
    from found
    on conflict (direction, pipedrive_org_id) do update
      set org_name = excluded.org_name, stage_id = excluded.stage_id,
          stage_name = excluded.stage_name, last_seen_at = now(),
          status = case when public.pb_roster_drift.status = 'resolved'
                        then 'open' else public.pb_roster_drift.status end
    returning 1)
  select count(*)::int into n_missing from up;

  -- departed: a live account whose card has moved to a partner stage, or to Friends
  with found as (
    select a.id as account_id, a.name, l.org_id, l.stage_id
    from public.pb_accounts a
    join _latest l on l.org_id = a.pipedrive_org_id
    where a.book in ('prospect', 'parked')
      and public.pb_cj_stage_class(l.stage_id) in ('partner', 'friends')
  ), up as (
    insert into public.pb_roster_drift
      (direction, pipedrive_org_id, org_name, stage_id, stage_name, account_id, last_seen_at)
    select 'departed', org_id, name, stage_id, public.pb_cj_stage_name(stage_id), account_id, now()
    from found
    on conflict (direction, pipedrive_org_id) do update
      set org_name = excluded.org_name, stage_id = excluded.stage_id,
          stage_name = excluded.stage_name, account_id = excluded.account_id,
          last_seen_at = now(),
          status = case when public.pb_roster_drift.status = 'resolved'
                        then 'open' else public.pb_roster_drift.status end
    returning 1)
  select count(*)::int into n_departed from up;

  -- anything open that this crawl did not see has fixed itself
  update public.pb_roster_drift
     set status = 'resolved', reviewed_at = now(),
         note = coalesce(note || ' | ', '') || 'no longer drifting on the crawl of ' || now()::date
   where status = 'open' and last_seen_at < st.started_at;
  get diagnostics n_resolved = row_count;

  update public.pb_runs
     set finished_at = now(), status = 'success',
         counts = jsonb_build_object('missing', n_missing, 'departed', n_departed,
                                     'resolved', n_resolved, 'cards',
                                     (select count(*) from public.pb_roster_cards))
   where id = run_id;

  return query select n_missing, n_departed, n_resolved;
end $$;

revoke all on function public.pb_roster_fetch_page(text, int)  from anon, authenticated;
revoke all on function public.pb_roster_crawl_reset()           from anon, authenticated;
revoke all on function public.pb_roster_crawl_step(int)         from anon, authenticated;
revoke all on function public.pb_roster_drift_refresh()         from anon, authenticated;

-- ── schedule ────────────────────────────────────────────────────────────────────────
-- 05:00 begin, 05:01-05:10 step (the step no-ops once the crawl is done, and ~950 cards
-- is two pages), 05:12 report — all of it before pb-nightly-notes at 05:45, so a card
-- that moved overnight is visible in the same morning's queue.

select cron.unschedule(jobname) from cron.job
 where jobname in ('pb-roster-begin', 'pb-roster-step', 'pb-roster-report');

select cron.schedule('pb-roster-begin',  '0 5 * * *',    $$select public.pb_roster_crawl_reset()$$);
select cron.schedule('pb-roster-step',   '1-10 5 * * *', $$select public.pb_roster_crawl_step()$$);
select cron.schedule('pb-roster-report', '12 5 * * *',   $$select public.pb_roster_drift_refresh()$$);
