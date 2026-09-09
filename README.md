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
2. **`ingest/`** — pure mappers from each source (Notion master, Orbit quotes, Pipedrive webhooks, Fathom webhooks) to `pb_*` rows, plus identity matching that proposes and never auto-merges below `high` confidence.
3. **`supabase/`** — the `pb_*` schema with default-deny RLS, Supabase Edge Functions (`pb-sync`, `pb-score`, `pb-fathom-webhook`, `pb-pipedrive-webhook`) and a `pg_cron` nightly score. Secrets live in Vault.
4. **`web/index.html`** — one file, no build step, magic-link sign-in, published to GitHub Pages; it reads through RLS with the publishable key and never changes a read by hand.
5. **`explain/`** — generates `docs/METHOD.md` from the rubric; a test fails when the document drifts from the JSON.

## Running the tests

```bash
npm test                       # or: bash scripts/test_all.sh
node --experimental-strip-types core/engine_test.ts        # one file
```

Node 22+ is required (`--experimental-strip-types`). The same files run under Deno
unchanged: relative imports carry `.ts` extensions and `core/`, `ingest/` and `explain/`
have no npm dependencies. `core/engine_test.ts` replays every fixture in
`fixtures/golden.json` and fails on any drift.

## Deploying

Everything deploys through the Supabase MCP from a session (project `sgagrmapuovnjwvgsxbp`);
the CLI equivalents are shown for a machine with network access. Step-by-step operator
instructions, including the Vault secrets and the webhook registrations, are in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

```bash
# Migrations (MCP: apply_migration, one call per file)
supabase db push --project-ref sgagrmapuovnjwvgsxbp

# Edge functions (MCP: deploy_edge_function, one call per function)
supabase functions deploy pb-sync               --project-ref sgagrmapuovnjwvgsxbp
supabase functions deploy pb-score              --project-ref sgagrmapuovnjwvgsxbp
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
