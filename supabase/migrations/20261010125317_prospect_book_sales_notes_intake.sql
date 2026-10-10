-- Prospect Book — what the sales team writes reaches the book (owner, 10 Oct 2026: "ship all of
-- it"; DECISIONS §64). No rule changes here. Five mechanical fixes, each inside rules 8 and 9:
--
--   1. The notes sweep runs ten times a night instead of once. One run reads about a dozen
--      records inside its 110 s budget (one model call is ~50 s, six in flight), so a cap of 30
--      alone would not have cleared anything. Ten runs, three minutes apart, 05:15–05:42 UTC,
--      each capped at 30 per channel: room for ~120 records a channel a night, all before the
--      06:00 autoconfirm and the 06:15 score. A run stops itself inside 150 s, so a 180 s cadence
--      never puts two runs on one cursor. A run with nothing past the watermark makes no model
--      call, so the nine extra runs cost nothing on a quiet night.
--   2. Call attribution runs every night at 05:13, after the roster report and before the first
--      notes run. It ran once, on 16 Sep; seven calls sat unattached for agencies that entered
--      the book after it. It now also ignores merged rows: a merged duplicate keeps its domain,
--      so without the filter every call of a merged pair would count as ambiguous forever.
--   3. (Not in this file.) Two accounts whose own records carry one exact domain had none on the
--      account, so none of their calls could attach. Their domains were filled as an operator
--      data step on 10 Oct, with a register note on each saying where the domain came from. Agency
--      data never enters this repository (rule 2), so the values live only in the database.
--   4. The Pipedrive note watermark goes back to 1 Sep, so every note since then is read again
--      at the new 40-character floor (pb-notes v17). A re-read cannot write twice: a claim's
--      fingerprint is (note id · note updated_at · extractor version · key), the same on the
--      second read. Only claims the first read did not make can land.
--   5. A time-boxed catch-up (the 23 Sep pattern) reads that re-opened range today instead of
--      across three nights: Pipedrive notes and recorded calls only, every 3 minutes, never in the
--      05:00 hour, and it stops posting at 2026-10-11 05:00 UTC and removes itself after.

-- 2. ------------------------------------------------------------------------------------------
create or replace function public.pb_attribute_orphan_calls(p_dry_run boolean default true)
returns table (calls_attached integer, accounts_touched integer, left_ambiguous integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attached integer := 0;
  v_accounts integer := 0;
  v_ambig    integer := 0;
begin
  create temporary table _cand on commit drop as
  with orphan as (
    select c.id as call_id, unnest(c.external_domains) as dom
    from public.pb_calls c
    where c.account_id is null and c.external_domains is not null
  ),
  d as (select call_id, lower(regexp_replace(dom, '^www\.', '')) as dom from orphan),
  m as (
    select distinct d.call_id, a.id as account_id
    from d
    join public.pb_accounts a
      on lower(regexp_replace(a.domain, '^www\.', '')) = d.dom
    where a.domain is not null and a.domain <> ''
      and a.book <> 'merged'
  )
  select call_id,
         (array_agg(distinct account_id))[1] as account_id,
         count(distinct account_id) as n
  from m group by call_id;

  select count(*) into v_ambig from _cand where n > 1;

  if p_dry_run then
    select count(*), count(distinct account_id) into v_attached, v_accounts
    from _cand where n = 1;
    return query select v_attached, v_accounts, v_ambig;
    return;
  end if;

  update public.pb_calls c
     set account_id = k.account_id, updated_at = now()
    from _cand k
   where k.n = 1 and c.id = k.call_id and c.account_id is null;
  get diagnostics v_attached = row_count;

  select count(distinct account_id) into v_accounts from _cand where n = 1;

  -- One register note per account per day: a nightly job that wrote one per call would be noise,
  -- and one per account ever (the 16 Sep fingerprint) would stay silent about every later call.
  insert into public.pb_register (account_id, kind, made_by, text, fingerprint, created_at)
  select g.account_id, 'note', 'pb_attribute_orphan_calls',
         'Attributed ' || g.n_calls || ' previously unattached recorded call(s) to this account '
         || 'by exact domain match (rule 8: exact domain = high). No fact was read from them '
         || 'here; the notes sweep reads them next.',
         g.fp,
         now()
    from (
      select k.account_id,
             count(*) as n_calls,
             encode(sha256(convert_to('call_attribution|' || k.account_id::text || '|' || current_date::text, 'UTF8')), 'hex') as fp
        from _cand k
       where k.n = 1
       group by k.account_id
    ) g
   where not exists (
     select 1 from public.pb_register r where r.fingerprint = g.fp
   );

  return query select v_attached, v_accounts, v_ambig;
end;
$$;

revoke all on function public.pb_attribute_orphan_calls(boolean) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-nightly-attribution') then
    perform cron.unschedule('pb-nightly-attribution');
  end if;
end $$;

select cron.schedule('pb-nightly-attribution', '13 5 * * *',
  $cmd$ select public.pb_attribute_orphan_calls(false); $cmd$);

-- Attach now what exact domain already settles, rather than waiting for tonight.
select public.pb_attribute_orphan_calls(false);

-- 1. ------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-nightly-notes') then
    perform cron.unschedule('pb-nightly-notes');
  end if;
end $$;

select cron.schedule(
  'pb-nightly-notes',
  '15-42/3 5 * * *',
  $cmd$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('max_notes', 30, 'budget_ms', 110000, 'concurrency', 6),
      timeout_milliseconds := 150000
    );
  $cmd$
);

-- 4. ------------------------------------------------------------------------------------------
update public.pb_source_watermarks
   set last_seen_at = '2026-09-01 00:00:00+00', last_seen_id = null,
       note = coalesce(note, '') || ' | wound back to 2026-09-01 on 2026-10-10: re-read at the 40-character floor (DECISIONS §64).'
 where source = 'pipedrive_note';

-- 5. ------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pb-notes-catchup') then
    perform cron.unschedule('pb-notes-catchup');
  end if;
end $$;

select cron.schedule(
  'pb-notes-catchup',
  '*/3 * * * *',
  $cmd$
    select net.http_post(
      url     := 'https://sgagrmapuovnjwvgsxbp.supabase.co/functions/v1/pb-notes',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'PB_SYNC_TOKEN' limit 1), '')
      ),
      body    := jsonb_build_object('max_notes', 30, 'budget_ms', 110000, 'concurrency', 6,
                                    'sources', jsonb_build_array('pipedrive_note', 'fathom_call')),
      timeout_milliseconds := 150000
    )
    where now() < timestamptz '2026-10-11 05:00:00+00'
      and extract(hour from now() at time zone 'utc') <> 5;
    select cron.unschedule('pb-notes-catchup') where now() >= timestamptz '2026-10-11 05:00:00+00';
  $cmd$
);
