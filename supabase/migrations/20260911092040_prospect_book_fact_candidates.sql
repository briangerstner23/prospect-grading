-- WLIQ Prospect Book — fact candidates and source watermarks.
--
-- Applied 11 Sep 2026.
--
-- Rule 8 says identity never auto-merges below high confidence; medium and low become
-- pb_identity_candidates for a person to review. Extracting facts out of free text is the
-- same problem with the same answer, so it gets the same shape.
--
-- A claim read out of a Pipedrive note, a Notion profile or a Fathom summary lands here when
-- ingest/pipedrive_notes.ts will not write it: no verbatim quote behind it, confidence below
-- high, or a person already recorded something different. A person confirms or rejects; only
-- then does anything reach pb_facts. The proposal itself is immutable — the guard below lets
-- a reviewer change status, reviewed_by, reviewed_at and note, and nothing else, so the queue
-- stays an honest record of what the extractor actually claimed.
--
-- fingerprint is unique and covers (source id · source updated_at · extractor version · key),
-- which is what makes the sweep re-runnable: the same text read by the same extractor never
-- queues twice, and editing the note or shipping a new extractor re-opens it.

create table if not exists public.pb_fact_candidates (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.pb_accounts(id) on delete cascade,
  key             text not null,
  value           jsonb,
  evidence_label  text not null default 'inferred'
                    check (evidence_label in ('evidence', 'inferred', 'unknown')),
  source          text not null,
  source_id       text,
  evidence_url    text,
  -- The verbatim sentence. A reviewer should never have to leave this row to judge the claim.
  quote           text,
  -- The SOURCE's date, never the extraction date, so decay sees the claim for its real age.
  observed_at     date,
  confidence      text check (confidence in ('high', 'medium', 'low')),
  extractor       text not null,
  fingerprint     text not null,
  -- What the book holds today, when it holds something different. Disagreement is surfaced
  -- on the row, not settled behind the reviewer's back.
  current_value   jsonb,
  conflicts       boolean not null default false,
  status          text not null default 'proposed'
                    check (status in ('proposed', 'confirmed', 'rejected', 'superseded')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  note            text,
  created_at      timestamptz not null default now()
);

create unique index if not exists pb_fact_candidates_fingerprint_idx
  on public.pb_fact_candidates (fingerprint);
create index if not exists pb_fact_candidates_account_idx
  on public.pb_fact_candidates (account_id, key);
create index if not exists pb_fact_candidates_status_idx
  on public.pb_fact_candidates (status);
create index if not exists pb_fact_candidates_conflict_idx
  on public.pb_fact_candidates (conflicts) where conflicts;

-- Where each source sweep left off, so a re-run reads the new notes and not all of them.
create table if not exists public.pb_source_watermarks (
  source        text primary key,
  last_seen_at  timestamptz,
  last_run_at   timestamptz not null default now(),
  note          text
);

alter table public.pb_fact_candidates enable row level security;
alter table public.pb_source_watermarks enable row level security;

-- Reads: signed-in WLIQ only. This queue holds unconfirmed assertions about named agencies,
-- so it is NOT part of the public-read set (DECISIONS.md §5), which covers graded reads.
drop policy if exists pb_fact_candidates_read on public.pb_fact_candidates;
create policy pb_fact_candidates_read on public.pb_fact_candidates
  for select to authenticated
  using (public.pb_is_wliq());

-- Review: owner and rater lanes, and a reviewer signs their own name.
drop policy if exists pb_fact_candidates_review on public.pb_fact_candidates;
create policy pb_fact_candidates_review on public.pb_fact_candidates
  for update to authenticated
  using (public.pb_is_wliq() and public.pb_role() in ('owner', 'rater'))
  with check (
    public.pb_is_wliq()
    and public.pb_role() in ('owner', 'rater')
    and reviewed_by = public.pb_me()
  );

-- Watermarks are operator state: service role only, no policies.

-- The proposal is immutable; only the review fields move.
create or replace function public.pb_fact_candidate_review_guard()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.account_id is distinct from old.account_id
     or new.key is distinct from old.key
     or new.value is distinct from old.value
     or new.source is distinct from old.source
     or new.source_id is distinct from old.source_id
     or new.quote is distinct from old.quote
     or new.fingerprint is distinct from old.fingerprint
     or new.extractor is distinct from old.extractor
     or new.observed_at is distinct from old.observed_at then
    raise exception 'pb_fact_candidates: only status, reviewed_by, reviewed_at and note may be changed';
  end if;
  return new;
end $function$;

drop trigger if exists pb_fact_candidate_review_guard_t on public.pb_fact_candidates;
create trigger pb_fact_candidate_review_guard_t
  before update on public.pb_fact_candidates
  for each row execute function public.pb_fact_candidate_review_guard();
