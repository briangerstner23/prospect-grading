-- WLIQ source-only intake. No canonical identities, facts, grades or permissions are changed.
-- Creates a private operator-only schema; all API roles are explicitly refused.
create schema prospect_intake;
comment on schema prospect_intake is 'Source-only evidence staging. Not a company master; no automatic admission into Prospect Book or MDM.';
revoke all on schema prospect_intake from public, anon, authenticated, service_role;

create table prospect_intake.source_files (
 source_sha256 text primary key check (source_sha256 ~ '^[0-9a-f]{64}$'),
 source_label text not null,
 source_kind text not null,
 source_record_count integer not null check (source_record_count >= 0),
 source_bytes bigint not null check (source_bytes > 0),
 exported_on date,
 created_at timestamptz not null default now()
);
create table prospect_intake.batches (
 batch_sha256 text primary key check (batch_sha256 ~ '^[0-9a-f]{64}$'),
 manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
 policy_version text not null,
 expected_record_count integer not null check (expected_record_count > 0),
 purpose text not null,
 created_at timestamptz not null default now()
);
create table prospect_intake.source_records (
 source_sha256 text not null references prospect_intake.source_files(source_sha256),
 record_number integer not null check (record_number >= 2),
 source_row_sha256 text not null check (source_row_sha256 ~ '^[0-9a-f]{64}$'),
 business_claims jsonb not null check (jsonb_typeof(business_claims)='object'),
 disposition text not null default 'source_only' check (disposition='source_only'),
 created_at timestamptz not null default now(),
 primary key (source_sha256,record_number),
 unique (source_sha256,record_number,source_row_sha256),
 check (business_claims - array['person_name','person_title','company_name','company_website','linkedin_profile_url','sales_navigator_url']::text[] = '{}'::jsonb)
);
create table prospect_intake.batch_records (
 batch_sha256 text not null references prospect_intake.batches(batch_sha256),
 source_sha256 text not null,
 record_number integer not null,
 source_row_sha256 text not null,
 review_flags jsonb not null check (jsonb_typeof(review_flags)='array'),
 proposed_links jsonb not null check (jsonb_typeof(proposed_links)='array'),
 created_at timestamptz not null default now(),
 primary key (batch_sha256,source_sha256,record_number),
 foreign key (source_sha256,record_number,source_row_sha256) references prospect_intake.source_records(source_sha256,record_number,source_row_sha256)
);
alter table prospect_intake.source_files enable row level security;
alter table prospect_intake.batches enable row level security;
alter table prospect_intake.source_records enable row level security;
alter table prospect_intake.batch_records enable row level security;
revoke all privileges on all tables in schema prospect_intake from public, anon, authenticated, service_role;
comment on table prospect_intake.source_records is 'Immutable by importer: insert or verify exact equality, never upsert-update. Business claims are unverified; no contact permissions or facts are asserted.';
comment on table prospect_intake.batch_records is 'Proposed links only. No foreign key or trigger connects this schema to canonical Book or MDM records.';
