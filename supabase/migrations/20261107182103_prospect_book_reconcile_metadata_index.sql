-- Cover the latest-read metadata used by runtime reconciliation, preserving the existing order.
-- No score, rubric, history row, API grant or decision is changed.
create index pb_reads_account_run_metadata_idx
on public.pb_reads(account_id,run_at desc)
include (id,rubric_version,rubric_fingerprint);
