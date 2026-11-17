-- WLIQ Prospect Book — the current read, one index probe per account, driven by pb_accounts (DECISIONS §67).
-- Filed under its applied version, byte-identical to the applied statement (RUNBOOK §28.6).
--
-- Replaces 20261115023404 (prospect_book_current_reads_by_index) the same night. That version found the
-- accounts with a recursive loose index scan, which is fast on its own (35 ms) but cannot be
-- parameterized: pb_board() joins `pb_current_reads r on r.account_id = k.account_id`, and the planner
-- re-ran the whole walk once per board row, so pb_board() went from 1.5 s to 4.5 s.
--
-- This one starts from pb_accounts, which holds every account that has a read (pb_reads_account_id_fkey,
-- on delete cascade), and takes each account's newest read with one probe of pb_reads_account_run_idx.
-- A join on account_id becomes two index probes per row; the whole view is 1,100 probes. Measured inside
-- a rolled-back block first: the view 6 ms, pb_board() 1,452 ms, pb_reconcile_state() 1,411 ms; the same
-- 1,100 ids as the DISTINCT ON view, nothing in either but not the other.
--
-- Visibility is unchanged. The view stays security_invoker, and pb_accounts and pb_reads carry the same
-- row policy for authenticated (pb_is_wliq()); anon reads neither table and reaches the view only
-- through the definer functions (DECISIONS §61). No ORDER BY: every caller orders (the page by
-- account_id, pb-score's batched `in (…)` by account_id), and an ordered view could not be flattened.
--
-- Section 0 refuses to run unless the live view is 20261115023404's; section 2 refuses a version that
-- returns a different number of rows than there are accounts with a read.

-- 0 · the view this replaces is 20261115023404's -----------------------------------------------------
do $$
begin
  if md5(pg_get_viewdef('public.pb_current_reads'::regclass, true)) is distinct from 'f9bc2b54d6feca4dff8ef5a1e85b083e' then
    raise exception 'pb_current_reads is not 20261115023404''s definition (md5 %); re-read it',
      md5(pg_get_viewdef('public.pb_current_reads'::regclass, true));
  end if;
end $$;

-- 1 · pb_current_reads ----------------------------------------------------------------------------------
create or replace view public.pb_current_reads with (security_invoker = on) as
select c.id, c.account_id, c.run_id, c.rubric_version, c.rubric_fingerprint, c.run_at, c.as_of, c.status,
       c.effective_tier, c.computed_tier, c.confidence, c.qualification_label, c.facts_present, c.ceiling,
       c.headroom_band, c.year1_band, c.urgency, c.cell, c.reason, c.flags, c.scorecard, c.scorecard_sha256,
       c.confidence_grade, c.computed_confidence_grade, c.confidence_overridden
  from public.pb_accounts a
  cross join lateral (
    select r.* from public.pb_reads r
     where r.account_id = a.id
     order by r.run_at desc
     limit 1
  ) c;

comment on view public.pb_current_reads is
  'The latest read per account, including the confidence grade. One probe of pb_reads_account_run_idx '
  'per account, driven by pb_accounts — never a sort of every read (DECISIONS §67). security_invoker, so '
  'the view never lends the definer''s reach; anon reads it only through the definer functions (§61).';

-- 2 · the same rows -------------------------------------------------------------------------------------
do $$
declare
  v_view  bigint;
  v_accts bigint;
begin
  select count(*) into v_view from public.pb_current_reads;
  select count(distinct account_id) into v_accts from public.pb_reads;
  if v_view <> v_accts then
    raise exception 'pb_current_reads returned % rows for % accounts with a read; refusing', v_view, v_accts;
  end if;
end $$;