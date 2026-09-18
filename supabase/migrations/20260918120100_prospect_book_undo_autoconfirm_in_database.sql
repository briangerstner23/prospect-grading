-- pb_undo_autoconfirm shipped requiring a signed-in owner, while pb_autoconfirm_facts — the
-- function that CREATES the batches — already accepted an in-database caller so pg_cron could run
-- it. The asymmetry is a bug, and RUNBOOK §28 is where it shows: that section tells an operator to
-- run `select public.pb_undo_autoconfirm('<batch>'::uuid, 'why');`, which raises "not a WLIQ member"
-- for anybody holding no JWT — which is everybody in the SQL editor. The book could make a batch
-- unattended at 06:00 and then refuse to let anyone take it back except through the web page.
--
-- Worse: nobody had ever run it. It was written, shipped and documented in the same hour, and the
-- undo is the half of §50 that makes the other half safe to switch on.
--
-- Same shape as the runner: no JWT means an in-database caller and nothing else can be, and it
-- signs the register as such rather than as a person.

create or replace function public.pb_undo_autoconfirm(p_batch uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_me       text := public.pb_me();
  v_actor    text;
  r          record;
  v_facts    int := 0;
  v_reopened int := 0;
  v_acc      jsonb := '{}'::jsonb;
  a          record;
begin
  if v_me is null or v_me = '' then
    if session_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception 'pb_undo_autoconfirm is not callable without a signed-in owner';
    end if;
    v_actor := 'an operator at the database';
  else
    if not public.pb_is_wliq() then
      raise exception 'not a WLIQ member';
    end if;
    if public.pb_role() is distinct from 'owner' then
      raise exception 'undoing an automatic approval is the owner lane (PRO-5)';
    end if;
    v_actor := v_me;
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
           note = coalesce(note, '') || ' [automatic approval undone by ' || v_actor || ']'
     where id = r.candidate_id
       and reviewed_by = 'auto:' || r.lane;
    if found then v_reopened := v_reopened + 1; end if;

    v_acc := jsonb_set(v_acc, array[r.account_id::text],
                       to_jsonb(coalesce((v_acc ->> r.account_id::text)::int, 0) + 1), true);
  end loop;

  update public.pb_autoconfirm_log
     set undone_at = now(), undone_by = v_actor
   where batch_id = p_batch and undone_at is null;

  for a in select k::uuid as account_id, v::int as n from jsonb_each_text(v_acc) as e(k, v)
  loop
    insert into public.pb_register (kind, account_id, made_by, text, payload)
    values (
      'note', a.account_id, v_actor,
      v_actor || ' undid ' || a.n || ' automatic approval' || case when a.n = 1 then '' else 's' end ||
      ' here (batch ' || p_batch || '); the facts were removed and the claims are back in the queue.',
      jsonb_build_object('decision', 'undone', 'automatic', true, 'batch_id', p_batch,
                         'undone_here', a.n, 'reviewer_note', p_note)
    );
  end loop;

  return jsonb_build_object('ok', true, 'batch_id', p_batch, 'facts_removed', v_facts,
                            'candidates_reopened', v_reopened, 'undone_by', v_actor,
                            'accounts', (select count(*) from jsonb_object_keys(v_acc)));
end $function$;

revoke all on function public.pb_undo_autoconfirm(uuid, text) from public, anon;
grant execute on function public.pb_undo_autoconfirm(uuid, text) to authenticated, service_role;

comment on function public.pb_undo_autoconfirm(uuid, text) is
  'Take back one batch of automatic approvals: delete the facts it wrote, put the claims back in '
  'the queue, and say so in each account''s register. Refuses to reopen a row a person has decided '
  'since. Owner lane through the page, or an operator in-database — the same two callers as '
  'pb_autoconfirm_facts, because a batch made unattended has to be undoable the same way. '
  'DECISIONS §50, RUNBOOK §28.';
