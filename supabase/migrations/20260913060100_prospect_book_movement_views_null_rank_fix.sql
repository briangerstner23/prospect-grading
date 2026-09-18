-- prospect_book_movement_views_null_rank_fix
--
-- TRANSCRIBED 17 Sep 2026 from supabase_migrations.schema_migrations.statements — the SQL below
-- is byte-for-byte what was applied to the database as version 20260913002739 (applied without a file;
-- DECISIONS §35, §38). Filed as 20260913060100 so it replays after 20260913060000_prospect_book_movement_views.sql. Do not edit the body: if
-- it needs to change, that is a new migration.

create or replace view pb_movement with (security_invoker = true) as
with seq as (
  select run_id, account_id, run_at, effective_tier, urgency, status, facts_present,
         row_number() over (partition by account_id order by run_at, run_id) as rn
  from pb_reads
),
pairs as (
  select a.run_id,
         b.effective_tier as prev_tier,    a.effective_tier as tier,
         b.urgency        as prev_urgency, a.urgency        as urgency,
         b.status         as prev_status,  a.status         as status,
         b.facts_present  as prev_facts,   a.facts_present  as facts
  from seq a
  join seq b on b.account_id = a.account_id and b.rn = a.rn - 1
),
runs as (
  select run_id, min(run_at) as run_at, count(*) as accounts
  from pb_reads
  group by run_id
)
select
  r.run_id,
  r.run_at,
  r.accounts,
  count(p.*) filter (where p.tier is distinct from p.prev_tier) as tier_moved,
  count(p.*) filter (
    where coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.tier), 0)
        > coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.prev_tier), 0)
  ) as promoted,
  count(p.*) filter (
    where coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.tier), 0)
        < coalesce(array_position(array['Bronze','Silver','Gold','Platinum'], p.prev_tier), 0)
  ) as demoted,
  count(p.*) filter (where p.urgency is distinct from p.prev_urgency) as urgency_moved,
  count(p.*) filter (
    where coalesce(array_position(array['Cold','Warm','Hot','Super Hot'], p.urgency), 0)
        > coalesce(array_position(array['Cold','Warm','Hot','Super Hot'], p.prev_urgency), 0)
  ) as urgency_up,
  count(p.*) filter (where p.facts is distinct from p.prev_facts)     as facts_changed,
  count(p.*) filter (where p.status = 'Ranked'       and p.prev_status <> 'Ranked')       as newly_ranked,
  count(p.*) filter (where p.status = 'Unclassified' and p.prev_status <> 'Unclassified') as newly_unclassified
from runs r
left join pairs p on p.run_id = r.run_id
group by r.run_id, r.run_at, r.accounts;
