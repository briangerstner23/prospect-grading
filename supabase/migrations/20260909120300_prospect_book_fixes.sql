-- WLIQ Prospect Book — corrective DDL after the first review of the schema and merge
-- migrations (9 Sep 2026).
--
-- Applied migrations are history and are never edited — the Client Book's discipline (its own
-- broken lock-down migration of 30 Aug is kept unedited and repaired by the two that follow
-- it). Every correction here is a new statement that supersedes the earlier one. Idempotent.
--
-- What this fixes, and why:
--
--   1. pb_role() recursed. It was SECURITY INVOKER and read pb_members, whose SELECT policy
--      (pb_members_read) itself calls pb_role(); every rater's call ended in "stack depth
--      limit exceeded", so the fact lane, the hand-signal lane, the merge review and the
--      page's member lookup failed for anyone but the owner (who succeeded only because her
--      own row satisfied the OR before pb_role() was reached). pb_role() is now SECURITY
--      DEFINER: its read of pb_members bypasses the policy. pb_me() and pb_is_wliq() touch
--      no table and stay INVOKER. All three stay executable by `authenticated` and never by
--      anon — policy expressions evaluate as the querying role (the Client Book's lesson).
--
--   2. pb_merge_accounts could never complete: its parameters `source_id` and `note` shared
--      their names with pb_identity_candidates columns, and PL/pgSQL (variable_conflict =
--      error, the default) aborted on the first candidate statement. The parameters are now
--      p_source / p_target / p_note (Postgres cannot rename a parameter in place, so the
--      function is dropped and re-created; nothing calls it by named argument yet), every
--      candidate column reference is qualified, and the duplicate releases its unique
--      pipedrive_org_id BEFORE the survivor takes it — the old order hit the unique
--      constraint whenever only the duplicate carried the id.
--
--   3. The identity-review guard's WHEN clause tested current_setting('role'), which stays
--      'authenticated' inside a SECURITY DEFINER call, so the guard refused the merge
--      procedure's own account_id move. It now tests current_user, which is the function
--      owner inside a DEFINER body and 'authenticated' under PostgREST. The guard also
--      freezes `id`: a reviewer could rewrite a candidate's primary key.
--
--   4. pb_signals_insert let a rater write any type, weight, lifespan and decays flag,
--      bypassing the rubric catalog that pb-sync enforces. A BEFORE INSERT trigger on the
--      client lane now requires the type to be in the active rubric's signals.catalog and
--      takes weight / lifespan_days / decays / expires_at from that entry, ignoring whatever
--      the client sent — a weight comes from the rubric, never from a hand. The service-role
--      lane (pb-sync) is untouched: it fills gaps from the same catalog and may carry a
--      weight a source stated.
--
--   5. The two views were granted to authenticated but never revoked from anon; under
--      Supabase's default privileges anon held SELECT on them and was stopped only by the
--      table-level revoke behind security_invoker. The views now deny anon on their own.

-- ── 1 · pb_role() reads pb_members as the definer, never through its own policy ─────────
create or replace function public.pb_role() returns text
  language sql stable security definer set search_path = public as
$$ select role from pb_members where email = pb_me() and active $$;

comment on function public.pb_role() is
  'The caller''s write lane (owner / rater / viewer) or null. SECURITY DEFINER because pb_members_read calls this function: an INVOKER read of pb_members would recurse into its own policy.';

revoke execute on function public.pb_role() from anon, public;
grant  execute on function public.pb_role() to authenticated;

-- ── 3 · the identity-review guard: freeze id too; skip for trusted (definer) code paths ──
create or replace function public.pb_identity_review_guard() returns trigger
  language plpgsql security invoker set search_path = public as $$
begin
  if new.id is distinct from old.id
     or new.account_id is distinct from old.account_id
     or new.source is distinct from old.source
     or new.source_id is distinct from old.source_id
     or new.source_name is distinct from old.source_name
     or new.source_domain is distinct from old.source_domain
     or new.matched_on is distinct from old.matched_on
     or new.confidence is distinct from old.confidence
     or new.created_at is distinct from old.created_at then
    raise exception 'pb_identity_candidates: only status, reviewed_by, reviewed_at and note may be changed by a reviewer';
  end if;
  new.reviewed_at := coalesce(new.reviewed_at, now());
  return new;
end $$;

-- current_user, not current_setting('role'): SET ROLE leaves the `role` GUC at 'authenticated'
-- inside a SECURITY DEFINER body, but current_user there is the function owner. A direct
-- client update under PostgREST still runs as current_user = 'authenticated'.
drop trigger if exists pb_identity_review_guard_trg on pb_identity_candidates;
create trigger pb_identity_review_guard_trg
  before update on pb_identity_candidates
  for each row when (current_user = 'authenticated')
  execute function public.pb_identity_review_guard();

-- ── 4 · hand signals take their weight from the active rubric's catalog ─────────────────
create or replace function public.pb_signals_catalog_guard() returns trigger
  language plpgsql security invoker set search_path = public as $$
declare
  catalog jsonb;
  entry   jsonb;
begin
  select v.spec -> 'signals' -> 'catalog' into catalog
    from pb_rubric_versions v
   where v.status = 'active'
   order by v.created_at desc
   limit 1;
  if catalog is null or jsonb_typeof(catalog) <> 'object' then
    raise exception 'pb_signals: no active rubric with a signal catalog is readable; a hand signal cannot be weighted';
  end if;
  entry := catalog -> new.type;
  if entry is null or jsonb_typeof(entry) <> 'object' or jsonb_typeof(entry -> 'weight') <> 'number' then
    raise exception 'pb_signals: type % is not in the active rubric catalog', coalesce(new.type, '(null)');
  end if;
  -- The catalog is the only source of these four; whatever the client sent is discarded.
  new.weight        := (entry ->> 'weight')::numeric;
  new.lifespan_days := case when jsonb_typeof(entry -> 'lifespan_days') = 'number'
                            then round((entry ->> 'lifespan_days')::numeric)::integer end;
  new.decays        := case when jsonb_typeof(entry -> 'decays') = 'boolean'
                            then (entry ->> 'decays')::boolean else true end;
  new.expires_at    := case when new.lifespan_days is not null and new.lifespan_days > 0
                            then new.observed_at + make_interval(days => new.lifespan_days) end;
  return new;
end $$;

comment on function public.pb_signals_catalog_guard() is
  'Client-lane hand signals: the type must be in the active rubric''s signals.catalog; weight, lifespan_days, decays and expires_at are taken from the catalog entry, never from the request.';

drop trigger if exists pb_signals_catalog_guard_trg on pb_signals;
create trigger pb_signals_catalog_guard_trg
  before insert on pb_signals
  for each row when (current_user = 'authenticated')
  execute function public.pb_signals_catalog_guard();

-- ── 5 · the views deny anon on their own ────────────────────────────────────────────────
revoke all on pb_current_reads, pb_current_facts from anon, public;
grant  select on pb_current_reads, pb_current_facts to authenticated;

-- ── 2 · pb_merge_accounts, re-issued with unambiguous names ─────────────────────────────
-- Dropped rather than replaced: Postgres refuses to rename a parameter in place. Callers pass
-- positional arguments (or, over PostgREST RPC, {p_source, p_target, p_note}).
drop function if exists public.pb_merge_accounts(uuid, uuid, text);

create function public.pb_merge_accounts(p_source uuid, p_target uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  caller_email text := pb_me();
  caller_role  text := pb_role();
  src   pb_accounts%rowtype;
  tgt   pb_accounts%rowtype;
  moved jsonb := '{}'::jsonb;
  n     integer;
begin
  if caller_role is null or caller_role not in ('owner','rater') then
    raise exception 'pb_merge_accounts: only an owner or rater may merge (caller %)', coalesce(nullif(caller_email, ''), 'anon');
  end if;
  if p_source is null or p_target is null then
    raise exception 'pb_merge_accounts: source and target are required';
  end if;
  if p_source = p_target then
    raise exception 'pb_merge_accounts: source and target are the same row';
  end if;
  select * into src from pb_accounts where id = p_source for update;
  select * into tgt from pb_accounts where id = p_target for update;
  if src.id is null or tgt.id is null then
    raise exception 'pb_merge_accounts: unknown account';
  end if;
  if src.book = 'merged' then
    raise exception 'pb_merge_accounts: source is already merged into %', src.merged_into;
  end if;
  if tgt.book = 'merged' then
    raise exception 'pb_merge_accounts: target is itself merged into %', tgt.merged_into;
  end if;

  update pb_facts    set account_id = p_target where account_id = p_source; get diagnostics n = row_count; moved := moved || jsonb_build_object('facts', n);
  update pb_signals  set account_id = p_target where account_id = p_source; get diagnostics n = row_count; moved := moved || jsonb_build_object('signals', n);
  update pb_contacts set account_id = p_target where account_id = p_source; get diagnostics n = row_count; moved := moved || jsonb_build_object('contacts', n);
  update pb_calls    set account_id = p_target where account_id = p_source; get diagnostics n = row_count; moved := moved || jsonb_build_object('calls', n);
  update pb_deals    set account_id = p_target where account_id = p_source; get diagnostics n = row_count; moved := moved || jsonb_build_object('deals', n);
  update pb_register set account_id = p_target where account_id = p_source and kind <> 'decision'; get diagnostics n = row_count; moved := moved || jsonb_build_object('register', n);

  -- The review guard does not fire here: current_user inside this DEFINER body is the owner.
  update pb_identity_candidates c set account_id = p_target where c.account_id = p_source;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('candidates', n);

  -- Proposed candidates that pointed at the duplicate's identity are what this merge answers.
  update pb_identity_candidates c
     set status = 'merged', reviewed_by = caller_email, reviewed_at = now(),
         note = coalesce(p_note, c.note, 'merged via pb_merge_accounts')
   where c.status = 'proposed' and c.account_id = p_target
     and ((c.source = 'pipedrive'     and c.source_id = src.pipedrive_org_id::text)
       or (c.source = 'orbit'         and c.source_id = src.orbit_client_id::text)
       or (c.source = 'notion_master' and c.source_id = src.notion_client_id)
       or lower(c.source_name) = lower(src.name));

  -- The duplicate keeps its row (history) but leaves the book FIRST, releasing its unique
  -- keys so the survivor may carry them in the next statement.
  update pb_accounts set
    book = 'merged', merged_into = p_target, status = 'Merged', effective_tier = null, cell = null,
    pipedrive_org_id = null
  where id = p_source;

  -- Identity keys travel to the survivor when it lacks them; the survivor's own keys win.
  update pb_accounts set
    domain            = coalesce(tgt.domain, src.domain),
    pipedrive_org_id  = coalesce(tgt.pipedrive_org_id, src.pipedrive_org_id),
    orbit_client_id   = coalesce(tgt.orbit_client_id, src.orbit_client_id),
    apollo_org_id     = coalesce(tgt.apollo_org_id, src.apollo_org_id),
    notion_client_id  = coalesce(tgt.notion_client_id, src.notion_client_id),
    notion_page_id    = coalesce(tgt.notion_page_id, src.notion_page_id),
    roster_certified  = tgt.roster_certified or src.roster_certified,
    roster_source     = case when tgt.roster_certified then tgt.roster_source
                             when src.roster_certified then src.roster_source
                             else tgt.roster_source end,
    relationship_type = coalesce(tgt.relationship_type, src.relationship_type),
    lineage           = coalesce(tgt.lineage, src.lineage)
  where id = p_target;

  insert into pb_register (kind, account_id, made_by, text, payload)
  values ('decision', p_target, coalesce(nullif(caller_email, ''), 'service_role'),
          format('Merged "%s" into "%s"%s', src.name, tgt.name, coalesce(' — ' || p_note, '')),
          jsonb_build_object('merged_from', p_source, 'merged_from_name', src.name, 'moved', moved));

  return jsonb_build_object('ok', true, 'source', p_source, 'target', p_target, 'moved', moved);
end $$;

comment on function public.pb_merge_accounts(uuid, uuid, text) is
  'Carry out a confirmed merge: move facts, signals, contacts, calls, deals, register rows and candidates from p_source onto p_target, mark p_source merged, record the decision. Owner and rater lanes only; reads are never moved.';

revoke execute on function public.pb_merge_accounts(uuid, uuid, text) from anon, public;
grant  execute on function public.pb_merge_accounts(uuid, uuid, text) to authenticated, service_role;
