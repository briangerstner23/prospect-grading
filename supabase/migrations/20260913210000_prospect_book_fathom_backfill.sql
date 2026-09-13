-- Fathom back-fill: the history the webhook never saw.
--
-- The webhook has only ever been told about meetings recorded since it was created
-- (12 Sep 2026). Everything before that is in Fathom and nowhere else, and it is the
-- only place the book holds a conversation rather than a CRM field.
--
-- Two rules shaped the design:
--
--   1. The API key never leaves Vault. The build container has no route to
--      *.fathom.ai; Postgres does, through pg_net. So the crawl runs here, reading
--      PB_FATHOM_API_KEY through pb_secret(), and the key is never handled by a
--      person, a log line or a checked-in file.
--   2. No second parser. Every staged meeting is REPLAYED through the live
--      pb-fathom-webhook with a genuine Standard Webhooks signature, so domain
--      attribution, meeting_key and the identity-candidate rules are the production
--      ones by construction. A back-fill that parsed payloads its own way would be a
--      second implementation of ingest/fathom_webhook.ts, free to drift from it.
--      Every delivery lands in pb_webhook_inbox like any other, so the back-fill is
--      audited the same way live traffic is.
--
-- The staging table is operator scaffolding, not part of the book's data model:
-- service role only, no grants to anon or authenticated, RLS on and default-deny.

create table if not exists public.pb_fathom_backfill (
  recording_id text primary key,
  payload      jsonb not null,
  held_at      timestamptz,
  title        text,
  fetched_at   timestamptz not null default now(),
  replayed_at  timestamptz,
  request_id   bigint,
  status       text not null default 'pending'
               check (status in ('pending','sent','ok','failed','skipped')),
  note         text
);

create index if not exists pb_fathom_backfill_status_idx
  on public.pb_fathom_backfill (status, held_at);

revoke all on public.pb_fathom_backfill from anon, authenticated;
alter table public.pb_fathom_backfill enable row level security;

-- Ask Fathom for one page. Returns the pg_net request id; the response is NOT
-- readable in this transaction — pg_net only dispatches after the caller commits.
create or replace function public.pb_fathom_fetch_page(
  after_cursor text default null, page_limit int default 25)
returns bigint
language plpgsql security definer set search_path = public as $$
declare rid bigint; u text;
begin
  u := 'https://api.fathom.ai/external/v1/meetings?include_transcript=false&include_summary=true&limit='
       || greatest(1, least(page_limit, 50));
  if after_cursor is not null then u := u || '&cursor=' || after_cursor; end if;
  select net.http_get(url := u,
           headers := jsonb_build_object('X-Api-Key', public.pb_secret('PB_FATHOM_API_KEY')),
           timeout_milliseconds := 30000) into rid;
  return rid;
end $$;

-- Land a page that has come back. Superseded by pb_fathom_crawl_step for the crawl
-- itself; kept for landing a page fetched by hand.
create or replace function public.pb_fathom_land_page(request_id bigint)
returns table (landed int, next_cursor text)
language plpgsql security definer set search_path = public as $$
declare body jsonb; n int := 0;
begin
  select content::jsonb into body from net._http_response where id = request_id;
  if body is null then raise exception 'pb_fathom_land_page: response % not ready', request_id; end if;

  insert into public.pb_fathom_backfill (recording_id, payload, held_at, title)
  select i->>'recording_id', i,
         coalesce((i->>'created_at')::timestamptz, (i->>'recording_start_time')::timestamptz),
         coalesce(i->>'title', i->>'meeting_title')
  from jsonb_array_elements(body->'items') i
  where i->>'recording_id' is not null
  on conflict (recording_id) do nothing;
  get diagnostics n = row_count;

  return query select n, body->>'next_cursor';
end $$;

-- Replay staged meetings through the live webhook, signed the way Fathom signs.
-- The body is signed and sent as the SAME text: re-serialising jsonb between the two
-- would change byte order and the signature would not verify.
create or replace function public.pb_fathom_replay(batch int default 20)
returns int
language plpgsql security definer set search_path = public as $$
declare r record; key bytea; ts text; wid text; body text; rid bigint; sent int := 0;
begin
  key := decode(substring(public.pb_secret('PB_FATHOM_WEBHOOK_SECRET') from 7), 'base64');
  if key is null or length(key) = 0 then
    raise exception 'pb_fathom_replay: PB_FATHOM_WEBHOOK_SECRET is not a whsec_ base64 key';
  end if;

  for r in select * from public.pb_fathom_backfill where status = 'pending'
           order by held_at nulls last limit greatest(1, batch)
  loop
    ts   := extract(epoch from now())::bigint::text;
    wid  := 'backfill-' || r.recording_id;
    body := r.payload::text;
    select net.http_post(
      url := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-fathom-webhook',
      body := r.payload,
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'webhook-id', wid,
        'webhook-timestamp', ts,
        'webhook-signature',
          'v1,' || encode(extensions.hmac(convert_to(wid || '.' || ts || '.' || body, 'utf8'),
                                          key, 'sha256'), 'base64')),
      timeout_milliseconds := 30000) into rid;

    update public.pb_fathom_backfill
       set status = 'sent', request_id = rid, replayed_at = now()
     where recording_id = r.recording_id;
    sent := sent + 1;
  end loop;
  return sent;
end $$;

-- pgcrypto lives in schema `extensions` on this project, not `public` — hence the
-- qualified extensions.hmac above. Unqualified it raises
-- `function hmac(text, bytea, unknown) does not exist`.

-- Read the webhook's answers back onto the staging rows.
create or replace function public.pb_fathom_settle()
returns table (ok int, failed int, waiting int)
language plpgsql security definer set search_path = public as $$
begin
  update public.pb_fathom_backfill b
     set status = case when resp.status_code = 200
                        and (resp.content::jsonb->>'ok')::boolean then 'ok' else 'failed' end,
         note   = left(resp.content::text, 500)
  from net._http_response resp
  where resp.id = b.request_id and b.status = 'sent';

  return query select
    (select count(*)::int from public.pb_fathom_backfill where status = 'ok'),
    (select count(*)::int from public.pb_fathom_backfill where status = 'failed'),
    (select count(*)::int from public.pb_fathom_backfill where status in ('pending','sent'));
end $$;

revoke all on function public.pb_fathom_fetch_page(text, int) from anon, authenticated;
revoke all on function public.pb_fathom_land_page(bigint) from anon, authenticated;
revoke all on function public.pb_fathom_replay(int) from anon, authenticated;
revoke all on function public.pb_fathom_settle() from anon, authenticated;
