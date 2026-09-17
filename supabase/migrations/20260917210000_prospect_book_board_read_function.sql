-- The board is read through a function, not by opening its plumbing.
--
-- Supersedes the grant in 20260917200000, which was necessary and not sufficient. Views here run
-- SECURITY INVOKER (migration 20260911180000, deliberately — a definer view bypasses RLS on
-- everything beneath it). pb_prospect_board sits on a chain of SEVENTEEN objects: pb_chase_board,
-- pb_chase_weights(_active), pb_company_engagement, pb_contact_events, pb_engagement,
-- pb_mdm_aliases / _companies / _junk / _resolution, pb_orbit_clients, and the facts and reads
-- beneath those. Granting the view to `anon` therefore reads as "the board is public" while
-- actually requiring eleven more grants to work at all — and each of those would publish
-- something nobody ruled public: the chase WEIGHTS, the identity registry's aliases, the Orbit
-- delivery snapshot, raw contact events.
--
-- So: one SECURITY DEFINER function returning exactly the board's own columns, granted to anon.
-- Same pattern as pb_reconcile_state (§34), same reasoning. The page can read the board; nothing
-- underneath it becomes readable. If the board should ever show a column it does not return, that
-- is an edit here and a person's decision — which is the point.
--
-- It returns no composite score. pb_chase_board carries one (pb_chase_scores, unruled — §37) and
-- this function does not select it.
--
-- `duplicate_records` is text in the view (a joined list of the duplicate names), not a boolean;
-- returned as text so the page shows what it actually is rather than a yes/no it is not.
create or replace function public.pb_board()
returns table (
  rank                     bigint,
  name                     text,
  effective_tier           text,
  cell                     text,
  ceiling                  text,
  headroom_band            text,
  year1_band               text,
  facts_present            integer,
  qualification_label      text,
  confidence               text,
  status                   text,
  engagement               text,
  signal_urgency           text,
  they_last_replied        date,
  untouched_high_potential boolean,
  records                  bigint,
  duplicate_records        text,
  flags                    text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select b.rank, b.name, b.effective_tier, b.cell, b.ceiling, b.headroom_band, b.year1_band,
         b.facts_present, b.qualification_label, b.confidence, b.status,
         b.engagement, b.signal_urgency, b.they_last_replied,
         b.untouched_high_potential, b.records, b.duplicate_records, b.flags
    from public.pb_prospect_board b
   order by b.rank;
$$;

revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §37): prospects ranked by potential, one row per company, in '
  'the engine''s own chase_rank_key order. SECURITY DEFINER so the page can read the board '
  'without any of the seventeen objects beneath it becoming readable — the chase weights, the '
  'identity registry and the Orbit snapshot stay closed. Returns no composite score (PRO-0).';

-- And undo the grant that could not have worked, so nothing suggests the view itself is open.
revoke select on public.pb_prospect_board from anon, authenticated;
