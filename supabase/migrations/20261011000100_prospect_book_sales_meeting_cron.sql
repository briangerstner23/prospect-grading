-- Prospect Book — the sales-meeting reader's schedule (DECISIONS §65). Migration B of two, applied
-- LAST: after migration A (prospect_book_sales_meeting_reader), after pb-notes carries the
-- `sales_meeting` channel (supabase/functions/pb-notes/meetings.ts), and after the first meetings were
-- read by hand and reviewed (RUNBOOK §32). Applied before that, it would post to a pb-notes that
-- answers 400 to a body naming only sales_meeting.
--
-- PLACEHOLDER VERSION. 20261011000100 is a drafting stamp; the file is re-filed under its applied
-- version, byte-identical to schema_migrations.statements by md5 (RUNBOOK §28.6).
--
-- WHEN. Every three minutes, 00:00–04:59 and 07:00–23:59 UTC: clear of the 05:00–06:30 nightly chain
-- (roster 05:00–05:12, attribution 05:13, notes 05:15–05:42, autoconfirm 06:00, events 06:05, score
-- 06:15), so a meeting read never competes with the sweep for the extractor or for pb-notes' budget.
-- A meeting ends, Fathom delivers about 1.7 minutes later, and its cards are ready in two or three
-- ticks.
--
-- ONLY WHEN THERE IS WORK, decided in SQL so an idle tick makes no HTTP call and no model call:
--   · a verified Fathom delivery past the 'sales_meeting' registration cursor (received_at, then id —
--     the 23 Sep cursor rule: a null last_seen_id means everything AT last_seen_at was read),
--     compared at the cursor's own precision, or
--   · a meeting 'waiting' to be read, or
--   · one 'reading' whose lease is older than 150 s (a run that died mid-meeting).
-- A delivery that is not an internal meeting still counts as work once: pb-notes registers nothing
-- for it and moves the cursor past it, so the next tick is idle.
--
-- THE CURSOR'S PRECISION. pb-notes writes last_seen_at through timeKey(), which keeps milliseconds;
-- received_at carries microseconds (1,188 of 1,190 verified Fathom deliveries, 10 Oct 2026).
-- Compared raw, the newest delivery would sit forever a few microseconds past the cursor it set, and
-- every tick would post to a pb-notes with nothing to do. So received_at is truncated to the
-- millisecond first, which is exactly how isPastCursor (ingest/notes_sweep.ts) sees it, and the ids
-- compare bytewise ("C"), as compareIds does for a uuid.
--
-- THE CALL. The nightly pattern (pb-nightly-notes): the Book's own bearer from Vault, the 150 s
-- pg_net timeout, budget_ms 110000 so pb-notes stops itself inside it, six model calls in flight. The
-- body names ONLY sales_meeting; pb-notes refuses that source beside any other, and the nightly body
-- names no sources, so the two paths never cross.
--
-- To stop it: select cron.unschedule('pb-meetings');

select cron.schedule(
  'pb-meetings',
  '*/3 0-4,7-23 * * *',
  $cmd$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('sources', jsonb_build_array('sales_meeting'),
                                    'budget_ms', 110000, 'concurrency', 6),
      timeout_milliseconds := 150000
    )
    where exists (
            select 1
              from public.pb_webhook_inbox i
              left join public.pb_source_watermarks w on w.source = 'sales_meeting'
             where i.source = 'fathom' and i.verified
               and (w.last_seen_at is null
                    or date_trunc('milliseconds', i.received_at) > w.last_seen_at
                    or (date_trunc('milliseconds', i.received_at) = w.last_seen_at and w.last_seen_id is not null
                        and i.id::text collate "C" > w.last_seen_id)))
       or exists (select 1 from public.pb_meetings m where m.status = 'waiting')
       or exists (select 1 from public.pb_meetings m
                   where m.status = 'reading'
                     and (m.read_started_at is null or m.read_started_at < now() - interval '150 seconds'));
  $cmd$
);
