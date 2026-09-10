-- WLIQ Prospect Book — the book becomes publicly readable.
--
-- WHAT THIS DOES, PLAINLY: after this migration the roster and every account sheet are
-- readable by anyone on the internet who opens the Pages URL. No sign-in, no WLIQ address,
-- no link-sharing required — the page is public and the repository that publishes it is
-- public, so the URL is discoverable. Agency names, their anticipated tiers and bands, the
-- facts and their notes, the signals, the deals, the call summaries and attendee lists, the
-- register and the merge queue are all served to the `anon` role.
--
-- WHY: Brian's instruction on 10 Sep 2026, made after the exposure above was put to him
-- explicitly. It reverses how PRO-7 ("anyone at WLIQ who signs in") was implemented in
-- 20260909120000. It is an owner's decision, recorded here and in docs/DECISIONS.md; it is
-- not a ruling, and the Grading Register should be updated to match.
--
-- WHAT STAYS CLOSED. Reads only, and not everything:
--   * every write path is untouched — anon may not insert a fact, a signal, a register row
--     or a review. Facts and hand signals stay in the rater lane, overrides in the owner
--     lane, and both still require a signed-in WLIQ address (PRO-5).
--   * pb_contacts — 817 named people at other companies with their email addresses. The page
--     never reads it, so it is not opened. This is the single largest block of personal data
--     in the book and it stays behind the sign-in.
--   * pb_members — WLIQ staff addresses and their lanes.
--   * pb_webhook_inbox — raw delivery bodies and headers. Service role only, always.
--   * pb_promotions, pb_potential_snapshots — not read by the page.
--
-- TO REVERSE: drop the policies named pb_*_read_anon and re-run the anon revoke at the end
-- of 20260909120000. Reversing restores the sign-in gate but does not un-publish anything
-- already read, copied or indexed while the book was open.

-- ── 1 · let anon reach the tables the page reads ────────────────────────────────────────
grant select on pb_accounts, pb_facts, pb_signals, pb_reads, pb_register, pb_rubric_versions,
                pb_runs, pb_calls, pb_deals, pb_identity_candidates to anon;
grant select on pb_current_reads, pb_current_facts to anon;

-- ── 2 · and let RLS admit it. Select only; `using (true)` because there is no viewer to
--        scope by, which is what "public" means. ────────────────────────────────────────
create policy pb_accounts_read_anon   on pb_accounts            for select to anon using (true);
create policy pb_facts_read_anon      on pb_facts               for select to anon using (true);
create policy pb_signals_read_anon    on pb_signals             for select to anon using (true);
create policy pb_reads_read_anon      on pb_reads               for select to anon using (true);
create policy pb_register_read_anon   on pb_register            for select to anon using (true);
create policy pb_rubric_read_anon     on pb_rubric_versions     for select to anon using (true);
create policy pb_runs_read_anon       on pb_runs                for select to anon using (true);
create policy pb_calls_read_anon      on pb_calls               for select to anon using (true);
create policy pb_deals_read_anon      on pb_deals               for select to anon using (true);
create policy pb_identity_read_anon   on pb_identity_candidates for select to anon using (true);

-- ── 3 · say the quiet part in the schema itself, for whoever reads this table list next ──
comment on table pb_accounts is 'PUBLIC READ (10 Sep 2026, owner decision). Readable by anon.';
comment on table pb_contacts is 'NOT public. Named people at other companies; stays behind the sign-in.';
