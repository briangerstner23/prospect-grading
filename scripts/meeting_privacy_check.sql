-- WLIQ Prospect Book — the sales-meeting reader's operator harness (DECISIONS §65).
--
-- Run it through execute_sql RIGHT AFTER migration A (prospect_book_sales_meeting_reader) applies,
-- and again after any change to pb_dossier(), pb_board(), the six meeting functions or the two removal
-- reads. It runs inside BEGIN … ROLLBACK and leaves nothing behind: every member, account, meeting,
-- proposal, fact, candidate, read and register row it makes is synthetic and is rolled back. It RAISES
-- on the first leak or missing refusal; success is the absence of an exception (and the NOTICE lines).
--
-- What it proves, in order:
--   1. Lanes. As a synthetic rater: approving a tier call, approving a removal, and a removal carrying
--      expires_at are refused. A viewer and a non-WLIQ address are refused outright.
--   2. Rules, as a synthetic owner: an override with no written reason, with an unknown reason code,
--      or on an account with no computed tier is refused; one at the computed tier (on an account no
--      live override moves) is recorded 'agrees' and writes nothing, and only_if_agrees refuses a call
--      the board does not show; a removal carrying an
--      expiry is refused by pb_register_removal_guard; a fact that disagrees with a person's value is
--      refused without overrule, judged on the value SENT (a claim that agreed, edited on the card to
--      another value, is refused; one that disagreed, edited to the person's own, records 'agrees');
--      a card spanning two agencies is refused; an unplaced name cannot be decided.
--   3. Writes. A rater's fact-and-read card lands (pb_facts with source sales_meeting, no quote and no
--      link; the waiting machine candidate on that key superseded; origin-tagged register notes). The
--      owner's card lands the overruling fact, the override (expiry = today + the rubric's
--      expiry_default_days), the removal (no expiry) and a read; the removed agency leaves pb_board().
--      No register row the decide function wrote carries a quote: pb_register is readable by every
--      signed-in lane, the viewer's included, and the words are owner and rater only.
--   4. Placement: assign remembers the name, unassign forgets it. The newest word, re-derived: an
--      older meeting's claim that a newer one superseded is open again once the newer one is sent
--      back to 'Who is this?', rejected on its card or dismissed with its meeting, and superseded again
--      once it is placed back; [Propose anyway] on an older row supersedes it at once. A card on an
--      agency since promoted can be rejected and not approved. A merge carries the merged record's
--      proposals and learned names to the survivor, where the newer word wins. A newer meeting's tier
--      call that the board has since come to show, decided as the page sends it, keeps the older
--      contradicting call closed — whether the engine's tier or a live override's put it there, and
--      the live override is not renewed. No tier call is decided against a read the register has moved
--      past — an override written since the engine's clock for that score (4q, ticked or not, overrule
--      or not; 4u, written while the score graded), one lapsed since (4r), or a record merged in since
--      (4t). A call that would end a live override the read shows — one pinning the computed tier
--      included — is refused without overrule and written with it (4s). A merged record whose read
--      carries a meeting override keeps that read (pb_merge_accounts never moves reads) while the
--      override row goes to the survivor.
--   5. As `authenticated`: a hand insert cannot pose as a meeting fact; a rater reads the proposals,
--      a viewer reads none of them; nobody updates them directly; an address outside WLIQ reads no
--      removal's written reason through pb_removed() or pb_removal(), and a WLIQ address does.
--   6. As `anon`: pb_dossier() and pb_board() carry none of the quotes, the override text, the read,
--      the meeting link or the literal 'sales_meeting'; a read as pb-score would write it after the
--      meeting's override (synthetic, rolled back) reaches the dossier without the override's reason
--      or its approver, in override.* or in the engine's note — on the subject account and on a record
--      merged away after its override, whose register row now sits on the survivor; the four tables
--      are denied; the decide function is denied.
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
  p_fact2   uuid; p_over_b uuid; p_fact_b uuid; p_unplaced uuid; p_fact_e uuid;
  v_old     text;      -- an older and a middle meeting, for the newest-word cases (section 4)
  v_mid     text;
  v_c       uuid;      -- a synthetic agency promoted under its open card
  v_d       uuid;      -- a synthetic agency merged into v_b
  v_e       uuid;      -- a synthetic agency whose engine tier a newer meeting named (4n)
  v_f       uuid;      -- a synthetic agency with a meeting override, merged into v_b (4o, 6g)
  v_g       uuid;      -- a synthetic agency a live override shows at a newer meeting's tier (4p)
  v_h       uuid;      -- a synthetic agency overridden after its read was scored (4q)
  v_i       uuid;      -- a synthetic agency whose override lapsed after its read was scored (4r)
  v_j       uuid;      -- a synthetic agency whose live override pins the computed tier (4s)
  v_k       uuid;      -- a synthetic agency a record with a live override was merged into after its read (4t)
  v_m       uuid;      -- that merged record (4t)
  v_l       uuid;      -- a synthetic agency overridden between its score's clock and its run row (4u)
  v_tier3   text;      -- a tier that is neither the computed one nor v_tier (4q)
  v_fq      text;      -- the written reason the owner typed from the meeting for v_f's override
  p_o1 uuid; p_n1 uuid; p_o2 uuid; p_n2 uuid; p_o3 uuid; p_m3 uuid; p_c1 uuid; p_c2 uuid; p_d1 uuid; p_b1 uuid;
  p_eo uuid; p_en uuid; p_f1 uuid; p_go uuid; p_gn uuid; p_h1 uuid; p_i1 uuid; p_h2 uuid; p_j1 uuid; p_k1 uuid; p_l1 uuid;
  v_item    jsonb;
  v_note    text;
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
    -- the instant the decide function compares the register against: the earliest of the run's
    -- start, the read's write and the engine's own clock (scorecard.as_of, taken before the register
    -- was read)
    cross join lateral (
      select least((select x.started_at from public.pb_runs x where x.id = r.run_id), r.run_at,
                   case when r.scorecard->>'as_of' ~ '^\d{4}-\d{2}-\d{2}' then (r.scorecard->>'as_of')::timestamptz end) as seen) s
   where a.book = 'prospect' and r.computed_tier is not null
     -- no live override at all — none moving the board off the computed tier, and none pinning it —
     -- so an override TO the computed tier changes nothing (2c) and one to another tier ends nothing (3f)
     and lower(coalesce(r.effective_tier, r.computed_tier)) = lower(r.computed_tier)
     and coalesce(jsonb_typeof(r.scorecard->'override'), 'null') = 'null'
     -- and no override written or lapsed, and no record merged in, since that instant: the decide
     -- function decides no tier call against a read the register has moved past (2c relies on it agreeing)
     and not exists (select 1 from public.pb_register g
                      where g.account_id = r.account_id and g.kind = 'override'
                        and (g.created_at > s.seen or (g.expires_at >= s.seen and g.expires_at < now())))
     and not exists (select 1 from public.pb_register g
                      where g.account_id = r.account_id and g.kind = 'decision' and g.payload ? 'merged_from'
                        and g.created_at > s.seen)
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
  select t into v_tier3 from jsonb_array_elements_text(v_spec->'vocabulary'->'tiers') t
   where lower(t) <> lower(v_ctier) and lower(t) <> lower(v_tier) limit 1;
  if v_tier3 is null then
    raise exception 'HARNESS: the vocabulary offers no third tier';
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
          'Tier call made in the sales meeting of ' || current_date || ' at 00:01:20; the words are on its meeting card.',
          'harness', 'h3:' || v_marker, 'proposed')
  returning id into p_over;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          q[8], 18, 18, '00:02:20', 'S1', 'asserted', current_date, 'Tier call made in the harness meeting.', 'harness',
          'h8:' || v_marker, 'proposed')
  returning id into p_over_same;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, reason_code, disposition, quote,
     line_from, line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'removal', 'too_small', 'unqualified', q[4],
          13, 13, '00:01:30', 'S1', 'asserted', current_date,
          'Removal called for in the sales meeting of ' || current_date || ' at 00:01:30; the words are on its meeting card.',
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
          q[6], 15, 15, '00:01:50', 'S2', 'asserted', current_date, 'Tier call made in the harness meeting.', 'harness',
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
  -- The tier the board already shows (the engine's, no override live): recorded 'agrees', nothing
  -- written. Refusing it left a reject as the only way to close the card, and a reject reopens an
  -- older meeting's contradicting call (4n). Rolled back by a sentinel: as 'agrees' at line 18 it
  -- would supersede p_over (line 12) before 3f approves it.
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over_same, 'decision', 'approve',
             'only_if_agrees', true)));
    if (v_r->>'agrees')::int <> 1 or (v_r->>'overrides')::int <> 0 or (v_r->>'approved')::int <> 0 then
      v_fail := 'a call at the computed tier returned ' || v_r::text;
    elsif (select status from public.pb_meeting_proposals where id = p_over_same) <> 'agrees'
          or exists (select 1 from public.pb_register g where g.payload->>'proposal_id' = p_over_same::text) then
      v_fail := 'a call at the computed tier was not recorded as agreeing, or wrote a register row';
    end if;
    raise exception 'harness sentinel 2c';
  exception when others then
    if sqlerrm <> 'harness sentinel 2c' then v_fail := 'a call at the computed tier was refused: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2c: %', v_fail; end if;
  -- only_if_agrees on a call the board does NOT show: the card is refused, nothing is written.
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_over, 'decision', 'approve',
              'only_if_agrees', true)));
    v_fail := 'only_if_agrees wrote an override for a tier the board does not show';
  exception when others then
    if sqlerrm not like '%no longer the tier the board shows%' then v_fail := 'only_if_agrees refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2c2: %', v_fail; end if;
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
  -- The value a card SENDS is the one compared, so an edit can make a conflict (the page's
  -- meetingOverrules sends overrule on the edited value). The row is made inside the block, so the
  -- refusal takes it away again and it can never supersede p_fact2.
  begin
    insert into public.pb_meeting_proposals
      (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
       quote_at, speaker, mode, held_on, extractor, fingerprint, status)
    values (v_rec, v_a, array['harness a'], 'harness a', 'resolved', 'name', 'fact', 'harness_k2', '30000'::jsonb, q[5],
            21, 21, '00:02:50', 'S1', 'asserted', current_date, 'harness', 'h5e:' || v_marker, 'proposed')
    returning id into p_fact_e;
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_fact_e, 'decision', 'approve',
              'edit', jsonb_build_object('value', 45000))));
    v_fail := 'a claim that agreed with a person, edited to another value, was approved without overrule';
  exception when others then
    if sqlerrm not like '%differs from what a person recorded%' then v_fail := 'edited conflict refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2f2: %', v_fail; end if;
  -- …and can end one: p_fact2 edited to the person's own value needs no overrule and writes nothing.
  -- Rolled back by a sentinel, so 3f still decides p_fact2 as written.
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_fact2, 'decision', 'approve',
             'edit', jsonb_build_object('value', 30000))));
    if (v_r->>'agrees')::int <> 1 or (v_r->>'facts')::int <> 0 then
      v_fail := 'a conflicting claim edited to the person''s own value returned ' || v_r::text;
    end if;
    raise exception 'harness sentinel 2f3';
  exception when others then
    if sqlerrm <> 'harness sentinel 2f3' then v_fail := 'a claim edited to the person''s own value was refused: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 2f3: %', v_fail; end if;
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
  select count(*) into v_n from public.pb_register g, unnest(q) x
   where g.account_id in (v_a, v_b) and g.payload->>'origin' = 'sales_meeting' and position(x in g.text) > 0;
  if v_n <> 0 then
    raise exception 'HARNESS 3k: % register row(s) the decide function wrote carry a quote; pb_register is read by every signed-in lane', v_n;
  end if;
  -- The read pb-score would write tomorrow morning, in the engine's shape, with a written reason a
  -- person typed from the meeting. Rule 6 keeps pb_reads for pb-score; this row is rolled back with
  -- the rest, and it is the only way to see the trace strip work on the subject account before then.
  v_note := 'Override applied: ' || v_ctier || ' → ' || v_tier || ' (relationship_known, ' || v_owner || ').';
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_a, 'harness', 'harness', clock_timestamp(), current_date, 'Overridden', v_tier, v_ctier,
          'Overridden by the owner (relationship_known). Harness read.',
          jsonb_build_object(
            'override', jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'reason', q[3],
                                           'approver', v_owner),
            'trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', jsonb_build_array(v_note))),
          'harness');

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

  -- The newest word, re-derived. An older meeting says harness_k5 about v_b; this meeting says it
  -- again under another spoken name, which wins.
  v_old := 'harness-old-' || v_marker;
  v_mid := 'harness-mid-' || v_marker;
  insert into public.pb_meetings (recording_id, inbox_id, title, title_norm, held_at, ended_at, url, include,
                                  selected_by, status, read_at)
  values (v_old, gen_random_uuid(), 'Harness sales connect', 'harness sales connect', now() - interval '3 days',
          now() - interval '3 days', null, true, 'owner', 'read', now()),
         (v_mid, gen_random_uuid(), 'Harness sales connect', 'harness sales connect', now() - interval '2 days',
          now() - interval '2 days', null, true, 'owner', 'read', now());
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_b, array['harness d'], 'harness d', 'resolved', 'name', 'fact', 'harness_k5', '5'::jsonb,
          'harness quote eleven ' || v_marker, 20, 20, '00:03:00', 'S1', 'asserted', current_date - 3, 'harness',
          'h11:' || v_marker, 'proposed')
  returning id into p_o1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, v_b, array['harness e'], 'harness e', 'resolved', 'name', 'fact', 'harness_k5', '6'::jsonb,
          'harness quote twelve ' || v_marker, 21, 21, '00:03:10', 'S2', 'asserted', current_date, 'harness',
          'h12:' || v_marker, 'proposed')
  returning id into p_n1;
  perform public.pb_meeting_supersede(v_rec);
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_o1)
     is distinct from 'superseded/' || p_n1 then
    raise exception 'HARNESS 4c: the older meeting''s claim was not superseded by the newer one';
  end if;
  perform public.pb_assign_meeting_mention(v_rec, 'harness e', 'unassign', null, false);
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_o1)
     is distinct from 'proposed/' then
    raise exception 'HARNESS 4d: [Wrong agency] on the newer claim left the older one superseded by a row that names nobody';
  end if;
  perform public.pb_assign_meeting_mention(v_rec, 'harness e', 'assign', v_b, false);
  if (select status from public.pb_meeting_proposals where id = p_o1) <> 'superseded' then
    raise exception 'HARNESS 4e: placing the newer claim back did not supersede the older one again';
  end if;
  perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_n1, 'decision', 'reject')));
  if (select status from public.pb_meeting_proposals where id = p_o1) <> 'proposed' then
    raise exception 'HARNESS 4f: rejecting the newer claim left the older one superseded';
  end if;

  -- [Propose anyway] on an older row a newer word already beats: superseded at once.
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_b, array['harness d'], 'harness d', 'resolved', 'name', 'fact', 'harness_k6', '1'::jsonb,
          'harness quote thirteen ' || v_marker, 22, 22, '00:03:20', 'S1', 'question', current_date - 3, 'harness',
          'h13:' || v_marker, 'not_proposed')
  returning id into p_o2;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, v_b, array['harness e'], 'harness e', 'resolved', 'person', 'fact', 'harness_k6', '2'::jsonb,
          'harness quote fourteen ' || v_marker, 23, 23, '00:03:30', 'S2', 'asserted', current_date, 'harness',
          'h14:' || v_marker, 'proposed')
  returning id into p_n2;
  perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_o2, 'decision', 'propose')));
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_o2)
     is distinct from 'superseded/' || p_n2 then
    raise exception 'HARNESS 4g: [Propose anyway] opened an older claim beside the newer word that beats it';
  end if;

  -- [Dismiss meeting] on the newer meeting: the older claim it had beaten is open again.
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_b, array['harness d'], 'harness d', 'resolved', 'name', 'fact', 'harness_k7', '1'::jsonb,
          'harness quote fifteen ' || v_marker, 24, 24, '00:03:40', 'S1', 'asserted', current_date - 3, 'harness',
          'h15:' || v_marker, 'proposed')
  returning id into p_o3;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_mid, v_b, array['harness f'], 'harness f', 'resolved', 'name', 'fact', 'harness_k7', '2'::jsonb,
          'harness quote sixteen ' || v_marker, 1, 1, '00:00:10', 'S1', 'asserted', current_date - 2, 'harness',
          'h16:' || v_marker, 'proposed')
  returning id into p_m3;
  perform public.pb_meeting_supersede(v_mid);
  perform public.pb_dismiss_meeting(v_mid, 'harness');
  if (select status from public.pb_meeting_proposals where id = p_o3) <> 'proposed'
     or (select status from public.pb_meeting_proposals where id = p_m3) <> 'rejected' then
    raise exception 'HARNESS 4h: dismissing the newer meeting left the older claim superseded';
  end if;

  -- A card on an agency promoted since it was read: it can be rejected, never approved.
  insert into public.pb_accounts (key, name, book)
  values ('harness-c:' || v_marker, 'Harness account c ' || v_marker, 'prospect') returning id into v_c;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_c, array['harness g'], 'harness g', 'resolved', 'name', 'fact', 'harness_k8', '1'::jsonb,
          'harness quote seventeen ' || v_marker, 25, 25, '00:03:50', 'S1', 'asserted', current_date - 3, 'harness',
          'h17:' || v_marker, 'proposed')
  returning id into p_c1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_c, array['harness g'], 'harness g', 'resolved', 'name', 'fact', 'harness_k9', '1'::jsonb,
          'harness quote eighteen ' || v_marker, 26, 26, '00:04:00', 'S1', 'asserted', current_date - 3, 'harness',
          'h18:' || v_marker, 'proposed')
  returning id into p_c2;
  update public.pb_accounts set book = 'promoted' where id = v_c;
  begin
    perform public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_c1, 'decision', 'approve')));
    v_fail := 'a card on a promoted agency was approved';
  exception when others then
    if sqlerrm not like '%meeting approval%' then v_fail := 'promoted approval refused for the wrong reason: ' || sqlerrm; end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4i: %', v_fail; end if;
  v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_c2, 'decision', 'reject')));
  if (v_r->>'rejected')::int <> 1 then
    raise exception 'HARNESS 4j: a card on a promoted agency could not be rejected (%)', v_r;
  end if;

  -- A merge: the merged record's proposal and learned name go to the survivor, where the newer word wins.
  perform set_config('request.jwt.claims', jsonb_build_object('email', v_owner, 'role', 'authenticated')::text, true);
  insert into public.pb_accounts (key, name, book)
  values ('harness-d:' || v_marker, 'Harness account d ' || v_marker, 'prospect') returning id into v_d;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_old, v_d, array['harness h'], 'harness h', 'resolved', 'learned', 'fact', 'harness_k10', '1'::jsonb,
          'harness quote nineteen ' || v_marker, 27, 27, '00:04:10', 'S1', 'asserted', current_date - 3, 'harness',
          'h19:' || v_marker, 'proposed')
  returning id into p_d1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, key, value, quote, line_from, line_to,
     quote_at, speaker, mode, held_on, extractor, fingerprint, status)
  values (v_rec, v_b, array['harness e'], 'harness e', 'resolved', 'person', 'fact', 'harness_k10', '2'::jsonb,
          'harness quote twenty ' || v_marker, 28, 28, '00:04:20', 'S2', 'asserted', current_date, 'harness',
          'h20:' || v_marker, 'proposed')
  returning id into p_b1;
  insert into public.pb_meeting_aliases (said_key, account_id, confirmed_by, from_recording, active)
  values ('harness h', v_d, v_owner, v_old, true);
  perform public.pb_merge_accounts(v_d, v_b, 'harness');
  if (select account_id from public.pb_meeting_proposals where id = p_d1) is distinct from v_b then
    raise exception 'HARNESS 4k: a merge left the merged record''s proposal on it, where no card can approve it';
  end if;
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_d1)
     is distinct from 'superseded/' || p_b1 then
    raise exception 'HARNESS 4l: after the merge the survivor''s newer word did not supersede the merged record''s older one';
  end if;
  if not exists (select 1 from public.pb_meeting_aliases where said_key = 'harness h' and account_id = v_b and active)
     or exists (select 1 from public.pb_meeting_aliases where said_key = 'harness h' and account_id = v_d and active) then
    raise exception 'HARNESS 4m: a merge did not carry the learned name to the survivor';
  end if;

  -- The newest word survives the board agreeing with it. An older meeting calls v_e v_tier; this
  -- meeting calls it v_ctier, which supersedes it; the engine computes v_ctier with no override live.
  -- Deciding this meeting's card as the page sends it (approve, only_if_agrees) records 'agrees' and
  -- the older call stays closed. Sent as a reject, it would have reopened, pre-ticked.
  insert into public.pb_accounts (key, name, book)
  values ('harness-e:' || v_marker, 'Harness account e ' || v_marker, 'prospect') returning id into v_e;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_e, 'harness', 'harness', clock_timestamp(), current_date, 'Ranked', v_ctier, v_ctier, 'Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_old, v_e, array['harness i'], 'harness i', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          'harness quote twenty-one ' || v_marker, 29, 29, '00:04:30', 'S1', 'asserted', current_date - 3,
          'Tier call made in the harness meeting.', 'harness', 'h21:' || v_marker, 'proposed')
  returning id into p_eo;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_e, array['harness i'], 'harness i', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          'harness quote twenty-two ' || v_marker, 30, 30, '00:04:40', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h22:' || v_marker, 'proposed')
  returning id into p_en;
  perform public.pb_meeting_supersede(v_rec);
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_eo)
     is distinct from 'superseded/' || p_en then
    raise exception 'HARNESS 4n: the newer meeting''s tier call did not supersede the older one';
  end if;
  v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_en, 'decision', 'approve',
           'only_if_agrees', true)));
  if (v_r->>'agrees')::int <> 1 or (v_r->>'overrides')::int <> 0
     or (select status from public.pb_meeting_proposals where id = p_en) <> 'agrees' then
    raise exception 'HARNESS 4n: the newer call the board shows was not recorded as agreeing (%)', v_r;
  end if;
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_eo)
     is distinct from 'superseded/' || p_en then
    raise exception 'HARNESS 4n: deciding the newer card reopened the older meeting''s contradicting tier call';
  end if;
  if exists (select 1 from public.pb_register g where g.account_id = v_e and g.kind = 'override') then
    raise exception 'HARNESS 4n: a tier call the board already shows wrote an override';
  end if;

  -- The same when a LIVE OVERRIDE puts the newer call's tier on the board and the engine computes
  -- another. An older meeting calls v_g v_ctier; this meeting calls it v_tier, which supersedes it;
  -- the owner has since overridden v_g to v_tier. Decided as the page sends it (approve,
  -- only_if_agrees), the newer call records 'agrees', writes no override (the live one is not
  -- renewed) and keeps the older call closed. Sent as a reject, the older call would have reopened
  -- and, approved, written an override ending the live one on a word the newer meeting contradicted.
  insert into public.pb_accounts (key, name, book)
  values ('harness-g:' || v_marker, 'Harness account g ' || v_marker, 'prospect') returning id into v_g;
  -- The override itself, in the register where the engine reads it, written a day before the read
  -- was scored: the read is settled, so the function may take it as what the board shows.
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at, created_at)
  values ('override', v_g, v_owner, 'relationship_known', 'harness override written before the score',
          jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'expires_at', now() + interval '30 days'),
          now() + interval '30 days', now() - interval '1 day');
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_g, 'harness', 'harness', clock_timestamp(), current_date, 'Overridden', v_tier, v_ctier,
          'Overridden by the owner (relationship_known). Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_old, v_g, array['harness k'], 'harness k', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          'harness quote twenty-five ' || v_marker, 32, 32, '00:05:00', 'S1', 'asserted', current_date - 3,
          'Tier call made in the harness meeting.', 'harness', 'h24:' || v_marker, 'proposed')
  returning id into p_go;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_g, array['harness k'], 'harness k', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          'harness quote twenty-six ' || v_marker, 33, 33, '00:05:10', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h25:' || v_marker, 'proposed')
  returning id into p_gn;
  perform public.pb_meeting_supersede(v_rec);
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_go)
     is distinct from 'superseded/' || p_gn then
    raise exception 'HARNESS 4p: the newer meeting''s tier call did not supersede the older one';
  end if;
  v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_gn, 'decision', 'approve',
           'only_if_agrees', true)));
  if (v_r->>'agrees')::int <> 1 or (v_r->>'overrides')::int <> 0
     or (select status from public.pb_meeting_proposals where id = p_gn) <> 'agrees' then
    raise exception 'HARNESS 4p: a newer call naming a live override''s tier was not recorded as agreeing (%)', v_r;
  end if;
  if (select status || '/' || coalesce(superseded_by::text, '') from public.pb_meeting_proposals where id = p_go)
     is distinct from 'superseded/' || p_gn then
    raise exception 'HARNESS 4p: deciding the newer card reopened the older meeting''s call against the live override';
  end if;
  if (select count(*) from public.pb_register g where g.account_id = v_g and g.kind = 'override') <> 1
     or exists (select 1 from public.pb_register g where g.payload->>'proposal_id' = p_gn::text) then
    raise exception 'HARNESS 4p: a tier call a live override already shows wrote (or renewed) an override';
  end if;

  -- The read the board shows is the last score's; an override written SINCE moves the board at the
  -- next one. v_h was scored an hour ago at v_ctier with no override; the owner has since overridden
  -- it to v_tier (from another meeting's card, or the sheet). This meeting's call names v_ctier — what
  -- the read still says. Sent as the page sends a call the board shows (only_if_agrees), the card is
  -- refused until the score, never recorded 'agrees': at 06:15 the board shows v_tier, and an 'agrees'
  -- would have closed the newest word for good. Sent as a plain approval — the screen pre-ticks a call
  -- that names a third tier, because the read it shows holds no override — it is refused too, with or
  -- without overrule: the card never showed the new override, so no tick on it can end it.
  insert into public.pb_accounts (key, name, book)
  values ('harness-h:' || v_marker, 'Harness account h ' || v_marker, 'prospect') returning id into v_h;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_h, 'harness', 'harness', now() - interval '1 hour', current_date, 'Ranked', v_ctier, v_ctier, 'Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at)
  values ('override', v_h, v_owner, 'relationship_known', 'harness override written after the score',
          jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'expires_at', now() + interval '30 days'),
          now() + interval '30 days');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_h, array['harness l'], 'harness l', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          'harness quote twenty-seven ' || v_marker, 34, 34, '00:05:20', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h26:' || v_marker, 'proposed')
  returning id into p_h1;
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_old, v_h, array['harness l'], 'harness l', 'resolved', 'name', 'override', v_tier3, 'relationship_known',
          'harness quote twenty-nine ' || v_marker, 36, 36, '00:05:40', 'S1', 'asserted', current_date - 3,
          'Tier call made in the harness meeting.', 'harness', 'h28:' || v_marker, 'proposed')
  returning id into p_h2;
  v_fail := null;
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_h1, 'decision', 'approve',
             'only_if_agrees', true)));
    v_fail := 'a call naming the stale read''s tier was decided (' || v_r::text || ') after an override was written since the score';
  exception when others then
    if sqlerrm not like '%since the board was last scored%' then
      v_fail := 'a call against a read the register moved past was refused for the wrong reason: ' || sqlerrm;
    end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4q: %', v_fail; end if;
  if (select status from public.pb_meeting_proposals where id = p_h1) <> 'proposed'
     or exists (select 1 from public.pb_register g where g.payload->>'proposal_id' = p_h1::text) then
    raise exception 'HARNESS 4q: the refused call did not stay open, or wrote a register row';
  end if;
  foreach v_item in array array[
      jsonb_build_object('id', p_h1, 'decision', 'approve'),
      jsonb_build_object('id', p_h1, 'decision', 'approve', 'overrule', true),
      jsonb_build_object('id', p_h2, 'decision', 'approve'),
      jsonb_build_object('id', p_h2, 'decision', 'approve', 'overrule', true)] loop
    begin
      v_r := public.pb_decide_meeting_card(jsonb_build_array(v_item));
      v_fail := 'a tier call ' || v_item::text || ' was decided (' || v_r::text || ') after an override was written since the score';
    exception when others then
      if sqlerrm not like '%since the board was last scored%' then
        v_fail := 'a ticked call against a read the register moved past was refused for the wrong reason: ' || sqlerrm;
      end if;
    end;
    if v_fail is not null then raise exception 'HARNESS 4q: %', v_fail; end if;
  end loop;
  if (select count(*) from public.pb_meeting_proposals where id in (p_h1, p_h2) and status = 'proposed') <> 2
     or (select count(*) from public.pb_register g where g.account_id = v_h and g.kind = 'override') <> 1 then
    raise exception 'HARNESS 4q: a refused call did not stay open, or the override written since the score was ended';
  end if;

  -- The same when the override LAPSED since the score: v_i's read shows v_tier by an override that
  -- expired an hour ago. The next score drops the board to v_ctier, so this meeting's v_tier call is
  -- not 'agrees' — recorded so, the team's reaffirmed call would be lost at 06:15.
  insert into public.pb_accounts (key, name, book)
  values ('harness-i:' || v_marker, 'Harness account i ' || v_marker, 'prospect') returning id into v_i;
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at, created_at)
  values ('override', v_i, v_owner, 'relationship_known', 'harness override that lapsed after the score',
          jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'expires_at', now() - interval '1 hour'),
          now() - interval '1 hour', now() - interval '10 days');
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_i, 'harness', 'harness', now() - interval '2 hours', current_date, 'Overridden', v_tier, v_ctier,
          'Overridden by the owner (relationship_known). Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_i, array['harness m'], 'harness m', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          'harness quote twenty-eight ' || v_marker, 35, 35, '00:05:30', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h27:' || v_marker, 'proposed')
  returning id into p_i1;
  v_fail := null;
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_i1, 'decision', 'approve',
             'only_if_agrees', true)));
    v_fail := 'a call naming a lapsed override''s tier was decided (' || v_r::text || ')';
  exception when others then
    if sqlerrm not like '%since the board was last scored%' then
      v_fail := 'a call against a lapsed override was refused for the wrong reason: ' || sqlerrm;
    end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4r: %', v_fail; end if;
  if (select status from public.pb_meeting_proposals where id = p_i1) <> 'proposed'
     or exists (select 1 from public.pb_register g where g.payload->>'proposal_id' = p_i1::text) then
    raise exception 'HARNESS 4r: the refused call did not stay open, or wrote a register row';
  end if;

  -- A live override at the COMPUTED tier: the owner pinned v_j at v_ctier (or the engine caught up to
  -- the override's tier). The read is Overridden with both tiers v_ctier — comparing the two cannot see
  -- the override, its scorecard can. A call naming a third tier ends it, so it is written only with
  -- overrule (a box a person ticked with "approving ends it" on the row); sent as a pre-ticked row is
  -- sent, it is refused.
  insert into public.pb_accounts (key, name, book)
  values ('harness-j:' || v_marker, 'Harness account j ' || v_marker, 'prospect') returning id into v_j;
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at, created_at)
  values ('override', v_j, v_owner, 'relationship_known', 'harness override pinning the computed tier',
          jsonb_build_object('tier', v_ctier, 'reason_code', 'relationship_known', 'expires_at', now() + interval '30 days'),
          now() + interval '30 days', now() - interval '1 day');
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_j, 'harness', 'harness', clock_timestamp(), current_date, 'Overridden', v_ctier, v_ctier,
          'Overridden by the owner (relationship_known). Harness read.',
          jsonb_build_object(
            'override', jsonb_build_object('tier', v_ctier, 'reason_code', 'relationship_known', 'approver', v_owner),
            'trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_j, array['harness n'], 'harness n', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          'harness quote thirty ' || v_marker, 37, 37, '00:05:50', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h29:' || v_marker, 'proposed')
  returning id into p_j1;
  v_fail := null;
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_j1, 'decision', 'approve')));
    v_fail := 'a call ending a live override at the computed tier was written without overrule (' || v_r::text || ')';
  exception when others then
    if sqlerrm not like '%a live override shows%' then
      v_fail := 'a call ending a live override was refused for the wrong reason: ' || sqlerrm;
    end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4s: %', v_fail; end if;
  if (select status from public.pb_meeting_proposals where id = p_j1) <> 'proposed'
     or (select count(*) from public.pb_register g where g.account_id = v_j and g.kind = 'override') <> 1 then
    raise exception 'HARNESS 4s: the refused call did not stay open, or wrote a register row';
  end if;
  v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_j1, 'decision', 'approve', 'overrule', true)));
  if (v_r->>'overrides')::int <> 1
     or not exists (select 1 from public.pb_register g where g.account_id = v_j and g.kind = 'override'
                     and g.payload->>'proposal_id' = p_j1::text and g.payload->>'tier' = v_tier) then
    raise exception 'HARNESS 4s: a call a person ticked on purpose to end the live override was not written (%)', v_r;
  end if;

  -- A MERGE since the read: v_k was scored an hour ago at v_ctier with no override; a duplicate
  -- holding a live override to v_tier, written days ago, has since been merged into it. The override
  -- row arrives with its old created_at, and the next score may apply it — so a call naming v_ctier
  -- sent only_if_agrees is refused until then, never recorded 'agrees'.
  insert into public.pb_accounts (key, name, book)
  values ('harness-k:' || v_marker, 'Harness account k ' || v_marker, 'prospect') returning id into v_k;
  insert into public.pb_accounts (key, name, book)
  values ('harness-m:' || v_marker, 'Harness account m ' || v_marker, 'prospect') returning id into v_m;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_k, 'harness', 'harness', now() - interval '1 hour', current_date, 'Ranked', v_ctier, v_ctier, 'Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at, created_at)
  values ('override', v_m, v_owner, 'relationship_known', 'harness override on the duplicate',
          jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'expires_at', now() + interval '30 days'),
          now() + interval '30 days', now() - interval '5 days');
  perform public.pb_merge_accounts(v_m, v_k, 'harness');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_k, array['harness o'], 'harness o', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          'harness quote thirty-one ' || v_marker, 38, 38, '00:06:00', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h30:' || v_marker, 'proposed')
  returning id into p_k1;
  v_fail := null;
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_k1, 'decision', 'approve',
             'only_if_agrees', true)));
    v_fail := 'a call naming the read''s tier was decided (' || v_r::text || ') after a record with a live override was merged in';
  exception when others then
    if sqlerrm not like '%since the board was last scored%' then
      v_fail := 'a call after a merge was refused for the wrong reason: ' || sqlerrm;
    end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4t: %', v_fail; end if;
  if (select status from public.pb_meeting_proposals where id = p_k1) <> 'proposed' then
    raise exception 'HARNESS 4t: the refused call did not stay open';
  end if;

  -- The ENGINE'S CLOCK, not the run's start: pb-score fixes as_of, reads pb_register, grades every
  -- account and only then opens its pb_runs row. v_l's read was written an hour ago by a score whose
  -- clock read two hours ago; an override was written in between (90 minutes ago). Compared against
  -- the run, it looks settled; against the engine's clock it is newer than the read, so the call naming
  -- the read's tier is refused, never recorded 'agrees'.
  insert into public.pb_accounts (key, name, book)
  values ('harness-l:' || v_marker, 'Harness account l ' || v_marker, 'prospect') returning id into v_l;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_l, 'harness', 'harness', now() - interval '1 hour', current_date, 'Ranked', v_ctier, v_ctier, 'Harness read.',
          jsonb_build_object(
            'as_of', to_char((now() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at, created_at)
  values ('override', v_l, v_owner, 'relationship_known', 'harness override written while the score graded',
          jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'expires_at', now() + interval '30 days'),
          now() + interval '30 days', now() - interval '90 minutes');
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_l, array['harness p'], 'harness p', 'resolved', 'name', 'override', v_ctier, 'relationship_known',
          'harness quote thirty-two ' || v_marker, 39, 39, '00:06:10', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h31:' || v_marker, 'proposed')
  returning id into p_l1;
  v_fail := null;
  begin
    v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_l1, 'decision', 'approve',
             'only_if_agrees', true)));
    v_fail := 'a call naming the read''s tier was decided (' || v_r::text || ') though an override was written after the engine''s clock';
  exception when others then
    if sqlerrm not like '%since the board was last scored%' then
      v_fail := 'a call against the engine''s clock was refused for the wrong reason: ' || sqlerrm;
    end if;
  end;
  if v_fail is not null then raise exception 'HARNESS 4u: %', v_fail; end if;

  -- A merged record keeps its last read for good — pb_merge_accounts never moves reads, and pb-score
  -- scores prospect and parked agencies only — while its register rows, the meeting override among
  -- them, go to the survivor. Section 6 renders that record's dossier as anon (6g).
  insert into public.pb_accounts (key, name, book)
  values ('harness-f:' || v_marker, 'Harness account f ' || v_marker, 'prospect') returning id into v_f;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_f, 'harness', 'harness', clock_timestamp(), current_date, 'Ranked', v_ctier, v_ctier, 'Harness read.',
          jsonb_build_object('trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', '[]'::jsonb)), 'harness');
  v_fq := 'harness quote twenty-three ' || v_marker || ' typed into the reason from the meeting';
  insert into public.pb_meeting_proposals
    (recording_id, account_id, said_as, said_key, mention_state, matched_on, kind, tier, reason_code, quote, line_from,
     line_to, quote_at, speaker, mode, held_on, default_text, extractor, fingerprint, status)
  values (v_rec, v_f, array['harness j'], 'harness j', 'resolved', 'name', 'override', v_tier, 'relationship_known',
          'harness quote twenty-four ' || v_marker, 31, 31, '00:04:50', 'S1', 'asserted', current_date,
          'Tier call made in the harness meeting.', 'harness', 'h23:' || v_marker, 'proposed')
  returning id into p_f1;
  v_r := public.pb_decide_meeting_card(jsonb_build_array(jsonb_build_object('id', p_f1, 'decision', 'approve',
           'edit', jsonb_build_object('text', v_fq))));
  if (v_r->>'overrides')::int <> 1 then
    raise exception 'HARNESS 4o: the owner''s tier call on the record to be merged returned %', v_r;
  end if;
  insert into public.pb_reads (account_id, rubric_version, rubric_fingerprint, run_at, as_of, status, effective_tier,
                               computed_tier, reason, scorecard, scorecard_sha256)
  values (v_f, 'harness', 'harness', clock_timestamp(), current_date, 'Overridden', v_tier, v_ctier,
          'Overridden by the owner (relationship_known). Harness read.',
          jsonb_build_object(
            'override', jsonb_build_object('tier', v_tier, 'reason_code', 'relationship_known', 'reason', v_fq,
                                           'approver', v_owner),
            'trace', jsonb_build_object('tier_reasoning', 'harness', 'notes', jsonb_build_array(
              'Override applied: ' || v_ctier || ' → ' || v_tier || ' (relationship_known, ' || v_owner || ').'))),
          'harness');
  perform public.pb_merge_accounts(v_f, v_b, 'harness');
  if exists (select 1 from public.pb_register g where g.account_id = v_f and g.kind = 'override')
     or not exists (select 1 from public.pb_register g where g.account_id = v_b and g.kind = 'override'
                     and g.payload->>'proposal_id' = p_f1::text)
     or (select r.effective_tier from public.pb_current_reads r where r.account_id = v_f) is distinct from v_tier then
    raise exception 'HARNESS 4o: the merge did not leave the read on the merged record and its override row on the survivor';
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
  perform set_config('harness.tier', v_tier, true);
  perform set_config('harness.note', replace(v_note, ', ' || v_owner || ').', ').'), true);
  perform set_config('harness.f', v_f::text, true);
  perform set_config('harness.f_reason', v_fq, true);
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
  -- The two definer reads of a removal's written reason: no wider than pb_register's own policy.
  if (select count(*) from public.pb_removal(current_setting('harness.a')::uuid)) <> 1 then
    raise exception 'HARNESS 5f: a WLIQ address does not see the subject''s removal through pb_removal()';
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('email', 'someone@example.com', 'role', 'authenticated')::text, true);
  if (select count(*) from public.pb_removal(current_setting('harness.a')::uuid)) <> 0
     or (select count(*) from public.pb_removed()) <> 0 then
    raise exception 'HARNESS 5g: an address outside WLIQ read a removal''s written reason through pb_removal() or pb_removed()';
  end if;
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
  v_dj    jsonb;
  v_board text;
  v_n     text;
  v_t     text;
  v_fail  text := null;
begin
  v_doc := public.pb_dossier(current_setting('harness.a')::uuid)::text;
  select coalesce(string_agg(b::text, ' '), '') into v_board from public.pb_board() b;
  if v_doc is null then raise exception 'HARNESS 6a: pb_dossier() rendered nothing for the subject account'; end if;
  v_dj := v_doc::jsonb;
  if v_dj #>> '{read,trace,override,tier}' is distinct from current_setting('harness.tier')
     or not coalesce(v_dj #> '{read,trace,trace,notes}' @> jsonb_build_array(current_setting('harness.note')), false) then
    raise exception 'HARNESS 6e: the harness read did not reach the dossier with its tier and its note less the approver';
  end if;
  if (v_dj #> '{read,trace,override}') ? 'reason' or (v_dj #> '{read,trace,override}') ? 'approver'
     or position('harness-owner' in (v_dj -> 'read')::text) > 0 then
    raise exception 'HARNESS 6f: the dossier''s read carries a meeting override''s reason or approver';
  end if;
  -- The record merged away after its meeting override: its read is still there, its override row is
  -- on the survivor, and anyone holding its id can render it.
  v_dj := public.pb_dossier(current_setting('harness.f')::uuid);
  if v_dj #>> '{read,trace,override,tier}' is distinct from current_setting('harness.tier') then
    raise exception 'HARNESS 6g: the merged record''s read did not reach its dossier, so the check proved nothing';
  end if;
  if (v_dj #> '{read,trace,override}') ? 'reason' or (v_dj #> '{read,trace,override}') ? 'approver'
     or position('harness-owner' in v_dj::text) > 0
     or position(current_setting('harness.f_reason') in v_dj::text) > 0 then
    raise exception 'HARNESS 6g: a merged record''s dossier carries its meeting override''s reason or approver';
  end if;
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
