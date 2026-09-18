-- The check in CLAUDE.md, run straight after the lanes went in, returned one row:
--
--   authenticated | pb_fact_candidate_lanes | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- The same default-privileges trap that cost twenty objects on 12 Sep, in the same shape: the
-- migration wrote `revoke all ... from anon` and stopped there, because anon is the role one
-- thinks about. Supabase's defaults on `public` grant everything to BOTH roles on anything created
-- after they were set, and a VIEW is created like anything else.
--
-- Nothing could have been written through it — it is security_invoker over pb_fact_candidates,
-- whose RLS refuses an insert from any lane — but a grant that is only harmless because something
-- else refuses it is not a grant anybody decided to make.

revoke all on public.pb_fact_candidate_lanes from authenticated;
grant select on public.pb_fact_candidate_lanes to authenticated;
