-- The LinkedIn company page, as an attribute of the ACCOUNT.
--
-- Where it comes from: Pipedrive has carried it natively on the organisation record all along
-- (`PipedriveOrg.linkedin`), and `ingest/pipedrive_seed.ts` has declared the field since the
-- certified roster pull without ever reading it. 310 of the 830 live accounts already have one
-- sitting there. This migration is the column it lands in; the seed change is the other half.
--
-- Why NOT pb_facts. A fact's key must be a `ProspectFeatures` key (CLAUDE.md, conventions) and
-- nothing about a LinkedIn URL is graded: it fires no gate, no adjustment and no band. It is an
-- identity attribute, the same class as `domain`, so it rides on pb_accounts next to it. Putting
-- it in pb_facts would have made every scorecard carry an input the rubric cannot read, and rule 5
-- (unknown is never evidence) would have had nothing to say about it.
--
-- Why it is safe for anon to read. pb_accounts is already readable by anon (DECISIONS §5) and
-- `domain` sits in the same row: a company's public page is the same class of public fact as its
-- website. What is NOT that class is a PERSON — so the check constraint below refuses anything
-- that is not `/company/`. Three of the roster's own Pipedrive values are personal `/in/`
-- profiles, and without the constraint the first sync would have published an owner's private
-- profile on a public board. `ingest/identity.ts`'s normalizeLinkedinCompany() refuses the same
-- shapes in the pure path; this is the database saying so independently, because the page reads
-- the table and not the TypeScript.
--
-- ADDITIVE and NULLABLE, so it satisfies DECISIONS §8: no existing key is renamed, retyped or
-- repurposed, and every account that has no page keeps a null rather than a guess (rule 5).

alter table public.pb_accounts
  add column if not exists linkedin_url    text,
  add column if not exists linkedin_uid    text,
  add column if not exists linkedin_source text;

comment on column public.pb_accounts.linkedin_url is
  'The LinkedIn COMPANY page, normalised to https://www.linkedin.com/company/<slug>. Never a personal /in/ profile — see the check constraint. Null means unknown, never "none".';
comment on column public.pb_accounts.linkedin_uid is
  'LinkedIn''s own numeric organisation id, when the source gave one. Survives a slug rename, which the URL does not, so it is the stable key of the two.';
comment on column public.pb_accounts.linkedin_source is
  'Which source produced the URL: pipedrive (the org record), apollo (bulk_enrich) or rater (a person typed it). A person outranks a machine — rule 9 — so an apollo sweep must not overwrite a rater value.';

-- A person is not an organisation. This is the constraint, not a convention.
alter table public.pb_accounts
  drop constraint if exists pb_accounts_linkedin_url_is_a_company;
alter table public.pb_accounts
  add constraint pb_accounts_linkedin_url_is_a_company
  check (linkedin_url is null
         or linkedin_url ~ '^https://www\.linkedin\.com/company/[a-z0-9%._-]+$');

alter table public.pb_accounts
  drop constraint if exists pb_accounts_linkedin_source_known;
alter table public.pb_accounts
  add constraint pb_accounts_linkedin_source_known
  check (linkedin_source is null
         or linkedin_source in ('pipedrive', 'apollo', 'rater', 'website'));

-- A url with no source, or a source with no url, is a half-written row either way.
alter table public.pb_accounts
  drop constraint if exists pb_accounts_linkedin_url_has_a_source;
alter table public.pb_accounts
  add constraint pb_accounts_linkedin_url_has_a_source
  check ((linkedin_url is null) = (linkedin_source is null));

create index if not exists pb_accounts_linkedin_url_idx
  on public.pb_accounts (linkedin_url) where linkedin_url is not null;

-- No new table, so no new grant: pb_accounts already holds exactly `select` for anon and
-- authenticated, and a column added to a table inherits the table's privileges. The CLAUDE.md
-- grant check still returns nothing after this migration — verified, not assumed.
