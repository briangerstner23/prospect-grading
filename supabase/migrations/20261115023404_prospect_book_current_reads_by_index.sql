-- WLIQ Prospect Book — the current read is found by index, not by sorting every read (DECISIONS §67).
-- Filed under its applied version, byte-identical to the applied statement (RUNBOOK §28.6).
--
-- pb_current_reads was `select distinct on (account_id) … from pb_reads order by account_id, run_at desc`.
-- DISTINCT ON reads EVERY row to keep one per account: 71,810 reads (343 MB, a scorecard each) for
-- 1,100 accounts on 15 Nov 2026, growing by about 830 a night. Measured that day: 3,128 ms for the view
-- alone, and pb_board() over it 1.5 s warm, past anon's 3 s statement_timeout whenever the cache was
-- cold or the shared project busy. The public board showed its error panel (two 500s on pb_board and
-- pb_lift at 01:17 UTC), and the 6-hourly reconcile had failed on the same timeout since at least 7 Nov.
--
-- The new definition reads only pb_reads, as before: a loose index scan walks the distinct account_ids
-- on pb_reads_account_run_idx, and for each one index probe takes its newest read (order by run_at desc
-- limit 1). Same table, same rows, same columns in the same order, same security_invoker: before
-- applying, the two were compared row for row (1,100 = 1,100, nothing in either but not the other), and
-- the new one ran in 35 ms. Ties on (account_id, run_at) take one row each way, as DISTINCT ON did
-- (there are none). The rows still come out in account_id order. A filter on account_id reaches the
-- probe, so pb_dossier() and pb-score's batched `in (…)` read only the accounts they ask for.
--
-- Section 0 refuses to run if the view moved since it was read; section 2 refuses to keep a version
-- that returns a different number of rows than there are accounts with a read.

-- 0 · the view this replaces is the one read on 15 Nov 2026 -------------------------------------------
do $$
begin
  if md5(pg_get_viewdef('public.pb_current_reads'::regclass, true)) is distinct from 'bb65f1e575fc94a1c36f94457dcbfd15' then
    raise exception 'pb_current_reads is not the definition this migration was written against (md5 %); re-read it',
      md5(pg_get_viewdef('public.pb_current_reads'::regclass, true));
  end if;
end $$;

-- 1 · pb_current_reads ----------------------------------------------------------------------------------
create or replace view public.pb_current_reads with (security_invoker = on) as
with recursive ids (account_id) as (
  (select r.account_id from public.pb_reads r order by r.account_id limit 1)
  union all
  select (select r.account_id from public.pb_reads r
           where r.account_id > ids.account_id order by r.account_id limit 1)
    from ids
   where ids.account_id is not null
)
select c.id, c.account_id, c.run_id, c.rubric_version, c.rubric_fingerprint, c.run_at, c.as_of, c.status,
       c.effective_tier, c.computed_tier, c.confidence, c.qualification_label, c.facts_present, c.ceiling,
       c.headroom_band, c.year1_band, c.urgency, c.cell, c.reason, c.flags, c.scorecard, c.scorecard_sha256,
       c.confidence_grade, c.computed_confidence_grade, c.confidence_overridden
  from ids
  cross join lateral (
    select r.* from public.pb_reads r
     where r.account_id = ids.account_id
     order by r.run_at desc
     limit 1
  ) c
 where ids.account_id is not null
 order by c.account_id;

comment on view public.pb_current_reads is
  'The latest read per account, including the confidence grade. Found by index (a loose scan of '
  'pb_reads_account_run_idx, then one probe per account), never by sorting every read — DECISIONS §67. '
  'security_invoker, so the view never lends the definer''s reach; anon reads it only through the '
  'definer functions (DECISIONS §61).';

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