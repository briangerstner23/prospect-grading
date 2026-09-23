-- Close the anonymous read surface down to what the public pages and CI actually use.
--
-- Owner ruling, 23 Sep 2026. It SUPERSEDES DECISIONS §5 ("the book reads publicly", migration
-- 20260910190000_prospect_book_public_read.sql) for every table and view below; §5 is not
-- re-argued here, it is narrowed. DECISIONS §61 records the ruling.
--
-- Why. §5 opened the base tables to `anon` so a page could read them with the publishable key.
-- The page stopped reading them long ago — since §37/§43 it reads the board and the dossier
-- through SECURITY DEFINER functions (pb_board, pb_dossier) that return their own columns and
-- nothing else, and web/board.html itself never shows an email address. But the policies stayed,
-- so the key shipped in the page still opened, to anyone who asked PostgREST directly:
--   - pb_calls: every call's attendee list WITH email addresses, and the call summaries;
--   - pb_facts.entered_by, pb_register.made_by and pb_identity_candidates.reviewed_by: staff
--     email addresses;
--   - pb_runs.errors: run error text that names agencies;
--   - pb_rubric_versions.activated_by (a staff address) and .preview_diff (account ids);
--   - the accounts, deals, reads, signals and register rows the board already summarises, and
--     ten security_invoker views over them.
-- The page's own rule was "no email address reaches the page"; the key that serves the page
-- reached all of them.
--
-- What anon keeps (verified against web/board.html, web/dashboard.html, web/method.html,
-- scripts/board_page_test.ts, scripts/reconcile.ts and .github/workflows/ci.yml, 23 Sep):
--   tables    pb_removal_reasons  select, whole row (the removal vocabulary; no person in it)
--             pb_rubric_versions  select on (version, status, spec, spec_sha256, activated_at,
--                                 created_at) — board.html and method.html read the active spec
--             pb_runs             select on (id, kind, source, status, started_at, finished_at,
--                                 counts), rows where source = 'pb-score' and status = 'success'
--                                 only — board.html's "last scored" line. pb-score's counts is a
--                                 fixed shape: {scored, parked, unclassified, overridden, ranked,
--                                 errors, snapshots} as numbers plus rubric_version and as_of. No
--                                 name reaches it; the error TEXT lives in pb_runs.errors, which
--                                 stays closed.
--   functions pb_board(), pb_dossier(uuid), pb_lift(), pb_dashboard(), pb_reconcile_state() —
--             all SECURITY DEFINER, all untouched here. pb_reconcile_state is what CI calls with
--             the publishable key and must keep working.
--
-- Everything else anon could read closes: the anon policies are dropped and SELECT is revoked
-- from anon on every other pb_ relation, enumerated from the catalog at apply time rather than
-- from a list written here, so a relation this header forgets is closed anyway. As of 23 Sep that
-- is the tables pb_accounts, pb_calls, pb_deals, pb_facts, pb_fact_candidates (a grant with no
-- policy — it returned nothing, and is closed anyway), pb_identity_candidates, pb_reads,
-- pb_register, pb_signals, and the views pb_current_facts, pb_current_reads, pb_engagement,
-- pb_engagement_shape, pb_mdm_junk_hits, pb_mdm_resolution, pb_movement,
-- pb_orbit_admission_queue, pb_orbit_overlap, pb_pulse. Every view anon could read was
-- security_invoker; the non-invoker views (pb_prospect_board, pb_chase_board, pb_removals, ...)
-- already held no anon grant.
--
-- Also: pb_build_rubric_013() loses EXECUTE for public, anon and authenticated. It was created in
-- the database outside any migration, carries the PUBLIC grant every new function gets (see
-- 20260918160352), and nothing calls it — no cron job, no function body, no view, no file in this
-- repository (checked 23 Sep). The guard below skips it on a replay where it does not exist.
--
-- NOT touched: every `authenticated` policy and grant. The signed-in back office (web/index.html)
-- reads pb_accounts, pb_current_reads, pb_runs, pb_fact_candidates and the rest as authenticated,
-- under the pb_is_wliq() policies, and none of that changes.
--
-- Idempotent: drop-if-exists, revoke (a no-op when nothing is held), then the three grants and the
-- one policy re-created. Safe to run twice. A table-level REVOKE also removes the column grants,
-- so re-running it lands on exactly the same column set.
--
-- TO REVERSE (owner decision only): re-create the pb_*_read_anon policies from 20260910190000 and
-- `grant select` on the tables to anon. Reversing un-publishes nothing that was read while open.

-- 1 · the anon row policies (all ten from 20260910190000, and the 18 Sep rewrite of the register's)
drop policy if exists pb_accounts_read_anon  on public.pb_accounts;
drop policy if exists pb_facts_read_anon     on public.pb_facts;
drop policy if exists pb_signals_read_anon   on public.pb_signals;
drop policy if exists pb_reads_read_anon     on public.pb_reads;
drop policy if exists pb_register_read_anon  on public.pb_register;
drop policy if exists pb_calls_read_anon     on public.pb_calls;
drop policy if exists pb_deals_read_anon     on public.pb_deals;
drop policy if exists pb_identity_read_anon  on public.pb_identity_candidates;
-- pb_runs keeps an anon policy, narrowed to the one row kind the board reads.
drop policy if exists pb_runs_read_anon      on public.pb_runs;
create policy pb_runs_read_anon on public.pb_runs
  for select to anon
  using (source = 'pb-score' and status = 'success');
-- pb_rubric_read_anon (using true) stays: every version's spec is public by design (method.html
-- prints it). Its person and its diff are closed by the column grant below.

-- 2 · revoke everything anon holds on every pb_ relation except the removal vocabulary
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname like 'pb\_%'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and c.relname <> 'pb_removal_reasons'
  loop
    execute format('revoke all on table public.%I from anon', r.relname);
  end loop;
end
$$;

-- 3 · what the pages read, column by column
grant select (id, kind, source, status, started_at, finished_at, counts)
  on public.pb_runs to anon;
grant select (version, status, spec, spec_sha256, activated_at, created_at)
  on public.pb_rubric_versions to anon;
grant select on public.pb_removal_reasons to anon;

-- 4 · the orphan function
do $$
begin
  if to_regprocedure('public.pb_build_rubric_013()') is not null then
    revoke execute on function public.pb_build_rubric_013() from public, anon, authenticated;
  end if;
end
$$;
