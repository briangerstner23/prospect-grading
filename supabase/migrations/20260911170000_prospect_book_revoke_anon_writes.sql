-- WLIQ Prospect Book — take back the writes anon was never meant to hold.
--
-- Three tables created on 11 Sep — pb_apollo_enrichment, pb_fact_candidates and
-- pb_source_watermarks — carry `anon` grants of DELETE, INSERT, REFERENCES, TRIGGER,
-- TRUNCATE and UPDATE alongside SELECT. Nothing in this repository granted them: they are
-- Supabase's stock default privileges on a newly created table in `public`, inherited by
-- every table made after that default was set. The tables written before 11 Sep were locked
-- down explicitly by 20260910183927_prospect_book_public_read, which grants only `select`,
-- and only on the tables the page reads.
--
-- NOT AN OPEN DOOR, AND STILL WRONG. All three have RLS enabled with no policy naming
-- `anon`, so default-deny refuses every one of those verbs over PostgREST today, and
-- PostgREST does not expose TRUNCATE at all. The defect is that the grant sits one policy
-- away from being live: the day somebody adds `for select to anon` to let the page show the
-- review queue, the INSERT, UPDATE and DELETE arrive with it, silently, on a table whose
-- whole purpose is to hold claims a machine is not allowed to write. CLAUDE.md's rule is
-- unconditional for that reason — never grant `anon` an insert, update or delete.
--
-- Idempotent: revoking a privilege that is not held is a no-op.
--
-- THE CAUSE IS NOT FIXED HERE, DELIBERATELY. It lives in the schema's default privileges,
-- and this Supabase project is shared with other WLIQ systems — altering defaults would
-- reach beyond the Prospect Book. Every new `pb_` table must therefore carry its own revoke.

revoke insert, update, delete, truncate, references, trigger
  on public.pb_apollo_enrichment from anon;

revoke insert, update, delete, truncate, references, trigger
  on public.pb_fact_candidates from anon;

-- Not on the page at all. Anon has no business reading the sweep's position either: a
-- watermark says when we last looked at somebody, which is not the public's to know.
revoke select, insert, update, delete, truncate, references, trigger
  on public.pb_source_watermarks from anon;

-- Staging for an enrichment vendor's raw payloads; the page reads facts, never this.
revoke select on public.pb_apollo_enrichment from anon;
