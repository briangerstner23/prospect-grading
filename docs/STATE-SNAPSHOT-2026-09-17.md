# State snapshot — 17 September 2026

**This file is a VERSION POINT.** It records what was actually running on 17 Sep 2026, measured
against the database, not what any document claimed. Tag: `snapshot-2026-09-17`. Parent commit
at time of writing: `a3e8fb9`.

Read this before trusting `docs/PHASE0.md`, `docs/METHOD.md` or the deployed-versions line in
`CLAUDE.md`: on 17 Sep all three described a system that was not the one running. Two entries in
PHASE0.md were corrected in the same commit as this file.

Aggregate counts only, per rule 2. Every figure below is reproducible from the query beside it.

## 1 · The rubric that is actually grading

*Point-in-time. Superseded later the same day by 0.1.4 — DECISIONS §25.*

| | |
|---|---|
| Active version | **0.1.3** — activated 2026-09-16 17:32 UTC, 829 reads |
| Had a file before this commit | **No.** `grep -r "0.1.3"` over the repo returned zero hits |
| Recovered to | `core/rubric.prospect.v0.1.3.json`, written from `pb_rubric_versions.spec` |
| **Engine fingerprint** | **`909b3747`** — `fingerprint()` from `core/engine.ts`, the value every `pb_reads` row stores. All 829 reads under 0.1.3 carry it; the recovered file produces it. This is the pin that matters |
| sha256 (informational) | `8befc1aef2719120` over key-sorted, separator-free JSON |

Every rubric file now in `core/`, with its fingerprint:

| File | version | fingerprint | in `pb_rubric_versions`? |
|---|---|---|---|
| `core/rubric.prospect.v0.1.1.json` | 0.1.1 | `914a8390bc060a53` | **no row** |
| `core/rubric.prospect.v0.1.2.json` | 0.1.2 | `35c14ec6ff41aa78` | yes (draft) |
| `core/rubric.prospect.v0.1.3.json` | 0.1.3 | `8befc1aef2719120` | **yes — ACTIVE** |
| `core/rubric.prospect.v0.1.json` | 0.1.0 | `ca765a4e8a5d5588` | yes (retired) |
| `core/rubric.prospect.v0.2.json` | 0.2.0 | `ec89b4e900e3931e` | yes (draft) |
| `core/rubric.prospect.v0.3.json` | 0.3.0 | `55d6197caa7a28a7` | **no row** |

`0.1.1` and `0.3.0` are files with no database row: they can never be previewed or activated as
they stand. `0.1.2` and `0.2.0` are registered drafts with zero reads.

### What 0.1.3 actually is, and the ruling it dropped

0.1.3 is **0.1.1 plus the §20 ceiling change**. It does **not** contain DECISIONS §17 (the
14 Sep owner ruling on climb evidence). Verified by comparing `potential.climb_evidence`:

| | live 0.1.3 | 0.1.2 file (§17, draft, 0 reads) |
|---|---|---|
| Signals | 2nd person engaged · Strategy question asked · **2nd project scoped** · **Referred someone** · Structural break | 2nd person engaged · **Champion identified** · Structural break · **Future-state language** · Strategy question asked |
| `lift_requires` | absent | `{strong: 1, weak: 2}` |
| Retired signals | none | 2nd project scoped, Referred someone |
| `caps_ceiling` | `false` (§20) | absent |

Two consequences, both live:

1. The two signals §17 retired as **logically impossible for a prospect** — "2nd project scoped"
   needs a first project, "Referred someone" needs a delivered outcome — are collectable again.
2. **The nightly extractor and the running engine disagree about what a climb signal is.**
   `ingest/notes_sweep.ts` may propose `Champion identified` and `Future-state language`; the
   active rubric does not recognise either. Facts collected tonight cannot be used by the engine
   scoring tonight.

Mitigating, and stated so this is not overread: because §20 set `caps_ceiling: false`, climb
evidence no longer gates the ceiling, so the missing `lift_requires` bar changes no tier today.
The signal-vocabulary mismatch is real regardless.

## 2 · Migrations: what is applied versus what is filed

64 Prospect Book migrations applied (75 total in a project shared with other WLIQ systems);
31 `.sql` files on disk. **33 applied with no file.**

Filenames on disk do not share timestamps with applied versions, so these are matched by name.

Applied, not filed:

- `prospect_book_movement_views_null_rank_fix`
- `prospect_book_fact_source_precedence`
- `prospect_book_website_team_pages`
- `prospect_book_website_retry_window`
- `prospect_book_research_log`
- `prospect_book_candidates_from_reads`
- `prospect_book_candidate_source_from_method`
- `prospect_book_contact_events`
- `prospect_book_engagement_mutual_counts`
- `prospect_book_mdm_registry`
- `prospect_book_mdm_junk_domains`
- `prospect_book_a_client_is_still_a_prospect`
- `prospect_book_orbit_clients`
- `prospect_book_admit_from_orbit`
- `prospect_book_admit_from_orbit_fix`
- `prospect_book_roster_source_orbit`
- `prospect_book_gmail_sweep_staging`
- `prospect_book_contact_events_from_gmail`
- `prospect_book_attribute_orphan_calls`
- `prospect_book_attribute_orphan_calls_fix`
- `prospect_book_attribute_orphan_calls_uuid_fix`
- `prospect_book_call_attribution_candidates_per_call`
- `prospect_book_attribute_orphan_calls_register_columns`
- `prospect_book_contact_events_from_calls`
- `prospect_book_orbit_quote_sweep`
- `prospect_book_norm_company_suffixes`
- `prospect_book_contact_events_from_quotes`
- `prospect_book_chase_board_v2`
- `prospect_book_chase_board_dedupe_registry_join`
- `prospect_book_chase_board_new_logo_rank_v2`
- `prospect_book_quote_match_by_domain`
- `prospect_book_chase_board_by_company`
- `prospect_book_prospect_board`

Every file on disk has been applied.

Everything from `prospect_book_research_log` onward (16 Sep) is a second system — boards, a
registry, contact events, a chase score — built entirely in the database with no file, no test
and no decision entry.

## 3 · Verified state, 17 Sep 2026

| Measure | Value | Query |
|---|---|---|
| Live accounts (`book in (prospect,parked)`) | 828 | `count(*) from pb_accounts` |
| Reads on the active rubric | 829 | `pb_reads where rubric_version='0.1.3'` |
| Reads on the retired 0.1.0 | 9,439 | same, `'0.1.0'` |
| Fact candidates proposed / ever reviewed | 904 / 25 | `pb_fact_candidates` |
| Members: owners / raters | 2 / 0 | `pb_members` |
| Overrides ever recorded | **0** | `pb_register where kind='override'` |
| Promotions ever recorded | **0** | `pb_promotions` |
| Potential snapshots (the calibration loop) | **0** | `pb_potential_snapshots` |
| `pb_chase_scores` — a summed composite | 146 rows, score **−18 … 123** | `pb_chase_scores` |
| Website texts fetched / read by anything | 914 / **0** | `pb_website_reads` |

`pb_chase_scores` is a single summed number. The founding rule of this system is four reads,
never summed (`CLAUDE.md` rule: "never a composite number"). Nothing prevented it being built.

## 4 · Source liveness

*Point-in-time. The Fathom row was acted on later the same day — DECISIONS §24.*

| Source | Newest row | Live? |
|---|---|---|
| Pipedrive | 16 Sep 2026 | **Yes** — 236 deliveries, `user-agent: Pipedrive Webhooks`, latency 0.18–2.52 s |
| Fathom | `pb_calls` newest held 11 Sep 2026 | **No.** 988 `source=fathom` inbox rows, every one `user-agent: pg_net/0.19.5`, all 13 Sep (the back-fill posting to its own endpoint). The only other `pg_net` rows are 2 Pipedrive receiver tests on 14 Sep. **Zero Fathom-originated deliveries in the table's life**; nothing purges it |
| Orbit | client rows added by hand 16 Sep | **No automated path.** No function, cron job or code path reads Orbit |
| Gmail | — | **No credential in Vault**; the channel is skipped every night |

## 5 · What this snapshot is for

It is the baseline the repair work is measured against. The rule being adopted is:

> **Nothing is activated that does not have a file, and nothing has a file that is not tested.**

The three reconciliation checks that would make this snapshot self-maintaining — rubric drift,
migration drift, source liveness — are specified in `docs/RESEARCH-CONFORMANCE.md` and are not
yet built. Until they are, this document goes stale the moment anything is applied to the
database without a commit, which is exactly how it got out of step the first time.
