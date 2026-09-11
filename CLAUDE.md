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
core/       prospect_types.ts (the contract: ADDITIVE, NULLABLE changes only — never rename,
            retype or repurpose an existing key; see docs/DECISIONS.md §8)
            rubric.prospect.v0.1.json (active) · rubric.prospect.v0.2.json (draft, spec as data)
            engine.ts (pure grade()) · classify.ts · decay.ts · reason.ts · engine_test.ts
fixtures/   golden.json — synthetic accounts with expected scorecards per rubric version
ingest/     identity.ts · resolve_features.ts · notion_seed.ts · orbit_quotes.ts
            pipedrive_seed.ts (the certified roster from the read-only pull; PipedriveKeys =
            the seed's inferred field keys) · pipedrive_webhook.ts · fathom_webhook.ts ·
            webhook_signatures.ts · written_record.ts (any written record's claims → facts or a
            review queue; source-agnostic) · record_sources.ts (Fathom / Gmail / Pipedrive →
            WrittenRecord, and the domain attribution that decides WHICH account) ·
            notes_sweep.ts (which records are worth a model call, and what a model is allowed
            to have said — the quote and judgement checks live here) (+ *_test.ts)
supabase/   migrations/ — in order: 20260909120000 schema + RLS · 120100 cron · 120200 merge ·
            120300 fixes · 120400 candidate review · 20260910141528 touch search_path ·
            20260910190000 public read · 20260911001048 apollo staging ·
            20260911092040 fact candidates · 20260911120000 fact precedence ·
            20260911130000 notes cron · 20260911140000 fact candidate review (all applied)
            functions/pb-sync, pb-score, pb-notes, pb-fathom-webhook, pb-pipedrive-webhook,
            _shared/
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
4. **The rubric is data.** Every threshold, band, weight and lifespan is read from the active
   rubric spec (`core/rubric.prospect.v0.1.json` today). Never hard-code one. A new version is a new file and a
   `pb_rubric_versions` row, previewed (`?rubric=<v>&preview=1`) before activation.
5. **Unknown is never evidence.** A null input never fires a gate, an adjustment or a
   warning; it produces a flag where the rubric names one. A grade is labelled, never withheld.
6. **Never edit a read by hand.** `pb_reads` is written by `pb-score` only. The page changes
   facts, signals and register rows; the nightly run changes reads.
7. **Overrides go through the register.** `pb_register` kind `override`, owner lane only,
   one tier max, reason code and expiry. The engine refuses anything beyond the cap.
8. Identity never auto-merges below `high` confidence; medium/low become
   `pb_identity_candidates` for a person to review. **Facts read out of prose follow the same
   rule**: no verbatim quote, or below `high`, or contradicting what a *person* recorded →
   `pb_fact_candidates`, never a write. A quote is only a quote if it is in the note —
   `notes_sweep.ts` checks it, so an invented sentence cannot reach `pb_facts` (DECISIONS §9).
9. **Evidence outranks recency.** `pb_current_facts` and `latestFactPerKey` both resolve a key by
   `evidence > inferred > unknown`, then newest written, then newest observed. The view is what
   pb-score reads and the function is what the pure path reads; they must not drift.
9. Tier words are always printed with **anticipated** and a confidence (PRO-1r), and with
   **UNVALIDATED (PRO-8)** while the rubric says so.

## Supabase

- Project id: `sgagrmapuovnjwvgsxbp` — `https://sgagrmapuovnjwvgsxbp.supabase.co`.
  This project is shared with other WLIQ systems; everything of ours is prefixed `pb_`.
- Deploy through the Supabase MCP (`apply_migration`, `deploy_edge_function`,
  `execute_sql`); the build container has no direct route to `*.supabase.co`.
- Secrets in Vault, read by `pb_secret()` (service role only). **Verify with
  `select name from vault.secrets where name like 'PB_%'` rather than trusting this list** — as
  of 11 Sep 2026 only `PB_SYNC_TOKEN` is actually set, and this file previously claimed
  otherwise. The names the code reads:

  | Secret | Read by | State (11 Sep 2026) |
  |---|---|---|
  | `PB_SYNC_TOKEN` | pb-sync, pb-score, pb-notes, pg_cron | **set** |
  | `PB_ANTHROPIC_API_KEY` | pb-notes (the extractor) | not set — pb-notes 503s, no run row |
  | `PB_PIPEDRIVE_API_TOKEN` | pb-notes (`pipedrive_note` channel) | not set |
  | `PB_GMAIL_REFRESH_TOKEN` + `_CLIENT_ID` + `_CLIENT_SECRET` | pb-notes (`email` channel) | not set |
  | `PB_EXTRACTOR_MODEL` | pb-notes | optional — defaults to `claude-sonnet-5` |
  | `PB_FATHOM_WEBHOOK_SECRET` | pb-fathom-webhook | not set (PHASE0 A3) |
  | `PB_PIPEDRIVE_WEBHOOK_BASIC`, `PB_PIPEDRIVE_FIELD_MAP` | pb-pipedrive-webhook | not set |

  pb-notes sweeps three channels, each behind its own credential and its own watermark row. The
  `fathom_call` channel needs **no credential of its own** — it reads `pb_calls`, which the
  webhook fills with the summary and the resolved account — so `PB_ANTHROPIC_API_KEY` alone is
  enough to make the sweep do real work. A channel with no credential is skipped and said so in
  the run's notes.
- All five edge functions deploy with `verify_jwt = false`: pb-sync / pb-score / pb-notes carry
  the Book's own bearer (which pg_cron sends), the webhooks their own signature / Basic check.
  Two cron jobs: `pb-nightly-notes` 05:45 UTC, `pb-nightly-score` 06:15 — the sweep runs first so
  a note read in the morning changes that morning's tier.
- RLS is default-deny **except for reads, which are public** (10 Sep 2026, owner decision —
  `docs/DECISIONS.md` §5; it supersedes how PRO-7 was implemented and PRO-7 itself is not
  re-ruled). `anon` holds `select` on the tables the page reads and nothing else: `pb_contacts`,
  `pb_members`, `pb_promotions`, `pb_potential_snapshots` and `pb_webhook_inbox` stay closed.
  Writes are unchanged — by lane via `pb_members.role` (owner / rater / viewer), signed in.
  Never grant `anon` an insert, update or delete; never open `pb_contacts` without asking.
- Operator steps: `docs/RUNBOOK.md`. Access status: `docs/PHASE0.md`.

## Open rulings (do not resolve them in code; each is a toggle in the rubric)

- PRO-2r-a — broker character as a safety gate (gate mode `flag` until ruled).
- Minimum Dimension A facts before a tier is published (`min_facts_to_publish_tier = 0`).
- Is the ≥ $2K economic floor about hourly rate or deal size (`floor_basis = deal_size`).
- Who confirms a promotion under PRO-18 (owner lane until ruled).
- The sizing pass mark on bands (PRO-16).
- The five July elements never ruled: gates as written, ICP → grade mapping, adjust rules
  as written, climb-evidence requirement, Grade × Ceiling output shape.
  **ICP → grade mapping is answered in draft 0.2.0** (owner, 11 Sep 2026): ICP is retired as
  the fit read and kept as a label; six observable criteria carry Dimension B. The ICP
  definitions stay verbatim under PRO-15. `docs/DECISIONS.md` §8. Still a toggle, not a ruling.
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
