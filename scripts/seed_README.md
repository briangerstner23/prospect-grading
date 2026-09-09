# Running the one-time seed (`scripts/seed.ts`)

`scripts/seed.ts` composes the four intake sources into one consistent set of `pb_*` rows and
writes numbered SQL files. It is **generate only**: it never touches the database, never reads
the network, and never reads or writes anything inside this repository other than
`core/rubric.prospect.v0.1.json`. The operator applies the files through the Supabase MCP.

The mappers do the reading (`ingest/pipedrive_seed.ts`, `ingest/notion_seed.ts`,
`ingest/orbit_quotes.ts`, `ingest/fathom_webhook.ts`); this script only composes: it assigns
account ids, applies the PRO-10 cross-check, attaches Notion rows to Pipedrive organisations on
a high key only, carries Orbit client ids across, decides fact precedence, validates every row
against the schema's constraints and the rubric's signal catalog, and fails loudly on anything it
cannot vouch for.

**No prospect data enters the repository.** Inputs and outputs live in a scratch directory
(the session scratchpad, or a `scratch/` / `data/` directory, both git-ignored). Names, domains
and dollar values flow from the pulls to the SQL files and never into a committed file.

## Usage

```bash
node --experimental-strip-types scripts/seed.ts \
  --in    <dir with the collected pulls>          # required (or PB_SEED_IN)
  --out   <dir for the SQL files>                 # default <in>/seed   (or PB_SEED_OUT)
  --as-of 2026-09-09                              # YYYY-MM-DD; default today (UTC)
  --uuid-seed <any text>                          # optional; makes account ids reproducible
```

| Flag | Meaning |
|---|---|
| `--in` | Directory holding the input JSON files listed below. Required. |
| `--out` | Directory the SQL files, `manifest.json`, `notes.txt` and `SUMMARY.md` are written to. Existing `NN_*.sql` files there are removed first. **The reference pull `client_book_keys.json` must already be in this directory** (see Inputs). |
| `--as-of` | The seed's clock. Signals dated after it are dropped by the mappers; facts are stamped with `created_at` from this date; the engine never reads a clock, so the date must be stated. |
| `--uuid-seed` | When given, every new `pb_accounts.id` is derived deterministically from this seed and the account key, so a re-run reproduces the same ids. Without it ids are random. |

Node 22+ (`--experimental-strip-types`). Every date in the inputs is parsed as UTC whatever
machine runs it (`process.env.TZ = "UTC"`).

## Inputs — what the collector pulls, and where each came from

All JSON, in `--in`. The collector is a session with the MCPs; the pulls are saved verbatim
(or lightly reshaped as noted) and never committed.

| File | Shape | Source |
|---|---|---|
| `pipedrive_stages.json` | `getStages` envelope `{data:[…]}` or a bare array | Pipedrive MCP, read-only. Stage names come from here at run time; the ids are in `ingest/pipedrive_seed.ts` `STAGE`. |
| `pipedrive_cj_deals.json` | `getDeals` for pipeline 9 (Client Journey), all statuses, `{data:[…]}` or array | Pipedrive MCP. One card per company, `CJ - <name>`. |
| `pipedrive_p1_open_deals.json` | `getDeals` for pipeline 1, status open | Pipedrive MCP. |
| `pipedrive_orgs.json` | `getOrganizations`, every organisation referenced by a card or deal | Pipedrive MCP. Custom fields arrive keyed by 40-hex hash; enum values as `{id,label}` (with option labels) or bare strings — both are read. |
| `pipedrive_persons.json` | array, or `{persons:[…], org_persons_index:{…}}` | Pipedrive MCP `getPersons`. |
| `pipedrive_activities.json` | array, or `{activities:[…]}` | Pipedrive MCP `getActivities` (meetings and calls → `meeting_accepted` signals). |
| `notion_prospects.json` | array of rows with **verbatim** property names (`Client Name`, `Record type`, `ICP class`, …). Multi-select cells may arrive as JSON-array strings; the script parses them before mapping. | Notion MCP, Clients master data source, rows where `Record type = Prospect` (62 on 9 Sep). |
| `prospect_domains.json` | `{by_account: {"<Notion Client Name>": ["domain", …]}}` | Collector research, for Notion rows that carry no contact email. Only used when the row has no domain of its own. |
| `orbit_clients_for_prospects.json` | `{lookups:[{notion_client_id, prospect_name, prospect_domain?, note?, candidates:[{id, company_name, company_email?, website_link?, match?, match_basis?}], best:{orbit_client_id, match: high\|medium\|low\|none}}]}` | Orbit MCP `list_clients`, one lookup per Notion prospect. 9 Sep: 19 high on domain, 19 name-only, 22 none. |
| `orbit_quotes.json` | `{rows:[OrbitProjectRow…]}` — `id, title, url, status, life_cycle_status, client_name, quoted_hours, created_at, project_start_date, project_payment_cost?` | Orbit MCP `list_projects` with status Quote (+ `get_project_payment_details` where readable). 9 Sep: 212 open, one with a dollar value. Timestamps carry no zone and are treated as UTC. |
| `fathom_backfill.json` | `{meetings:[{recording_id, title, url\|share_url, created_iso, recorded_by, attendees:[{name,email,is_external}], summary, action_items}]}` | Briang-account Fathom MCP `list_meetings`, paged over the whole team since 1 Jun 2026 and matched client-side against the prospect domains (the MCP ignores `calendar_invitees_domains`). 9 Sep: 12 external calls across 7 prospect domains. |
| **`<out>/client_book_keys.json`** | `{grading_roster:[{client_key, name, status, effective_tier}], grading_book_keys:[…], pb_accounts:[{id, key, name, domain, pipedrive_org_id, orbit_client_id, notion_client_id}]}` | A **read-only** reference pull the orchestrator saves before the run, via `execute_sql`: the Client Book's `grading_roster` / `grading_book` keys and names (PRO-10; nothing is imported, no table is shared) plus the existing `pb_accounts` rows (so a re-run reuses ids instead of colliding). The script refuses to start without it. |

## What the script does, in order

1. **Pipedrive roster (certified, PRO-6).** `mapPipedriveRoster` turns the pull into accounts,
   facts, signals, contacts and deals. The roster is every organisation whose most recently
   updated **open** Client Journey card is in a prospect stage — New, Schedule Sales Call, Sales
   Call Done, Quoting, Quote Lost, or Unqualified/DNC (that one lands in the `parked` book) —
   plus every organisation with an open pipeline-1 deal and no card at all (flagged "No CJ
   card"). Cards in Active / Inactive / Past / Lost Client are Agency Partners (PRO-10) and never
   enter; Friends of WLIQ is not a sales relationship. All rows: `roster_source = pipedrive`,
   `roster_certified = true`. Custom-field keys are the inferred set in `PipedriveKeys`
   (`ingest/pipedrive_seed.ts`); a run may override any of them through `opts.keys`. Long
   informational facts are left out to keep the load small (re-pullable); the kept set is
   `PIPEDRIVE_KEEP` in the script.
2. **PRO-10 cross-check.** Every Pipedrive organisation name, every Notion row name and every
   Orbit quote's client name is compared with the Client Book keys under three spellings
   (`norm(name)` compacted, lower-case alphanumerics, and the Client Book's own key style). A hit
   means "already an Agency Partner": the organisation or row is dropped with every dependent
   row, and the quote is counted, not written. Everything dropped is listed in `SUMMARY.md` and in
   `pb_runs.counts.skipped`.
3. **Notion master (uncertified intake).** `mapNotionProspects`, then for each row: attach to an
   existing (Pipedrive) account **only on a high key — the contact-email domain equals the
   organisation domain**. A name-only resemblance creates a **separate** account with a
   disambiguated key and a merge-queue row; the script never merges on a name. Attached rows
   add `notion_client_id` / `notion_page_id` to the survivor and a `notion_attached_on` fact
   saying why. Two Notion rows sharing a domain are both created and queued for a person.
4. **Orbit.** Client ids from the lookup file attach on `high` only (medium / low go to the merge
   queue); quotes are then mapped through `mapOrbitQuotes` against the accounts known so far,
   with client ids joined from the lookup file by exact company name. Attached quotes become
   `quote_*` / `orbit_*` signals (and a `quote_amount` fact where cost > 0); name-only matches
   become candidate rows; the rest are listed as unmatched in the run's counts.
5. **Fathom back-fill.** Each meeting is rebuilt as a webhook-shaped payload and passed through
   `parseFathomWebhook`: internal-only calls are skipped, external calls become `pb_calls` rows
   attached by domain (high) or left unattached with a candidate row. **No signal is raised from a
   call.** `transcript_available = false`, `extraction_status = pending`.
6. **Compose.** Facts are ordered and stamped so `pb_current_facts` is deterministic (below);
   contacts are de-duplicated on account + email / person id / name; signals are validated
   against `rubric.signals.catalog` and the `pb_signals.source` allow-list and de-duplicated on
   account + type + observed_at + source + payload; candidate rows are folded to one per
   (account, source, source id, domain).
7. **Write** the SQL files, `manifest.json`, `notes.txt` (every mapper note, by lane) and
   `SUMMARY.md` (the dry-run report: counts, attachments, skips, spot checks).

## The fact-precedence rule

Facts are append-only and `pb_current_facts` takes the latest `created_at` per (account, key),
so precedence is expressed as emission order. The script stamps `created_at` explicitly,
1 ms apart, in this order: **Notion facts first, Pipedrive facts later, then Orbit, then the
seed's own notes.**

- **Pipedrive wins where both speak.** A Notion fact whose key Pipedrive also supplies for the
  same account is not emitted at all (counted in `counts.facts.notion_dropped_by_precedence`).
- **Notion fills what Pipedrive lacks**: any key Pipedrive did not emit for that account.
- **Always from Notion**: `wl_signal`, `stated_ceiling`, `climb_signals` — Pipedrive has no field
  for them today; if it ever emits one, Pipedrive still supersedes by `created_at`.
- Notion's `headcount` and `service_shape` fill only when Pipedrive did not supply them
  (Pipedrive's employee range and services of interest win where present).
- Economics is never emitted by any mapper (the floor's basis is unruled; the engine derives it).

## Outputs

| File | Contents |
|---|---|
| `01_accounts.sql` | `insert into pb_accounts … on conflict (key) do update` — keys are filled where empty, `roster_certified` is OR-ed, `book` is never demoted from `promoted` / `merged`. Safe to re-apply. |
| `02_contacts.sql` | plain inserts |
| `03_facts.sql` | plain inserts with explicit `created_at` (the precedence order) |
| `04_signals.sql` | plain inserts; weight / lifespan / decays from the rubric catalog |
| `05_calls.sql` | `on conflict (fathom_recording_id) do nothing`. Safe to re-apply. |
| `06_deals.sql` | `on conflict (pipedrive_deal_id) do update` (keeps `close_date_pushes`). Safe to re-apply. |
| `07_identity_candidates.sql` | plain inserts, all `status = proposed`. Nothing is merged by the seed. |
| `08_runs.sql` | one `pb_runs` row, kind `seed`, with the full counts JSON |
| `manifest.json` · `notes.txt` · `SUMMARY.md` | the dry-run record; read `SUMMARY.md` before applying anything |

Every SQL file is a single transaction (`begin; … commit;`) and **≤ 150 KB**; a set that would
exceed the limit is split into `NN_name_01.sql`, `NN_name_02.sql`, … A single row larger than the
limit fails the run.

## Applying the SQL

1. Read `SUMMARY.md`: the counts, the Notion → Pipedrive attachments, the PRO-10 skips, the
   unmatched quotes and the five spot-check accounts. If anything looks wrong, fix the input or
   the mapper and re-run the script; nothing has been applied yet.
2. Apply the files with the Supabase MCP `execute_sql`, **one file per call, in lexical order**
   (`01_accounts.sql`, then `02_…`, … `08_runs.sql`). Each call is one transaction; a failure
   leaves that file unapplied and the earlier ones intact.
3. Apply each file **once**. `01`, `05` and `06` are idempotent; `02`, `03`, `04`, `07` and `08`
   are plain inserts and would duplicate rows if applied twice.
4. Run a manual score (`docs/RUNBOOK.md` §9) and check
   `select started_at, status, counts from pb_runs where kind = 'seed' order by started_at desc limit 1;`.
5. Review the merge queue (`docs/RUNBOOK.md` §12). Every row the seed could not attach on a high
   key is waiting there for a person; the seed itself never merges (PRO-18's discipline).

## Re-running

Save the reference pull again first (existing `pb_accounts` rows are reused by key and by
Pipedrive organisation id, so ids stay stable), pass the same `--uuid-seed`, and treat the
non-idempotent files as new inserts — either on a clean set of `pb_*` tables or after
deleting the previous seed's rows deliberately. The script deletes only its own earlier
`NN_*.sql` files in `--out`.
