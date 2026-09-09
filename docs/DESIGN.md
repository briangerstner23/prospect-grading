# The Prospect Book — design

**Status:** Phase 0–1 build, 9 September 2026. Against the Grading Register's prospect rulings
PRO-0 … PRO-18 (in `wliq-momentum`, `client-grading/ingest/prospect_rulings.json`) and the
9 Sep build kit (Drive: `Documents/Claude/prospect grading/`). **Where the kit and the register
disagree, the register wins** — the kit says so itself. `docs/DECISIONS.md` lists every point
where that happened.

This repository is its own system (PRO-17). It borrows the Client Book's *discipline* — pure
engine, versioned rubric as data, evidence labels, append-only facts, a register, golden
fixtures, default-deny RLS — and none of its code, tables or identity list. The two systems
connect at one event: **promotion**, when a first invoice appears and a person confirms which
prospect it was (PRO-10, PRO-18).

---

## 1 · What one record produces

One row per agency. Four reads, computed separately, never summed:

| Read | Question | Output | Source of inputs |
|---|---|---|---|
| **Fit** (Dimension B) | Is it work we're good at? | anticipated tier **Platinum / Gold / Silver / Bronze** + confidence | ICP class, service shape, economics, adjustment facts |
| **Qualification** (Dimension A) | Is the deal real? | count of money · authority · timing · specification present → Qualified / Partly qualified / Conversation | CRM facts, quotes, call attendance |
| **Potential** | How big could it get? | ceiling **Project / Embedded / Partner**, headroom band, year-1 **band** (never a figure), confidence | headcount, WL signal, archetype, vendor rank, quotes, climb evidence |
| **Signals** | Are they moving now? | decayed score → urgency **Super Hot / Hot / Warm / Cold**, tasks with SLAs | pb_signals |
| **Deal health** | Are we winning? | red / yellow / green per open deal, warnings | pb_deals (Pipedrive), Gmail counts, Fathom fields |

Output per record: `status` (Parked / Unclassified / Overridden / Ranked), `effective_tier`,
`cell` = tier × ceiling, a `chase_rank_key` (PRO-0: ordering is the job), a one-sentence
`reason`, `flags`, and the full breakdown. Every tier prints **anticipated** and its
confidence (PRO-1r) and, under v0.1, **UNVALIDATED (PRO-8)**.

### 1a · How the anticipated tier is derived (rubric v0.1, all thresholds in the JSON)

1. **Gates** run first, in order: service shape (Off → Parked), economics (fail → Parked),
   broker character (**flag only**, PRO-2r-a open), geography (off). `unknown` never parks.
   A parked row's grade is still computed and stored; only its status changes (PRO-0).
2. **ICP class**: a stated fact wins; otherwise the six-step classification flow derives it.
   None → Unclassified.
3. **Base tier** from ICP, the July mapping restated on four words: ICP-1/2/4 → Gold,
   ICP-6 → Silver, ICP-3/5 → Bronze. Platinum is never a base.
4. **Named adjustments**, each logged with its basis; **net cap +1 / −1** (the +1 is ruled).
   Agency-only rules skip direct-to-client rows (PRO-4). Adjustments never reach Platinum.
5. **Platinum rule**: adjusted Gold **and** ceiling Partner (with climb evidence) **and** ≥ 3
   of the 4 Dimension A facts present.
6. **Override** (owner only, one tier max, reason code, expiry) → Overridden. Beyond the
   cap the engine refuses the override and flags it.
7. **Confidence** from the evidence labels of the inputs and the fact count.

Chase order: tier ↓, facts present ↓, urgency ↓, year-1 band ↓, name.

---

## 2 · Repository layout

```
core/
  prospect_types.ts              the complete input/output types (written)
  rubric.prospect.v0.1.json      the versioned spec as data (written)
  engine.ts                      PURE: grade(features, rubric, options) → scorecard; fingerprint()
  engine_test.ts                 unit tests + golden replay
  classify.ts                    (optional split) ICP flow, gates — imported by engine.ts
fixtures/
  golden.json                    ~12 SYNTHETIC accounts, {id, description, features, expected: {"0.1.0": {...}}}
ingest/
  identity.ts                    norm(), normalizeDomain(), proposeMatches() → merge-queue rows. Never auto-merges.
  resolve_features.ts            pb_current_facts rows + signals + deals + prior grades → ProspectFeatures
  notion_seed.ts                 Notion master row (verbatim property names) → accounts + facts + prior_grade signals
  orbit_quotes.ts                Orbit project rows (status Quote, life_cycle_status, payment details) → signals + identity candidates
  pipedrive_webhook.ts           webhooks v2 payload → deals / accounts / contacts upserts (field map passed in, never hard-coded)
  fathom_webhook.ts              webhook payload → pb_calls row; external-domain join; seven-field extraction SCHEMA (extraction itself is a later step)
  decay.ts                       decayed weights, urgency, routing tasks (shared with engine via a pure module)
  reason.ts                      the one-sentence reason builder (shared with engine)
supabase/
  migrations/20260909120000_prospect_book_schema.sql   (written)
  migrations/20260909120100_prospect_book_cron.sql     pg_cron + pg_net nightly score (written)
  functions/pb-sync/index.ts             bearer-token bulk ingest of packs: accounts, facts, signals, contacts, deals, calls, identity_candidates
  functions/pb-score/index.ts            score every account (or ?account=) under the active rubric → pb_reads; refreshes pb_accounts listing columns; writes pb_runs
  functions/pb-fathom-webhook/index.ts   Standard-Webhooks signature check → pb_webhook_inbox → pb_calls
  functions/pb-pipedrive-webhook/index.ts  HTTP Basic check → pb_webhook_inbox → pb_deals / pb_accounts / pb_contacts
  functions/_shared/                     db client, secrets (pb_secret RPC), engine import shim
web/
  index.html                     the Prospect Book page (single file, no build step; sign-in with Supabase magic link)
explain/
  generate_method.ts             rubric JSON → docs/METHOD.md; method_test.ts fails if stale
docs/
  DESIGN.md · DECISIONS.md · METHOD.md (generated) · PHASE0.md (access status) · RUNBOOK.md
.github/workflows/deploy-pages.yml   publishes web/ to GitHub Pages (manual dispatch; Pages must be enabled once)
```

**Conventions.** TypeScript that runs under both Deno (edge functions) and
`node --experimental-strip-types` (tests, scripts): relative imports with `.ts` extensions,
no npm dependencies in `core/`, `ingest/` or `explain/`. Edge functions import
`jsr:@supabase/supabase-js@2` and copy the pure modules they need through
`supabase/functions/_shared/` (Supabase deploys a function's own files only). Money is in
dollars, ratios are 0–1, dates are ISO strings, the engine never reads a clock (`as_of` is an
input). snake_case for every key that reaches the database.

**No prospect data enters this repository.** The repo is public today. Fixtures are
synthetic. Names of people appear only as roles.

---

## 3 · The engine (core/engine.ts)

```
grade(features: ProspectFeatures, rubric, options?: {override}) → ProspectScorecard
```

Pure, deterministic, no I/O. Order of work: gates → ICP → base tier → adjustments (with caps
and the agency-only exclusion) → qualification → potential → platinum rule → signals →
deal health → override → status → effective tier, cell, chase key → flags → reason → trace.

Rules the implementation must honour:

- **Unknown is never evidence.** A null input never fires a gate, an adjustment or a warning;
  it produces a flag ("Headcount unknown", "Service shape unknown") where the rubric names one.
- **Every fired rule is in the trace** with its inputs, its rule text and its basis
  (`ruled` / `unruled_default` / `reasoned`). A reader can re-derive the tier by hand.
- **Bands are labels.** `year1_band` and `headroom_band` are strings from the rubric; the raw
  headroom number lives in the trace for audit only and is never shown on the page.
- **Decay** uses `as_of`, never `Date.now()`. Negative signals with `decays: false` count at
  full weight until `lifespan_days` then drop to zero.
- **Urgency**: a stated `timing` fact wins; else the decayed-total ladder; else Cold with
  basis `none`.
- **Tasks**: one strong signal (weight ≥ 8) or two medium (≥ 4) inside the routing window
  creates a task with the signal's `sla_hours` (or the default), due from `observed_at`.
- **Deal health** is computed per open deal; with no deals the array is empty and the reason
  sentence omits it. `unknown_never_warns`.
- **Override**: applied only when `approver` and `reason_code` are present and
  `|TIER_ORDER.indexOf(override.tier) − TIER_ORDER.indexOf(computed_tier)| ≤ 1`; otherwise
  refused with flag "Override refused: beyond one-tier cap" and the computed tier stands.
- `rubric_fingerprint` = FNV-1a hex of the rubric JSON (same helper as the client engine, so
  the two systems' fingerprints are comparable in form and never in value).
- The **reason sentence** follows `rubric.reason_sentence.shape` and contains no bare score.

Fixtures: `fixtures/golden.json`, ≥ 12 synthetic accounts covering — parked on service shape;
parked on economics; unclassified; ICP-1 Gold with Partner ceiling and 4 facts → Platinum;
ICP-2 Gold with no climb evidence (ceiling capped) → Gold; ICP-3 with WL High → Silver via
ADJ-WL; ICP-3 with two positives (cap binds at +1); ICP-6 direct (agency-only rules skipped,
flagged); ICP-4 unproven vertical → Silver; a Conversation row (0 facts); an override within
cap; an override beyond cap refused; a lapsed-client lineage row; a row with a quote → year-1
from quote; a negative signal that does not decay; a Super Hot stated timing overriding a Cold
computed score; a red deal on three pushes. `engine_test.ts` replays every fixture and fails on
any drift.

---

## 4 · Ingest

### 4a · Identity (`ingest/identity.ts`)

`norm(name)` — lower-case, strip punctuation and the words `the`, `inc`, `llc`, `ltd`,
`agency`, `group`, `co`; collapse whitespace; this is `pb_accounts.key`.
`normalizeDomain(url|email)` — host only, no `www.`, lower-case; generic mail domains
(gmail, outlook, yahoo, icloud, hotmail) return null.

Join keys, in order of trust: `pipedrive_org_id`, `orbit_client_id`, `domain`, then
`norm(name)`. A key match on the first three is `high`; `norm(name)` exact is `medium`;
anything fuzzier (trigram ≥ 0.85) is `low`. **Only `high` attaches automatically**; medium
and low become `pb_identity_candidates` rows for a person (PRO-18's discipline applied to
every source, not just promotion). Never merge two pb_accounts rows without a register entry.

### 4b · Notion master seed (`ingest/notion_seed.ts`)

Source: Clients master data source `collection://96938468-40c8-8332-9a1a-87cf382ad1f2`,
rows where `Record type = Prospect` (62 on 9 Sep). Property names are used **verbatim** as
`pb_facts.note` provenance and mapped to feature keys:

| Notion property | → | feature key / table | evidence label |
|---|---|---|---|
| Client Name, Client ID | pb_accounts.name, notion_client_id | — |
| Relationship type (Agency partner / Direct-to-client / Unknown) | relationship_type agency / direct / null | inferred |
| ICP class (ICP-1…6) | icp_class | inferred |
| Agency type (text) | agency_type via keyword map (full-service → full_service; boutique; digital; niche/vertical; consult/fractional → consultancy) — unmapped text kept as note | inferred |
| Headcount | headcount | inferred |
| WL signal (Very High/High/Medium/Low) | wl_signal | inferred |
| Gate: needs what we do (Core/Adjacent/Neither/Unknown) | service_shape Core / Complement / Off / null | inferred |
| Gate: can afford us (Yes/No/Unknown) | money present/absent/unknown **and** economics pass/fail/null | inferred |
| Gate: decent to deal with (Pass/Flag/Unknown) | broker_character pass/flag/null | inferred |
| Key decision maker? (Yes/No/Unknown) | authority | inferred |
| Lead priority (Super Hot/Hot/Warm/Cold) | timing within_1_week / within_1_month / within_3_months / no_timeline | inferred |
| Active project / immediate need? (Yes/No/Unknown) | specification present/absent/unknown — **approximation, flagged in the note** | inferred |
| Ceiling (A job / Seat at the table / Partnership) | stated_ceiling Project / Embedded / Partner | inferred |
| Proof of growth (multi) | climb_signals (verbatim strings) | inferred |
| Est Year-1 $ | pb_signals type prior_grade payload {field: "Est Year-1 $", value} — **not** quote_amount (it is a band someone selected, §14.5 C2) | — |
| Referral source (text) | referral_from_network = true when it mentions Brian, AMI, BABA, Agency Builders, AMIN, referral; else stored as note only | inferred |
| Trigger event (text) | pb_signals type manual_note, payload {text}, observed_at = row last edited | — |
| Prospect grade (effective), SQL grade (auto), Grade adjustment (rule), Override reason | pb_signals type prior_grade, one per non-empty field, payload {field, value, source: "notion_master"} | — |
| Headroom / vendor rank (text) | parse `#n of N` → our_rank, n_vendors when present; else note | inferred |
| Contact name / title / email, Additional contacts | pb_contacts | — |
| Status (Active/New/Stale/Inactive/Lost/Cancelled) | pb_facts key notion_status (informational) | inferred |
| Current AM | owner_email left null; value kept as fact `notion_current_am` | inferred |

Every seeded account: `roster_source = notion_master`, `roster_certified = false`
(PRO-6), `book = prospect`. `observed_at` = the row's last-edited date. `entered_by =
system:notion_master`. Rows whose `Business Status` is `Client` or that carry `T12M billings $`
> 0 are **not** seeded as prospects: under PRO-10 an invoice makes an Agency Partner; they are
listed in the run's `errors` as "already an Agency Partner — stale prospect row".

### 4c · Orbit quotes (`ingest/orbit_quotes.ts`)

Input: `list_projects` rows with status Quote (211 open) plus `life_cycle_status` and, where
readable, `get_project_payment_details.payment_details.project_payment_cost`. Map:
`quoted` → quote_sent, `refine` → quote_sent, `verbally_accepted` → orbit_verbally_accepted,
`pa_sent` → orbit_pa_sent, `pa_signed` → orbit_pa_signed; `not_set` / missing → quote_requested.
`observed_at` = project `created_at`; payload carries project id, url slug, title,
`quoted_hours`, `project_payment_cost`. Where the cost is > 0 also write fact `quote_amount`
(evidence). Join on `client_name` → norm(name) against pb_accounts; misses go to
`pb_identity_candidates` (source orbit, matched_on none) so the acceptance test can list
"attached or unmatched". Orbit client id is attached when the client list has been loaded.

### 4d · Pipedrive (`ingest/pipedrive_webhook.ts`, `functions/pb-pipedrive-webhook`)

Webhooks v2 payload: `{ meta: { action: create|change|delete, entity: deal|organization|
person|activity|note, entity_id, company_id, user_id, timestamp, version: "2.0", webhook_id,
is_bulk_edit, change_source, attempt }, data: {...}, previous: {...} }`. Field map for custom
fields is loaded at runtime from `/v2/dealFields` and `/v1/organizationFields` **and passed
in**; hash keys are never hard-coded (the Grade field `79d0a04a…` with options 414/415/416 is
recorded in config once readable). Deals whose title starts with `CJ` are `is_cj = true`.
Close-date changes append to `close_date_pushes`. Organizations upsert pb_accounts by
`pipedrive_org_id` (attach by domain / norm(name) through identity.ts, otherwise create with
`roster_source = pipedrive`, `roster_certified = true`). Endpoint auth: HTTP Basic against
the vault secret `PB_PIPEDRIVE_WEBHOOK_BASIC` (`user:pass`). Every delivery lands in
`pb_webhook_inbox` first; only verified rows are processed. **Cannot be tested live until the
token is fixed (PRO-6 blocker).**

### 4e · Fathom (`ingest/fathom_webhook.ts`, `functions/pb-fathom-webhook`)

Webhook "new meeting content ready", created through the Briang-account Fathom MCP with
`include_transcript`, `include_summary`, `include_action_items`, `include_crm_matches`.
Signature: Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`
headers; HMAC-SHA256 over `${id}.${timestamp}.${body}`, secret `whsec_…` base64, tolerance
5 minutes). Unverified deliveries are stored in the inbox with `verified = false` and never
become a call. Parser is defensive about field names (`recording_id` | `id`, `title`,
`url` | `share_url`, `created_at` | `recorded_at`, `recorded_by`, `calendar_invitees[]` with
`email`, `name`, `is_external`, `default_summary` | `summary`, `transcript[]`).
`external_domains` = normalized domains of external invitees; join to pb_accounts by domain
(high) else identity candidate. Internal-only calls are skipped, counted in pb_runs. The
seven-field extraction schema is defined here (`CallFields` type) and left `pending`;
extraction is a later step and nothing writes to Pipedrive before `confirmed_by`.

### 4f · Sync (`functions/pb-sync`)

`POST` with `Authorization: Bearer <PB_SYNC_TOKEN>` (vault). Body:
`{ run: {kind, source, triggered_by}, accounts?, contacts?, facts?, signals?, deals?, calls?,
identity_candidates? }`. Upserts in batches of 200 with the natural conflict keys; facts and
signals are inserts only. Returns counts and writes a `pb_runs` row. Refuses everything when
the secret is unset.

### 4g · Score (`functions/pb-score`)

`POST` with the same bearer (or the cron). Loads the active `pb_rubric_versions` row, every
`pb_accounts` row with `book in (prospect, parked)`, current facts, non-expired signals, open
deals, prior grades and the latest override from `pb_register`; resolves features
(`resolve_features.ts`); runs `grade()`; inserts `pb_reads`; updates the listing columns on
`pb_accounts` (`status`, `effective_tier`, `cell`); writes `pb_runs`. `?account=<id>` scores
one. `?rubric=<version>&preview=1` scores under a draft rubric **without writing reads** and
returns the tier diff against the current reads (the preview-before-activate pattern).

### 4h · Cron

`20260909120100_prospect_book_cron.sql` enables `pg_cron` and `pg_net` and schedules
`pb-score` nightly (06:15 UTC) with the bearer read from vault. Decay is inside scoring, so
one job covers both.

---

## 5 · The page (web/index.html)

One self-contained file, the Client Book pattern: `@supabase/supabase-js@2` from a CDN,
publishable key `sb_publishable_Rwx3FbwsjnVFx9MUVQX0EA_wm2F52sC`, project
`https://sgagrmapuovnjwvgsxbp.supabase.co`, `signInWithOtp` magic link. Cannot be served
from `*.supabase.co` (HTML is downgraded to text/plain there); published on GitHub Pages from
`web/` by the workflow, which needs Pages enabled once and the Pages URL added to Supabase
Auth → URL Configuration.

Phase 1 scope (the acceptance test is "every seeded account shows its sources on one screen"):

- **Roster**: one row per account, sorted by `chase_rank_key`; columns: name, anticipated
  tier + confidence (the word *anticipated* printed, never omitted), qualification, ceiling,
  year-1 band, urgency, cell, flags, reason sentence. Filters: tier, status, flag, roster
  source. Every row shows "UNVALIDATED (PRO-8)" while the rubric says so.
- **Sheet** per account: sources (which systems have touched it, with dates), the four reads
  with their breakdown, the signal timeline, calls, deals, register entries, merge-queue items.
- **Write paths, RLS-enforced**: a rater adds a fact (key from the feature list, value,
  evidence label, source, evidence URL, observed date, stand-in checkbox); any signer raises a
  dispute or a proposal; the owner sets an override (tier, reason code, reason, expiry) and
  reviews merge-queue rows. Nothing on the page changes a read; the nightly run does.
- No bare numbers. Bands, tiers and sentences only. Dark/light aware, responsive.

---

## 6 · Explain

`explain/generate_method.ts` renders `docs/METHOD.md` from the rubric JSON (the Client Book
convention: the document is generated, and `method_test.ts` fails when it is stale).

---

## 7 · Deployment and access (Phase 0)

Everything deploys through the Supabase MCP from a session (`apply_migration`,
`deploy_edge_function`, `execute_sql`); the container has no egress to `*.supabase.co`, the
Cloudflare API, Pipedrive, Fathom or Apollo, so the brief's Cloudflare Workers target is
replaced by Supabase Edge Functions + pg_cron — the same single-system pattern the Client Book
uses. Secrets live in Supabase Vault (`pb_secret()` RPC, service role only) because the MCP
has no secrets-set tool.

| Access | State on 9 Sep | Who fixes it |
|---|---|---|
| Pipedrive API | **Auth fails** (MCP `get_pipelines` → "authentication failed"); roster source of truth (PRO-6) is unreadable | Brian / admin: regenerate the token or complete the OAuth grant |
| Fathom webhook | Creatable via the Briang-account MCP once the endpoint is deployed | this build |
| Fathom REST back-fill | Per-user key; MCP `list_meetings` with `calendar_invitees_domains` and `include_transcript` covers the back-fill in-session | this build (in-session), Brian for an admin key |
| Orbit | MCP only (Orbit 1.0 API not ready); reads happen in-session and post to pb-sync or SQL | this build |
| Apollo | MCP available; **no credits spent without a fresh confirmation** (2,573 lead credits left; direct-dial at 0 until 3 Oct) | Brian confirms a budget |
| Gmail inbound counts | MCP only; a collector job, not an edge function | later phase |
| GitHub Pages | Needs enabling once on the repo (Settings → Pages → GitHub Actions); repo is **public** | Brian |

---

## 8 · What is deliberately not built here

ML scoring · third-party intent ingestion · web-visitor de-anonymization · buying-committee
maps · a composite prospect score · manufactured urgency (research §13). Also not in Phase 1:
Pipedrive write-back, the Slack digest, the seven-field extraction run, the potential snapshot
job, the lift analysis (blocked on the pre-signing harvest, PRO-8), the Phase 4 bridge that
moves the 95 Client Book rows (PRO-13/14) and the promotion UI (PRO-18) beyond the table that
will hold it.
