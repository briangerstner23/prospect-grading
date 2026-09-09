-- WLIQ Prospect Book — closing the identity loop.
--
-- The merge queue proposes; a person decides (PRO-18's discipline applied to every source).
-- Until now a reviewer could mark a candidate merged or rejected, but nothing carried the
-- decision through: an Orbit candidate marked merged left pb_accounts.orbit_client_id empty,
-- so the next quote sweep still could not attach. This procedure is the one place a review
-- becomes an effect:
--
--   orbit          → the account takes the Orbit client id
--   pipedrive      → if another pb_accounts row already carries that Pipedrive organisation,
--                    the reviewed account is merged INTO it (pb_merge_accounts; the certified
--                    Pipedrive row survives); otherwise the account takes the org id and is
--                    certified (PRO-6)
--   notion_master  → the account takes the Notion client id
--   fathom         → the call rows that carry the candidate's source_id attach to the account
--   sales_sheet / tier1_book / gotham / brian_trip / client_book → recorded only
--
-- Rejected candidates are recorded and nothing else moves. Owner and rater lanes only.

create or replace function public.pb_review_candidate(p_candidate uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  caller_email text := pb_me();
  caller_role  text := pb_role();
  c            pb_identity_candidates%rowtype;
  acct         pb_accounts%rowtype;
  other        pb_accounts%rowtype;
  effect       jsonb := '{}'::jsonb;
  n            integer;
begin
  if caller_role is null or caller_role not in ('owner','rater') then
    raise exception 'pb_review_candidate: only an owner or rater may review (caller %)', coalesce(nullif(caller_email, ''), 'anon');
  end if;
  if p_decision not in ('merged','rejected') then
    raise exception 'pb_review_candidate: decision must be merged or rejected';
  end if;
  select * into c from pb_identity_candidates where id = p_candidate for update;
  if c.id is null then raise exception 'pb_review_candidate: unknown candidate'; end if;
  if c.status <> 'proposed' then raise exception 'pb_review_candidate: candidate is already %', c.status; end if;
  if c.account_id is null then
    raise exception 'pb_review_candidate: this candidate has no account to attach to; create the account first';
  end if;
  select * into acct from pb_accounts where id = c.account_id for update;
  if acct.id is null then raise exception 'pb_review_candidate: candidate points at a missing account'; end if;

  if p_decision = 'rejected' then
    update pb_identity_candidates set status = 'rejected', reviewed_by = caller_email, reviewed_at = now(), note = coalesce(p_note, note)
     where id = p_candidate;
    insert into pb_register (kind, account_id, made_by, text, payload)
    values ('decision', c.account_id, caller_email,
            format('Rejected identity match: %s "%s"%s', c.source, coalesce(c.source_name, c.source_id), coalesce(' — ' || p_note, '')),
            jsonb_build_object('candidate', p_candidate, 'source', c.source, 'source_id', c.source_id));
    return jsonb_build_object('ok', true, 'decision', 'rejected');
  end if;

  if c.source = 'orbit' then
    update pb_accounts set orbit_client_id = c.source_id::integer where id = c.account_id and orbit_client_id is null;
    get diagnostics n = row_count;
    effect := jsonb_build_object('orbit_client_id_set', n = 1, 'orbit_client_id', c.source_id);
    -- Any Orbit-sourced signal or fact already recorded for this Orbit client but parked without an account.
  elsif c.source = 'pipedrive' then
    select * into other from pb_accounts where pipedrive_org_id = c.source_id::bigint and id <> c.account_id and book <> 'merged';
    if other.id is not null then
      effect := pb_merge_accounts(c.account_id, other.id, coalesce(p_note, 'identity review: same company as the Pipedrive organisation'));
      effect := effect || jsonb_build_object('merged_into', other.id);
    else
      update pb_accounts set pipedrive_org_id = c.source_id::bigint, roster_certified = true,
                             roster_source = coalesce(roster_source, 'pipedrive')
       where id = c.account_id;
      effect := jsonb_build_object('pipedrive_org_id_set', true, 'roster_certified', true);
    end if;
  elsif c.source = 'notion_master' then
    update pb_accounts set notion_client_id = c.source_id where id = c.account_id and notion_client_id is null;
    get diagnostics n = row_count;
    effect := jsonb_build_object('notion_client_id_set', n = 1);
  elsif c.source = 'fathom' then
    update pb_calls set account_id = c.account_id where fathom_recording_id = c.source_id and account_id is null;
    get diagnostics n = row_count;
    effect := jsonb_build_object('calls_attached', n);
  else
    effect := jsonb_build_object('recorded_only', true);
  end if;

  update pb_identity_candidates set status = 'merged', reviewed_by = caller_email, reviewed_at = now(), note = coalesce(p_note, note)
   where id = p_candidate and status = 'proposed';

  insert into pb_register (kind, account_id, made_by, text, payload)
  values ('decision', coalesce((effect ->> 'merged_into')::uuid, c.account_id), caller_email,
          format('Confirmed identity match: %s "%s"%s', c.source, coalesce(c.source_name, c.source_id), coalesce(' — ' || p_note, '')),
          jsonb_build_object('candidate', p_candidate, 'source', c.source, 'source_id', c.source_id, 'effect', effect));

  return jsonb_build_object('ok', true, 'decision', 'merged', 'effect', effect);
end $$;

comment on function public.pb_review_candidate(uuid, text, text) is
  'A reviewer''s decision on a merge-queue row, carried through: orbit → orbit_client_id; pipedrive → merge into the certified row or take the org id; notion_master → notion_client_id; fathom → attach calls. Owner and rater lanes only. Every decision is a register row.';

revoke execute on function public.pb_review_candidate(uuid, text, text) from anon, public;
grant  execute on function public.pb_review_candidate(uuid, text, text) to authenticated, service_role;
