-- Prospect Book — one potential snapshot per account, per day, per estimator.
--
-- pb-score writes a pb_potential_snapshots row for every ranked account on every non-preview
-- run (DECISIONS §30, REPAIR-PLAN item 6). The nightly job runs once, but a hand-triggered
-- re-run the same day must not double the day's evidence: the write is an upsert on this key,
-- so the last run of a day is the day's snapshot. No grant changes: service_role writes,
-- authenticated reads through the existing pb_snapshots_read policy, anon holds nothing.

create unique index if not exists pb_potential_snapshots_account_day_estimator
  on public.pb_potential_snapshots (account_id, taken_at, estimator);

comment on table public.pb_potential_snapshots is
  'One row per ranked account per day per estimator, written by pb-score (DECISIONS §30). '
  'p10/p90 at 12 months are the active rubric''s year-one band edges; p50, the 24-month '
  'interval and the two probabilities stay null until an estimator that produces them exists '
  '(PRO-16: no point estimate). Frozen at promotion by selection, never by a second write: '
  'the newest row with taken_at <= pb_promotions.first_invoice_at. Actuals come from the '
  'billing systems of record (Orbit, QuickBooks), never from the Client Book''s tables (PRO-17).';
