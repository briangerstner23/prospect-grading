# Research conformance — what the 9 Sep research asked for, and what this repo does

**Status: ADVISORY. Nothing in this file is a ruling.** The Grading Register (PRO-0 … PRO-18)
is the authority; `docs/DECISIONS.md` records how each open item landed. This file records how
the built system compares to the **Prospect Grading Research** (external document, 9 Sep 2026,
~150 sources read / ~80 cited) and to the ten requirements R1–R10 that document wrote for
whoever built this repo. Where the research and the register disagree, **the register wins** and
the row says so. A gap named here is a candidate for a ruling, never a ruling itself.

Why this file exists: the research lives outside the repo, no session reads it by default, and
three separate rulings (§19, §21, §16) independently rediscovered gaps it had already named.
That is drift, and it costs a session every time. This file is the memory, and
`scripts/conformance_test.ts` is what stops it going quietly stale — the `auto` checks below run
on every `npm test` and fail the build when reality stops matching what is written here.

Per CLAUDE.md rule 2 this file carries **aggregate counts only**: no agency names, no dollar
bands, no external document IDs or URLs. Pointers to the research itself live outside the repo.

## How to use this file

- **Closing a gap?** Change the row's `state`, flip its `auto` check to the new expected value,
  and run `npm test`. A gap that reopens later fails the build instead of being forgotten.
- **Re-opening one deliberately?** Same edit, opposite direction, and say why in `docs/DECISIONS.md`.
- **A `manual` row** cannot be checked from the repo (a credential, a database count, a person).
  Every run prints them with the date they were last verified. Re-verify before trusting one.
- **Never** delete a row to make the build pass.

## The ten requirements

| R | Asked for | State | What is missing |
|---|---|---|---|
| R1 | One record per agency; identity keys; deterministic match; merge queue; grade carried at promotion | **met** | Who confirms a promotion is unruled (PRO-18) |
| R2 | Signals table with provenance/weight/lifespan; six connectors; nightly recompute; signals expire, never delete | **partial** | The `email` channel has no credential and is skipped every night |
| R3 | Four reads computed separately, **gates first**, never summed, no bare numbers | **partial** | Of four gates only `service_shape` and `economics` park. `broker_character` is `flag` (PRO-2r-a unruled) and **`geography` is `off`** |
| R4 | Wallet/winnable/headroom with editable anchors; climb evidence for ceiling; **P10/P50/P90 frozen at first SOW, checked at 6/12/24 months; interval hit-rate, median error, Brier score** | **partial** | The formulas are built and rubric-driven. **The entire calibration loop is not.** `pb_potential_snapshots` exists and no function writes it. Largest gap against the research |
| R5 | Fathom extraction; seven quote-backed fields; `not discussed` literal; rep confirms before any write | **divergent** | Quote verification is *stronger* than asked (a fabricated quote structurally cannot reach `pb_facts`). But the extracted set is Dimension A + climb signals, **not** the seven named fields; and high-confidence facts write without a human step |
| R6 | Gong-style deal warnings with **thresholds set from WLIQ's own stage medians**; stage-exit criteria | **partial** | The rubric still carries the "defaults below until then" placeholder. Pipedrive has been readable since 12 Sep; the thresholds were never re-cut. Stage-exit enforcement not built |
| R7 | Tiers that name a play; capacity cap (Tier 1 ≈ 15–20); owner + SLA per tier; strong signal creates a task | **not met** | The engine emits a chase-order key and stops. No plays, owners, SLAs or tasks. Tier-1 sizing is open decision 1 |
| R8 | Team surface; ratings by name; **tier + top-3 reasons written back to Pipedrive**; daily digest; sharing decided | **partial** | Page built; sharing ruled (DECISIONS §5). No write-back (the Pipedrive integration is inbound only), no digest, and the rater lane is unstaffed |
| R9 | Rubric versions + preview diff; register overrides; **acceptance-rate KPI, quarterly lift report, Blind Test**; ~10 golden fixtures | **partial** | Versioning, preview, register and fixtures all present (25 fixtures, past the ~10 asked). **None of the three measurement rituals run.** PRO-8 validation is specified and the book ships stamped UNVALIDATED |
| R10 | Budgets as code; webhook health checks; Fathom sharing policy; Notion rows migrated once | **partial** | Sweep budget and self-imposed deadline built. No scheduled webhook health check |

## "Do not build" — six for six

ML scoring · third-party intent data · visitor de-anonymisation · buying-committee maps ·
**a composite score** · manufactured urgency. All six honoured. The composite prohibition is
rule 1 of this repo and is enforced by the type contract, not by intention.

## The seven decisions the research asked for

| | Question | State |
|---|---|---|
| 1 | Tier-1 sized at 15–20? | open |
| 2 | ICP changes (floor ICP-3, drop ICP-6, add recurring / niche / AM-PM, score AI-positive) | **answered further than asked** — ICP retired as the fit read entirely (DECISIONS §8). ICP-6 kept: the research recommended removal, PRO-4 ruled otherwise, **the register wins**. Recurring built as a criterion, niche as an adjustment. AM/PM and AI-positive never built |
| 3 | Lift-derived weights now, or equal weights? | answered: equal weights, with the reason recorded in 0.2 |
| 4 | Who rates now Deepak is outside the agency? | **open, and currently the binding constraint** |
| 5 | SPICED as the shared record, MEDDIC-lite above $35K? | open — Dimension A is the qualification read instead |
| 6 | Pipedrive system of record, or the Book? | settled in practice (DECISIONS §12), never written as a ruling |
| 7 | Share publicly? | ruled yes (DECISIONS §5) |

## The fit read: twelve researched attributes, six built criteria

Rubric 0.2 carries `is_agency`, `sells_build_work`, `build_capacity_gap`, `size_band_fit`,
`client_budget_size`, `recurring_work_shape`. Narrowing twelve to six is defensible — six you can
answer beats twelve you cannot — but one omission is worth a ruling rather than an accident:

**The white-label signal is not in the fit read.** The research calls it "the single strongest
predictor you found" from WLIQ's own data. In this repo `wl_signal` only sets the outsourceable
share inside Potential. It has never been proposed as a fit criterion and never rejected as one.

## Machine-checked claims

`scripts/conformance_test.ts` reads the block below and fails `npm test` on any mismatch.
Keep it in step with the tables above.

```json
{
  "compiled_on": "2026-09-16",
  "source": "Prospect Grading Research, 9 Sep 2026 (external). Advisory; the register governs.",
  "checks": [
    { "id": "R3-gate-order", "r": "R3", "mode": "auto",
      "claim": "Four gates, in the research's stated evaluation order",
      "probe": { "kind": "rubric_equals", "version": "0.1", "path": "gates.evaluation_order",
                 "value": ["service_shape", "economics", "broker_character", "geography"] } },

    { "id": "R3-service-parks", "r": "R3", "mode": "auto",
      "claim": "Service shape parks the account",
      "probe": { "kind": "rubric_equals", "version": "0.1", "path": "gates.items.service_shape.mode", "value": "park" } },

    { "id": "R3-economics-parks", "r": "R3", "mode": "auto",
      "claim": "Economic floor parks the account",
      "probe": { "kind": "rubric_equals", "version": "0.1", "path": "gates.items.economics.mode", "value": "park" } },

    { "id": "R3-broker-flag-only", "r": "R3", "mode": "auto",
      "claim": "Broker character only flags; it does not park. PRO-2r-a is unruled — flip to 'park' when it is ruled",
      "probe": { "kind": "rubric_equals", "version": "0.1", "path": "gates.items.broker_character.mode", "value": "flag" } },

    { "id": "R3-geography-off", "r": "R3", "mode": "auto",
      "claim": "GAP: geography is a gate in the research and is switched off here",
      "probe": { "kind": "rubric_equals", "version": "0.1", "path": "gates.items.geography.mode", "value": "off" } },

    { "id": "DNB-no-composite", "r": "DNB", "mode": "auto",
      "claim": "The contract carries no composite/total/overall score field",
      "probe": { "kind": "count_matches", "paths": ["core/prospect_types.ts"],
                 "pattern": "composite|total_score|overall_score", "equals": 0 } },

    { "id": "R4-calibration-absent", "r": "R4", "mode": "auto",
      "claim": "GAP: no edge function reads or writes pb_potential_snapshots, so the calibration loop does not run. Expect > 0 once R4 is built",
      "probe": { "kind": "count_matches", "paths": ["supabase/functions"], "exts": [".ts"],
                 "pattern": "pb_potential_snapshots", "equals": 0 } },

    { "id": "R5-quote-check-present", "r": "R5", "mode": "auto",
      "claim": "The verbatim-quote check exists and is exported",
      "probe": { "kind": "count_matches", "paths": ["ingest/notes_sweep.ts"],
                 "pattern": "export function verifyClaims", "equals": 1 } },

    { "id": "R5-seven-fields-absent", "r": "R5", "mode": "auto",
      "claim": "GAP: the seven SPICED fields are not extractable keys. Decision 5 is unruled",
      "probe": { "kind": "count_matches", "paths": ["ingest/notes_sweep.ts"],
                 "pattern": "(price_reaction|risk_words|critical_event|next_step)\\s*:", "equals": 0 } },

    { "id": "R6-thresholds-not-recut", "r": "R6", "mode": "auto",
      "claim": "GAP: deal-health thresholds still carry the pre-Pipedrive placeholder. Remove the phrase when they are cut from WLIQ's own stage medians",
      "probe": { "kind": "count_matches", "paths": ["core/rubric.prospect.v0.1.json"],
                 "pattern": "defaults below until then", "equals": 1 } },

    { "id": "R7-no-plays", "r": "R7", "mode": "auto",
      "claim": "GAP: no tier carries a play or an SLA in either rubric",
      "probe": { "kind": "count_matches",
                 "paths": ["core/rubric.prospect.v0.1.json", "core/rubric.prospect.v0.2.json"],
                 "pattern": "\"(sla|play|plays)\"", "equals": 0 } },

    { "id": "R9-fixtures", "r": "R9", "mode": "auto",
      "claim": "At least the ~10 golden fixtures the research asked for",
      "probe": { "kind": "json_len", "file": "fixtures/golden.json", "min": 10 } },

    { "id": "FIT-six-criteria", "r": "FIT", "mode": "auto",
      "claim": "Rubric 0.2 carries exactly six equal-weight fit criteria",
      "probe": { "kind": "json_len", "file": "core/rubric.prospect.v0.2.json",
                 "path": "dimension_b.base_tier_from_fit.criteria", "equals": 6 } },

    { "id": "FIT-wl-signal-absent", "r": "FIT", "mode": "auto",
      "claim": "GAP: the white-label signal — the strongest predictor in WLIQ's own data — is not a fit criterion",
      "probe": { "kind": "rubric_absent", "version": "0.2",
                 "path": "dimension_b.base_tier_from_fit", "needle": "wl_signal" } },

    { "id": "R2-email-channel-dark", "r": "R2", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "The email channel has no credential in Vault and is skipped every night" },

    { "id": "R4-snapshots-empty", "r": "R4", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "pb_potential_snapshots holds no rows; no estimate has ever been frozen" },

    { "id": "R6-thresholds-source", "r": "R6", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "Pipedrive has been readable since 12 Sep; WLIQ's own stage medians have not been computed" },

    { "id": "R8-no-raters", "r": "R8", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "The rater lane is unstaffed: 2 owners, 0 raters. Research decision 4 is unanswered" },

    { "id": "R8-no-writeback", "r": "R8", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "Tier and reasons are not written back to Pipedrive; the integration is inbound only" },

    { "id": "R9-rituals-absent", "r": "R9", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "None of the three measurement rituals run: override acceptance-rate KPI, quarterly lift report, Blind Test" },

    { "id": "QUEUE-unworked", "r": "R8", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "The fact-candidate queue is growing faster than it is worked, and the roster is growing faster than its evidence" },

    { "id": "REGISTER-unread", "r": "ALL", "mode": "manual", "verified_on": "2026-09-16",
      "claim": "The Grading Register is a Claude artifact, not a file. No session in this repo has read it directly; every claim about PRO-numbers here is second-hand via docs/DECISIONS.md" }
  ]
}
```
