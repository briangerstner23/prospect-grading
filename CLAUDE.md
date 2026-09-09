# CLAUDE.md — WLIQ Prospect Book

Project context for Claude Code sessions working in this repository. Read
`docs/DESIGN.md` and `docs/DECISIONS.md` before changing anything; they are the contract.

## What this is

The Prospect Book grades agencies that are not yet WLIQ clients. One row per agency, four
reads (Fit, Qualification, Potential, Signals) plus deal health, never summed. Output is a
rank (anticipated tier + chase-order key) and bands — never a composite number. It is a
**separate system from the Client Book** (PRO-17). The Client Book lives in the
`wliq-momentum` repository under `client-grading/` (locally `/home/user/wliq-cg/client-grading`
when checked out beside this one). Read it for patterns; **never import from it, never copy
its data, never share its tables.** The two systems meet at one event only: promotion
(PRO-10, PRO-18).

## Layout

```
core/       prospect_types.ts (types, do not change) · rubric.prospect.v0.1.json (spec as data)
            engine.ts (pure grade()) · classify.ts · decay.ts · reason.ts · engine_test.ts
fixtures/   golden.json — synthetic accounts with expected scorecards per rubric version
ingest/     identity.ts · resolve_features.ts · notion_seed.ts · orbit_quotes.ts
            pipedrive_seed.ts (the certified roster from the read-only pull; PipedriveKeys =
            the seed's inferred field keys) · pipedrive_webhook.ts · fathom_webhook.ts ·
            webhook_signatures.ts (+ *_test.ts)
supabase/   migrations/ — five, in order: 20260909120000 schema + RLS · 120100 cron ·
            120200 merge · 120300 fixes · 120400 candidate review (all applied)
            functions/pb-sync, pb-score, pb-fathom-webhook, pb-pipedrive-webhook, _shared/
            (_shared/core and _shared/ingest are COPIES written by scripts/sync_shared.sh;
            never edit them by hand) · functions/README.md (deploy file lists)
web/        index.html — the page, one file, no build step
explain/    generate_method.ts → docs/METHOD.md · method_test.ts (fails when stale)
docs/       DESIGN.md · DECISIONS.md · METHOD.md (generated) · PHASE0.md · RUNBOOK.md
scripts/    seed.ts (one-time seed composer → SQL files; see scripts/seed_README.md) ·
            sync_shared.sh · test_all.sh
```

## Conventions

- TypeScript that runs under **both Deno and `node --experimental-strip-types`**: relative
  imports with `.ts` extensions; `import type` for types; no enums (string unions); no
  `satisfies`, decorators or parameter properties; **no npm dependencies** in `core/`,
  `ingest/` or `explain/`. Edge functions may import `jsr:@supabase/supabase-js@2` and copy
  the pure modules they need into `supabase/functions/_shared/`.
- Pure modules never read a clock, the network or the filesystem. `as_of` is an input.
- Money in dollars, ratios 0..1, dates as ISO strings, snake_case for every key that
  reaches the database (`pb_facts.key` = a `ProspectFeatures` key).
- Tests are plain scripts that exit non-zero on failure. No test framework.
- Tables, views, functions and vault secrets are prefixed `pb_` / `PB_`.

## The rules

1. **The register wins over the brief.** The Grading Register's PRO-0 … PRO-18 are
   authoritative. Nothing in this repo is a new ruling; `docs/DECISIONS.md` records how each
   open item landed.
2. **No prospect data in this repo.** It is public. No agency names, dollar bands, seed
   exports, gate reports, staff names or build-kit documents. Fixtures are synthetic
   (invented agency names). People appear only as roles.
3. **The engine is pure.** `grade(features, rubric, options) → scorecard`, deterministic,
   every fired rule in the trace with its basis (`ruled` / `unruled_default` / `reasoned`).
4. **The rubric is data.** Every threshold, band, weight and lifespan is read from
   `core/rubric.prospect.v0.1.json`. Never hard-code one. A new version is a new file and a
   `pb_rubric_versions` row, previewed (`?rubric=<v>&preview=1`) before activation.
5. **Unknown is never evidence.** A null input never fires a gate, an adjustment or a
   warning; it produces a flag where the rubric names one. A grade is labelled, never withheld.
6. **Never edit a read by hand.** `pb_reads` is written by `pb-score` only. The page changes
   facts, signals and register rows; the nightly run changes reads.
7. **Overrides go through the register.** `pb_register` kind `override`, owner lane only,
   one tier max, reason code and expiry. The engine refuses anything beyond the cap.
8. Identity never auto-merges below `high` confidence; medium/low become
   `pb_identity_candidates` for a person to review.
9. Tier words are always printed with **anticipated** and a confidence (PRO-1r), and with
   **UNVALIDATED (PRO-8)** while the rubric says so.

## Supabase

- Project id: `sgagrmapuovnjwvgsxbp` — `https://sgagrmapuovnjwvgsxbp.supabase.co`.
  This project is shared with other WLIQ systems; everything of ours is prefixed `pb_`.
- Deploy through the Supabase MCP (`apply_migration`, `deploy_edge_function`,
  `execute_sql`); the build container has no direct route to `*.supabase.co`.
- Secrets in Vault, read by `pb_secret()` (service role only): `PB_SYNC_TOKEN`,
  `PB_FATHOM_WEBHOOK_SECRET`, `PB_PIPEDRIVE_WEBHOOK_BASIC`, `PB_PIPEDRIVE_FIELD_MAP`,
  `PB_PIPEDRIVE_API_TOKEN`.
- All four edge functions deploy with `verify_jwt = false`: pb-sync / pb-score carry the
  Book's own bearer (which pg_cron sends), the webhooks their own signature / Basic check.
- RLS is default-deny. Any authenticated `@whitelabeliq.com` address reads (PRO-7); writes
  by lane via `pb_members.role` (owner / rater / viewer). `pb_webhook_inbox` is service-role only.
- Operator steps: `docs/RUNBOOK.md`. Access status: `docs/PHASE0.md`.

## Open rulings (do not resolve them in code; each is a toggle in the rubric)

- PRO-2r-a — broker character as a safety gate (gate mode `flag` until ruled).
- Minimum Dimension A facts before a tier is published (`min_facts_to_publish_tier = 0`).
- Is the ≥ $2K economic floor about hourly rate or deal size (`floor_basis = deal_size`).
- Who confirms a promotion under PRO-18 (owner lane until ruled).
- The sizing pass mark on bands (PRO-16).
- The five July elements never ruled: gates as written, ICP → grade mapping, adjust rules
  as written, climb-evidence requirement, Grade × Ceiling output shape.
- Tier-1 capacity sizing (decision 1) and SPICED vs Dimension A (decision 5) — not ruled;
  the engine outputs a chase key and Dimension A is the qualification read.

## Tests

```bash
npm test                                    # bash scripts/test_all.sh — every *_test.ts + the sync check
node --experimental-strip-types core/engine_test.ts
node --experimental-strip-types explain/method_test.ts   # regenerate docs/METHOD.md if it fails
bash scripts/sync_shared.sh                 # after editing core/ or ingest/: refresh the _shared copies
```

`npm test` runs every `*_test.ts` under `core/`, `ingest/`, `explain/`, `scripts/` and
`supabase/functions/` (the `_shared/core` and `_shared/ingest` copies excluded), then
`bash scripts/sync_shared.sh --check`, which fails the run when a `_shared/` copy differs from
its original. Node 22+; Deno is not installed in the build container. Run the tests before
finishing any change to `core/`, `ingest/`, `explain/` or `supabase/functions/`; a fixture
drift or a stale copy is a real failure, not noise.
