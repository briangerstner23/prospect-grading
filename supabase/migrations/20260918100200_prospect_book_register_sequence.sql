-- pb_removals resolves "is this account off the board?" by taking the LATEST of its removal and
-- reinstatement rows. It ordered by `created_at desc, id desc`, and `id` is a random uuid — so two
-- register rows sharing a timestamp resolved by coin flip. The harness caught it immediately: a
-- removal and a reinstatement written in one transaction both carry transaction-start `now()`, and
-- the board kept the account hidden after it had been put back.
--
-- In normal use the two rows arrive in separate requests, microseconds apart, and the old order
-- was right by luck. Luck is not a tiebreak for "did the owner say to stop contacting them".
--
-- `seq` is an ADDITIVE column: nothing is renamed, retyped or repurposed (DECISIONS §8). It is
-- true insertion order, which is what "latest decision" actually means. Existing rows are numbered
-- in `created_at` order so the history reads the same as it did before.
alter table public.pb_register add column if not exists seq bigserial;

create index if not exists pb_register_seq_idx on public.pb_register (account_id, seq desc);

comment on column public.pb_register.seq is
  'Insertion order. The tiebreak for "which decision is current" when two rows share a timestamp '
  '— a uuid is not an order (DECISIONS §50).';

create or replace view public.pb_removals as
with last as (
  select distinct on (g.account_id)
         g.account_id, g.kind, g.made_by, g.reason_code, g.text, g.payload, g.created_at
    from public.pb_register g
   where g.kind in ('removal', 'reinstatement')
     and g.account_id is not null
   order by g.account_id, g.created_at desc, g.seq desc
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
  'Accounts currently off the board, one row each: the LATEST removal or reinstatement decides, '
  'by timestamp then insertion order. Never expires — nothing here lapses on a timer '
  '(DECISIONS §50).';

revoke all on public.pb_removals from anon, authenticated;
