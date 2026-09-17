-- `orbit` joins the roster sources. Additive only — no existing value is renamed or repurposed
-- (the contract rule in CLAUDE.md and DECISIONS §8), and `core/prospect_types.ts` gains the same
-- member in the same commit so the type and the constraint cannot drift.
--
-- PRO-6 is untouched: Pipedrive remains the only certified roster. An Orbit admission is
-- uncertified intake exactly like a Notion one, and is still graded — PRO-8's principle that a
-- grade is labelled, never withheld.

alter table public.pb_accounts drop constraint if exists pb_accounts_roster_source_check;
alter table public.pb_accounts add constraint pb_accounts_roster_source_check
  check (roster_source = any (array[
    'pipedrive'::text, 'notion_master'::text, 'sales_sheet'::text, 'tier1_book'::text,
    'gotham'::text, 'brian_trip'::text, 'client_book_lapsed'::text, 'manual'::text,
    'orbit'::text
  ]));
