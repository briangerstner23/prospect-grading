-- Prospect Book — the notes catch-up, faster (owner, 23 Sep 2026: "can we catch up now").
--
-- Same job, same guards as 20260923211234, two knobs turned: six records read at once (the
-- function's own ceiling) and a run every three minutes. A run stops itself inside 150 s, so a
-- 180 s cadence still never overlaps two runs on one cursor — two runs on one cursor would read
-- the same records twice. The time box is unchanged: nothing posts after 2026-09-25 05:00 UTC or
-- in the 05:30–05:59 UTC window of the nightly run.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-notes-catchup') then
    perform cron.unschedule('pb-notes-catchup');
  end if;
end $$;

select cron.schedule(
  'pb-notes-catchup',
  '*/3 * * * *',
  $cmd$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('max_notes', 30, 'budget_ms', 110000, 'concurrency', 6),
      timeout_milliseconds := 150000
    )
    where now() < timestamptz '2026-09-25 05:00:00+00'
      and not (extract(hour from now() at time zone 'utc') = 5 and extract(minute from now() at time zone 'utc') >= 30);
  $cmd$
);
