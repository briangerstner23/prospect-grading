-- The composite score is retired (owner decision D4, 18 Sep 2026, DECISIONS §50).
--
-- pb_chase_scores held 146 rows of a summed −18…123, built on 16 Sep in the research log with
-- no file, no test and no decision entry (STATE-SNAPSHOT-2026-09-17 §3; RESEARCH-CONFORMANCE
-- DNB-composite-table-exists). The book's first line is four reads, never summed (PRO-0), and
-- the research's "do not build" list names a composite score. Nothing read it: not the page
-- (board_page_test bars it), not the dossier, not the dashboard, and pg_depend lists no
-- dependent object. The owner ruled it retired rather than deferred.
--
-- The chase WEIGHTS (pb_chase_weights) and the contact board (pb_chase_board) stay: the board
-- reads pb_chase_board for the engagement columns and the company grouping, never its score.
-- From rubric 0.1.7 the within-cell order is the engine's own engagement-recency term, so the
-- page carries ONE rank and no score anywhere.

drop table if exists public.pb_chase_scores;
