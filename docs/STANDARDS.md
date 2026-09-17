# Standards alignment — how the Prospect Book compares to the field, component by component

*Track B of `docs/REPAIR-PLAN.md`. Written 17 September 2026 on Fable 5.1, read-only: no rubric,
engine or data was changed to produce this. ADVISORY — the Grading Register governs (CLAUDE.md
rule 1). Aggregate figures only; no agency is named.*

**The owner's direction (17 Sep):** prospect and account grading is a well-studied field and the
book must not reinvent it. It should rest on the field's best-established model, tuned to WLIQ,
and every place it diverges from that standard must be a *deliberate, recorded* tuning — never an
accident of iteration. This document finds out, component by component, which it is.

**What it rests on.** Three things already done, not re-derived here: the 9 Sep research (~150
sources read, ~80 cited, each tagged independent / vendor data / vendor claim / WLIQ data — the
owner holds it; its ten requirements are tracked in `docs/RESEARCH-CONFORMANCE.md`); the 17 Sep
audit's practice comparison (ten places ahead, twelve behind, two deliberate divergences —
`docs/HANDOFF-2026-09-17.md`); and the active rubric's own `basis` labels
(`core/rubric.prospect.v0.1.4.json`: 28 labelled entries — 17 `reasoned`, 6 `unruled_default`,
3 `locked` (the headroom method), 1 `research`, 1 `ruled`). Every "WLIQ today" cell below names a
rubric path or a file so it can be checked; every count is from `pb_current_reads` on 17 Sep
(850 accounts: 615 ranked, 225 unclassified, 10 parked).

## 0 · Three kinds of knowledge, kept apart

The whole document depends on not confusing these.

| Kind | What it covers | How to treat it |
|---|---|---|
| **Settled** — not to be relitigated | Mechanical combination beats holistic judgement (Grove et al. 2000, 136 studies, *independent*). Equal weights beat fitted weights when outcomes are few (Dawes 1979, *independent*). Fit and engagement are different axes and must not be summed (Forrester; HubSpot; Marketo; 6sense — *independent* + *vendor data*, and the decision-science literature on matrices vs scorecards). Behaviour decays, fit does not (MadKudu, HubSpot — *vendor practice*, uncontested). A few hundred closed outcomes before fitting anything (every published vendor floor: 120–400; Riley et al. BMJ 2020 for the statistics — *independent*). Reps ignore scores they cannot explain (Pedowitz, Pocus, MadKudu — *practitioner*, uncontested). | Match it. Where WLIQ matches, stop arguing about it. |
| **Empirical and local** — no external truth exists | Every threshold, band edge, weight, lifespan, pass mark and gate value. The field agrees on *how* to set these (from the seller's own conversion data, cut where the staircase breaks) and has nothing to say about *what* they are for a white-label development shop. | Label the current value's origin honestly (`reasoned`, `unruled_default`, fitted-to-cohort) and build the loop that will replace it with a measured one. Do not import a number from a SaaS vendor's dataset as if it were yours. |
| **Unknown to anyone** | Whether any prospect grade predicts revenue for a white-label development shop selling to agencies. No published dataset exists. PRO-8's own measurement so far: rank agreement ρ = 0.270, CI [−0.142, 0.647], n = 31 — consistent with "some signal" and with "none". | The only instrument that can answer it is the calibration loop (§36 started it on 17 Sep). Every scorecard prints UNVALIDATED until PRO-8's test is run and passed. |

The rest of this document says, for each component, which of these three kinds the standard
belongs to, so that "behind" on a *settled* point and "behind" on a *local* number are not read
as the same finding.

## 1 · Gates and knockouts

**Established practice.** Two or three disqualifiers run before any scoring and park the account
whatever it scores; negatives inside the score are sized to matter. Every serious design has it
(Forrester's fit-first waterfall — *independent*; 6sense's AND-gate — *vendor data*; Breadcrumbs —
*vendor data*, which attributes a ~40% volume cut and a ~22% win-rate lift to disqualification that
actually disqualifies). The *existence* of gates is settled; *which* gates and *where the bar sits*
are local.

| Aspect | Standard (who; evidence) | WLIQ today | Verdict |
|---|---|---|---|
| Gates run first, park with a reason, grade still computed | Forrester, 6sense, Breadcrumbs | `gates.evaluation_order`, `status_rules.Parked`; the grade is computed and stored for a parked row (PRO-0) | **matches** |
| Unknown never parks | Decision-science hygiene; no vendor states it | `gates.unknown_never_parks: true`; engine `evaluateGates` | **ahead** — most products treat a blank as a fail |
| The gates bite | Breadcrumbs (*vendor data*) | 10 of 850 parked. `broker_character` mode `flag` (PRO-2r-a open), `geography` mode `off` (no territory list), `economics` parks only on an explicitly stated fail or a stated deal size below $2K (`gates.items.economics`), `service_shape` parks on `Off` only | **deliberately deferred, recorded** — PRO-2r-a and the floor-basis question are open rulings in the register; `docs/REPAIR-PLAN.md` decision 4 asks the owner directly. Not accidental. |
| A profitability floor on small shops is a *gate* | The 9 Sep research (§Fit, from The Admin Bar 2026, n = 622, *independent*): "keep ICP-3 only where average project is $10K or more and they already outsource" — i.e. exclude the rest | `dimension_b.adjustments.rules[2]` `ADJ-ICP3-FLOOR`: the same condition, implemented as a **+1 adjustment** when met, nothing when not. A floor became a bonus. Its `source` text quotes the research's floor language while its `direction` is 1. No DECISIONS entry records the flip. | **diverged by accident** — A1 below |

## 2 · Fit

**Established practice.** Four to six observable attributes per axis, near-equal weights, plus
disqualifiers (Prospeo, Breadcrumbs — *practitioner*/*vendor data*; Dawes for the weights —
*independent*, settled). Weights re-cut from the seller's own lift on a holdout once outcomes
exist (Ignacio — *practitioner*; the published data floors — *vendor data*). Fit never decays; it
is refreshed. Which attributes carry weight for a white-label dev shop is local; the agency
research (Promethean, SoDA, Agency Core, SparkToro — *independent*) says which are worth testing.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Fit is a separate read, never summed with engagement | Forrester, HubSpot, Marketo; matrix-vs-scorecard literature | Four reads, `what_the_grade_is_for.consequence`: rank + band, never a composite | **matches / ahead** (four reads, not two) |
| 4–6 attributes, equal weight | Dawes; Prospeo | **0.1.4 (active):** base tier from a six-way ICP map (`dimension_b.base_tier_from_icp`, `unruled_default`) then **14** adjustment rules capped at net ±1 rung (`net_cap_up/down`). **0.2 (draft):** six observable criteria, one point each, bands 5+/3+/0 (`base_tier_from_fit`, DECISIONS §8) | **deliberately in transition, recorded** — §8 retires ICP as the fit read; 0.2 matches the standard exactly. Until 0.2 activates, 14 rules exceed the "4–6" guidance, but the ±1 cap (ruled, July) bounds what they can do. |
| Attributes chosen from evidence | Promethean, Agency Core, SoDA (*independent*) | 0.1.4's ADJ rules carry the research's own attribute list (recurring model, niche, AM/PM split, badges, peer network, AI posture, tiny/in-house/dev-shop/shrinking negatives), each with a `source` line | **matches** |
| Weights from own lift, checked on a holdout | Ignacio; every vendor floor | Not run. Decision 3 in DECISIONS §1 chose equal weights first; no outcomes to fit yet (2 won, 67 lost, 31 retrodictable) | **behind, recorded** — correct posture at this n; the loop that will change it is §36 |
| Direct end-clients in an agency book | The research recommended removal | Kept, flagged, excluded from agency-only rules — PRO-4 (2026-09-04) | **deliberately diverged, recorded** — register ruling |
| Fit refreshed on a rhythm, ≤20% churn per quarter | Winning by Design (*practitioner*); Breadcrumbs' rebuild trigger | Facts arrive from sweeps and webhooks continuously (rule 8, §9); no quarterly refresh job, no churn cap | **behind (not built)** — an operations gap, not a method divergence |
| Confidence printed beside every tier | PRO-1r (WLIQ's own rule); the field's "explain every score" | `dimension_b.confidence.rules`: High needs an evidence-labelled ICP and ≥3 Dimension A facts. **Today: 0 accounts at High, 468 Medium, 157 Low, 225 unclassified.** | **matches the standard; the data does not yet earn the top label** — observation, not a divergence |

## 3 · Potential

**Established practice.** Key-account literature has had a potential axis for thirty years
(McDonald & Woodburn — *independent*). Wallet estimated top-down from headcount × revenue per head
× outsourceable share (Bain; SPI benchmarks — *independent*). The Wallet Allocation Rule ties share
to rank among vendors (Keiningham et al., HBR 2011, ~17,000 *existing customers* — *independent*).
Calibration: record the estimate at decision time, score it later; untrained 90% intervals hit
about 70% (Hubbard — *independent*). Estimate *and* calibrate is settled; every anchor is local.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Headroom = wallet × winnable share − trailing revenue | Bain; the `client-grading-system` skill's locked method | `potential.headroom`, `revenue_per_head_usd` (Promethean/SPI anchors, `locked`), `outsourceable_share_by_wl` (`locked`), `serviceable_share_default 0.5` (`reasoned`) | **matches** |
| Wallet Allocation Rule for winnable share | Keiningham 2011 — derived on customers who could state a vendor rank | `potential.winnable_share`: applied to *prospects*; rank almost never known → default "#1 of 3" (0.5). `default_basis: reasoned`. DECISIONS §18 records what a vendor count means and why the default stands | **deliberately diverged, recorded (§18)** — and untested: the two discovery questions replace the default only when a call captures them |
| Capacity, not payroll, sizes the wallet | Revenue per head is benchmarked per delivery person | `delivery_headcount` preferred over `headcount` (DECISIONS §21) | **ahead** — a refinement the benchmarks imply but do not state |
| Year-one and headroom kept as two side-values | Forrester's Account Opportunity; Murphy's "ascension potential" | `year1_band` (quote, else ICP prior) and `headroom_band` are separate; the ceiling comes from headroom | **matches** |
| Year-one anchors fitted to own data | The field says: from your own outcomes | `year1_bands_basis`: cohort quartiles, n = 31 (Q1/median/Q3); the July prior table retired as biased high. `year1_icp_prior_band` per ICP is `reasoned`, labelled unfitted | **ahead on the anchors** (fitted), **honest on the priors** (labelled) |
| Ceiling needs climb evidence | The 9 Sep research §Potential ("make the ceiling earn its name"); KAM "willingness to invest" | `climb_evidence.caps_ceiling: false` since 15 Sep — evidence is computed and traced, it does not cap size. The five signals and the strong/weak lift bar are §17 | **deliberately diverged, recorded (§20)** — the owner's reasoning ("Project is a size; cold is a behaviour") is written down with the number it moved (139 accounts). Its *consequence* for scarcity is A2 below. |
| Snapshot at signing, score at 6/12/24 months, Brier + hit-rate | Hubbard; decision-journal practice; the research's R4 | Nightly snapshots since 17 Sep (§36): p10/p90 = band edges, p50 null, probabilities null. Scoring pass **not built**; ledger `R4-scoring-pass-absent` | **matches in shape, behind in the loop — recorded** |
| Interval honesty | Hubbard: intervals start too narrow | p10/p90 are the rubric's band edges, not a judged interval; the 90%-interval question cannot be asked until an estimator produces one | **not yet applicable** — noted so it is not forgotten when p50 arrives |

## 4 · Signals

**Established practice.** A catalog with weight, lifespan and provenance per signal; decay on
behaviour only (MadKudu's `weight × (1 − age/lifespan)` — *vendor practice*); half-lives keyed to
the seller's cycle (a quarter to a third of it — *practitioner* norm); trigger events and warm
paths outrank bought intent (Gartner, Elias, Schmitt et al. — *independent*; 6sense, UserGems —
*vendor data*); route strong signals to a human with an SLA, let weak ones only update the
profile (Hunter, MIT lead-response — *vendor data*/*independent*). The catalog structure and the
decay shape are settled; every weight and lifespan is local.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Decay formula | MadKudu | `signals.decay_formula`, verbatim, with `as_of` an input so any run replays | **matches / ahead** (replayable) |
| Fit never decays | MadKudu, HubSpot | Facts carry no lifespan; only `pb_signals` decay | **matches** |
| Negatives carry real weight and do not quietly fade | The research ("downgrade, don't just decay"); Breadcrumbs | Strong negatives −5 to −8 against strong positives +8 to +10; `decays: false` on the five strong negatives | **ahead** — an asymmetry no vendor documents |
| Lifespans keyed to cycle | Practitioner norm 30–45 days for a 90–120-day cycle; the research's per-signal table | Catalog lifespans 14–365 days, per signal, following the research's own table (quotes 14, PA 30, referral 90, peer group 365). WLIQ's cycle length is **unmeasured** (`deal_health.default_stage_median_days 21` is a placeholder) | **matches the table; the cycle it should key to is unknown** — local number, honestly labelled |
| Routing: strong → task with SLA; two mediums → task; one medium → note; weak → profile | The research's routing rule (from Hunter + MIT) | `signals.routing` implements exactly this (`strong_min_weight 8`, `medium_min_weight 4`, `window_days 30`, per-signal `sla_hours`) | **matches** |
| Warm path is one of the strongest inputs | Schmitt et al.; Promethean; SparkToro (*independent*) | `referral_warm_intro` weight 10, the catalog maximum, 90-day lifespan, 48 h SLA; `ADJ-REF` +1 in fit | **matches** |
| Do not buy third-party intent | The research (IP resolution fails < ~250 employees) | None bought; Apollo's included topics are the ceiling; ledger "do not build" honoured 6/6 | **matches** |
| Coverage of behavioural signals | — | 1,479 signals on 643 accounts, of which **1,149 are `prior_grade`** (weight 0, informational). Live behavioural signals: 113 inbound replies, 87 warm intros, 73 quotes lost, 11 sent, 6 requested. Urgency: 610 Cold, 178 Warm, 47 Hot, 15 Super Hot | **observation** — the read works; the feed is thin. Fathom is attached to 721 of 994 calls; the sweep is the lever. |
| Stated timing beats the computed urgency | The research: replace the hand stamp with a computed value | `signals.urgency.stated_timing_wins: true` — a stated timing *fact* (Dimension A's "there is a date") outranks the decayed total. Recorded in the rubric's `urgency_note`, not in DECISIONS | **deliberately diverged, recorded in the rubric only** — the `standard_source` field (§9) is where this belongs |

## 5 · Deal health

**Established practice.** Rules, not a model, at this deal size (Gong's configurable warnings —
*vendor practice*; the research's R6). Thresholds from the seller's own stage medians. A light
qualification record on every deal — SPICED at $10–50K services deals (Winning by Design —
*practitioner*; Ebsta's 4.2M-opportunity dataset — *vendor data*), MEDDIC elements only above
~$35K/yr. The Gong findings that feed the rules (next step, decision-maker, price by call 2, email
velocity, multi-threading, indecision language) are large but SaaS and *vendor data*; Dixon's
JOLT indecision finding is *independent*. Stage-exit criteria enforced in the tool *and* the CRM.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Rules, not a model; every threshold in `params`, none in prose | Gong; the research | `deal_health.red_when_any` (5) / `yellow_when_any` (7), `params_note`; engine `DEAL_PARAM_NAMES` refuses a rule with a threshold only in its `test` text | **matches / ahead** (the prose-vs-params guard) |
| The warning set | Gong's eight: no activity, ghosted, overdue close, not enough contacts, no decision-maker, price never mentioned, red-flag language, stalled in stage | DH-DARK, DH-QUIET, DH-PUSHES/PUSHED, DH-THIN, DH-NO-DM, DH-NO-PRICE, DH-INDECISION, DH-STALLED, DH-NO-NEXT, DH-VELOCITY, DH-NO-CRITICAL | **matches, plus SPICED's critical event** |
| Thresholds from own stage medians | The research R6 | `default_stage_median_days 21`, `stage_median_days` per deal accepted but never supplied; 163 deals in `pb_deals` | **behind, recorded** (ledger R6) — a local number awaiting measurement |
| Unknown never warns | Decision-science hygiene | `deal_health.unknown_never_warns: true`; `next_meeting_note` distinguishes "no meeting" from "not read" | **ahead** |
| SPICED as the shared record; MEDDIC-lite above $35K | Winning by Design; Ebsta | Not adopted as a record. Dimension A (money, authority, timing, specification — PRO-2r) is the ruled qualification read; SPICED's *elements* appear as deal-health inputs (`critical_event_captured`, `indecision_level`, `risk_words_present`, `decision_maker_engaged`) and in the extractor's seven fields (`ingest/notes_sweep.ts`) | **deliberately diverged, recorded** — DECISIONS §1 decision 5 "not ruled; PRO-2r's Dimension A is the ruled read". The elements are there; the framework label is not. |
| Stage-exit criteria in tool and CRM | The research R6; Ebsta (skipped stages close 46% less — *vendor data*) | `stage_exit_criteria_note: "Phase 3"`; not enforced anywhere; `rubric.prospect.v0.3.json` (unregistered) carries a `stage_exit` block | **behind, recorded in the rubric** |
| Champion test above the partnership line | Force Management (*practitioner*) | `Champion identified` is a climb signal with MEDDICC's definition (§17), strong, in the extractor's vocabulary | **matches** |

## 6 · Scoring mechanics

**Established practice.** Gates first; four to six attributes; equal weights until lift shows a
2× separation; decay on behaviour; thresholds cut where the staircase breaks with a scarce top
band (Reform, 6sense deciles — *practitioner*/*vendor data*); a reason on every score; overrides
with a controlled vocabulary into a register, with an acceptance-rate KPI; versioned rubric with a
preview diff before activation (UserGems — *vendor practice*). "Never a bare number" is settled;
where the cuts fall is local.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Never a composite number; a reason on every score | Matrix-vs-scorecard literature; Pocus, Gong, HubSpot top factors | `reason_sentence.shape`; the page shows sentence + breakdown; every fired rule in the trace with its basis (`ruled` / `unruled_default` / `reasoned`) | **ahead** — the basis label per rule has no commercial equivalent |
| Thresholds cut where the staircase breaks; top band scarce | Reform; 6sense; the research §Scoring 5 ("the top band should convert at least twice the bottom") | No cut has ever been made from conversion (no outcomes yet). **Distribution today: Platinum 67, Gold 39, Silver 171, Bronze 348** — the top band outnumbers the one below it. Platinum = Gold base + Partner ceiling (`platinum_rule`, `reasoned`); the Partner ceiling reaches 143 accounts since §20 removed the climb-evidence cap | **diverged by accident** — A2 below. §20 is recorded; the inversion it produced is not, and nothing says whether it is acceptable |
| Equal weights until lift shows otherwise | Dawes | Decision 3; 0.2's six criteria are one point each | **matches** |
| Overrides: reason code, register, expiry, cap | The research §Scoring 7; Pocus inbox | `override.*`: owner lane, one tier max, five reason codes, 90-day expiry, refused beyond cap. **0 overrides ever**; 285 register rows, none `override` | **matches in design; unused** |
| Override acceptance-rate KPI (65–75% healthy) | The research §Scoring 7 (*practitioner*) | Absent. Nothing computes it; nothing to compute it on | **behind (not built)** |
| Versioned rubric, preview before activation | UserGems | `pb_rubric_versions`; `?rubric=<v>&preview=1` diffs tier/status/confidence across the book; 0.1.4 was activated after a 829/0-changed preview. (0.1.3 was activated **without** one — §29) | **matches, and now enforced** — "nothing is activated that does not have a file, and nothing has a file that is not tested" (§29), pinned by `scripts/conformance_test.ts` |
| Rebuild trigger: a band moves >10 points in four weeks, or positioning changes | Breadcrumbs (*vendor practice*) | Tier-movement views exist (migration 20260913060000); no threshold, no alert, no scheduled review of them | **behind (not built)** |
| Quarterly lift report; share of past wins in the top two cells (60–70%) | The research §Scoring 5 and R9 | Absent; the raw material is `pb_potential_snapshots` (from 17 Sep) and `pb_reads` history | **behind, recorded** (R9 in the ledger) |

## 7 · Governance

**Established practice.** Model definitions in version control (GitOps; Fed SR 11-7 change
management — *independent*/regulatory); a model registry; champion–challenger before promotion
(FICO — *practitioner*); independent validation with a pre-registered test (SR 11-7); drift
monitoring in production (credit-scorecard practice: population stability, conversion by band);
audit trails for every decision and override (EU AI Act Art. 12 — *regulatory*); regression
fixtures kept current with the deployed version (Breck et al., *The ML Test Score* — *independent*).
All of this is settled practice in regulated scoring; none of it is common in sales tooling.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Model definition in version control, deployed = committed | GitOps; SR 11-7 | Active rubric has a file whose engine fingerprint the ledger pins and CI checks against the database (§29, §34). pb-score is deployed as a commit (RUNBOOK §3). On 17 Sep the active rubric had **no** file (§29) | **was behind by accident; matches since 17 Sep** — and the check that keeps it so runs every 6 h |
| Reconciliation: declared vs running | ArgoCD/Flux drift detection | `pb_reconcile_state()` + `scripts/reconcile.ts` in CI, no secrets: active rubric four ways, migrations by name, source liveness, rule-9 agreement (§34) | **matches** (was the highest-value missing control on 17 Sep) |
| Executable requirements traceability | Safety-critical engineering; policy-as-code | `docs/RESEARCH-CONFORMANCE.md`'s JSON block runs on every `npm test`; closing OR reopening a gap fails the build | **ahead** — no commercial product has an equivalent |
| Pre-registered validation test | SR 11-7; PRO-8 | PRO-8: Spearman ρ ≥ 0.5 on 31 retrodictable clients, pre-registered 4 Sep; every card prints UNVALIDATED until it passes | **ahead** on pre-registration; **behind** on running it (the pre-signing harvest has not run) |
| Regression fixtures current with the deployed version | Breck et al. | 25 golden fixtures on 0.1.0 (kept — `docs/BASELINE.md`), 2 pinned on the active 0.1.4 since 17 Sep (§31) | **matches** (was behind: all 25 pinned a retired version) |
| Champion–challenger before promotion | FICO | The preview path; bypassed once (0.1.3), now a rule (§29) | **matches** |
| Drift monitoring on *outputs* (conversion by band, population stability) | Credit-risk scorecard practice | Absent; movement views exist, no PSI-style check, no conversion by band (no conversions yet) | **behind (not built)** |
| Audit trail: every read, every rule fired, every override | EU AI Act Art. 12; rules-engine practice | `pb_reads.scorecard` holds the full trace with basis per rule; `pb_register` for overrides; `pb_runs` for every run; `pb_potential_snapshots.assumptions` for every estimate | **ahead** |
| Human review queues stay drainable | MLOps HITL practice | `pb_fact_candidates` and `pb_identity_candidates`: **0 pending** on 17 Sep (a bulk reject on 14 Sep cleared a backlog that had reached ~30:1 intake-to-review) | **matches today; the mechanism that emptied it was a bulk action, not a rhythm** — adoption, §8 |
| A second rater; per-rater calibration | PRO-5 (WLIQ); inter-rater practice | `pb_members`: 2 owners, 0 raters. The Blind Test and per-rater calibration cannot run | **blocked on decision 3** (REPAIR-PLAN) — recorded |

## 8 · Adoption

**Established practice.** A grade only matters if someone makes a different decision because of
it. Tiers name a play with an owner and an SLA (Pocus playbooks — *vendor practice*; RAIN Group on
planning processes — *independent*); the score lives where the team works (write-back to the CRM,
a digest — HubSpot, UserGems, Common Room — *vendor practice*); a weekly data-first review (Ebsta:
weekly updating correlates with 17% more closes — *vendor data*); Tier 1 sized to what the pod can
plan against (Bain — *independent*). The failure mode is documented everywhere: a dashboard nobody
actions.

| Aspect | Standard | WLIQ today | Verdict |
|---|---|---|---|
| Tier → play, owner, SLA | Pocus; the research R7 | No plays, no owners on accounts, no SLA beyond the signal-routing tasks. `chase_rank_key` orders; nothing assigns | **behind, recorded** (ledger R7; REPAIR-PLAN decision 1) |
| Tier 1 sized to capacity (15–20) | Bain; the research decision 1 | Not ruled; 67 Platinum × Partner today | **blocked on decision 1** — recorded |
| Score where the team works (CRM write-back, digest) | HubSpot, UserGems, Common Room; the research R8 | Pipedrive is read (webhooks in); **nothing is written back**; no Slack digest. The page is public-read (§5) and has **0 writes ever** (0 overrides, 0 promotions) across every lane | **behind, recorded** (ledger R8) — and the audit's sharpest finding: reads healthy, writes zero |
| The working surface is decided | — | Page vs the 16 Sep boards: undecided; last week's work happened on boards the page cannot see | **blocked on decisions 1–2** — recorded |
| Weekly data-first review; monthly re-tier; quarterly rubric re-run | The research §Rhythm; Ebsta | Nightly score runs; no human rhythm is defined anywhere in the repo | **behind (not built)** |
| Routing cell is fit × *size* (tier × ceiling), not fit × *readiness* | Every outside grid crosses fit with engagement/readiness (HubSpot A1–C3, Marketo) | `cell` = tier × ceiling; readiness (qualification, urgency) is the second and third key of `chase_rank_key`, not part of the cell. PRO-0 ("who we chase first, how much it is worth") | **deliberately diverged, recorded** (PRO-0; DECISIONS §10 on the chase order) — and **untested**: nothing measures whether tier × ceiling orders better than tier × urgency would. The snapshots will eventually allow the comparison. |

## 9 · The accidental divergences — both ruled, 17 September 2026

"Accidental" meant: WLIQ does something different from the established practice and no ruling,
DECISIONS section or rubric note records the choice. **Two survived that test on 17 Sep, and both
were put to the owner the same day and ruled. Neither is accidental any more.** The table is kept
for the record; the ledger's `STD-accidental-divergences-open` now expects zero.

| # | Where | The standard | What WLIQ does | **Ruling (DECISIONS §40)** |
|---|---|---|---|---|
| ~~A1~~ | `ADJ-ICP3-FLOOR` + `FLAG-ICP3-BELOW-FLOOR` | The research's ICP-3 profitability floor: an exclusion below a $10K average project | Was a +1 bonus when met and silence when not | **RULED: flag it, do not park it.** Rubric 0.1.5 adds `dimension_b.flag_rules` raising "Below the small-shop project floor". The book ranks, it does not gate (PRO-0). Inert until `avg_project_size` is collected — zero facts on file today, which is also why the bonus never fired. |
| ~~A2~~ | `platinum_rule` × `caps_ceiling` | Cut thresholds from conversion; keep the top band scarce | Platinum 67 outnumbers Gold 39 since §20 | **RULED: Platinum is a SIZE label and need not be scarce.** Scarcity belongs to what the team plans against — the head of the chase order, Platinum **and** qualified, which `chase_rank_key` already produces. No threshold moved; the cut comes from outcomes when they exist. |

Two items were listed here as close to the line and *recorded* rather than accidental. One of them
has now also been ruled: **broker character** was an unruled default in `flag` mode; PRO-2r-a is
ruled (§40) and it stays a flag — a deliberate, recorded divergence from disqualification practice.
The other stands unchanged: **the Wallet Allocation Rule applied to prospects** (§18) is recorded,
untested, and still the softest number under Platinum — the first parameter to check when outcomes
exist.

## 10 · Proposal (not applied): a `standard_source` field beside `basis`

`basis` says whether a rule is `ruled`, `unruled_default` or `reasoned`. It does not say what the
field's practice is, who established it, how good the evidence is, or whether WLIQ matches it —
which is exactly the question the owner asked. The proposal is one additive, nullable object per
rubric entry that already carries `basis`. Nothing reads it (the engine ignores unknown keys), so
behaviour cannot change; `explain/generate_method.ts` could print it.

```json
"standard_source": {
  "practice":   "one sentence: the established practice this entry implements or departs from",
  "established_by": "who, and when",
  "evidence":   "independent | vendor_data | vendor_claim | practitioner | wliq_data | none",
  "knowledge":  "settled | local | unknown",
  "verdict":    "matches | ahead | behind | deliberate | accidental",
  "record":     "where the choice is written down, e.g. DECISIONS §20, PRO-4, or null"
}
```

Three worked examples, as they would sit in `core/rubric.prospect.v0.1.5.json`:

```json
"signals": {
  "decay_formula": "weight_now = decays ? weight * max(0, 1 - age_days / lifespan_days) : (age_days <= lifespan_days ? weight : 0)",
  "standard_source": {
    "practice": "Behavioural signals decay linearly to zero over a lifespan; fit never decays.",
    "established_by": "MadKudu likelihood-to-buy documentation; HubSpot percentage decay; practitioner norm since ~2018",
    "evidence": "practitioner",
    "knowledge": "settled",
    "verdict": "ahead",
    "record": "as_of is an input, never the clock (CLAUDE.md conventions); strong negatives do not decay (catalog)"
  }
}
```

```json
{
  "id": "ADJ-ICP3-FLOOR",
  "name": "Boutique clears the $10K project floor and already outsources",
  "when": "icp_class == ICP-3 AND avg_project_size >= 10000 AND already_outsources == true",
  "basis": "reasoned",
  "direction": 1,
  "standard_source": {
    "practice": "Small shops below a ~$5K project size are a profitability cliff; the research keeps ICP-3 only above a $10K floor with outsourcing already in place — an exclusion, not a bonus.",
    "established_by": "The Admin Bar 2026 WordPress agency survey (n = 622), via the 9 Sep research §Fit",
    "evidence": "independent",
    "knowledge": "local",
    "verdict": "accidental",
    "record": null
  }
}
```

```json
"winnable_share": {
  "formula": "(1 - our_rank / (n_vendors + 1)) * (2 / n_vendors)",
  "default_when_unknown": 0.5,
  "standard_source": {
    "practice": "Share of a customer's category spend is a function of the vendor's rank among the vendors they use (r ≈ 0.9 with actual share).",
    "established_by": "Keiningham, Aksoy, Buoye & Cooil, HBR 2011 — ~17,000 existing customers, nine countries",
    "evidence": "independent",
    "knowledge": "settled for customers; local (untested) for prospects, where rank is rarely known",
    "verdict": "deliberate",
    "record": "DECISIONS §18; rubric default_basis"
  }
}
```

**Why it must be a new version, not an edit.** The engine fingerprint (`fingerprint()` in
`core/engine.ts`) covers the whole spec, so adding `standard_source` to 0.1.4's file would break
the ledger's pin and CI on purpose — that is the pin working. The field arrives as 0.1.5, a new
file and a `pb_rubric_versions` row, previewed; the preview must show 0 changed, which is the proof
that the field is inert. The ledger's `active_rubric` block and `explain/generate_method.ts`'s
default move with it, and `ACTIVE-method-source` fails until they do.

## 11 · What this document does not do

It does not change a parameter, and it does not decide A1 or A2 — both are one rubric edit and a
preview away once the owner says which way. It does not re-derive the research's evidence tags; it
inherits them and says so. And it does not claim the field's numbers as WLIQ's: every "matches" on
a threshold above means the *method* of setting it matches, and the value itself remains local
and unmeasured until the loop that started on 17 Sep has outcomes to cut against.
