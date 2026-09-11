-- WLIQ Prospect Book — schedule the nightly notes sweep.
--
-- pb-notes runs at 05:45 UTC, half an hour BEFORE pb-nightly-score at 06:15, so the facts it
-- writes are in the book by the time the night's grades are computed. A note read at 05:45
-- changes that morning's tier, not tomorrow's.
--
-- The job is a no-op until PB_ANTHROPIC_API_KEY is in Vault: pb-notes answers 503 and writes
-- no pb_runs row, so an unconfigured sweep is silent rather than a nightly failure.
--
-- Cost control lives in the body, not the schedule: max_notes caps one run's model calls, and
-- the watermark means a run only reads notes touched since the last one. Steady state is a
-- handful of notes a night.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-nightly-notes') then
    perform cron.unschedule('pb-nightly-notes');
  end if;
end $$;

select cron.schedule(
  'pb-nightly-notes',
  '45 5 * * *',
  $job$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('max_notes', 120)
    );
  $job$
);
