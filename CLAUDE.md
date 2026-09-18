# CLAUDE.md — WLIQ Prospect Book

**New here? Read `docs/START-HERE.md` first.** One page: what this is, what lives OUTSIDE this
repository (the Grading Register and every prospect fact both do), what you need connected, and
how to prove you are oriented in five minutes.

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
            rubric.prospect.v0.1.7.json is ACTIVE (18 Sep 03:37 UTC, fp dec7d291: the GRID —
            readiness × potential band first in the chase key, the tier second; stamps that age;
            assumed ceilings printed Low; twelve never-fired adjustment rules parked — DECISIONS
            §52. Previewed 830 scored / 0 errors / 3 changed, all three owner overrides the 0.1.6
            safety preview showed identically / 810 reordered; then activated and run: 830 live
            reads on dec7d291, computed tier identical to 0.1.6 on every one).
            v0.2.1 (fp 101ee7c1) is a REGISTERED DRAFT, previewed and HELD: seven equal-weight fit
            criteria at a threshold of three answered — 587 of 830 would be Unclassified today
            because only 239 accounts answer three (§52). Activation follows the collection sprint.
            v0.1.6 (retired 18 Sep 03:37; fp 9a911e2c: the override distance cap removed —
            max_tiers_moved null, DECISIONS §49; previewed 830 scored, 2 changed, both explained:
            the owner's own override on one agency, which the cap had been refusing, and one
            Pipedrive row added the same day).
            v0.1.5 (retired 17 Sep 22:27; fp 517f4476, four owner rulings, DECISIONS §40 — added
            dimension_b.flag_rules; previewed 829/0 changed).
            v0.1.4 (retired 17 Sep; it was 0.1.3 + DECISIONS §17 restored, §31).
            v0.1.3 (retired; recovered from the database 17 Sep — it had had no file; see
            docs/STATE-SNAPSHOT-2026-09-17.md). Also on disk: v0.1(.0, retired),
            v0.1.1 and v0.3 (files with NO pb_rubric_versions row), v0.1.2 and v0.2 (registered
            drafts, 0 reads). ELEVEN files, nine registered — run `ls core/rubric*` rather than
            trusting this line, and check pb_rubric_versions for which is active.
            engine.ts (pure grade()) · classify.ts · decay.ts · reason.ts · engine_test.ts
fixtures/   golden.json — synthetic accounts with expected scorecards per rubric version
ingest/     identity.ts · resolve_features.ts · notion_seed.ts · orbit_quotes.ts
            pipedrive_seed.ts (the certified roster from the read-only pull; PipedriveKeys =
            the seed's inferred field keys) · pipedrive_webhook.ts · fathom_webhook.ts ·
            webhook_signatures.ts · written_record.ts (any written record's claims → facts or a
            review queue; source-agnostic) · record_sources.ts (Fathom / Gmail / Pipedrive →
            WrittenRecord, and the domain attribution that decides WHICH account) ·
            verify_support.ts (the second question, asked of claims the book already has: does the
            stored quote STATE this value? states / implies / unsupported, model then a
            downward-only lexicon — DECISIONS §54) ·
            notes_sweep.ts (which records are worth a model call, and what a model is allowed
            to have said — the quote and judgement checks live here; `keysFor(source)` is the ONE
            place a channel's key set is decided, read by both the prompt and the verifier so they
            cannot drift) (+ *_test.ts)
supabase/   migrations/ — in order: 20260909120000 schema + RLS · 120100 cron · 120200 merge ·
            120300 fixes · 120400 candidate review · 20260910141528 touch search_path ·
            20260910190000 public read · 20260911001048 apollo staging ·
            20260911092040 fact candidates · 20260911120000 fact precedence ·
            20260911130000 notes cron · 20260911140000 fact candidate review ·
            20260911150000 notes cron budget · 20260911170000 revoke anon writes ·
            20260911180000 restore view invoker · 20260912130000 score cron timeout ·
            20260912140000 revoke authenticated writes ·
            20260912150000 nightly watchdog ·
            20260913060000 movement views · 060100 movement views null-rank fix (transcribed 17 Sep) ·
            20260913160000 account cohort ·
            20260913200000 call meeting key ·
            20260913210000/210100/210200/210300 fathom back-fill (staging, stepper, retry, driver) ·
            20260913220000 roster drift ·
            20260914150000 bulk reject fact candidates ·
            20260914210000 pipedrive field map ·
            20260915090000 website reads · 090100 fact source precedence · 090200 website team pages ·
            090300 website retry window (the last three transcribed 17 Sep from the database, where
            they had run without a file — DECISIONS §26) ·
            20260917100000 reconcile state (§34) · 110000 potential snapshot key (§36). All applied.
            20260918 claim support — pb_fact_candidates.support (states/implies/unsupported)
            and the lanes view rebuilt around it: `unsupported` refuses a claim from EVERY
            lane, and `states` stands in for its source being on a lane's allow-list
            (DECISIONS §54).
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
            20260916200000/200100 gmail sweep staging + contact events from it ·
            20260916210000/210100/210200 attribute orphan calls (+ the per-call review
            queue) · 20260916210250/210300/210500 company-name normaliser + orbit quote
            sweep + contact events from it ·
            20260916220000 chase board — pb_chase_weights (weights as data) +
            pb_chase_board (chase_rank over all 849, new_logo_rank over the 612 with no
            delivery work; the CRM stage is carried at zero points) ·
            20260916220100 duplicate accounts ·
            20260916230000 quote match by exact domain ·
            20260916230100 pb_company_engagement + the chase board grouped by company
            (824 companies over 849 records; the union is over EVENTS, never over the
            derived flags — DECISIONS §31) ·
            20260916240000 pb_prospect_board — prospects ranked by POTENTIAL, sorted on the
            engine's own chase_rank_key read out of the scorecard (the rubric defines the
            order, SQL never restates it); engagement is a COLUMN, never the rank; no
            composite number. pb_chase_board stays as the contact-ordered
            "who do I call today" board — a different question (all applied)
            (the 16 Sep set above was written on branch claude/new-session-glwxzh and merged
            17 Sep; a few of its inline §-references point at sections that branch never wrote
            and have been dropped — DECISIONS §38) ·
            20260917200000 board public read (SUPERSEDED — a view grant cannot work here) ·
            210000 pb_board() definer · 220000/230000 prospect_board fast (8.1s → 0.80s; the
            `as materialized` fence, §42) · 240000 pb_dossier() · 250000 dossier public (§43) ·
            260000 board carries account_id · 270000 call attendees by name only ·
            280000 dossier no addresses · 290000 confirm fact candidates (§45) ·
            300000 dossier deals and candidates · 310000 dashboard · 320000 dashboard queue fix ·
            330000 board computed tier · 20260917233631 candidate kind · 233850 confirm
            corroborated (§51). NOTE the two 23:36/23:38 files carry REAL applied timestamps while
            the 2000-3300 set above carries invented ones, so a replay from scratch would run them
            in a different order than they ran. Harmless today (every one is idempotent) and worth
            fixing the next time the list is touched.
            20260918100000/100100/100250/100260/100300/130000 AUTOCONFIRM (DECISIONS §53):
            pb_fact_autoconfirm_policy (lanes + thresholds as data) · pb_fact_candidate_lanes
            (every proposed candidate in exactly one lane, with the reason in plain words) ·
            pb_autoconfirm_facts() (dry run by default) · pb_autoconfirm_log +
            pb_undo_autoconfirm() · 100200 pb_confirm_fact_candidates refuses an explicit
            judgement · 120000 restores §51's corroboration rules, which 100200 had overwritten
            (§53a) · 120100 undo callable in-database · 130000 citation renumber, comments only.
            20260918 claim support — pb_fact_candidates.support (states/implies/unsupported) and
            the lanes view rebuilt around it: `unsupported` refuses a claim from EVERY lane, and
            `states` stands in for its source being on a lane's allow-list (DECISIONS §54).
            NOTE these share a 20260918 prefix with the grid set below but are a different series;
            the names disambiguate them, the numbers do not. ·
            20260918100000 removals — pb_removal_reasons (the vocabulary as data) + register kinds
            `removal` / `reinstatement` + pb_removals / pb_removal_due_review + pb_board() filters
            them out + pb_removed() / pb_removal(uuid) (authenticated only). A removal has NO
            expiry and the guard refuses one (DECISIONS §50) · 100100 revoke on the two new views
            (they arrived holding everything, as this file warns) · 100200 pb_register.seq, because
            a uuid is not an order · 100300 renumber it in created_at order · 100400 pb_dossier()
            skips removal rows — a definer function is a hole in every policy above it.
            The 17 Sep set was transcribed from the database after it ran; each file is
            byte-identical to schema_migrations.statements (verified by md5).
            The 18 Sep set (DECISIONS §52; files 20260918100000–140000, database versions
            032803 / 032853 / 032858 / 033410 / 034006 — the MCP stamps apply time; each statement
            byte-identical to its file by md5, RUNBOOK §28.6): 100000 board by cell (pb_key_num,
            pb_key_last_text, pb_prospect_board v3, pb_board() v4 with the cell columns) ·
            110000 outcomes and lift (pb_outcomes, pb_lift_by_cell, pb_lift() definer,
            pb_lift_snapshots, pb_snapshot_lift(), cron pb-monthly-lift) · 120000 scoring pass
            (pb_actuals, pb_score_snapshots(), pb_calibration) · 130000 retire composite (drops
            pb_chase_scores) · 140000 revoke view writes (the seven 16 Sep views). All applied.
            functions/pb-sync, pb-score, pb-notes, pb-verify, pb-fathom-webhook,
            pb-pipedrive-webhook, _shared/
            (_shared/core and _shared/ingest are COPIES written by scripts/sync_shared.sh;
            never edit them by hand) · functions/README.md (deploy file lists)
web/        board.html — THE WORKING SURFACE (DECISIONS §37, §41, §43): the prospect board, live,
            AND the dossier behind every row. Reads pb_board() for the list and pb_dossier(uuid)
            for one agency — both SECURITY DEFINER functions, because the view and its sources stay
            closed to anon (seventeen objects under the board, nine more under the dossier) and
            granting them all is a far larger decision than exposing two read functions. Renders the
            engine's own chase_rank_key order and the 16 Sep artifact's own dossier sections, in its
            order. Public, no sign-in (owner ruling §43), no data baked in. Light by default with a
            remembered dark toggle; every localStorage touch wrapped. NO EMAIL ADDRESSES reach the
            page — not from pb_contacts, not from call attendees (names and side only). Since 18 Sep the
            ranked list is grouped under a header per CHASE CELL with the cell's play (§52). It is also the
            ONE PLACE an agency comes off the book: "Remove from the board", under the override and
            deliberately unlike it — no expiry, two dispositions, and an "Off the board" list that is
            the only route back (§59). Adding a section, or dropping one, means updating
            web/CONTRACT.json (which owns the section names, §46) and scripts/board_page_test.ts,
            which pins the board's BEHAVIOUR — 111 checks in total.
            index.html — the signed-in back office: sign-in, candidate review, merges, register.
            The fact queue now carries the AUTOMATIC half above the manual one (DECISIONS §53):
            which lane each waiting claim is in, which lanes are switched on, a dry run before every
            real run so the number in the dialog is the number that lands, and the undo beside it.
            Every count comes from pb_fact_candidate_lanes, which IS the rule — the page never
            restates a threshold.
            Both are one file each, no build step
explain/    generate_method.ts → docs/METHOD.md · method_test.ts (fails when stale)
docs/       DESIGN.md · DECISIONS.md · METHOD.md (generated) · PHASE0.md · RUNBOOK.md
            HANDOFF-2026-09-17.md — start here if you are new: goal, environment, what was
            done, every corrected claim, and an eight-step check that proves you are oriented
            before you build. REPAIR-PLAN.md — the ordered work and the four owner decisions.
            STATE-SNAPSHOT-2026-09-17.md — the version point: what was ACTUALLY running on
            17 Sep, measured from the database. Read it before trusting PHASE0/METHOD/the
            deployed-versions line; on 17 Sep all three described a system that was not running.
            STANDARDS.md — Track B (17 Sep): each component against the field's established
            practice, evidence kind stated, one verdict per row; §9 is the ranked list of ACCIDENTAL
            divergences (two open) that need a ruling. ADVISORY; the register governs.
            RESEARCH-CONFORMANCE.md — how the build compares to the 9 Sep research's ten
            requirements; ADVISORY (the register governs). Its fenced JSON block is run by
            scripts/conformance_test.ts on every npm test, so closing a gap OR reopening one
            fails the build until the ledger says so. Read it before adding a read or a rule.
            GRADING-REVIEW-2026-09-18.md — the rubric, the weights and the rank reviewed against
            the field from the live database (18 Sep): what actually decides a tier today, the four
            point systems, the sort-versus-grid divergence, the six-move plan and the seven owner
            decisions. ADVISORY; the register governs. Ruled and shipped 18 Sep — DECISIONS §52;
            the status line at the top of the file says what is live and what is held.
scripts/    seed.ts (the seed composer → SQL files; --only-orgs makes it an admission, the way a
            pb_roster_drift row enters the book — see scripts/seed_README.md, RUNBOOK §23) ·
            seed_scope_test.ts · sync_shared.sh · test_all.sh · build_functions.sh (esbuild → dist/functions/<fn>/
            index.js, the one payload small enough to deploy through the MCP) · page_pure_test.ts ·
            no_prospect_names.ts (rule 2 made mechanical — takes the roster from outside the repo;
            run it before any commit that adds prose. DECISIONS §23, RUNBOOK §27. It matches whole
            roster entries against WHITESPACE-NORMALISED text, so a name wrapped across a line break
            is caught, AND each entry's distinctive first word — ≥6 characters, not in GENERIC, not
            in FIRST_TOKEN_ALLOW — because "Firstword" alone names the account to anyone holding the
            roster. Both shapes reported clean on 18 Sep while two names sat in docs/; DECISIONS §50)
            · no_prospect_names_test.ts (pins both shapes; needs no roster and no database)
            reconcile.ts (DECLARED vs RUNNING: calls pb_reconcile_state() — no secrets — and fails
            when the active rubric, the applied migrations, source liveness or rule 9 disagree with
            the record; CI runs it on push and every 6h; `--state f.json` runs offline) · reconcile_test.ts
.github/    workflows/ci.yml — test · reconcile · deploy-from-source (needs SUPABASE_ACCESS_TOKEN)
            workflows/deploy-pages.yml — the page, manual
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
   reason code, written reason and expiry — all still required, all still enforced by the engine.
   The **distance cap is gone**: `override.max_tiers_moved` is `null` in rubric 0.1.6 (owner,
   17 Sep 2026 — DECISIONS §49 retires July's "one grade max"), so an override may move a tier to
   any value in `vocabulary.tiers`. A move of more than one tier raises
   `Override moved more than one tier` and the trace says how far it went. A **number** in that
   key restores the cap; an **absent** key is still an error, because "no cap" has to be stated on
   purpose and a rubric that forgot to mention it must not silently become an uncapped one.
7a. **A removal is not an override, and never expires.** An override argues with the ENGINE'S
   ANSWER, whose inputs keep moving, so it lapses — that is a forced re-look, the only mechanism that
   makes a human judgement face new evidence. A removal (`pb_register` kind `removal`, owner lane)
   is a standing decision about whether we pursue them at all; nothing the engine learns overnight
   makes it stale. So it carries no `expires_at` and the database refuses one. `do_not_contact` is
   about permission and takes no review date; `unqualified` is about fit and may take one — a review
   date QUEUES A PERSON and never returns the row by itself. Reversal is a `reinstatement` row, never
   a delete. Removal touches no tier, no rubric and no scorecard (DECISIONS §50).

8. Identity never auto-merges below `high` confidence; medium/low become
   `pb_identity_candidates` for a person to review. **A fact candidate may be approved without a
   person**, but only on a lane the owner switched on in `pb_fact_autoconfirm_policy`, and never
   past four refusals nothing can widen: no quote, disagrees with what the book holds, two records
   proposing different values for one key, or an explicit `judgement`. A lane trusts a READER, not
   a confidence score — an extractor's own "high" counts only once somebody has checked that
   reader's ratings against its own quotes, which the website reader has not passed (four of ten
   sampled claims were inferences wearing a verbatim sentence). An automatic fact carries
   `entered_by = 'auto:<lane>'`, never an email. DECISIONS §53. A lane may ALSO be restricted by FIELD
   (`pb_fact_autoconfirm_policy.keys`, data like `sources`): the `medium_observation` lane is open only on
   keys the active rubric does not read, so a wrong admission there cannot move a tier, a rank or a band —
   the one gate that does not depend on trusting a reader. 32 of its 77 qualify; the other 45 stay with a
   person. Three of those keys are read by the 0.2.1 draft, so re-audit before activating it (DECISIONS §60). **Facts read out of prose follow the same
   rule**: no verbatim quote, or below `high`, or contradicting what a *person* recorded →
   `pb_fact_candidates`, never a write. A quote is only a quote if it is in the note —
   `notes_sweep.ts` checks it, so an invented sentence cannot reach `pb_facts` (DECISIONS §9).
9. **Evidence outranks recency, and a person outranks a machine.** `pb_current_facts` and
   `latestFactPerKey` both resolve a key by `evidence > inferred > unknown`, then **source
   precedence** (`rater > fathom_call > pipedrive_note > website > notion_master > apollo >
   pipedrive > anything else`, added 15 Sep 2026), then newest written, then newest observed. The
   view is what pb-score reads and the function is what the pure path reads; they must not drift —
   and they did, for two days, because the view changed in a migration that had no file
   (DECISIONS §33). Without the middle step the tiebreak is which seed ran last — 38 accounts flip
   across the Partner threshold on that alone (§22). `resolve_features_test.ts` pins the order
   against the migration.
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

  pb-notes sweeps **four** channels, each behind its own credential and its own watermark row. Two
  need **no credential of their own**: `fathom_call` reads `pb_calls`, which the webhook fills with
  the summary and the resolved account, and `website` reads `pb_website_reads`, which the fetcher
  filled with page text and the account it belongs to. So `PB_ANTHROPIC_API_KEY` alone is enough to
  make the sweep do real work. A channel with no credential is skipped and said so in the run's
  notes.

  **The `website` channel is narrower than the others on purpose** (DECISIONS §50). It reads a site
  the book has NEVER read — an account with a live `pb_account_reads` row is skipped, so superseding
  that row is what brings a site back into scope — and `notes_sweep.keysFor()` withholds `money`,
  `authority`, `specification`, `timing`, the climb signals and `relationship_type` from its prompt
  entirely, because no homepage can witness a deal. It carries its own prompt version (`site@v1`),
  computed per RECORD: every fingerprint is built from the extractor id, so one shared version
  would re-read every note and call in the book under a new id.
- **A ruling is applied when the deployed artefact contains it** — not when it is written down
  and not when the code is merged. `deploy_edge_function` reports success for any syntactically
  valid payload, including one that is not the bundle: a v7 deployed from a placeholder string
  took pb-score down on 16 Sep, and only fetching the function back and diffing it proved v8
  was right. The pinned-commit entrypoint (RUNBOOK §3) removes the hazard; the check stays.
- Deployed versions as of **18 Sep 2026**: **pb-score v14** (commit `d14223c`, the grid engine —
  deployed as a one-line entrypoint pinned to that commit's raw GitHub URL, so the deployed
  function IS the commit; RUNBOOK §3; §52), **pb-notes v14** (commit `53596a3`, also a pinned-commit
  entrypoint — the `website` channel §50, and the candidate's own observation/judgement verdict §51), **pb-sync v2**, **pb-pipedrive-webhook v2**,
  **pb-fathom-webhook v2** (those three from 14 Sep bundles, `561f289`/`53fb656`), and
  **pb-verify v3** (commit `81dc617`, pinned-commit entrypoint, `verify_jwt: false` confirmed in
  the deploy response; v1 `5378733` and v2 `9c253b5` were superseded by lexicon corrections —
  DECISIONS §54a, §54b). Read this line from `list_edge_functions`, never from here: on 18 Sep it
  still claimed pb-score v13 and pb-notes v11, two and three versions stale. **Deploy pb-score
  BEFORE activating a rubric that uses a feature its engine lacks** — the pre-0.1.5 engine ignores
  `dimension_b.flag_rules` entirely, so a preview on it proves nothing about the new rule (§40), and
  the pre-v13 engine reads `override.max_tiers_moved` with `reqNum`, so 0.1.6's `null` would have
  thrown for every account (§49), and the pre-v14 engine has no `chase` block and reads no
  `chase_rank_key.order`, so a 0.1.7 preview on it would print the five-term key and prove nothing
  about the grid (§52). **Check `verify_jwt` in the deploy response every time**: the
  call defaults it to TRUE, and v12 went out that way — the gateway would have refused pg_cron's
  bearer before the function was reached. v13 is the same commit, correctly at false, and v14 went
  out at false (read back 18 Sep 03:38 UTC). This line has
  been wrong more than once — read it from `list_edge_functions`, not from here, and check drift
  against each function's real import closure (RUNBOOK §3). All five carry the
  `helpers.ts` / `db.ts` paging fixes; pb-score also carries the 17 Sep rule-9 source precedence
  and the potential-snapshot write (DECISIONS §27, §30). `pb_secret()` is the first call pb-sync, pb-score and pb-notes each make, and it
  runs *before* anything is written — so a transient gateway failure there costs the whole run
  and leaves no `pb_runs` row at all. That is not hypothetical: it took both nightly jobs out on
  12 Sep (RUNBOOK §15).
- All six edge functions deploy with `verify_jwt = false`: pb-sync / pb-score / pb-notes carry
  the Book's own bearer (which pg_cron sends), the webhooks their own signature / Basic check.
  The cron jobs (**read `cron.job`** — a count written here goes stale and this one twice has). Three re-read the roster, entirely inside the database:
  `pb-roster-begin` 05:00 UTC clears the staging table and starts a crawl of the Client Journey
  pipeline, `pb-roster-step` every minute 05:01-05:10 walks the cursor (a stepper because pg_net
  dispatches only after the calling transaction commits; ~950 cards is two pages and the step
  no-ops once done), and `pb-roster-report` 05:12 recomputes `pb_roster_drift`. Then
  `pb-nightly-notes` 05:45, `pb-autoconfirm` 06:00 (the lanes of §53, in-database) and
  `pb-nightly-score` 06:15 — the sweep runs before the score so a
  note read in the morning changes that morning's tier, and the roster runs before both so a card
  that moved overnight is in the same morning's queue. Last, `pb-nightly-watchdog` 07:00 writes a
  `failed` `pb_runs` row for either nightly job if it left no finished run. The watchdog lives in
  the database on purpose: the thing that took both jobs out on 12 Sep was the API gateway, and a
  remedy that goes through the gateway is no remedy (migration 20260912150000). The seventh,
  `pb-monthly-lift`, runs at 07:30 UTC on the 1st and snapshots the lift-by-cell report
  (`pb_snapshot_lift()`; RUNBOOK §28.2, DECISIONS §52).
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
  project is shared), so **every new table needs its own `revoke`, for both roles** — and every
  new VIEW: seven security_invoker views from the 16 Sep set held every privilege for both roles
  until 18 Sep (migration 20260918140000, DECISIONS §52); harmless in effect, because the base
  tables refuse, and still wrong.

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
              and table_name in ('pb_fact_candidates','pb_identity_candidates',
                                 'pb_fact_autoconfirm_policy')
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
- The rank of a READY row with no tier: the unranked cell sits last (0.1.7). On 18 Sep 68 of the
  223 no-tier rows were ready and that cell held 28 of the 44 quotes of the last 90 days (§52).
- Activation of 0.2.1, the criteria fit read — held until the collection sprint; numbers in §52.
- The readiness thresholds and the cell plays are a first setting (basis reasoned), to be re-cut
  from the lift-by-cell report once outcomes exist (§52).

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
