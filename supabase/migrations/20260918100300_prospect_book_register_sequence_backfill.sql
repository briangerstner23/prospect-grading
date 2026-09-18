-- The previous migration's comment said existing rows were "numbered in created_at order". They
-- were not. `alter table ... add column seq bigserial` numbers rows in PHYSICAL order during the
-- rewrite, and this table has been updated and vacuumed for nine days: 222 of its 295 rows came
-- out in a different order from the one they were written in.
--
-- Nothing depended on it — pb_removals only reads removal and reinstatement rows and every one of
-- those is newer than this migration — so this is not a broken system. It is a comment that was
-- false, which in this repository is its own kind of defect: §26, §33 and §49 are all the same
-- story of a written record that described something the database was not doing. Renumbering
-- costs one pass over 295 rows and makes the sentence true.
do $$
declare n bigint;
begin
  with ordered as (
    select id, row_number() over (order by created_at, seq) as rn
      from public.pb_register
  )
  update public.pb_register g set seq = o.rn from ordered o where o.id = g.id and g.seq <> o.rn;

  select coalesce(max(seq), 0) + 1 into n from public.pb_register;
  execute format('alter sequence public.pb_register_seq_seq restart with %s', n);
end $$;
