-- WLIQ Prospect Book — which source wins when two of them claim the same key.
--
-- `pb_current_facts` resolved a key by evidence_label, then `created_at desc`. Within one label
-- that made WRITE ORDER the tiebreak, which is not a judgement about quality — it is an accident
-- of which seed ran last.
--
-- Measured on 15 Sep 2026: 111 prospect accounts carry a headcount from BOTH Apollo and
-- Pipedrive. Twelve agree. The median Apollo/Pipedrive ratio is 2.0 and the upper quartile is
-- 9.25, and **38 of the 111 sit on opposite sides of the 12-person Partner threshold** depending
-- on which row you believe. Today Apollo wins 109 of them — not because it is better, but because
-- the Apollo seed ran on 11 Sep and the Pipedrive seed on 9 Sep. Re-running the Pipedrive seed
-- (which is how an account is admitted — RUNBOOK §23) writes fresh rows dated today and silently
-- flips all 109 back, moving 38 ceilings. That is the regression this migration forecloses.
--
-- The order below ranks a source by how close it is to someone who actually knows, and it is the
-- same order `latestFactPerKey` uses in ingest/resolve_features.ts. Rule 9: the view and the
-- function must not drift; ingest/resolve_features_test.ts pins the list against this file.
--
--   0 rater           a person in the owner or rater lane typed it
--   1 fathom_call     someone said it out loud on a recorded call
--   2 pipedrive_note  someone wrote it down in a note
--   3 website         the agency's own site — the number they would defend in public
--   4 notion_master   the curated master list
--   5 apollo          third-party enrichment (LinkedIn-derived profile counts)
--   6 pipedrive       a CRM field, entered once and rarely revisited
--   7 anything else
--
-- Apollo above Pipedrive is the one placement carrying evidence rather than principle. Nine
-- accounts have a headcount someone stated on a call. Against those, Apollo is exact twice and
-- within 25% four times out of the seven it covers; Pipedrive overcounts both of the two it
-- covers. Small n, so this is a default and not a finding — `website` is ranked above both
-- because a team page is a claim the agency makes about itself, and `rater` above everything
-- because a person looking at the answer beats every machine that guessed it.
--
-- This changes NO stored row. pb_facts keeps every claim from every source; the view chooses.

create or replace view public.pb_current_facts
with (security_invoker = true) as
  select distinct on (account_id, key)
    id, account_id, key, value, evidence_label, source, evidence_url,
    observed_at, entered_by, stand_in, note, created_at
  from public.pb_facts f
  order by
    account_id,
    key,
    case evidence_label when 'evidence' then 0 when 'inferred' then 1 else 2 end,
    case source
      when 'rater'          then 0
      when 'fathom_call'    then 1
      when 'pipedrive_note' then 2
      when 'website'        then 3
      when 'notion_master'  then 4
      when 'apollo'         then 5
      when 'pipedrive'      then 6
      else 7
    end,
    created_at desc,
    observed_at desc nulls last;

comment on view public.pb_current_facts is
  'One winning fact per (account, key): evidence label, then source precedence, then newest written, then newest observed. Mirrors latestFactPerKey in ingest/resolve_features.ts — the two must not drift (CLAUDE.md rule 9).';

-- `create or replace view` resets reloptions when no WITH clause is given, which is how
-- security_invoker was lost once before (20260911180000). It is restated above; this asserts it.
do $$
declare v_opt text;
begin
  select option_value into v_opt
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         lateral pg_options_to_table(c.reloptions)
   where n.nspname = 'public' and c.relname = 'pb_current_facts' and option_name = 'security_invoker';
  if v_opt is distinct from 'true' then
    raise exception 'pb_current_facts lost security_invoker (got %)', coalesce(v_opt, 'null');
  end if;
end $$;
