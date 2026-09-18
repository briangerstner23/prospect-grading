-- prospect_book_fact_source_precedence
--
-- TRANSCRIBED 17 Sep 2026 from supabase_migrations.schema_migrations.statements — the SQL below
-- is byte-for-byte what was applied to the database as version 20260915233744 (applied without a file;
-- DECISIONS §35, §38). Filed as 20260915090100 so it replays after 20260915090000_prospect_book_website_reads.sql. Do not edit the body: if
-- it needs to change, that is a new migration.

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
