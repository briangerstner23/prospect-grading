-- WLIQ Prospect Book — the research log.
--
-- On 16 Sep 2026 the owner asked whether the chase-list work was accumulating or only iterating.
-- It was only iterating: 380 agencies had been read from their own sites, 146 of them structured
-- field-by-field with a verbatim quote and checked by a second agent, 80 written up as sales
-- briefs — and every one of those artefacts lived in a session scratch directory that dies with
-- the container. `select count(*) from pb_facts where source = 'website'` returned 0.
--
-- His instruction: *"I need all of our research to be logged in an accurate and responsible way,
-- we do not want to lose what we know or [stop] growing in confidence."*
--
-- Three tables, and the split between them is the whole design:
--
--   pb_account_reads   every structured read of an account, WHOLE and unfiltered, with the quote
--                      behind each value and the skeptic's verdict beside it. Nothing is dropped
--                      for being inconvenient; a value the checker refused is kept with the reason
--                      it was refused. This is the record.
--   pb_briefs          the written assessment a salesperson acts on, versioned by generation, so
--                      December's can be diffed against September's instead of re-derived.
--   pb_chase_scores    the ranking, with the weights version that produced it, so a rank is
--                      reproducible and two runs are comparable.
--
-- NONE of these is a fact and none feeds the engine. `pb_reads` is still written only by pb-score
-- and `pb_facts` only through the candidate queue (rules 6 and 8). A read here PROPOSES; migration
-- 20260916090100 derives candidates from it and a person still decides. Keeping the full read
-- separate from the review queue is what lets us log everything without burying the reviewer: the
-- record is complete, the queue is only what would change an answer.

create table if not exists public.pb_account_reads (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.pb_accounts(id) on delete cascade,
  read_at      timestamptz not null default now(),
  reader       text not null,
  method       text not null,
  -- What was in front of the reader: page paths, call dates, which facts were already on file.
  inputs       jsonb not null default '{}'::jsonb,
  -- One object per feature: {value, quote, dropped?, method?, roles?}. `dropped` is the skeptic's
  -- reason for refusing it, and the value beside it has been nulled — both are kept.
  fields       jsonb not null,
  site_found   boolean,
  summary      text,
  confidence   text check (confidence in ('high', 'medium', 'low')),
  -- The adversarial pass. verified=false means nobody checked it, which is not the same as passing.
  verified     boolean not null default false,
  verifier     text,
  stripped     text[] not null default '{}',
  verdict      jsonb,
  superseded_at timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.pb_account_reads is
  'Every structured read of an account: each field with its verbatim quote and the checker''s verdict, kept whole. Proposes; never a fact (rule 8).';

create index if not exists pb_account_reads_account_idx on public.pb_account_reads (account_id, read_at desc);
create index if not exists pb_account_reads_live_idx on public.pb_account_reads (account_id) where superseded_at is null;

create table if not exists public.pb_briefs (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.pb_accounts(id) on delete cascade,
  generated_at  timestamptz not null default now(),
  author        text not null,
  read_id       uuid references public.pb_account_reads(id) on delete set null,
  brief         jsonb not null,
  -- Denormalised so the common questions are one index scan, not a jsonb scan.
  location      text,
  headcount     int,
  headcount_confidence text check (headcount_confidence in ('high', 'medium', 'low')),
  confidence    text check (confidence in ('high', 'medium', 'low')),
  next_step     text,
  superseded_at timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.pb_briefs is
  'The written sales assessment per account, versioned by generation so two dates can be diffed. An opinion with its sources, not a fact.';

create index if not exists pb_briefs_account_idx on public.pb_briefs (account_id, generated_at desc);
create index if not exists pb_briefs_live_idx on public.pb_briefs (account_id) where superseded_at is null;

create table if not exists public.pb_chase_scores (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.pb_accounts(id) on delete cascade,
  scored_at       timestamptz not null default now(),
  weights_version text not null,
  score           int,
  rank            int,
  -- Every term that produced the score, so the arithmetic is readable years later.
  breakdown       jsonb not null default '[]'::jsonb,
  excluded_reason text,
  critic_notes    jsonb,
  read_id         uuid references public.pb_account_reads(id) on delete set null,
  created_at      timestamptz not null default now()
);

comment on table public.pb_chase_scores is
  'A chase ranking run: score, rank and the full breakdown under a named weights version. Not the engine''s tier and not a ruling.';

create index if not exists pb_chase_scores_run_idx on public.pb_chase_scores (scored_at desc, rank);
create index if not exists pb_chase_scores_account_idx on public.pb_chase_scores (account_id, scored_at desc);

-- A new pb_ table arrives with anon AND authenticated holding everything (CLAUDE.md), so both are
-- revoked explicitly before anything is granted back. These carry candid judgements about named
-- companies — who is price-sensitive, whose owner is retiring — so unlike pb_facts they are NOT
-- opened to anon. Signed-in readers only; the owner can widen it, deliberately, later.
revoke all on public.pb_account_reads, public.pb_briefs, public.pb_chase_scores from anon, authenticated;
grant select on public.pb_account_reads, public.pb_briefs, public.pb_chase_scores to authenticated;

alter table public.pb_account_reads enable row level security;
alter table public.pb_briefs        enable row level security;
alter table public.pb_chase_scores  enable row level security;

create policy pb_account_reads_read on public.pb_account_reads for select to authenticated using (true);
create policy pb_briefs_read        on public.pb_briefs        for select to authenticated using (true);
create policy pb_chase_scores_read  on public.pb_chase_scores  for select to authenticated using (true);

-- The live view of what we currently believe about an account, one row each.
create or replace view public.pb_current_research
with (security_invoker = true) as
  select distinct on (r.account_id)
         r.account_id, r.id as read_id, r.read_at, r.reader, r.confidence, r.verified,
         r.stripped, r.site_found, r.summary, r.fields,
         b.id as brief_id, b.brief, b.location, b.headcount, b.headcount_confidence,
         b.confidence as brief_confidence, b.next_step
    from public.pb_account_reads r
    left join public.pb_briefs b
           on b.account_id = r.account_id and b.superseded_at is null
   where r.superseded_at is null
   order by r.account_id, r.read_at desc, b.generated_at desc;

comment on view public.pb_current_research is
  'Latest live read per account with its brief. What we currently believe, and how sure we are.';

grant select on public.pb_current_research to authenticated;
