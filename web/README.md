# The Prospect Book page

`index.html` is the whole page: one self-contained file, no build step, no bundler, no
framework, no fonts fetched. It loads `@supabase/supabase-js@2` from a CDN, signs the reader in
with a magic link, and reads the `pb_*` tables under that reader's own session. Row Level
Security decides what each signer sees and may write; the page enforces nothing on its own.

**Reads change only when the nightly run scores; this page never grades.** Every tier prints
the word *anticipated* with its confidence (PRO-1r); every read is a band, a word or a sentence,
never a score; while the rubric says so, every row carries **UNVALIDATED (PRO-8)**.

## Where it is hosted

**GitHub Pages, from `web/`.** The workflow `.github/workflows/deploy-pages.yml` publishes this
directory (manual dispatch). Two one-time steps, both by a repo admin:

1. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**. Until
   Pages is enabled the workflow cannot deploy.
2. Run the workflow once. The page appears at `https://<owner>.github.io/prospect-grading/`.

The repository is public, and so is this page's source. That is fine: the file carries only the
project URL and the **publishable** key, which is designed to be shipped to browsers. Nothing is
readable without a signed-in `@whitelabeliq.com` session, and nothing is writable outside the
lanes RLS grants (below).

### Why it cannot live on `*.supabase.co`

Supabase rewrites any HTML response served from `*.supabase.co` — Edge Functions and Storage
alike, with or without an API key — to `content-type: text/plain` with a sandboxing
`content-security-policy`, so a browser shows the source instead of the page. It is an
anti-phishing rule on a shared apex domain, not something a function can opt out of (the Client
Book measured it, and this page inherits the lesson). JSON passes through untouched, so the
Auth and REST APIs the page talks to are unaffected; only the HTML needs its own origin.

## The Supabase Auth step that will otherwise break sign-in

Supabase only sends a magic link to a redirect URL it has been told to trust. The page passes
`emailRedirectTo: window.location.href`, so until the Pages address is on that list the link in
the email bounces to the project's default Site URL and sign-in looks broken for reasons the
page cannot report.

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL** → the Pages address (`https://<owner>.github.io/prospect-grading/`)
- **Redirect URLs** → add that address and `https://<owner>.github.io/prospect-grading/**`

Add a custom domain the same way if one is attached later. For a local preview
(`python3 -m http.server` inside `web/`), add `http://localhost:8000/**` too — or sign in on the
published page first and open the local copy afterwards, since the session lives in the browser.

## How RLS decides what a signer can do

All policies live in `supabase/migrations/20260909120000_prospect_book_schema.sql`, corrected
by `20260909120300_prospect_book_fixes.sql`; the two procedures the page calls are
`pb_merge_accounts` (`20260909120200` / re-issued in `20260909120300`) and
`pb_review_candidate` (`20260909120400_prospect_book_candidate_review.sql`). The page only
shows a form when `pb_members` says the lane exists; the database is the authority and refuses
anything else, and the page prints the refusal verbatim.

| Who | Reads | May write |
|---|---|---|
| Any signed-in `@whitelabeliq.com` address (PRO-7) | every `pb_*` table and the two views, except `pb_webhook_inbox` (service role only — raw payloads and transcripts never reach a browser) | `pb_register` rows of kind `dispute`, `proposal`, `note`, under their own email |
| `pb_members.role = rater` | as above | `pb_facts` inserts and `pb_signals` inserts with source `manual`, both with `entered_by` = their own email (append-only: no update, no delete; a trigger re-weights every hand signal from the active rubric's catalog); call `pb_review_candidate` and `pb_merge_accounts` (both check the lane again inside the database) |
| `pb_members.role = owner` | as above, plus every `pb_members` row | everything a rater may, plus `pb_register` kinds `override`, `decision`, `approval`, `promotion`, and `pb_promotions` |
| `pb_members.role = viewer`, or no row | as any signer | as any signer (dispute / proposal / note only) |
| An address outside `whitelabeliq.com` | nothing — every select returns empty | nothing |

Identity comes from the JWT (`pb_me()` lowercases `auth.jwt() ->> 'email'`), so `entered_by`,
`made_by` and `reviewed_by` must equal the signer's own address or the insert fails the policy's
`with check`. Reads (`pb_reads`, `pb_current_reads`) have no client write path at all: the
nightly `pb-score` run is the only writer, which is what keeps "this page never grades" true.

What the page writes, and what happens next:

- **Add a fact** → one `pb_facts` row (key from the `ProspectFeatures` list, value, evidence
  label, source, evidence URL, observed date, stand-in flag, note). The engine reads the latest
  row per key at the next run.
- **Raise a dispute / proposal / note** → one `pb_register` row. It changes no read on its own.
- **Set override** (owner) → one `pb_register` row of kind `override` with
  `payload = {tier, expires_at}`, a reason code and a written reason. The engine applies it at
  the next run — or refuses it beyond the one-tier cap and flags the row.
- **Add a hand signal** (owner / rater) → one `pb_signals` row with `source = 'manual'` and
  `entered_by` = the signer. The type is chosen from the **active** rubric's `signals.catalog`
  (the select shows each entry's label and weight; `pb_rubric_versions where status = 'active'`
  is read once at boot). The page copies `weight`, `lifespan_days` and `decays` from the
  catalog entry, and says so in a hint — the database trigger `pb_signals_catalog_guard`
  overwrites all three (and `expires_at`) from the same catalog anyway, so a weight never comes
  from a hand. The observed date is recorded as the start of that day; the note travels as
  `payload.text`. Without a readable active rubric the form is replaced by a notice, because the
  trigger would refuse the insert for the same reason.
- **Review match** (owner / rater) → `rpc('pb_review_candidate', { p_candidate, p_decision:
  'merged' | 'rejected', p_note })`. The procedure carries the decision through and the page
  prints what it reports: *Orbit client id attached*, *Pipedrive organisation attached; roster
  certified (PRO-6)*, *merged into <name>* with the moved counts, *Notion client id attached*,
  *calls attached: n*, or *recorded only*; a refusal is printed verbatim. When a Pipedrive review
  merges the account into the row that already carries that organisation, the page reloads the
  roster and opens the surviving row. Every decision is a `pb_register` row of kind `decision`.
- **Merge into…** (owner / rater) → `rpc('pb_merge_accounts', { p_source: this row, p_target,
  p_note })`, after a confirm dialog: *This moves every fact, signal, contact, call and deal
  onto <target> and records the decision under your name. Reads are not moved. Continue?* The
  survivor is picked by name or domain search over the loaded roster (rows already merged are
  never offered). On success the page reloads the roster and opens the survivor, with the moved
  counts in a notice. Reads are never moved: they were computed for the row as it was, and the
  next scoring run reads the merged row.

Every successful write re-renders the sheet, so the confirmation appears as a one-shot notice at
the top of the sheet rather than inside the form that submitted it.

## Merged rows

`pb_accounts.book` is `prospect`, `parked`, `promoted` or `merged`. The roster loads only the
first three: a merged row is history, never a ranked row, and never a merge target. On the
survivor's sheet a **Merged rows** group (and a line in *Sources*) lists every account whose
`merged_into` points at it — name, domain, roster source and when — read from `pb_accounts where
merged_into = <id>`. A `promoted` row stays on the roster and carries a *promoted* chip and its
promotion date. Following an old link to a merged row (`#account=<id>`) shows a note naming the
row it was merged into, with a link, instead of an empty sheet.

## Editing

There is nothing to build. Edit `index.html`, open it, run the workflow. The vocabulary the page
needs at runtime (tier words, signal labels and the hand-signal catalog, year-one bands, reason
codes, the flags list) comes from the **active** `pb_rubric_versions` row when one is readable
and falls back to the constants at the top of the script, which mirror `core/prospect_types.ts`
and `core/rubric.prospect.v0.1.json`. All text reaches the DOM through `textContent`; the page
never sets `innerHTML` from data. Potential is shown as `headroom_band`, `year1_band`, `ceiling`
and `confidence` only; `wallet`, `headroom` and `winnable_share` stay on the scorecard for audit
and are never rendered.

The pure helpers (sorting by `chase_rank_key`, band lookup, fact-value coercion, the override
cap warning, the words for what a review or merge reported) sit between the `@pure-start` and
`@pure-end` markers in the script and touch no DOM, clock, network or page state. A sanity
script slices that block out of the HTML and runs it under Node in an empty context:

```bash
node --experimental-strip-types scripts/page_pure_test.ts   # prints "page_pure: N checks, F failed"
```

Keep new helpers that need no DOM inside the block, and anything they need declared there too —
a reference to a page global is a failure in that script before it is a bug in a browser.
