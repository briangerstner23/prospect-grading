-- WLIQ Prospect Book — the board carries its chase cells again (DECISIONS §69).
--
-- Since 18 Sep 2026 the public board has grouped every row under "No cell (rubric before 0.1.7)".
-- Two migrations share the version 20260918100000. prospect_book_board_by_cell gave pb_board() ten
-- cell columns (cell_id, cell_name, cell_play, cell_rank, cell_owner_role, cell_sla_days, cell_abm,
-- readiness, ceiling_assumed, timing_aged_out), which web/board.html reads to draw a header and a play
-- per cell (DECISIONS §52). prospect_book_removals then re-created pb_board() from the definition
-- BEFORE that one, to filter removed agencies out (DECISIONS §50), and the ten columns went with it.
-- The live function (prosrc md5 6c47cb99…, measured 20 Nov) returns the 21 pre-cell columns; the page
-- finds no cell_id on any row and falls back to its "no cell" group, and the dossier's cell chip and
-- play line are blank for the same reason. pb_prospect_board still computes all ten columns.
--
-- This keeps the removals body exactly (the materialised `gone` set, the anti-join on id or normalised
-- name, the renumbering) and adds the ten columns back from the view, in board_by_cell's order. The
-- return type changes, so it is a drop and create; nothing in the database depends on the function
-- (pg_depend, 20 Nov), and the grants are restated as the removals migration left them. The cost is the
-- removals body's cost: the view already computes the cell columns for every row (explain analyze,
-- 20 Nov: 847 rows, the same ~150,000 buffers as the live function).

-- 0 · refuse to run if pb_board() moved since it was read ---------------------------------------
do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.pb_board()'::regprocedure)
       <> '6c47cb99ea02667de5d5fa53f2948888' then
    raise exception 'pb_board() changed since 20261120 was written (prosrc md5 is not 6c47cb99…); re-read it before applying';
  end if;
end
$guard$;

-- 1 · the board, with its cells ------------------------------------------------------------------
drop function public.pb_board();

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
         k.untouched_high_potential, k.records, k.duplicate_records, k.flags,
         -- §52's grid, which board.html groups by and the dossier's cell chip reads (§69).
         k.cell_id, k.cell_name, k.cell_play, k.cell_rank, k.cell_owner_role, k.cell_sla_days, k.cell_abm,
         k.readiness, k.ceiling_assumed, k.timing_aged_out
    from kept k
    left join public.pb_current_reads r on r.account_id = k.account_id
   order by k.rank;
$$;

-- 2 · the grants and the comment, as the removals migration left them ------------------------------
revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §37): prospects ranked by potential, one row per company, in the engine''s own chase_rank_key order, each row carrying the account_id that opens its dossier via pb_dossier(). Also carries the tier the ENGINE COMPUTED and whether a live override moved it (§47). Agencies the owner has removed are not here at all — a standing decision, never an expiry (§50). Carries the chase cell of each row (cell_id, cell_name, cell_play, cell_rank, cell_owner_role, cell_sla_days, cell_abm, readiness, ceiling_assumed, timing_aged_out), which the page groups by (§52, restored §69). SECURITY DEFINER so the page reads the board without any of the seventeen objects beneath it becoming readable (§41). No composite score (PRO-0).';