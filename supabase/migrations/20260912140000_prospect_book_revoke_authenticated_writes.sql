-- WLIQ Prospect Book — the same stock-default grants, on the role nobody checked.
--
-- 20260911170000 took back the writes `anon` was never meant to hold on three tables, and
-- CLAUDE.md turned that into a standing rule with a query to prove it. The query filters
-- `grantee = 'anon'`. Ask the same question of `authenticated` and every one of the twenty
-- `pb_` tables and views answers
--
--   DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- — not three tables, all of them, including `pb_reads`, whose whole rule is that nobody edits
-- a read by hand (CLAUDE.md rule 6), and `pb_runs`, which is the log that says what happened.
-- Nothing in this repository granted any of it. It is Supabase's default privileges on `public`
-- again, and `authenticated` is simply a role the earlier migration did not think to ask about.
--
-- NOT AN OPEN DOOR, AND STILL WRONG — the same verdict as last time, for mostly the same
-- reasons. Every table has RLS enabled, and only six carry a write policy at all, so PostgREST
-- refuses every one of these verbs today for a signed-in viewer. But:
--
--   * TRUNCATE IS NOT SUBJECT TO RLS. Postgres checks the privilege and nothing else; a row
--     policy cannot refuse it. The only thing standing between a signed-in user and an empty
--     `pb_reads` is that PostgREST does not expose TRUNCATE. That is a property of the client,
--     not of our permissions, and it is the one verb here that default-deny never refused.
--   * The rest is the familiar one-policy-away problem, now with a much bigger blast radius:
--     any future `for update to authenticated` on a table — the obvious way to let a rater fix
--     something on the page — arrives alongside DELETE and TRUNCATE on that table, silently.
--
-- WHAT THE LANES ACTUALLY NEED, and therefore what is granted back. Read out of pg_policy, not
-- assumed: six tables carry a write policy, and each names exactly one verb.
--
--   pb_facts               insert   pb_facts_insert              owner/rater, entered_by = pb_me()
--   pb_signals             insert   pb_signals_insert            owner/rater, source = 'manual'
--   pb_register            insert   pb_register_insert_owner / _signer
--   pb_promotions          insert   pb_promotions_owner          owner, confirmed_by = pb_me()
--   pb_fact_candidates     update   pb_fact_candidates_review    owner/rater
--   pb_identity_candidates update   pb_identity_review           owner/rater
--
-- Nothing else writes as the caller. `pb_merge_accounts`, `pb_review_candidate` and
-- `pb_review_fact_candidate` are SECURITY DEFINER, so they run with the definer's rights and
-- need no privilege from the person calling them; every other write is the service role's.
-- Policies are untouched here — a lane's behaviour is unchanged as long as the grant its policy
-- needs survives, and each one does.
--
-- SELECT is left alone wherever the page reads, and taken back on the three tables it never
-- reads: staging for a vendor's raw payloads, the sweep's position, and the raw webhook inbox.
-- RLS already denies all three (they have no policies at all); this just stops saying otherwise.
--
-- THE CAUSE IS STILL NOT FIXED, DELIBERATELY — the defaults belong to a project shared with
-- other WLIQ systems. Every new `pb_` table needs its own revoke, now for both roles.
-- Idempotent: revoking a privilege that is not held is a no-op.

do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v') and c.relname like 'pb\_%'
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated',
      r.relname);
  end loop;
end $$;

-- The six verbs the six write policies rest on, and nothing besides.
grant insert on public.pb_facts               to authenticated;
grant insert on public.pb_signals             to authenticated;
grant insert on public.pb_register            to authenticated;
grant insert on public.pb_promotions          to authenticated;
grant update on public.pb_fact_candidates     to authenticated;
grant update on public.pb_identity_candidates to authenticated;

-- Service-role-only tables: the page reads none of them, and RLS denies them already.
revoke select on public.pb_apollo_enrichment  from authenticated;
revoke select on public.pb_source_watermarks  from authenticated;
revoke select on public.pb_webhook_inbox      from authenticated;
