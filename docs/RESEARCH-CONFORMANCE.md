# Research conformance and reconciliation — what was asked for, what runs, and what is declared

**Status: ADVISORY. Nothing in this file is a ruling.** The Grading Register (PRO-0 … PRO-18)
governs; `docs/DECISIONS.md` records how each open item landed. This file compares the built
system to the **Prospect Grading Research** (external, 9 Sep 2026) and its build brief, and —
since 17 Sep — records **reconciliation**: whether what is declared in this repo is what is
actually running. Where research and register disagree, the register wins and the row says so.

Why it exists: the research lives outside the repo, no session reads it by default, and three
rulings (§19, §21, §16) independently rediscovered gaps it had named. Then on 17 Sep the rubric
grading all 829 accounts turned out to have no file. Neither the requirements axis nor the phase
axis could see that. This file is the memory; `scripts/conformance_test.ts` runs the fenced JSON
block below on every `npm test` and fails the build when reality stops matching what is written.

Aggregate counts only, per rule 2. No external document IDs. The version point is
`docs/STATE-SNAPSHOT-2026-09-17.md` (commit `e20b702`).

## How the check works, and what it cannot do

- Every `auto` row states what is true **today, including the gaps**. Closing a gap fails the
  build until the row is updated; a gap that reopens fails it too. Symmetric on purpose.
- **Completeness**: every key in `required_coverage` needs at least one auto row. Deleting rows
  to go green fails the build. (The 16 Sep version passed with 21 of 22 rows deleted.)
- **The active rubric is pinned by the engine's own `fingerprint()`** — the value every
  `pb_reads` row stores — not by an ad-hoc hash. On 17 Sep every read under 0.1.3 carried
  `909b3747`, and the recovered file produces `909b3747`.
- **Manual rows expire** after `manual_max_age_days`. Each carries the exact query to re-run.
- Rubric-wide probes **enumerate `core/rubric.prospect.v*.json` from disk**. The 16 Sep version
  hard-coded two of five files and audited a retired rubric as if it were active.
- It **cannot see the database**. Rubric drift against `pb_rubric_versions`, migration drift
  against `schema_migrations`, and source liveness need network and belong in
  `scripts/reconcile.ts`, which is not yet built (row `RECON-checks-unbuilt`).
- **Never** delete a row to make the build pass.

## The standard the book must rest on (owner direction, 17 Sep)

The foundation is not to be invented. `docs/STANDARDS.md` (Track B, not yet written) will record,
per component, the field's established practice and whether WLIQ matches it, is ahead, is behind,
or diverges — and whether each divergence is a recorded tuning or an accident. Until it exists the
`STD-standards-doc-absent` row fails on purpose.

## The ten requirements

| R | Asked for | State | What is missing |
|---|---|---|---|
| R1 | One record per agency; identity keys; deterministic match; merge queue; grade carried at promotion | **partial** | 993 candidates, 80 with a proposed match, none reviewed since 13 Sep. Promotion confirmer unruled (PRO-18) |
| R2 | Signals with provenance/weight/lifespan; six connectors; nightly recompute; expire, never delete | **partial** | `email` channel has no credential; **Fathom has never delivered** (see RECON) |
| R3 | Four reads separately, **gates first**, never summed, no bare numbers | **partial** | Only `service_shape` and `economics` park. `broker_character` is `flag` (PRO-2r-a unruled); **`geography` is `off`** with no ruling |
| R4 | Wallet/winnable/headroom with editable anchors; climb evidence; **P10/P50/P90 frozen at first SOW, scored at 6/12/24 months, hit-rate, error, Brier** | **schema complete, loop absent** | `pb_potential_snapshots` has the brief's exact columns and zero rows. Nothing inserts. Largest gap against the research |
| R5 | Fathom extraction; seven quote-backed fields; `not discussed`; rep confirms before write | **divergent** | Quote verification is *stronger* than asked. Extracted set is Dimension A + climb signals, not the seven fields; high-confidence facts write without a human step. **And the extractor's climb vocabulary does not match the active rubric's** |
| R6 | Deal warnings with **thresholds from WLIQ's own stage medians**; stage-exit criteria | **partial** | Stage median still the placeholder default. Stage-exit noted, not enforced |
| R7 | Tiers that name a play; capacity cap; owner + SLA; strong signal creates a task | **not met** | Engine emits a chase key and stops. Tier-1 sizing is open decision 1 |
| R8 | Team surface; ratings; **write tier + reasons back to Pipedrive**; digest; sharing decided | **built, never used** | Page built, sharing ruled. 0 overrides, 0 promotions, 0 manual signals ever. No write-back, no digest, 0 raters |
| R9 | Versions + preview; register overrides; **acceptance KPI, lift report, Blind Test**; ~10 fixtures | **built, unmeasured** | 25 fixtures — **all pin retired 0.1.0; none pins the active version**. No ritual runs. UNVALIDATED (PRO-8) is accurate |
| R10 | Budgets as code; webhook health checks; Fathom sharing policy; Notion migrated once | **mostly** | No scheduled webhook health check — which is why Fathom being dark went unnoticed |

## "Do not build" — six for six, with one break

ML scoring · intent data · visitor de-anonymisation · committee maps · manufactured urgency: all
honoured. **A composite score**: honoured in the engine and the contract, **broken in the
database** — `pb_chase_scores` is a summed −18..123, built 16 Sep with no file, no test, no
decision entry. Whether it stays is owner decision 2.

## Reconciliation — declared versus running (17 Sep 2026)

| Break | Evidence | Repair |
|---|---|---|
| Fathom never connected; status doc said Pass | 988 inbox rows all `pg_net`, zero Fathom user agents ever; newest call 11 Sep | item 1 |
| Active rubric had no file | 0.1.3, 829 reads, zero repo hits; recovered 17 Sep, engine fp `909b3747` | done |
| Active rubric lacks §17; extractor vocabulary split | `Champion identified` proposed by the sweep, unknown to the engine | item 2 |
| 33 applied migrations with no file | 64 applied vs 31 on disk, by name | item 3 |
| Composite score in the database | `pb_chase_scores`, 146 rows | decision 2 |
| Docs described a system not running | PHASE0 (corrected), METHOD.md (regenerate from active), CLAUDE.md layout (corrected) | item 5 |

## The seven decisions the research asked for

| | Question | State |
|---|---|---|
| 1 | Tier-1 sized at 15–20? | open |
| 2 | ICP changes | answered further than asked — ICP retired as the fit read (§8). ICP-6 kept: research said remove, PRO-4 ruled otherwise, **register wins** |
| 3 | Lift weights or equal? | equal, reason recorded in 0.2 |
| 4 | Who rates? | **open — the binding constraint** |
| 5 | SPICED + MEDDIC-lite? | open — Dimension A instead |
| 6 | Pipedrive as system of record? | settled in practice (§12), never ruled |
| 7 | Share publicly? | ruled yes (§5) |

## The fit read: twelve researched attributes, six built criteria

Rubric 0.2 carries `is_agency`, `sells_build_work`, `build_capacity_gap`, `size_band_fit`,
`client_budget_size`, `recurring_work_shape`. Narrowing to six answerable criteria is defensible.
**The white-label signal is not among them** — the research calls it "the single strongest
predictor you found" — and it was never proposed as one nor rejected. It deserves a ruling.

## Machine-checked claims

`scripts/conformance_test.ts` reads this block. Keep it in step with the tables above.

```json
{
  "compiled_on": "2026-09-17",
  "source": "Prospect Grading Research (9 Sep 2026) and its build brief (external). ADVISORY — the Grading Register governs, docs/DECISIONS.md records.",
  "required_coverage": [
    "R1",
    "R2",
    "R3",
    "R4",
    "R5",
    "R6",
    "R7",
    "R8",
    "R9",
    "R10",
    "DNB",
    "FIT",
    "RECON",
    "STD"
  ],
  "manual_max_age_days": 45,
  "active_rubric": {
    "version": "0.1.3",
    "file": "core/rubric.prospect.v0.1.3.json",
    "engine_fingerprint": "909b3747",
    "reads_verified_on": "2026-09-17",
    "note": "engine_fingerprint is fingerprint() from core/engine.ts — the value every pb_reads row stores. Verified 17 Sep: all 829 reads under 0.1.3 carry 909b3747. When a new version is activated, update version, file, engine_fingerprint and reads_verified_on together, in the same commit as the file and its golden fixture."
  },
  "checks": [
    {
      "id": "R1-merge-queue-code",
      "r": "R1",
      "mode": "auto",
      "claim": "Identity proposes matches into a merge queue rather than merging (proposeMatches exists; pb_identity_candidates table exists).",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "ingest/identity.ts"
        ],
        "pattern": "export function proposeMatches",
        "equals": 1
      }
    },
    {
      "id": "R1-merge-queue-table",
      "r": "R1",
      "mode": "auto",
      "claim": "The merge-queue table is in the filed schema.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "supabase/migrations"
        ],
        "exts": [
          ".sql"
        ],
        "pattern": "pb_identity_candidates",
        "min": 1
      }
    },
    {
      "id": "R1-queue-mostly-unmatched",
      "r": "R1",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select count(*), count(*) filter (where confidence is not null) from pb_identity_candidates;",
      "claim": "993 candidates, only 80 carry a proposed match; 913 are unmatched with null confidence. Nothing reviewed since 13 Sep. Phase 1's 'duplicates sit in the merge queue with a proposed match' is PARTIAL."
    },
    {
      "id": "R2-signals-lifespan-column",
      "r": "R2",
      "mode": "auto",
      "claim": "Signals carry a lifespan in the filed schema.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "supabase/migrations/20260909120000_prospect_book_schema.sql"
        ],
        "pattern": "lifespan_days",
        "min": 1
      }
    },
    {
      "id": "R2-decay-implemented",
      "r": "R2",
      "mode": "auto",
      "claim": "Decay is implemented against lifespan (MadKudu form) in core/decay.ts.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "core/decay.ts"
        ],
        "pattern": "lifespan",
        "min": 1
      }
    },
    {
      "id": "R2-email-channel-dark",
      "r": "R2",
      "mode": "manual",
      "verified_on": "2026-09-16",
      "reverify": "select name from vault.secrets where name like 'PB_GMAIL%';",
      "claim": "The email channel has no credential in Vault and is skipped every night."
    },
    {
      "id": "R3-gate-order",
      "r": "R3",
      "mode": "auto",
      "claim": "Four gates in the research's evaluation order — checked on the ACTIVE rubric (the 16 Sep version checked the retired 0.1.0).",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "gates.evaluation_order",
        "value": [
          "service_shape",
          "economics",
          "broker_character",
          "geography"
        ]
      }
    },
    {
      "id": "R3-service-parks",
      "r": "R3",
      "mode": "auto",
      "claim": "Service shape parks.",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "gates.items.service_shape.mode",
        "value": "park"
      }
    },
    {
      "id": "R3-economics-parks",
      "r": "R3",
      "mode": "auto",
      "claim": "Economic floor parks.",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "gates.items.economics.mode",
        "value": "park"
      }
    },
    {
      "id": "R3-broker-flag-only",
      "r": "R3",
      "mode": "auto",
      "claim": "Broker character only flags (PRO-2r-a unruled). Flip to 'park' when ruled.",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "gates.items.broker_character.mode",
        "value": "flag"
      }
    },
    {
      "id": "R3-geography-off",
      "r": "R3",
      "mode": "auto",
      "claim": "GAP: geography is a gate in the research and is switched OFF in the live rubric, with no ruling and no open item saying why. Only two of four gates park.",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "gates.items.geography.mode",
        "value": "off"
      }
    },
    {
      "id": "R4-schema-complete",
      "r": "R4",
      "mode": "auto",
      "claim": "pb_potential_snapshots carries the brief's full schema (p10/p50/p90 at 12m and 24m, the two binaries, brier).",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "supabase/migrations/20260909120000_prospect_book_schema.sql"
        ],
        "pattern": "p_35k_12m|p_100k_24m|brier",
        "min": 3
      }
    },
    {
      "id": "R4-nothing-writes-snapshots",
      "r": "R4",
      "mode": "auto",
      "claim": "GAP: no function AND no migration inserts into pb_potential_snapshots — the calibration loop does not run. (The 16 Sep probe scanned supabase/functions only; this repo builds machinery in migrations, so that probe would have stayed green through R4 being built.) Expect >= 1 once repair item 6 lands.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "supabase/functions",
          "supabase/migrations"
        ],
        "exts": [
          ".ts",
          ".sql"
        ],
        "pattern": "insert into (public\\.)?pb_potential_snapshots",
        "equals": 0
      }
    },
    {
      "id": "R4-snapshots-empty",
      "r": "R4",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select count(*) from pb_potential_snapshots;",
      "claim": "Zero rows. No estimate has ever been frozen."
    },
    {
      "id": "R5-quote-check-present",
      "r": "R5",
      "mode": "auto",
      "claim": "The verbatim-quote check exists and is exported.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "ingest/notes_sweep.ts"
        ],
        "pattern": "export function verifyClaims",
        "equals": 1
      }
    },
    {
      "id": "R5-seven-fields-absent",
      "r": "R5",
      "mode": "auto",
      "claim": "GAP: the seven SPICED fields are not extractable keys. Decision 5 is unruled.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "ingest/notes_sweep.ts"
        ],
        "pattern": "(price_reaction|risk_words|critical_event|next_step)\\s*:",
        "equals": 0
      }
    },
    {
      "id": "R6-stage-median-is-default",
      "r": "R6",
      "mode": "auto",
      "claim": "GAP: deal-health stage medians are still the placeholder default (21 days), not WLIQ's own. Pipedrive has been readable since 12 Sep. Pinned numerically rather than by grepping prose.",
      "probe": {
        "kind": "rubric_equals",
        "version": "0.1.3",
        "path": "deal_health.default_stage_median_days",
        "value": 21
      }
    },
    {
      "id": "R6-stage-exit-unenforced",
      "r": "R6",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "grep -rn stage_exit core/ supabase/functions/ — is anything enforced, or only noted?",
      "claim": "Stage-exit criteria exist as a note in the rubric (and in the 0.3 draft) but nothing enforces them in Pipedrive or the app."
    },
    {
      "id": "R7-no-plays",
      "r": "R7",
      "mode": "auto",
      "claim": "GAP: no rubric on disk carries a play or an SLA — enumerated across every core/rubric.prospect.v*.json, not a hard-coded pair.",
      "probe": {
        "kind": "rubric_glob_absent",
        "needles": [
          "\"sla\":",
          "\"play\":",
          "\"plays\":"
        ]
      }
    },
    {
      "id": "R8-page-reads-register",
      "r": "R8",
      "mode": "auto",
      "claim": "The page reads the register.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "web/index.html"
        ],
        "pattern": "pb_register",
        "min": 1
      }
    },
    {
      "id": "R8-no-raters",
      "r": "R8",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select role, count(*) from pb_members group by 1;",
      "claim": "2 owners, 0 raters. Research decision 4 unanswered."
    },
    {
      "id": "R8-page-never-written",
      "r": "R8",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select kind, count(*) from pb_register group by 1; select count(*) from pb_promotions; select count(*) from pb_signals where source='manual';",
      "claim": "Register kinds are only decision and note: 0 overrides ever, 0 promotions ever, 0 manual signals ever. Every write lane on the page is unused."
    },
    {
      "id": "R8-no-writeback",
      "r": "R8",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "grep -rn 'api.pipedrive.com' supabase/functions ingest — every call is a read?",
      "claim": "Tier and reasons are not written back to Pipedrive; the integration is inbound only."
    },
    {
      "id": "R9-fixtures-count",
      "r": "R9",
      "mode": "auto",
      "claim": "At least the ~10 golden fixtures asked for (25).",
      "probe": {
        "kind": "json_len",
        "file": "fixtures/golden.json",
        "min": 10
      }
    },
    {
      "id": "R9-no-fixture-on-active",
      "r": "R9",
      "mode": "auto",
      "claim": "GAP: no golden fixture carries an expected scorecard for the ACTIVE version. All 25 pin only 0.1.0 (retired). Flips when repair item 5 lands.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "fixtures/golden.json"
        ],
        "pattern": "\"0\\.1\\.3\"",
        "equals": 0
      }
    },
    {
      "id": "R9-validation-specified",
      "r": "R9",
      "mode": "auto",
      "claim": "PRO-8 validation is specified in the rubric (and the book ships UNVALIDATED).",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "core/rubric.prospect.v0.1.3.json"
        ],
        "pattern": "PRO-8",
        "min": 1
      }
    },
    {
      "id": "R9-rituals-absent",
      "r": "R9",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "Is there any acceptance-rate KPI, quarterly lift report, or recorded Blind Test?",
      "claim": "None of the three measurement rituals run."
    },
    {
      "id": "R10-notes-budget",
      "r": "R10",
      "mode": "auto",
      "claim": "The notes-sweep budget-as-code migration exists.",
      "probe": {
        "kind": "file_exists",
        "path": "supabase/migrations/20260911150000_prospect_book_notes_cron_budget.sql"
      }
    },
    {
      "id": "DNB-no-composite-in-contract",
      "r": "DNB",
      "mode": "auto",
      "claim": "The type contract carries no composite/total/overall score.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "core/prospect_types.ts"
        ],
        "pattern": "composite|total_score|overall_score",
        "equals": 0
      }
    },
    {
      "id": "DNB-composite-table-exists",
      "r": "DNB",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select count(*), min(score), max(score) from pb_chase_scores;",
      "claim": "BREAK: pb_chase_scores holds a summed composite (146 rows, −18..123) against the founding rule that the four reads are never summed. Built in the database on 16 Sep with no file, no test, no decision entry. Whether it stays is owner decision 2."
    },
    {
      "id": "FIT-six-criteria",
      "r": "FIT",
      "mode": "auto",
      "claim": "Rubric 0.2 (draft) carries exactly six equal-weight fit criteria.",
      "probe": {
        "kind": "json_len",
        "file": "core/rubric.prospect.v0.2.json",
        "path": "dimension_b.base_tier_from_fit.criteria",
        "equals": 6
      }
    },
    {
      "id": "FIT-wl-signal-absent",
      "r": "FIT",
      "mode": "auto",
      "claim": "GAP: the white-label signal — the strongest predictor in WLIQ's own data — is not a fit criterion in 0.2.",
      "probe": {
        "kind": "rubric_absent",
        "version": "0.2",
        "path": "dimension_b.base_tier_from_fit",
        "needle": "wl_signal"
      }
    },
    {
      "id": "RECON-s17-missing-from-active",
      "r": "RECON",
      "mode": "auto",
      "claim": "BREAK: the ACTIVE rubric does not contain DECISIONS §17 (14 Sep ruling). 'Champion identified' is absent from potential.climb_evidence; the §17 set lives only in the 0.1.2 draft (0 reads). Flips when 0.1.4 carries §17 (repair item 2).",
      "probe": {
        "kind": "rubric_absent",
        "version": "0.1.3",
        "path": "potential.climb_evidence",
        "needle": "Champion identified"
      }
    },
    {
      "id": "RECON-extractor-vocab-split",
      "r": "RECON",
      "mode": "auto",
      "claim": "BREAK (paired with the row above): the extractor may propose 'Champion identified', which the active rubric does not recognise — the extractor and the engine disagree about what a climb signal is. Facts collected tonight cannot be used by the engine tonight.",
      "probe": {
        "kind": "count_matches",
        "paths": [
          "ingest/notes_sweep.ts"
        ],
        "pattern": "\"Champion identified\"",
        "equals": 1
      }
    },
    {
      "id": "RECON-migrations-unfiled",
      "r": "RECON",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "count pb migrations in supabase_migrations.schema_migrations vs ls supabase/migrations — match by NAME, timestamps differ.",
      "claim": "BREAK: 64 Prospect Book migrations applied, 31 files on disk — 33 running with no file, listed by name in docs/STATE-SNAPSHOT-2026-09-17.md §2. Repair item 3."
    },
    {
      "id": "RECON-fathom-dark",
      "r": "RECON",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "select source, headers->>'user-agent', count(*), max(received_at) from pb_webhook_inbox group by 1,2; select max(held_at) from pb_calls;",
      "claim": "BREAK, ongoing loss: Fathom has never delivered. 988 source=fathom rows all carry user-agent pg_net/0.19.5 from the 13 Sep back-fill; the only 2 other pg_net rows are 14 Sep Pipedrive receiver tests. Newest pb_calls.held_at is 11 Sep. Repair item 1."
    },
    {
      "id": "RECON-checks-unbuilt",
      "r": "RECON",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "does scripts/reconcile.ts exist and run in CI?",
      "claim": "The three reconciliation checks that compare DECLARED to RUNNING — rubric drift vs pb_rubric_versions, migration drift vs schema_migrations, source liveness with external-delivery evidence — are NOT built. This offline test pins the FILE; reconcile.ts must pin the file TO THE DATABASE. Repair item 4."
    },
    {
      "id": "RECON-register-unread",
      "r": "RECON",
      "mode": "manual",
      "verified_on": "2026-09-17",
      "reverify": "has any session read the Grading Register directly?",
      "claim": "The Grading Register (PRO-0..PRO-18) is a Claude artifact, not a file. No session in this repo has read it directly; every PRO-number claim in docs/ is second-hand via DECISIONS.md."
    },
    {
      "id": "STD-standards-doc-absent",
      "r": "STD",
      "mode": "auto",
      "claim": "GAP (owner direction, 17 Sep): docs/STANDARDS.md — the per-component comparison of WLIQ to the field's established practice, with every divergence marked deliberate-or-accidental — does not exist yet. Track B in docs/REPAIR-PLAN.md produces it. Flip to file_exists when it lands.",
      "probe": {
        "kind": "file_absent",
        "path": "docs/STANDARDS.md"
      }
    }
  ]
}
```
