-- WLIQ Prospect Book — pb_current_reads must carry the confidence grade.
--
-- Migration 20260913230000 added confidence_grade, computed_confidence_grade and
-- confidence_overridden to pb_reads, and stopped there. pb_current_reads selects an EXPLICIT
-- column list, so the three new columns were invisible to everything that reads the view — which
-- is the page's whole listing, and pb-score's own preview comparison.
--
-- The consequence was not cosmetic. Rubric 0.1.1's only difference from 0.1.0 IS the confidence
-- grade, so previewing it (rule 4: preview before activation) compared tier and status, found
-- them identical, and would have reported "0 changed" for all 659 accounts — telling the owner
-- that activating it does nothing, when in fact it grades every account in the book.
--
-- The three columns are APPENDED, not slotted in beside `confidence` where they read better.
-- `create or replace view` may only add columns at the end: inserting one renames every column
-- after it, which Postgres refuses outright. The alternative is drop-and-recreate, which silently
-- drops the view's grants — and `anon` holds select here (public reads, DECISIONS §5), so a
-- rebuild that forgets to re-grant takes the whole page down for signed-out readers. Column order
-- in a view is cosmetic; losing the grant is not.
--
-- security_invoker stays on: migration 20260911180000 restored it after a regression, and a view
-- that runs as its definer would hand the caller the definer's reach.

create or replace view public.pb_current_reads
with (security_invoker = on) as
  select distinct on (account_id)
    id,
    account_id,
    run_id,
    rubric_version,
    rubric_fingerprint,
    run_at,
    as_of,
    status,
    effective_tier,
    computed_tier,
    confidence,
    qualification_label,
    facts_present,
    ceiling,
    headroom_band,
    year1_band,
    urgency,
    cell,
    reason,
    flags,
    scorecard,
    scorecard_sha256,
    confidence_grade,
    computed_confidence_grade,
    confidence_overridden
  from pb_reads r
  order by account_id, run_at desc;

comment on view public.pb_current_reads is
  'The latest read per account, including the confidence grade. Reads are public (DECISIONS §5); security_invoker so the view never lends the definer''s reach.';
