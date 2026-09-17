-- Owner ruling, 17 Sep 2026: "no sign in required."
--
-- The previous migration put pb_dossier() behind `authenticated`, on the CLAUDE.md line that
-- opening people and candid judgements is the owner's call and not a default. He has now made
-- that call, explicitly, having been told in one sentence what it means: the page is served
-- publicly with no login, so the dossiers — names and titles, call summaries, and the written
-- read on each agency — are visible to anyone with the URL. Recorded in DECISIONS §43; this
-- comment is the standing note so no later session "fixes" it back.
--
-- What is still NOT returned, and why it is not an oversight: contact EMAIL ADDRESSES. The
-- function never selected them. The 16 September artifact the owner ruled the layout (§37) shows
-- a person's name and title and nothing else, so leaving the address out is matching the layout
-- rather than overriding the ruling. A later ruling can add it in one line.
grant execute on function public.pb_dossier(uuid) to anon;

comment on function public.pb_dossier(uuid) is
  'One account''s full dossier — the 16 September board''s row detail (DECISIONS §37, §43): the '
  'engine''s read and full trace, the written brief, the research read, people, calls, contact '
  'events, resolved facts with their evidence labels, signals, register rows and the Apollo '
  'check. PUBLIC by owner ruling of 17 Sep 2026 ("no sign in required"), which is why this is '
  'granted to anon despite carrying candid judgements about named companies. Email addresses are '
  'not returned — the layout being matched shows name and title only.';