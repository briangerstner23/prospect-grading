-- WLIQ Prospect Book — [Wrong agency] forgets a learned name on the terms it was learned on
-- (DECISIONS §66). DRAFT: drafting stamp; re-filed under its applied version in the sitting that
-- applies it, byte-identical to the applied statement (RUNBOOK §28.6, §33.1).
--
-- pb_assign_meeting_mention('assign', remember) stores the card's whole said_key in
-- pb_meeting_aliases ('quillmere|quillmere studio'), and buildRosterIndex learns EVERY '|' part of it as
-- a key that places with no person. A later meeting that hears only 'Quillmere' is placed on that
-- learned part, and its card's said_key is 'quillmere'. [Wrong agency] on that card ran
-- `where said_key = p_said_key`, which never matches the stored 'quillmere|quillmere studio', so the
-- alias stayed active and the next meeting placed the name on the wrong agency again, with no person.
-- Found in review, 13 Nov 2026.
--
-- The one change: unassign deactivates every active alias of the old account(s) that shares a part
-- with the card's said_key. Everything else in the function is migration 20261112233107's, byte for
-- byte. Section 0 refuses to run if the live function is not that version, so a newer definition is
-- never overwritten with this one.

-- 0 · the function this replaces is migration A's --------------------------------------------------
do $$
declare
  v_src text;
begin
  select md5(p.prosrc) into v_src from pg_proc p
   where p.oid = 'public.pb_assign_meeting_mention(text, text, text, uuid, boolean)'::regprocedure;
  if v_src is distinct from '6cb87141f6fdab5fb3331064060dde0a' then
    raise exception 'pb_assign_meeting_mention is not migration 20261112233107''s version (md5 %); re-read it and rebase this change', v_src;
  end if;
end $$;

-- 1 · pb_assign_meeting_mention ----------------------------------------------------------------------
create or replace function public.pb_assign_meeting_mention(
  p_recording_id text, p_said_key text, p_decision text, p_account uuid default null, p_remember boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      text := public.pb_me();
  v_role    text := public.pb_role();
  v_book    text;
  v_merged  uuid;
  v_n       integer := 0;
  v_old     uuid[];
  v_forgot  integer := 0;
  v_learned boolean := false;
  v_super   integer := 0;
begin
  if not coalesce(public.pb_is_wliq(), false) then
    raise exception 'not a WLIQ member';
  end if;
  if v_role is distinct from 'owner' and v_role is distinct from 'rater' then
    raise exception 'the % lane may not place meeting names', coalesce(v_role, 'unknown');
  end if;
  if coalesce(p_decision, '') not in ('assign', 'unassign', 'not_in_book', 'not_an_agency') then
    raise exception 'decision is assign, unassign, not_in_book or not_an_agency, not %', coalesce(p_decision, '(none)');
  end if;

  perform 1 from public.pb_meeting_proposals
   where recording_id = p_recording_id and said_key = p_said_key
     and status in ('proposed', 'not_proposed', 'agrees', 'superseded')
   order by id for update;
  if not found then
    raise exception 'no open proposal for that name in that meeting';
  end if;

  if p_decision = 'assign' then
    if p_account is null then
      raise exception 'assign names an account';
    end if;
    select a.book, a.merged_into into v_book, v_merged from public.pb_accounts a where a.id = p_account;
    if v_book is null then
      raise exception 'no such account';
    end if;
    if v_book = 'merged' then
      raise exception 'that record is merged into %; place the name on the surviving account', v_merged;
    end if;
    if v_book not in ('prospect', 'parked') then
      raise exception 'that account is % in the book; a meeting proposal attaches only to a prospect or parked agency', v_book;
    end if;
    update public.pb_meeting_proposals
       set account_id = p_account, matched_on = 'person', mention_state = 'resolved',
           status = case when status in ('agrees', 'superseded') then 'proposed' else status end,
           superseded_by = null
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees', 'superseded');
    get diagnostics v_n = row_count;
    if coalesce(p_remember, true) then
      insert into public.pb_meeting_aliases (said_key, account_id, confirmed_by, from_recording, active)
      values (p_said_key, p_account, v_me, p_recording_id, true)
      on conflict (said_key, account_id) do update
        set active = true, confirmed_by = excluded.confirmed_by, confirmed_at = now(),
            from_recording = excluded.from_recording;
      v_learned := true;
    end if;
    v_super := public.pb_meeting_supersede(p_recording_id);

  elsif p_decision = 'unassign' then
    select array_agg(distinct account_id) into v_old
      from public.pb_meeting_proposals
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees', 'superseded') and account_id is not null;
    update public.pb_meeting_proposals
       set account_id = null, matched_on = null, mention_state = 'ambiguous',
           status = case when status in ('agrees', 'superseded') then 'proposed' else status end,
           superseded_by = null
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees', 'superseded');
    get diagnostics v_n = row_count;
    -- Forget on the terms the index learns on: buildRosterIndex learns every '|' part of a stored
    -- key, so an alias stored as 'x|x studio' places a later card heard only as 'x'. Matching the
    -- whole key could never forget it. Any alias of the old account sharing a part with this card's
    -- name goes; its other parts go with it, the safe direction (a person confirms the name again).
    update public.pb_meeting_aliases
       set active = false
     where account_id = any (coalesce(v_old, '{}'::uuid[])) and active
       and string_to_array(said_key, '|') && string_to_array(p_said_key, '|');
    get diagnostics v_forgot = row_count;
    v_super := public.pb_meeting_supersede(p_recording_id);

  else
    update public.pb_meeting_proposals
       set status = 'rejected', decided_by = v_me, decided_at = now(),
           decision_note = case p_decision when 'not_in_book' then 'not in the book' else 'not an agency' end
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees', 'superseded');
    get diagnostics v_n = row_count;
    v_super := public.pb_meeting_supersede(p_recording_id);
  end if;

  return jsonb_build_object(
    'ok', true, 'decision', p_decision, 'recording_id', p_recording_id, 'said_key', p_said_key,
    'account_id', case when p_decision = 'assign' then p_account end,
    'rows', v_n, 'remembered', v_learned, 'forgotten', v_forgot, 'superseded', v_super);
end $$;

-- 2 · privileges, restated (CREATE OR REPLACE keeps them; stated so the file says what it leaves) ------
revoke all on function public.pb_assign_meeting_mention(text, text, text, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.pb_assign_meeting_mention(text, text, text, uuid, boolean) to authenticated;
