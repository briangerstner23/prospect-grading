-- WLIQ Prospect Book — let the nightly score job wait for its own answer.
--
-- `pb-nightly-score` has called net.http_post with no timeout_milliseconds since
-- 20260909120100 created it, so pg_net applied its default of 5000 ms to a request that takes
-- roughly twenty seconds. Measured, not guessed — three consecutive score runs in pb_runs:
--
--   2026-09-11 16:26:10 -> 16:26:28   18 s
--   2026-09-11 16:40:36 -> 16:40:52   16 s
--   2026-09-12 13:05:57 -> 13:06:15   18 s   (680 accounts, 601 ranked)
--
-- NO DATA WAS EVER LOST TO THIS. The edge function keeps running after pg_net stops listening,
-- so the nightly score completed and wrote its pb_reads and its pb_runs row on every night it
-- was healthy. What the short timeout destroyed is the EVIDENCE: net._http_response recorded
-- "Timeout of 5000 ms reached" for every single nightly score, success and failure alike, so
-- the cron side of the system could never tell the two apart.
--
-- That mattered on 12 Sep 2026. Both nightly jobs failed — public.pb_secret(PB_SYNC_TOKEN),
-- the first call each function makes, came back 504 Gateway Timeout from the API gateway, so
-- pb-notes and pb-score each threw before writing a pb_runs row and answered 500. The sweep's
-- failure was legible, because 20260911150000 had already given that job a real timeout and
-- pg_net captured the 500. The score's failure was indistinguishable from every ordinary night:
-- the same 5000 ms timeout row it always wrote. A day of the book went unscored and the only
-- trace was an absence.
--
-- 150000 ms, matching pb-nightly-notes. The value is chosen to sit AT OR ABOVE the platform's
-- own request ceiling rather than near the job's runtime: a pg_net timeout shorter than the
-- platform's simply reintroduces the fault, discarding the outcome of a slow-but-successful run.
-- Longer than the platform allows costs nothing — the request ends when the platform ends it,
-- and pg_net records whatever came back. Eight times the observed runtime is headroom for a
-- larger roster, not an expectation.
--
-- Nothing else about the job changes: same name, same 06:15 UTC schedule, same bearer read from
-- Vault at fire time, same body. Idempotent, and amended the way every other cron migration here
-- amends one — unschedule by name, then re-schedule. The job takes a new jobid each time it is
-- re-scheduled, which is why the live jobids are not contiguous.

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
      body    := jsonb_build_object('triggered_by', 'pg_cron', 'kind', 'score'),
      timeout_milliseconds := 150000
    );
  $job$
);
