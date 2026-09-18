-- The default-privileges trap, applied to FUNCTIONS.
--
-- CLAUDE.md documents at length that a new pb_ table arrives with anon AND authenticated
-- holding everything, and that every new table needs its own revoke for both roles. Functions
-- have the same trap and never got the same treatment: Postgres grants EXECUTE to PUBLIC on
-- every new function, so `anon` inherited it. The ACLs read `=X/postgres` — a leading `=` with
-- no role name IS the PUBLIC grant.
--
-- The effect was that thirteen VOLATILE SECURITY DEFINER functions — which run with owner
-- rights — were callable unauthenticated over PostgREST at /rest/v1/rpc/<name>. Nine of them
-- write; pb_roster_fetch_page and the Fathom steppers also reach external APIs through pg_net,
-- so it was a cost and quota vector as well as an integrity one. That contradicts the standing
-- rule "Never grant anon an insert, update or delete": a definer function that writes,
-- executable by anon, is that grant laundered through a function.
--
-- These are machine functions. pg_cron calls them as postgres and the edge functions call them
-- as service_role; both hold explicit grants that a revoke from PUBLIC does not touch. Neither
-- page calls any of them — web/board.html and web/index.html between them use only pb_board,
-- pb_dossier, pb_dashboard, pb_confirm_fact_candidates, pb_reject_fact_candidates,
-- pb_review_candidate, pb_review_fact_candidate and pb_merge_accounts.
--
-- Deliberately NOT touched: pb_board, pb_dossier, pb_dashboard, pb_lift and pb_reconcile_state.
-- All are STABLE and read-only, all carry EXPLICIT anon grants, and all follow from the owner's
-- 10 Sep decision that reads are public (DECISIONS §5, §43). pb_reconcile_state in particular is
-- called from CI with no secrets and must stay reachable.

revoke execute on function
  public.pb_attribute_orphan_calls(boolean),
  public.pb_contact_events_from_calls(),
  public.pb_contact_events_from_gmail(),
  public.pb_contact_events_from_quotes(),
  public.pb_fathom_backfill_tick(integer),
  public.pb_fathom_crawl_guard(date),
  public.pb_fathom_crawl_step(integer),
  public.pb_roster_crawl_reset(),
  public.pb_roster_crawl_step(integer),
  public.pb_roster_drift_refresh(),
  public.pb_roster_fetch_page(text, integer),
  public.pb_score_snapshots(),
  public.pb_snapshot_lift()
from public, anon, authenticated;
