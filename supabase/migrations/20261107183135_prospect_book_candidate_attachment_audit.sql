-- Audit only: no trigger, RPC, canonical identity merge, score or reviewer decision.
create table prospect_intake.candidate_attachment_runs (
 run_sha256 text primary key check(run_sha256 ~ '^[0-9a-f]{64}$'),
 policy_version text not null,
 expected_candidate_count integer not null check(expected_candidate_count>0),
 actor text not null,
 input_manifest jsonb not null check(jsonb_typeof(input_manifest)='object'),
 state text not null default 'applied' check(state in('applied','reversed')),
 created_at timestamptz not null default now(),
 reversed_at timestamptz
);
create table prospect_intake.candidate_attachment_audit (
 run_sha256 text not null references prospect_intake.candidate_attachment_runs(run_sha256),
 candidate_id uuid not null,
 existing_account_id uuid not null,
 proof jsonb not null check(jsonb_typeof(proof)='object'),
 before_row jsonb not null check(jsonb_typeof(before_row)='object'),
 after_row jsonb not null check(jsonb_typeof(after_row)='object'),
 created_at timestamptz not null default now(),
 primary key(run_sha256,candidate_id),
 check(before_row->'account_id'='null'::jsonb),
 check(before_row->>'status'='proposed' and after_row->>'status'='proposed'),
 check(before_row->>'id'=candidate_id::text and after_row->>'id'=candidate_id::text),
 check(after_row->>'account_id'=existing_account_id::text),
 check(before_row-'account_id'=after_row-'account_id')
);
alter table prospect_intake.candidate_attachment_runs enable row level security;
alter table prospect_intake.candidate_attachment_audit enable row level security;
revoke all privileges on prospect_intake.candidate_attachment_runs,prospect_intake.candidate_attachment_audit
from public,anon,authenticated,service_role;
comment on table prospect_intake.candidate_attachment_audit is
'Administrative metadata repairs only: NULL candidate parent -> an already-certified existing native source reference. Status and every other candidate field remain unchanged. Full before/after images are retained for guarded rollback. No canonical account or identity decision is created.';
