# WLIQ Prospect Book

The Prospect Book is White Label IQ's grading record for agencies that are not yet clients.
It produces one row per agency with four reads — computed separately and never summed —
so the sales team knows **who to chase first and how much the pursuit is worth** (PRO-0).
Every tier is printed as *anticipated* with its confidence (PRO-1r), and under rubric v0.1
every scorecard also prints **UNVALIDATED (PRO-8)**, because the pre-registered rank test
has not yet been run. It is an independent system from the Client Book (PRO-17): it borrows
that system's discipline — a pure engine, a versioned rubric as data, evidence labels,
append-only facts, a decision register, golden fixtures, default-deny RLS — and none of its
code, tables or identity list. The two connect at exactly one event: promotion, when a
first invoice appears and a person confirms which prospect it was (PRO-10, PRO-18).

## The four reads (plus deal health)

| Read | Question | Output | Inputs |
|---|---|---|---|
| **Fit** (Dimension B) | Is it work we're good at? | anticipated tier Platinum / Gold / Silver / Bronze + confidence | ICP class, service shape, economics, adjustment facts |
| **Qualification** (Dimension A) | Is the deal real? | count of money · authority · timing · specification present → Qualified / Partly qualified / Conversation | CRM facts, quotes, call attendance |
| **Potential** | How big could it get? | ceiling Project / Embedded / Partner, headroom band, year-1 **band** (never a figure), confidence | headcount, WL signal, archetype, vendor rank, quotes, climb evidence |
| **Signals** | Are they moving now? | decayed score → urgency Super Hot / Hot / Warm / Cold, tasks with SLAs | `pb_signals` |
| **Deal health** | Are we winning? | red / yellow / green per open deal, warnings | `pb_deals` (Pipedrive), Gmail counts, Fathom fields |

Each record also carries a `status` (Parked / Unclassified / Overridden / Ranked), an
`effective_tier`, a `cell` (tier × ceiling), a `chase_rank_key`, a one-sentence `reason`,
`flags`, and the full trace. No bare numbers reach the page: bands, tiers and sentences only.

## Architecture in five lines

1. **`core/`** — a pure, deterministic engine: `grade(features, rubric, options) → scorecard`. No clock, no I/O; `as_of` is an input. Every threshold, weight and lifespan lives in `core/rubric.prospect.v0.1.json`, never in code.
2. **`ingest/`** — pure mappers from each source (the Pipedrive roster pull and webhooks, Notion master, Orbit quotes, Fathom webhooks) to `pb_*` rows, plus identity matching that proposes and never auto-merges below `high` confidence. `scripts/seed.ts` composes them once into SQL files (`scripts/seed_README.md`).
3. **`supabase/`** — the `pb_*` schema with default-deny RLS (five migrations, all applied), Supabase Edge Functions (`pb-sync`, `pb-score`, `pb-fathom-webhook`, `pb-pipedrive-webhook`, all deployed with `verify_jwt = false` because none of their callers presents a Supabase JWT) and a `pg_cron` nightly score. Secrets live in Vault.
4. **`web/index.html`** — one file, no build step, magic-link sign-in, published to GitHub Pages; it reads through RLS with the publishable key and never changes a read by hand.
5. **`explain/`** — generates `docs/METHOD.md` from the rubric; a test fails when the document drifts from the JSON.

## Running the tests

```bash
npm test                       # or: bash scripts/test_all.sh
node --experimental-strip-types core/engine_test.ts        # one file
```

Node 22+ is required (`--experimental-strip-types`). The same files run under Deno
unchanged: relative imports carry `.ts` extensions and `core/`, `ingest/` and `explain/`
have no npm dependencies. `npm test` runs every `*_test.ts` under `core/`, `ingest/`,
`explain/`, `scripts/` and `supabase/functions/`, then checks that the functions' `_shared/`
copies match their originals (`bash scripts/sync_shared.sh --check`). `core/engine_test.ts`
replays every fixture in `fixtures/golden.json` and fails on any drift.

## Deploying

Everything deploys through the Supabase MCP from a session (project `sgagrmapuovnjwvgsxbp`);
the CLI equivalents are shown for a machine with network access. Step-by-step operator
instructions, including the Vault secrets, the webhook registrations, the merge queue and
the seed, are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md); the access status is in
[`docs/PHASE0.md`](docs/PHASE0.md). As of 9 September: Pipedrive is connected (the ruled
roster source, PRO-6, is readable and the certified roster is derived from its Client
Journey cards), the five migrations are applied, rubric `0.1.0` is active, and the four
functions deploy with `verify_jwt = false` — `pb-sync` and `pb-score` are called with the
Book's own bearer (by a session and by pg_cron), the webhooks with their own signature or
HTTP Basic check, and the gateway would reject all of those under `verify_jwt = true`.

```bash
# Migrations (MCP: apply_migration, one call per file, in order):
#   20260909120000 schema + RLS · 20260909120100 cron · 20260909120200 merge ·
#   20260909120300 fixes · 20260909120400 candidate review
supabase db push --project-ref sgagrmapuovnjwvgsxbp

# Edge functions (MCP: deploy_edge_function, one call per function, verify_jwt = false)
supabase functions deploy pb-sync               --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-score              --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-fathom-webhook     --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
supabase functions deploy pb-pipedrive-webhook  --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt

# The page: enable GitHub Pages once (Settings → Pages → GitHub Actions), then dispatch
# .github/workflows/deploy-pages.yml by hand. It uploads web/ and nothing else.
```

## The rulings this build encodes

The Grading Register's prospect rulings PRO-0 … PRO-18 are authoritative; where the 9 Sep
build brief disagreed with them, the register won. [`docs/DECISIONS.md`](docs/DECISIONS.md)
lists every point where that happened and the assumptions the build proceeds on (each is a
toggle in the rubric). [`docs/DESIGN.md`](docs/DESIGN.md) is the contract for what is
built; [`docs/METHOD.md`](docs/METHOD.md) is the generated, human-readable method.

## This repository is public

No prospect data is committed here: no agency names, no dollar bands, no seed exports, no
gate reports, no raw pulls. Fixtures are synthetic. Names of people appear only as roles.
The page carries only a publishable key; every read is behind RLS and requires a signed-in
`@whitelabeliq.com` address (PRO-7). `.gitignore` excludes `data/` and `scratch/` for the
same reason.

## Where the build kit lives

The 9 Sep build kit — the brief, the research, the seed exports and the gate reports — is
**not** in this repository. It lives in Google Drive under
`Documents/Claude/prospect grading/`. Those documents carry Notion URLs, credit balances and
staff names and stay out of a public repo (DECISIONS.md §4).
