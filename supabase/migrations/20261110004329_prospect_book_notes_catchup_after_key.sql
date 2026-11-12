-- Prospect Book: a time-boxed note catch-up after the Anthropic key was replaced (10 Nov 2026).
--
-- PB_ANTHROPIC_API_KEY was refused (401) on every nightly notes run from 13 Oct to 9 Nov. Each run
-- halted on the refusal and marked nothing read past it (TB-41), so the backlog waited intact: about
-- 336 Pipedrive notes and the Fathom calls behind them. The owner replaced the key at 00:40 UTC on
-- 10 Nov; a hand-posted run at 00:41 read notes and wrote facts again.
--
-- This posts the nightly body every 3 minutes, pipedrive_note and fathom_call only, until 05:00 UTC
-- on 10 Nov (clear of the 05:00-05:59 nightly chain), then unschedules itself. A run with nothing
-- left to read makes no model call. The same shape as the 10 Oct catch-up (20261010125317,
-- DECISIONS §64).

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
      body    := jsonb_build_object('max_notes', 30, 'budget_ms', 110000, 'concurrency', 6,
                                    'sources', jsonb_build_array('pipedrive_note', 'fathom_call')),
      timeout_milliseconds := 150000
    )
    where now() < timestamptz '2026-11-10 05:00:00+00'
      and extract(hour from now() at time zone 'utc') <> 5;
    select cron.unschedule('pb-notes-catchup') where now() >= timestamptz '2026-11-10 05:00:00+00';
  $cmd$
);
