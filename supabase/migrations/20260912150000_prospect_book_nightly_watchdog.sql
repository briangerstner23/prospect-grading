-- WLIQ Prospect Book — notice the night that did not happen.
--
-- On 12 Sep 2026 both nightly jobs answered 500 and wrote no `pb_runs` row at all. The book
-- went a day unscored and its own record said nothing — not "failed", nothing. Every check in
-- RUNBOOK §15 reads the rows that exist, and the failure mode is an absence of rows.
--
-- WHY THIS LIVES IN THE DATABASE AND NOT IN THE FUNCTIONS. The obvious fix is for pb-score and
-- pb-notes to record their own failure. They cannot, for two independent reasons:
--
--   1. The call that failed was `public.pb_secret('PB_SYNC_TOKEN')` — the bearer check's own
--      input. A function that has not read the token does not yet know whether its caller is
--      pg_cron or a stranger, and these functions are deployed `verify_jwt = false` on a public
--      URL. Writing a run row before `bearerOk` hands anyone who knows the URL a way to fill
--      `pb_runs` with noise; writing it after is unreachable, because the secret read is what
--      failed.
--   2. The write would go through the very PostgREST gateway that had just returned 504. A
--      remedy that depends on the thing that broke is not a remedy.
--
-- pg_cron runs inside Postgres. No gateway, no bearer, no question about who is calling. It is
-- the only place that can still speak when the door is the thing that is jammed.
--
-- WHAT IT WRITES. One `pb_runs` row per missing job, `status = 'failed'`, `source = 'watchdog'`,
-- so it can never be mistaken for an attempt that really ran — and `counts` left null, because
-- nothing was counted. `closeAbandonedRuns` only ever touches rows still `running`, so it will
-- not see these. The page reads the newest `kind = 'score'` row solely as a fallback label for
-- when no reads exist at all (web/index.html:830), which is not a state this book is in, so a
-- watchdog row changes nothing a reader sees.
--
-- It records what pg_cron and pg_net saw, because at 07:00 both still remember: `pg_net` keeps
-- responses about six hours, and 06:15 is inside that. By the next morning the evidence is gone
-- and only this row is left, which is the entire point. Status codes and error text only — never
-- the response body, which carries account names into a table `anon` can read.
--
-- Idempotent twice over: re-applying the migration re-schedules one job by name, and the
-- function refuses to write a second row for a kind it has already reported on today.

create or replace function public.pb_nightly_watchdog()
returns integer
language plpgsql
security invoker
set search_path to 'public', 'cron', 'net'
as $fn$
declare
  since   timestamptz := date_trunc('day', now());
  written integer := 0;
  job     record;
begin
  for job in
    select * from (values
      ('score',  null::text,       'pb-nightly-score (06:15 UTC)', 'score'),
      ('ingest', 'written_record', 'pb-nightly-notes (05:45 UTC)', 'notes')
    ) as t(kind_, source_, label_, fn_)
  loop
    -- Did the job leave a finished run this morning?
    if exists (
      select 1 from public.pb_runs r
      where r.kind = job.kind_
        and (job.source_ is null or r.source = job.source_)
        and r.status in ('success', 'partial')
        and r.started_at >= since
    ) then
      continue;
    end if;

    -- Have we already said so today? Never two rows for one silent night.
    if exists (
      select 1 from public.pb_runs r
      where r.kind = job.kind_ and r.source = 'watchdog' and r.started_at >= since
    ) then
      continue;
    end if;

    insert into public.pb_runs (kind, source, triggered_by, status, finished_at, errors)
    values (
      job.kind_, 'watchdog', 'pb-nightly-watchdog', 'failed', now(),
      to_jsonb(array[
        format('No finished %s run since %s. %s left no pb_runs row, so the book was not brought up to date and nothing else would have said so.',
               job.kind_, to_char(since, 'YYYY-MM-DD HH24:MI'), job.label_),
        coalesce(
          (select string_agg(
             format('cron fired %s and reported %s; the function answered %s',
                    to_char(d.start_time, 'HH24:MI:SS'), d.status,
                    coalesce(r.status_code::text, r.error_msg, 'nothing pg_net still remembers')),
             ' / ' order by d.start_time desc)
           from cron.job_run_details d
           left join net._http_response r
                  on r.created between d.start_time and d.start_time + interval '5 minutes'
           where d.start_time >= since
             and d.command like '%functions/v1/pb-' || job.fn_ || '%'),
          'pg_cron has no record of the job firing at all.'),
        'Written by pb_nightly_watchdog, which runs in the database rather than through the API gateway, so it can still speak when the gateway is what failed. Re-run the job by hand (RUNBOOK §9 for the score, §17 for the sweep); this row is a record, not a retry.'
      ])
    );
    written := written + 1;
  end loop;

  return written;
end
$fn$;

comment on function public.pb_nightly_watchdog() is
  'Records a failed pb_runs row for any nightly job that left no finished run this morning. Runs from pg_cron at 07:00 UTC, in-database, so a broken API gateway cannot silence it.';

revoke execute on function public.pb_nightly_watchdog() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-nightly-watchdog') then
    perform cron.unschedule('pb-nightly-watchdog');
  end if;
end $$;

-- 07:00 UTC: 45 minutes after the score and 75 after the sweep, both of which finish in well
-- under two minutes, and still inside pg_net's memory of what the gateway answered.
select cron.schedule('pb-nightly-watchdog', '0 7 * * *', $job$ select public.pb_nightly_watchdog(); $job$);
