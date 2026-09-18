-- SUPERSEDED — NOT WHAT RAN. This file was written by the 16 September session on branch
-- claude/new-session-glwxzh and never applied under this name; the database ran
--   20260916134753_prospect_book_gmail_sweep_staging.sql
-- instead. Kept because it is what that session wrote and the reasoning in it is real, but
-- the filed version above is the one that is live. DECISIONS §45.

-- The email sweep (DECISIONS §24 — engagement is recorded contact, and email is the
-- channel we had never read). The owner asked for it twice: sweep every prospect domain.
--
-- WHY A STAGING TABLE. The sweep runs outside the database: a Gmail query per batch of
-- domains, newest-first. What comes back is per-domain — a last inbound date and a last
-- outbound date. Which ACCOUNT that domain belongs to is a join, and joins run in the
-- database. The one time this book matched names to domains by hand it produced a
-- contaminated file and a wrong headline number (see 20260916180000). So the sweep loads
-- the domain and the two dates, and nothing else; pb_accounts decides the account.
--
-- WHAT A ROW ASSERTS. That an email to or from that domain exists on that date. Not who
-- it was, not what it said, not that it was about buying anything. It is evidence of
-- contact, which is what pb_engagement reads, and it is never a fact about the company.
create table if not exists public.pb_gmail_sweep (
  domain          text primary key,
  last_inbound    timestamptz,   -- newest message FROM that domain
  last_outbound   timestamptz,   -- newest message TO that domain
  threads_seen    integer not null default 0,
  truncated       boolean not null default false,  -- page 1 only; older activity may exist
  observed_at     timestamptz not null default now()
);

comment on table public.pb_gmail_sweep is
  'Per-domain email recency from the Gmail sweep. Page-1 (newest-first) results, so a '
  'null date means nothing recent was found, never that nothing exists. Staging only: '
  'pb_contact_events is derived from it by joining on pb_accounts.domain.';

revoke all on public.pb_gmail_sweep from anon, authenticated;
alter table public.pb_gmail_sweep enable row level security;
