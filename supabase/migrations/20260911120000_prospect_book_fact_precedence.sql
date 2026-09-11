-- WLIQ Prospect Book — evidence outranks recency.
--
-- pb_current_facts picked the newest row per (account, key) and nothing else. That was fine
-- while every fact came from a machine sweep. It stopped being fine the moment notes started
-- writing quote-backed facts: a Pipedrive note from 2025 saying "they work with one or two
-- freelancers for web projects" is better evidence than an Apollo guess made this morning,
-- and under created_at DESC the next Apollo sweep would have silently overwritten it.
--
-- Measured on eight accounts with first-party call notes, Apollo disagreed with the note on
-- five of eleven overlapping facts and was wrong on all five. Recency is not quality.
--
-- New order: evidence > inferred > unknown, then newest written, then newest observed.
-- Within one label nothing changes, so no existing resolution moves.
--
-- ingest/resolve_features.ts::latestFactPerKey carries the same order. The two must agree —
-- the view is what pb-score reads, the function is what the pure path reads.

create or replace view public.pb_current_facts as
  select distinct on (account_id, key)
    id, account_id, key, value, evidence_label, source, evidence_url,
    observed_at, entered_by, stand_in, note, created_at
  from public.pb_facts f
  order by
    account_id,
    key,
    case evidence_label when 'evidence' then 0 when 'inferred' then 1 else 2 end,
    created_at desc,
    observed_at desc nulls last;
