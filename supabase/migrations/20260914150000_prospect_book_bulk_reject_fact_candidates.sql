-- WLIQ Prospect Book — rejecting a batch of fact candidates in one decision.
--
-- `pb_review_fact_candidate` takes one candidate at a time, which is right for confirming:
-- writing a fact is a claim about the world and deserves its own look. Rejecting is not
-- symmetrical. When an extractor proposes a value the book cannot hold — 17 `reseller` and 3
-- `referral` rows for `relationship_type` on 14 Sep 2026, from a prompt fixed in e053ff7 — the
-- reader is not making twenty judgements. They are making one, twenty times, and the queue
-- grows about twenty rows a night while they do it.
--
-- So: a bulk path, and **only for rejection**. There is deliberately no bulk confirm here and
-- there should never be one. Rule 8 is that nothing a machine read becomes a fact on a
-- machine's say-so; a button that writes a hundred facts from one click is exactly the thing
-- that rule exists to refuse. Rejecting writes no fact, so the same argument does not apply in
-- reverse — the worst a wrong rejection does is close a proposal the sweep will offer again.
--
-- What this keeps from the single-candidate path, on purpose:
--   · the same lane check — owner and rater only, and only from `proposed`;
--   · ONE REGISTER ROW PER CANDIDATE, not one for the batch. A person deciding what the book
--     believes is a decision, and the register is where decisions live. Deciding twenty at
--     once makes the clicking cheaper; it does not make the record thinner. Each row carries
--     `batch_size` and a shared `batch_id` so the register can still say these went together.
--
-- What it does NOT do:
--   · supersede other proposals. Confirming a candidate answers the (account, key) question
--     and closes its rivals; rejecting one answers nothing, so its rivals stay open.
--   · fail the whole batch over a stale row. A candidate someone else already decided is
--     skipped and reported, not raised — in a batch assembled a minute ago that is a race,
--     not an error, and refusing 200 good rejections over it would be the wrong trade.

create or replace function public.pb_reject_fact_candidates(
  p_candidates uuid[],
  p_note       text default null
)
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
  v_rejected   int   := 0;
  v_skipped    int   := 0;
  v_keys       jsonb := '{}'::jsonb;
begin
  if not public.pb_is_wliq() then
    raise exception 'not a WLIQ member';
  end if;
  if v_role is distinct from 'owner' and v_role is distinct from 'rater' then
    raise exception 'the % lane may not review fact candidates', coalesce(v_role, 'unknown');
  end if;
  if p_candidates is null or cardinality(p_candidates) = 0 then
    raise exception 'no candidates named';
  end if;

  -- Deduplicate and strip nulls: the same id twice is one decision, not two register rows.
  select array_agg(distinct x) into v_ids from unnest(p_candidates) as x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'no candidates named';
  end if;
  -- A ceiling well above the whole queue: high enough never to block real work, low enough
  -- that a malformed caller cannot walk the table.
  if cardinality(v_ids) > 1000 then
    raise exception 'that is % candidates; reject at most 1000 in one decision', cardinality(v_ids);
  end if;

  for c in
    select * from public.pb_fact_candidates
     where id = any(v_ids)
     order by id
       for update
  loop
    if c.status <> 'proposed' then
      continue;
    end if;

    update public.pb_fact_candidates
       set status      = 'rejected',
           reviewed_by = v_me,
           reviewed_at = now(),
           note        = coalesce(p_note, pb_fact_candidates.note)
     where id = c.id;

    insert into public.pb_register (kind, account_id, made_by, text, payload)
    values (
      'note', c.account_id, v_me,
      v_me || ' rejected a ' || c.source || ' claim about ' || c.key || '; nothing was written.',
      jsonb_build_object(
        'candidate_id', c.id, 'key', c.key, 'value', c.value, 'decision', 'rejected',
        'extractor', c.extractor, 'source_id', c.source_id, 'fact_id', null,
        'superseded', 0, 'reviewer_note', p_note,
        'batch_id', v_batch, 'batch_size', cardinality(v_ids)
      )
    );

    v_rejected := v_rejected + 1;
    v_keys := jsonb_set(v_keys, array[c.key], to_jsonb(coalesce((v_keys ->> c.key)::int, 0) + 1), true);
  end loop;

  -- Anything named and not rejected was skipped: already decided by someone else, or never a
  -- candidate id at all. The caller is told the number either way — a batch that silently did
  -- less than it was asked to is the failure mode worth reporting.
  v_skipped := cardinality(v_ids) - v_rejected;

  return jsonb_build_object(
    'ok', true, 'decision', 'rejected', 'batch_id', v_batch,
    'named', cardinality(v_ids), 'rejected', v_rejected, 'skipped', v_skipped,
    'keys', v_keys
  );
end $function$;

revoke all on function public.pb_reject_fact_candidates(uuid[], text) from public, anon;
grant execute on function public.pb_reject_fact_candidates(uuid[], text) to authenticated;
