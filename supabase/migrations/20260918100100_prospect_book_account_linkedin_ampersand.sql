-- Widen the company-page constraint to admit `&`.
--
-- Six of the roster's accounts are agencies with an ampersand in the name and a LinkedIn value a
-- person typed into Pipedrive by hand. `&` is legal in a URL path segment (it is only special in a
-- query string), and rule 9 — a person outranks a machine — says keep what they wrote rather than
-- drop six real agencies or re-encode their slug into a guess. `ingest/identity.ts`'s
-- normalizeLinkedinCompany() admits the same character.
alter table public.pb_accounts
  drop constraint if exists pb_accounts_linkedin_url_is_a_company;
alter table public.pb_accounts
  add constraint pb_accounts_linkedin_url_is_a_company
  check (linkedin_url is null
         or linkedin_url ~ '^https://www\.linkedin\.com/company/[a-z0-9%._&-]+$');
