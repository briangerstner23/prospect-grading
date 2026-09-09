# How a prospect is graded

> Generated from core/rubric.prospect.v0.1.json. Do not edit by hand.
> Regenerate with `node --experimental-strip-types explain/generate_method.ts`.
> `explain/method_test.ts` fails the build if this file is out of date, so what you
> read here is what the engine actually does — not what someone once wrote down.

**Rubric:** WLIQ Prospect Book — anticipated grade, rank and band · **Version:** 0.1.0 · **Status:** DRAFT · **Created:** 2026-09-09

Every anticipated grade is produced by a pure function of stored inputs:

```
grade(features, rubric, options) -> scorecard
```

No network, no clock, no randomness, no AI judgment anywhere in the scoring path. The
same inputs and the same rubric version always produce the same grade. Every rule that
fires is written into the scorecard's trace with its inputs and its basis, so a reader
can re-derive the tier by hand. **Unknown is never evidence:** a missing input never
fires a gate, an adjustment or a warning — it raises a flag instead.

---

## 1 · What the grade is for — and what it is not

**Ruling.** PRO-0 (2026-09-04): who we chase first, and how much this is worth pursuing.

**It is explicitly not:**

- A gate on who we say yes or no to.
- A prediction of what the company will be like to work with once they sign.

The instrument outputs a RANK (an anticipated tier plus a chase-order key) and a BAND (PRO-16). It never outputs a single composite number.

**Architecture.** PRO-17 (2026-09-09): an independent system from the Client Book. Connects at promotion only.

**Promotion.** PRO-10: an agency with an invoice is an Agency Partner; without one it is a prospect. PRO-18: a person confirms the match at the first invoice; the confirmation, the person and the date are recorded. PRO-9: prospect-era facts cross the seam as a dated prior and never overwrite a first-hand client judgment. The anticipated tier never becomes a client tier.

## 2 · Validation stamp: UNVALIDATED

Every scorecard under this version carries the stamp **UNVALIDATED**. It is a statement about the instrument, not about the prospect.

**Rule.** PRO-8 (pre-registered 2026-09-04): rank agreement (Spearman rho) >= 0.5 on the 31 retrodictable clients, scored as prospects on facts dated before their first invoice. Below 0.5 the grade ships stamped UNVALIDATED and may not be the sole basis for a decision. A grade is never withheld for failing; it is labelled.

**Measured so far.** Tier reached vs year-one dollars on the cohort: rho = 0.270, CI [-0.142, 0.647] (PROSPECT_PHASE0 §15). The pre-signing harvest has not run, so PRO-8's literal test is unrun. Every scorecard under this version prints UNVALIDATED.

**Sizing pass mark on bands:** not yet set. Owed since PRO-16: a mark on BANDS (does the true year-one land inside the stated band at the stated rate), set against a naive baseline with the transformation disclosed, before the fit is looked at.

## 3 · Vocabulary

Three words print beside every tier, and none of them is optional:

- **anticipated** — this is a prospect's tier, a forecast of fit, never a client tier.
- **confidence** (High / Medium / Low) — how good the inputs behind it are (§8).
- **UNVALIDATED** — the instrument's validation stamp (§2), until the rule there is met.

**Tiers** (worst to best): **Bronze** → **Silver** → **Gold** → **Platinum**.

PRO-1r (2026-09-04): same words as clients. Every prospect tier prints the word 'anticipated' and its confidence; prospect rows never sit in a client table without that label. Supersedes the July High / Medium / Low and retires the Tier 1 Opportunity Book's Platinum / Black / Gold.

**Ceilings** (how big the relationship could become): **Project** → **Embedded** → **Partner**. Older lists used other words for the same three rungs:

| Older word | Ceiling |
|---|---|
| A job | Project |
| Seat at the table | Embedded |
| Partnership | Partner |

**Urgency** (coldest to hottest): **Cold** → **Warm** → **Hot** → **Super Hot**.

The July Stage 4 words are kept as the display of a COMPUTED value (research §7). A stated timing fact wins over the computation.

## 4 · Gates — operational filters, run first

July Stage 0, kept as the frame under PRO-15 ('keep the structure, test each piece as data arrives'). The July ledger records the gates AS WRITTEN as never ruled, so each is a toggle with its basis stated. PRO-0: a gate is an operational filter, not what the grade is for — the grade is still computed and stored for a parked row; only the status changes.

A gate has one of three **modes**: `park` (a fail sets the row's status to Parked), `flag` (a fail only raises a flag) or `off` (not evaluated). **An unknown input never parks and never flags.** Gates run in this order:

| # | Gate | Test | Input | Fails when | Mode | Basis |
|---|---|---|---|---|---|---|
| 1 | **Service shape** | The need is Core or Complement to what WLIQ sells. Off parks. | `service_shape` | `Off` | **park** | `unruled_default` |
| 2 | **Economic floor** | Accepts real rates, at or above the floor. | `economics` | `fail` | **park** | `unruled_default` |
| 3 | **Broker character** | Fair in scoping, negotiation and treatment of expertise. | `broker_character` | `flag` | **flag** | `reasoned` |
| 4 | **Geography** | Inside the territories WLIQ serves. | `geography_ok` | `no` | **off** | `reasoned` |

**Service shape.** Seed values map as follows:

| Seed value | → `service_shape` |
|---|---|
| Core | Core |
| Adjacent | Complement |
| Neither | Off |
| Unknown | unknown |

**Economic floor.** Floor **$2,000**, read as **deal_size** (options: `deal_size`, `hourly_rate`). Whether the >= $2K floor is about the hourly rate or the deal size is unruled since July (prospect_rulings still_open). deal_size is the default reading; the engine derives economics = fail when deal_size_estimate is stated and below the floor, or hourly_rate_accepted is explicitly false, and never from absence.

**Broker character.** PRO-2r (2026-09-07): character is NOT a grading input. PRO-2r-a is open: does it survive as a safety gate that never scores? Until ruled it is a FLAG only — visible, never scoring, never parking. Switch mode to 'park' if the owner rules the safety valve in.

**Geography.** Added by the 9 Sep research brief; no ruling. Off until a territory list exists.

## 5 · Fit (Dimension B): the ICP class

**Ruling.** PRO-2r: 'Is it work we're good at' — service shape, economics, ICP fit. Classifications and facts, zero character judgments.

**Source.** 🧬 ICP Definitions & SQL Classification (2026-04-05, 185 client records). Kept verbatim under PRO-15.

**A stated class wins.** A stated icp_class fact (Notion 'ICP class', or a rater's classification) is used as-is with its evidence label. The flow runs only when no class is stated. If both exist and disagree the stated class stands and the row carries the flag 'ICP disagrees with derivation'.

When no class is stated, the flow below runs top to bottom and the first test that passes names the class. If no test passes the row is **Unclassified**.

| Step | If | Then |
|---|---|---|
| 1 | `is_agency == false OR agency_type == direct_end_client` | **ICP-6** |
| 2 | `agency_type == consultancy` | **ICP-5** |
| 3 | `agency_type == full_service AND headcount >= 11 AND revenue_band in [5-10M, 10-25M, >25M]` | **ICP-1** |
| 4 | `agency_type == full_service (otherwise)` | **ICP-2** |
| 5 | `agency_type in [boutique, digital_only, niche_vertical] AND vertical_depth == deep_single_vertical` | **ICP-4** |
| 6 | `agency_type in [boutique, digital_only, niche_vertical] (otherwise)` | **ICP-3** |

**The six classes**, kept verbatim from the definitions document:

| Class | Name | Employees | Revenue | WL signal | Typical ticket | July priority |
|---|---|---|---|---|---|---|
| **ICP-1** | Established Full-Service Partner | 11–50 (some 25–100) | $5–10M | High | $10–50K | A |
| **ICP-2** | Ambitious Growing Agency | 1–50 | $1–5M | High | $5–25K | A- |
| **ICP-3** | Lean Boutique Operator | 1–10 | <$1M to <$5M | High to Very High | $2–10K | B+ |
| **ICP-4** | Niche Vertical Specialist | 11–50 | $1–25M | Medium | $5–20K | A- |
| **ICP-5** | Strategic Consultant / Fractional CMO | 1–10 | <$1M to $5–10M | High | $5–15K | B |
| **ICP-6** | Direct End-Client | any | any | n/a | varies | varies |

**ICP-6.** PRO-4 (2026-09-04): in scope, flagged 'Direct-to-client', excluded from agency-only fit weights. The 9 Sep research recommended removal; the ruling stands.

## 6 · Base tier from the ICP class

The July Stage 1 mapping (ICP-1/2/4 → High · ICP-6 → Medium · ICP-3/5 → Low) restated on PRO-1r's four words: High → Gold, Medium → Silver, Low → Bronze. Platinum is never a base; it is EARNED by the platinum_rule below, mirroring the client engine's top-tier gate ('a high-revenue / weak-partner account can't buy Platinum'). Basis: `unruled_default`.

| ICP class | Base tier |
|---|---|
| **ICP-1** | **Gold** |
| **ICP-2** | **Gold** |
| **ICP-4** | **Gold** |
| **ICP-6** | **Silver** |
| **ICP-3** | **Bronze** |
| **ICP-5** | **Bronze** |

## 7 · Named adjustments

**Ruling.** July Stage 2, ruled by the owner 2026-07-09: named rules only, every adjustment logged, bumps cap at ONE grade total, ever. The named rules AS WRITTEN were never ruled; each is a toggle with its basis.

Each rule moves the base tier **one rung** in its direction and is logged with its inputs whether or not it fired. The net movement is capped at **+1** upward and **−1** downward, however many rules fire. Adjustments never reach **Platinum** — that tier is earned only by the platinum rule (§8). A rule whose inputs are unknown does not fire.

Basis of the downward cap: reasoned — symmetry with the ruled bump cap; research sizes negatives to matter but a tier ladder has no finer unit than one rung.

| Rule | Name | Direction | Fires when | Basis | Source | Agency-only |
|---|---|---|---|---|---|---|
| **ADJ-WL** | High white-label signal on a boutique or consultant | ↑ up 1 | `icp_class in [ICP-3, ICP-5] AND wl_signal in [Very High, High]` | `unruled_default` | July Stage 2 | yes |
| **ADJ-REF** | Referral from the owner / AMI / BABA network | ↑ up 1 | `referral_from_network == true` | `unruled_default` | July Stage 2; research §3: a warm path is one of the strongest inputs | no — applies to direct rows too |
| **ADJ-ICP3-FLOOR** | Boutique clears the $10K project floor and already outsources | ↑ up 1 | `icp_class == ICP-3 AND avg_project_size >= 10000 AND already_outsources == true` | `reasoned` | Research §Fit: profitability cliff at $5K; keep ICP-3 only where average project is $10K or more and they already outsource | yes |
| **ADJ-RECUR** | Recurring or retainer model | ↑ up 1 | `recurring_revenue_share >= 0.25` | `reasoned` | Research: 51% vs 40% consistently profitable | yes |
| **ADJ-NICHE** | Niche or vertical positioning | ↑ up 1 | `niche_positioning == true` | `reasoned` | Research: narrowed agencies grow ~2x | yes |
| **ADJ-AMPM** | Account management separate from project management | ↑ up 1 | `am_pm_separated == true` | `reasoned` | Research: fast-grower trait | yes |
| **ADJ-BADGE** | Platform partner badge | ↑ up 1 | `platform_partner_badge == true` | `reasoned` | Research: badges require real managed volume | yes |
| **ADJ-PEER** | Peer-network membership | ↑ up 1 | `peer_network_member == true` | `reasoned` | Research: referral-driven category | yes |
| **ADJ-AI** | AI-positive posture | ↑ up 1 | `ai_posture == positive` | `reasoned` | Research: the pivot's tailwind | no — applies to direct rows too |
| **ADJ-ICP4-UNPROVEN** | Niche specialist in an unproven vertical | ↓ down 1 | `icp_class == ICP-4 AND icp4_vertical_proven == false` | `unruled_default` | July Stage 2 | yes |
| **ADJ-TINY** | Under 8 people, owner does everything | ↓ down 1 | `(headcount != null AND headcount < 8) AND owner_does_everything == true` | `reasoned` | Research: can't fund $35K+/yr | yes |
| **ADJ-INHOUSE** | Large agency with an in-house dev team | ↓ down 1 | `headcount >= 40 AND inhouse_dev_team == true` | `reasoned` | Research: contractor reliance 11% → 6% | yes |
| **ADJ-DEVSHOP** | Development-archetype agency | ↓ down 1 | `dev_archetype == true` | `reasoned` | Research: competitor and price-sensitive buyer | yes |
| **ADJ-SHRINK** | Shrinking agency | ↓ down 1 | `shrinking == true` | `reasoned` | Research: headcount down, BD turnover, dormant marketing | yes |

**Agency-only rules.** PRO-4: direct-to-client rows (relationship_type == direct or ICP-6) are excluded from agency-derived rules. ADJ-REF and ADJ-AI still apply to them. The agency-only set is: `ADJ-WL`, `ADJ-ICP3-FLOOR`, `ADJ-RECUR`, `ADJ-NICHE`, `ADJ-AMPM`, `ADJ-BADGE`, `ADJ-PEER`, `ADJ-ICP4-UNPROVEN`, `ADJ-TINY`, `ADJ-INHOUSE`, `ADJ-DEVSHOP`, `ADJ-SHRINK`.

## 8 · The platinum rule, and confidence

**Platinum** is never a base tier and no adjustment reaches it. A row earns it only when **all** of the following hold (basis `reasoned`):

| Requirement | Why |
|---|---|
| `adjusted_tier == Gold` | top base band |
| `potential.ceiling == Partner` | Partner ceiling with climb evidence (headroom ≥ $100K band or stated Partner, and at least one climb signal) |
| `qualification.present_count >= 3` | the deal is real: at least three of money, authority, timing, specification present |

Research tier table: Tier 1 = Fit A or B, ceiling Partner with at least one climb signal. Under PRO-0 the top of the chase order must be both the best fit and the biggest real deal; a Gold that is not yet real ranks below a Gold that is.

**Fit confidence** prints beside the anticipated tier. Rules are tried in order; the first that matches wins (basis `reasoned`):

| Confidence | When |
|---|---|
| **High** | `icp_class_label == evidence AND qualification.present_count >= 3` |
| **Medium** | `icp_class_label in [evidence, inferred] AND qualification.present_count >= 1` |
| **Low** | otherwise |

Confidence prints beside every anticipated tier (PRO-1r). It is about the INPUTS, not about validation — validation is a separate stamp (PRO-8).

## 9 · Qualification (Dimension A): is the deal real?

**Ruling.** PRO-2r: 'Is the deal real' — money, authority, timing, specification. Facts a salesperson has or does not have; mostly a CRM read.

Four facts. Each is **present**, **absent** or **unknown** — a fact, never a judgment:

| Fact | Test | Where the evidence lives |
|---|---|---|
| **money** | A stated budget, or a quote issued. | PandaDoc or Orbit quote · a budget figure recorded in the CRM |
| **authority** | Someone who can say yes, and we have met them. | who attended the calls · who is named on the proposal · who is copied on the quote |
| **timing** | There is a date. | the urgency stamp / a stated timeline |
| **specification** | They can say what they need in enough detail to quote it. | the brief · the RFP · the proposal · the quote |

The count of facts **present** gives the qualification label:

| Label | Facts present |
|---|---|
| **Qualified** | at least 4 |
| **Partly qualified** | at least 2 |
| **Conversation** | at least 0 |

**Minimum facts present before a tier is published: 0.** OPEN (prospect_rulings still_open): how many of the four must be present before a prospect can be ranked. Default 0 — the tier is always published with the qualification label beside it, because a skip is a real answer. Raise this to hide tiers on 'Conversation' rows once the owner rules.

Seed values from the intake list map to the four facts as follows (a rater's entry supersedes them):

| Fact | Seed property | Mapping | Note |
|---|---|---|---|
| **money** | Gate: can afford us | Yes → present; No → absent; Unknown → unknown | — |
| **authority** | Key decision maker? | Yes → present; No → absent; Unknown → unknown | — |
| **timing** | Lead priority | Super Hot → within_1_week; Hot → within_1_month; Warm → within_3_months; Cold → no_timeline | — |
| **specification** | Active project / immediate need? | Yes → present; No → absent; Unknown → unknown | Approximation flagged at seed: an immediate need is not a written scope. Treated as inferred. |

## 10 · Potential: how big could it get?

**Ruling.** PRO-16 (2026-09-05): a rough band is enough; the point estimate is dropped. Headroom method from the client-grading-system skill, locked; vendor rank from the Wallet Allocation Rule (research §Potential).

Potential answers with three labels — a **ceiling**, a **headroom band** and a **year-one band** — and a confidence. The raw headroom number stays in the trace for audit and is never shown on the page.

### 10a · Headroom

```
headroom = wallet * winnable_share - trailing_12m_revenue, where wallet = headcount * revenue_per_head * outsourceable_share * serviceable_share
```

**Revenue per head** by archetype (default archetype **blended**; a computed value below **$120,000** per head is warned about in the trace). Basis: locked headroom method; Promethean $163K avg, SPI $168K.

| Archetype | Revenue per head |
|---|---|
| **production** | $150,000 |
| **blended** | $175,000 |
| **strategy** | $200,000 |

**Outsourceable share** by white-label signal (default **20%** when the signal is unknown). Basis: locked headroom method (WL meter Low/Medium/High → 10/20/30%).

| WL signal | Outsourceable share |
|---|---|
| **Very High** | 30% |
| **High** | 30% |
| **Medium** | 20% |
| **Low** | 10% |

**Serviceable share:** default **50%**. Reasoned — the skill derives it from service mapping; until that pack exists half of a blended agency's outsourceable menu is assumed to map to WLIQ's eleven service families.

**Winnable share** from vendor rank (the Wallet Allocation Rule):

```
winnable_share = (1 - our_rank / (n_vendors + 1)) * (2 / n_vendors)
```

| Our rank | Winnable share |
|---|---|
| #1 of 2 | 0.667 |
| #1 of 3 | 0.5 |
| #2 of 3 | 0.333 |

When rank or vendor count is unknown the default is **0.5**. Reasoned — '#1 of 3'; the two discovery questions (who else do you use, where do we rank) replace it.

**Headroom bands** (basis: research tier table: Tier 1 headroom ≥ $100K, Tier 2 $35K–100K) and the ceiling each proposes:

| Headroom band | Edges | Proposed ceiling |
|---|---|---|
| **≥ $100K** | $100,000 and up | **Partner** |
| **$35K–100K** | $35,000 to $100,000 | **Embedded** |
| **< $35K** | under $35,000 | **Project** |

When headroom cannot be computed (headcount unknown) a sales-stated ceiling stands in, treated as inferred.

### 10b · Climb evidence caps the ceiling

The ceiling may not exceed Project without at least one observed climb signal (July Stage 3; the July ledger records this as never ruled; kept under PRO-15). Basis: `unruled_default`. A ceiling held down by this rule carries the flag "Ceiling capped: no climb evidence".

| Climb signal | Also written as |
|---|---|
| **2nd person engaged** | `multi_thread` |
| **Strategy question asked** | `strategy_shaped_question` |
| **2nd project scoped** | `second_project_scoped` |
| **Referred someone** | `refers_others` |
| **Structural break** | `structural_trigger_event` |

### 10c · Year-one band

Year one is a **band, never a figure**. When a quote exists its amount picks the band (basis `quote`); otherwise the ICP prior band below is used (basis `icp_prior`); with neither, the band is unknown.

| Year-one band | Edges |
|---|---|
| **≥ $100K** | $100,000 and up |
| **$46K–100K** | $46,000 to $100,000 |
| **$16K–46K** | $16,000 to $46,000 |
| **$6K–16K** | $6,000 to $16,000 |
| **< $6K** | under $6,000 |

Basis of the anchors: fitted anchors — retrodiction cohort year-one billings, n = 31 (PROSPECT_PHASE0 §14.4, 2026-09-05): Q1 $5,898 · median $16,318 · Q3 $46,151; $100K is the Tier-1 partner threshold. The July prior table ($145K/$73K/$55K/$43K/$27K/$22K) is retired as biased high (§14.5 C1).

**ICP prior band** (used only without a quote). Basis: reasoned from cohort tier medians (Platinum $43,956 · Gold $20,374 · Silver $10,012 · Bronze $5,538, n = 31) and the ICP-definition ticket midpoints ($6K/$15K/$30K). Unfitted per ICP; labelled so.

| ICP class | Prior year-one band |
|---|---|
| **ICP-1** | **$16K–46K** |
| **ICP-2** | **$16K–46K** |
| **ICP-4** | **$6K–16K** |
| **ICP-3** | **$6K–16K** |
| **ICP-5** | **$6K–16K** |
| **ICP-6** | **$6K–16K** |

### 10d · Potential confidence

| Confidence | When |
|---|---|
| **High** | `headcount_label == evidence AND wl_signal != null` |
| **Medium** | `headcount_label == inferred OR (headcount == null AND stated_ceiling != null)` |
| **Low** | otherwise |

Basis: locked headroom method: High if headcount is evidence (LinkedIn, site, Clutch), Medium if inferred, Low if guessed.

**Snapshot at signing** (later phase). Fields `p10_12m`, `p50_12m`, `p90_12m`, `p10_24m`, `p50_24m`, `p90_24m`, `p_35k_12m`, `p_100k_24m`, scored at 6, 12, 24 months. Phase 4. Frozen at first SOW, scored against Orbit and QuickBooks actuals; interval hit-rate, median error by estimator and ICP, Brier on the two binaries.

## 11 · Signals: are they moving now?

**Ruling.** Research §7 catalog; computed, not stamped by hand. Decay on behaviour only (MadKudu: weight * max(0, 1 - age_days / lifespan_days)). Fit never decays.

Each signal has a weight and a lifespan. Behavioural signals decay linearly to zero over their lifespan; signals marked *does not decay* count at full weight until the lifespan ends and then drop to zero. Age is measured against the scoring date passed in (`as_of`), never a clock.

```
weight_now = decays ? weight * max(0, 1 - age_days / lifespan_days) : (age_days <= lifespan_days ? weight : 0)
```

### 11a · Signal catalog

| Signal | Label | Weight | Lifespan | Decays | Strength | SLA | Also |
|---|---|---|---|---|---|---|---|
| `referral_warm_intro` | Warm intro or referral | 10 | 90 days | yes | strong | 48 h | — |
| `champion_job_change` | Past champion or contact moved to a new agency | 9 | 90 days | yes | strong | 72 h | — |
| `quote_requested` | Quote requested | 9 | 14 days | yes | strong | 8 h | — |
| `quote_sent` | Quote sent | 8 | 30 days | yes | strong | default | — |
| `orbit_verbally_accepted` | Quote verbally accepted (Orbit) | 8 | 30 days | yes | strong | default | — |
| `orbit_pa_sent` | Project agreement sent (Orbit) | 8 | 30 days | yes | strong | default | — |
| `orbit_pa_signed` | Project agreement signed (Orbit) — promotion pending | 8 | 60 days | no | strong | default | flag: PA signed — promotion pending (PRO-18) |
| `inbound_reply` | Inbound reply | 6 | 14 days | yes | strong_when_stacked | default | — |
| `meeting_accepted` | Meeting accepted | 6 | 14 days | yes | strong_when_stacked | default | — |
| `next_step_agreed` | Next step agreed on a call | 8 | 30 days | yes | strong | default | — |
| `new_client_win` | New client win or AOR announcement | 6 | 90 days | yes | medium_strong | default | — |
| `cluster_hiring` | Cluster hiring for developers or designers (3+ roles) | 5 | 56 days | yes | medium_two_sided | default | — |
| `freelance_dev_posting` | Freelance or Upwork dev posting by the agency | 6 | 60 days | yes | medium_strong | default | — |
| `service_mix_change` | Service-mix change | 4 | 90 days | yes | medium | default | — |
| `platform_tier_change` | Platform partner tier change | 4 | 90 days | yes | medium | default | — |
| `leadership_change` | New COO, ops director or head of delivery | 5 | 84 days | yes | medium | default | — |
| `owner_capacity_post` | Owner posts about capacity or hiring pain | 4 | 30 days | yes | medium | default | — |
| `peer_group_attendance` | Attends AMI, BABA, Agency Builders; joins a peer group | 3 | 365 days | no | medium | default | — |
| `review_award_relaunch` | Review velocity, award, website relaunch | 1 | 90 days | yes | weak | default | — |
| `neg_champion_left` | Champion left | -8 | 90 days | no | strong_negative | default | — |
| `neg_needs_to_figure_out` | 'We need to figure out…' | -5 | 90 days | no | strong_negative | default | — |
| `neg_no_decision_maker` | No decision-maker on calls | -5 | 90 days | no | strong_negative | default | — |
| `neg_dark_21_days` | 21+ days dark | -6 | 90 days | no | strong_negative | default | — |
| `neg_hiring_inhouse_dev_lead` | Hiring an in-house dev lead | -6 | 90 days | no | strong_negative | default | — |
| `neg_end_client_inhousing` | End client in-housing | -6 | 90 days | no | strong_negative | default | — |
| `prior_grade` | Prior grade from an earlier list or model | 0 | never expires | no | informational | default | Every letter grade from Gotham, the Tier 1 Book, the July wave, AMIN, Pittsburgh or the Cold Pool is kept as this signal with its source. It never scores. |
| `manual_note` | Peer-group or conference intel entered by hand | 2 | 90 days | yes | weak | default | — |

### 11b · Urgency

**A stated timing fact wins.** When the timing fact is present it sets urgency directly:

| Stated timing | Urgency |
|---|---|
| `within_1_week` | **Super Hot** |
| `within_1_month` | **Hot** |
| `within_3_months` | **Warm** |
| `no_timeline` | **Cold** |

Otherwise the **decayed total** of live signals climbs this ladder (the first rung the total reaches, from the top). With no signals at all the row is **Cold** with basis `none`.

| Urgency | Decayed total at least |
|---|---|
| **Super Hot** | 15 |
| **Hot** | 8 |
| **Warm** | 3 |
| **Cold** | -999 |

Basis: reasoned — thresholds to be re-cut where the staircase breaks once outcomes exist.

### 11c · Routing: when a signal becomes a task

One strong signal (weight >= 8) or two medium signals (weight >= 4) inside a 30-day window creates a task with an SLA; a single medium signal is a note; weak signals only update the profile.

| Setting | Value |
|---|---|
| Window | 30 days |
| Strong signal | weight ≥ 8 |
| Medium signal | weight ≥ 4 |
| Default SLA | 120 hours |

A task's SLA is the signal's own (catalog column above) or the default; it is due that many hours after the signal was observed. Basis: research §7 routing rule.

## 12 · Deal health: are we winning?

**Ruling.** Research §Read 4: rules, not a model. Gong-style warnings with thresholds from WLIQ's own stage medians once Pipedrive is readable; defaults below until then.

Computed **per open deal**; a row with no deals has no deal-health read and its reason sentence says nothing about it. A deal is **red** if any red rule fires, else **yellow** if any yellow rule fires, else **green**. Stage medians default to **21 days** until WLIQ's own are known. **An unknown field never warns.**

**Red when any of:**

| Rule | Test | Warning shown |
|---|---|---|
| **DH-DARK** | `days since last buyer-initiated touch >= 21 AND no next meeting booked` | 21+ days without a buyer touch and nothing scheduled |
| **DH-PUSHES** | `close_date_pushes >= 3 OR largest_push_days > 21` | Close date pushed three times or once by more than three weeks |
| **DH-STALLED** | `days in stage > 2 * stage median` | Stalled in stage at more than twice WLIQ's median |
| **DH-NO-DM** | `decision_maker_engaged == false AND calls_held >= 2` | Two or more calls and no decision-maker has attended or replied |
| **DH-INDECISION** | `indecision_level == high OR (risk_words_present == true AND next_meeting_at == null)` | High indecision language with no next step |

**Yellow when any of:**

| Rule | Test | Warning shown |
|---|---|---|
| **DH-QUIET** | `days since last buyer-initiated touch between 14 and 20` | Two weeks quiet |
| **DH-PUSHED** | `close_date_pushes between 1 and 2` | Close date has moved |
| **DH-NO-NEXT** | `next_meeting_at == null` | No next meeting booked |
| **DH-NO-PRICE** | `price_discussed == false AND calls_held >= 2` | Price not discussed by the second call |
| **DH-THIN** | `buyer_contacts_30d < 2` | Fewer than two buyer contacts engaged |
| **DH-VELOCITY** | `buyer_email_velocity_7d == 0` | No buyer email this week |
| **DH-NO-CRITICAL** | `critical_event_captured == false AND calls_held >= 2` | No critical event captured (SPICED) |

Enforced both in Pipedrive required fields and here, because API writes bypass Pipedrive's checks (R6). Phase 3.

## 13 · Override contract

**Ruling.** PRO-5 revision (2026-09-04): override authority sits with the owner alone. July (ruled): one grade max, written reason required.

| Term | Value |
|---|---|
| Who may override | the **owner** lane only |
| How far | at most **1** tier from the computed tier |
| Reason code | **required**, one of `data_wrong`, `relationship_known`, `timing_known`, `conflict`, `other` |
| Written reason | required |
| Default expiry | 90 days |
| Beyond the cap | refused — the engine rejects an override more than one tier from the computed tier rather than applying it |
| Recorded in the register | yes |

An override is applied only when the approver and a reason code are both present. A refused override leaves the computed tier standing and raises the flag "Override refused: beyond one-tier cap". An override nearing its expiry raises "Override expires soon".

**Raters.** PRO-5: the two sales raters enter facts on their own rows; the owner may stand in, recorded AS a stand-in. Per-rater calibration is a first-class output; for a rater with few rows report an interval and say plainly when history is too thin.

Under PRO-2r there are no judgment scales — raters enter FACTS with evidence. Attribution still matters: every fact carries entered_by, stand_in and observed_at.

## 14 · Status precedence

Evaluated in this order; the first that applies is the row's status: **Parked** → **Unclassified** → **Overridden** → **Ranked**. A parked or unclassified row is still graded and stored — only its status differs.

| Status | When |
|---|---|
| **Parked** | any gate with mode park has result fail |
| **Unclassified** | icp_class is null after the classification flow |
| **Overridden** | an override with reason_code and approver is set and within the cap |
| **Ranked** | otherwise |

## 15 · Chase order

**Ruling.** PRO-0: ordering is the job. Rows sort by these keys in turn, best first; the **cell** shown on the page is the anticipated tier × the ceiling.

| Order | Key |
|---|---|
| 1 | effective_tier (Platinum first) |
| 2 | qualification.present_count (4 first) |
| 3 | urgency (Super Hot first) |
| 4 | year1_band (largest first) |
| 5 | name |

## 16 · Flags

A flag warns and never caps (Client Book principle carried over). Every flag is a displayed signal and an action cue.

- Anticipated
- UNVALIDATED (PRO-8)
- Direct-to-client
- Roster source uncertified
- Lapsed client
- Service shape unknown
- Economics unknown
- Broker character flag
- ICP disagrees with derivation
- Headcount unknown
- Ceiling capped: no climb evidence
- PA signed — promotion pending (PRO-18)
- Prior grade differs
- Stand-in entry
- Override expires soon
- Conversation only

## 17 · The reason sentence

The page shows the sentence and the breakdown, never a bare number.

```
Anticipated {tier} ({confidence}): {icp_class} {agency_type_words}, {qualification words}; ceiling {ceiling} on {headroom_band or 'unknown headroom'}, year one likely {year1_band}; {urgency} — {top signal or 'no live signal'}.
```

## 18 · Still open in this version

Each of these is a toggle in the rubric with its current default stated; none is a new ruling.

- PRO-2r-a — broker character as a safety gate (gate mode is 'flag' until ruled).
- How many Dimension A facts must be present before a prospect can be ranked (min_facts_to_publish_tier = 0 until ruled).
- Is the ≥ $2K economic floor about the hourly rate or the deal size (floor_basis = deal_size until ruled).
- Who performs the promotion confirmation under PRO-18 (owner lane until ruled).
- The sizing pass mark on bands (PRO-16).
- The five July elements the July ledger records as never ruled: gates as written, ICP → grade mapping, adjust rules as written, climb-evidence requirement, Grade × Ceiling output shape. All five are toggles here.

---

*Generated from the rubric. If this document and the engine ever disagree, the
generator is broken — the rubric is the single source of both.*
