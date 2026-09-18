-- The two views from 20260918100000 arrived holding DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE
-- and UPDATE for both anon and authenticated — Supabase's default privileges on `public`, which
-- CLAUDE.md warns about in as many words and which I revoked on the new TABLE and forgot on the
-- new VIEWS. Written up rather than folded into the previous file: that one has already run, and a
-- migration file that does not match what the database executed is the drift DECISIONS §26 and §33
-- are both about.
--
-- Neither role needs to touch these directly. The pages read pb_board(), pb_removed() and
-- pb_removal() — all SECURITY DEFINER — so the views stay service-role only, the same posture as
-- pb_apollo_enrichment and pb_website_reads. A view is not auto-updatable through a DISTINCT ON or
-- a join, so the write grants were mostly inert; TRUNCATE is the one that is not, because no row
-- policy can refuse it.
revoke all on public.pb_removals         from anon, authenticated;
revoke all on public.pb_removal_due_review from anon, authenticated;
