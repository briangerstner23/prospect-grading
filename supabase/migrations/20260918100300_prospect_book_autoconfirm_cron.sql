/* ------------------------------------------------------------------ *
 * 7. when it runs
 * ------------------------------------------------------------------ */

-- 06:00 UTC: after the notes sweep (05:45) writes the morning's candidates and before the score
-- (06:15) reads the facts, so a claim approved this morning reaches this morning's tier rather
-- than tomorrow's. In-database, like the watchdog, for the watchdog's reason: the thing that took
-- both nightly jobs out on 12 Sep was the API gateway, and a job that goes through the gateway to
-- do database work has bought itself a dependency it does not need.
select cron.schedule('pb-autoconfirm', '0 6 * * *',
  $job$ select public.pb_autoconfirm_facts(false, 500); $job$);
