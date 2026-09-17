-- Admitting Orbit companies into the book. (Owner instruction, 16 Sep 2026: "You can bring them in".)
--
-- Orbit held 187 companies — agencies, and companies with live project work — that had no account
-- here at all. The owner's ruling is that a client is still a prospect, so their absence was the
-- gap, not their presence.
--
-- THIS READS ORBIT AND NEVER WRITES TO IT (CLAUDE.md rule 11). The owner was explicit: "Do not,
-- absolutely do not write anything into Orbit." Nothing in this repository can: `pb_orbit_clients`
-- is filled from Orbit's read-only list endpoints, and no code here calls an Orbit mutation.
--
-- What an admission does NOT do, because the owner also said not to make dramatic assumptions and
-- that the grading still matters:
--
--   * it asserts NO `is_agency` fact. Having an Orbit project says we do work together; it does
--     not say what kind of company they are. The key stays unknown (rule 5).
--   * it asserts no tier, no grade, no engagement. The account enters `Unclassified` and is graded
--     on the same evidence as every other row. Verified after the run: 0 grades, 0 facts.
--   * it is `roster_certified = false`. PRO-6 certifies Pipedrive only, and Orbit is not Pipedrive.
--
-- What it refuses to admit, each a judgement rather than a rule, and none of them silent —
-- `pb_orbit_admission_queue` lists every one with its reason for a person to overrule:
--
--   * anything the identity registry calls junk — WLIQ itself, demo and test rows;
--   * a company named as ANOTHER AGENCY'S END CLIENT (the parenthetical-owner pattern). Those are
--     a partner's client list; admitting them would put a partner's customers on our prospect list
--     and double-count the relationship. 32 records, and the largest single reason;
--   * anything colliding with an existing account once punctuation is ignored — that is a merge
--     question, and merges go through `pb_merge_accounts`.

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
         -- One Orbit record carries two URLs in one field; keep the first host only.
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

  -- pb_register.fingerprint carries no unique constraint, so idempotency is a NOT EXISTS rather
  -- than an ON CONFLICT: an ON CONFLICT on an unindexed column simply errors.
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

/**
 * What admission refuses, and why. Every refusal is a judgement a person can overrule.
 */
create or replace view public.pb_orbit_admission_queue
with (security_invoker = true) as
select o.orbit_id, o.company_name, o.domain, o.client_type, o.client_status,
       o.active_projects, o.account_manager,
       case
         when exists (select 1 from public.pb_mdm_junk j
                       where (j.kind = 'name'   and lower(j.value) = lower(o.company_name))
                          or (j.kind = 'domain' and lower(j.value) = lower(coalesce(o.domain,''))))
           then 'the identity registry lists this as junk — not a company'
         when o.company_name ~* '^(test|test agency|templates?|internal|orbit portal|wliq test|agency demo|core x|web ?pm\+?|webpmplus)$'
           then 'looks like a demo, test or internal row'
         when o.company_name ~ '\([A-Za-z0-9 &.-]+\)\s*$'
           then 'named as another agency''s end client — admitting it would put a partner''s customer list on our prospect list'
         when exists (select 1 from public.pb_accounts a
                       where lower(regexp_replace(a.name, '[^a-z0-9]', '', 'gi'))
                           = lower(regexp_replace(o.company_name, '[^a-z0-9]', '', 'gi')))
           then 'an account already exists under the same name once punctuation is ignored — this is a merge question'
       end as held_back_because
  from public.pb_orbit_clients o
 where not exists (select 1 from public.pb_orbit_overlap ov where ov.orbit_id = o.orbit_id)
   and (o.client_type = 'Agency' or o.active_projects > 0)
   and (
        exists (select 1 from public.pb_mdm_junk j
                 where (j.kind = 'name'   and lower(j.value) = lower(o.company_name))
                    or (j.kind = 'domain' and lower(j.value) = lower(coalesce(o.domain,''))))
     or o.company_name ~* '^(test|test agency|templates?|internal|orbit portal|wliq test|agency demo|core x|web ?pm\+?|webpmplus)$'
     or o.company_name ~ '\([A-Za-z0-9 &.-]+\)\s*$'
     or exists (select 1 from public.pb_accounts a
                 where lower(regexp_replace(a.name, '[^a-z0-9]', '', 'gi'))
                     = lower(regexp_replace(o.company_name, '[^a-z0-9]', '', 'gi')))
   );

comment on view public.pb_orbit_admission_queue is
  'Orbit companies that admission deliberately did not create an account for, with the reason. A person can overrule any of them; the refusal is never silent.';
