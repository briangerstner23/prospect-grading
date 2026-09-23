-- Prospect Book — a time-boxed catch-up of the notes backlog. Owner ruling 23 Sep 2026 (audit
-- record 3, finding A: "I want this all fixed"; credit restored the same day).
--
-- The wound-back watermarks (20260923110000) put several hundred Fathom calls and a few dozen
-- Pipedrive notes back in front of the sweep. The nightly job reads about eight records per
-- channel, so on its own the backlog would take weeks. This job runs the same function on the
-- same terms every four minutes for a bounded window and then does nothing.
--
-- BOUNDED THREE WAYS, so it can never become a standing cost:
--   * by time  — the command posts only before 2026-09-25 05:00 UTC, and never between :30 and
--                :59 of 05 UTC, so it cannot overlap the 05:45 nightly run reading the same records;
--   * by work  — once the cursors catch up, a run finds nothing to read and makes no model call;
--   * by run   — max_notes 12 per channel and the function's own 110 s budget, as nightly.
-- Runs do not overlap: each stops itself inside 150 s and the cadence is 240 s.
--
-- Remove the job once it has gone quiet (a later migration, or cron.unschedule by hand). Leaving
-- it after the window is harmless: the guard makes every firing a no-op.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-notes-catchup') then
    perform cron.unschedule('pb-notes-catchup');
  end if;
end $$;

select cron.schedule(
  'pb-notes-catchup',
  '*/4 * * * *',
  $cmd$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('max_notes', 12, 'budget_ms', 110000, 'concurrency', 4),
      timeout_milliseconds := 150000
    )
    where now() < timestamptz '2026-09-25 05:00:00+00'
      and not (extract(hour from now() at time zone 'utc') = 5 and extract(minute from now() at time zone 'utc') >= 30);
  $cmd$
);
