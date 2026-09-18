-- The dossier carries the LinkedIn company page.
--
-- A sourced URL nobody can open is not sourced. pb_dossier() already hands the page the
-- account's `domain`; the LinkedIn page is the same class of public identifier and belongs
-- beside it, in the same `account` object, so this adds no section and the section contract
-- in web/CONTRACT.json is untouched.
--
-- Done as a targeted replacement rather than a full redefinition on purpose. pb_dossier() has
-- been redefined five times (the deals-and-candidates cut is the current one) and is 7 KB;
-- transcribing it to change one line is how a function silently loses the address scrub or the
-- attendee-names-only rule that a later migration added. This takes whatever is LIVE and edits
-- the one anchor, so every earlier ruling survives by construction.
--
-- It refuses to no-op quietly: if the anchor is missing the migration raises, because a
-- migration that reports success while changing nothing is the failure mode this repository has
-- already been bitten by (a view that changed in a migration with no file, DECISIONS §33).
do $$
declare
  def text;
  anchor constant text := '''id'', a.id, ''name'', a.name, ''domain'', a.domain,';
  patched constant text := '''id'', a.id, ''name'', a.name, ''domain'', a.domain,'
                           || ' ''linkedin_url'', a.linkedin_url,';
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pb_dossier';

  if def is null then
    raise exception 'pb_dossier() does not exist; nothing to patch';
  end if;

  if position('linkedin_url' in def) > 0 then
    raise notice 'pb_dossier() already carries linkedin_url; nothing to do';
    return;
  end if;

  if position(anchor in def) = 0 then
    raise exception 'pb_dossier() no longer contains the account-object anchor; '
                    'refusing to guess where linkedin_url goes';
  end if;

  execute replace(def, anchor, patched);
end $$;

-- The grants pb_dossier() carries are set by 20260917250000 (dossier public, DECISIONS §43) and
-- survive `create or replace`. Re-stated here so the definer function's reach is never implicit.
revoke all on function public.pb_dossier(uuid) from public;
grant execute on function public.pb_dossier(uuid) to anon, authenticated;
