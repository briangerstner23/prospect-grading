-- Citations only. No behaviour changes here, and nothing but `comment on` runs.
--
-- The autoconfirm work was written as DECISIONS §50 and §52 on one branch while another branch was
-- independently writing its own §50, §51 and §52. Two collisions. The rulings are renumbered §53
-- and §54 in docs/DECISIONS.md.
--
-- The migration FILES keep the old numbers and must: 20260918100000-100300, 120000 and 120100 are
-- byte-identical to schema_migrations.statements, and editing one to fix a citation would break the
-- single check that proves the record matches what ran. So the files say §50/§52 and mean §53/§54.
--
-- The live comment strings are not part of that byte-identity, and they are what somebody reads
-- when they ask the database to describe itself. So they are corrected here, where correcting them
-- costs nothing and leaves the frozen record intact.

comment on view public.pb_fact_candidate_lanes is
  'Every proposed fact candidate, in exactly one lane, with the reason in plain words. Five '
  'refusals sit above every lane and none is switchable: no quote, a sentence audited as not '
  'bearing on the claim, disagreement with what the book holds, two records proposing different '
  'values for one key, and an explicit judgement. Corroboration is tested before confidence, and '
  'an audited support = states stands in for the reader being on the lane''s allow-list. Which '
  'lanes run, which readers they trust and how much corroboration counts are all '
  'pb_fact_autoconfirm_policy. Owner ruling 18 Sep 2026, DECISIONS §53 and §54 (written as §50 '
  'and §52; the migration files keep the old numbers because they are frozen against '
  'schema_migrations).';

comment on function public.pb_autoconfirm_facts(boolean, int, text[]) is
  'Approve the fact candidates whose lane the owner has switched on. Dry run by default. Re-derives '
  'each lane against pb_current_facts at write time, writes facts under entered_by auto:<lane> so '
  'nothing a machine read ever looks like a person''s entry, logs every row to pb_autoconfirm_log '
  'for pb_undo_autoconfirm, and writes one register row per account saying it was automatic. '
  'Owner lane, or pg_cron in-database. DECISIONS §53.';

comment on function public.pb_undo_autoconfirm(uuid, text) is
  'Take back one batch of automatic approvals: delete the facts it wrote, put the claims back in '
  'the queue, and say so in each account''s register. Refuses to reopen a row a person has decided '
  'since. Owner lane through the page, or an operator in-database — the same two callers as '
  'pb_autoconfirm_facts, because a batch made unattended has to be undoable the same way. '
  'DECISIONS §53, RUNBOOK §28.';

comment on column public.pb_fact_candidates.support is
  'Does the stored quote STATE this value for this key? states / implies / unsupported, decided by '
  'ingest/verify_support.ts — the model answers and a lexicon may overrule it DOWNWARD only. NULL '
  'means nobody has audited it, which is not a finding about the sentence. DECISIONS §54.';

comment on function public.pb_confirm_fact_candidates(uuid[], text) is
  'Confirm fact candidates in bulk — owner lane only, and only where a reviewer reading the '
  'sentence has nothing to weigh. Three classes, each named in the return and in the fact''s own '
  'note: high_and_unheld (rated high, quoted, the book holds nothing for that key, and not a '
  'sentence the extractor called an assessment); corroborates_what_is_held (the book already holds '
  'this exact value as inferred — same answer, now with a sentence behind it); '
  'second_independent_source (another candidate, from a DIFFERENT source, claims the same value '
  'with its own quote). A candidate matching a value the book already holds as evidence is CLOSED, '
  'not written. The two corroboration classes require kind = observation explicitly. A quote is the '
  'floor for all three. Disagreement with what is on file is always refused here, not in the page, '
  'and is re-derived against pb_current_facts at confirm time. DECISIONS §45 and §51 (the '
  'corroboration rules), plus §53a for the judgement refusal on high_and_unheld and for the restore '
  'after the autoconfirm migration overwrote this function.';

comment on function public.pb_dashboard() is
  'The front page, read live. Its queue block reads pb_fact_candidate_lanes rather than carrying a '
  'second copy of the lane rules — a second implementation of a rule is a second rule, and this '
  'one had already drifted past the autoconfirm lanes and the support audit. Returns counts only, '
  'never a claim, which is why it is SECURITY DEFINER over a table that stays closed to anon. '
  'confirmable_together is retained as an alias of `automatic` because two published pages read it '
  'by name. DECISIONS §53, §54.';
