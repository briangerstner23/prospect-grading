-- The scoring pass for the potential snapshots (R4; owner decision, 18 Sep 2026, move 4 —
-- DECISIONS §50). Until now the snapshots accumulated (one per ranked account per night since
-- 17 Sep, §36) and nothing could ever fill actual_6m / actual_12m / actual_24m, because the
-- actuals live in QuickBooks and Orbit, which this database cannot read (Orbit is never written
-- and is read only through the MCP; QuickBooks likewise). So the actuals ARRIVE as rows an
-- operator records, and the pass scores the frozen snapshot against them.
--
--   pb_actuals            what an account actually billed in the 6 / 12 / 24 months after its
--                         first invoice, with the source and who recorded it. Service role only.
--   pb_score_snapshots()  the freeze is a SELECTION (§36): the latest snapshot on or before
--                         first_invoice_at, per account and estimator. For every such snapshot
--                         with an actual on file, fill the actual columns and stamp scored_at.
--                         Returns counts. Idempotent; re-run whenever actuals land.
--   pb_calibration        per estimator: how many scored, how many actuals fell inside the
--                         stated band (p10 ≤ actual < p90; an open top band counts on p10 alone).
--                         The hit-rate the research asked for. Brier stays null until an
--                         estimator produces the two probabilities (§36).
--
-- Operator step (RUNBOOK): at 6, 12 and 24 months after a promotion's first invoice, read the
-- account's billings from QuickBooks (or Orbit), insert one pb_actuals row, run
-- `select public.pb_score_snapshots();`. Nothing here reaches Orbit or QuickBooks itself.

create table if not exists public.pb_actuals (
  id           uuid        primary key default gen_random_uuid(),
  account_id   uuid        not null references public.pb_accounts (id),
  months       integer     not null check (months in (6, 12, 24)),
  revenue_usd  numeric     not null check (revenue_usd >= 0),
  source       text        not null check (source in ('quickbooks', 'orbit', 'manual')),
  period_start date,
  period_end   date,
  recorded_by  text        not null,
  recorded_at  timestamptz not null default now(),
  note         text,
  unique (account_id, months, source)
);

revoke all on public.pb_actuals from anon, authenticated;
alter table public.pb_actuals enable row level security;

comment on table public.pb_actuals is
  'What a promoted account actually billed in the 6 / 12 / 24 months after its first invoice, '
  'recorded by an operator from QuickBooks or Orbit. The input to pb_score_snapshots(). '
  'Service role only; dollar figures about named companies never reach a public read.';

create or replace function public.pb_score_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promotions integer := 0;
  v_frozen     integer := 0;
  v_scored     integer := 0;
begin
  select count(*) into v_promotions from public.pb_promotions where first_invoice_at is not null;

  -- The frozen snapshot per (account, estimator): the last claim the book made on or before the
  -- first invoice. A selection, never a second write (DECISIONS §36).
  create temp table if not exists _frozen on commit drop as
    select distinct on (s.account_id, s.estimator) s.id, s.account_id, s.estimator, p.first_invoice_at
      from public.pb_potential_snapshots s
      join public.pb_promotions p on p.account_id = s.account_id and p.first_invoice_at is not null
     where s.taken_at <= p.first_invoice_at
     order by s.account_id, s.estimator, s.taken_at desc;
  select count(*) into v_frozen from _frozen;

  with upd as (
    update public.pb_potential_snapshots s
       set actual_6m  = coalesce((select a.revenue_usd from public.pb_actuals a
                                   where a.account_id = s.account_id and a.months = 6
                                   order by a.recorded_at desc limit 1), s.actual_6m),
           actual_12m = coalesce((select a.revenue_usd from public.pb_actuals a
                                   where a.account_id = s.account_id and a.months = 12
                                   order by a.recorded_at desc limit 1), s.actual_12m),
           actual_24m = coalesce((select a.revenue_usd from public.pb_actuals a
                                   where a.account_id = s.account_id and a.months = 24
                                   order by a.recorded_at desc limit 1), s.actual_24m),
           scored_at  = now()
      from _frozen f
     where s.id = f.id
       and exists (select 1 from public.pb_actuals a where a.account_id = s.account_id)
     returning s.id
  )
  select count(*) into v_scored from upd;

  return jsonb_build_object(
    'promotions_with_first_invoice', v_promotions,
    'frozen_snapshots', v_frozen,
    'scored', v_scored,
    'run_at', now(),
    'note', 'brier stays null until an estimator produces p_35k_12m and p_100k_24m (DECISIONS §36)');
end
$$;

revoke all on function public.pb_score_snapshots() from public;
grant execute on function public.pb_score_snapshots() to service_role;

comment on function public.pb_score_snapshots() is
  'The 6 / 12 / 24-month scoring pass: fills the frozen snapshot''s actual columns from '
  'pb_actuals and stamps scored_at. Idempotent. The freeze is a selection at '
  'pb_promotions.first_invoice_at (§36). DECISIONS §50, move 4.';

create or replace view public.pb_calibration
with (security_invoker = true) as
select s.estimator,
       count(*)                                                                                  as scored,
       count(*) filter (where s.actual_12m is not null)                                          as with_12m,
       count(*) filter (where s.actual_12m is not null
                          and s.actual_12m >= coalesce(s.p10_12m, 0)
                          and (s.p90_12m is null or s.actual_12m < s.p90_12m))                  as hits_12m,
       round(100.0 * count(*) filter (where s.actual_12m is not null
                                        and s.actual_12m >= coalesce(s.p10_12m, 0)
                                        and (s.p90_12m is null or s.actual_12m < s.p90_12m))
             / nullif(count(*) filter (where s.actual_12m is not null), 0), 1)                  as hit_rate_12m
  from public.pb_potential_snapshots s
 where s.scored_at is not null
 group by s.estimator;

comment on view public.pb_calibration is
  'Interval hit-rate per estimator over the scored snapshots: did the true year-one land inside '
  'the stated band. The sizing pass mark PRO-16 asked for is set against this once it has rows.';

revoke all on public.pb_calibration from anon, authenticated;
