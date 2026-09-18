/* ------------------------------------------------------------------ *
 * 6. the gap §45 left open
 * ------------------------------------------------------------------ */

-- pb_confirm_fact_candidates says in its own comment that it refuses "a claim that is somebody's
-- judgement rather than an observation". It never did: `kind` appears nowhere in the function, and
-- on the morning this was written 11 claims the extractor had explicitly marked `judgement` were
-- sitting inside its gate, one click from being facts. Nothing else about the function changes.
create or replace function public.pb_confirm_fact_candidates(p_candidates uuid[], p_note text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  c            record;
  v_me         text  := public.pb_me();
  v_role       text  := public.pb_role();
  v_batch      uuid  := gen_random_uuid();
  v_ids        uuid[];
  v_confirmed  int   := 0;
  v_cur        record;
  v_fact_id    uuid;
  v_superseded int   := 0;
  v_sup        int   := 0;
  v_skip       jsonb := '{}'::jsonb;
  v_acc        jsonb := '{}'::jsonb;
  v_keys       jsonb := '{}'::jsonb;
  a            record;

  procedure_skip text;
begin
  if not public.pb_is_wliq() then
    raise exception 'not a WLIQ member';
  end if;
  -- Stricter than single review on purpose: rater may confirm one claim, not two hundred.
  if v_role is distinct from 'owner' then
    raise exception 'confirming in bulk is the owner lane (PRO-5); the % lane confirms one claim at a time', coalesce(v_role, 'unknown');
  end if;
  if p_candidates is null or cardinality(p_candidates) = 0 then
    raise exception 'no candidates named';
  end if;

  select array_agg(distinct x) into v_ids from unnest(p_candidates) as x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'no candidates named';
  end if;
  -- Lower than the reject cap (1000) because this one writes. A batch a person cannot hold in
  -- their head is not a review, and 250 facts is already a great deal to answer for at once.
  if cardinality(v_ids) > 250 then
    raise exception 'that is % candidates; confirm at most 250 in one decision', cardinality(v_ids);
  end if;

  for c in
    select * from public.pb_fact_candidates
     where id = any(v_ids)
     order by id
       for update
  loop
    procedure_skip := null;

    if c.status <> 'proposed' then
      procedure_skip := 'already ' || c.status;
    elsif coalesce(c.confidence, '') <> 'high' then
      procedure_skip := 'confidence ' || coalesce(c.confidence, 'unstated') || ' — answer it one at a time';
    elsif c.quote is null or length(btrim(c.quote)) = 0 then
      procedure_skip := 'no quote in the source — answer it one at a time';
    elsif c.kind = 'judgement' then
      procedure_skip := 'the sentence behind it is an assessment, not an observation — answer it one at a time';
    end if;

    if procedure_skip is null then
      -- Re-derived now, not read off c.conflicts, which may be hours stale.
      select f.value, f.source, f.evidence_label into v_cur
        from public.pb_current_facts f
       where f.account_id = c.account_id and f.key = c.key;
      if found then
        if v_cur.value is not distinct from c.value then
          procedure_skip := 'already on record with the same value';
        else
          procedure_skip := 'disagrees with what ' || coalesce(v_cur.source, 'the book') || ' holds — answer it one at a time';
        end if;
      end if;
    end if;

    if procedure_skip is not null then
      v_skip := jsonb_set(v_skip, array[procedure_skip],
                          to_jsonb(coalesce((v_skip ->> procedure_skip)::int, 0) + 1), true);
      continue;
    end if;

    insert into public.pb_facts
      (account_id, key, value, evidence_label, source, evidence_url, note, observed_at, entered_by, stand_in)
    values (
      c.account_id, c.key, c.value, 'evidence', c.source, c.evidence_url,
      '"' || c.quote || '" — confirmed from ' || c.source || ' by ' || v_me ||
        ' in a bulk review of ' || cardinality(v_ids) || ' claims (batch ' || v_batch || ')',
      c.observed_at, v_me, false
    )
    returning id into v_fact_id;

    update public.pb_fact_candidates
       set status = 'superseded',
           reviewed_by = v_me,
           reviewed_at = now(),
           note = coalesce(pb_fact_candidates.note, '') || ' [closed: ' || c.key || ' was answered by another candidate]'
     where account_id = c.account_id
       and key = c.key
       and status = 'proposed'
       and id <> c.id;
    get diagnostics v_sup = row_count;
    v_superseded := v_superseded + v_sup;

    update public.pb_fact_candidates
       set status = 'confirmed',
           reviewed_by = v_me,
           reviewed_at = now(),
           note = coalesce(p_note, pb_fact_candidates.note)
     where id = c.id;

    v_confirmed := v_confirmed + 1;
    v_keys := jsonb_set(v_keys, array[c.key], to_jsonb(coalesce((v_keys ->> c.key)::int, 0) + 1), true);
    v_acc  := jsonb_set(v_acc, array[c.account_id::text],
                        to_jsonb(coalesce((v_acc ->> c.account_id::text)::int, 0) + 1), true);
  end loop;

  -- One row per account, and it says "bulk". The register is read by people deciding whether to
  -- trust a fact; it must never present a batch as a series of separate readings.
  for a in select k::uuid as account_id, v::int as n from jsonb_each_text(v_acc) as e(k, v)
  loop
    insert into public.pb_register (kind, account_id, made_by, text, payload)
    values (
      'note', a.account_id, v_me,
      v_me || ' confirmed ' || a.n || ' machine-read claim' || case when a.n = 1 then '' else 's' end ||
      ' here in a bulk review of ' || cardinality(v_ids) || ', limited to claims the extractor rated high, ' ||
      'with a quote, on keys the book held nothing for.',
      jsonb_build_object(
        'decision', 'confirmed', 'bulk', true, 'batch_id', v_batch,
        'batch_size', cardinality(v_ids), 'confirmed_here', a.n,
        'reviewer_note', p_note
      )
    );
  end loop;

  return jsonb_build_object(
    'ok', true, 'decision', 'confirmed', 'bulk', true, 'batch_id', v_batch,
    'named', cardinality(v_ids), 'confirmed', v_confirmed,
    'skipped', cardinality(v_ids) - v_confirmed, 'skipped_why', v_skip,
    'superseded', v_superseded, 'accounts', (select count(*) from jsonb_object_keys(v_acc)),
    'keys', v_keys
  );
end $function$;

revoke all on function public.pb_confirm_fact_candidates(uuid[], text) from public, anon;
grant execute on function public.pb_confirm_fact_candidates(uuid[], text) to authenticated, service_role;

comment on function public.pb_confirm_fact_candidates(uuid[], text) is
  'Confirm fact candidates in bulk — owner lane only, and only the class where a reviewer has '
  'nothing to weigh: the extractor rated it high, a verbatim quote is attached, and the book holds '
  'nothing for that key. Medium or low confidence, a missing quote, an explicit judgement and any '
  'value that disagrees with what is on file are REFUSED here rather than in the page, so no '
  'interface can widen it. The conflict test is re-derived against pb_current_facts at confirm '
  'time, never read off the candidate''s stale conflicts column. Writes one register row per '
  'ACCOUNT saying the word bulk with the batch size, so the audit trail never presents one click '
  'as many considered decisions. DECISIONS §45, and §50 for the judgement refusal the original '
  'comment claimed but never performed.';
