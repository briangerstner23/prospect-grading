-- WLIQ Prospect Book — pb_engagement's stage label is read by index, not by sorting every read (DECISIONS §67).
-- Filed under its applied version, byte-identical to the applied statement (RUNBOOK §28.6).
--
-- pb_engagement.stage_label is `(select r.urgency from pb_reads r where r.account_id = a.id
-- order by r.as_of desc limit 1)`. The only (account_id, …) indexes on pb_reads are ordered by run_at, so
-- for every account the subquery fetched all of its reads (about 67 each on 17 Nov 2026, one more a
-- night) and sorted them by as_of: 1,100 accounts x 67 rows inside pb_chase_board, the board's base.
-- Measured: that one node was 1.8 s of pb_chase_board's 2.6 s, and pb_board() took 6.65 s on 17 Nov with
-- every page already in memory, past anon's 3 s statement_timeout, so the public board showed its error.
--
-- This index matches the subquery exactly — account_id, then as_of descending, carrying urgency — so it
-- becomes one index-only probe per account. No view or function changes, so no answer changes: which read
-- wins a tie on (account_id, as_of) was never specified and is not now. A plain CREATE INDEX: the
-- migration runs in a transaction, which CONCURRENTLY cannot, and on about 72,000 narrow keys the
-- write lock on pb_reads lasts well under a second; pb-score writes reads only at 06:15 UTC.
create index if not exists pb_reads_account_asof_idx
  on public.pb_reads (account_id, as_of desc) include (urgency);