-- pb_board() returned every column the board TABLE draws and not the one the board NEEDS: a row
-- has to carry its account_id or clicking it cannot open a dossier. Dropped on the first cut
-- because the visible columns were the whole brief at the time; adding it is the difference
-- between a list and a working surface (DECISIONS §49).
--
-- Not a widening of what is exposed: the id is an opaque uuid, it is the key pb_dossier() already
-- takes, and pb_accounts.id is readable by anon already.
drop function if exists public.pb_board();

create function public.pb_board()
returns table (
  account_id               uuid,
  rank                     bigint,
  name                     text,
  effective_tier           text,
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
  select b.account_id, b.rank, b.name, b.effective_tier, b.cell, b.ceiling, b.headroom_band,
         b.year1_band, b.facts_present, b.qualification_label, b.confidence, b.status,
         b.engagement, b.signal_urgency, b.they_last_replied,
         b.untouched_high_potential, b.records, b.duplicate_records, b.flags
    from public.pb_prospect_board b
   order by b.rank;
$$;

revoke all on function public.pb_board() from public;
grant execute on function public.pb_board() to anon, authenticated, service_role;

comment on function public.pb_board() is
  'The working surface (DECISIONS §43): prospects ranked by potential, one row per company, in '
  'the engine''s own chase_rank_key order, each row carrying the account_id that opens its '
  'dossier via pb_dossier(). SECURITY DEFINER so the page reads the board without any of the '
  'seventeen objects beneath it becoming readable (§47). No composite score (PRO-0).';