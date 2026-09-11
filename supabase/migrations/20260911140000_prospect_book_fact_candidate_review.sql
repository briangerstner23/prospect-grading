-- WLIQ Prospect Book — carrying a fact-candidate review through.
--
-- pb_review_candidate does this for identity (rule 8). A claim read out of a note is the same
-- problem, so it gets the same shape: the page states a decision, the DATABASE performs it,
-- and the whole thing is one transaction. The page never writes a fact and then updates a
-- status and hopes both landed.
--
-- Confirming a candidate:
--   · writes the fact, labelled `evidence`, entered_by the reviewer, dated by the NOTE
--     (observed_at), with the verbatim quote and a link back to the source in the note field;
--   · closes every other proposed candidate for the same (account, key) as `superseded` —
--     answering the question closes it, rather than leaving stale proposals behind;
--   · marks the candidate confirmed, by whom and when.
--
-- Rejecting writes no fact. Either way a `note` row lands in the register, because a person
-- deciding what the book believes is a decision and the register is where decisions live.
--
-- Owner and rater lanes only, and only from `proposed` — a decision already made is not
-- re-made silently. The immutability trigger still guards the proposal itself.

create or replace function public.pb_review_fact_candidate(
  p_candidate uuid,
  p_decision  text,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  c            record;
  v_me         text := public.pb_me();
  v_role       text := public.pb_role();
  v_fact_id    uuid := null;
  v_superseded int  := 0;
begin
  if not public.pb_is_wliq() then
    raise exception 'not a WLIQ member';
  end if;
  if v_role is distinct from 'owner' and v_role is distinct from 'rater' then
    raise exception 'the % lane may not review fact candidates', coalesce(v_role, 'unknown');
  end if;
  if p_decision not in ('confirmed', 'rejected') then
    raise exception 'decision must be confirmed or rejected, not %', p_decision;
  end if;

  select * into c from public.pb_fact_candidates where id = p_candidate for update;
  if not found then
    raise exception 'no such fact candidate';
  end if;
  if c.status <> 'proposed' then
    raise exception 'that candidate was already %; it is not re-reviewed', c.status;
  end if;

  if p_decision = 'confirmed' then
    insert into public.pb_facts
      (account_id, key, value, evidence_label, source, evidence_url, note, observed_at, entered_by, stand_in)
    values (
      c.account_id, c.key, c.value, 'evidence', c.source, c.evidence_url,
      case when c.quote is null
        then 'Confirmed from ' || c.source || ' by ' || v_me
        else '"' || c.quote || '" — confirmed from ' || c.source || ' by ' || v_me
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
    get diagnostics v_superseded = row_count;
  end if;

  update public.pb_fact_candidates
     set status = p_decision,
         reviewed_by = v_me,
         reviewed_at = now(),
         note = coalesce(p_note, pb_fact_candidates.note)
   where id = p_candidate;

  insert into public.pb_register (kind, account_id, made_by, text, payload)
  values (
    'note', c.account_id, v_me,
    case p_decision
      when 'confirmed' then v_me || ' confirmed ' || c.key || ' from a ' || c.source || ' claim and it is now a fact.'
      else v_me || ' rejected a ' || c.source || ' claim about ' || c.key || '; nothing was written.'
    end,
    jsonb_build_object(
      'candidate_id', c.id, 'key', c.key, 'value', c.value, 'decision', p_decision,
      'extractor', c.extractor, 'source_id', c.source_id, 'fact_id', v_fact_id,
      'superseded', v_superseded, 'reviewer_note', p_note
    )
  );

  return jsonb_build_object(
    'ok', true, 'decision', p_decision, 'key', c.key, 'account_id', c.account_id,
    'fact_id', v_fact_id, 'superseded', v_superseded
  );
end $function$;

revoke all on function public.pb_review_fact_candidate(uuid, text, text) from public, anon;
grant execute on function public.pb_review_fact_candidate(uuid, text, text) to authenticated;
