-- WLIQ Prospect Book — reconcile from a snapshot (DECISIONS §68).
--
-- The scheduled reconcile (scripts/reconcile.ts, CI every six hours) failed on every run from
-- 14 Nov 2026: pb_reconcile_state() hit anon's 3 s statement_timeout. The function is not slow —
-- 0.23 s warm, every page already in memory — but the project runs on the Micro compute size, a
-- shared two-core ARM CPU, and the same call has taken from 44 ms to 4.9 s (pg_stat_statements,
-- 17 Nov). A check that depends on the CPU's mood at :17 past the hour is not a check.
--
-- So the database takes the reconcile itself. pg_cron runs pb_reconcile_snapshot() every twenty
-- minutes as postgres, which has no statement_timeout; the result lands in pb_reconcile_snapshots;
-- and anon reads the newest one through pb_reconcile_latest(), a single-row index read. The state
-- is never older than twenty minutes plus the job's own run, and scripts/reconcile.ts FAILS when it
-- is older than three hours, so a stopped job cannot hide drift behind an old green snapshot.
--
-- pb_reconcile_state() is not touched: three tests pin its newest definition (the rule-9 CASE, the
-- meeting canary, meetings_work) and every check it makes is the same check. It stays callable by
-- anon, as DECISIONS §61 lists it; nothing in the repository calls it with the publishable key once
-- reconcile.ts reads the snapshot.
--
-- Staleness in the other direction is harmless: reconcile fails on a migration APPLIED with no file,
-- never on a file not yet applied, so a snapshot taken before the newest migration cannot fail a push.

-- 1 · the snapshots ------------------------------------------------------------------------------
create table if not exists public.pb_reconcile_snapshots (
  id           bigint generated always as identity primary key,
  generated_at timestamptz not null default now(),
  took_ms      integer not null,
  state        jsonb not null
);
create index if not exists pb_reconcile_snapshots_generated_idx
  on public.pb_reconcile_snapshots (generated_at desc);
alter table public.pb_reconcile_snapshots enable row level security;
-- A new table arrives holding everything for anon AND authenticated (CLAUDE.md, Supabase). Nobody
-- reads it over PostgREST: pb_reconcile_latest() is the only door.
revoke all on table public.pb_reconcile_snapshots from public, anon, authenticated;

comment on table public.pb_reconcile_snapshots is
  'pb_reconcile_state() as of generated_at, written by pg_cron job pb-reconcile-snapshot every 20 minutes and read by pb_reconcile_latest(). Counts only, the same object anon could already call for. Seven days kept (DECISIONS §68).';

-- 2 · taking one ---------------------------------------------------------------------------------
create or replace function public.pb_reconcile_snapshot() returns jsonb
language plpgsql security invoker set search_path = public as
$$
declare
  t0 timestamptz := clock_timestamp();
  s  jsonb;
  ms integer;
begin
  s  := public.pb_reconcile_state();
  ms := greatest(0, round(extract(epoch from (clock_timestamp() - t0)) * 1000))::integer;
  insert into public.pb_reconcile_snapshots (took_ms, state) values (ms, s);
  delete from public.pb_reconcile_snapshots where generated_at < now() - interval '7 days';
  return jsonb_build_object('took_ms', ms);
end;
$$;
revoke all on function public.pb_reconcile_snapshot() from public, anon, authenticated;

comment on function public.pb_reconcile_snapshot() is
  'Stores pb_reconcile_state() in pb_reconcile_snapshots and drops snapshots older than seven days. Run by pg_cron (pb-reconcile-snapshot) as postgres, outside any API timeout; never callable by anon or authenticated (DECISIONS §68).';

-- 3 · reading the newest -------------------------------------------------------------------------
create or replace function public.pb_reconcile_latest() returns jsonb
language sql stable security definer set search_path = public as
$$
  select s.state || jsonb_build_object('snapshot', jsonb_build_object(
           'id', s.id,
           'taken_at', s.generated_at,
           'took_ms', s.took_ms,
           'age_seconds', round(extract(epoch from (now() - s.generated_at)))))
  from public.pb_reconcile_snapshots s
  order by s.generated_at desc
  limit 1
$$;
revoke all on function public.pb_reconcile_latest() from public;
grant execute on function public.pb_reconcile_latest() to anon, authenticated;

comment on function public.pb_reconcile_latest() is
  'The newest pb_reconcile_snapshots row: pb_reconcile_state()''s object plus a `snapshot` block (id, taken_at, took_ms, age_seconds). Null before the first snapshot. What scripts/reconcile.ts reads with the publishable key; it fails a snapshot older than three hours (DECISIONS §68).';

-- 4 · the schedule -------------------------------------------------------------------------------
-- Minutes 7, 27 and 47: clear of the nightly chain's :00 / :12 / :13 / :15 marks and of the CI's :17.
select cron.unschedule(jobid) from cron.job where jobname = 'pb-reconcile-snapshot';
select cron.schedule('pb-reconcile-snapshot', '7,27,47 * * * *', $cron$select public.pb_reconcile_snapshot()$cron$);

-- 5 · the first snapshot, so the reader has something before the first tick ------------------------
select public.pb_reconcile_snapshot();