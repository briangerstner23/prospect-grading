-- WLIQ Prospect Book — filed verbatim from supabase_migrations.schema_migrations on 17 Sep 2026.
-- Applied 20260916132851 as "prospect_book_admit_from_orbit_fix" by the 16 September session, which pushed its work to its own
-- branch and never filed this one. Recovered with the branch merge; see DECISIONS §38 for the
-- precedent and §45 for why eleven branches existed. Byte-for-byte what ran; do not re-edit here.

-- `pb_register.fingerprint` carries no unique constraint, so an ON CONFLICT on it cannot work.
-- Guard the register insert with a NOT EXISTS on the same fingerprint instead, which gives the
-- same idempotency without assuming an index that does not exist.

create or replace function public.pb_admit_from_orbit(p_dry_run boolean default true)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer := 0;
begin
  create temporary table if not exists _pb_admit_candidates (
    orbit_id integer, company_name text, domain text, client_type text,
    client_status text, active_projects integer, account_manager text
  ) on commit drop;
  delete from _pb_admit_candidates;

  insert into _pb_admit_candidates
  select o.orbit_id, o.company_name,
         nullif(lower(split_part(btrim(o.domain), ' ', 1)), ''),
         o.client_type, o.client_status, o.active_projects, o.account_manager
    from public.pb_orbit_clients o
   where not exists (select 1 from public.pb_orbit_overlap ov where ov.orbit_id = o.orbit_id)
     and (o.client_type = 'Agency' or o.active_projects > 0)
     and not exists (select 1 from public.pb_mdm_junk j
                      where (j.kind = 'name'   and lower(j.value) = lower(o.company_name))
                         or (j.kind = 'domain' and lower(j.value) = lower(coalesce(o.domain,''))))
     and o.company_name !~* '^(test|test agency|templates?|internal|orbit portal|wliq test|agency demo|core x|web ?pm\+?|webpmplus)$'
     and o.company_name !~ '\([A-Za-z0-9 &.-]+\)\s*$'
     and not exists (
           select 1 from public.pb_accounts a
            where lower(regexp_replace(a.name, '[^a-z0-9]', '', 'gi'))
                = lower(regexp_replace(o.company_name, '[^a-z0-9]', '', 'gi')));

  select count(*) into v_count from _pb_admit_candidates;
  if p_dry_run then
    return v_count;
  end if;

  create temporary table if not exists _pb_admitted (id uuid, orbit_client_id integer) on commit drop;
  delete from _pb_admitted;

  with ins as (
    insert into public.pb_accounts
      (key, name, domain, orbit_client_id, book, roster_source, roster_certified, status)
    select lower(c.company_name), c.company_name, c.domain, c.orbit_id,
           'prospect', 'orbit', false, 'Unclassified'
      from _pb_admit_candidates c
    on conflict (key) do nothing
    returning id, orbit_client_id
  )
  insert into _pb_admitted select id, orbit_client_id from ins;

  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, fingerprint)
  select 'note', ad.id,
         'claude (session 16 Sep 2026), on the owner''s instruction to bring the Orbit companies in',
         'data_wrong',
         'Admitted from Orbit (client ' || ad.orbit_client_id || '). ' ||
         'Status ' || coalesce(c.client_status, 'not set') ||
         ', type ' || coalesce(c.client_type, 'not set') ||
         ', ' || c.active_projects || ' active project(s)' ||
         coalesce(', account manager ' || c.account_manager, '') || '. ' ||
         'NOTHING is asserted about this account beyond its existence: no is_agency, no tier, ' ||
         'no engagement. It is roster_certified = false because PRO-6 certifies Pipedrive only, ' ||
         'and it is graded on the same evidence as every other row. Orbit was read, never written.',
         jsonb_build_object('orbit_id', ad.orbit_client_id, 'client_status', c.client_status,
                            'client_type', c.client_type, 'active_projects', c.active_projects,
                            'account_manager', c.account_manager, 'admitted_from', 'orbit'),
         encode(sha256(convert_to('orbit_admission|' || ad.orbit_client_id::text, 'UTF8')), 'hex')
    from _pb_admitted ad
    join _pb_admit_candidates c on c.orbit_id = ad.orbit_client_id
   where not exists (
     select 1 from public.pb_register r
      where r.fingerprint = encode(sha256(convert_to('orbit_admission|' || ad.orbit_client_id::text, 'UTF8')), 'hex'));

  select count(*) into v_count from _pb_admitted;
  return v_count;
end $function$;

revoke all on function public.pb_admit_from_orbit(boolean) from public, anon, authenticated;

comment on function public.pb_admit_from_orbit(boolean) is
  'Admit Orbit companies that have no account yet. Reads Orbit''s snapshot, never writes to Orbit. Asserts no is_agency, no tier and no engagement — existence only (owner instruction, 16 Sep 2026). Dry run by default.';
