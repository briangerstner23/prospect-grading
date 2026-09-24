-- Prospect Book — the notes catch-up is finished; remove its job (TB-41).
-- The backlog emptied by 24 Sep 00:57 UTC: every fathom_call record behind the cursor read,
-- pipedrive_note current, the last runs finding nothing. Since the fix: 383 facts and 889 review
-- candidates written, 0 runs halted or failed. The nightly pb-nightly-notes job carries on alone.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-notes-catchup') then
    perform cron.unschedule('pb-notes-catchup');
  end if;
end $$;
