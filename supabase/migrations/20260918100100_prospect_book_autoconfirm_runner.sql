/* ------------------------------------------------------------------ *
 * 4. the runner
 * ------------------------------------------------------------------ */

-- p_dry_run defaults to TRUE. Nothing about this function writes until somebody says false, so a
-- mistyped call reports and stops. The nightly job passes false explicitly.
--
-- The lane is re-derived per row at write time, against pb_current_facts as it stands NOW, and
-- never read off the candidate's own `conflicts` column — §45's lesson, and it matters more here
-- because this runs unattended: a person may have recorded the very same key between the sweep
-- and the run, and a stale boolean is exactly how a machine ends up overruling them.
create or replace function public.pb_autoconfirm_facts(
  p_dry_run boolean default true,
  p_limit   int     default 500,
  p_lanes   text[]  default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_me        text  := public.pb_me();
  v_actor     text;
  v_batch     uuid  := gen_random_uuid();
  v_ids       uuid[];
  cand        record;
  v_cur       record;
  v_cid       uuid;
  v_fact_id   uuid;
  v_lane      text;
  v_why       text;
  v_written   int   := 0;
  v_closed    int   := 0;
  v_skipped   int   := 0;
  v_lanes     jsonb := '{}'::jsonb;
  v_skip_why  jsonb := '{}'::jsonb;
  v_acc       jsonb := '{}'::jsonb;
  v_reason    text;
  a           record;
begin
  if v_me is null or v_me = '' then
    -- No JWT: this is pg_cron or the service role calling in-database. Nothing else can be.
    if session_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception 'pb_autoconfirm_facts is not callable without a signed-in owner';
    end if;
    v_actor := 'auto (nightly)';
  else
    if not public.pb_is_wliq() then
      raise exception 'not a WLIQ member';
    end if;
    if public.pb_role() is distinct from 'owner' then
      raise exception 'switching the book''s automatic approvals is the owner lane (PRO-5); the % lane confirms one claim at a time', coalesce(public.pb_role(), 'unknown');
    end if;
    v_actor := v_me;
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 2000 then
    raise exception 'p_limit must be between 1 and 2000, not %', coalesce(p_limit::text, 'null');
  end if;

  -- Snapshot the classification ONCE, into a temp table. Two reasons, and both are load-bearing:
  -- the view reads pb_current_facts, which this loop CHANGES, so iterating it live would let row 1
  -- silently re-classify row 400 halfway through; and re-selecting the view per row would re-scan
  -- every candidate in the queue for each of several hundred writes, which is how a nightly job
  -- discovers the statement timeout. What the snapshot must NOT be trusted for is the one test
  -- that can go stale — whether the book now holds the key — and that is re-derived below, per row,
  -- against pb_current_facts itself.
  -- search_path is '' in this function, so pg_temp is named explicitly; an unqualified temp
  -- reference would not resolve at all.
  create temp table if not exists pb_ac_batch
    (id uuid primary key, lane text not null, why text not null) on commit drop;
  delete from pg_temp.pb_ac_batch;

  insert into pg_temp.pb_ac_batch (id, lane, why)
  select id, lane, why
    from public.pb_fact_candidate_lanes
   where lane_enabled
     and lane <> 'needs_a_person'
     and (p_lanes is null or lane = any(p_lanes))
   order by lane, account_id, key
   limit p_limit;

  select array_agg(id) into v_ids from pg_temp.pb_ac_batch;

  if v_ids is null then
    return jsonb_build_object('ok', true, 'dry_run', p_dry_run, 'batch_id', null,
                              'eligible', 0, 'confirmed', 0, 'closed', 0, 'superseded', 0,
                              'skipped', 0, 'by_lane', '{}'::jsonb, 'skipped_why', '{}'::jsonb,
                              'accounts', 0, 'ran_by', v_actor);
  end if;

  foreach v_cid in array v_ids loop
    select * into cand from public.pb_fact_candidates where id = v_cid for update;
    if not found or cand.status <> 'proposed' then
      v_skipped := v_skipped + 1;
      v_skip_why := jsonb_set(v_skip_why, array['already decided'],
                              to_jsonb(coalesce((v_skip_why ->> 'already decided')::int, 0) + 1), true);
      continue;
    end if;

    select lane, why into v_lane, v_why from pg_temp.pb_ac_batch where id = cand.id;

    -- The hard re-check, in the function rather than in the view, so nothing can route around it.
    select f.value, f.source into v_cur
      from public.pb_current_facts f
     where f.account_id = cand.account_id and f.key = cand.key;

    if v_lane = 'corroborates_book' then
      if not found or v_cur.value is distinct from cand.value then
        v_skipped := v_skipped + 1;
        v_reason := 'the book no longer holds that value';
        v_skip_why := jsonb_set(v_skip_why, array[v_reason],
                                to_jsonb(coalesce((v_skip_why ->> v_reason)::int, 0) + 1), true);
        continue;
      end if;
    elsif found then
      v_skipped := v_skipped + 1;
      v_reason := 'somebody recorded ' || cand.key || ' first';
      v_skip_why := jsonb_set(v_skip_why, array[v_reason],
                              to_jsonb(coalesce((v_skip_why ->> v_reason)::int, 0) + 1), true);
      continue;
    end if;

    v_lanes := jsonb_set(v_lanes, array[v_lane], to_jsonb(coalesce((v_lanes ->> v_lane)::int, 0) + 1), true);
    v_acc   := jsonb_set(v_acc, array[cand.account_id::text],
                         to_jsonb(coalesce((v_acc ->> cand.account_id::text)::int, 0) + 1), true);

    if p_dry_run then
      if v_lane = 'corroborates_book' then v_closed := v_closed + 1; else v_written := v_written + 1; end if;
      continue;
    end if;

    if v_lane = 'corroborates_book' then
      -- Nothing to write. The question was already answered; the row is closed, not confirmed,
      -- because no new fact was established and the register should not pretend one was.
      update public.pb_fact_candidates
         set status = 'superseded',
             reviewed_by = 'auto:' || v_lane,
             reviewed_at = now(),
             note = coalesce(pb_fact_candidates.note, '') ||
                    ' [closed automatically: ' || v_why || ']'
       where id = cand.id;
      insert into public.pb_autoconfirm_log
        (batch_id, account_id, candidate_id, fact_id, lane, action, key, value, ran_by)
      values (v_batch, cand.account_id, cand.id, null, v_lane, 'closed', cand.key, cand.value, v_actor);
      v_closed := v_closed + 1;
      continue;
    end if;

    -- entered_by names the LANE, never a person. A fact nobody read must not look like one
    -- somebody did; that is what makes rule 9's "a person outranks a machine" still mean anything.
    insert into public.pb_facts
      (account_id, key, value, evidence_label, source, evidence_url, note, observed_at, entered_by, stand_in)
    values (
      cand.account_id, cand.key, cand.value, 'evidence', cand.source, cand.evidence_url,
      '"' || cand.quote || '" — approved automatically from ' || cand.source ||
        ' on the ' || v_lane || ' rule (' || v_why || '), batch ' || v_batch,
      cand.observed_at, 'auto:' || v_lane, false
    )
    returning id into v_fact_id;

    insert into public.pb_autoconfirm_log
      (batch_id, account_id, candidate_id, fact_id, lane, action, key, value, ran_by)
    values (v_batch, cand.account_id, cand.id, v_fact_id, v_lane, 'confirmed', cand.key, cand.value, v_actor);

    -- Answering the question closes the other proposals for it. Logged, so undo can reopen them.
    insert into public.pb_autoconfirm_log
      (batch_id, account_id, candidate_id, fact_id, lane, action, key, value, ran_by)
    select v_batch, o.account_id, o.id, null, v_lane, 'superseded', o.key, o.value, v_actor
      from public.pb_fact_candidates o
     where o.account_id = cand.account_id and o.key = cand.key
       and o.status = 'proposed' and o.id <> cand.id;

    update public.pb_fact_candidates
       set status = 'superseded',
           reviewed_by = 'auto:' || v_lane,
           reviewed_at = now(),
           note = coalesce(pb_fact_candidates.note, '') ||
                  ' [closed: ' || cand.key || ' was answered automatically by another candidate]'
     where account_id = cand.account_id and key = cand.key
       and status = 'proposed' and id <> cand.id;
    update public.pb_fact_candidates
       set status = 'confirmed',
           reviewed_by = 'auto:' || v_lane,
           reviewed_at = now(),
           note = coalesce(pb_fact_candidates.note, '') || ' [approved automatically: ' || v_why || ']'
     where id = cand.id;

    v_written := v_written + 1;
  end loop;

  if not p_dry_run and (v_written > 0 or v_closed > 0) then
    -- One row per ACCOUNT, and it says the word "automatically" with the batch in it. A dossier
    -- must never show an unread claim as a considered decision.
    for a in select k::uuid as account_id, v::int as n from jsonb_each_text(v_acc) as e(k, v)
    loop
      insert into public.pb_register (kind, account_id, made_by, text, payload)
      values (
        'note', a.account_id, v_actor,
        'The book approved ' || a.n || ' machine-read claim' || case when a.n = 1 then '' else 's' end ||
        ' here automatically, on rules the owner switched on (batch ' || v_batch ||
        '). Each one is quoted, none overruled anything on file, and any of them can be undone.',
        jsonb_build_object(
          'decision', 'confirmed', 'automatic', true, 'batch_id', v_batch,
          'confirmed_here', a.n, 'by_lane', v_lanes, 'ran_by', v_actor
        )
      );
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true, 'dry_run', p_dry_run, 'batch_id', case when p_dry_run then null else v_batch end,
    'eligible', cardinality(v_ids), 'confirmed', v_written, 'closed', v_closed,
    'superseded', (select count(*) from public.pb_autoconfirm_log
                    where batch_id = v_batch and action = 'superseded'),
    'skipped', v_skipped, 'by_lane', v_lanes, 'skipped_why', v_skip_why,
    'accounts', (select count(*) from jsonb_object_keys(v_acc)), 'ran_by', v_actor
  );
end $function$;

revoke all on function public.pb_autoconfirm_facts(boolean, int, text[]) from public, anon;
grant execute on function public.pb_autoconfirm_facts(boolean, int, text[]) to authenticated, service_role;

comment on function public.pb_autoconfirm_facts(boolean, int, text[]) is
  'Approve the fact candidates whose lane the owner has switched on. Dry run by default. Re-derives '
  'each lane against pb_current_facts at write time, writes facts under entered_by auto:<lane> so '
  'nothing a machine read ever looks like a person''s entry, logs every row to pb_autoconfirm_log '
  'for pb_undo_autoconfirm, and writes one register row per account saying it was automatic. '
  'Owner lane, or pg_cron in-database. DECISIONS §50.';

/* ------------------------------------------------------------------ *
 * 5. undo — the half of the ruling that makes the other half safe
 * ------------------------------------------------------------------ */

create or replace function public.pb_undo_autoconfirm(p_batch uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_me       text := public.pb_me();
  r          record;
  v_facts    int := 0;
  v_reopened int := 0;
  v_acc      jsonb := '{}'::jsonb;
  a          record;
begin
  if not public.pb_is_wliq() then
    raise exception 'not a WLIQ member';
  end if;
  if public.pb_role() is distinct from 'owner' then
    raise exception 'undoing an automatic approval is the owner lane (PRO-5)';
  end if;
  if p_batch is null then
    raise exception 'name the batch to undo';
  end if;
  if not exists (select 1 from public.pb_autoconfirm_log where batch_id = p_batch and undone_at is null) then
    raise exception 'no live automatic approvals in batch %', p_batch;
  end if;

  for r in
    select * from public.pb_autoconfirm_log
     where batch_id = p_batch and undone_at is null
     order by action desc, id
  loop
    if r.fact_id is not null then
      delete from public.pb_facts where id = r.fact_id;
      if found then v_facts := v_facts + 1; end if;
    end if;

    -- Reopen only rows this batch closed and nobody has touched since; a later human decision
    -- on the same row is a decision, and undoing the machine must not undo the person.
    update public.pb_fact_candidates
       set status = 'proposed',
           reviewed_by = null,
           reviewed_at = null,
           note = coalesce(note, '') || ' [automatic approval undone by ' || v_me || ']'
     where id = r.candidate_id
       and reviewed_by = 'auto:' || r.lane;
    if found then v_reopened := v_reopened + 1; end if;

    v_acc := jsonb_set(v_acc, array[r.account_id::text],
                       to_jsonb(coalesce((v_acc ->> r.account_id::text)::int, 0) + 1), true);
  end loop;

  update public.pb_autoconfirm_log
     set undone_at = now(), undone_by = v_me
   where batch_id = p_batch and undone_at is null;

  for a in select k::uuid as account_id, v::int as n from jsonb_each_text(v_acc) as e(k, v)
  loop
    insert into public.pb_register (kind, account_id, made_by, text, payload)
    values (
      'note', a.account_id, v_me,
      v_me || ' undid ' || a.n || ' automatic approval' || case when a.n = 1 then '' else 's' end ||
      ' here (batch ' || p_batch || '); the facts were removed and the claims are back in the queue.',
      jsonb_build_object('decision', 'undone', 'automatic', true, 'batch_id', p_batch,
                         'undone_here', a.n, 'reviewer_note', p_note)
    );
  end loop;

  return jsonb_build_object('ok', true, 'batch_id', p_batch, 'facts_removed', v_facts,
                            'candidates_reopened', v_reopened,
                            'accounts', (select count(*) from jsonb_object_keys(v_acc)));
end $function$;

revoke all on function public.pb_undo_autoconfirm(uuid, text) from public, anon;
grant execute on function public.pb_undo_autoconfirm(uuid, text) to authenticated;

comment on function public.pb_undo_autoconfirm(uuid, text) is
  'Take back one batch of automatic approvals: delete the facts it wrote, put the claims back in '
  'the queue, and say so in each account''s register. Refuses to reopen a row a person has decided '
  'since. Owner lane. DECISIONS §50.';
