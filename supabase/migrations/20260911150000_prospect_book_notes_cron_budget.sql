-- WLIQ Prospect Book — a nightly batch the sweep can actually finish.
--
-- The first live runs measured ~45 seconds per record: a model call on a call summary is not
-- quick. The original job asked for 120 records a night, which is roughly ninety minutes of
-- work inside a function the platform kills in a few. Every such run would have died mid-flight,
-- written nothing, and left pb_runs saying "running" forever.
--
-- pb-notes now stops itself on a wall-clock budget and writes each record as it finishes, so a
-- run always ends cleanly and always leaves a resumable watermark. The job's batch is sized to
-- match: a handful a night, with the watermark carrying the backlog across nights. Steady state
-- is a few new records a day, which this clears comfortably.

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
      body    := jsonb_build_object('max_notes', 8, 'budget_ms', 110000),
      timeout_milliseconds := 150000
    );
  $job$
);
