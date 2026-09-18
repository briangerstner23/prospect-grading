-- SUPERSEDED — NOT WHAT RAN. This file was written by the 16 September session on branch
-- claude/new-session-glwxzh and never applied under this name; the database ran
--   20260916141700_prospect_book_norm_company_suffixes.sql
-- instead. Kept because it is what that session wrote and the reasoning in it is real, but
-- the filed version above is the one that is live. DECISIONS §45.

-- Company-name normaliser for cross-system joins.
--
-- The first version was too literal and five quoted companies fell out of the join. Two of the
-- five are pure spelling: an ampersand where the book writes "and", and a legal suffix the book
-- keeps ("Inc") that the delivery system drops. Those are mechanical, so the normaliser handles
-- them.
--
-- The other three are not spelling and must NOT be normalised away: a genuine typo in the source,
-- a brand name against a legal name, and a parenthetical naming the agency behind a sub-brand.
-- Each is an ALIAS — an assertion that two names are one company — and an alias is an identity
-- decision (rule 8). They stay in pb_orbit_quote_unmatched for a person, where they are visible,
-- rather than being guessed by a cleverer regex. A normaliser loose enough to match those three
-- would also match companies that are genuinely different, and it would do it silently.
create or replace function public.pb_norm_company(p text)
returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 replace(lower(coalesce(p, '')), '&', 'and'),
                 '^the\s+', ''),
               '[,.]?\s+(inc|llc|ltd|lp|co|corp|corporation|limited|company)\.?$', '', 'g'),
             '[^a-z0-9]+', '', 'g'),
           '(inc|llc|ltd)$', '');
$$;

comment on function public.pb_norm_company(text) is
  'Company-name normaliser for cross-system joins: ampersand to "and", leading "The" dropped, '
  'trailing legal suffix dropped, everything non-alphanumeric removed. Deliberately does NOT '
  'try to resolve typos, brand-vs-legal names or parentheticals — those are aliases, and an '
  'alias is a person''s decision (rule 8).';
