-- Driving the back-fill without a person watching it.
--
-- The crawl and the replay are both stepper-shaped for the same reason (pg_net
-- dispatches on commit), which makes them a poor fit for a hand-driven session and a
-- good fit for pg_cron. Three jobs, all temporary, all unscheduled when the wave is
-- done:
--
--   pb-fathom-crawl     every 10s   pb_fathom_crawl_step(50)
--   pb-fathom-guard     every 20s   pb_fathom_crawl_guard()
--   pb-fathom-backfill  every 30s   pb_fathom_backfill_tick(60)
--
-- Ten seconds, not five: Fathom rate-limits at roughly ten requests a minute, and
-- five-second spacing spent the budget and collected 429s.
--
-- How far back to go. The crawl would otherwise run until Fathom's history is
-- exhausted, which is years. The rubric answers it: the longest signal lifespan in
-- core/rubric.prospect.v0.1.json is 180 days (quote_lost) and every other signal
-- decays inside 90, so a meeting older than half a year cannot contribute a live
-- signal at all. Facts outlive signals — who decides, what they spend, how big they
-- are — so the cutoff is set at twelve months rather than six, which buys the facts
-- a wide margin and still stops. Pass a different cutoff to the guard to widen it.

create or replace function public.pb_fathom_crawl_guard(cutoff date default '2025-09-13')
returns text
language plpgsql security definer set search_path = public as $$
declare oldest date; d boolean;
begin
  select min(held_at)::date into oldest from public.pb_fathom_backfill;
  select done into d from public.pb_fathom_crawl where id = 1;
  if d or (oldest is not null and oldest <= cutoff) then
    update public.pb_fathom_crawl set done = true, request_id = null,
           last_note = case when d then 'history exhausted'
                            else 'stopped at cutoff ' || cutoff end
     where id = 1;
    perform cron.unschedule('pb-fathom-crawl');
    return 'stopped at ' || coalesce(oldest::text, 'nothing');
  end if;
  return 'running, oldest ' || coalesce(oldest::text, 'nothing');
end $$;

-- One tick of the replay. Settle first — the previous tick's deliveries have had a
-- tick to come back — then send the next batch, and only once the crawl is finished,
-- so the wave is one auditable pass rather than two interleaved.
create or replace function public.pb_fathom_backfill_tick(batch int default 25)
returns table (crawl_done boolean, sent int, ok int, failed int, waiting int)
language plpgsql security definer set search_path = public as $$
declare d boolean; s int := 0; r record;
begin
  select done into d from public.pb_fathom_crawl where id = 1;
  select * into r from public.pb_fathom_settle();
  if d then
    s := public.pb_fathom_replay(batch);
  end if;
  return query select d, s, r.ok, r.failed, r.waiting;
end $$;

revoke all on function public.pb_fathom_crawl_guard(date) from anon, authenticated;
revoke all on function public.pb_fathom_backfill_tick(int) from anon, authenticated;
