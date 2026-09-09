# Phase 0 — access status and acceptance

The access table from `docs/DESIGN.md` §7, expanded into what a human must do. Status words:
**done** · **blocked** (needs a person outside the build) · **pending** (the build does it once
the blocker before it clears). Result cells are filled by the orchestrator at the end of each
phase; nothing in this file is a ruling.

## 1 · Access checklist

| # | Access | State on 9 Sep | Who | What exactly must happen | Status |
|---|---|---|---|---|---|
| A1 | Pipedrive API | MCP `get_pipelines` → "authentication failed". Pipedrive is the ruled roster source of truth (PRO-6), so the certified roster is unreadable. | the owner / Pipedrive admin | Regenerate the personal API token (Pipedrive → Personal preferences → API) **or** complete the OAuth grant on the MCP. Put the token in Vault as `PB_PIPEDRIVE_API_TOKEN` (RUNBOOK §1). | **blocked** |
| A2 | Pipedrive webhook | Cannot be created or tested until A1 clears. | the owner / admin, then this build | Create webhooks v2 for `deal` and `organization` pointing at `…/functions/v1/pb-pipedrive-webhook` with the HTTP Basic pair stored as `PB_PIPEDRIVE_WEBHOOK_BASIC` (RUNBOOK §5). | **pending** (on A1) |
| A3 | Fathom webhook | Creatable via the owner-account Fathom MCP (the account whose recordings are shared with the team) once the endpoint is deployed. | this build | Deploy `pb-fathom-webhook`; `create_webhook` with all four include flags and `triggered_for = my_recordings + shared_team_recordings`; store the `whsec_…` as `PB_FATHOM_WEBHOOK_SECRET` (RUNBOOK §4). | **pending** (on deploy) |
| A4 | Fathom REST back-fill | Per-user key only. MCP `list_meetings` with `calendar_invitees_domains` and `include_transcript` covers the back-fill in-session. | this build (in-session); the owner for an admin key | Back-fill runs from a session through `pb-sync`. An admin key would let a function do it unattended — not required for Phase 1. | **done** (in-session path) / admin key **blocked** |
| A5 | Orbit | MCP only; the Orbit 1.0 API is not ready. | this build | Read `list_projects` (status Quote) and payment details in-session; map through `ingest/orbit_quotes.ts`; post to `pb-sync` or insert by SQL. | **done** (path) — run **pending** |
| A6 | Apollo | MCP available. 2,573 lead credits; direct-dial at 0 until 3 Oct. **No credits spent without a fresh confirmation.** | the owner | Confirm a credit budget for enrichment in writing. Not needed for Phase 0/1 acceptance. | **blocked** (budget) |
| A7 | Gmail inbound counts | MCP only; a collector job, not an edge function. | later phase | Nothing in Phase 0/1. Deal-health email counts stay null (unknown never warns). | **pending** (later phase) |
| A8 | GitHub Pages | Repo is public; Pages not yet enabled. | the owner (repo admin) | Settings → Pages → Source → GitHub Actions, once. Then dispatch `deploy-pages.yml`; then add the Pages URL to Supabase Auth → URL Configuration (RUNBOOK §6–7). | **blocked** (one dashboard step) |
| A9 | Supabase Vault secrets | `PB_SYNC_TOKEN`, `PB_FATHOM_WEBHOOK_SECRET`, `PB_PIPEDRIVE_WEBHOOK_BASIC`, `PB_PIPEDRIVE_API_TOKEN`. | this build (SQL) + the owner for the Pipedrive value | `vault.create_secret(...)` per RUNBOOK §1. The sync token and Basic pair can be generated now; the Fathom secret after A3; the Pipedrive token after A1. | **pending** |
| A10 | `pb_members` rows | Empty until inserted. Reading needs no row (PRO-7); writing does (PRO-5). | the owner names the two raters | Insert owner + two rater rows (RUNBOOK §8). | **blocked** (names) |
| A11 | Migrations + edge functions | Written in this repo. | this build (Supabase MCP) | `apply_migration` × 2, `deploy_edge_function` × 4, insert the active rubric row (RUNBOOK §2–3). | **pending** |
| A12 | Notion master seed | Data source `collection://96938468-…` readable via MCP; 62 prospect rows on 9 Sep. | this build | Run `ingest/notion_seed.ts` in-session, post to `pb-sync`. Rows that are already clients are reported, not seeded (PRO-10). | **pending** |

## 2 · Acceptance test — Phase 0

Restated from the brief: **one Pipedrive deal, one Fathom call and one Orbit quote read end
to end into `pb_runs`.** Each source must produce a verified inbound row, the mapped table
row, and a `pb_runs` entry that names it.

| Check | Evidence to show | Result |
|---|---|---|
| P0-1 | One Pipedrive deal lands in `pb_webhook_inbox` (source pipedrive, `verified = true`), becomes a `pb_deals` row attached to a `pb_accounts` row, and a `pb_runs` row (kind `webhook`, source `pipedrive`) records it. *Depends on A1/A2.* | `<to be filled by the orchestrator>` |
| P0-2 | One Fathom call lands in `pb_webhook_inbox` (source fathom, `verified = true`), becomes a `pb_calls` row with `attendees` and `external_domains`, attached by domain or queued in `pb_identity_candidates`, and a `pb_runs` row (kind `webhook`, source `fathom`) records it. | `<to be filled by the orchestrator>` |
| P0-3 | One Orbit quote (status Quote) becomes a `pb_signals` row of a `quote_*` / `orbit_*` type with payload {project id, slug, title, quoted_hours, project_payment_cost}, a `quote_amount` fact where cost > 0, attached to an account or queued as an identity candidate; a `pb_runs` row (kind `ingest`, source `orbit`) records it. | `<to be filled by the orchestrator>` |
| P0-4 | A manual `pb-score` run completes with `status = success` and writes one `pb_reads` row per prospect account. | `<to be filled by the orchestrator>` |

## 3 · Acceptance test — Phase 1

Restated from the brief: **every seeded account shows its sources on one screen.**

| Check | Evidence to show | Result |
|---|---|---|
| P1-1 | Every seeded account (Notion master, Pipedrive, Orbit) appears on the roster, and its sheet lists every system that touched it with dates, the four reads, signals, calls, deals, register entries and merge-queue items — on one screen. | `<to be filled by the orchestrator>` |
| P1-2 | Duplicate candidates (medium/low identity matches) appear in the merge queue as `pb_identity_candidates` rows with `status = proposed`; none was merged automatically. | `<to be filled by the orchestrator>` |
| P1-3 | A new Pipedrive deal appears in `pb_deals` within a minute of creation. *Depends on A1/A2.* | `<to be filled by the orchestrator>` |
| P1-4 | A new Fathom call appears in `pb_calls` with `attendees` populated (name, email, is_external) after the recording is ready. | `<to be filled by the orchestrator>` |
| P1-5 | Orbit's open quotes are each either attached to a `pb_accounts` row or listed as unmatched in `pb_identity_candidates` (source orbit, `matched_on = none`). | `<to be filled by the orchestrator>` |
| P1-6 | Every roster row prints the word *anticipated* beside its tier, a confidence, and "UNVALIDATED (PRO-8)"; no bare number is shown anywhere on the page. | `<to be filled by the orchestrator>` |
| P1-7 | Uncertified rows (every non-Pipedrive roster source) carry the "Roster source uncertified" flag and are still graded (PRO-6, PRO-8). | `<to be filled by the orchestrator>` |

## 4 · What clears the blockers

- **A1 (Pipedrive token)** unblocks A2, P0-1, P1-3 and the certified roster. One person, once.
- **A8 (Pages enabled)** unblocks the page and therefore every P1 check that reads "on one screen".
- **A10 (rater names)** unblocks the write paths on the page; reads work without it.
- **A6 (Apollo budget)** blocks nothing in Phase 0/1.
