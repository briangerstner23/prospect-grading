-- SUPERSEDED the same day by 20260917210000. The grant below is necessary and NOT sufficient:
-- views here run security-invoker, so `anon` would also need select on the seventeen objects
-- beneath pb_prospect_board — the chase weights, the identity registry, the Orbit snapshot.
-- That is a far larger exposure than the board, and the owner's call rather than a default.
-- The board is read through pb_board() instead, and 210000 revokes this grant. DECISIONS §47.

-- The Prospect Board becomes the working surface, so the page has to be able to read it.
--
-- Owner ruling, 17 Sep 2026 (DECISIONS §43): the 16 September board is THE page, codified and
-- made live rather than re-invented. A live page reads the database on every load, which means
-- pb_prospect_board needs the same grant the rest of the page's reads already hold.
--
-- WHY THIS IS CONSISTENT, not a new exposure. Reads are public by owner decision (§5): `anon`
-- already holds select on pb_accounts and pb_current_reads, which carry every column this view
-- carries — the agency's name, its anticipated tier, its cell and bands, its status and flags.
-- The view adds no column of its own; it groups the same reads by company and orders them by
-- the engine's chase_rank_key. What stays closed stays closed: pb_contacts (people),
-- pb_briefs / pb_account_reads / pb_chase_scores (candid judgements about named companies),
-- pb_members, pb_promotions, pb_potential_snapshots, pb_webhook_inbox. The dossier's people and
-- briefs therefore remain behind sign-in, which is the line CLAUDE.md draws.
--
-- pb_chase_board is NOT granted: it carries pb_chase_scores' composite score, which is unruled
-- (§43) and must not be displayed anywhere until it is.
--
-- Views run security-invoker here (migration 20260911180000), so the underlying tables' RLS
-- still applies to whoever reads it; this grant does not bypass a policy, it permits the select.
grant select on public.pb_prospect_board to anon, authenticated;

comment on view public.pb_prospect_board is
  'Prospects ranked by POTENTIAL, not by contact. One row per company with no active delivery '
  'work, ordered by the engine''s own chase_rank_key — tier, then how real the deal is, then '
  'urgency, then year-one band — which the rubric defines and grade() computes, so the order is '
  'never restated in SQL (rule 4). Engagement is carried in its own columns and never sets the '
  'rank: potential is what they could be worth, engagement is whether they are live right now, '
  'and neither touches the other (DECISIONS §20). No composite score: the output is a rank, a '
  'Tier × Ceiling cell and bands (PRO-0). THE WORKING SURFACE reads this view (§43), so it is '
  'readable by anon like the rest of the page''s reads (§5); pb_chase_board is not, because it '
  'carries an unruled composite score. pb_chase_board remains the contact-ordered board — who to '
  'call today — and answers a different question.';
