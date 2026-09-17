-- Junk by domain, and marking what came from the registry versus what this book observed.
--
-- The registry's junk list names WLIQ itself so no loader turns it into a client. This book holds
-- an account under WLIQ's OWN domain carrying 53 of our own projects — the same junk reached by a
-- different key, which the name-only check could not catch.
--
-- Two changes, both small and both honest about provenance:
--   * `kind` accepts 'domain', so a junk entry can be keyed the way this book joins;
--   * `origin` records whether a row came from the registry or was observed here. A row this book
--     added is a PROPOSAL to the registry's steward, not an edit to the registry.

alter table public.pb_mdm_junk drop constraint if exists pb_mdm_junk_kind_check;
alter table public.pb_mdm_junk add constraint pb_mdm_junk_kind_check
  check (kind in ('name','domain','orbit_record','notion_record'));

alter table public.pb_mdm_junk add column if not exists origin text not null default 'wliq-mdm'
  check (origin in ('wliq-mdm','prospect-book'));

comment on column public.pb_mdm_junk.origin is
  'wliq-mdm: mirrored from the registry. prospect-book: observed here and PROPOSED to the registry steward — this book never edits the registry.';

-- The resolution view now tests the domain kind too.
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
       exists (select 1 from public.pb_mdm_junk j
                where (j.kind = 'name'   and lower(j.value) = lower(m.account_name))
                   or (j.kind = 'domain' and lower(j.value) = lower(coalesce(m.domain,'')))) as is_junk,
       case
         when m.entity_type = 'client'     then 'client per the registry — belongs in the promotion queue, not a chase list'
         when m.entity_type = 'sub_client' then 'a pod of another company — not an account of its own'
         when m.entity_type = 'prospect'   then 'prospect per the registry — stays in the book'
       end as action,
       (m.signed_off_at is null) as pending_signoff
  from m;

/**
 * Accounts in this book that the registry's junk list says are not companies at all.
 * Reported, never deleted — removing an account is a person's decision (rule 8).
 */
create or replace view public.pb_mdm_junk_hits
with (security_invoker = true) as
select a.id as account_id, a.name, a.domain, j.kind, j.value, j.why, j.origin
  from public.pb_accounts a
  join public.pb_mdm_junk j
    on (j.kind = 'name'   and lower(j.value) = lower(a.name))
    or (j.kind = 'domain' and lower(j.value) = lower(coalesce(a.domain,'')));

comment on view public.pb_mdm_junk_hits is
  'Accounts in this book that the identity registry says are not companies. Reported, never deleted — an account leaves the book by a person''s decision, recorded in pb_register.';
