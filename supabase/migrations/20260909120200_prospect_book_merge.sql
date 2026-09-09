-- WLIQ Prospect Book — merging two rows that turn out to be one company.
--
-- The merge queue (pb_identity_candidates) proposes; a person decides (PRO-18's discipline,
-- applied to every source). This is the one procedure that carries out a confirmed merge:
-- it moves every fact, signal, contact, call, deal and candidate from the duplicate onto
-- the surviving row, marks the duplicate merged, and writes the decision into the register
-- under the caller's name. Reads are NOT moved: they were computed for the row as it was
-- and remain its history; the next scoring run reads the merged row.
--
-- Callable by owner and rater lanes only. Nothing else may change pb_accounts from a client.

alter table pb_accounts drop constraint if exists pb_accounts_book_check;
alter table pb_accounts add constraint pb_accounts_book_check
  check (book = any (array['prospect','promoted','parked','merged']));
alter table pb_accounts add column if not exists merged_into uuid references pb_accounts(id);

create or replace function public.pb_merge_accounts(source_id uuid, target_id uuid, note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    text := pb_me();
  role  text := pb_role();
  src   pb_accounts%rowtype;
  tgt   pb_accounts%rowtype;
  moved jsonb := '{}'::jsonb;
  n     integer;
begin
  if role is null or role not in ('owner','rater') then
    raise exception 'pb_merge_accounts: only an owner or rater may merge (caller %)', coalesce(me, 'anon');
  end if;
  if source_id = target_id then
    raise exception 'pb_merge_accounts: source and target are the same row';
  end if;
  select * into src from pb_accounts where id = source_id for update;
  select * into tgt from pb_accounts where id = target_id for update;
  if src.id is null or tgt.id is null then
    raise exception 'pb_merge_accounts: unknown account';
  end if;
  if src.book = 'merged' then
    raise exception 'pb_merge_accounts: source is already merged into %', src.merged_into;
  end if;
  if tgt.book = 'merged' then
    raise exception 'pb_merge_accounts: target is itself merged into %', tgt.merged_into;
  end if;

  update pb_facts    set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('facts', n);
  update pb_signals  set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('signals', n);
  update pb_contacts set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('contacts', n);
  update pb_calls    set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('calls', n);
  update pb_deals    set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('deals', n);
  update pb_register set account_id = target_id where account_id = source_id and kind <> 'decision'; get diagnostics n = row_count; moved := moved || jsonb_build_object('register', n);
  update pb_identity_candidates set account_id = target_id where account_id = source_id; get diagnostics n = row_count; moved := moved || jsonb_build_object('candidates', n);
  update pb_identity_candidates
     set status = 'merged', reviewed_by = me, reviewed_at = now(), note = coalesce(note, 'merged via pb_merge_accounts')
   where status = 'proposed' and account_id = target_id
     and ((source = 'pipedrive' and source_id::text = src.pipedrive_org_id::text)
       or (source = 'orbit'     and source_id::text = src.orbit_client_id::text)
       or (source = 'notion_master' and source_id::text = src.notion_client_id)
       or lower(source_name) = lower(src.name));

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
  where id = target_id;

  -- The duplicate keeps its row (history) but leaves the book. Its unique keys are cleared
  -- so the survivor may carry them.
  update pb_accounts set
    book = 'merged', merged_into = target_id, status = 'Merged', effective_tier = null, cell = null,
    pipedrive_org_id = null
  where id = source_id;

  insert into pb_register (kind, account_id, made_by, text, payload)
  values ('decision', target_id, coalesce(nullif(me, ''), 'service_role'),
          format('Merged "%s" into "%s"%s', src.name, tgt.name, coalesce(' — ' || note, '')),
          jsonb_build_object('merged_from', source_id, 'merged_from_name', src.name, 'moved', moved));

  return jsonb_build_object('ok', true, 'source', source_id, 'target', target_id, 'moved', moved);
end $$;

revoke execute on function public.pb_merge_accounts(uuid, uuid, text) from anon, public;
grant  execute on function public.pb_merge_accounts(uuid, uuid, text) to authenticated, service_role;
