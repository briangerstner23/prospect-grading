-- Prospect Book — the internal sales meeting is read, and what it says waits for a person
-- (owner, 10 Oct 2026; DECISIONS §65). Migration A of two. ONE atomic file, so the decide
-- functions can never exist without the dossier filters that keep their words off the public read.
--
-- PLACEHOLDER VERSION. 20261011000000 is a drafting stamp. When this is applied through the MCP,
-- the file is re-filed under the version schema_migrations records, byte-identical to
-- schema_migrations.statements by md5 (RUNBOOK §28.6). Until then CI's reconcile reports the
-- applied name as unfiled, so apply, transcribe and merge in one sitting.
--
-- WHAT IT ADDS
--   pb_meetings              one row per internal RECORDING seen: the selection record and the
--                            read log together. Written by pb-notes (service role) and by the owner's
--                            two selection functions below.
--   pb_meeting_title_rules   the owner's per-series say, as data.
--   pb_meeting_proposals     everything a meeting said about a named agency, until a person decides.
--                            A pure verifier (ingest/meeting_claims.ts) wrote every row; nothing in it
--                            reaches pb_facts or pb_register until pb_decide_meeting_card runs under
--                            a signed-in owner or rater.
--   pb_meeting_aliases       spoken names a person placed once ("Remember this name").
--   pb_facts.meeting_proposal_id, and a check that ties it to source 'sales_meeting' both ways.
--   the 'sales_meeting' registration cursor in pb_source_watermarks.
--   six SECURITY DEFINER functions: pb_decide_meeting_card, pb_assign_meeting_mention,
--   pb_meeting_include, pb_meeting_title_rule, pb_dismiss_meeting (authenticated) and
--   pb_meeting_supersede (service role).
--
-- WHAT IT CHANGES, each rebuilt from its LIVE body, never from a file (§50a, §53a). The bodies
-- below were read back on 10 Oct 2026 with pg_get_functiondef / pg_get_viewdef; section 0 refuses
-- to run if either function has moved since, rather than overwrite a newer body with an older one.
--   pb_current_facts   rule 9: 'sales_meeting' ranks 0, tied with 'rater'. security_invoker restated
--                      (create-or-replace resets reloptions — the 20260911180000 lesson) and asserted.
--   pb_reconcile_state the same CASE line in its rule9 copy (the third place the order is stated),
--                      plus two count-only blocks: meeting_privacy (a live canary CI runs every 6 h
--                      over the dossiers of the 20 newest-approved accounts) and meetings_work.
--   pb_dossier         three filters: no sales_meeting fact, no origin-tagged register row, and the
--                      trace's override.reason and approver stripped once any meeting-origin override
--                      exists for the account. linkedin_url, the removal filter and the address scrub
--                      survive and are asserted below.
--
-- WHY NOTHING IS PARKED IN pb_fact_candidates. The lanes view's `agree` CTE counts quoted proposed
-- candidates of any kind, so a parked meeting judgement would corroborate a matching machine claim
-- into autoconfirm at 06:00; pb_review_fact_candidate writes the quote into pb_facts.note, which
-- every signed-in address can read; and the dossier publishes candidates' keys. So meeting claims
-- wait in their own owner/rater-only table and the decide function writes pb_facts directly, with no
-- quote. The invariant: zero pb_fact_candidates rows with source 'sales_meeting', ever.
--
-- PRIVILEGES. anon holds nothing on the four tables or the six functions. Each table: RLS on, every
-- privilege revoked from anon and authenticated, SELECT back to authenticated, and one SELECT policy
-- narrower than pb_facts' (owner and rater lanes only, as the research tables are). No insert,
-- update or delete grant or policy exists: the service role and the definer functions write. CLAUDE.md's
-- two grants queries need no new exception (authenticated 'SELECT', anon '(none)'). This file grants
-- NOTHING to anon; the anon EXECUTE that pb_dossier and pb_reconcile_state already hold survives
-- create-or-replace and is asserted in section 11 rather than restated.
--
-- The sentinel (section 12) inserts a synthetic account, meeting, approved proposal, sales_meeting
-- fact and origin-tagged override and note, renders pb_dossier() for it, checks the live canary in
-- pb_reconcile_state() both ways (clean, then a deliberate leak it must see), and rolls all of it
-- back. A version that leaks cannot apply.

-- 0 · the live bodies this file was built from ---------------------------------------------------
do $$
declare
  v_src  text;
  v_def  text;
  v_odd  text;
begin
  select md5(p.prosrc) into v_src from pg_proc p where p.oid = 'public.pb_dossier(uuid)'::regprocedure;
  if v_src is distinct from 'ab44f7fd1d051c988bf7e76d9fa9df46' then
    raise exception 'pb_dossier() has moved since this file was written (prosrc md5 %, expected ab44f7fd…); '
                    'rebuild section 9 from the live body (DECISIONS §50a) instead of overwriting it', v_src;
  end if;
  select md5(p.prosrc) into v_src from pg_proc p where p.oid = 'public.pb_reconcile_state()'::regprocedure;
  if v_src is distinct from 'd6c124b70ce0b3f1ded7e0261f604c5b' then
    raise exception 'pb_reconcile_state() has moved since this file was written (prosrc md5 %, expected d6c124b7…); '
                    'rebuild section 10 from the live body (DECISIONS §50a) instead of overwriting it', v_src;
  end if;
  -- The view is restated whole below. What would be lost is a source rank someone added since; so
  -- every quoted name in the live definition must be one this file states.
  v_def := pg_get_viewdef('public.pb_current_facts'::regclass, true);
  select string_agg(distinct m[1], ', ') into v_odd
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') m
   where m[1] <> all (array['evidence', 'inferred', 'rater', 'sales_meeting', 'fathom_call', 'pipedrive_note',
                            'website', 'notion_master', 'apollo', 'pipedrive']);
  if v_odd is not null then
    raise exception 'pb_current_facts names % that this file does not; rebuild section 6 from the live view', v_odd;
  end if;
end $$;

-- 1 · pb_meetings ------------------------------------------------------------------------------
create table public.pb_meetings (
  recording_id    text primary key,
  inbox_id        uuid not null,               -- pb_webhook_inbox.id; no FK, the inbox is a log
  duplicate_of    text references public.pb_meetings (recording_id) on delete set null,
  title           text,
  title_norm      text not null,
  held_at         timestamptz,
  ended_at        timestamptz,
  url             text,                        -- the Fathom call url, never share_url (a capability link)
  speakers        jsonb,                       -- [{label:'S1', name}], no addresses
  include         boolean,                     -- the owner's say for this one meeting; null = none
  selected_by     text not null
                  check (selected_by in ('owner', 'title_rule', 'pattern', 'none')),
  status          text not null
                  check (status in ('waiting', 'reading', 'read', 'partial', 'skipped', 'duplicate', 'failed')),
  skip_reason     text
                  check (skip_reason in ('not_selected', 'external_speaker', 'owner_excluded', 'no_transcript')),
  extractor       text,
  read_started_at timestamptz,                 -- the lease
  read_at         timestamptz,
  mentions        jsonb,                       -- verified pass-1 output plus resolutions
  progress        jsonb,                       -- {done_refs:[], failed_refs:[]}
  counts          jsonb,
  usage           jsonb,                       -- {calls, input_tokens, output_tokens}
  notes           text[],                      -- ids and counts only
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.pb_meetings is
  'One row per internal recording pb-notes registered (DECISIONS §65): whether it is read and why, its lease, '
  'its verified mentions and its usage. No transcript is copied here; it stays in the service-role inbox.';

create index pb_meetings_status_held on public.pb_meetings (status, held_at);

create trigger pb_meetings_touch before update on public.pb_meetings
  for each row execute function public.pb_touch_updated_at();

alter table public.pb_meetings enable row level security;
revoke all on table public.pb_meetings from anon, authenticated;
grant select on table public.pb_meetings to authenticated;
create policy pb_meetings_read on public.pb_meetings
  for select to authenticated
  using (public.pb_is_wliq() and public.pb_role() in ('owner', 'rater'));

-- 2 · pb_meeting_title_rules -------------------------------------------------------------------
create table public.pb_meeting_title_rules (
  title_norm text primary key,
  read       boolean not null,
  set_by     text not null,
  set_at     timestamptz not null default now()
);

comment on table public.pb_meeting_title_rules is
  'The owner''s per-series control (DECISIONS §65): read, or never read, every meeting with this exact '
  'normalised title. Beats MEETING_TITLE_PATTERNS; loses to pb_meetings.include.';

alter table public.pb_meeting_title_rules enable row level security;
revoke all on table public.pb_meeting_title_rules from anon, authenticated;
grant select on table public.pb_meeting_title_rules to authenticated;
create policy pb_meeting_title_rules_read on public.pb_meeting_title_rules
  for select to authenticated
  using (public.pb_is_wliq() and public.pb_role() in ('owner', 'rater'));

-- 3 · pb_meeting_proposals ---------------------------------------------------------------------
-- The 35 columns pb-notes sends are ingest/meeting_claims.ts PROPOSAL_COLUMNS, in that order, from
-- recording_id to status; `id` and the six after `status` are PROPOSAL_DB_COLUMNS (defaults, or
-- filled by a decision). meeting_privacy_static_test.ts pins the two lists to this table.
create table public.pb_meeting_proposals (
  id               uuid primary key default gen_random_uuid(),
  recording_id     text not null references public.pb_meetings (recording_id) on delete cascade,
  account_id       uuid references public.pb_accounts (id) on delete cascade,   -- null = not yet placed
  said_as          text[] not null,
  said_key         text not null,
  mention_state    text not null check (mention_state in ('resolved', 'suggested', 'ambiguous')),
  matched_on       text check (matched_on in ('name', 'alias', 'learned', 'token', 'domain', 'prefix', 'person')),
  options          uuid[] not null default '{}' check (cardinality(options) <= 5),
  kind             text not null check (kind in ('fact', 'override', 'removal', 'read')),
  key              text,
  value            jsonb,
  confidence       text check (confidence in ('high', 'medium', 'low')),
  tier             text,
  reason_code      text,
  disposition      text check (disposition in ('do_not_contact', 'unqualified')),
  review_on        date,
  topic            text check (topic in ('price', 'decision_maker', 'relationship', 'timing', 'risk', 'fit',
                                         'next_step', 'other')),
  quote            text not null check (char_length(quote) between 12 and 600),
  context          text check (char_length(context) <= 1200),          -- the cited lines ±2
  line_from        integer not null,
  line_to          integer not null,
  quote_at         text not null check (quote_at ~ '^[0-9]{2,}:[0-5][0-9]:[0-5][0-9]$'),
  speaker          text not null check (speaker ~ '^S[0-9]+$'),
  mode             text not null check (mode in ('asserted', 'reported', 'plan', 'hypothetical', 'question',
                                                 'joke', 'unclear')),
  flags            text[] not null default '{}',
  default_selected boolean not null default false,
  held_on          date not null,
  current_value    jsonb,                     -- display snapshots only, never the rule:
  current_source   text,                      -- pb_decide_meeting_card re-derives all of it
  conflicts        boolean not null default false,
  engine_tier      text,
  effective_tier   text,
  default_text     text,                      -- the prefilled written reason
  extractor        text not null,
  fingerprint      text not null unique,
  status           text not null default 'proposed'
                   check (status in ('proposed', 'not_proposed', 'approved', 'rejected', 'superseded', 'agrees')),
  superseded_by    uuid,
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  result_id        uuid,                      -- the pb_facts or pb_register row a decision wrote
  created_at       timestamptz not null default now(),
  constraint pb_meeting_proposals_lines_check    check (line_from >= 1 and line_to >= line_from),
  constraint pb_meeting_proposals_fact_check     check (kind <> 'fact' or (key is not null and value is not null)),
  constraint pb_meeting_proposals_override_check check (kind <> 'override' or tier is not null),
  constraint pb_meeting_proposals_read_check     check (kind <> 'read' or topic is not null),
  -- Rule 8: identity never attaches below high without a person. A row carries an account only
  -- when its mention resolved, or a person placed it (matched_on 'person', state 'resolved').
  constraint pb_meeting_proposals_placed_check   check ((account_id is not null) = (mention_state = 'resolved'))
);

comment on table public.pb_meeting_proposals is
  'What an internal sales meeting said about a named agency, verified against its transcript lines, waiting '
  'for a person (DECISIONS §65). Owner and rater lanes only. Nothing here is a fact, an override or a removal '
  'until pb_decide_meeting_card writes it; meeting claims never enter pb_fact_candidates.';

create index pb_meeting_proposals_said    on public.pb_meeting_proposals (recording_id, said_key);
create index pb_meeting_proposals_account on public.pb_meeting_proposals (account_id, kind, key, status);
create index pb_meeting_proposals_open    on public.pb_meeting_proposals (created_at) where status = 'proposed';

-- Modelled on pb_fact_candidate_review_guard, written as "everything except" so a column added later
-- is immutable by default — the safe direction.
create or replace function public.pb_meeting_proposal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note', 'result_id',
                            'superseded_by', 'account_id', 'matched_on', 'mention_state'])
     is distinct from
     (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note', 'result_id',
                            'superseded_by', 'account_id', 'matched_on', 'mention_state']) then
    raise exception 'pb_meeting_proposals: only status, decided_by, decided_at, decision_note, result_id, '
                    'superseded_by, account_id, matched_on and mention_state may change; what the meeting said '
                    '(quote, lines, key, value, tier, fingerprint, extractor, held_on) is immutable';
  end if;
  return new;
end $$;

create trigger pb_meeting_proposal_guard before update on public.pb_meeting_proposals
  for each row execute function public.pb_meeting_proposal_guard();

alter table public.pb_meeting_proposals enable row level security;
revoke all on table public.pb_meeting_proposals from anon, authenticated;
grant select on table public.pb_meeting_proposals to authenticated;
create policy pb_meeting_proposals_read on public.pb_meeting_proposals
  for select to authenticated
  using (public.pb_is_wliq() and public.pb_role() in ('owner', 'rater'));

-- 4 · pb_meeting_aliases -----------------------------------------------------------------------
-- pb_mdm_aliases is a registry mirror and is never written; a name a person placed lives here.
create table public.pb_meeting_aliases (
  said_key       text not null,
  account_id     uuid not null references public.pb_accounts (id) on delete cascade,
  confirmed_by   text not null,
  confirmed_at   timestamptz not null default now(),
  from_recording text,
  active         boolean not null default true,
  primary key (said_key, account_id)
);

comment on table public.pb_meeting_aliases is
  'Spoken names a person placed once in a meeting review (DECISIONS §65). An active row makes that name '
  'resolve next time; two accounts holding one name make it ambiguous again.';

alter table public.pb_meeting_aliases enable row level security;
revoke all on table public.pb_meeting_aliases from anon, authenticated;
grant select on table public.pb_meeting_aliases to authenticated;
create policy pb_meeting_aliases_read on public.pb_meeting_aliases
  for select to authenticated
  using (public.pb_is_wliq() and public.pb_role() in ('owner', 'rater'));

-- 5 · pb_facts: a meeting fact names the proposal a person approved ------------------------------
-- Every existing row passes the check (none has the source). Grants are unchanged (authenticated
-- INSERT,SELECT). The check alone would still let a signed-in rater hand-insert a 'sales_meeting'
-- row naming a proposal id they can read, so a trigger refuses the source and the column to every
-- API role; the decide function runs as the table owner and passes.
alter table public.pb_facts
  add column meeting_proposal_id uuid references public.pb_meeting_proposals (id);

alter table public.pb_facts
  add constraint pb_facts_meeting_origin_check
  check ((source = 'sales_meeting') = (meeting_proposal_id is not null));

comment on column public.pb_facts.meeting_proposal_id is
  'Set exactly when source = ''sales_meeting'': the pb_meeting_proposals row a person approved on its card '
  '(pb_decide_meeting_card). DECISIONS §65.';

create or replace function public.pb_facts_meeting_origin_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source = 'sales_meeting' or new.meeting_proposal_id is not null then
    raise exception 'a sales_meeting fact is written only by pb_decide_meeting_card, from a proposal a person '
                    'approved on its card (DECISIONS §65)';
  end if;
  return new;
end $$;

create trigger pb_facts_meeting_origin_guard before insert or update on public.pb_facts
  for each row when (current_user in ('authenticated', 'anon', 'service_role'))
  execute function public.pb_facts_meeting_origin_guard();

-- The registration cursor. last_seen_at null = nothing registered yet; pb-notes advances it past
-- every inbox row it considers, internal or not.
insert into public.pb_source_watermarks (source, last_seen_at, last_run_at, note)
values ('sales_meeting', null, now(), 'registration cursor over pb_webhook_inbox (received_at, id)')
on conflict (source) do nothing;

-- 6 · pb_current_facts: rule 9 with the meeting beside the rater ---------------------------------
--   0 rater, sales_meeting   a person typed it, or a person approved what the team said (§65)
--   1 fathom_call  2 pipedrive_note  3 website  4 notion_master  5 apollo  6 pipedrive  7 else
-- The tie inside rank 0 goes to the newest written; the card refuses to overrule a person silently.
-- The same order is stated in pb_reconcile_state()'s rule9 CTE (section 10) and in SOURCE_RANK
-- (ingest/resolve_features.ts); resolve_features_test.ts pins all three together.
create or replace view public.pb_current_facts
with (security_invoker = true) as
  select distinct on (account_id, key)
    id, account_id, key, value, evidence_label, source, evidence_url,
    observed_at, entered_by, stand_in, note, created_at
  from public.pb_facts f
  order by
    account_id,
    key,
    case evidence_label when 'evidence' then 0 when 'inferred' then 1 else 2 end,
    case source
      when 'rater'          then 0
      when 'sales_meeting'  then 0
      when 'fathom_call'    then 1
      when 'pipedrive_note' then 2
      when 'website'        then 3
      when 'notion_master'  then 4
      when 'apollo'         then 5
      when 'pipedrive'      then 6
      else 7
    end,
    created_at desc,
    observed_at desc nulls last;

comment on view public.pb_current_facts is
  'One winning fact per (account, key): evidence label, then source precedence (rater = sales_meeting > fathom_call > pipedrive_note > website > notion_master > apollo > pipedrive > else), then newest written, then newest observed. Mirrors latestFactPerKey in ingest/resolve_features.ts and the rule9 CTE in pb_reconcile_state() — the three must not drift (CLAUDE.md rule 9, DECISIONS §65).';

do $$
declare v_opt text;
begin
  select option_value into v_opt
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         lateral pg_options_to_table(c.reloptions)
   where n.nspname = 'public' and c.relname = 'pb_current_facts' and option_name = 'security_invoker';
  if v_opt is distinct from 'true' then
    raise exception 'pb_current_facts lost security_invoker (got %)', coalesce(v_opt, 'null');
  end if;
end $$;

-- 7 · pb_meeting_supersede: the newest meeting's word wins, in any write order -------------------
-- A newer non-rejected row (proposed, approved or agrees) for the same (account, kind, key) moves an
-- older PROPOSED row to 'superseded'. "Same key" is the fact key for a fact, the topic for a read,
-- and nothing more for a tier call or a removal. Newer = the later meeting (held_at, then
-- recording_id); inside one meeting, the later line — except reads, which never supersede a read
-- of their own meeting (up to three per agency is the point). Only pairs touching p_recording_id
-- are considered. Service role (pb-notes, after it writes a meeting) and the two decision functions.
create or replace function public.pb_meeting_supersede(p_recording_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  with ranked as (
    select p.id, p.recording_id, p.account_id, p.kind, p.status, p.line_from,
           case p.kind when 'fact' then coalesce(p.key, '') when 'read' then coalesce(p.topic, '') else '' end as disc,
           coalesce(m.held_at, m.created_at) as held
      from public.pb_meeting_proposals p
      join public.pb_meetings m on m.recording_id = p.recording_id
     where p.account_id is not null
       and p.account_id in (select q.account_id from public.pb_meeting_proposals q
                             where q.recording_id = p_recording_id and q.account_id is not null)
  ),
  pick as (
    select o.id as old_id,
           (select n.id
              from ranked n
             where n.account_id = o.account_id and n.kind = o.kind and n.disc = o.disc
               and n.id <> o.id
               and n.status in ('proposed', 'approved', 'agrees')
               and (n.recording_id = p_recording_id or o.recording_id = p_recording_id)
               and not (n.kind = 'read' and n.recording_id = o.recording_id)
               and (n.held, n.recording_id, n.line_from, n.id::text) > (o.held, o.recording_id, o.line_from, o.id::text)
             order by n.held desc, n.recording_id desc, n.line_from desc, n.id::text desc
             limit 1) as new_id
      from ranked o
     where o.status = 'proposed'
  )
  update public.pb_meeting_proposals t
     set status = 'superseded', superseded_by = pick.new_id
    from pick
   where t.id = pick.old_id and pick.new_id is not null and t.status = 'proposed';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 8 · the five a person calls ------------------------------------------------------------------

-- pb_decide_meeting_card: one atomic call per agency card. Items are
--   [{id, decision: 'approve'|'reject'|'propose', overrule?: bool,
--     edit?: {value?, tier?, reason_code?, text?, expires_at?, disposition?, review_on?}}]
-- 1–20 items, every one locked FOR UPDATE, all on ONE placed account whose book is prospect or
-- parked. 'approve' and 'reject' take a 'proposed' row; 'propose' is [Propose anyway] and takes a
-- 'not_proposed' row (a question, joke or hypothetical) back to 'proposed', writing nothing else.
-- Owner or rater for facts, reads, rejects and propose; owner ONLY to approve a tier call or a
-- removal (rules 7, 7a). One wrong item refuses the whole card. Everything is re-derived here at
-- decision time (the §51 lesson): the page previews, this function decides.
create or replace function public.pb_decide_meeting_card(p_items jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me       text := public.pb_me();
  v_role     text := public.pb_role();
  v_n        integer;
  v_ids      uuid[];
  v_k        integer;
  v_acct     uuid;
  v_book     text;
  v_bad      text;
  v_spec     jsonb;
  v_codes    jsonb;
  v_item     jsonb;
  v_edit     jsonb;
  v_dec      text;
  p          public.pb_meeting_proposals%rowtype;
  v_status   text;
  v_held     text;
  v_overrule boolean;
  v_value    jsonb;
  v_cur_id   uuid;
  v_cur_val  jsonb;
  v_cur_lab  text;
  v_cur_src  text;
  v_same     boolean;
  v_tier     text;
  v_ctier    text;
  v_etier    text;
  v_code     text;
  v_text     text;
  v_exp      timestamptz;
  v_days     numeric;
  v_disp     text;
  v_rev      text;
  v_fact     uuid;
  v_reg      uuid;
  v_closed   integer;
  v_recs     text[] := '{}';
  v_r        text;
  c_approved integer := 0;
  c_rejected integer := 0;
  c_agrees   integer := 0;
  c_proposed integer := 0;
  c_facts    integer := 0;
  c_override integer := 0;
  c_removal  integer := 0;
  c_reads    integer := 0;
  c_closed   integer := 0;
  c_super    integer := 0;
begin
  if not coalesce(public.pb_is_wliq(), false) then
    raise exception 'not a WLIQ member';
  end if;
  if v_role is distinct from 'owner' and v_role is distinct from 'rater' then
    raise exception 'the % lane may not decide meeting proposals', coalesce(v_role, 'unknown');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items is a JSON array of {id, decision}';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 20 then
    raise exception 'a card carries 1 to 20 items, not %', v_n;
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where jsonb_typeof(e) <> 'object' or coalesce(e->>'id', '') = ''
                 or coalesce(e->>'decision', '') not in ('approve', 'reject', 'propose')) then
    raise exception 'each item is {id, decision} with decision approve, reject or propose';
  end if;
  select array_agg((e->>'id')::uuid) into v_ids from jsonb_array_elements(p_items) e;
  if (select count(distinct x) from unnest(v_ids) x) <> v_n then
    raise exception 'each item names a different proposal';
  end if;

  perform 1 from public.pb_meeting_proposals where id = any (v_ids) order by id for update;
  if (select count(*) from public.pb_meeting_proposals where id = any (v_ids)) <> v_n then
    raise exception 'no such meeting proposal';
  end if;

  select string_agg(distinct m.status || ' (' || (e->>'decision') || ')', ', ') into v_bad
    from jsonb_array_elements(p_items) e
    join public.pb_meeting_proposals m on m.id = (e->>'id')::uuid
   where ((e->>'decision') = 'propose' and m.status <> 'not_proposed')
      or ((e->>'decision') <> 'propose' and m.status <> 'proposed');
  if v_bad is not null then
    raise exception 'only an open proposal is decided, and only a not-proposed one is proposed; this card holds %', v_bad;
  end if;

  if exists (select 1 from public.pb_meeting_proposals m where m.id = any (v_ids) and m.account_id is null) then
    raise exception 'place this name first (Who is this?): a proposal with no agency cannot be decided';
  end if;
  select count(distinct m.account_id), min(m.account_id::text)::uuid into v_k, v_acct
    from public.pb_meeting_proposals m where m.id = any (v_ids);
  if v_k <> 1 then
    raise exception 'a card is one agency; these proposals name % agencies', v_k;
  end if;
  select a.book into v_book from public.pb_accounts a where a.id = v_acct;
  if v_book is null or v_book not in ('prospect', 'parked') then
    raise exception 'that agency is % in the book; only a prospect or parked agency takes a meeting decision',
      coalesce(v_book, 'missing');
  end if;

  if v_role <> 'owner' and exists (
       select 1 from jsonb_array_elements(p_items) e
         join public.pb_meeting_proposals m on m.id = (e->>'id')::uuid
        where (e->>'decision') = 'approve' and m.kind in ('override', 'removal')) then
    raise exception 'approving a tier call or a removal is the owner''s lane (rules 7 and 7a); the % lane may '
                    'approve facts and reads, and reject anything', v_role;
  end if;

  select r.spec into v_spec from public.pb_rubric_versions r
   where r.status = 'active' order by r.activated_at desc nulls last limit 1;

  for v_item in select e from jsonb_array_elements(p_items) e loop
    select * into p from public.pb_meeting_proposals where id = (v_item->>'id')::uuid;
    v_dec  := v_item->>'decision';
    v_edit := coalesce(v_item->'edit', '{}'::jsonb);
    if jsonb_typeof(v_edit) <> 'object' then
      raise exception 'edit is an object';
    end if;
    v_overrule := coalesce((v_item->>'overrule')::boolean, false);
    v_held := to_char(p.held_on, 'YYYY-MM-DD');

    if v_dec = 'propose' then
      update public.pb_meeting_proposals set status = 'proposed' where id = p.id;
      c_proposed := c_proposed + 1;
      continue;
    end if;

    if v_dec = 'reject' then
      update public.pb_meeting_proposals
         set status = 'rejected', decided_by = v_me, decided_at = now(), decision_note = p_note
       where id = p.id;
      c_rejected := c_rejected + 1;
      continue;
    end if;

    -- approve
    v_status := 'approved';
    v_fact := null;
    v_reg := null;

    if p.kind = 'fact' then
      v_value := case when v_edit ? 'value' then v_edit->'value' else p.value end;
      if v_value is null or jsonb_typeof(v_value) = 'null' then
        raise exception '% needs a value', p.key;
      end if;
      if jsonb_typeof(v_value) <> jsonb_typeof(p.value) then
        raise exception 'an edited % keeps its shape (% expected, % given)', p.key, jsonb_typeof(p.value), jsonb_typeof(v_value);
      end if;
      v_cur_id := null; v_cur_val := null; v_cur_lab := null; v_cur_src := null;
      select f.id, f.value, f.evidence_label, f.source into v_cur_id, v_cur_val, v_cur_lab, v_cur_src
        from public.pb_current_facts f where f.account_id = v_acct and f.key = p.key;
      if v_cur_id is not null and v_cur_lab = 'evidence' and v_cur_src in ('rater', 'sales_meeting') then
        v_same := case
          when jsonb_typeof(v_cur_val) = 'array' and jsonb_typeof(v_value) = 'array' then
            (select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) from jsonb_array_elements(v_cur_val) x)
            = (select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) from jsonb_array_elements(v_value) x)
          else v_cur_val = v_value end;
        if v_same then
          v_status := 'agrees';
        elsif not v_overrule then
          raise exception '% differs from what a person recorded (% from %); tick overrule to replace it on purpose',
            p.key, v_cur_val, v_cur_src;
        end if;
      end if;
      if v_status = 'approved' then
        -- No quote and no link: pb_facts is readable by every signed-in address. The words stay on
        -- the proposal, behind the owner and rater lanes.
        insert into public.pb_facts
          (account_id, key, value, evidence_label, source, evidence_url, note, observed_at, entered_by, stand_in,
           meeting_proposal_id)
        values (v_acct, p.key, v_value, 'evidence', 'sales_meeting', null,
                'From the internal sales meeting of ' || v_held || ' (' || p.quote_at || '); confirmed by ' || v_me || '.',
                p.held_on, v_me, false, p.id)
        returning id into v_fact;
        c_facts := c_facts + 1;

        -- The one valuable side effect pb_review_fact_candidate had, kept: the machine claims
        -- waiting on this key are answered.
        update public.pb_fact_candidates
           set status = 'superseded', reviewed_by = v_me, reviewed_at = now(),
               note = coalesce(note, '') || ' [closed: answered in the sales meeting of ' || v_held || ']'
         where account_id = v_acct and key = p.key and status = 'proposed';
        get diagnostics v_closed = row_count;
        c_closed := c_closed + v_closed;

        insert into public.pb_register (kind, account_id, made_by, text, payload)
        values ('note', v_acct, v_me,
                'Confirmed ' || p.key || ' from the sales meeting of ' || v_held || '; it is now a fact ('
                  || v_closed || ' machine claim(s) on that key closed).',
                jsonb_build_object('origin', 'sales_meeting', 'proposal_id', p.id, 'recording_id', p.recording_id,
                                   'quote_at', p.quote_at, 'key', p.key, 'fact_id', v_fact,
                                   'candidates_closed', v_closed, 'overruled', v_overrule and v_cur_id is not null));
      end if;

    elsif p.kind = 'override' then
      v_tier := coalesce(nullif(v_edit->>'tier', ''), p.tier);
      if not exists (select 1 from jsonb_array_elements_text(coalesce(v_spec->'vocabulary'->'tiers', '[]'::jsonb)) t
                      where t = v_tier) then
        raise exception 'tier % is not in the active rubric''s vocabulary.tiers', coalesce(v_tier, '(none)');
      end if;
      v_codes := coalesce(v_spec->'override'->'reason_codes', '[]'::jsonb);
      v_code := coalesce(nullif(v_edit->>'reason_code', ''), p.reason_code,
                         case when v_codes ? 'relationship_known' then 'relationship_known' end);
      if v_code is null or not (v_codes ? v_code) then
        raise exception 'reason code % is not one of the rubric''s override.reason_codes %', coalesce(v_code, '(none)'), v_codes;
      end if;
      v_text := btrim(case when v_edit ? 'text' then coalesce(v_edit->>'text', '') else coalesce(p.default_text, '') end);
      if v_text = '' then
        raise exception 'an override needs a written reason (rule 7)';
      end if;
      if v_edit ? 'expires_at' and jsonb_typeof(v_edit->'expires_at') <> 'null' then
        v_exp := (v_edit->>'expires_at')::timestamptz;
      else
        v_days := (v_spec->'override'->>'expiry_default_days')::numeric;
        if v_days is null or v_days <= 0 then
          raise exception 'the active rubric names no override.expiry_default_days; set an expiry on the card';
        end if;
        v_exp := now() + v_days::double precision * interval '1 day';
      end if;
      if v_exp <= now() then
        raise exception 'an override expires in the future, not %', v_exp;
      end if;
      v_ctier := null; v_etier := null;
      select r.computed_tier, r.effective_tier into v_ctier, v_etier
        from public.pb_current_reads r where r.account_id = v_acct;
      if v_ctier is null then
        raise exception 'the engine refuses an override until this account has a computed tier';
      end if;
      if lower(v_tier) = lower(v_ctier) then
        raise exception 'anticipated % is already the computed tier; an override to it changes nothing', v_tier;
      end if;
      if lower(v_tier) = lower(coalesce(v_etier, '')) then
        v_status := 'agrees';                         -- a live override already says it
      else
        insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at)
        values ('override', v_acct, v_me, v_code, v_text,
                jsonb_build_object('tier', v_tier, 'reason_code', v_code, 'expires_at', v_exp,
                                   'origin', 'sales_meeting', 'proposal_id', p.id, 'recording_id', p.recording_id,
                                   'quote_at', p.quote_at),
                v_exp)
        returning id into v_reg;
        c_override := c_override + 1;
      end if;

    elsif p.kind = 'removal' then
      v_disp := coalesce(nullif(v_edit->>'disposition', ''), p.disposition);
      v_code := coalesce(nullif(v_edit->>'reason_code', ''), p.reason_code);
      if v_disp is null or v_code is null then
        raise exception 'a removal needs a disposition and a reason code; pick them on the card';
      end if;
      if exists (select 1 from public.pb_removals x where x.account_id = v_acct) then
        v_status := 'agrees';                         -- already off the board
      else
        v_text := btrim(case when v_edit ? 'text' then coalesce(v_edit->>'text', '') else coalesce(p.default_text, '') end);
        v_rev := nullif(v_edit->>'review_on', '');
        -- Passed through on purpose: pb_register_removal_guard refuses any expiry, a pair that is not
        -- an active pb_removal_reasons row, and a review date where none is allowed (rule 7a).
        v_exp := case when v_edit ? 'expires_at' and jsonb_typeof(v_edit->'expires_at') <> 'null'
                      then (v_edit->>'expires_at')::timestamptz end;
        insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at)
        values ('removal', v_acct, v_me, v_code, v_text,
                jsonb_strip_nulls(jsonb_build_object('disposition', v_disp, 'review_on', v_rev,
                                                     'origin', 'sales_meeting', 'proposal_id', p.id,
                                                     'recording_id', p.recording_id)),
                v_exp)
        returning id into v_reg;
        c_removal := c_removal + 1;
      end if;

    elsif p.kind = 'read' then
      -- The quote only; the model never paraphrases and neither does this.
      insert into public.pb_register (kind, account_id, made_by, text, payload)
      values ('note', v_acct, v_me,
              '"' || p.quote || '" — sales meeting ' || v_held || ' (' || coalesce(p.topic, 'other') || ')',
              jsonb_build_object('origin', 'sales_meeting', 'proposal_id', p.id, 'recording_id', p.recording_id,
                                 'quote_at', p.quote_at, 'topic', p.topic))
      returning id into v_reg;
      c_reads := c_reads + 1;
    end if;

    update public.pb_meeting_proposals
       set status = v_status, decided_by = v_me, decided_at = now(), decision_note = p_note,
           result_id = coalesce(v_fact, v_reg)
     where id = p.id;
    if v_status = 'agrees' then c_agrees := c_agrees + 1; else c_approved := c_approved + 1; end if;
    if not (p.recording_id = any (v_recs)) then v_recs := v_recs || p.recording_id; end if;
  end loop;

  -- Every approval supersedes the older proposed rows of the same (account, kind, key).
  foreach v_r in array v_recs loop
    c_super := c_super + public.pb_meeting_supersede(v_r);
  end loop;

  return jsonb_build_object(
    'ok', true, 'account_id', v_acct,
    'approved', c_approved, 'rejected', c_rejected, 'agrees', c_agrees, 'proposed', c_proposed,
    'facts', c_facts, 'overrides', c_override, 'removals', c_removal, 'reads', c_reads,
    'candidates_closed', c_closed, 'superseded', c_super);
end $$;

-- pb_assign_meeting_mention: 'Who is this?' and [Wrong agency]. Owner or rater.
--   assign         the open rows of (meeting, said_key) go to p_account (matched_on 'person'); the
--                  name is remembered unless p_remember is false; then the newest word wins again.
--   unassign       the wrong agency: back to 'Who is this?', and a learned name that pointed there
--                  is forgotten.
--   not_in_book / not_an_agency   those rows are rejected with that note.
-- "Open" is proposed, not_proposed or agrees; an 'agrees' computed against one account means nothing
-- for another, so a re-pointed row goes back to 'proposed'.
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
     and status in ('proposed', 'not_proposed', 'agrees')
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
           status = case when status = 'agrees' then 'proposed' else status end
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees');
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
       and status in ('proposed', 'not_proposed', 'agrees') and account_id is not null;
    update public.pb_meeting_proposals
       set account_id = null, matched_on = null, mention_state = 'ambiguous',
           status = case when status = 'agrees' then 'proposed' else status end
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees');
    get diagnostics v_n = row_count;
    update public.pb_meeting_aliases
       set active = false
     where said_key = p_said_key and account_id = any (coalesce(v_old, '{}'::uuid[])) and active;
    get diagnostics v_forgot = row_count;

  else
    update public.pb_meeting_proposals
       set status = 'rejected', decided_by = v_me, decided_at = now(),
           decision_note = case p_decision when 'not_in_book' then 'not in the book' else 'not an agency' end
     where recording_id = p_recording_id and said_key = p_said_key
       and status in ('proposed', 'not_proposed', 'agrees');
    get diagnostics v_n = row_count;
  end if;

  return jsonb_build_object(
    'ok', true, 'decision', p_decision, 'recording_id', p_recording_id, 'said_key', p_said_key,
    'account_id', case when p_decision = 'assign' then p_account end,
    'rows', v_n, 'remembered', v_learned, 'forgotten', v_forgot, 'superseded', v_super);
end $$;

-- pb_meeting_include: the owner's say on one meeting. skipped ↔ waiting; a meeting being read, read
-- or partial is never moved, nor a duplicate; an external speaker or a missing transcript stays a
-- refusal whatever the owner says (an internal meeting is the only kind this reads).
create or replace function public.pb_meeting_include(p_recording_id text, p_include boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m        public.pb_meetings%rowtype;
  v_status text;
  v_skip   text;
begin
  if not coalesce(public.pb_is_wliq(), false) then
    raise exception 'not a WLIQ member';
  end if;
  if public.pb_role() is distinct from 'owner' then
    raise exception 'which meetings are read is the owner''s lane';
  end if;
  if p_include is null then
    raise exception 'say true (read this meeting) or false (do not)';
  end if;
  select * into m from public.pb_meetings where recording_id = p_recording_id for update;
  if not found then
    raise exception 'no such meeting';
  end if;
  if m.status in ('reading', 'read', 'partial', 'duplicate') then
    return jsonb_build_object('ok', true, 'changed', false, 'recording_id', m.recording_id, 'status', m.status,
      'include', m.include,
      'note', case when m.status = 'duplicate'
                   then 'a duplicate recording is never read; its meeting is read from the representative'
                   else 'a meeting being read or already read is not moved; dismiss its open proposals instead' end);
  end if;

  v_status := m.status;
  v_skip := m.skip_reason;
  if p_include then
    if m.status = 'skipped' and m.skip_reason in ('not_selected', 'owner_excluded') then
      v_status := 'waiting';
      v_skip := null;
    end if;
  else
    if m.status in ('waiting', 'failed') then
      v_status := 'skipped';
      v_skip := 'owner_excluded';
    elsif m.status = 'skipped' and m.skip_reason = 'not_selected' then
      v_skip := 'owner_excluded';
    end if;
  end if;

  update public.pb_meetings
     set include = p_include, selected_by = 'owner', status = v_status, skip_reason = v_skip
   where recording_id = m.recording_id;

  return jsonb_build_object('ok', true, 'changed', v_status is distinct from m.status,
    'recording_id', m.recording_id, 'include', p_include, 'status', v_status, 'skip_reason', v_skip);
end $$;

-- pb_meeting_title_rule: read (true), never read (false), or forget (null) every meeting with this
-- exact normalised title. Then re-select the meetings of that title the owner has not ruled on one by
-- one and that are not being read or read.
create or replace function public.pb_meeting_title_rule(p_title_norm text, p_read boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      text := public.pb_me();
  -- normTitle() in ingest/meeting_transcript.ts: whitespace collapsed, trimmed, lower-cased.
  v_t       text := lower(btrim(regexp_replace(coalesce(p_title_norm, ''), '\s+', ' ', 'g')));
  -- MEETING_TITLE_PATTERNS (ingest/meeting_transcript.ts) in Postgres's word-boundary spelling:
  -- \m starts a word, \M ends one. meeting_privacy_static_test.ts pins the two lists together. Used
  -- only when a rule is forgotten, to fall back to what the pattern says.
  v_pattern constant text[] := array['\msales\M', '\mprospect', '\mgrading\M'];
  v_hit     boolean;
  v_n       integer := 0;
begin
  if not coalesce(public.pb_is_wliq(), false) then
    raise exception 'not a WLIQ member';
  end if;
  if public.pb_role() is distinct from 'owner' then
    raise exception 'which meetings are read is the owner''s lane';
  end if;
  if v_t = '' then
    raise exception 'a title rule names a title';
  end if;
  v_hit := exists (select 1 from unnest(v_pattern) x where v_t ~* x);

  if p_read is null then
    delete from public.pb_meeting_title_rules where title_norm = v_t;
  else
    insert into public.pb_meeting_title_rules (title_norm, read, set_by, set_at)
    values (v_t, p_read, v_me, now())
    on conflict (title_norm) do update
      set read = excluded.read, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;

  with sel as (
    select m.recording_id,
           coalesce(p_read, v_hit) as selected,
           case when p_read is not null then 'title_rule' when v_hit then 'pattern' else 'none' end as by_what
      from public.pb_meetings m
     where m.title_norm = v_t and m.include is null
       and m.status in ('waiting', 'skipped', 'failed')
       and (m.status <> 'skipped' or m.skip_reason = 'not_selected')
  )
  update public.pb_meetings m
     set selected_by = sel.by_what,
         status = case when sel.selected and m.status = 'skipped' then 'waiting'
                       when not sel.selected and m.status in ('waiting', 'failed') then 'skipped'
                       else m.status end,
         skip_reason = case when sel.selected and m.status = 'skipped' then null
                            when not sel.selected and m.status in ('waiting', 'failed') then 'not_selected'
                            else m.skip_reason end
    from sel
   where m.recording_id = sel.recording_id;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'title_norm', v_t, 'read', p_read, 'meetings_reselected', v_n);
end $$;

-- pb_dismiss_meeting: [Dismiss meeting]. Rejects every still-proposed row of that meeting and writes
-- nothing else. Owner or rater.
create or replace function public.pb_dismiss_meeting(p_recording_id text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   text := public.pb_me();
  v_role text := public.pb_role();
  v_n    integer := 0;
begin
  if not coalesce(public.pb_is_wliq(), false) then
    raise exception 'not a WLIQ member';
  end if;
  if v_role is distinct from 'owner' and v_role is distinct from 'rater' then
    raise exception 'the % lane may not dismiss a meeting', coalesce(v_role, 'unknown');
  end if;
  if not exists (select 1 from public.pb_meetings where recording_id = p_recording_id) then
    raise exception 'no such meeting';
  end if;
  update public.pb_meeting_proposals
     set status = 'rejected', decided_by = v_me, decided_at = now(),
         decision_note = coalesce(nullif(btrim(p_note), ''), 'dismissed with the meeting')
   where recording_id = p_recording_id and status = 'proposed';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'recording_id', p_recording_id, 'rejected', v_n);
end $$;

-- 9 · pb_dossier(uuid), rebuilt from the live body with the three §65 filters -------------------
-- The live definition (pg_get_functiondef md5 d7066184…, prosrc md5 ab44f7fd…) is byte-identical to
-- the body 20260918100400 wrote; the three edits are marked "§65" in place. Signature, language,
-- volatility, SECURITY DEFINER, search_path and the grants (create-or-replace keeps them) unchanged.
create or replace function public.pb_dossier(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  -- Built exactly as before; the address scrub is the last thing that happens to it.
  with raw as (
    select jsonb_build_object(
        'account', (
          select jsonb_build_object(
            'id', a.id, 'name', a.name, 'domain', a.domain, 'linkedin_url', a.linkedin_url,
            'roster_source', a.roster_source, 'roster_certified', a.roster_certified,
            'lineage', a.lineage, 'relationship_type', a.relationship_type)
          from pb_accounts a where a.id = p_account_id),

        'read', (
          select jsonb_build_object(
            'effective_tier', r.effective_tier, 'cell', r.cell, 'ceiling', r.ceiling,
            'headroom_band', r.headroom_band, 'year1_band', r.year1_band,
            'facts_present', r.facts_present, 'qualification_label', r.qualification_label,
            'confidence', r.confidence, 'confidence_grade', r.confidence_grade,
            'status', r.status, 'urgency', r.urgency, 'flags', r.flags,
            'reason', r.reason, 'as_of', r.as_of,
            'rubric_version', r.rubric_version, 'rubric_fingerprint', r.rubric_fingerprint,
            -- §65: a meeting-origin override's written reason is the team's own quote, and the
            -- trace carries it at override.reason (measured: nowhere else; r.reason carries only
            -- the code). Over-redaction is the cheap direction: once the account has ANY such
            -- override, the reason and the approver leave the trace of every read.
            'trace', case when exists (
                       select 1 from pb_register g
                        where g.account_id = p_account_id and g.kind = 'override'
                          and g.payload->>'origin' = 'sales_meeting')
                     then r.scorecard #- '{override,reason}' #- '{override,approver}'
                     else r.scorecard end)
          from pb_current_reads r where r.account_id = p_account_id),

        'brief', (
          select jsonb_build_object(
            'generated_at', b.generated_at, 'author', b.author, 'brief', b.brief,
            'location', b.location, 'headcount', b.headcount,
            'headcount_confidence', b.headcount_confidence,
            'confidence', b.confidence, 'next_step', b.next_step)
          from pb_briefs b
          where b.account_id = p_account_id and b.superseded_at is null
          order by b.generated_at desc limit 1),

        'research', (
          select jsonb_build_object(
            'read_at', ar.read_at, 'reader', ar.reader, 'method', ar.method,
            'site_found', ar.site_found, 'summary', ar.summary,
            'confidence', ar.confidence, 'verified', ar.verified, 'verdict', ar.verdict,
            'fields', ar.fields)
          from pb_account_reads ar
          where ar.account_id = p_account_id and ar.superseded_at is null
          order by ar.read_at desc limit 1),

        'people', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', c.name, 'title', c.title, 'seniority', c.seniority,
            'is_decision_maker', c.is_decision_maker, 'source', c.source,
            'last_job_change_at', c.last_job_change_at)
            order by c.is_decision_maker desc nulls last, c.name)
          from pb_contacts c where c.account_id = p_account_id), '[]'::jsonb),

        'calls', coalesce((
          select jsonb_agg(jsonb_build_object(
            'held_at', k.held_at, 'title', k.title, 'url', k.url,
            'recorded_by', k.recorded_by,
            -- names and side only; the address never leaves the database
            'attendees', (
              select coalesce(jsonb_agg(jsonb_build_object(
                'name', at->>'name', 'is_external', at->'is_external')), '[]'::jsonb)
              from jsonb_array_elements(coalesce(k.attendees, '[]'::jsonb)) at),
            'summary', left(k.summary, 2000), 'extraction_status', k.extraction_status)
            order by k.held_at desc)
          from (select * from pb_calls where account_id = p_account_id
                order by held_at desc limit 12) k), '[]'::jsonb),

        'events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'occurred_at', e.occurred_at, 'channel', e.channel,
            'direction', e.direction, 'source', e.source, 'subject', left(e.subject, 200))
            order by e.occurred_at desc)
          from (select * from pb_contact_events where account_id = p_account_id
                order by occurred_at desc limit 40) e), '[]'::jsonb),

        'facts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'key', f.key, 'value', f.value, 'evidence_label', f.evidence_label,
            'source', f.source, 'observed_at', f.observed_at, 'entered_by', f.entered_by,
            'evidence_url', f.evidence_url, 'note', f.note)
            order by f.key)
          -- §65: a fact a sales meeting settled is the team's judgement, signed-in only. The key
          -- is simply absent here; no machine value is substituted for the one the engine used.
          from pb_current_facts f
          where f.account_id = p_account_id and f.source <> 'sales_meeting'), '[]'::jsonb),

        'signals', coalesce((
          select jsonb_agg(jsonb_build_object(
            'type', s.type, 'source', s.source, 'observed_at', s.observed_at,
            'weight', s.weight, 'decays', s.decays, 'lifespan_days', s.lifespan_days,
            'payload', s.payload, 'evidence_url', s.evidence_url)
            order by s.observed_at desc)
          from (select * from pb_signals where account_id = p_account_id
                order by observed_at desc limit 40) s), '[]'::jsonb),

        -- THE ONE CHANGE. A removal's written reason is not the public's business, and a definer
        -- function has to say so itself: the anon policy on pb_register cannot reach in here.
        'register', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', g.kind, 'made_by', g.made_by, 'reason_code', g.reason_code,
            'text', g.text, 'created_at', g.created_at, 'expires_at', g.expires_at)
            order by g.created_at desc)
          from (select * from pb_register where account_id = p_account_id
                  and kind <> all (array['removal', 'reinstatement'])
                  -- §65: nothing a sales meeting put on the register is public — its overrides,
                  -- its reads, its fact confirmations. The board shows the effect, never the words.
                  and coalesce(payload->>'origin', '') <> 'sales_meeting'
                order by created_at desc limit 20) g), '[]'::jsonb),

    -- Quotes on record. A lost quote is the first thing to explain before re-approaching, so it
    -- belongs in the dossier and not only in the CRM.
    'deals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', dl.title, 'value', dl.value, 'currency', dl.currency,
        'status', dl.status, 'stage_name', dl.stage_name, 'close_date', dl.close_date,
        'health', dl.health, 'is_cj', dl.is_cj)
        order by dl.close_date desc nulls last)
      from (select * from pb_deals where account_id = p_account_id
            order by close_date desc nulls last limit 20) dl), '[]'::jsonb),

    -- What was read out of calls and notes and NOT written, and why it waits. Counts only: the
    -- claims themselves are a reviewer's screen, behind sign-in, not a public dossier's business.
    'candidates', (
      select jsonb_build_object(
        'n', count(*),
        'high', count(*) filter (where confidence = 'high'),
        'conflicts', count(*) filter (where conflicts),
        'keys', coalesce(jsonb_agg(distinct key), '[]'::jsonb))
      from pb_fact_candidates
      where account_id = p_account_id and status = 'proposed'),

        'apollo', (
          select jsonb_build_object(
            'org_name', ap.org_name, 'employees', ap.employees, 'industry', ap.industry,
            'eng_headcount', ap.eng_headcount, 'revenue', ap.revenue,
            'founded_year', ap.founded_year, 'build_keywords', ap.build_keywords,
            'fetched_at', ap.fetched_at)
          from pb_apollo_enrichment ap
          join pb_accounts a2 on lower(a2.domain) = lower(ap.domain)
          where a2.id = p_account_id and ap.matched limit 1)
      ) as j
  )
  select regexp_replace(
           raw.j::text,
           '([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
           '\1',
           'g'
         )::jsonb
    from raw;
$function$;

-- 10 · pb_reconcile_state(), rebuilt from the live body ----------------------------------------
-- The live definition (pg_get_functiondef md5 868704ff…, prosrc md5 d6c124b7…) is byte-identical to
-- the body 20260923211200 wrote. Three edits: the rule9 CASE gains 'sales_meeting' at 0, and two new
-- top-level keys, counts only; every existing key is unchanged.
--   meeting_privacy {checked, leaks}   For the 20 accounts with the newest approved proposals,
--       pb_dossier(account)::text normalised to [a-z0-9 ]. A hit is the first 40 normalised
--       characters of an approved quote, or of an origin='sales_meeting' register text (24
--       characters or more), found in that account's dossier; plus every dossier carrying the
--       literal 'sales_meeting'. scripts/reconcile.ts check 6 FAILS on leaks > 0.
--       NOT the pb_board() text, and 20 rather than 50 dossiers, on a measurement: CI calls this as
--       anon, whose statement_timeout is 3 s; this function already takes 1.4–2.0 s, 50 dossiers add
--       ~0.6 s and rendering pb_board() ~0.8–1.3 s (10 Oct 2026). A canary that times out turns CI
--       red for the wrong reason every six hours. pb_board() prints no register, fact or proposal
--       text (name, tiers, labels, flags, engagement), which meeting_privacy_static_test.ts pins
--       on its newest definition, and scripts/meeting_privacy_check.sql reads it as anon.
--   meetings_work {selected_7d, read_7d, failed_7d, stale_reading, oldest_open_days}   check 7 warns.
create or replace function public.pb_reconcile_state() returns jsonb
language sql stable security definer set search_path = public, supabase_migrations as
$$
with active as (
  select version, spec, activated_at
  from public.pb_rubric_versions where status = 'active'
  order by activated_at desc nulls last limit 1
),
rule9 as (
  select count(*) filter (where v.id <> r.id) as mismatches
  from public.pb_current_facts v
  join (
    select distinct on (account_id, key) id, account_id, key
    from public.pb_facts
    order by account_id, key,
      case evidence_label when 'evidence' then 0 when 'inferred' then 1 else 2 end,
      case source when 'rater' then 0 when 'sales_meeting' then 0 when 'fathom_call' then 1
                  when 'pipedrive_note' then 2 when 'website' then 3 when 'notion_master' then 4
                  when 'apollo' then 5 when 'pipedrive' then 6 else 7 end,
      created_at desc, observed_at desc nulls last
  ) r on r.account_id = v.account_id and r.key = v.key
),
notes_runs as (
  select id, status, started_at, finished_at,
         (case when jsonb_typeof(counts->'facts') = 'number' then (counts->>'facts')::numeric else 0 end)
       + (case when jsonb_typeof(counts->'candidates') = 'number' then (counts->>'candidates')::numeric else 0 end)
           as written
  from public.pb_runs
  where kind = 'ingest' and source = 'written_record' and finished_at is not null
),
notes_latest as (
  select r.id, r.status, r.started_at, r.finished_at, r.counts
  from public.pb_runs r
  join (select id from notes_runs order by finished_at desc limit 1) l on l.id = r.id
),
notes_num as (
  select e.key as k, (e.value #>> '{}')::numeric as n
  from notes_latest l, jsonb_each(coalesce(l.counts, '{}'::jsonb)) e
  where jsonb_typeof(e.value) = 'number'
),
notes_productive as (
  select max(finished_at) as at from notes_runs where written > 0
),
-- §65 · meeting_privacy: the accounts whose newest approvals are freshest, the words those
-- approvals put on record, and those accounts' public dossiers, all normalised to [a-z0-9 ].
mp_accounts as (
  select p.account_id
  from public.pb_meeting_proposals p
  where p.status = 'approved' and p.account_id is not null
  group by p.account_id
  order by max(p.decided_at) desc nulls last, p.account_id
  limit 20
),
mp_needles as (
  select x.account_id, left(x.t, 40) as needle
  from (
    select p.account_id, btrim(regexp_replace(lower(p.quote), '[^a-z0-9]+', ' ', 'g')) as t
    from public.pb_meeting_proposals p
    where p.status = 'approved' and p.account_id in (select account_id from mp_accounts)
    union
    select g.account_id, btrim(regexp_replace(lower(g.text), '[^a-z0-9]+', ' ', 'g'))
    from public.pb_register g
    where g.payload->>'origin' = 'sales_meeting' and g.account_id in (select account_id from mp_accounts)
  ) x
  where char_length(x.t) >= 24
),
mp_docs as materialized (
  select a.account_id, d.raw, btrim(regexp_replace(lower(d.raw), '[^a-z0-9]+', ' ', 'g')) as norm
  from mp_accounts a, lateral (select public.pb_dossier(a.account_id)::text as raw) d
)
select jsonb_build_object(
  'generated_at', now(),
  'active_rubric', (select jsonb_build_object('version', version, 'activated_at', activated_at, 'spec', spec) from active),
  'reads_on_active', (select jsonb_build_object('accounts', count(*), 'fingerprints', coalesce(jsonb_agg(distinct cr.rubric_fingerprint), '[]'::jsonb))
                        from public.pb_current_reads cr, active a where cr.rubric_version = a.version),
  'applied_migrations', (select coalesce(jsonb_agg(name order by version), '[]'::jsonb)
                           from supabase_migrations.schema_migrations where name ilike 'prospect_book%'),
  'sources', jsonb_build_object(
    'fathom', jsonb_build_object(
      'newest_call_held_at', (select max(held_at) from public.pb_calls),
      'newest_external_verified_delivery_at', (select max(received_at) from public.pb_webhook_inbox
         where source = 'fathom' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%'),
      'external_verified_deliveries', (select count(*) from public.pb_webhook_inbox
         where source = 'fathom' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%')),
    'pipedrive', jsonb_build_object(
      'newest_external_verified_delivery_at', (select max(received_at) from public.pb_webhook_inbox
         where source = 'pipedrive' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%'),
      'external_verified_deliveries', (select count(*) from public.pb_webhook_inbox
         where source = 'pipedrive' and verified and coalesce(headers->>'user-agent','') not ilike 'pg_net%')),
    'score_run', jsonb_build_object('newest_success_finished_at',
      (select max(finished_at) from public.pb_runs where kind = 'score' and status = 'success')),
    'notes_run', jsonb_build_object('newest_success_finished_at',
      (select max(finished_at) from public.pb_runs where kind = 'ingest' and source = 'written_record' and status in ('success','partial')))
  ),
  'rule9_mismatches', (select mismatches from rule9),
  'live_accounts', (select count(*) from public.pb_accounts where book in ('prospect','parked')),
  'notes_work', jsonb_build_object(
    'latest', (select jsonb_build_object(
        'status', l.status,
        'started_at', l.started_at,
        'finished_at', l.finished_at,
        'facts',            (select n from notes_num where k = 'facts'),
        'candidates',       (select n from notes_num where k = 'candidates'),
        'wrote',            (select n from notes_num where k = 'wrote'),
        'errors',           (select n from notes_num where k = 'errors'),
        'halted',           (select n from notes_num where k = 'halted'),
        'extractor_failed', (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.extractor_failed$'),
        'extractor_halted', (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.extractor_halted$'),
        'pulled',           (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.pulled$'),
        'planned',          (select sum(n) from notes_num where k ~ '^[a-z0-9_]+\.planned$'))
      from notes_latest l),
    'newest_productive_finished_at', (select at from notes_productive),
    'runs_since_productive', (select count(*) from notes_runs, notes_productive p
                                where p.at is null or notes_runs.finished_at > p.at),
    'finished_runs_7d', (select count(*) from notes_runs where finished_at > now() - interval '7 days')),
  'meeting_privacy', jsonb_build_object(
    'checked', (select count(*) from mp_docs),
    'leaks', (select count(*) from mp_needles n join mp_docs d on d.account_id = n.account_id
               where position(n.needle in d.norm) > 0)
           + (select count(*) from mp_docs d where position('sales_meeting' in d.raw) > 0)),
  'meetings_work', jsonb_build_object(
    'selected_7d', (select count(*) from public.pb_meetings m
                     where m.status in ('waiting', 'reading', 'read', 'partial', 'failed')
                       and coalesce(m.held_at, m.created_at) > now() - interval '7 days'),
    'read_7d', (select count(*) from public.pb_meetings m
                 where m.status in ('read', 'partial') and m.read_at > now() - interval '7 days'),
    'failed_7d', (select count(*) from public.pb_meetings m
                   where m.status = 'failed' and m.updated_at > now() - interval '7 days'),
    'stale_reading', (select count(*) from public.pb_meetings m
                       where m.status = 'reading'
                         and (m.read_started_at is null or m.read_started_at < now() - interval '3 hours')),
    'oldest_open_days', (select round((extract(epoch from (now() - min(p.created_at))) / 86400)::numeric, 1)
                          from public.pb_meeting_proposals p where p.status = 'proposed'))
);
$$;

comment on function public.pb_reconcile_state() is
  'Declared-vs-running facts for scripts/reconcile.ts: active rubric, applied migration names, source liveness (external deliveries only), rule-9 mismatch count, whether the latest notes run did any work, whether any sales-meeting quote reaches pb_dossier() or pb_board() (meeting_privacy), and whether the meeting reader is keeping up (meetings_work). Counts only — never a quote, a name or pb_runs.errors; callable by anon (DECISIONS §34, §65).';

-- 11 · privileges ------------------------------------------------------------------------------
-- The 20260918160352 lesson: a new function arrives executable by PUBLIC (and, here, by the project's
-- default privileges for anon, authenticated and service_role). Revoke all, then grant exactly.
revoke all on function public.pb_decide_meeting_card(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.pb_assign_meeting_mention(text, text, text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.pb_meeting_include(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.pb_meeting_title_rule(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.pb_dismiss_meeting(text, text) from public, anon, authenticated, service_role;
revoke all on function public.pb_meeting_supersede(text) from public, anon, authenticated, service_role;

grant execute on function public.pb_decide_meeting_card(jsonb, text) to authenticated;
grant execute on function public.pb_assign_meeting_mention(text, text, text, uuid, boolean) to authenticated;
grant execute on function public.pb_meeting_include(text, boolean) to authenticated;
grant execute on function public.pb_meeting_title_rule(text, boolean) to authenticated;
grant execute on function public.pb_dismiss_meeting(text, text) to authenticated;
grant execute on function public.pb_meeting_supersede(text) to service_role;

do $$
declare
  v_t   text;
  v_f   text;
  v_def text;
  v_n   text;
begin
  -- The dossier still carries every earlier ruling, and the three new ones.
  v_def := pg_get_functiondef('public.pb_dossier(uuid)'::regprocedure);
  foreach v_n in array array[
    '''linkedin_url'', a.linkedin_url',
    'kind <> all (array[''removal'', ''reinstatement''])',
    '''([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}''',
    '''name'', at->>''name'', ''is_external'', at->''is_external''',
    'f.source <> ''sales_meeting''',
    'coalesce(payload->>''origin'', '''') <> ''sales_meeting''',
    '#- ''{override,reason}''',
    '#- ''{override,approver}''']
  loop
    if position(v_n in v_def) = 0 then
      raise exception 'pb_dossier() lost or lacks: %', v_n;
    end if;
  end loop;

  -- The public read keeps working.
  if not has_function_privilege('anon', 'public.pb_dossier(uuid)', 'execute')
     or not has_function_privilege('anon', 'public.pb_reconcile_state()', 'execute') then
    raise exception 'anon lost EXECUTE on pb_dossier() or pb_reconcile_state()';
  end if;

  -- anon holds nothing new; authenticated reads the four tables and writes none of them.
  foreach v_t in array array['public.pb_meetings', 'public.pb_meeting_title_rules',
                             'public.pb_meeting_proposals', 'public.pb_meeting_aliases'] loop
    if has_table_privilege('anon', v_t, 'select, insert, update, delete, truncate, references, trigger') then
      raise exception 'anon holds a privilege on %', v_t;
    end if;
    if not has_table_privilege('authenticated', v_t, 'select')
       or has_table_privilege('authenticated', v_t, 'insert, update, delete, truncate, references, trigger') then
      raise exception 'authenticated should hold SELECT and nothing else on %', v_t;
    end if;
  end loop;
  foreach v_f in array array['public.pb_decide_meeting_card(jsonb, text)',
                             'public.pb_assign_meeting_mention(text, text, text, uuid, boolean)',
                             'public.pb_meeting_include(text, boolean)',
                             'public.pb_meeting_title_rule(text, boolean)',
                             'public.pb_dismiss_meeting(text, text)'] loop
    if has_function_privilege('anon', v_f, 'execute') or not has_function_privilege('authenticated', v_f, 'execute') then
      raise exception 'EXECUTE on % should be authenticated only', v_f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.pb_meeting_supersede(text)', 'execute')
     or has_function_privilege('authenticated', 'public.pb_meeting_supersede(text)', 'execute')
     or not has_function_privilege('service_role', 'public.pb_meeting_supersede(text)', 'execute') then
    raise exception 'EXECUTE on pb_meeting_supersede(text) should be service_role only';
  end if;
  if not has_table_privilege('authenticated', 'public.pb_facts', 'insert')
     or has_table_privilege('authenticated', 'public.pb_facts', 'update, delete, truncate') then
    raise exception 'authenticated should still hold INSERT,SELECT on pb_facts and nothing more';
  end if;
end $$;

-- 12 · the sentinel ----------------------------------------------------------------------------
-- Inside a sub-block: a synthetic account, a read meeting, an approved proposal whose quote is a
-- random sentinel, a sales_meeting fact carrying it in its note and its link, and an origin-tagged
-- override and note carrying it. pb_dossier() of that account must render it (its marker is in the
-- name) without the quote, the meeting link or the literal 'sales_meeting'; the live canary must
-- report it checked and clean; then one untagged register row carrying the quote — a deliberate
-- leak — must make the canary count it. A private SQLSTATE rolls all of it back; then, outside, a
-- problem raises for real and nothing in this file applies. No pb_reads row is written (rule 6), so
-- the trace strip is pinned by the static test and the live canary instead.
do $sentinel$
declare
  v_marker  text := 'pbmark' || replace(gen_random_uuid()::text, '-', '');
  v_quote   text := 'sentinel quote ' || replace(gen_random_uuid()::text, '-', '');
  v_rec     text;
  v_url     text;
  v_acct    uuid;
  v_prop    uuid;
  v_spec    jsonb;
  v_doc     text;
  v_mp      jsonb;
  v_problem text := null;
begin
  begin
    select r.spec into v_spec from public.pb_rubric_versions r
     where r.status = 'active' order by r.activated_at desc nulls last limit 1;
    v_rec := 'sentinel-' || v_marker;
    v_url := 'https://fathom.video/calls/' || v_marker;

    insert into public.pb_accounts (key, name, book)
    values ('sentinel:' || v_marker, 'Sentinel account ' || v_marker, 'prospect')
    returning id into v_acct;

    insert into public.pb_meetings (recording_id, inbox_id, title, title_norm, held_at, ended_at, url, include,
                                    selected_by, status, read_at)
    values (v_rec, gen_random_uuid(), 'Sentinel sales meeting', 'sentinel sales meeting', now() - interval '1 hour',
            now(), v_url, true, 'owner', 'read', now());

    insert into public.pb_meeting_proposals (recording_id, account_id, said_as, said_key, mention_state, matched_on,
                                             kind, key, value, quote, line_from, line_to, quote_at, speaker, mode,
                                             held_on, extractor, fingerprint, status, decided_by, decided_at)
    values (v_rec, v_acct, array['sentinel'], 'sentinel', 'resolved', 'name', 'fact', 'headcount', '40'::jsonb,
            v_quote, 1, 1, '00:00:01', 'S1', 'asserted', current_date, 'sentinel', 'sentinel:' || v_marker,
            'approved', 'sentinel@example.invalid', now())
    returning id into v_prop;

    insert into public.pb_facts (account_id, key, value, evidence_label, source, evidence_url, note, observed_at,
                                 entered_by, stand_in, meeting_proposal_id)
    values (v_acct, 'headcount', '40'::jsonb, 'evidence', 'sales_meeting', v_url, '"' || v_quote || '" — sentinel',
            current_date, 'sentinel@example.invalid', false, v_prop);

    insert into public.pb_register (kind, account_id, made_by, reason_code, text, payload, expires_at) values
      ('override', v_acct, 'sentinel@example.invalid', coalesce(v_spec->'override'->'reason_codes'->>0, 'other'),
       '"' || v_quote || '" — sentinel override',
       jsonb_build_object('tier', coalesce(v_spec->'vocabulary'->'tiers'->>0, 'none'), 'origin', 'sales_meeting',
                          'proposal_id', v_prop, 'recording_id', v_rec),
       now() + interval '1 day'),
      ('note', v_acct, 'sentinel@example.invalid', null, '"' || v_quote || '" — sentinel read',
       jsonb_build_object('origin', 'sales_meeting', 'proposal_id', v_prop, 'recording_id', v_rec), null);

    v_doc := public.pb_dossier(v_acct)::text;
    if v_doc is null or position(v_marker in v_doc) = 0 then
      v_problem := 'pb_dossier() did not render the sentinel account, so the check proved nothing';
    elsif position(v_quote in v_doc) > 0 then
      v_problem := 'pb_dossier() published a sales-meeting quote';
    elsif position(v_url in v_doc) > 0 then
      v_problem := 'pb_dossier() published a sales-meeting link';
    elsif position('sales_meeting' in v_doc) > 0 then
      v_problem := 'pb_dossier() published the literal sales_meeting';
    end if;

    if v_problem is null then
      v_mp := public.pb_reconcile_state() -> 'meeting_privacy';
      if v_mp is null or coalesce((v_mp->>'checked')::int, 0) < 1 or coalesce((v_mp->>'leaks')::int, -1) <> 0 then
        v_problem := 'pb_reconcile_state().meeting_privacy did not report the sentinel checked and clean (got '
                     || coalesce(v_mp::text, 'null') || ')';
      end if;
    end if;

    if v_problem is null then
      insert into public.pb_register (kind, account_id, made_by, text)
      values ('note', v_acct, 'sentinel@example.invalid', '"' || v_quote || '" — a deliberate, untagged leak');
      v_mp := public.pb_reconcile_state() -> 'meeting_privacy';
      if coalesce((v_mp->>'leaks')::int, 0) < 1 then
        v_problem := 'pb_reconcile_state().meeting_privacy missed a deliberate leak (got '
                     || coalesce(v_mp::text, 'null') || ')';
      end if;
    end if;

    raise exception using errcode = 'PBS01', message = 'sentinel: roll back';
  exception when sqlstate 'PBS01' then
    null;
  end;

  if v_problem is not null then
    raise exception 'sales-meeting privacy sentinel: %. Nothing in this migration applies.', v_problem;
  end if;
end
$sentinel$;
