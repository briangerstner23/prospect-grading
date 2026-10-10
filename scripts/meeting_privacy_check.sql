-- WLIQ Prospect Book — the sales-meeting reader's operator harness (DECISIONS §65).
--
-- Run it through execute_sql RIGHT AFTER migration A (prospect_book_sales_meeting_reader) applies,
-- and again after any change to pb_dossier(), pb_board() or the six meeting functions. It runs inside
-- BEGIN … ROLLBACK and leaves nothing behind: every member, account, meeting, proposal, fact,
-- candidate and register row it makes is synthetic and is rolled back. It RAISES on the first leak or
-- missing refusal; success is the absence of an exception (and the NOTICE lines).
--
-- What it proves, in order:
--   1. Lanes. As a synthetic rater: approving a tier call, approving a removal, and a removal carrying
--      expires_at are refused. A viewer and a non-WLIQ address are refused outright.
--   2. Rules, as a synthetic owner: an override with no written reason, with an unknown reason code,
--      at the computed tier, or on an account with no computed tier is refused; a removal carrying an
--      expiry is refused by pb_register_removal_guard; a fact that disagrees with a person's value is
--      refused without overrule; a card spanning two agencies is refused; an unplaced name cannot be
--      decided.
--   3. Writes. A rater's fact-and-read card lands (pb_facts with source sales_meeting, no quote and no
--      link; the waiting machine candidate on that key superseded; origin-tagged register notes). The
--      owner's card lands the overruling fact, the override (expiry = today + the rubric's
--      expiry_default_days), the removal (no expiry) and a read; the removed agency leaves pb_board().
--   4. Placement: assign remembers the name, unassign forgets it.
--   5. As `authenticated`: a hand insert cannot pose as a meeting fact; a rater reads the proposals,
--      a viewer reads none of them; nobody updates them directly.
--   6. As `anon`: pb_dossier() and pb_board() carry none of the quotes, the override text, the read,
--      the meeting link or the literal 'sales_meeting'; the four tables are denied; the decide function
--      is denied.
--   7. Invariants: zero pb_fact_candidates rows with source 'sales_meeting'; the lanes view count is
--      back where it started.
--
-- It reads ONE live account as the test subject (a prospect with a computed tier, on the board, not
-- removed), chosen by query; its name never appears here and nothing about it survives the rollback.
-- Rule 2: every literal in this file is synthetic.

begin;

insert into public.pb_members (email, display_name, role, active) values
  ('harness-owner@whitelabeliq.com',  'Harness owner',  'owner',  true),
  ('harness-rater@whitelabeliq.com',  'Harness rater',  'rater',  true),
  ('harness-viewer@whitelabeliq.com', 'Harness viewer', 'viewer', true)
on conflict (email) do nothing;

do $harness$
declare
  v_marker  text := replace(gen_random_uuid()::text, '-', '');
  v_owner   constant text := 'harness-owner@whitelabeliq.com';
  v_rater   constant text := 'harness-rater@whitelabeliq.com';
  v_viewer  constant text := 'harness-viewer@whitelabeliq.com';
  v_spec    jsonb;
  v_a       uuid;      -- a live prospect with a computed tier (read only; everything rolls back)
  v_b       uuid;      -- a synthetic prospect with no read
  v_ctier   text;
  v_etier   text;
  v_tier    text;
  v_rec     text;
  v_url     text;
  v_lanes0  bigint;
  v_cand    uuid;
  p_fact1   uuid; p_read1 uuid; p_read2 uuid; p_over uuid; p_over_same uuid; p_rem uuid;
  p_fact2   uuid; p_over_b uuid; p_fact_b uuid; p_unplaced uuid;
  q         text[];
  v_r       jsonb;
  v_fail    text;
  v_n       bigint;
  v_days    numeric;
  v_exp     timestamptz;
begin
  select r.spec into v_spec from public.pb_rubric_versions r
   where r.status = 'active' order by r.activated_at desc nulls last limit 1;
  v_days := (v_spec->'override'->>'expiry_default_days')::numeric;

  select r.account_id, r.computed_tier, r.effective_tier into v_a, v_ctier, v_etier
    from public.pb_current_reads r
    join public.pb_accounts a on a.id = r.account_id
   where a.book = 'prospect' and r.computed_tier is not null
     and not exists (select 1 from public.pb_removals x where x.account_id = r.account_id)
     and r.account_id in (select b.account_id from public.pb_board() b)
   order by r.account_id
   limit 1;
  if v_a is null then
    raise exception 'HARNESS: no prospect with a computed tier on the board to test against';
  end if;
  select t into v_tier from jsonb_array_elements_text(v_spec->'vocabulary'->'tiers') t
   where lower(t) <> lower(v_ctier) and lower(t) <> lower(coalesce(v_etier, '')) limit 1;
  if v_tier is null then
    raise exception 'HARNESS: the vocabulary offers no tier other than the computed and effective ones';
  end if;

  insert into public.pb_accounts (key, name, book)
  values ('harness:' || v_marker, 'Harness account ' || v_marker, 'prospect') returning id into v_b;

  select count(*) into v_lanes0 from public.pb_fact_candidate_lanes;

  -- A person's value on one synthetic key; a machine claim waiting on another. Synthetic keys, so no
  -- real fact of the subject account can interfere, and pb-score never sees them (rollback).
  insert into public.pb_facts (account_id, key, value, evidence_label, source, observed_at, entered_by, note)
  values (v_a, 'harness_k2', '30000'::jsonb, 'evidence', 'rater', current_date, v_owner, 'harness');
  insert into public.pb_fact_candidates (account_id, key, value, evidence_label, source, quote, extractor, fingerprint, status)
  values (v_a, 'harness_k1', '7'::jsonb, 'inferred', 'website', 'a harness sentence from a website',
          'harness', 'harness:' || v_marker || ':k1', 'proposed')
  returning id into v_cand;

  v_rec := 'harness-' || v_marker;
  v_url := 'https://fathom.video/calls/harness-' || v_marker;
  insert into public.pb_meetings (recording_id, inbox_id, title, title_norm, held_at, ended_at, url, include,
                                  selected_by, status, read_at)
  values (v_rec, gen_random_uuid(), 'Harness sales connect', 'harness sales connect', now() - interval '1 hour',
          now(), v_url, true, 'owner', 'read', now());

  q := array[
    'harness quote one ' || v_marker || ' they ship about twelve builds a quarter',
    'harness quote two ' || v_marker || ' price was the sticking point last time',
    'harness quote three ' || v_marker || ' honestly they are a ' || v_tier || ' for us',
    'harness quote four ' || v_marker || ' they are too small, take them off',
    'harness quote five ' || v_marker || ' their average project is fifty thousand',
    'harness quote six ' || v_marker || ' the other one is a ' || v_tier || ' too',
    'harness quote seven ' || v_marker || ' they have three builds open',
    'harness quote eight ' || v_marker || ' they really are a ' || v_ctier,
    'harness quote nine ' || v_marker || ' they want to start in the new year',
    'harness quote ten ' || v_marker || ' somebody nobody could place'];

  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, tier, reason_code,
     disposition, topic, quote, line_from, line_to, quote_at, speaker, mode, held_on, default_text, extractor,
     fingerprint, status)
  values
    (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'fact', 'harness_k1', '12'::jsonb, null, null,
     null, null, q[1], 10, 10, '00:01:00', 'S1', 'asserted', current_date, null, 'harness', 'h1:' || v_marker, 'proposed')
  returning id into p_fact1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, topic, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'read', 'price', q[2], 11, 11, '00:01:10',
          'S2', 'asserted', current_date, null, 'harness', 'h2:' || v_marker, 'proposed')
  returning id into p_read1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, topic, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'read', 'timing', q[9], 19, 19, '00:02:30',
          'S2', 'asserted', current_date, null, 'harness', 'h9:' || v_marker, 'proposed')
  returning id into p_read2;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          q[3], 12, 12, '00:01:20', 'S1', 'asserted', current_date,
          '"' || q[3] || '" — Harness sales connect, ' || current_date || ' 00:01:20', 'harness', 'h3:' || v_marker, 'proposed')
  returning id into p_over;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          q[8], 18, 18, '00:02:20', 'S1', 'asserted', current_date, '"' || q[8] || '" — harness', 'harness',
          'h8:' || v_marker, 'proposed')
  returning id into p_over_same;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, reason_code, disposition, quote,
     line_from, line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'removal', 'too_small', 'unqualified', q[4],
          13, 13, '00:01:30', 'S1', 'asserted', current_date, '"' || q[4] || '" — sales meeting ' || current_date,
          'harness', 'h4:' || v_marker, 'proposed')
  returning id into p_rem;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'fact', 'harness_k2', '50000'::jsonb, q[5],
          14, 14, '00:01:40', 'S1', 'asserted', current_date, 'harness', 'h5:' || v_marker, 'proposed')
  returning id into p_fact2;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_b, array['harness b'], 'harness b', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          q[6], 15, 15, '00:01:50', 'S2', 'asserted', current_date, '"' || q[6] || '" — harness', 'harness',
          'h6:' || v_marker, 'proposed')
  returning id into p_over_b;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, v_b, array['harness b'], 'harness b', 'resolved', 'name', 'fact', 'harness_k1', '3'::jsonb, q[7],
          16, 16, '00:02:00', 'S2', 'asserted', current_date, 'harness', 'h7:' || v_marker, 'proposed')
  returning id into p_fact_b;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, options, kind, key, value, quote,
     line_from, line_to, quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, null, array['harness c'], 'harness c', 'suggested', 'token', array[v_a], 'fact', 'harness_k3',
          '1'::jsonb, q[10], 17, 17, '00:02:10', 'S3', 'asserted', current_date, 'harness', 'h10:' || v_marker, 'proposed')
  returning id into p_unplaced;

  -- 1 · lanes ----------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('email', v_rater, 'role', 'authenticated')::text, true);
  v_fail := null;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over, 'decision', 'approve')));
    v_fail := 'a rater approved a tier call';
  exception when others then
    if sqlerrm not like '%owner%' then v_fail := 'rater tier call refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 1a: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_rem, 'decision', 'approve')));
    v_fail := 'a rater approved a removal';
  exception when others then
    if sqlerrm not like '%owner%' then v_fail := 'rater removal refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 1b: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_rem, 'decision', 'approve',
              'edit', jsonb_build_object('expires_at', now() + interval '30 days'))));
    v_fail := 'a rater approved a removal carrying an expiry';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1c: %', v_fail; end if;
  begin
    perform public.pb_meeting_include(v_rec, false);
    v_fail := 'a rater changed which meetings are read';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1d: %', v_fail; end if;
  begin
    perform public.pb_meeting_title_rule('harness title ' || v_marker, true);
    v_fail := 'a rater set a title rule';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1e: %', v_fail; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_fact1, 'decision', 'approve')));
    v_fail := 'a viewer decided a card';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1f: %', v_fail; end if;
  begin
    perform public.pb_dismiss_meeting(v_rec, null);
    v_fail := 'a viewer dismissed a meeting';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1g: %', v_fail; end if;
  begin
    perform public.pb_assign_meeting_mention(v_rec, 'harness c', 'assign', v_a, true);
    v_fail := 'a viewer placed a name';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 1h: %', v_fail; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('email', 'someone@example.com', 'role', 'authenticated')::text, true);
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_fact1, 'decision', 'reject')));
    v_fail := 'an address outside WLIQ decided a card';
  exception when others then
    if sqlerrm not like '%WLIQ%' then v_fail := 'outside address refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 1i: %', v_fail; end if;

  -- 2 · rules, as the owner ----------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('email', v_owner, 'role', 'authenticated')::text, true);
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over, 'decision', 'approve',
              'edit', jsonb_build_object('text', '   '))));
    v_fail := 'an override with no written reason was approved';
  exception when others then
    if sqlerrm not like '%written reason%' then v_fail := 'no-reason override refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2a: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over, 'decision', 'approve',
              'edit', jsonb_build_object('reason_code', 'not_a_code'))));
    v_fail := 'an override with an unknown reason code was approved';
  exception when others then
    if sqlerrm not like '%reason code%' then v_fail := 'unknown code refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2b: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over_same, 'decision', 'approve')));
    v_fail := 'an override to the computed tier was approved';
  exception when others then
    if sqlerrm not like '%computed tier%' then v_fail := 'computed-tier override refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2c: %', v_fail; end if;
  -- Out of the way, so it cannot supersede the real tier call when the next approval runs.
  perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over_same, 'decision', 'reject')));
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over_b, 'decision', 'approve')));
    v_fail := 'an override on an account with no computed tier was approved';
  exception when others then
    if sqlerrm not like '%computed tier%' then v_fail := 'no-read override refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2d: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_rem, 'decision', 'approve',
              'edit', jsonb_build_object('expires_at', now() + interval '30 days'))));
    v_fail := 'a removal carrying an expiry was approved';
  exception when others then
    if sqlerrm not like '%never expires%' then v_fail := 'expiring removal refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2e: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_fact2, 'decision', 'approve')));
    v_fail := 'a fact overruling a person was approved without overrule';
  exception when others then
    if sqlerrm not like '%differs from what a person recorded%' then v_fail := 'conflict refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2f: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(
      jsonb_build_object('id', p_fact1, 'decision', 'approve'),
      jsonb_build_object('id', p_fact_b, 'decision', 'approve')));
    v_fail := 'a card spanning two agencies was decided';
  exception when others then
    if sqlerrm not like '%one agency%' then v_fail := 'mixed card refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2g: %', v_fail; end if;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_unplaced, 'decision', 'approve')));
    v_fail := 'an unplaced name was decided';
  exception when others then
    if sqlerrm not like '%place this name first%' then v_fail := 'unplaced row refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2h: %', v_fail; end if;

  -- 3 · writes ---------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('email', v_rater, 'role', 'authenticated')::text, true);
  v_r := public.pb_decide_meeting_card(jsonb_build_array(
           jsonb_build_object('id', p_fact1, 'decision', 'approve'),
           jsonb_build_object('id', p_read1, 'decision', 'approve')), 'harness');
  if (v_r->>'facts')::int <> 1 or (v_r->>'reads')::int <> 1 or (v_r->>'candidates_closed')::int <> 1 then
    raise exception 'HARNESS 3a: the rater''s fact-and-read card returned %', v_r;
  end if;
  select count(*) into v_n from public.pb_facts
   where account_id = v_a and key = 'harness_k1' and source = 'sales_meeting' and meeting_proposal_id = p_fact1
     and evidence_label = 'evidence' and evidence_url is null and entered_by = v_rater
     and position(q[1] in coalesce(note, '')) = 0;
  if v_n <> 1 then raise exception 'HARNESS 3b: the approved fact is not the expected sales_meeting row (% found)', v_n; end if;
  if (select status from public.pb_fact_candidates where id = v_cand) <> 'superseded' then
    raise exception 'HARNESS 3c: the machine candidate on the approved key was not closed';
  end if;
  select count(*) into v_n from public.pb_register
   where account_id = v_a and payload->>'origin' = 'sales_meeting' and kind = 'note';
  if v_n <> 2 then raise exception 'HARNESS 3d: expected 2 origin-tagged register notes, found %', v_n; end if;
  if (select status from public.pb_meeting_proposals where id = p_fact1) <> 'approved'
     or (select result_id from public.pb_meeting_proposals where id = p_fact1) is null then
    raise exception 'HARNESS 3e: the approved proposal does not record its result';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('email', v_owner, 'role', 'authenticated')::text, true);
  v_r := public.pb_decide_meeting_card(jsonb_build_array(
           jsonb_build_object('id', p_fact2, 'decision', 'approve', 'overrule', true),
           jsonb_build_object('id', p_over, 'decision', 'approve'),
           jsonb_build_object('id', p_rem, 'decision', 'approve'),
           jsonb_build_object('id', p_read2, 'decision', 'approve')), 'harness');
  if (v_r->>'facts')::int <> 1 or (v_r->>'overrides')::int <> 1 or (v_r->>'removals')::int <> 1
     or (v_r->>'reads')::int <> 1 or (v_r->>'approved')::int <> 4 then
    raise exception 'HARNESS 3f: the owner''s card returned %', v_r;
  end if;
  select g.expires_at into v_exp from public.pb_register g
   where g.account_id = v_a and g.kind = 'override' and g.payload->>'proposal_id' = p_over::text;
  if v_exp is null or abs(extract(epoch from (v_exp - (now() + v_days::double precision * interval '1 day')))) > 60 then
    raise exception 'HARNESS 3g: the override''s expiry % is not today + the rubric''s % days', v_exp, v_days;
  end if;
  if exists (select 1 from public.pb_register g where g.account_id = v_a and g.kind = 'removal'
              and g.payload->>'proposal_id' = p_rem::text and g.expires_at is not null) then
    raise exception 'HARNESS 3h: the removal carries an expiry';
  end if;
  if not exists (select 1 from public.pb_removals x where x.account_id = v_a) then
    raise exception 'HARNESS 3i: the approved removal is not in pb_removals';
  end if;
  if exists (select 1 from public.pb_board() b where b.account_id = v_a) then
    raise exception 'HARNESS 3j: the removed agency is still on pb_board()';
  end if;

  -- 4 · placement ------------------------------------------------------------------------------
  v_r := public.pb_assign_meeting_mention(v_rec, 'harness c', 'assign', v_b, true);
  if (v_r->>'rows')::int <> 1 or not exists (select 1 from public.pb_meeting_aliases
                                              where said_key = 'harness c' and account_id = v_b and active) then
    raise exception 'HARNESS 4a: assign did not place and remember the name (%)', v_r;
  end if;
  v_r := public.pb_assign_meeting_mention(v_rec, 'harness c', 'unassign', null, true);
  if (v_r->>'rows')::int <> 1 or exists (select 1 from public.pb_meeting_aliases
                                          where said_key = 'harness c' and account_id = v_b and active)
     or (select account_id from public.pb_meeting_proposals where id = p_unplaced) is not null then
    raise exception 'HARNESS 4b: unassign did not send the name back and forget it (%)', v_r;
  end if;

  -- 7 · invariants -----------------------------------------------------------------------------
  if exists (select 1 from public.pb_fact_candidates where source = 'sales_meeting') then
    raise exception 'HARNESS 7a: a pb_fact_candidates row carries source sales_meeting';
  end if;
  select count(*) into v_n from public.pb_fact_candidate_lanes;
  if v_n <> v_lanes0 then
    raise exception 'HARNESS 7b: the lanes view held % rows before and % after', v_lanes0, v_n;
  end if;

  -- for the role sections below (custom settings are readable by every role)
  perform set_config('harness.a', v_a::text, true);
  perform set_config('harness.rec', v_rec, true);
  perform set_config('harness.url', v_url, true);
  perform set_config('harness.p_fact1', p_fact1::text, true);
  perform set_config('harness.p_over', p_over::text, true);
  perform set_config('harness.needles', array_to_string(q || array[
      (select g.text from public.pb_register g where g.kind = 'override' and g.payload->>'proposal_id' = p_over::text),
      (select g.text from public.pb_register g where g.kind = 'note' and g.payload->>'proposal_id' = p_read1::text)],
    '|'), true);
  perform set_config('request.jwt.claims', '', true);
  raise notice 'meeting_privacy_check: lanes, rules, writes, placement and invariants hold';
end
$harness$;

-- 5 · as authenticated ---------------------------------------------------------------------------
set local role authenticated;
do $auth$
declare
  v_fail text := null;
  v_n    bigint;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('email', 'harness-rater@whitelabeliq.com', 'role', 'authenticated')::text, true);
  begin
    insert into public.pb_facts (account_id, key, value, evidence_label, source, entered_by, meeting_proposal_id)
    values (current_setting('harness.a')::uuid, 'harness_k4', '1'::jsonb, 'evidence', 'sales_meeting',
            'harness-rater@whitelabeliq.com', current_setting('harness.p_fact1')::uuid);
    v_fail := 'a hand insert posed as a meeting fact';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 5a: %', v_fail; end if;
  begin
    insert into public.pb_facts (account_id, key, value, evidence_label, source, entered_by, meeting_proposal_id)
    values (current_setting('harness.a')::uuid, 'harness_k4', '1'::jsonb, 'evidence', 'rater',
            'harness-rater@whitelabeliq.com', current_setting('harness.p_fact1')::uuid);
    v_fail := 'a hand insert carried a meeting_proposal_id';
  exception when others then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 5b: %', v_fail; end if;
  select count(*) into v_n from public.pb_meeting_proposals where recording_id = current_setting('harness.rec');
  if v_n = 0 then raise exception 'HARNESS 5c: a rater cannot read the proposals'; end if;
  begin
    update public.pb_meeting_proposals set status = 'approved' where id = current_setting('harness.p_over')::uuid;
    v_fail := 'a signed-in user updated a proposal directly';
  exception when insufficient_privilege then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 5d: %', v_fail; end if;

  perform set_config('request.jwt.claims',
    jsonb_build_object('email', 'harness-viewer@whitelabeliq.com', 'role', 'authenticated')::text, true);
  select (select count(*) from public.pb_meeting_proposals) + (select count(*) from public.pb_meetings)
       + (select count(*) from public.pb_meeting_aliases) + (select count(*) from public.pb_meeting_title_rules)
    into v_n;
  if v_n <> 0 then raise exception 'HARNESS 5e: a viewer reads % meeting rows', v_n; end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'meeting_privacy_check: authenticated holds what it should and no more';
end
$auth$;
reset role;

-- 6 · as anon -----------------------------------------------------------------------------------
set local role anon;
do $anon$
declare
  v_doc   text;
  v_board text;
  v_n     text;
  v_t     text;
  v_fail  text := null;
begin
  v_doc := public.pb_dossier(current_setting('harness.a')::uuid)::text;
  select coalesce(string_agg(b::text, ' '), '') into v_board from public.pb_board() b;
  if v_doc is null then raise exception 'HARNESS 6a: pb_dossier() rendered nothing for the subject account'; end if;
  foreach v_n in array string_to_array(current_setting('harness.needles'), '|')
                       || array[current_setting('harness.url'), current_setting('harness.rec'), 'sales_meeting'] loop
    if v_n is not null and v_n <> '' and (position(v_n in v_doc) > 0 or position(v_n in v_board) > 0) then
      raise exception 'HARNESS 6b: a public read carries meeting text (% characters starting "%")',
        char_length(v_n), left(v_n, 24);
    end if;
  end loop;
  foreach v_t in array array['pb_meetings', 'pb_meeting_title_rules', 'pb_meeting_proposals', 'pb_meeting_aliases'] loop
    begin
      execute format('select 1 from public.%I limit 1', v_t);
      v_fail := 'anon read ' || v_t;
    exception when insufficient_privilege then null;
    end;
    if v_fail is not null then raise exception 'HARNESS 6c: %', v_fail; end if;
  end loop;
  begin
    perform public.pb_decide_meeting_card('[]'::jsonb, null);
    v_fail := 'anon reached pb_decide_meeting_card';
  exception when insufficient_privilege then null;
  end;
  if v_fail is not null then raise exception 'HARNESS 6d: %', v_fail; end if;
  raise notice 'meeting_privacy_check: anon sees the effect, never the words';
end
$anon$;
reset role;

rollback;
