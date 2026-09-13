-- One transaction per page.
--
-- The first attempt at the crawl was a DO block: fetch a page, land it, follow the
-- cursor, repeat. It failed on the first iteration with
-- `pb_fathom_land_page: response 59 not ready`, and the reason is structural rather
-- than a timing accident: pg_net queues a request and only dispatches it AFTER the
-- calling transaction commits. A single transaction can therefore never read its own
-- response, no matter how long it waits — and waiting inside the transaction is what
-- guarantees the response never comes.
--
-- So the crawl is a stepper. Each call settles the page the previous call asked for
-- and fires the next one, and the caller's commit is what sends it. State lives in a
-- table, so the crawl is resumable: interrupted halfway, the next call picks up at
-- the same cursor. Drive it from pg_cron at a few seconds' spacing, or by hand.

create table if not exists public.pb_fathom_crawl (
  id          int primary key default 1 check (id = 1),
  cursor_next text,
  request_id  bigint,
  pages       int not null default 0,
  done        boolean not null default false,
  updated_at  timestamptz not null default now()
);
insert into public.pb_fathom_crawl (id) values (1) on conflict (id) do nothing;

revoke all on public.pb_fathom_crawl from anon, authenticated;
alter table public.pb_fathom_crawl enable row level security;

create or replace function public.pb_fathom_crawl_step(page_limit int default 50)
returns table (landed int, staged int, pages int, finished boolean)
language plpgsql security definer set search_path = public as $$
declare st record; body jsonb; n int := 0; nxt text;
begin
  select * into st from public.pb_fathom_crawl where id = 1 for update;

  if st.request_id is not null then
    select content::jsonb into body from net._http_response where id = st.request_id;
    if body is null then
      return query select 0, (select count(*)::int from public.pb_fathom_backfill), st.pages, st.done;
      return;
    end if;

    insert into public.pb_fathom_backfill (recording_id, payload, held_at, title)
    select i->>'recording_id', i,
           coalesce((i->>'created_at')::timestamptz, (i->>'recording_start_time')::timestamptz),
           coalesce(i->>'title', i->>'meeting_title')
    from jsonb_array_elements(body->'items') i
    where i->>'recording_id' is not null
    on conflict (recording_id) do nothing;
    get diagnostics n = row_count;

    nxt := body->>'next_cursor';
    update public.pb_fathom_crawl
       set cursor_next = nxt, request_id = null, pages = st.pages + 1,
           done = (nxt is null), updated_at = now()
     where id = 1
     returning * into st;
  end if;

  if not st.done then
    update public.pb_fathom_crawl
       set request_id = public.pb_fathom_fetch_page(st.cursor_next, page_limit), updated_at = now()
     where id = 1
     returning * into st;
  end if;

  return query select n, (select count(*)::int from public.pb_fathom_backfill), st.pages, st.done;
end $$;

revoke all on function public.pb_fathom_crawl_step(int) from anon, authenticated;
