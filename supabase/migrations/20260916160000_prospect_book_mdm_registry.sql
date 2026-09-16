-- WLIQ Prospect Book — the identity registry, mirrored. (16 Sep 2026.)
--
-- `wliq-mdm` maintains a reviewed identity registry: which company is which, which records in
-- Orbit and Notion belong to it, what it has been called, and what must never become a company at
-- all. The Prospect Book has been guessing at all four, badly:
--
--   * an account in this book is filed under WLIQ's own domain, carrying 53 of our own projects —
--     the registry lists that record as junk by name;
--   * two accounts here are the two halves of a ruled poison pair, and a name-similarity merge
--     would have joined them (the registry records the score that proves no threshold is safe);
--   * accounts here sit under project labels and people's names rather than company names, which
--     the registry already resolves as non-authoritative aliases.
--
-- So this mirrors the registry rather than re-deriving it. Five tables and a resolution view.
--
-- **It is advisory, exactly like `pb_roster_drift`.** Nothing here writes a fact, a grade or an
-- account. It reports: this account appears to be that company, this record is junk, these two may
-- never be merged. A person decides, and the decision is a register row (rule 8).
--
-- Two properties of the registry that this mirror must not quietly discard:
--
--   1. **Review state is part of the data.** Rows are green (re-verified against a live system),
--      yellow (documented, with an open question) or white (name only). A yellow row is not a
--      confirmed row and must never be treated as one.
--   2. **Notion Client IDs are reference only** (the registry's rule R4) and are never a join key.
--      They are stored for traceability and the resolver must not match on them.
--
-- The registry is also not signed off yet — its own review sheet says nothing changes until the
-- owner answers per company. `signed_off_at` stays null until that happens, and the resolution
-- view reports `pending_signoff` so no downstream job can mistake a draft for a ruling.

create table if not exists public.pb_mdm_companies (
  slug            text primary key,
  canonical_name  text not null,
  entity_type     text not null check (entity_type in ('client','prospect','sub_client')),
  status          text,                      -- active · archived
  review_state    text not null check (review_state in ('green','yellow','white')),
  parent_slug     text references public.pb_mdm_companies(slug),
  note            text,
  sources         text[] not null default '{}',
  registry_version text not null,
  signed_off_at   timestamptz,               -- null until the owner answers for this company
  observed_at     timestamptz not null default now()
);

comment on table public.pb_mdm_companies is
  'Mirror of the wliq-mdm identity registry: one row per company it has ruled on. Advisory only — nothing here writes a fact, a grade or an account. review_state green/yellow/white is part of the data: a yellow row is documented with an open question, not a confirmed one.';

create table if not exists public.pb_mdm_records (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null references public.pb_mdm_companies(slug) on delete cascade,
  system        text not null check (system in ('orbit','notion')),
  record_id     text not null,
  record_title  text,
  record_status text,
  live_state    text,                        -- what the live system said at the re-check
  is_archived   boolean not null default false,
  -- Registry rule R4: a Notion Client ID is reference only and is NEVER a join key.
  reference_only boolean not null default false,
  note          text,
  unique (system, record_id, slug)
);

comment on column public.pb_mdm_records.reference_only is
  'Registry rule R4: true for Notion Client IDs, which are carried for traceability and must never be used to join.';

create table if not exists public.pb_mdm_aliases (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null references public.pb_mdm_companies(slug) on delete cascade,
  alias         text not null,
  alias_type    text not null check (alias_type in ('name','domain')),
  -- A project label or a person's name kept only so the source row resolves. Not a company name.
  authoritative boolean not null default true,
  unique (slug, alias, alias_type)
);

create index if not exists pb_mdm_aliases_lookup on public.pb_mdm_aliases (alias_type, lower(alias));

create table if not exists public.pb_mdm_junk (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('name','orbit_record','notion_record')),
  value       text not null,
  why         text not null,
  live_today  text,
  unique (kind, value)
);

comment on table public.pb_mdm_junk is
  'Names and records that must never become a company: WLIQ itself, test rows, internal buckets. A loader skips them and a resolver answers "not an entity".';

create table if not exists public.pb_mdm_poison_pairs (
  id        uuid primary key default gen_random_uuid(),
  slug_a    text not null,
  slug_b    text not null,
  score     numeric,
  why       text not null,
  check (slug_a < slug_b),
  unique (slug_a, slug_b)
);

comment on table public.pb_mdm_poison_pairs is
  'Pairs a steward has ruled are DIFFERENT companies. They can never be proposed for merge again, and merging them needs an explicit override with a written reason. The stored score is the proof that no similarity threshold is merge-safe.';

create table if not exists public.pb_mdm_search_traps (
  id        uuid primary key default gen_random_uuid(),
  query     text not null unique,
  slug      text not null references public.pb_mdm_companies(slug) on delete cascade,
  why       text not null
);

-- CLAUDE.md: a new pb_ table arrives with anon AND authenticated holding everything.
revoke all on public.pb_mdm_companies, public.pb_mdm_records, public.pb_mdm_aliases,
               public.pb_mdm_junk, public.pb_mdm_poison_pairs, public.pb_mdm_search_traps
  from anon, authenticated;
grant select on public.pb_mdm_companies, public.pb_mdm_records, public.pb_mdm_aliases,
                public.pb_mdm_junk, public.pb_mdm_poison_pairs, public.pb_mdm_search_traps
  to authenticated;

alter table public.pb_mdm_companies     enable row level security;
alter table public.pb_mdm_records       enable row level security;
alter table public.pb_mdm_aliases       enable row level security;
alter table public.pb_mdm_junk          enable row level security;
alter table public.pb_mdm_poison_pairs  enable row level security;
alter table public.pb_mdm_search_traps  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['pb_mdm_companies','pb_mdm_records','pb_mdm_aliases',
                           'pb_mdm_junk','pb_mdm_poison_pairs','pb_mdm_search_traps'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (true)', t, t);
  end loop;
end $$;

/**
 * What the registry says about the accounts in this book.
 *
 * Matches on domain first, then on an alias, then on the canonical name. Never on a Notion Client
 * ID (R4). Reports rather than decides: `action` is what a person is being asked to consider.
 */
create or replace view public.pb_mdm_resolution
with (security_invoker = true) as
with m as (
  select a.id as account_id, a.name as account_name, a.domain,
         c.slug, c.canonical_name, c.entity_type, c.status, c.review_state, c.signed_off_at,
         case
           when al_d.slug is not null then 'domain'
           when al_n.slug is not null then 'alias_name'
           else 'canonical_name'
         end as matched_on,
         coalesce(al_n.authoritative, al_d.authoritative, true) as alias_authoritative
    from public.pb_accounts a
    left join public.pb_mdm_aliases al_d
           on al_d.alias_type = 'domain' and lower(al_d.alias) = lower(a.domain)
    left join public.pb_mdm_aliases al_n
           on al_n.alias_type = 'name' and lower(al_n.alias) = lower(a.name)
    join public.pb_mdm_companies c
           on c.slug = coalesce(al_d.slug, al_n.slug)
           or lower(c.canonical_name) = lower(a.name)
)
select m.*,
       (select count(*) from public.pb_mdm_junk j
         where (j.kind = 'name' and lower(j.value) = lower(m.account_name))
            or (j.kind = 'name' and lower(j.value) = lower(coalesce(m.domain,'')))) > 0 as is_junk,
       case
         when m.entity_type = 'client'   then 'client per the registry — belongs in the promotion queue, not a chase list'
         when m.entity_type = 'sub_client' then 'a pod of another company — not an account of its own'
         when m.entity_type = 'prospect' then 'prospect per the registry — stays in the book'
       end as action,
       (m.signed_off_at is null) as pending_signoff
  from m;

comment on view public.pb_mdm_resolution is
  'Prospect Book accounts matched against the identity registry, by domain then alias then canonical name — never by a Notion Client ID (R4). Advisory: it says what the registry believes and whether that belief has been signed off, and a person decides.';
