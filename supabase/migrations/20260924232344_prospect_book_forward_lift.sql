-- Forward lift: the lift report without the circle (DECISIONS §62; owner ruling, Three Books log,
-- 24 Sep 2026: "Fix the lift report before the 1 Oct snapshot; 15 Dec becomes a monitoring read").
--
-- What was wrong. pb_lift_by_cell compares each account's CURRENT cell with its contact events in
-- the last 90 days. A cell is "ready" because the account replied recently, and "replied" is the
-- same set of inbound and mutual contact events, so the report counts one fact twice and calls it
-- lift. It also has no as-of date, and the events stopped arriving: the three builders below were
-- never scheduled, so calls reached pb_contact_events only up to 11 Sep while pb_calls runs to today.
--
-- What this does.
--   1. Schedules the three contact-event builders nightly at 06:05 UTC, after the notes sweep and
--      before the score, so a morning's read sees the morning's calls. Each is idempotent (a
--      fingerprint conflict does nothing). Calls refresh by themselves through the Fathom webhook;
--      email and quotes refresh only when their staging tables are refilled, which is still a
--      person's session until a Gmail credential and an Orbit read credential exist.
--   2. pb_forward_lift(as_of, horizon): each account's cell AS OF a date, from the append-only
--      pb_reads (cells exist from 18 Sep), against outcomes strictly AFTER that date. Readiness can
--      no longer be caused by the outcome it is scored on. Every rate carries a Wilson 95% interval
--      and every lift an approximate exact-Poisson 95% interval (Byar), with the book-wide totals
--      beside them, so a thin number reads as thin.
--      It leaves out accounts Orbit shows as DELIVERING NOW (pb_orbit_overlap, 241 accounts on
--      24 Sep). Those are current clients inside Book 1 (the lifecycle defect, plan CL-02), and their
--      delivery calls are not sales replies: a dry run on 24 Sep found every one of the 13 accounts
--      engaged since 19 Sep was a delivering client. The exclusion is a proxy until Build 1 gives
--      every account a lifecycle state; the count left out is reported beside the result.
--   3. pb_lift() gains a "forward" block anchored at the end of 18 Sep 2026 (each account's last
--      ranking that day: the grid's first day, and the date the plan pre-registers). The old
--      "cells" block stays for continuity, labelled circular.
--   4. pb_snapshot_lift() stores the forward rows beside the old ones ("fwd:<cell>"), and marks the
--      old rows circular, so the 1 Oct snapshot records both and says which is evidence.
--
-- A monitoring read, not a verdict. The 90-day window from the end of 18 Sep closes at the end of
-- 17 Dec; until then the counts are partial and window_closed is false. PRO-8's re-run on 15 Dec
-- reads this, labelled. Nothing here touches a rubric, a read, a tier or a rank (rule 6).

-- 1. The nightly contact-event refresh -------------------------------------------------------------
do $$ begin
  perform cron.unschedule('pb-nightly-events');
exception when others then null;
end $$;

select cron.schedule(
  'pb-nightly-events',
  '5 6 * * *',
  $cron$ select public.pb_contact_events_from_calls();
         select public.pb_contact_events_from_gmail();
         select public.pb_contact_events_from_quotes(); $cron$
);

-- 2. Intervals ---------------------------------------------------------------------------------------
-- Wilson score interval for k successes in n trials, 95%.
create or replace function public.pb_wilson(k bigint, n bigint)
returns numeric[]
language sql immutable set search_path = public as $$
  select case when n is null or n = 0 then array[null, null]::numeric[] else array[
    round(((k::numeric / n) + 1.9208 / n - 1.96 * sqrt((k::numeric / n) * (1 - k::numeric / n) / n + 0.9604 / (n::numeric * n)))
          / (1 + 3.8416 / n), 4),
    round(((k::numeric / n) + 1.9208 / n + 1.96 * sqrt((k::numeric / n) * (1 - k::numeric / n) / n + 0.9604 / (n::numeric * n)))
          / (1 + 3.8416 / n), 4)
  ] end;
$$;

-- Byar's approximation to the exact Poisson 95% interval for an observed count k.
create or replace function public.pb_poisson_ci(k bigint)
returns numeric[]
language sql immutable set search_path = public as $$
  select array[
    case when k is null then null when k = 0 then 0
         else k * power(1 - 1.0 / (9 * k) - 1.96 / (3 * sqrt(k::numeric)), 3) end,
    case when k is null then null
         else (k + 1) * power(1 - 1.0 / (9 * (k + 1)) + 1.96 / (3 * sqrt((k + 1)::numeric)), 3) end
  ]::numeric[];
$$;

-- 3. The forward read --------------------------------------------------------------------------------
create or replace function public.pb_forward_lift(p_as_of timestamptz, p_horizon_days integer default 90)
returns table (
  cell_rank integer, cell_id text, cell_name text,
  accounts bigint, replied bigint, quoted bigint, promoted bigint,
  reply_rate numeric, reply_rate_lo numeric, reply_rate_hi numeric,
  quote_rate numeric, quote_rate_lo numeric, quote_rate_hi numeric,
  reply_lift numeric, reply_lift_lo numeric, reply_lift_hi numeric,
  quote_lift numeric, quote_lift_lo numeric, quote_lift_hi numeric,
  as_of timestamptz, window_end timestamptz, window_closed boolean,
  book_accounts bigint, book_replied bigint, book_quoted bigint, left_out_delivering bigint
)
language sql stable set search_path = public as $$
  with w as (
    select p_as_of as t0,
           p_as_of + make_interval(days => p_horizon_days) as t1,
           least(p_as_of + make_interval(days => p_horizon_days), now()) as t_end
  ),
  -- each account's latest read on or before the as-of moment: the cell it was in, from what was known then
  r as (
    select distinct on (x.account_id) x.account_id, x.scorecard
      from public.pb_reads x, w
     where x.run_at <= w.t0 and x.scorecard ? 'chase_cell'
     order by x.account_id, x.run_at desc
  ),
  -- current clients being delivered to: their calls are delivery, not sales (see the header)
  delivering as (
    select distinct o.account_id from public.pb_orbit_overlap o where o.lane like 'delivering now%'
  ),
  rows_ as (
    select r.account_id,
           coalesce(r.scorecard -> 'chase_cell' ->> 'id', 'no-cell')                 as cell_id,
           coalesce(r.scorecard -> 'chase_cell' ->> 'name', 'No cell')               as cell_name,
           coalesce((r.scorecard -> 'chase_cell' ->> 'rank')::integer, 99)           as cell_rank,
           exists (select 1 from public.pb_contact_events e, w
                    where e.account_id = r.account_id
                      and e.direction in ('inbound', 'mutual')
                      and e.occurred_at > w.t0 and e.occurred_at <= w.t_end)          as replied,
           exists (select 1 from public.pb_contact_events e, w
                    where e.account_id = r.account_id
                      and e.channel = 'quote'
                      and e.occurred_at > w.t0 and e.occurred_at <= w.t_end)          as quoted,
           exists (select 1 from public.pb_promotions p, w
                    where p.account_id = r.account_id
                      and p.first_invoice_at > w.t0::date
                      and p.first_invoice_at <= w.t_end::date)                        as promoted
      from r
      join public.pb_accounts a on a.id = r.account_id and a.book <> 'merged'
     where not exists (select 1 from delivering d where d.account_id = r.account_id)
  ),
  tot as (
    select count(*) as n,
           count(*) filter (where replied) as rp,
           count(*) filter (where quoted)  as q,
           (select count(*) from r where exists (select 1 from delivering d where d.account_id = r.account_id)) as left_out
      from rows_
  ),
  g as (
    select x.cell_rank, x.cell_id, x.cell_name,
           count(*)                           as n,
           count(*) filter (where x.replied)  as rp,
           count(*) filter (where x.quoted)   as q,
           count(*) filter (where x.promoted) as pr
      from rows_ x
     group by x.cell_rank, x.cell_id, x.cell_name
  )
  select g.cell_rank, g.cell_id, g.cell_name,
         g.n, g.rp, g.q, g.pr,
         round(g.rp::numeric / nullif(g.n, 0), 4), (public.pb_wilson(g.rp, g.n))[1], (public.pb_wilson(g.rp, g.n))[2],
         round(g.q::numeric  / nullif(g.n, 0), 4), (public.pb_wilson(g.q,  g.n))[1], (public.pb_wilson(g.q,  g.n))[2],
         -- lift = observed / expected at the book's own rate; the interval is on the observed count
         -- (the book-wide rate is treated as known, which it nearly is beside one cell)
         round(g.rp / nullif(g.n * tot.rp::numeric / nullif(tot.n, 0), 0), 2),
         round((public.pb_poisson_ci(g.rp))[1] / nullif(g.n * tot.rp::numeric / nullif(tot.n, 0), 0), 2),
         round((public.pb_poisson_ci(g.rp))[2] / nullif(g.n * tot.rp::numeric / nullif(tot.n, 0), 0), 2),
         round(g.q  / nullif(g.n * tot.q::numeric  / nullif(tot.n, 0), 0), 2),
         round((public.pb_poisson_ci(g.q))[1]  / nullif(g.n * tot.q::numeric  / nullif(tot.n, 0), 0), 2),
         round((public.pb_poisson_ci(g.q))[2]  / nullif(g.n * tot.q::numeric  / nullif(tot.n, 0), 0), 2),
         w.t0, w.t1, (w.t1 <= now()),
         tot.n, tot.rp, tot.q, tot.left_out
    from g cross join tot cross join w
   order by g.cell_rank;
$$;

-- 4. pb_lift(): the forward read beside the old one ------------------------------------------------
create or replace function public.pb_lift()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'taken_at', now(),
    'cells', coalesce((select jsonb_agg(to_jsonb(l) order by l.cell_rank) from public.pb_lift_by_cell l), '[]'::jsonb),
    'cells_note', 'Circular: a cell is ready because the account replied recently, and these replies are the same events. Kept for continuity; not evidence.',
    'forward', coalesce((select jsonb_agg(to_jsonb(f) order by f.cell_rank)
                           from public.pb_forward_lift('2026-09-19 00:00:00+00'::timestamptz, 90) f), '[]'::jsonb),
    'forward_note', 'Each account''s cell at the end of the grid''s first day (18 Sep 2026), against replies and quotes from 19 Sep on only, leaving out clients Orbit shows as delivering now (their calls are delivery, not sales). 95% intervals. A monitoring read until the window closes on 17 Dec 2026, not a verdict.',
    'events_newest', (select jsonb_object_agg(channel, newest) from (
                        select channel, max(occurred_at) as newest from public.pb_contact_events group by channel) e),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('taken_at', s.taken_at, 'cell_id', s.cell_id, 'row', s.row) order by s.taken_at desc, s.cell_id)
        from (select taken_at, cell_id, row from public.pb_lift_snapshots order by taken_at desc limit 60) s), '[]'::jsonb)
  );
$$;

-- 5. pb_snapshot_lift(): both reads, labelled -------------------------------------------------------
create or replace function public.pb_snapshot_lift()
returns integer
language sql security definer set search_path = public as $$
  insert into public.pb_lift_snapshots (taken_at, cell_id, row)
  select current_date, l.cell_id, to_jsonb(l) || jsonb_build_object('circular', true)
    from public.pb_lift_by_cell l
  on conflict (taken_at, cell_id) do update set row = excluded.row;
  insert into public.pb_lift_snapshots (taken_at, cell_id, row)
  select current_date, 'fwd:' || f.cell_id, to_jsonb(f) || jsonb_build_object('circular', false)
    from public.pb_forward_lift('2026-09-19 00:00:00+00'::timestamptz, 90) f
  on conflict (taken_at, cell_id) do update set row = excluded.row;
  select count(*)::integer from public.pb_lift_snapshots where taken_at = current_date;
$$;

-- Grants: the new functions are not public. pb_lift() and pb_snapshot_lift() keep the grants they
-- already hold (create or replace preserves them); pb_lift() stays anon-executable for the board.
revoke all on function public.pb_forward_lift(timestamptz, integer) from public, anon;
grant execute on function public.pb_forward_lift(timestamptz, integer) to authenticated, service_role;
revoke all on function public.pb_wilson(bigint, bigint) from public, anon;
grant execute on function public.pb_wilson(bigint, bigint) to authenticated, service_role;
revoke all on function public.pb_poisson_ci(bigint) from public, anon;
grant execute on function public.pb_poisson_ci(bigint) to authenticated, service_role;
