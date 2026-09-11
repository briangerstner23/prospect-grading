-- WLIQ Prospect Book — Apollo enrichment staging.
--
-- Applied 11 Sep 2026. One row per domain we sent to Apollo's bulk enrich, matched or not.
-- This is a RAW PULL, not the book: nothing here is a fact until resolve_features reads it
-- and something writes pb_facts. Keeping the pull separate is what lets us re-measure Apollo
-- against first-party sources without re-spending credits, and lets us throw the whole table
-- away when a better source arrives.
--
-- Apollo describes what a company IS, not what it BUYS — measured against call notes it was
-- absent or wrong on 5 of 6 accounts. Treat every column here as a hint, never as evidence.
--
-- Service role only: RLS is on and there are no policies, so anon and authenticated see
-- nothing. Deliberate — it holds unreviewed third-party assertions about named agencies.

create table if not exists public.pb_apollo_enrichment (
  domain          text primary key,
  matched         boolean not null,
  apollo_org_id   text,
  org_name        text,
  employees       integer,
  industry        text,
  eng_headcount   integer,
  dept_headcount  integer,
  revenue         numeric,
  founded_year    integer,
  build_keywords  text[],
  fetched_at      timestamptz not null default now(),
  batch           integer
);

create index if not exists pb_apollo_enrichment_batch_idx
  on public.pb_apollo_enrichment (batch);

alter table public.pb_apollo_enrichment enable row level security;
