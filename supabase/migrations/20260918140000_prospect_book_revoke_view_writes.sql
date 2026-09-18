-- Seven views from the 16 Sep set arrived with anon and authenticated holding EVERY privilege
-- (CLAUDE.md: Supabase's default privileges on public grant insert/update/delete/truncate on any
-- object created after they were set, so every new pb_ object needs its own revoke, for both
-- roles). Found 18 Sep by the grants check the book relies on, while verifying the 18 Sep
-- migrations. All seven are security_invoker views, so no grant ever reached a row: the base
-- tables are default-deny with writes revoked, and pb_current_research's sources
-- (pb_account_reads, pb_briefs) hold no anon grant at all. But a check that reports known
-- noise stops being read, and the check is meant to return nothing.
--
-- pb_current_research is narrowed to match its sources: authenticated select, anon nothing —
-- the research tables carry candid judgements about named companies and opening them to anon
-- is the owner's call, not a default (CLAUDE.md). The other six keep the public read that
-- every other pb_ read has (DECISIONS §5) and lose everything else.

revoke all on public.pb_current_research from anon, authenticated;
grant select on public.pb_current_research to authenticated;

revoke all on public.pb_engagement, public.pb_engagement_shape, public.pb_mdm_junk_hits,
              public.pb_mdm_resolution, public.pb_orbit_admission_queue, public.pb_orbit_overlap
  from anon, authenticated;
grant select on public.pb_engagement, public.pb_engagement_shape, public.pb_mdm_junk_hits,
                public.pb_mdm_resolution, public.pb_orbit_admission_queue, public.pb_orbit_overlap
  to anon, authenticated;
