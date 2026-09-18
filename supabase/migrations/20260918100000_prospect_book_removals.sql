-- Removing an agency from the board — and why that is not an override (DECISIONS §50).
--
-- Owner, 18 Sep 2026, looking at the "Change this grade" panel: *"I need this screen to have an
-- option where I'm just removing people, either because they're unqualified or because they're do
-- not contact. Maybe those mean the same thing... there's this thing where the ruling has a date
-- that expires. When I make some of these changes, I don't want it to expire."*
--
-- ── WHY THE OVERRIDE EXPIRES ────────────────────────────────────────────────────────────────
-- An override is a statement about the ENGINE'S ANSWER, not about the world. The inputs keep
-- moving underneath it every night — new facts, new calls, new Pipedrive movement — and the
-- override sits on top and ignores all of them. If it never lapsed, that row would be frozen
-- against every piece of evidence that arrived afterwards, and nobody would ever find out. The
-- 90-day lapse is a forced re-look: it is the only mechanism in the book that makes a human
-- judgement face new evidence. That is also why the panel points at a FACT as the permanent fix —
-- a fact changes the input, so the engine re-derives from it and there is nothing to go stale.
--
-- ── WHY A REMOVAL MUST NOT EXPIRE ───────────────────────────────────────────────────────────
-- A removal is not a claim about the tier. It is a standing instruction about whether we pursue
-- them at all. Nothing the engine learns overnight makes that stale — and a better tier is exactly
-- the WRONG reason to put someone back in front of a caller after they asked us to stop. So a
-- removal does not borrow the override's machinery: `expires_at` must be null, and the trigger
-- below refuses the row otherwise rather than accepting it and quietly lapsing in 90 days.
--
-- ── THE TWO DISPOSITIONS ARE NOT THE SAME THING ─────────────────────────────────────────────
-- They have the same effect on the board and different meanings, and the difference shows up the
-- moment the facts change:
--
--   do_not_contact  is about PERMISSION and RELATIONSHIP. They asked; it is a conflict with a
--                   client or a partner; legal said so. No fact can reopen it. It carries no
--                   review date at all, and only a person's reinstatement brings them back.
--
--   unqualified     is about FIT. Not an agency; out of business; too small; buys no build work.
--                   That is a judgement over facts, and facts change — a three-person shop becomes
--                   a thirty-person shop. So it may carry an optional REVIEW DATE, which is not an
--                   expiry: on that date the row appears in pb_removal_due_review for a person to
--                   look at. It never returns to the board on its own.
--
-- Review date ≠ expiry. An expiry undoes a decision on a timer. A review date asks a person to
-- look again and leaves the decision standing until they act.
--
-- ── WHAT A REMOVAL DOES NOT DO ──────────────────────────────────────────────────────────────
-- It does not delete anything, it does not stop the nightly score, and it does not touch
-- pb_accounts.book. Removed accounts keep being read and graded, so a reinstatement shows today's
-- tier rather than a stale one, and nothing has to be re-seeded to undo a mistake. `book =
-- 'parked'` stays what it already means — the Pipedrive Client Journey parked stage — because
-- conflating "their CRM card moved" with "the owner removed them" would make both unreadable.
--
-- It is also NOT a grading concept, so it does not go near the engine, the rubric or a scorecard.
-- The engine grades; the register decides what we do about the grade. Putting removal in the
-- rubric would have said the opposite.

-- ── the vocabulary, as data ─────────────────────────────────────────────────────────────────
-- The same posture as pb_chase_weights (16 Sep): a list the owner can change without a code
-- change, and one the page must READ rather than restate. A hard-coded list in board.html would
-- keep working after this table changed and would be wrong without failing.
create table if not exists public.pb_removal_reasons (
  disposition        text not null check (disposition = any (array['do_not_contact','unqualified'])),
  code               text not null,
  label              text not null,
  note               text,
  allows_review_date boolean not null default false,
  sort               integer not null default 0,
  active             boolean not null default true,
  primary key (disposition, code)
);

comment on table public.pb_removal_reasons is
  'Why an agency was taken off the board, as data rather than as a list in the page (DECISIONS '
  '§50). do_not_contact is about permission and never carries a review date; unqualified is a '
  'judgement over facts and may carry one. A review date is not an expiry: it queues a person, it '
  'does not put the row back.';

insert into public.pb_removal_reasons (disposition, code, label, note, allows_review_date, sort) values
  ('do_not_contact','they_asked',         'They asked us to stop',        'Said so on a call, in writing, or by unsubscribing. The one reason that is not ours to weigh.', false, 10),
  ('do_not_contact','client_conflict',    'Conflicts with a client',      'Working them would put us across the table from someone we already deliver for.',              false, 20),
  ('do_not_contact','partner_conflict',   'Conflicts with a partner',     'Another agency''s account, or a referral relationship we would be cutting across.',           false, 30),
  ('do_not_contact','relationship_damage','The relationship is spent',    'History that makes an approach worse than no approach.',                                      false, 40),
  ('do_not_contact','legal',              'Legal or contractual',         'An NDA, a non-solicit, or anything counsel has ruled on.',                                    false, 50),
  ('do_not_contact','other',              'Other — say why below',        null,                                                                                          false, 90),
  ('unqualified',   'not_an_agency',      'Not an agency',                'A record that should never have been in an agency book — a vendor, a directory, a person.',    true,  10),
  ('unqualified',   'out_of_business',    'Out of business',              'Closed, acquired and absorbed, or dormant.',                                                  true,  20),
  ('unqualified',   'too_small',          'Too small to buy',             'Below the economic floor today. The one most likely to be worth a review date.',              true,  30),
  ('unqualified',   'no_build_work',      'Buys no build work',           'Strategy, media or creative only — nothing we deliver.',                                      true,  40),
  ('unqualified',   'competitor',         'A competitor, not a buyer',    'They sell what we sell.',                                                                     true,  50),
  ('unqualified',   'duplicate_record',   'Duplicate of another record',  'Prefer a merge in the back office; this only hides the row.',                                 true,  60),
  ('unqualified',   'other',              'Other — say why below',        null,                                                                                          true,  90)
on conflict (disposition, code) do update
  set label = excluded.label, note = excluded.note,
      allows_review_date = excluded.allows_review_date, sort = excluded.sort, active = excluded.active;

-- Supabase's default privileges hand anon and authenticated everything on a new public table
-- (CLAUDE.md). Revoke both, then grant select only. This table is vocabulary, no prospect data.
revoke all on public.pb_removal_reasons from anon, authenticated;
grant select on public.pb_removal_reasons to anon, authenticated;
alter table public.pb_removal_reasons enable row level security;
drop policy if exists pb_removal_reasons_read on public.pb_removal_reasons;
create policy pb_removal_reasons_read on public.pb_removal_reasons for select using (true);

-- ── the register carries the decision ───────────────────────────────────────────────────────
-- Nothing enters the book by hand (schema, 9 Sep): the page writes a register row and the system
-- reads it back. A removal is a register row like every other decision, which is what makes it
-- auditable, attributable and reversible.
alter table public.pb_register drop constraint if exists pb_register_kind_check;
alter table public.pb_register add constraint pb_register_kind_check
  check (kind = any (array['decision','override','dispute','proposal','approval','promotion','note',
                           'removal','reinstatement']));

-- The reason-code column now spans two vocabularies: the override's five (in the rubric, rule 4)
-- and the removal's (in pb_removal_reasons above). The column check is the union and deliberately
-- loose; the trigger below is what actually holds a removal to its own list, because a check
-- constraint cannot look in a table.
alter table public.pb_register drop constraint if exists pb_register_reason_code_check;
alter table public.pb_register add constraint pb_register_reason_code_check
  check (reason_code = any (array[
    'data_wrong','relationship_known','timing_known','conflict','other',
    'they_asked','client_conflict','partner_conflict','relationship_damage','legal',
    'not_an_agency','out_of_business','too_small','no_build_work','competitor','duplicate_record']));

create or replace function public.pb_register_removal_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d text;
  r public.pb_removal_reasons%rowtype;
  rv text;
begin
  if new.kind not in ('removal', 'reinstatement') then
    return new;
  end if;

  if new.account_id is null then
    raise exception 'a % names no account', new.kind;
  end if;
  if coalesce(btrim(new.text), '') = '' then
    raise exception 'a % needs a written reason: this row IS the record', new.kind;
  end if;
  -- The point of the whole exercise. An expiry is the override's discipline, for a statement about
  -- a tier that new evidence can overtake. A removal is a standing decision and does not lapse on
  -- a timer; accepting a date here and quietly undoing the decision in 90 days is the failure this
  -- refusal exists to prevent.
  if new.expires_at is not null then
    raise exception 'a % never expires — an expiry belongs to an override, which is a different act (DECISIONS §50)', new.kind;
  end if;

  if new.kind = 'reinstatement' then
    return new;
  end if;

  d := new.payload ->> 'disposition';
  select * into r from public.pb_removal_reasons
   where disposition = d and code = new.reason_code and active;
  if not found then
    raise exception 'removal: disposition % with reason code % is not an active row of pb_removal_reasons',
      coalesce(d, '(none)'), coalesce(new.reason_code, '(none)');
  end if;

  rv := nullif(new.payload ->> 'review_on', '');
  if rv is not null then
    if not r.allows_review_date then
      raise exception 'a % removal carries no review date: %', d, r.label;
    end if;
    if rv::date <= current_date then
      raise exception 'a review date in the past or today asks for nothing; leave it blank or set a future date';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists pb_register_removal_guard on public.pb_register;
create trigger pb_register_removal_guard
  before insert on public.pb_register
  for each row execute function public.pb_register_removal_guard();

-- The owner lane, as PRO-5's revision has it for every other decision of this weight.
drop policy if exists pb_register_insert_owner on public.pb_register;
create policy pb_register_insert_owner on public.pb_register
  for insert to authenticated
  with check (pb_is_wliq() and made_by = pb_me() and pb_role() = 'owner'
              and kind = any (array['override','decision','approval','promotion',
                                    'removal','reinstatement']));

-- A removal's written reason is candid about a named company — "they asked us to stop", "their
-- owner is impossible" — and pb_register is readable by anon (pb_register_read_anon, `using
-- true`). The public board simply stops showing the row; it does not owe the public an
-- explanation. So this one kind comes off the anon surface. NOTE for the owner: every OVERRIDE
-- reason written so far is still public, which is a separate call and not one to make quietly
-- from here (DECISIONS §50).
drop policy if exists pb_register_read_anon on public.pb_register;
create policy pb_register_read_anon on public.pb_register
  for select to anon
  using (kind <> all (array['removal', 'reinstatement']));

-- ── the current state, resolved ─────────────────────────────────────────────────────────────
-- Append-only, like the rest of the register: a reinstatement does not delete the removal, it
-- outranks it. The whole history stays readable, which is the point of a register.
create or replace view public.pb_removals as
with last as (
  select distinct on (g.account_id)
         g.account_id, g.kind, g.made_by, g.reason_code, g.text, g.payload, g.created_at
    from public.pb_register g
   where g.kind in ('removal', 'reinstatement')
     and g.account_id is not null
   order by g.account_id, g.created_at desc, g.id desc
)
select l.account_id,
       l.payload ->> 'disposition'                  as disposition,
       l.reason_code,
       l.text                                       as reason,
       l.made_by                                    as removed_by,
       l.created_at                                 as removed_at,
       nullif(l.payload ->> 'review_on', '')::date  as review_on
  from last l
 where l.kind = 'removal';

comment on view public.pb_removals is
  'Accounts currently off the board, one row each: the LATEST removal or reinstatement decides. '
  'Never expires — nothing here lapses on a timer (DECISIONS §50).';

-- The queue a review date feeds. It asks a person to look; it does not put the row back.
create or replace view public.pb_removal_due_review as
select r.account_id, a.name, r.disposition, r.reason_code, r.reason,
       r.removed_by, r.removed_at, r.review_on,
       (current_date - r.review_on) as days_overdue
  from public.pb_removals r
  join public.pb_accounts a on a.id = r.account_id
 where r.review_on is not null
   and r.review_on <= current_date;

comment on view public.pb_removal_due_review is
  'Unqualified removals whose review date has arrived. A review date is NOT an expiry: the row '
  'stays off the board until a person reinstates it (DECISIONS §50).';

-- ── the board stops showing them ────────────────────────────────────────────────────────────
-- Matched two ways: the account the board row carries, and the normalised company name. A
-- do-not-contact must not be defeated by a second Pipedrive record for the same company. The
-- remaining gap is a removal recorded against a non-lead duplicate whose name normalises
-- differently; the form only ever offers removal from the row you are looking at, which carries
-- the lead account, so that is a shape the interface does not produce.
drop function if exists public.pb_board();

create function public.pb_board()
returns table (
  account_id               uuid,
  rank                     bigint,
  name                     text,
  effective_tier           text,
  computed_tier            text,
  overridden               boolean,
  cell                     text,
  ceiling                  text,
  headroom_band            text,
  year1_band               text,
  facts_present            integer,
  qualification_label      text,
  confidence               text,
  status                   text,
  engagement               text,
  signal_urgency           text,
  they_last_replied        date,
  untouched_high_potential boolean,
  records                  bigint,
  duplicate_records        text,
  flags                    text[]
)
language sql
stable
security definer
set search_path = public
as $$
  -- Tiny: one row per removal, not per account. Materialised so the planner evaluates it once
  -- rather than per board row — the lesson of the 8.1s → 0.80s fence (DECISIONS §42).
  with gone as materialized (
    select rm.account_id, public.pb_norm_company(a.name) as norm_name
      from public.pb_removals rm
      join public.pb_accounts a on a.id = rm.account_id
  ),
  kept as (
    select b.*
      from public.pb_prospect_board b
     where not exists (select 1 from gone g
                        where g.account_id = b.account_id
                           or g.norm_name  = b.norm_name)
  )
  -- Re-numbered, never re-ordered. The sequence is still the engine's chase_rank_key: this only
  -- closes the gaps a removed row would leave, so rank 1..n keeps meaning "n rows above you".
  select k.account_id,
         row_number() over (order by k.rank)                          as rank,
         k.name, k.effective_tier,
         (r.scorecard -> 'fit' ->> 'computed_tier')                   as computed_tier,
         (r.scorecard -> 'override') is not null
           and jsonb_typeof(r.scorecard -> 'override') <> 'null'      as overridden,
         k.cell, k.ceiling, k.headroom_band,
         k.year1_band, k.facts_present, k.qualification_label, k.confidence, k.status,
         k.engagement, k.signal_urgency, k.they_last_replied,
         k.untouched_high_potential, k.records, k.duplicate_records, k.flags
    from kept k
    left join public.pb_current_reads r on r.account_id = k.account_id
   order by k.rank;
$$;

revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §37): prospects ranked by potential, one row per company, in '
  'the engine''s own chase_rank_key order, each row carrying the account_id that opens its '
  'dossier via pb_dossier(). Also carries the tier the ENGINE COMPUTED and whether a live '
  'override moved it (§47). Agencies the owner has removed are not here at all — a standing '
  'decision, never an expiry (§50). SECURITY DEFINER so the page reads the board without any of '
  'the seventeen objects beneath it becoming readable (§41). No composite score (PRO-0).';

-- ── seeing and undoing a removal ────────────────────────────────────────────────────────────
-- Both are granted to `authenticated` ONLY. The reason text is a candid judgement about a named
-- company, which CLAUDE.md keeps off the anon surface; the public board owes no explanation for a
-- row it is not showing.
create or replace function public.pb_removed()
returns table (
  account_id   uuid,
  name         text,
  disposition  text,
  reason_code  text,
  label        text,
  reason       text,
  removed_by   text,
  removed_at   timestamptz,
  review_on    date,
  due_review   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select rm.account_id, a.name, rm.disposition, rm.reason_code,
         coalesce(rr.label, rm.reason_code) as label,
         rm.reason, rm.removed_by, rm.removed_at, rm.review_on,
         (rm.review_on is not null and rm.review_on <= current_date) as due_review
    from public.pb_removals rm
    join public.pb_accounts a on a.id = rm.account_id
    left join public.pb_removal_reasons rr
      on rr.disposition = rm.disposition and rr.code = rm.reason_code
   order by (rm.review_on is not null and rm.review_on <= current_date) desc,
            rm.removed_at desc;
$$;

revoke all on function public.pb_removed() from public, anon;
grant execute on function public.pb_removed() to authenticated, service_role;

comment on function public.pb_removed() is
  'Everything taken off the board, newest first, with anything due a review at the top. Signed-in '
  'only: the reason is a candid judgement about a named company (DECISIONS §50).';

create or replace function public.pb_removal(p_account_id uuid)
returns table (
  account_id   uuid,
  disposition  text,
  reason_code  text,
  label        text,
  reason       text,
  removed_by   text,
  removed_at   timestamptz,
  review_on    date,
  due_review   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select rm.account_id, rm.disposition, rm.reason_code,
         coalesce(rr.label, rm.reason_code) as label,
         rm.reason, rm.removed_by, rm.removed_at, rm.review_on,
         (rm.review_on is not null and rm.review_on <= current_date) as due_review
    from public.pb_removals rm
    left join public.pb_removal_reasons rr
      on rr.disposition = rm.disposition and rr.code = rm.reason_code
   where rm.account_id = p_account_id;
$$;

revoke all on function public.pb_removal(uuid) from public, anon;
grant execute on function public.pb_removal(uuid) to authenticated, service_role;

comment on function public.pb_removal(uuid) is
  'One account''s current removal state, or no row. What the dossier''s panel reads to know '
  'whether it is offering a removal or a reinstatement (DECISIONS §50).';
