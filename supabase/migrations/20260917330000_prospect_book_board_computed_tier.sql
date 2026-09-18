-- Owner, 17 Sep 2026: override the classification by clicking the tier chip on the board itself,
-- without opening the dossier first (DECISIONS §53).
--
-- The override form needs one thing the board did not carry: the tier the ENGINE computed, which
-- is not the same as the tier shown. The shown tier is `effective_tier` — computed, then moved by
-- any live override. The one-tier cap is measured from the COMPUTED tier, so a board that only
-- knows the effective one cannot tell the owner whether his choice will be accepted, and would
-- have to either stay silent or fetch the whole dossier per click to find out.
--
-- Also returns `overridden`, so a row that is already carrying someone's override can say so
-- rather than presenting a hand-set tier as the engine's own answer.
--
-- Both come from pb_current_reads, which this function can read and anon cannot — the same reason
-- pb_board() is SECURITY DEFINER at all (§47). Neither is a new kind of data: the dossier has
-- shown both since §49.
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
  select b.account_id, b.rank, b.name, b.effective_tier,
         (r.scorecard -> 'fit' ->> 'computed_tier')                  as computed_tier,
         (r.scorecard -> 'override') is not null
           and jsonb_typeof(r.scorecard -> 'override') <> 'null'     as overridden,
         b.cell, b.ceiling, b.headroom_band,
         b.year1_band, b.facts_present, b.qualification_label, b.confidence, b.status,
         b.engagement, b.signal_urgency, b.they_last_replied,
         b.untouched_high_potential, b.records, b.duplicate_records, b.flags
    from public.pb_prospect_board b
    left join public.pb_current_reads r on r.account_id = b.account_id
   order by b.rank;
$$;

revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §43): prospects ranked by potential, one row per company, in '
  'the engine''s own chase_rank_key order, each row carrying the account_id that opens its '
  'dossier via pb_dossier(). Also carries the tier the ENGINE COMPUTED and whether a live '
  'override moved it — the two the override form needs to check the one-tier cap from the board '
  'itself, without opening a dossier (§53). SECURITY DEFINER so the page reads the board without '
  'any of the seventeen objects beneath it becoming readable (§47). No composite score (PRO-0).';
