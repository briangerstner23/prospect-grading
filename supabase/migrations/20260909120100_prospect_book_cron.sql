-- WLIQ Prospect Book — the schedule.
--
-- Decay and scoring run nightly inside the pb-score edge function; this schedules the call.
-- The bearer token is read from Vault at fire time, so no secret is written into the job.
-- pg_cron runs as the postgres role and may read vault.decrypted_secrets directly.

create extension if not exists pg_cron  with schema pg_catalog;
create extension if not exists pg_net   with schema extensions;

-- Idempotent: unschedule first so re-applying the migration does not double the job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-nightly-score') then
    perform cron.unschedule('pb-nightly-score');
  end if;
end $$;

select cron.schedule(
  'pb-nightly-score',
  '15 6 * * *',
  $job$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-score',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('triggered_by', 'pg_cron', 'kind', 'score')
    );
  $job$
);
