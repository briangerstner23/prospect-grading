-- WLIQ Prospect Book — the data layer.
--
-- An INDEPENDENT system from the Client Book (PRO-17, 2026-09-09). It lives in the same
-- Supabase project because that is the infrastructure WLIQ already runs, but it shares no
-- table, no key and no code with grading_*: every object here is prefixed pb_. The two
-- systems connect at one event only — promotion — recorded in pb_promotions and confirmed
-- by a person (PRO-10, PRO-18).
--
-- Design rules carried from the Client Book:
--   * The database is the grading record. Pipedrive stays the deal-motion record.
--   * Every fact carries a source, an evidence label and a date; facts and signals are
--     APPEND-ONLY. A change is a new row that supersedes, never an edit.
--   * Nothing enters the book by hand: hand-set proposals and overrides land in pb_register
--     and are applied by the scoring run, never by editing a read.
--   * Default-deny RLS on every table.
--
-- Read access (PRO-7, 2026-09-06): anyone at WLIQ who signs in. Not public — signing in is
-- the bar — but not restricted by role. Implemented as an email-domain check, deliberately
-- unlike the Client Book's allowlist, because that is what was ruled. Sensitive fields
-- (an anticipated value band, named raters' entries) are visible to every signer; the
-- ruling names both as accepted costs.
--
-- Write access: raters and the owner enter facts (PRO-5); the owner alone overrides
-- (PRO-5 revision) and confirms promotions (PRO-18, who-confirms unruled → owner lane);
-- everything else is written by the service role (edge functions) only.

create extension if not exists pgcrypto;

-- ── who may write, and in what lane ─────────────────────────────────────────────────────
create table if not exists pb_members (
  email          text primary key,
  display_name   text not null,
  role           text not null check (role = any (array['owner','rater','viewer'])),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
comment on table pb_members is 'Write lanes (PRO-5). Reading needs no row here: any @whitelabeliq.com signer reads (PRO-7).';

-- ── one row per agency ──────────────────────────────────────────────────────────────────
create table if not exists pb_accounts (
  id                     uuid primary key default gen_random_uuid(),
  key                    text not null unique,            -- norm(name); the engine's own identity key
  name                   text not null,
  domain                 text,                            -- normalized, no www
  pipedrive_org_id       bigint unique,
  orbit_client_id        integer,
  apollo_org_id          text,
  notion_client_id       text,                            -- the master's Client ID (auto-increment), as text
  notion_page_id         text,
  book                   text not null default 'prospect' check (book = any (array['prospect','promoted','parked'])),
  roster_source          text check (roster_source = any (array['pipedrive','notion_master','sales_sheet','tier1_book','gotham','brian_trip','client_book_lapsed','manual'])),
  roster_certified       boolean not null default false,  -- PRO-6: true only once Pipedrive carries the row
  relationship_type      text check (relationship_type = any (array['agency','direct'])),
  lineage                text check (lineage = any (array['lapsed_client'])),
  owner_email            text,
  sponsor_email          text,
  status                 text,                            -- copy of the latest read's status, for listing
  effective_tier         text,                            -- copy of the latest read, for listing
  cell                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  promoted_at            timestamptz,
  promotion_id           uuid
);
create index if not exists pb_accounts_domain_idx on pb_accounts (domain);
create index if not exists pb_accounts_orbit_idx  on pb_accounts (orbit_client_id);
create index if not exists pb_accounts_notion_idx on pb_accounts (notion_client_id);

create table if not exists pb_contacts (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references pb_accounts(id) on delete cascade,
  name                text,
  email               text,
  title               text,
  seniority           text check (seniority = any (array['owner','ops','account_lead','pm','other'])),
  pipedrive_person_id bigint,
  apollo_person_id    text,
  is_decision_maker   boolean,
  last_job_change_at  date,
  source              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists pb_contacts_account_idx on pb_contacts (account_id);
create index if not exists pb_contacts_email_idx   on pb_contacts (lower(email));

-- ── the merge queue: proposed matches a person confirms. Never auto-merged (PRO-18). ────
create table if not exists pb_identity_candidates (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references pb_accounts(id) on delete set null,
  source        text not null,                            -- pipedrive | orbit | fathom | notion | apollo | sheet | client_book
  source_id     text,
  source_name   text,
  source_domain text,
  matched_on    text,                                     -- domain | name_exact | name_norm | none
  confidence    text check (confidence = any (array['high','medium','low'])),
  status        text not null default 'proposed' check (status = any (array['proposed','merged','rejected'])),
  reviewed_by   text,
  reviewed_at   timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists pb_identity_status_idx on pb_identity_candidates (status);

-- ── facts: the evidence-labelled inputs to Dimension A and B. Append-only. ──────────────
create table if not exists pb_facts (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references pb_accounts(id) on delete cascade,
  key            text not null,                           -- a ProspectFeatures key (snake_case)
  value          jsonb,                                   -- null = a recorded "unknown"
  evidence_label text not null check (evidence_label = any (array['evidence','inferred','unknown'])),
  source         text not null,                           -- notion_master | pipedrive | fathom | orbit | apollo | skill | viq | rater | gmail | sheet | client_book
  evidence_url   text,
  observed_at    date,                                    -- when the fact was true / observed
  entered_by     text not null,                           -- email or 'system:<source>'
  stand_in       boolean not null default false,          -- PRO-5: a Brian stand-in is recorded AS a stand-in
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists pb_facts_account_key_idx on pb_facts (account_id, key, created_at desc);

-- ── signals: provenance, weight, lifespan. Append-only; signals expire, never delete. ────
create table if not exists pb_signals (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references pb_accounts(id) on delete cascade,
  contact_id     uuid references pb_contacts(id) on delete set null,
  source         text not null check (source = any (array['pipedrive','fathom','gmail','orbit','apollo','skill','viq','manual','notion_master','sheet','tier1_book','gotham','brian_trip','client_book'])),
  type           text not null,                           -- a key in rubric.signals.catalog
  observed_at    timestamptz not null,
  payload        jsonb,
  evidence_url   text,
  weight         numeric not null,
  lifespan_days  integer,                                 -- null = never expires (informational)
  decays         boolean not null default true,
  entered_by     text not null,
  expires_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists pb_signals_account_idx on pb_signals (account_id, observed_at desc);
create index if not exists pb_signals_type_idx    on pb_signals (type);

-- ── calls: one per Fathom recording that touches a prospect domain ──────────────────────
create table if not exists pb_calls (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid references pb_accounts(id) on delete set null,
  fathom_recording_id   text not null unique,
  title                 text,
  held_at               timestamptz,
  url                   text,
  recorded_by           text,
  attendees             jsonb,                            -- [{name,email,is_external,role}]
  external_domains      text[],
  summary               text,
  transcript_available  boolean not null default false,
  -- the seven quote-backed fields + the two potential questions (R5). Each value is
  -- {value, quote, timestamp, inferred} or the literal "not discussed". Filled by the
  -- extraction step; nothing writes to Pipedrive until confirmed_by is set.
  fields                jsonb,
  extraction_status     text not null default 'pending' check (extraction_status = any (array['pending','extracted','confirmed','skipped'])),
  confirmed_by          text,
  confirmed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists pb_calls_account_idx on pb_calls (account_id, held_at desc);

-- ── deals: a mirror of the Pipedrive deals that matter (never the record) ───────────────
create table if not exists pb_deals (
  pipedrive_deal_id       bigint primary key,
  account_id              uuid references pb_accounts(id) on delete set null,
  title                   text,
  pipeline_id             integer,
  stage_id                integer,
  stage_name              text,
  stage_entered_at        timestamptz,
  value                   numeric,
  currency                text,
  close_date              date,
  close_date_pushes       jsonb not null default '[]'::jsonb,  -- [{from,to,at}]
  status                  text,                                -- open | won | lost | deleted
  won_time                timestamptz,
  lost_time               timestamptz,
  owner_user_id           bigint,
  is_cj                   boolean not null default false,      -- Client Journey cards are excluded from prospect counts
  last_buyer_touch_at     timestamptz,
  buyer_email_velocity_7d integer,
  next_meeting_at         timestamptz,
  decision_maker_engaged  boolean,
  buyer_contacts_30d      integer,
  price_discussed         boolean,
  calls_held              integer,
  health                  text check (health = any (array['green','yellow','red'])),
  health_reasons          jsonb,
  raw                     jsonb,
  updated_at              timestamptz not null default now()
);
create index if not exists pb_deals_account_idx on pb_deals (account_id);

-- ── reads: one row per account per scoring run. The scorecard is the record. ────────────
create table if not exists pb_reads (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references pb_accounts(id) on delete cascade,
  run_id              uuid,
  rubric_version      text not null,
  rubric_fingerprint  text not null,
  run_at              timestamptz not null default now(),
  as_of               date not null,
  status              text not null,
  effective_tier      text,
  computed_tier       text,
  confidence          text,
  qualification_label text,
  facts_present       integer,
  ceiling             text,
  headroom_band       text,
  year1_band          text,
  urgency             text,
  cell                text,
  reason              text not null,
  flags               text[] not null default '{}',
  scorecard           jsonb not null,
  scorecard_sha256    text not null
);
create index if not exists pb_reads_account_run_idx on pb_reads (account_id, run_at desc);
create index if not exists pb_reads_run_idx on pb_reads (run_id);

-- ── the rubric, versioned, with a preview diff before activation ────────────────────────
create table if not exists pb_rubric_versions (
  version       text primary key,
  status        text not null check (status = any (array['draft','active','retired'])),
  spec          jsonb not null,
  spec_sha256   text not null,
  preview_diff  jsonb,
  activated_by  text,
  activated_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- ── the register: every decision that touches a grade lives here, never in a read ───────
create table if not exists pb_register (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind = any (array['decision','override','dispute','proposal','approval','promotion','note'])),
  account_id   uuid references pb_accounts(id) on delete set null,
  made_by      text not null,
  reason_code  text check (reason_code = any (array['data_wrong','relationship_known','timing_known','conflict','other'])),
  text         text not null,
  payload      jsonb,                                     -- e.g. {tier, expires_at} for an override; {fields} for a proposal
  fingerprint  text,
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists pb_register_account_idx on pb_register (account_id, created_at desc);
create index if not exists pb_register_kind_idx on pb_register (kind);

-- ── potential frozen at signing, scored at 6 / 12 / 24 months (Phase 4) ─────────────────
create table if not exists pb_potential_snapshots (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references pb_accounts(id) on delete cascade,
  taken_at     date not null,
  estimator    text not null,
  p10_12m      numeric, p50_12m numeric, p90_12m numeric,
  p10_24m      numeric, p50_24m numeric, p90_24m numeric,
  p_35k_12m    numeric, p_100k_24m numeric,
  assumptions  jsonb,
  actual_6m    numeric, actual_12m numeric, actual_24m numeric,
  scored_at    timestamptz,
  brier        numeric,
  created_at   timestamptz not null default now()
);

-- ── promotion: the one seam between the two systems (PRO-10, PRO-18) ────────────────────
create table if not exists pb_promotions (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid references pb_accounts(id) on delete set null,
  client_key           text,                              -- the Client Book key the person confirmed
  client_name          text,
  first_invoice_at     date,
  proposed_match       jsonb,                             -- what the system suggested and why
  decision             text check (decision = any (array['confirmed','corrected','no_prospect'])),
  confirmed_by         text,
  confirmed_at         timestamptz,
  handoff              jsonb,                             -- PRO-9: the dated prospect-era facts that cross
  created_at           timestamptz not null default now()
);

-- ── every ingest, scoring and decay run ─────────────────────────────────────────────────
create table if not exists pb_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind = any (array['ingest','score','decay','seed','webhook','enrich','export'])),
  source        text,
  triggered_by  text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status = any (array['running','success','partial','failed'])),
  counts        jsonb,
  credits_spent jsonb,
  errors        jsonb
);

-- ── raw inbound webhooks. Service role only. Nothing becomes a call or a deal unless verified.
create table if not exists pb_webhook_inbox (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source = any (array['fathom','pipedrive','apollo','other'])),
  received_at   timestamptz not null default now(),
  headers       jsonb,
  body          jsonb,
  verified      boolean not null default false,
  processed_at  timestamptz,
  error         text
);

-- ── the caller's identity, role and WLIQ membership ─────────────────────────────────────
-- SECURITY INVOKER, per the Client Book's lesson: policy expressions evaluate as the
-- querying role, so these must be executable by `authenticated`. anon never.
create or replace function public.pb_me() returns text
  language sql stable security invoker set search_path = public as
$$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.pb_is_wliq() returns boolean
  language sql stable security invoker set search_path = public as
$$ select pb_me() like '%@whitelabeliq.com' $$;

create or replace function public.pb_role() returns text
  language sql stable security invoker set search_path = public as
$$ select role from pb_members where email = pb_me() and active $$;

revoke execute on function public.pb_me(), public.pb_is_wliq(), public.pb_role() from anon, public;
grant  execute on function public.pb_me(), public.pb_is_wliq(), public.pb_role() to authenticated;

-- ── default deny everywhere ─────────────────────────────────────────────────────────────
alter table pb_members             enable row level security;
alter table pb_accounts            enable row level security;
alter table pb_contacts            enable row level security;
alter table pb_identity_candidates enable row level security;
alter table pb_facts               enable row level security;
alter table pb_signals             enable row level security;
alter table pb_calls               enable row level security;
alter table pb_deals               enable row level security;
alter table pb_reads               enable row level security;
alter table pb_rubric_versions     enable row level security;
alter table pb_register            enable row level security;
alter table pb_potential_snapshots enable row level security;
alter table pb_promotions          enable row level security;
alter table pb_runs                enable row level security;
alter table pb_webhook_inbox       enable row level security;

-- Members: a signer reads their own row (so pb_role() works) and the owner reads all.
create policy pb_members_read on pb_members
  for select to authenticated using (email = pb_me() or pb_role() = 'owner');

-- PRO-7: every WLIQ signer reads the book. No role check.
create policy pb_accounts_read            on pb_accounts            for select to authenticated using (pb_is_wliq());
create policy pb_contacts_read            on pb_contacts            for select to authenticated using (pb_is_wliq());
create policy pb_identity_read            on pb_identity_candidates for select to authenticated using (pb_is_wliq());
create policy pb_facts_read               on pb_facts               for select to authenticated using (pb_is_wliq());
create policy pb_signals_read             on pb_signals             for select to authenticated using (pb_is_wliq());
create policy pb_calls_read               on pb_calls               for select to authenticated using (pb_is_wliq());
create policy pb_deals_read               on pb_deals               for select to authenticated using (pb_is_wliq());
create policy pb_reads_read               on pb_reads               for select to authenticated using (pb_is_wliq());
create policy pb_rubric_read              on pb_rubric_versions     for select to authenticated using (pb_is_wliq());
create policy pb_register_read            on pb_register            for select to authenticated using (pb_is_wliq());
create policy pb_snapshots_read           on pb_potential_snapshots for select to authenticated using (pb_is_wliq());
create policy pb_promotions_read          on pb_promotions          for select to authenticated using (pb_is_wliq());
create policy pb_runs_read                on pb_runs                for select to authenticated using (pb_is_wliq());
-- pb_webhook_inbox has NO select policy for authenticated: raw payloads (transcripts) stay with the service role.

-- PRO-5: raters and the owner enter facts and hand signals, under their own name. Append-only:
-- no UPDATE or DELETE policy exists on pb_facts or pb_signals for any client role.
create policy pb_facts_insert on pb_facts
  for insert to authenticated
  with check (pb_is_wliq() and pb_role() = any (array['owner','rater']) and entered_by = pb_me());

create policy pb_signals_insert on pb_signals
  for insert to authenticated
  with check (pb_is_wliq() and pb_role() = any (array['owner','rater']) and entered_by = pb_me() and source = 'manual');

-- The register: any WLIQ signer may raise a dispute, a proposal or a note under their own name;
-- an override is the owner's alone (PRO-5 revision); a promotion confirmation is the owner's
-- until PRO-18's who-confirms question is ruled. Append-only for every client role.
create policy pb_register_insert_signer on pb_register
  for insert to authenticated
  with check (pb_is_wliq() and made_by = pb_me() and kind = any (array['dispute','proposal','note']));

create policy pb_register_insert_owner on pb_register
  for insert to authenticated
  with check (pb_is_wliq() and made_by = pb_me() and pb_role() = 'owner' and kind = any (array['override','decision','approval','promotion']));

-- The merge queue: a rater or the owner confirms or rejects a proposed match. Only the
-- review fields may change; the trigger below refuses anything else.
create policy pb_identity_review on pb_identity_candidates
  for update to authenticated
  using (pb_is_wliq() and pb_role() = any (array['owner','rater']))
  with check (pb_is_wliq() and pb_role() = any (array['owner','rater']) and reviewed_by = pb_me());

create or replace function public.pb_identity_review_guard() returns trigger
  language plpgsql security invoker set search_path = public as $$
begin
  if new.account_id is distinct from old.account_id
     or new.source is distinct from old.source
     or new.source_id is distinct from old.source_id
     or new.source_name is distinct from old.source_name
     or new.source_domain is distinct from old.source_domain
     or new.matched_on is distinct from old.matched_on
     or new.confidence is distinct from old.confidence
     or new.created_at is distinct from old.created_at then
    raise exception 'pb_identity_candidates: only status, reviewed_by, reviewed_at and note may be changed by a reviewer';
  end if;
  new.reviewed_at := coalesce(new.reviewed_at, now());
  return new;
end $$;

drop trigger if exists pb_identity_review_guard_trg on pb_identity_candidates;
create trigger pb_identity_review_guard_trg
  before update on pb_identity_candidates
  for each row when (current_setting('role', true) = 'authenticated')
  execute function public.pb_identity_review_guard();

-- Promotions: the owner records the confirmation (PRO-18).
create policy pb_promotions_owner on pb_promotions
  for insert to authenticated
  with check (pb_is_wliq() and pb_role() = 'owner' and confirmed_by = pb_me());

revoke all on pb_members, pb_accounts, pb_contacts, pb_identity_candidates, pb_facts, pb_signals,
               pb_calls, pb_deals, pb_reads, pb_rubric_versions, pb_register, pb_potential_snapshots,
               pb_promotions, pb_runs, pb_webhook_inbox from anon;

-- ── the latest read per account, for the page. RLS of pb_reads applies (security_invoker). ──
create or replace view pb_current_reads with (security_invoker = true) as
  select distinct on (r.account_id) r.*
  from pb_reads r
  order by r.account_id, r.run_at desc;

-- ── the latest value per fact key per account. RLS of pb_facts applies. ────────────────
create or replace view pb_current_facts with (security_invoker = true) as
  select distinct on (f.account_id, f.key) f.*
  from pb_facts f
  order by f.account_id, f.key, f.created_at desc;

grant select on pb_current_reads, pb_current_facts to authenticated;

-- ── secrets for the edge functions and cron, read from Vault. Service role only. ────────
-- Set with: select vault.create_secret('<value>', 'PB_SYNC_TOKEN', 'Prospect Book sync bearer');
create or replace function public.pb_secret(secret_name text) returns text
  language sql stable security definer set search_path = public, vault as
$$ select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1 $$;

revoke execute on function public.pb_secret(text) from anon, authenticated, public;
grant  execute on function public.pb_secret(text) to service_role;

-- ── keep pb_accounts.updated_at honest ─────────────────────────────────────────────────
create or replace function public.pb_touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists pb_accounts_touch on pb_accounts;
create trigger pb_accounts_touch before update on pb_accounts for each row execute function public.pb_touch_updated_at();
drop trigger if exists pb_contacts_touch on pb_contacts;
create trigger pb_contacts_touch before update on pb_contacts for each row execute function public.pb_touch_updated_at();
drop trigger if exists pb_calls_touch on pb_calls;
create trigger pb_calls_touch before update on pb_calls for each row execute function public.pb_touch_updated_at();
drop trigger if exists pb_deals_touch on pb_deals;
create trigger pb_deals_touch before update on pb_deals for each row execute function public.pb_touch_updated_at();
