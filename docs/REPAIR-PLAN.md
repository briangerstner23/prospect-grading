# Repair plan — Prospect Book, from the 17 Sep version point

**Version point: commit `e20b702` on `claude/amazing-mayer-umftf0`** (tag `snapshot-2026-09-17`
exists locally; the remote refused the tag ref, so quote the SHA). Its companion document is
`docs/STATE-SNAPSHOT-2026-09-17.md` — what was actually running, measured from the database.

Paste one prompt per session (the external handoff carries the same text plus document locations). They are ordered. Items 1–5 are about eighteen hours and close
every foundation break; item 6 is half a day and is the only thing that can ever tell you whether
the book is right.

---

## STANDING PREAMBLE — paste this at the top of every prompt below

> Before you start: read `docs/STATE-SNAPSHOT-2026-09-17.md`. It is the version point (commit
> `e20b702`) and it records what is ACTUALLY running, measured from the database, because on
> 17 Sep `docs/PHASE0.md`, `docs/METHOD.md` and `CLAUDE.md`'s own layout section each described a
> system that was not running. Do not trust a document's claim about the live system without
> re-deriving it — `CLAUDE.md` names files that are stale; run `ls` and query
> `pb_rubric_versions` and `supabase_migrations.schema_migrations` yourself.
>
> The rule this repo is adopting: **nothing is activated that does not have a file, and nothing
> has a file that is not tested.** If your work applies anything to the database, the migration
> file lands in the same commit. If it activates a rubric, the rubric file lands in the same
> commit and a golden fixture pins it.
>
> Finish by updating the matching row in `docs/RESEARCH-CONFORMANCE.md` and its expected value in
> the fenced JSON block, then run `npm test`. That check is symmetric — it fails when you close a
> gap without saying so, exactly as it fails when one reopens. Never delete a row to go green.
> Anything that is a ruling rather than a build gets a numbered section in `docs/DECISIONS.md`.

---

## 1 · Reconnect Fathom — do this first, it is the only ongoing loss

*Executed 17 Sep — DECISIONS §30. Webhook created; proof pending first external delivery.*

> Fathom has never delivered to this system. Verified: all 990 rows in `pb_webhook_inbox` carry
> `user-agent: pg_net/0.19.5` and fall inside the 13–14 Sep `prospect_book_fathom_backfill*`
> window — this database posting to its own endpoint. **Zero rows have ever carried a Fathom user
> agent.** The Pipedrive rows, by contrast, carry `user-agent: Pipedrive Webhooks`. The newest
> `pb_calls.held_at` is 11 Sep 2026. Calls held since then with real prospects are not in the book.
>
> `docs/PHASE0.md` A3 previously claimed the webhook was created in the UI on 12 Sep and cited
> those 988 deliveries; that claim is corrected in the version-point commit. Assume the webhook
> must be built and proved from scratch. Do not assume any prior step worked.
>
> Work it in this order. First establish whether a webhook exists on the Fathom side at all —
> `PB_FATHOM_API_KEY` is in Vault for exactly this (operator-only, reads `api.fathom.ai` from
> `pg_net`; RUNBOOK §4). List the webhooks. If one exists, compare its destination URL, its four
> include flags and its `triggered_for` against what `pb-fathom-webhook` expects, and check the
> stored `PB_FATHOM_WEBHOOK_SECRET` still matches its signing key. If none exists, create it.
>
> The ONLY acceptable evidence that this works is a row in `pb_webhook_inbox` carrying a Fathom
> user agent, `verified = true`, that becomes a `pb_calls` row with attendees. A test post from
> `pg_net` proves nothing — that is exactly the evidence that produced the false Pass.
>
> Then back-fill 11–17 Sep. Fathom recorded meetings on 16 Sep, several with external prospect
> domains. Use the REST path that already exists rather than writing a new one, and make it write
> a `pb_runs` row so the gap is visible in the record.
>
> Finally correct `docs/PHASE0.md` A3, P0-2 and P1-4 to Pass **with the new evidence quoted**, and
> add a `docs/DECISIONS.md` section on what actually went wrong, because a status document that
> lied for five days is the more important finding.

---

## 2 · Reconcile the missing ruling into the active rubric

*Executed 17 Sep — DECISIONS §31. 0.1.4 active; preview 829/0 changed.*

> **Read `docs/STATE-SNAPSHOT-2026-09-17.md` §1 first — this is subtle and the snapshot has the
> table.**
>
> The active rubric `0.1.3` is `0.1.1` plus the §20 ceiling change. It does **not** contain
> DECISIONS §17, the 14 Sep owner ruling on climb evidence. §17 exists only in
> `core/rubric.prospect.v0.1.2.json`, a registered draft with zero reads.
>
> Two live consequences. The two signals §17 retired as logically impossible for a prospect —
> "2nd project scoped" needs a first project, "Referred someone" needs a delivered outcome — are
> collectable again. And `ingest/notes_sweep.ts` may propose `Champion identified` and
> `Future-state language`, which the active rubric does not recognise: **the extractor and the
> engine disagree about what a climb signal is**, so facts collected tonight cannot be used by the
> engine scoring tonight.
>
> Produce `0.1.4` as a file first, carrying §17's signal set, its `lift_requires {strong: 1,
> weak: 2}` and its retired list, on top of 0.1.3's `caps_ceiling: false`. Then preview it
> (`?rubric=0.1.4&preview=1`) and report the diff before activating anything.
>
> Two things to get right. Because §20 set `caps_ceiling: false`, climb evidence no longer gates
> the ceiling — so establish and state whether `lift_requires` still changes any tier, or whether
> it now only affects what is traced and printed. Say which, with numbers, rather than assuming.
> And check `ingest/resolve_features.ts`'s alias mapping against the new signal list in both
> directions, so a fact already written under either vocabulary still resolves.
>
> Activate only after the preview is reported. The file, the `pb_rubric_versions` row and a golden
> fixture pinned to `0.1.4` all land in the same commit.

---

## 3 · Write down the 33 migrations that are running

*First half executed 17 Sep — DECISIONS §32: the 4 pre-16-Sep migrations filed verbatim from `schema_migrations.statements`. The 29 boards migrations wait on decision 2; their SQL is saved externally.*

> 64 Prospect Book migrations are applied to the database; 31 `.sql` files are on disk. **33 are
> running with no file.** They are listed by name in `docs/STATE-SNAPSHOT-2026-09-17.md` §2.
> Filenames on disk do not share timestamps with applied versions, so match by name, never by
> version number.
>
> This is transcription, not design. For each unfiled migration, recover its DDL from the database
> — `pg_get_functiondef` for functions, `pg_get_viewdef` for views, `information_schema` plus
> `pg_indexes` for tables — and write it to `supabase/migrations/` using the applied version as
> the filename timestamp so ordering is preserved. Do not improve anything as you go; if
> something looks wrong, note it in the commit message and leave it alone.
>
> **Everything from `prospect_book_research_log` (16 Sep) onward is a second system** — boards, an
> MDM registry, contact events, a chase score — built entirely in the database with no file, no
> test and no decision entry. That group is blocked on the owner's decision about whether the
> boards stay or go. Transcribe the pre-16-Sep group first and stop; ask before transcribing the
> boards.
>
> One of them, `pb_chase_scores`, is a summed composite scoring −18..123 across 146 rows, against
> the founding rule that the four reads are never summed. Do not delete it. Write it down, and
> raise it as a `docs/DECISIONS.md` question: is it a deliberate exception, or does it go?
>
> After each file lands, verify it reproduces the live object — compare the recovered definition
> against the database, do not assume your transcription is faithful.

---

## 4 · Build the three reconciliation checks and turn on CI

*Executed 17 Sep — DECISIONS §34. `pb_reconcile_state()` + `scripts/reconcile.ts` + `.github/workflows/ci.yml`. The deploy job waits on `SUPABASE_ACCESS_TOKEN` as a repository secret (owner).*

> This is the item that makes everything else permanent. `docs/RESEARCH-CONFORMANCE.md` has a
> `RECON-checks-unbuilt` row recording that these do not exist.
>
> Every break in the 17 Sep audit was invisible to both the requirements ledger and the phase
> tests, because both compare documents to code and none of them compares **what is declared to
> what is running**. You already own the pattern twice: `scripts/sync_shared.sh --check` fails the
> build when a copy drifts from its original, and `scripts/conformance_test.ts` fails it when the
> ledger stops matching the code. Neither is pointed at the database.
>
> Build `scripts/reconcile.ts`, run from CI rather than from `npm test` since it needs network:
>
> 1. **Rubric drift.** Fetch the active row's `spec` from `pb_rubric_versions` — the table has
>    **no fingerprint column**, so compute it with `fingerprint()` from `core/engine.ts`, the same
>    function every `pb_reads` row uses (0.1.3 → `909b3747`, verified against all 829 reads on
>    17 Sep). Require that some file in `core/` produces that fingerprint AND that
>    `docs/RESEARCH-CONFORMANCE.md`'s `active_rubric` block pins it AND that at least one golden
>    fixture carries `expected["<version>"]`. This single check
>    would have caught eight of the audit's findings.
> 2. **Migration drift.** List `supabase_migrations.schema_migrations`, filter to ours, and fail on
>    any applied migration with no file. Match by name.
> 3. **Source liveness.** For each declared source, assert the newest row is younger than a stated
>    budget, and require the evidence to be an *external* delivery where one applies — a Fathom
>    row whose user agent is `pg_net` must not count as Fathom being alive. That is the check that
>    would have caught this on 14 Sep instead of on the 17th.
>
> Then add a GitHub Action that runs `npm test` on push, **and that builds and deploys the edge
> functions from `scripts/build_functions.sh` with the Supabase CLI and a stored access token** —
> so a deploy is a reproducible build of a commit, never an 81KB bundle hand-carried through the MCP.
> Its first job was pb-score: v8 was behind source by the 17 Sep rule-9 fix (ledger row
> `RECON-pb-score-bundle-behind-source`) — closed the same day by v9, deployed as a one-line
> entrypoint pinned to commit `c467352` (RUNBOOK §3), which is what the CI deploy should also do. The suite is good and currently entirely
> voluntary; making it mandatory is a twenty-line file. Run `reconcile.ts` on a schedule too, since
> the database can drift without anyone pushing.

---

## 5 · Pin the active rubric with a fixture and repoint METHOD.md

> `fixtures/golden.json` holds 25 fixtures and **every one pins rubric 0.1.0, which is retired**.
> `npm test` passes 17/17 against a rulebook nothing runs. `explain/generate_method.ts` generates
> `docs/METHOD.md` from a file rather than from whatever is active, so METHOD.md has been
> describing a rubric that is not grading anything.
>
> The mechanism is already there: `core/engine_test.ts` holds a `RUBRICS` map keyed by version
> (it loads 0.1.0 and 0.1.2 today), and each fixture's `expected` is an object keyed by version —
> every one of the 25 has only an `"0.1.0"` key. Add the active version to the map and add an
> `expected["<active>"]` scorecard to at least one fixture (0.1.4 if item 2 has landed, else
> 0.1.3), chosen to exercise what actually differs between it and 0.1.0 — the ceiling rule and the
> climb-evidence handling — rather than a case both versions score identically. Then repoint the
> METHOD.md generator at the file that item 4's first check now guarantees matches production, and
> regenerate. `explain/method_test.ts` fails when METHOD.md is stale, so this closes itself.
>
> Do not retire the 0.1.0 fixtures. `docs/BASELINE.md`'s frozen baseline still reproduces
> byte-identically over 680 rows and that property is worth keeping.

*Executed 17 Sep — DECISIONS §35. Fixture half in §31 (PB04, PB20 pinned on 0.1.4); METHOD.md regenerated from 0.1.4; `ACTIVE-method-source` in the conformance test fails if the generator's default and the ledger's active file ever differ again.*

---

## 6 · Start writing potential snapshots tonight

> `pb_potential_snapshots` has the full designed schema — `p10/p50/p90` at 12m and 24m,
> `p_35k_12m`, `p_100k_24m`, `assumptions`, `actual_6m/12m/24m`, `brier` — and **zero rows**.
> Nothing writes it. It is requirement R4 of the 9 Sep research and Phase 4 of the build brief,
> and it is the only mechanism that can ever tell you whether the grade predicts anything.
>
> This is high on the list for one reason: the clock starts the day you start. Every night you do
> not write a snapshot is a night of evidence you cannot recover later.
>
> Add one insert to the scoring function, for every ranked account, recording the current
> p10/p50/p90 and the two threshold probabilities with the estimator and the as-of date. Do not
> build the 6/12/24-month scoring pass yet — just start accumulating. Keep it inside the existing
> run so a failure shows up in `pb_runs`.
>
> One design question to settle before writing code, not after. The brief says freeze "at first
> SOW", which is a Client Book event — a prospect has not invoiced, and this repository may never
> import the Client Book's keys or read its tables (PRO-17). Work out how a snapshot gets frozen
> at the promotion boundary without crossing it, and put the answer in `docs/DECISIONS.md` before
> you build. The nightly accumulation does not depend on that answer; the freeze does.

*Executed 17 Sep — DECISIONS §36 (the freeze is a selection at `pb_promotions.first_invoice_at`; actuals come from Orbit/QuickBooks, never the Client Book). pb-score upserts one row per ranked account per day per estimator; migration 20260917110000 is the key. The 6/12/24-month scoring pass is not built, and the ledger says so (`R4-scoring-pass-absent`).*

---

## Track B · Standards alignment — runs ALONGSIDE the repairs, read-only

*Owner's direction, 17 Sep: the foundation is not to be invented. The book must rest on the
field's best-established model, tuned to WLIQ; every divergence must be a deliberate, recorded
tuning. This track produces the evidence for that. It changes no parameter until the foundation
repairs (items 1–6) are done; its findings then drive the four open rulings.*

*Run on Fable 5.1 at effort `max`, one long session. This is the best single use of Fable in the
project: long-horizon, many sources, judgment about what is settled versus vendor-written.*

> Read `docs/HANDOFF-2026-09-17.md` §1 for the goal and `docs/DECISIONS.md` §29 for the state.
> This is READ-ONLY research: you change no rubric, no engine code and no data. Your output is
> one document and one proposal.
>
> The owner's direction: prospect and account grading is a well-studied field, and he does not
> want to reinvent it. He wants the book to rest on the industry's best-established model —
> the platinum standard, drawn from the whole field's expertise — personalised to WLIQ. Every
> place the book diverges from that standard must be a deliberate, recorded tuning to his needs,
> never an accident of iteration. Your job is to find out, component by component, which it is.
>
> You are not starting from nothing. The 17 Sep audit's §4 (in the handoff, embedded in full)
> already compared ten practices where WLIQ is ahead and twelve where it is behind, with sources.
> The 9 Sep research document (external; the owner holds it) cites ~80 sources and marks each as
> independent, academic or vendor. The rubric labels every threshold's `basis` as `reasoned` or
> `unruled_default` — none is `ruled`. Build on all three; do not re-derive verified facts.
>
> Cover every component of the instrument: the gates and knockouts; the fit read (attribute
> choice, equal versus fitted weights at low n, the criteria the research named that were never
> built); potential (the wallet formula, the Wallet Allocation Rule applied to prospects rather
> than customers, interval calibration, Brier scoring, back-testing on 50–100 deals); signals
> (decay, half-lives keyed to cycle length, routing of strong versus weak signals); deal health
> (SPICED versus MEDDPICC at this deal size, Gong-style warnings, thresholds from the seller's own
> stage medians, stage-exit criteria); scoring mechanics (never summed, a reason on every score,
> thresholds cut where the staircase breaks, a scarce top band); governance (model definitions in
> version control, a registry, champion–challenger, SR 11-7-style validation, drift monitoring,
> audit trails for overrides); and adoption (plays with owners and SLAs, write-back to where the
> team works). For each: the established practice, who established it and on what evidence —
> say plainly whether that evidence is independent, academic or a vendor's own data — what WLIQ
> does today (rubric path or file:line), and one verdict: matches, ahead, behind, deliberately
> diverged (cite the `docs/DECISIONS.md` section that records the divergence), or **diverged by
> accident** (no record anywhere). The last category is the one that matters most to him.
>
> Be honest about the three kinds of knowledge. Settled and not to be relitigated (mechanical
> combination beats holistic judgment; equal weights beat fitted at low n; fit and engagement are
> different axes; behaviour decays and fit does not; a few hundred outcomes before fitting).
> Empirical and local, with no external truth (every threshold, band edge and pass mark — these
> come from the seller's own conversion data, which WLIQ does not yet have). And unknown to
> anyone (whether any prospect grade predicts revenue for a white-label development shop). Do
> not present the second or third kind as the first.
>
> Deliver `docs/STANDARDS.md` — one section per component, a table per section, aggregate
> figures only and no agency names (rule 2) — ending with a ranked list of every accidental
> divergence that needs a ruling, each with the standard it would align to and the WLIQ-specific
> reason that might justify keeping the divergence. Then PROPOSE, do not apply, an additive
> `standard_source` field beside `basis` on each rubric entry, showing three worked examples.
> Finally flip the `STD-standards-doc-absent` row in `docs/RESEARCH-CONFORMANCE.md` and run
> `npm test`.

*Executed 17 Sep on Fable 5.1 — `docs/STANDARDS.md`. Eight components, two accidental divergences found (A1: the research's ICP-3 profitability floor was implemented as a +1 bonus; A2: Platinum outnumbers Gold since §20 removed the climb cap, and no ruling accepts that distribution). Both are one rubric edit and a preview away once ruled. The `standard_source` field is proposed with three worked examples, not applied. Ledger: `STD-standards-doc-present`, `STD-standards-doc-shape`, `STD-accidental-divergences-open` (equals 2).*

---

## Blocked on you, not on a session

1. **RULED 17 Sep (DECISIONS §37): the page is the 16 Sep Prospect Board, made live.** ~~Is the page the working surface, or are the boards?~~ It is currently neither — the page has
   never been written to (0 overrides, 0 promotions, ever), and last week's work happened on
   boards the page cannot see. Blocks items in prompt 3 and the whole of Phase 3.
2. **RULED 17 Sep (DECISIONS §37): they stay; file the 29 migrations; `pb_chase_scores` deferred.** ~~Do the 16 Sep boards, briefs and chase scores stay or go?~~ Either they are the product and
   need migrations, tests and a ruling, or they are an experiment and should be deleted. Leaving
   them where they are is the only genuinely bad option. Blocks prompt 3's second half.
3. **RULED 17 Sep (DECISIONS §37): yes, at release, with plain-language questions and an entry page.** ~~Is there ever a second rater?~~ 2 owners, 0 raters. The blind test and per-rater calibration
   are blocked on someone other than you. If the answer is nobody, strike them from the plan
   rather than carrying them as debt.
4. **RULED 17 Sep (DECISIONS §40): no — broker character stays a flag and never parks.** ~~Does the gate bite?~~ Broker character is a flag, geography is `off`, and you park 7 of 829.
   Outside practice attributes real win-rate lift to disqualification that actually disqualifies.
   Free to decide, and it changes what the book is for.

5. **RULED 17 Sep (DECISIONS §40): `main`, pushed from this line of work; the owner sets it in GitHub.** ~~Which branch is the repository's default?~~ It is `claude/new-session-8qkstx` today, and all of
   17 Sep's work is on `claude/amazing-mayer-umftf0`. Two things depend on the answer and neither
   is a session's to fix: GitHub fires `schedule` triggers only from the default branch's workflow
   file, so the six-hourly reconcile has **never run** (only the on-push one has); and the deploy
   job is gated to the default branch by design. Make this branch the default, or merge it there.
   Found 07:10 UTC on 17 Sep when the 06:17 schedule did not fire.
