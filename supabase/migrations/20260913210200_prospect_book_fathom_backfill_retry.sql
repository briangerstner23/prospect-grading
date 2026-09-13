-- The stepper parked on a 429.
--
-- Fathom rate-limits at roughly ten requests a minute. Driven from pg_cron every five
-- seconds the crawl hit that on page 19 and then STOPPED — not because the limit is
-- fatal, but because of how the step read the response. It asked one question,
-- `content::jsonb is null`, and treated the answer as "still in flight". A 429 comes
-- back as a real net._http_response row with status_code 429 and no body, which is
-- also null content. So the step returned "not ready" on every subsequent call while
-- request_id stayed set, and the crawl sat on a request that would never improve.
--
-- The fix is to ask a second question first: is there a response row at all? No row
-- means genuinely in flight, leave it standing. A row that is not a usable 200 means
-- the attempt is spent — clear request_id so the NEXT step re-fires the same cursor,
-- and count the miss. Nothing is skipped; the cursor only advances on a landed page.
--
-- Rate limiting is handled by spacing, not by this function: drive the crawl at ten
-- seconds rather than five and the misses stay in the single digits.

alter table public.pb_fathom_crawl add column if not exists misses int not null default 0;
alter table public.pb_fathom_crawl add column if not exists last_note text;

drop function if exists public.pb_fathom_crawl_step(int);

create function public.pb_fathom_crawl_step(page_limit int default 50)
returns table (landed int, staged int, pages int, finished boolean, note text)
language plpgsql security definer set search_path = public as $$
declare st record; resp record; body jsonb; n int := 0; nxt text; msg text := null;
begin
  select * into st from public.pb_fathom_crawl where id = 1 for update;

  -- 1. settle whatever the previous step asked for, once it has come back
  if st.request_id is not null then
    select status_code, content, error_msg into resp
      from net._http_response where id = st.request_id;

    if not found then
      -- no response row: genuinely still in flight, leave the request standing
      return query select 0, (select count(*)::int from public.pb_fathom_backfill),
                          st.pages, st.done, 'in flight'::text;
      return;
    end if;

    if resp.status_code is distinct from 200 or resp.content is null then
      msg := 'retry: status ' || coalesce(resp.status_code::text, 'none')
             || coalesce(' ' || resp.error_msg, '');
      update public.pb_fathom_crawl
         set request_id = null, misses = st.misses + 1, last_note = msg, updated_at = now()
       where id = 1
       returning * into st;
    else
      body := resp.content::jsonb;

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
             done = (nxt is null), last_note = 'landed ' || n, updated_at = now()
       where id = 1
       returning * into st;
    end if;
  end if;

  -- 2. ask for the next page, unless the history is exhausted
  if not st.done then
    update public.pb_fathom_crawl
       set request_id = public.pb_fathom_fetch_page(st.cursor_next, page_limit), updated_at = now()
     where id = 1
     returning * into st;
  end if;

  return query select n, (select count(*)::int from public.pb_fathom_backfill),
                      st.pages, st.done, coalesce(msg, st.last_note);
end $$;

revoke all on function public.pb_fathom_crawl_step(int) from anon, authenticated;
