-- Restoring §51, which §50 destroyed by accident. This is a repair, not a new idea.
--
-- 20260917233850 (prospect_book_confirm_corroborated, DECISIONS §51) rewrote
-- pb_confirm_fact_candidates around five named rules: already_evidenced closes a claim the book
-- already holds as evidence rather than writing a second row, corroborates_what_is_held upgrades an
-- inferred value that now has a sentence behind it, high_and_unheld is §45's original class, and
-- second_independent_source admits a medium claim when another record FROM A DIFFERENT SOURCE says
-- the same thing with its own quote.
--
-- On 18 Sep 20260918111608 replaced that function wholesale. It was built by copying the 17 Sep
-- 290000 file and adding one `elsif`, and it went out three hours after §51 landed without anyone
-- checking whether the file it was copied from was still what was running. It parsed, it applied,
-- it reported success, and it silently deleted four of the five rules. Nothing in the queue screen
-- would have looked wrong: the button still worked, it just quietly refused everything it used to
-- settle by corroboration.
--
-- That is the same failure as the v7 placeholder deploy on 16 Sep, in a different costume: a
-- `create or replace` is a whole-object write, and writing one from a file is only safe if the file
-- is the current definition. The database was the record and the file was not.
--
-- This restores §51's function EXACTLY, with one addition, stated rather than smuggled:
--
--   high_and_unheld now refuses an explicit `kind = 'judgement'`.
--
-- §51 requires kind = observation on both corroboration rules and deliberately leaves high_and_unheld
-- on §45's terms, where kind was never consulted. But a claim the extractor itself labelled an
-- assessment is what written_record.ts rule 3 exists to stop, and eleven of them were sitting inside
-- that branch. A NULL kind still passes there, as it always has — absent is not the same as stated,
-- and narrowing that too would empty the rule rather than sharpen it.
--
-- What is NOT copied across from §50: the source gate. §50 refuses the website reader on its own
-- say-so because four of ten of its high-confidence claims were inferences wearing a quote — but
-- that gate exists to bound what the book does UNATTENDED at 06:00. This button is a person
-- selecting rows and clicking. Narrowing a human decision with a rule written for a robot would be
-- taking the owner's judgement away in the name of protecting it.

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
  v_closed     int   := 0;
  v_cur        record;
  v_held       boolean;
  v_fact_id    uuid;
  v_superseded int   := 0;
  v_sup        int   := 0;
  v_skip       jsonb := '{}'::jsonb;
  v_acc        jsonb := '{}'::jsonb;
  v_keys       jsonb := '{}'::jsonb;
  v_rules      jsonb := '{}'::jsonb;
  a            record;

  v_rule         text;
  procedure_skip text;
begin
  if not public.pb_is_wliq() then
    raise exception 'not a WLIQ member';
  end if;
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
    v_rule         := null;
    v_held         := false;

    if c.status <> 'proposed' then
      procedure_skip := 'already ' || c.status;
    elsif c.quote is null or length(btrim(c.quote)) = 0 then
      procedure_skip := 'no quote in the source — answer it one at a time';
    end if;

    if procedure_skip is null then
      select f.value, f.source, f.evidence_label into v_cur
        from public.pb_current_facts f
       where f.account_id = c.account_id and f.key = c.key;
      v_held := found;

      if v_held and v_cur.value is distinct from c.value then
        procedure_skip := 'disagrees with what ' || coalesce(v_cur.source, 'the book') || ' holds — answer it one at a time';

      elsif v_held then
        if c.kind is distinct from 'observation' then
          procedure_skip := case
            when c.kind = 'judgement' then 'the sentence behind it is an assessment — answer it one at a time'
            else 'nothing recorded whether its sentence is checkable — answer it one at a time'
          end;
        elsif v_cur.evidence_label = 'evidence' then
          v_rule := 'already_evidenced';
        else
          v_rule := 'corroborates_what_is_held';
        end if;

      elsif coalesce(c.confidence, '') = 'high' then
        -- Added by the repair: §45 never consulted kind here and eleven claims the extractor had
        -- explicitly called an assessment were inside this branch. A null kind still passes —
        -- unstated is not the same as stated, and refusing it would empty the rule.
        if c.kind = 'judgement' then
          procedure_skip := 'the sentence behind it is an assessment — answer it one at a time';
        else
          v_rule := 'high_and_unheld';
        end if;

      else
        if c.kind is distinct from 'observation' then
          procedure_skip := case
            when c.kind = 'judgement' then 'the sentence behind it is an assessment — answer it one at a time'
            else 'confidence ' || coalesce(c.confidence, 'unstated') || ' and nothing recorded whether its sentence is checkable — answer it one at a time'
          end;
        elsif exists (
          select 1
            from public.pb_fact_candidates o
           where o.account_id = c.account_id
             and o.key        = c.key
             and o.id        <> c.id
             and o.source    <> c.source
             and o.value      = c.value
             and o.kind       = 'observation'
             and o.quote is not null and length(btrim(o.quote)) > 0
             and o.status in ('proposed', 'confirmed')
        ) then
          v_rule := 'second_independent_source';
        else
          procedure_skip := 'confidence ' || coalesce(c.confidence, 'unstated') ||
                            ' and nothing else on record says the same — answer it one at a time';
        end if;
      end if;
    end if;

    if procedure_skip is not null then
      v_skip := jsonb_set(v_skip, array[procedure_skip],
                          to_jsonb(coalesce((v_skip ->> procedure_skip)::int, 0) + 1), true);
      continue;
    end if;

    v_rules := jsonb_set(v_rules, array[v_rule], to_jsonb(coalesce((v_rules ->> v_rule)::int, 0) + 1), true);

    if v_rule = 'already_evidenced' then
      update public.pb_fact_candidates
         set status = 'superseded',
             reviewed_by = v_me,
             reviewed_at = now(),
             note = coalesce(pb_fact_candidates.note, '') ||
                    ' [closed in a bulk review: the book already holds ' || c.key ||
                    ' at this value, as evidence from ' || coalesce(v_cur.source, 'another record') ||
                    '. Nothing to add.]'
       where id = c.id;
      v_closed := v_closed + 1;
      v_acc := jsonb_set(v_acc, array[c.account_id::text],
                         to_jsonb(coalesce((v_acc ->> c.account_id::text)::int, 0) + 1), true);
      continue;
    end if;

    insert into public.pb_facts
      (account_id, key, value, evidence_label, source, evidence_url, note, observed_at, entered_by, stand_in)
    values (
      c.account_id, c.key, c.value, 'evidence', c.source, c.evidence_url,
      '"' || c.quote || '" — confirmed from ' || c.source || ' by ' || v_me ||
        ' in a bulk review of ' || cardinality(v_ids) || ' claims (batch ' || v_batch || '), under "' ||
        v_rule || '"' ||
        case
          when v_rule = 'corroborates_what_is_held'
            then ': the book already held this value as ' || coalesce(v_cur.evidence_label, 'unknown') ||
                 ' from ' || coalesce(v_cur.source, 'another record') || '; this is the same answer with a sentence behind it'
          when v_rule = 'second_independent_source'
            then ': another record, from a different source, says the same'
          else ''
        end,
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

  for a in select k::uuid as account_id, v::int as n from jsonb_each_text(v_acc) as e(k, v)
  loop
    insert into public.pb_register (kind, account_id, made_by, text, payload)
    values (
      'note', a.account_id, v_me,
      v_me || ' settled ' || a.n || ' machine-read claim' || case when a.n = 1 then '' else 's' end ||
      ' here in a bulk review of ' || cardinality(v_ids) || ', limited to claims that are either ' ||
      'rated high with a quote on a key the book held nothing for, or corroborated — by a value ' ||
      'the book already holds, or by a second record from a different source saying the same.',
      jsonb_build_object(
        'decision', 'confirmed', 'bulk', true, 'batch_id', v_batch,
        'batch_size', cardinality(v_ids), 'settled_here', a.n,
        'rules', v_rules, 'reviewer_note', p_note
      )
    );
  end loop;

  return jsonb_build_object(
    'ok', true, 'decision', 'confirmed', 'bulk', true, 'batch_id', v_batch,
    'named', cardinality(v_ids), 'confirmed', v_confirmed,
    'closed_nothing_to_add', v_closed,
    'skipped', cardinality(v_ids) - v_confirmed - v_closed, 'skipped_why', v_skip,
    'by_rule', v_rules,
    'superseded', v_superseded, 'accounts', (select count(*) from jsonb_object_keys(v_acc)),
    'keys', v_keys
  );
end $function$;

revoke all on function public.pb_confirm_fact_candidates(uuid[], text) from public, anon;
grant execute on function public.pb_confirm_fact_candidates(uuid[], text) to authenticated, service_role;

comment on function public.pb_confirm_fact_candidates(uuid[], text) is
  'Confirm fact candidates in bulk — owner lane only, and only where a reviewer reading the '
  'sentence has nothing to weigh. Three classes, each named in the return and in the fact''s own '
  'note: high_and_unheld (DECISIONS §45 — rated high, quoted, the book holds nothing for that '
  'key, and not a sentence the extractor called an assessment); corroborates_what_is_held (the '
  'book already holds this exact value as inferred — same answer, now with a sentence behind it); '
  'second_independent_source (another candidate, from a DIFFERENT source, claims the same value '
  'with its own quote). A candidate matching a value the book already holds as evidence is CLOSED, '
  'not written: a second evidence row adds nothing rule 9 would consult. The two corroboration '
  'classes require kind = observation explicitly — a NULL kind means the producer never said, and '
  'rule 5 makes unknown never evidence. A quote is the floor for all three. Disagreement with what '
  'is on file is always refused here, not in the page, and is re-derived against pb_current_facts '
  'at confirm time. DECISIONS §45, §51, and §50 for the judgement refusal on high_and_unheld and '
  'for the restore after §50''s own migration overwrote this function.';
