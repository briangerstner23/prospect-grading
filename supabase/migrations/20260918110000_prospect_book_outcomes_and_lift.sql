-- The outcome loop starts (owner decision, 18 Sep 2026, move 4 — DECISIONS §50).
--
-- Nothing in the book has ever measured whether a grade predicts anything: 2 won deals, 67 lost,
-- 31 retrodictable clients, one rank correlation of 0.27 measured once (PRO-8, UNVALIDATED). The
-- outcomes that exist in volume are earlier in the funnel — a first reply, a quote — and they are
-- already recorded as dated contact events. This migration names them as OUTCOMES and reports
-- them by CHASE CELL, which is the question the grid has to answer: does the cell we work first
-- produce more quotes and wins per account than the cells we work later?
--
--   pb_outcomes        per live account: first / last reply, first / last quote, counts in the
--                      last 90 days, the first won deal, the first invoice (pb_promotions)
--   pb_lift_by_cell    per cell: accounts, share of accounts, replied / quoted / won / promoted,
--                      share of quotes, and LIFT = the cell's quote rate over the book's quote
--                      rate (1.0 = no better than chance; the research's bar is 2× top over bottom)
--   pb_lift()          the same, as jsonb, SECURITY DEFINER, for the page — counts only, no names
--   pb_lift_snapshots  one row per cell per month, written by pb_snapshot_lift() on the 1st at
--                      07:30 UTC, so the report has a history to compare against
--
-- Aggregates only: nothing here returns an account name. Lift is a ratio of two rates, never a
-- composite of the reads (PRO-0). Thin numbers are the honest state and the reason the clock
-- has to start now.

create or replace view public.pb_outcomes
with (security_invoker = true) as
select a.id as account_id,
       min(e.occurred_at) filter (where e.direction in ('inbound', 'mutual'))                                          as first_reply_at,
       max(e.occurred_at) filter (where e.direction in ('inbound', 'mutual'))                                          as last_reply_at,
       count(*)           filter (where e.direction in ('inbound', 'mutual') and e.occurred_at >= now() - interval '90 days') as replies_90d,
       min(e.occurred_at) filter (where e.channel = 'quote')                                                            as first_quote_at,
       max(e.occurred_at) filter (where e.channel = 'quote')                                                            as last_quote_at,
       count(*)           filter (where e.channel = 'quote' and e.occurred_at >= now() - interval '90 days')            as quotes_90d,
       (select min(d.won_time) from public.pb_deals d where d.account_id = a.id and d.status = 'won')                  as won_at,
       (select min(p.first_invoice_at) from public.pb_promotions p where p.account_id = a.id)                          as first_invoice_at
  from public.pb_accounts a
  left join public.pb_contact_events e on e.account_id = a.id
 where a.book in ('prospect', 'parked')
 group by a.id;

comment on view public.pb_outcomes is
  'The outcome events the calibration loop scores against, per live account: replies and quotes '
  'from the dated contact events, the first won deal, the first invoice. DECISIONS §50, move 4.';

revoke all on public.pb_outcomes from anon, authenticated;

create or replace view public.pb_lift_by_cell
with (security_invoker = true) as
with rows_ as (
  select r.account_id,
         coalesce(r.scorecard -> 'chase_cell' ->> 'id',   'no-cell')                        as cell_id,
         coalesce(r.scorecard -> 'chase_cell' ->> 'name', 'No cell (rubric before 0.1.7)')  as cell_name,
         coalesce((r.scorecard -> 'chase_cell' ->> 'rank')::integer, 99)                    as cell_rank,
         coalesce(o.replies_90d, 0) as replies_90d,
         coalesce(o.quotes_90d, 0)  as quotes_90d,
         o.won_at, o.first_invoice_at
    from public.pb_current_reads r
    join public.pb_accounts a on a.id = r.account_id and a.book in ('prospect', 'parked')
    left join public.pb_outcomes o on o.account_id = r.account_id
),
tot as (
  select count(*)                                          as n,
         count(*) filter (where quotes_90d > 0)            as q,
         count(*) filter (where replies_90d > 0)           as rp
    from rows_
)
select x.cell_rank, x.cell_id, x.cell_name,
       count(*)                                                                   as accounts,
       round(100.0 * count(*) / nullif(tot.n, 0), 1)                              as pct_of_accounts,
       count(*) filter (where x.replies_90d > 0)                                  as replied_90d,
       count(*) filter (where x.quotes_90d > 0)                                   as quoted_90d,
       count(*) filter (where x.won_at is not null)                               as won,
       count(*) filter (where x.first_invoice_at is not null)                     as promoted,
       round(100.0 * count(*) filter (where x.quotes_90d > 0) / nullif(tot.q, 0), 1) as pct_of_quotes,
       round(((count(*) filter (where x.quotes_90d > 0))::numeric / nullif(count(*), 0))
             / nullif(tot.q::numeric / nullif(tot.n, 0), 0), 2)                   as quote_lift,
       round(((count(*) filter (where x.replies_90d > 0))::numeric / nullif(count(*), 0))
             / nullif(tot.rp::numeric / nullif(tot.n, 0), 0), 2)                  as reply_lift
  from rows_ x
 cross join tot
 group by x.cell_rank, x.cell_id, x.cell_name, tot.n, tot.q, tot.rp
 order by x.cell_rank;

comment on view public.pb_lift_by_cell is
  'The lift report: per chase cell, the share of accounts against the share of quotes and '
  'replies in the last 90 days, and the cell''s quote and reply rate over the book''s. 1.0 is '
  'chance; the 9 Sep research wants the top band to convert at least twice the bottom. Counts '
  'only. DECISIONS §50, move 4.';

revoke all on public.pb_lift_by_cell from anon, authenticated;

create or replace function public.pb_lift()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'cells', coalesce((select jsonb_agg(to_jsonb(l) order by l.cell_rank) from public.pb_lift_by_cell l), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('taken_at', s.taken_at, 'cell_id', s.cell_id, 'row', s.row) order by s.taken_at desc, s.cell_id)
        from (select taken_at, cell_id, row from public.pb_lift_snapshots order by taken_at desc limit 60) s), '[]'::jsonb)
  );
$$;

revoke all on function public.pb_lift() from public;
grant execute on function public.pb_lift() to anon, authenticated, service_role;

comment on function public.pb_lift() is
  'The lift-by-cell report for the page: today''s rows and up to sixty monthly snapshot rows. '
  'SECURITY DEFINER so the page reads counts without pb_contact_events, pb_deals or '
  'pb_promotions becoming readable. Aggregates only, no names. DECISIONS §50.';

create table if not exists public.pb_lift_snapshots (
  taken_at   date        not null,
  cell_id    text        not null,
  row        jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (taken_at, cell_id)
);

-- Every new pb_ table arrives with anon and authenticated holding everything (CLAUDE.md).
revoke all on public.pb_lift_snapshots from anon, authenticated;
alter table public.pb_lift_snapshots enable row level security;

comment on table public.pb_lift_snapshots is
  'The lift report, one row per cell per month (pb_snapshot_lift, cron pb-monthly-lift on the '
  '1st at 07:30 UTC), so the grid can be judged against its own history. Counts only.';

create or replace function public.pb_snapshot_lift()
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.pb_lift_snapshots (taken_at, cell_id, row)
  select current_date, l.cell_id, to_jsonb(l)
    from public.pb_lift_by_cell l
  on conflict (taken_at, cell_id) do update set row = excluded.row;
  select count(*)::integer from public.pb_lift_snapshots where taken_at = current_date;
$$;

revoke all on function public.pb_snapshot_lift() from public;
grant execute on function public.pb_snapshot_lift() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-monthly-lift') then
    perform cron.unschedule('pb-monthly-lift');
  end if;
end $$;

select cron.schedule(
  'pb-monthly-lift',
  '30 7 1 * *',
  $job$ select public.pb_snapshot_lift(); $job$
);
