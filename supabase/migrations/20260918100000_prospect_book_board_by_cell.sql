-- The board becomes a GRID (owner decision D1, 18 Sep 2026, DECISIONS §50).
--
-- Rubric 0.1.7 puts the chase CELL — potential band × readiness, with a play — first in the
-- engine's chase key and the tier second, so a qualified, engaged Silver is worked before a cold
-- Platinum nobody has contacted. The order is still the engine's own (rule 4): this view reads
-- the key out of the scorecard exactly as before and never restates a threshold. What changes:
--
--   * The key has SEVEN terms from 0.1.7 and had FIVE before, so the elements are read safely
--     (a number where there is one, else null) and the name — the last element in both shapes —
--     is read as text. pb_key_num() and pb_key_last_text() are the two helpers; both immutable.
--   * The cell, its play, owner role and SLA, the readiness band, whether the ceiling is an
--     assumption (D6) and whether the timing stamp aged out (D3) are carried as columns, read out
--     of the scorecard, so the page can group by cell and say why.
--   * Only LIVE accounts feed the read: a merged record's last read (21 of them, on rubric 0.1.0
--     with the five-term key) could otherwise win the distinct-on for its company and put a
--     retired read on the board. It was possible before; the seven-term key would have made it
--     certain, because a legacy key's first element (−tier) sorts before a cell rank.
--
-- pb_board() is recreated because its return type gains columns (the same drop-and-create the
-- 17 Sep migrations used). No composite score anywhere (PRO-0); the contact score of
-- pb_chase_board is not read.

create or replace function public.pb_key_num(p_key jsonb, p_i integer)
returns numeric
language sql
immutable
as $$
  select case when jsonb_typeof(p_key -> p_i) = 'number' then (p_key ->> p_i)::numeric else null end
$$;

create or replace function public.pb_key_last_text(p_key jsonb)
returns text
language sql
immutable
as $$
  select case when jsonb_typeof(p_key) = 'array' and jsonb_array_length(p_key) > 0
              then p_key ->> (jsonb_array_length(p_key) - 1) else null end
$$;

revoke all on function public.pb_key_num(jsonb, integer) from public;
revoke all on function public.pb_key_last_text(jsonb) from public;
grant execute on function public.pb_key_num(jsonb, integer) to anon, authenticated, service_role;
grant execute on function public.pb_key_last_text(jsonb) to anon, authenticated, service_role;

drop function if exists public.pb_board();
drop view if exists public.pb_prospect_board;

create view public.pb_prospect_board as
with grp as (
  select b.norm_name, b.name, b.account_ids, b.records, b.duplicate_records,
         b.engagement, b.quote_state, b.crm_urgency, b.cj_stage,
         b.they_last_replied, b.last_quoted, b.entity_type
    from public.pb_chase_board b
   where b.active_projects = 0
),
acct as (
  select g.norm_name, a.account_id
    from grp g
    cross join lateral unnest(g.account_ids) as a(account_id)
),
-- THE FENCE (17 Sep): pb_current_reads is a distinct-on over all of pb_reads; without
-- `materialized` it is rebuilt once per company and the view takes eight seconds.
reads as materialized (
  select r.account_id, r.effective_tier, r.cell, r.ceiling, r.headroom_band, r.year1_band,
         r.facts_present, r.qualification_label, r.confidence, r.confidence_grade,
         r.urgency, r.status, r.flags,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 0) as k0,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 1) as k1,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 2) as k2,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 3) as k3,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 4) as k4,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 5) as k5,
         public.pb_key_num(r.scorecard -> 'chase_rank_key', 6) as k6,
         public.pb_key_last_text(r.scorecard -> 'chase_rank_key') as kname,
         r.scorecard -> 'chase_cell' ->> 'id'                        as cell_id,
         r.scorecard -> 'chase_cell' ->> 'name'                      as cell_name,
         r.scorecard -> 'chase_cell' ->> 'play'                      as cell_play,
         (r.scorecard -> 'chase_cell' ->> 'rank')::integer           as cell_rank,
         r.scorecard -> 'chase_cell' ->> 'owner_role'                as cell_owner_role,
         (r.scorecard -> 'chase_cell' ->> 'sla_days')::integer       as cell_sla_days,
         r.scorecard -> 'chase_cell' ->> 'abm'                       as cell_abm,
         r.scorecard -> 'readiness' ->> 'label'                      as readiness,
         coalesce((r.scorecard -> 'potential' ->> 'assumed')::boolean, false)             as ceiling_assumed,
         coalesce((r.scorecard -> 'signals' ->> 'stated_timing_aged_out')::boolean, false) as timing_aged_out
    from public.pb_current_reads r
    join public.pb_accounts a on a.id = r.account_id and a.book in ('prospect', 'parked')
),
best as (
  select distinct on (a.norm_name)
         a.norm_name, r.*
    from acct a
    join reads r on r.account_id = a.account_id
   order by a.norm_name,
            r.k0 nulls last, r.k1 nulls last, r.k2 nulls last, r.k3 nulls last,
            r.k4 nulls last, r.k5 nulls last, r.k6 nulls last, r.kname
)
select
  row_number() over (order by b.k0 nulls last, b.k1 nulls last, b.k2 nulls last, b.k3 nulls last,
                              b.k4 nulls last, b.k5 nulls last, b.k6 nulls last, b.kname) as rank,
  dense_rank()  over (order by b.k0 nulls last)                                           as tier_band,
  b.account_id, g.norm_name, g.name,
  b.effective_tier, b.cell, b.ceiling, b.headroom_band, b.year1_band,
  b.facts_present, b.qualification_label, b.confidence, b.confidence_grade, b.status,
  g.engagement, b.urgency as signal_urgency, g.crm_urgency, g.quote_state,
  g.they_last_replied, g.last_quoted, g.cj_stage, g.entity_type,
  (b.effective_tier in ('Platinum', 'Gold') and g.engagement = 'unknown') as untouched_high_potential,
  g.records, g.duplicate_records, b.flags,
  b.cell_id, b.cell_name, b.cell_play, b.cell_rank, b.cell_owner_role, b.cell_sla_days, b.cell_abm,
  b.readiness, b.ceiling_assumed, b.timing_aged_out
from best b
join grp g on g.norm_name = b.norm_name;

comment on view public.pb_prospect_board is
  'Prospects in the engine''s own chase order, one row per company with no active delivery '
  'work. From rubric 0.1.7 the first key term is the CHASE CELL (potential band × readiness, '
  'with a play) and the tier is second — the grid the owner ruled on 18 Sep 2026 (DECISIONS '
  '§50) in place of a size-first sort. The key is read out of the scorecard element by element, '
  'safely across the five-term and seven-term shapes; nothing here restates a threshold (rule '
  '4). Only live accounts (book prospect or parked) feed the read. Engagement is carried in its '
  'own columns; no composite score (PRO-0). Read by the page through pb_board(); closed to anon '
  'because it sits on seventeen objects (§41). The `reads as materialized` fence is load-bearing.';

revoke all on public.pb_prospect_board from anon, authenticated;

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
  flags                    text[],
  cell_id                  text,
  cell_name                text,
  cell_play                text,
  cell_rank                integer,
  cell_owner_role          text,
  cell_sla_days            integer,
  cell_abm                 text,
  readiness                text,
  ceiling_assumed          boolean,
  timing_aged_out          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select b.account_id, b.rank, b.name, b.effective_tier,
         (r.scorecard -> 'fit' ->> 'computed_tier')                  as computed_tier,
         (r.scorecard -> 'override') is not null
           and jsonb_typeof(r.scorecard -> 'override') <> 'null'     as overridden,
         b.cell, b.ceiling, b.headroom_band,
         b.year1_band, b.facts_present, b.qualification_label, b.confidence, b.status,
         b.engagement, b.signal_urgency, b.they_last_replied,
         b.untouched_high_potential, b.records, b.duplicate_records, b.flags,
         b.cell_id, b.cell_name, b.cell_play, b.cell_rank, b.cell_owner_role, b.cell_sla_days, b.cell_abm,
         b.readiness, b.ceiling_assumed, b.timing_aged_out
    from public.pb_prospect_board b
    left join public.pb_current_reads r on r.account_id = b.account_id
   order by b.rank;
$$;

revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §37): prospects in the engine''s own chase order, one row per '
  'company, each row carrying its chase cell and play, its readiness, whether its ceiling is an '
  'assumption and whether its timing stamp aged out (rubric 0.1.7, DECISIONS §50), the tier the '
  'engine computed and whether a live override moved it (§47), and the account_id that opens '
  'its dossier. SECURITY DEFINER so the page reads the board without any of the objects '
  'beneath it becoming readable (§41). No composite score (PRO-0).';
