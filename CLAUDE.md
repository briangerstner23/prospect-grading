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
            rubric.prospect.v0.1.json (RETIRED 16 Sep) · rubric.prospect.v0.1.3.json (ACTIVE —
            0.1.0 plus the two §20 deletions: platinum_rule loses present_count >= 3, and
            climb_evidence.caps_ceiling = false) · rubric.prospect.v0.2.json (draft, spec as data)
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
            20260911130000 notes cron · 20260911140000 fact candidate review ·
            20260911150000 notes cron budget · 20260911170000 revoke anon writes ·
            20260911180000 restore view invoker · 20260912130000 score cron timeout ·
            20260912140000 revoke authenticated writes ·
            20260912150000 nightly watchdog ·
            20260913060000 movement views ·
            20260913160000 account cohort ·
            20260913200000 call meeting key ·
            20260913210000/210100/210200/210300 fathom back-fill (staging, stepper, retry, driver) ·
            20260913220000 roster drift ·
            20260914150000 bulk reject fact candidates ·
            20260914210000 pipedrive field map ·
            20260915090000 website reads ·
            20260915120000 fact source precedence ·
            20260915130000 website team pages ·
            20260915140000 website retry window ·
            20260916090000 research log (pb_account_reads · pb_briefs · pb_chase_scores) ·
            20260916090100 candidates from reads ·
            20260916100000 candidate source from method ·
            20260916140000 contact events + pb_engagement (DECISIONS §24) ·
            20260916140100 engagement counts a meeting they attended ·
            20260916160000 identity registry mirror (pb_mdm_*, DECISIONS §25) ·
            20260916160100 junk by domain + origin ·
            20260916170000 a client is still a prospect; quote_state (DECISIONS §26) ·
            20260916180000 orbit clients snapshot + pb_orbit_overlap ·
            20260916190000/190100 admit from orbit (+ roster_source 'orbit') ·
            20260916200000/200100 gmail sweep staging + contact events from it
            (DECISIONS §28) ·
            20260916210000/210100/210200 attribute orphan calls (+ the per-call review
            queue) · 20260916210250/210300/210500 company-name normaliser + orbit quote
            sweep + contact events from it (DECISIONS §29) ·
            20260916220000 chase board — pb_chase_weights (weights as data) +
            pb_chase_board (chase_rank over all 849, new_logo_rank over the 612 with no
            delivery work; the CRM stage is carried at zero points) ·
            20260916220100 duplicate accounts (DECISIONS §30) ·
            20260916230000 quote match by exact domain ·
            20260916230100 pb_company_engagement + the chase board grouped by company
            (824 companies over 849 records; the union is over EVENTS, never over the
            derived flags — DECISIONS §31) ·
            20260916240000 pb_prospect_board — prospects ranked by POTENTIAL, sorted on the
            engine's own chase_rank_key read out of the scorecard (the rubric defines the
            order, SQL never restates it); engagement is a COLUMN, never the rank; no
            composite number (DECISIONS §33). pb_chase_board stays as the contact-ordered
            "who do I call today" board — a different question (all applied)
            functions/pb-sync, pb-score, pb-notes, pb-fathom-webhook, pb-pipedrive-webhook,
            _shared/
            (_shared/core and _shared/ingest are COPIES written by scripts/sync_shared.sh;
            never edit them by hand) · functions/README.md (deploy file lists)
web/        index.html — the page, one file, no build step
explain/    generate_method.ts → docs/METHOD.md · method_test.ts (fails when stale)
docs/       DESIGN.md · DECISIONS.md · METHOD.md (generated) · PHASE0.md · RUNBOOK.md
scripts/    seed.ts (the seed composer → SQL files; --only-orgs makes it an admission, the way a
            pb_roster_drift row enters the book — see scripts/seed_README.md, RUNBOOK §23) ·
            seed_scope_test.ts · sync_shared.sh · test_all.sh · build_functions.sh (esbuild → dist/functions/<fn>/
            index.js, the one payload small enough to deploy through the MCP) · page_pure_test.ts ·
            no_prospect_names.ts (rule 2 made mechanical — takes the roster from outside the repo;
            run it before any commit that adds prose. DECISIONS §23, RUNBOOK §27)
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
   (invented agency names). People appear only as roles. This was broken for five days by
   agency names that entered as *examples* in prose (DECISIONS §23) — so the check is
   now mechanical: `scripts/no_prospect_names.ts` against the live roster, RUNBOOK §27 — 26
   agencies reached the repo before anyone ran a check, and a hand count of them was wrong too.
   Shape
   the example ("an agency Apollo listed at 68 with 35 on its team page"), never name it.
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
9. **Evidence outranks recency, and a named source outranks write order.** `pb_current_facts`
   and `latestFactPerKey` both resolve a key by `evidence > inferred > unknown`, then by source
   (`rater > fathom_call > pipedrive_note > website > notion_master > apollo > pipedrive >`
   anything else), then newest written, then newest observed. Without the middle step the
   tiebreak is which seed ran last — 38 accounts flip across the Partner threshold on that alone
   (`docs/DECISIONS.md` §22). The view is what pb-score reads and the function is what the pure
   path reads; they must not drift, and `resolve_features_test.ts` pins the list against the
   migration.
10. Tier words are always printed with **anticipated** and a confidence (PRO-1r), and with
   **UNVALIDATED (PRO-8)** while the rubric says so.
11. **Orbit is read, never written.** Owner instruction, 16 Sep 2026: *"Do not, absolutely do not
   write anything into Orbit."* Orbit is the delivery system and the system of record for work in
   flight; a wrong row there reaches real projects, real invoices and real people. Only
   `list_*` / `get_*` are permitted. **Never** call `create_client`, `create_project`,
   `update_project`, `create_task`, `update_task`, `add_task_comment`, `complete_task`,
   `change_*_due_date` or any other Orbit mutation, in any session, for any reason — including to
   "correct" something this book believes is wrong. Drift goes in a report a person reads
   (`pb_orbit_admission_queue`, `pb_orbit_overlap`), the same posture as `pb_roster_drift`.
   `pb_orbit_clients` is a snapshot filled from the read endpoints and nothing else.

## Supabase

- Project id: `sgagrmapuovnjwvgsxbp` — `https://sgagrmapuovnjwvgsxbp.supabase.co`.
  This project is shared with other WLIQ systems; everything of ours is prefixed `pb_`.
- Deploy through the Supabase MCP (`apply_migration`, `deploy_edge_function`,
  `execute_sql`); the build container has no direct route to `*.supabase.co`.
- Secrets in Vault, read by `pb_secret()` (service role only). **Verify with
  `select name from vault.secrets where name like 'PB_%'` rather than trusting this list** — it
  has been wrong before, in both directions. The names the code reads:

  | Secret | Read by | State (12 Sep 2026) |
  |---|---|---|
  | `PB_SYNC_TOKEN` | pb-sync, pb-score, pb-notes, pg_cron | **set** |
  | `PB_ANTHROPIC_API_KEY` | pb-notes (the extractor) | **set** — without it pb-notes 503s and writes no run row |
  | `PB_PIPEDRIVE_API_TOKEN` | pb-notes (`pipedrive_note` channel); `pb_roster_fetch_page` | **set** (12 Sep 2026) — this file said "not set" until 13 Sep, which is why the roster sync looked blocked when it was not |
  | `PB_GMAIL_REFRESH_TOKEN` + `_CLIENT_ID` + `_CLIENT_SECRET` | pb-notes (`email` channel) | not set — safe to add now; the redeploy they were waiting on landed as pb-notes **v9** (RUNBOOK §17), and v11 carries it too |
  | `PB_EXTRACTOR_MODEL` | pb-notes | optional — defaults to `claude-sonnet-5` |
  | `PB_FATHOM_WEBHOOK_SECRET` | pb-fathom-webhook | **set** (12 Sep 2026) — `whsec_`, 24-byte key. From a webhook created in the Fathom UI; see RUNBOOK §4 |
  | `PB_FATHOM_API_KEY` | nothing — operator only | **set** (12 Sep 2026). Creates/deletes the Fathom webhook via `api.fathom.ai` from `pg_net`. No edge function reads it; safe to delete once the webhook is settled |
  | `PB_PIPEDRIVE_WEBHOOK_BASIC` | pb-pipedrive-webhook | **set** (14 Sep 2026) — `pbhook:<24 random bytes, hex>`, generated in-database. The four Pipedrive webhooks carry the same pair as HTTP Basic; RUNBOOK §5 |
  | `PB_PIPEDRIVE_FIELD_MAP` | pb-pipedrive-webhook | **set** (14 Sep 2026) — 69 custom fields (28 deal, 13 organization, 28 person, 0 activity), collected from Pipedrive's own `/v1/*Fields` by `pb_pipedrive_field_map_begin()` / `_finish()`. A **snapshot**: a field renamed in Pipedrive keeps its old label here until the pair is re-run. RUNBOOK §5 |

  pb-notes sweeps three channels, each behind its own credential and its own watermark row. The
  `fathom_call` channel needs **no credential of its own** — it reads `pb_calls`, which the
  webhook fills with the summary and the resolved account — so `PB_ANTHROPIC_API_KEY` alone is
  enough to make the sweep do real work. A channel with no credential is skipped and said so in
  the run's notes.
- **pb-score is v8 (16 Sep 2026), built from commit `f265702`.** It carries §19
  (`build_demand_exceeds_capacity`) and §20 (`caps_ceiling`); v6 predated both, so two ruled
  changes sat unshipped for a day (DECISIONS §32). **A ruling is applied when the deployed
  artefact contains it — not when it is written down and not when the code is merged.** After
  any MCP deploy, fetch the function back with `get_edge_function` and diff it against
  `dist/functions/<fn>/index.js`; the API reports success for any syntactically valid payload,
  including one that is not the bundle. A v7 deployed from a placeholder string took pb-score
  down on 16 Sep and only that diff proved v8 was right.
- Deployed versions as of **14 Sep 2026**: **pb-notes v11**, ~~pb-score v6~~ (now v8), **pb-sync v2**,
  **pb-pipedrive-webhook v2** (all four from commit `561f289`/`53fb656` — the same bundles),
  **pb-fathom-webhook v2**. This line has
  been wrong more than once — read it from `list_edge_functions`, not from here, and check drift
  against each function's real import closure (RUNBOOK §3). All five now carry the
  `helpers.ts` / `db.ts` paging fixes; the last two were caught up on 14 Sep, so no function is
  knowingly behind its source. `pb_secret()` is the first call pb-sync, pb-score and pb-notes each make, and it
  runs *before* anything is written — so a transient gateway failure there costs the whole run
  and leaves no `pb_runs` row at all. That is not hypothetical: it took both nightly jobs out on
  12 Sep (RUNBOOK §15).
- All five edge functions deploy with `verify_jwt = false`: pb-sync / pb-score / pb-notes carry
  the Book's own bearer (which pg_cron sends), the webhooks their own signature / Basic check.
  Six cron jobs. Three re-read the roster, entirely inside the database:
  `pb-roster-begin` 05:00 UTC clears the staging table and starts a crawl of the Client Journey
  pipeline, `pb-roster-step` every minute 05:01-05:10 walks the cursor (a stepper because pg_net
  dispatches only after the calling transaction commits; ~950 cards is two pages and the step
  no-ops once done), and `pb-roster-report` 05:12 recomputes `pb_roster_drift`. Then
  `pb-nightly-notes` 05:45 and `pb-nightly-score` 06:15 — the sweep runs before the score so a
  note read in the morning changes that morning's tier, and the roster runs before both so a card
  that moved overnight is in the same morning's queue. Last, `pb-nightly-watchdog` 07:00 writes a
  `failed` `pb_runs` row for either nightly job if it left no finished run. The watchdog lives in
  the database on purpose: the thing that took both jobs out on 12 Sep was the API gateway, and a
  remedy that goes through the gateway is no remedy (migration 20260912150000).
- **The roster is re-read, never re-written.** `pb_roster_drift` reports both directions — a
  prospect-stage card with no account (`missing`), an account whose card has moved to a partner
  stage or Friends of WLIQ (`departed`) — and writes nothing else. It may not: PRO-18's
  confirmation lane is an open ruling, and the seed's PRO-10 cross-check needs the Client Book's
  keys, which this repository may never import. It is to the roster what
  `pb_identity_candidates` is to identity — it proposes, a person decides (migration
  20260913220000, `docs/RUNBOOK.md` §22).
- RLS is default-deny **except for reads, which are public** (10 Sep 2026, owner decision —
  `docs/DECISIONS.md` §5; it supersedes how PRO-7 was implemented and PRO-7 itself is not
  re-ruled). `anon` holds `select` on the tables the page reads and nothing else: `pb_contacts`,
  `pb_members`, `pb_promotions`, `pb_potential_snapshots` and `pb_webhook_inbox` stay closed.
  Writes are unchanged — by lane via `pb_members.role` (owner / rater / viewer), signed in.
  Never grant `anon` an insert, update or delete; never open `pb_contacts` without asking.
- **A new `pb_` table arrives with `anon` AND `authenticated` holding everything.** Supabase's
  default privileges on `public` grant insert/update/delete/truncate on any table created after
  they were set. Three tables made on 11 Sep inherited that for `anon`
  (`20260911170000_prospect_book_revoke_anon_writes`); **all twenty objects held it for
  `authenticated`** until `20260912140000_prospect_book_revoke_authenticated_writes`, because
  the check below originally asked about `anon` only. The defaults are not ours to change (the
  project is shared), so **every new table needs its own `revoke`, for both roles**.

  RLS default-deny refuses these over PostgREST, with one exception worth remembering:
  **TRUNCATE is not subject to RLS at all** — a row policy cannot refuse it, and only
  PostgREST's not exposing TRUNCATE stood between a signed-in user and an empty `pb_reads`.

  Check after adding a table. `authenticated` legitimately writes where a policy says so, so
  its expected set is not simply `SELECT`: insert on `pb_facts`, `pb_signals`, `pb_register`
  and `pb_promotions`; update on `pb_fact_candidates` and `pb_identity_candidates`; select
  elsewhere; and nothing at all on `pb_apollo_enrichment`, `pb_source_watermarks`,
  `pb_webhook_inbox` or `pb_website_reads`. The three research tables
  (`pb_account_reads`, `pb_briefs`, `pb_chase_scores`) are `authenticated` **select only and
  `anon` nothing** — deliberately narrower than `pb_facts`, because they carry candid judgements
  about named companies (who is price-sensitive, whose owner is retiring) rather than facts.
  Opening them to `anon` is the owner's call, not a default. This returns nothing when the book
  is in order:

  ```sql
  select grantee, table_name, privs, expected
  from (
    select grantee, table_name,
           string_agg(privilege_type, ',' order by privilege_type) as privs,
           case
             when grantee = 'authenticated'
              and table_name in ('pb_facts','pb_signals','pb_register','pb_promotions')
             then 'INSERT,SELECT'
             when grantee = 'authenticated'
              and table_name in ('pb_fact_candidates','pb_identity_candidates')
             then 'SELECT,UPDATE'
             else 'SELECT'
           end as expected
    from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated')
      and table_name like 'pb\_%'
    group by 1, 2
  ) g
  where privs <> expected;
  ```

  Compare against a computed `expected` rather than writing the exception list into a
  `having … not in (…, case … end)`: when that `case` falls through to NULL the comparison is
  NULL, not true, and the row is dropped — a check that hides exactly the findings it exists
  to surface. The three service-role-only tables appear in no row at all, which is correct;
  they now hold no grant for either role.
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
