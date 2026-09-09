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

All policies live in `supabase/migrations/20260909120000_prospect_book_schema.sql`. The page
only shows a form when `pb_members` says the lane exists; the database is the authority and
refuses anything else, and the page prints the refusal verbatim.

| Who | Reads | May write |
|---|---|---|
| Any signed-in `@whitelabeliq.com` address (PRO-7) | every `pb_*` table and the two views, except `pb_webhook_inbox` (service role only — raw payloads and transcripts never reach a browser) | `pb_register` rows of kind `dispute`, `proposal`, `note`, under their own email |
| `pb_members.role = rater` | as above | `pb_facts` inserts with `entered_by` = their own email (append-only: no update, no delete); review `pb_identity_candidates` (status, note, `reviewed_by` = own email — a trigger refuses any other column) |
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
- **Review match** (owner / rater) → updates `status`, `note`, `reviewed_by` on a
  `pb_identity_candidates` row. The attachment itself happens in the next ingest; nothing on the
  page merges accounts (PRO-18).

## Editing

There is nothing to build. Edit `index.html`, open it, run the workflow. The vocabulary the page
needs at runtime (tier words, signal labels, year-one bands, reason codes, the flags list) comes
from the active `pb_rubric_versions` row when one is readable and falls back to the constants at
the top of the script, which mirror `core/prospect_types.ts` and `core/rubric.prospect.v0.1.json`.
All text reaches the DOM through `textContent`; the page never sets `innerHTML` from data.
