# How the book decides — the rubric, the weights and the rank, reviewed against the field

*Written 18 September 2026 from the running system: rubric 0.1.6 (fingerprint `9a911e2c`), the
830 live accounts, every current read, fact, signal and contact event, queried directly. ADVISORY —
the Grading Register governs (rule 1). Aggregate counts only, no agency named (rule 2). Nothing in
the book was changed to produce this, with one exception: a write-nothing preview of draft rubric
0.2.0 was run at 02:18 UTC (pg_net request 4220) so §5 could report what the six-criteria fit
read would produce today.*

*Status, 18 Sep 2026, 03:45 UTC (DECISIONS §52): D1, D3, D4, D6 and D7 are live in rubric 0.1.7 (fingerprint `dec7d291`, activated 03:37 UTC, 830 reads), and the twelve never-fired rules of D2 are parked in it. The criteria fit read (D2, D5) is draft 0.2.1, registered and previewed — 587 of 830 would be Unclassified today because only 239 accounts answer three of the seven criteria — and held until the collection sprint. The page is built and blocked on one repository setting. The numbers below describe the book as it stood on 0.1.6 the same morning; §8 reproduces them.*

The owner asked three questions. Is anything actually being graded, or is a lot of information
just sitting there? Is the method a proven science, or a wheel being reinvented? And what is this
kind of selling called, so that the right things get looked at. The answers, in order: yes, but
the grade adds almost nothing to what the CRM already says; the shape is the field's standard
shape, and one departure from it is the reason the board disappoints; and this is account-based
partner recruitment, which changes what the six most valuable facts are.

## 0 · The position

The machinery is the field's. Gates first, four reads never summed, fit that does not decay,
behaviour that does, a versioned rubric previewed before it activates, every fired rule traced with
its basis. Sales tooling rarely gets that far, and the governance around it (reconcile, conformance,
the register) is ahead of anything commercial.

The inputs are not. Stripped of the ceremony, the tier an agency carries tonight is a Pipedrive
dropdown translated into a tier word, plus one point for a referral, plus a headcount. The
qualification label is two more Pipedrive fields. The urgency is a third dropdown that never ages.
Fourteen adjustment rules exist and twelve have never fired, because the facts they read have never
been collected. The sales team's own High / Medium / Low grade in Pipedrive agrees with the engine's
tier 88% of the time, which is the cleanest statement of how much the engine currently adds.

The one design choice that departs from the standard is the sort order. The board is a strict
sort: size first, then everything else as a tiebreak. So the head of the board today is 46
Platinum accounts that are cold and unqualified, most never contacted, sitting above every
qualified, hot, engaged deal in Silver or Bronze (the first of those appears at rank 88). The field
does not sort; it puts potential on one axis and readiness on the other and names a play for each
cell. That is the change with the highest return and it is a rubric version plus a board change,
not a rebuild.

Nothing measures whether any of it predicts a signed agreement. The book holds 2 won deals, 67
lost, 31 retrodictable clients, and a rank correlation of 0.27 measured once. The loop that would
change that started accumulating on 17 September and has no scoring pass. Until it runs, every
number in the rubric is a labelled assumption, and the document says so honestly.

| The four numbers that carry the position | Value |
|---|---|
| Accounts whose base tier is a stated ICP label rather than an observation | 612 of 627 classified (98%) |
| Adjustment rules that have fired at least once, of 14 | 2 (referral 97 accounts, white-label 20) |
| Head of the prospect board that is cold, unqualified and Platinum (top 60) | 46 of 60 |
| Agreement between the engine's tier and Pipedrive's own Grade field | 512 of 584 (88%) |

## 1 · What the book actually decides today, stripped to the rule

Every row below is what the engine does with the facts it has, not what the rubric could do with
facts it does not have. Counts are from `pb_current_reads` and `pb_current_facts` on 18 Sep
(830 live accounts; 851 current reads because 21 merged records keep their last read).

### 1.1 · The effective decision rule

| Step | What the rubric says | What decides it today | Evidence |
|---|---|---|---|
| Gates | Park on service shape `Off` or an economics `fail` | Almost nothing: both inputs are unknown on 9 in 10 accounts and unknown never parks | 7 parked; `service_shape` on 78 accounts, `economics` on 60 |
| Base tier | ICP class → Gold (1/2/4), Silver (6), Bronze (3/5) | A Pipedrive custom field on the Client Journey card ("ICP-3: …"), or Notion's ICP column; the six-step derivation runs for 15 accounts | `icp_derivation`: stated 612, derived 15, none 224 |
| Adjustments | 14 named rules, net cap ±1 | Two rules ever fire: referral from the network (+1 on 97) and a high white-label signal on a boutique (+1 on 20). The other twelve read facts with zero rows | 111 accounts at +1, 0 at −1, 740 at 0 |
| Platinum | Adjusted Gold and a Partner ceiling | With the defaults the wallet is `headcount × $8,750`, so Partner means 12 or more people on record. Platinum today is "Gold-base ICP label and headcount ≥ 12" | 60 of 65 Platinums fit that rule exactly; the rest reach it through a bump |
| Qualification | Count of money, authority, timing, specification present | Two CRM fields: timing (the lead-temperature dropdown) and authority (a job title). Money and specification exist on 1 in 10 accounts | present: timing 408, authority 338, money 76, specification 70; 302 of 338 authority facts and 328 of 408 timing facts are read off Pipedrive |
| Urgency | Stated timing wins; else the decayed signal ladder | The same lead-temperature dropdown on 428 accounts, nothing on 413, the signal ladder on 10 | `urgency_basis`: stated_timing 428, none 413, computed 10 |
| Deal health | Twelve Gong-style warnings per open deal | Evaluated on the 28 accounts with an open pipeline deal | 28 accounts carry a deal-health read |
| Potential | wallet × winnable share − trailing revenue | Every term is a default except headcount: winnable 0.5 on 851 of 851, white-label share default on 94%, serviceable 0.5 | potential confidence High 3, Medium 481, Low 367 |
| Chase order | tier ↓, facts present ↓, urgency ↓, year-one band ↓, name | Size first; everything else breaks ties inside a tier | See §1.4 |

Two consequences are worth stating plainly. First, the ICP label itself was measured on 11 Sep at
r = −0.135 against observed fit (DECISIONS §8), and the owner retired it as the fit read that day;
the retirement lives in draft 0.2.0 and has never been activated, so the retired input still sets
98% of base tiers. Second, the classification that produced those labels admits agencies its own
definitions exclude: 72 of the 268 "ICP-3, 1–10 people" accounts with a headcount have more than
10 people, and 25 of the 31 "ICP-1, 11–50 people" accounts with a headcount have more than 40.

### 1.2 · Where the points live

The owner asked about "the pointing system". There are four, and they do different jobs.

| System | Where | Feeds | Who set the numbers | Accounts it moves today | Standing |
|---|---|---|---|---|---|
| Signal weights and lifespans (30 signal types, −8…+10, 14–365 days, linear decay) | rubric `signals.catalog` | urgency ladder (Warm 3 / Hot 8 / Super Hot 15); task routing | 9 Sep research catalog, basis `reasoned` | urgency on 10 accounts (stated timing wins elsewhere); tasks on 4 | live, mostly overridden |
| Chase weights (`chase-evidence-0.1`: quote open 50, replied ≤30d 40, ≤90d 25, quoted ≤180d 20, delivering 18, call 12, fading 8, multi-channel 6, never answered −5, dormant −10, CRM stage 0) | `pb_chase_weights` → `pb_chase_board` | a summed contact score and two ranks (`chase_rank`, `new_logo_rank`) | owner rulings on ordering (DECISIONS §26), points chosen by the builder | all 824 companies; 547 score under 10 because nothing is recorded | live in the database, disowned as a ranking by §33b; a composite the founding rule forbids |
| `pb_chase_scores` (a summed −18…123 over 146 rows) | table | nothing on the page | 16 Sep research log | 0 | unruled; owner decision 2 deferred (§37) |
| Six-criteria fit (one point per yes; 5+ Gold, 3+ Silver, else Bronze) | draft rubric 0.2.0 | base tier, replacing the ICP map | owner decision 11 Sep, basis `reasoned` | 0 (draft) | built, previewed, not active |

The tier path itself carries no points at all: it is ordinal rungs with a ±1 cap, which is the
right shape for a scarce-outcome problem (Dawes 1979 equal weights; STANDARDS §2). The engagement
states (`engaged`, `responsive`, `pursued`, `fading`, `dormant`, `unknown`) are recency bands over
dated contact events, which is direct marketing's RFM with only the R.

### 1.3 · The sales team's own grade against the engine

Pipedrive carries a Grade field (High / Medium / Low) on 584 of the accounts the engine ranks. Read
High as Platinum-or-Gold, Medium as Silver and Low as Bronze:

| Pipedrive Grade | Platinum | Gold | Silver | Bronze | Unclassified | Agrees |
|---|---|---|---|---|---|---|
| High (85) | 53 | 25 | 4 | 3 | 0 | 92% |
| Medium (127) | 3 | 4 | 110 | 10 | 0 | 87% |
| Low (372) | 4 | 2 | 37 | 324 | 5 | 87% |

88% agreement is not validation. Both columns come from the same hands and the same fields; the
engine has restated the CRM in four words with a trace. That is worth having (it is reproducible,
auditable and nightly), but it is not yet a grade the CRM could not have produced on its own.

### 1.4 · The head of the board

`pb_prospect_board` sorts on the engine's own chase key. The top 60 rows on 18 Sep:

| Rows | Tier | Qualification | Urgency | Recorded engagement |
|---|---|---|---|---|
| 46 | Platinum | Conversation (0–1 facts) | Cold | 21 never contacted, 14 fading, 8 written to and never answered, 3 responsive |
| 11 | Platinum | Partly qualified | Warm / Hot / Cold | mixed |
| 2 | Platinum | Qualified | Hot / Super Hot | 1 engaged, 1 pursued |
| 1 | Gold | Partly qualified | Warm | never contacted |

The first qualified Silver appears at rank 88; the first qualified Bronze, hot and engaged, at rank
230. The 17 Sep ruling (Platinum is a size label; scarcity belongs to "Platinum and qualified" at
the head of the order) holds for exactly two rows and then the order hands the next 46 to accounts
nobody has qualified. The tier is doing its job. The sort is not.

### 1.5 · What the inputs cover

Share of the 830 live accounts carrying each fact, with its dominant source:

| Fact | Accounts | Share | Where it comes from |
|---|---|---|---|
| `icp_class` | 592 | 71% | Pipedrive card field 559, Notion 33; all `inferred` |
| `is_agency` | 575 | 69% | Pipedrive organisation type, plus site and call reads |
| `headcount` | 457 | 55% | Pipedrive 262, Apollo 152, Notion 24; `evidence` on 19 |
| `timing` | 408 | 49% | Pipedrive lead temperature 328, calls 37, Notion 42 |
| `referral_from_network` | 368 | 44% | Pipedrive lead source; true on 95 |
| `authority` | 338 | 41% | Pipedrive 302, calls 29 |
| `sells_build_work` | 239 | 29% | site reader, Apollo, calls, notes, rater |
| `no_inhouse_dev_team` | 187 | 23% | same |
| `service_shape` | 78 | 9% | Notion 45, Pipedrive 27 |
| `money` | 76 | 9% | Notion, calls, Pipedrive |
| `specification` | 70 | 8% | calls 37, Pipedrive 22 |
| `wl_signal` | 54 | 7% | Notion only |
| `recurring_work_shape` | 29 | 3% | calls, notes, site |
| `client_budget_size` | 17 | 2% | calls, notes, site |
| `avg_project_size`, `recurring_revenue_share`, `niche_positioning`, `am_pm_separated`, `platform_partner_badge`, `peer_network_member`, `ai_posture`, `inhouse_dev_team`, `dev_archetype`, `shrinking`, `owner_does_everything`, `icp4_vertical_proven`, `n_vendors`, `our_rank` | 0 | 0% | never collected |

Signals: 1,479 rows, of which 1,149 are weight-zero prior grades. Live behaviour: 113 inbound
replies, 87 warm introductions, 73 lost quotes, 37 hand notes, 11 quotes sent, 6 requested,
2 verbal acceptances, 1 agreement sent. Contact events: 1,350 (719 calls, 468 emails, 97 quotes,
63 CRM notes), on 339 of 824 companies; 485 companies have no recorded contact of any kind.

So the direct answer to "is it being graded": yes, every night, deterministically, with a trace.
What it is graded on is two dropdowns, a headcount and a referral flag. The rest of the rubric is
correct and asleep.

## 2 · Is this a proven science? Component by component

The field has three kinds of knowledge and STANDARDS §0 keeps them apart: settled mechanics that are
not to be relitigated; local numbers (every threshold) that only the seller's own outcomes can set;
and the one thing nobody knows, which is whether any prospect grade predicts revenue for a
white-label development shop. The table says which kind each component is, what the field calls
it, and where WLIQ stands.

| Component | The field's name and origin | Kind | WLIQ today | Verdict |
|---|---|---|---|---|
| Gates before scoring | Disqualification / knock-out criteria (Forrester's fit-first waterfall; every vendor's AND-gate) | settled | Two of four gates can park; both inputs unknown on 9 in 10 accounts, and unknown never parks. Character stays a flag by owner ruling (§40) | matches in shape; asleep for lack of inputs; the flag is a recorded divergence |
| Fit | ICP scoring: 4–6 observable attributes, near-equal weights (Dawes 1979; Grove 2000 on mechanical vs holistic). For a reseller channel the same thing is called an **Ideal Partner Profile** and scored on capability, capacity, commitment and compatibility | settled shape, local attributes | Active: ICP label → tier, measured r = −0.135, retired 11 Sep, still running. Draft 0.2.0: six equal-weight criteria, the standard shape exactly | the standard is built and parked; the retired input still grades the book |
| Qualification | **BANT**: budget, authority, need, timing (IBM, decades old); MEDDIC for larger deals; SPICED for recurring-revenue services (Winning by Design) | settled | Dimension A is BANT with "need" spelled "specification". Present-count labels. SPICED elements feed the call extractor and deal health, not the score | matches; right size for $5–50K deals |
| Potential | Key-account potential axis (McDonald & Woodburn); wallet = capacity × revenue per head × outsourceable share; share of wallet from vendor rank (Keiningham et al., HBR 2011, on existing customers) | settled shape, every anchor local | Formula matches the locked method; every term but headcount is a default; the vendor-rank rule is applied to prospects who have no rank on file, and the owner has challenged the method (§18.3, open) | matches in shape; a Partner ceiling today is an assumption, stated as one |
| Engagement signals | Behavioural lead scoring with linear decay on behaviour, none on fit (MadKudu, HubSpot); trigger events and warm paths outrank bought intent | settled shape, local weights | Catalog, decay and routing implemented verbatim; overridden by a hand stamp on 428 accounts, silent on 413, live on 10 | matches; not yet driving anything |
| Engagement states | RFM recency (direct marketing) | settled | Six recency bands over dated contact events; `unknown` kept separate from `cold` (§24) | matches, and ahead on the unknown/cold split |
| Deal health | Rule-based deal warnings (Gong's eight; Dixon's indecision finding) | settled shape, local thresholds | Twelve rules, every threshold in params; stage medians still the 21-day placeholder | matches; thresholds unmeasured |
| Never summed; rank and bands | The fit-by-engagement grid (a letter for fit, a number for engagement) that Eloqua, Marketo and HubSpot ship; composites rejected by the decision-science literature | settled | Tier is non-compensatory (good). The **chase order is a strict lexicographic sort**, not a grid; two summed composites exist in the database | **the one real divergence**: a sort where the field uses a grid |
| Tiering | Account-based marketing (ITSMA, early 2000s): 1:1 strategic (median 13 accounts), 1:few (median 50), 1:many programmatic | settled | Platinum × Partner is the 1:1 candidate list (65 today); the owner's stated chase capacity is 100; Tier-1 sizing is open decision 1 | matches in concept; sizing unruled |
| Validation | A pre-registered test (PRO-8), calibration of estimates against outcomes (Hubbard), scored intervals (Brier) | settled method, unknown result | Specified; run once (ρ = 0.27, n = 31); snapshots accumulate since 17 Sep; no scoring pass; 2 won, 67 lost | behind, and the only thing that can ever say whether the book works |
| Governance | Versioned model in source control, preview before promotion, audit trail per decision, drift reconciliation | settled (regulated scoring, not sales tooling) | Rubric as data, fingerprint-pinned, previewed, reconciled from CI, every rule traced | ahead of anything commercial |

So: not a reinvented wheel. It is the standard wheel, built with unusually careful bookkeeping,
and it is running on defaults because the tyre was never fitted. The two things that matter are
the divergence in the last-but-three row, and the empty inputs in §1.5.

## 3 · Who you are, in the field's words

You sell production (development, design, paid media and the rest of the eleven service families)
to agencies, who resell it under their own name. Your buyer is not a customer in the usual sense;
it is a **channel partner**, and what you are doing when you grade a prospect is **partner
recruitment**. The universe is finite and knowable: a few thousand agencies of roughly 8–40 people
in your territories, which is why the motion is **account-based** (the unit is the agency, not the
lead; the buying committee matters; the list is named, not harvested). Your sales pod is two people
and the owner; deals run $2K–50K; a won client's first year is $16K at the median; a Tier-1
partner is $100K a year. The book holds 830 accounts, and 227 of them are already being delivered
for, because the owner ruled that a client buying one line is a prospect for every line they are
not buying (§26.1).

Three things follow from that, and each changes what to look at.

**It is account-based, not lead-based.** The vocabulary is MQA (marketing-qualified account), not
MQL; tiers are 1:1, 1:few and 1:many with a play per tier; the readiness signal is the account's
recorded behaviour, not a stamp someone typed. The book already has the pieces (contact events,
engagement states, the tier). What it lacks is the grid that puts them together and the play that
each cell triggers.

**It is a partner profile, not a customer profile.** The six criteria in 0.2.0 are an Ideal
Partner Profile in everything but name. The channel literature scores partners on four things
(capability, capacity, commitment, compatibility), and the six criteria map onto them: sells build
work and is an agency are capability and compatibility; the capacity gap and the size band are
capacity; recurring work shape is commitment; client budget size is the economics. The one thing
the channel model asks that the book does not is **commitment evidence**, and the owner's own data
says the white-label signal (roughly 80% active rate in the July research) is the strongest
predictor found. It is not a fit criterion and never was proposed as one (§28a). That is open
ruling 25 and it deserves a yes.

**Two motions share one book.** New-logo recruitment (603 accounts with no delivery) and expansion
inside delivering accounts (227) are different questions with different standard scorecards:
prospect scoring for the first, whitespace or land-and-expand scoring for the second (which lines
they buy, which they could, who at the client sponsors it). The chase board's "delivering +18
points" and its second rank are the current compromise. The honest structure is a lane, not a
points tweak: the prospect board for new logos, and an expansion view for delivering accounts
whose potential is the ceiling minus what they already buy.

### 3.1 · The jargon, mapped

| The field says | The book says | Where it lives |
|---|---|---|
| ICP / Ideal Partner Profile | Dimension B, fit; the six criteria | rubric `dimension_b` |
| Knock-out / disqualifier | gate | `gates.items` |
| BANT | Dimension A: money, authority, timing, specification | `dimension_a` |
| Account potential / share of wallet / whitespace | ceiling, headroom band, winnable share | `potential` |
| Intent and engagement signals, decay | signals, urgency | `signals.catalog`, `pb_signals` |
| RFM recency | engagement state | `pb_engagement`, `pb_company_engagement` |
| Multi-threading, champion, critical event | climb evidence (strong / weak) | `potential.climb_evidence` |
| Deal risk warnings | deal health, red / yellow / green | `deal_health` |
| ABM tiers (1:1, 1:few, 1:many) | Platinum × Partner … Bronze × Project cells | `cell` on every read |
| Named-account list, sized to capacity | the chase list, "up to 100" | open decision 1 |
| MQA / hand-off criteria | qualification label, urgency | `qualification`, `signals.urgency` |
| Land and expand | Project → Embedded → Partner | `vocabulary.ceilings` |
| Override with reason code and expiry | register kind `override` | `pb_register` |
| Calibration loop | potential snapshots, PRO-8 | `pb_potential_snapshots` |

### 3.2 · Should you be looking at different things?

Yes, and fewer of them. The field and your own data agree on a short list, and the rubric's long
list is where the effort has leaked.

| Look at | Why | Coverage today |
|---|---|---|
| Build capacity gap (they have more build work than they can absorb) | the strongest single predictor in the July research; re-worded by owner ruling §19 | 187–239 accounts, from site reads and calls |
| Warm path (referral from the network, peer-group presence) | the strongest engagement input in the literature; already +1 in fit and weight 10 in signals | 368 known, 95 true |
| Recorded engagement in the last 90 days | the readiness axis; the only thing that separates a live account from a big one | 339 companies with any event; 114 replied within 90 days |
| Client budget size (who their clients are) | sets ticket size and technical depth for a white-label supplier; no API has it | 17 accounts; a person reads a work page in ninety seconds |
| White-label signal (do they already outsource, and how much) | your own strongest predictor; today it only sets a share inside the wallet | 54 accounts, Notion only |
| Recurring work shape | commitment; the partner literature's fourth C | 29 accounts |

And stop carrying, in the active rubric, the twelve adjustment inputs nobody has ever recorded.
They are not wrong; they are noise on the method page and a standing invitation to collect
things that do not change a grade.

## 4 · How the decisions were made

The ledger (`docs/DECISIONS.md`, 55 sections, 9–17 Sep) records the arc. Condensed:

| When | What changed in the grading | Who |
|---|---|---|
| July 2026 | High / Medium / Low buyer-type grades, four "C" rules, bumps capped at one grade, "one grade max" overrides | owner ruling |
| 4–9 Sep | The Grading Register PRO-0…PRO-18: the grade orders the chase, it does not gate; anticipated tiers in the client words; bands not figures; owner-only overrides; Pipedrive is the roster | owner rulings (never read directly by any session; second-hand throughout) |
| 9 Sep | Rubric 0.1.0 from the research brief: gates, ICP → tier, 14 adjustments, headroom method, signal catalog, deal health, the chase key. Eight builder defaults marked `unruled_default` | builder |
| 11 Sep | ICP retired as the fit read after measuring r = −0.135; six equal-weight criteria in draft 0.2.0; evidence outranks recency | owner decision, on measurement |
| 13 Sep | The chase key measured: 78% of ranked accounts in ties of 20 or more; "unknown ranks with no" named as the largest rule-5 exposure; cohorts defined; the book found to be a CRM mirror | measurement, no ruling |
| 14 Sep | Climb evidence re-ruled as engagement depth (strong / weak, two signals retired); settle fit before spending on climb; vendor-count method challenged | owner rulings |
| 15 Sep | Potential decoupled from engagement (two deletions; Platinum 2 → 67); delivery capacity replaces payroll; the capacity-gap wording; source precedence | owner rulings |
| 16 Sep | Engagement from recorded contact, not the CRM stamp; nine chase-list rulings (delivery is not disqualification, a live quote outranks conversation, a lost quote is not a lost client, chase up to 100); contact board built with weights, then disowned for the rubric's own key | owner rulings; builder build and retraction |
| 17 Sep | Four rulings: trunk is `main`; character stays a flag; the small-shop floor is a flag; Platinum is a size label. The one-tier override cap removed. The 15 Sep ruling found never to have reached the deployed engine | owner rulings; audit |

Three warnings the ledger gives about itself matter for anyone reading it as authority. §43 records
a builder decision that overwrote an owner ruling and was recorded as the ruling. §10 records that
the live instrument places an unresearched agency below a researched bad one, and says it is a
register question, still unruled. And the section numbers collide (two §28s through two §33s from
a branch merge), so a bare "§30" is ambiguous today.

The owner's intent, in his own words, reads as five principles. Potential, confidence and
engagement are three separate questions and none may leak into another ("platinum does not mean
the deal is real, it means that they have the potential to reach this level"; "cold is changed based
on engagement"). The book ranks; it never gates. A client is still a prospect, and the handover is
the moment to nurture hardest. Facts happen in conversations, not in CRM fields. The page is the
product and must show the most accurate, most confident data available, without being reinvented.

### 4.1 · What you are asking for, said plainly

You want a prospect book that rests on the field's established model for account-based partner
recruitment, tuned to a white-label production shop, where every parameter is either the standard
with its source or a recorded WLIQ ruling, and nothing is an accident of iteration. You want the
grade to be earned from observed facts rather than relabelled from a dropdown. You want the board to
answer, in this order, who to work this week and how much each is worth, without collapsing the two
into one number. You want the people who talk to agencies to enter what they learn in plain
language, once, on the page. And you want to know, on a date you can name, whether the grades
predict anything, so that the rubric can be cut from outcomes rather than from opinion.

## 5 · The problems, ranked

Each has what, the evidence, the standard, and what closes it.

**P1 · The board sorts when it should grid.** The chase key is tier, then facts, then urgency.
A Platinum with nothing recorded outranks a qualified, engaged Silver; 46 of the top 60 are that
Platinum. The standard is a two-axis grid with a play per cell. Closing it is one rubric version
(the readiness band as the first key, or a cell as the first key) plus the board reading cells.
Today's counts under a plain readiness rule (two or more qualification facts, or Hot/Super Hot, or a
reply within 90 days = ready; one fact, or contact without a reply = stirring; nothing = cold):

| Cell | Accounts | Of which qualified / hot / replied ≤ 90d | The play |
|---|---|---|---|
| Big (Platinum, Gold) × ready | 38 (26 new logo, 12 delivering) | 5 / 9 / 13 | chase now; the 1:1 list |
| Small (Silver, Bronze) × ready | 159 (120 new logo, 39 delivering) | 14 / 51 / 36 | work the deal; the 1:few list |
| Big × stirring or cold | 66 | 0 / 0 / 0 | open the door; nurture with intent |
| Small × stirring or cold | 364 | 0 / 0 / 0 | programmatic; 1:many |

Under the current sort the 66 "open the door" rows sit above the 159 "work the deal" rows. The
15 Sep ruling is untouched by this: the tier stays a size label. Only the order changes.

**P2 · The tier is a relabelled dropdown, and the replacement is parked.** 98% of base tiers are
stated ICP labels the owner retired on 11 Sep. The six-criteria rubric 0.2.0 is the standard
shape and was previewed on 18 Sep at 02:18 UTC (830 scored, 0 errors, 317 tiers change): Platinum
3, Gold 34, Silver 140, Bronze 413, no tier about 240. It flattens the book because two criteria
have no collection path (17 and 29 accounts) and because the band lookup counts yeses regardless of
how many criteria were answered, so "2 yes of 2 answered" reads Bronze exactly like "2 of 6". The
rubric's own note calls that "graded on ignorance" (§8). Only 237 of 830 accounts can answer three
or more of the six today; 20 can answer five. Closing it is a collection sprint on the ready cells
first, the `unclassified_when_answered_below` toggle raised from 1 to 3, a ruling on whether a
fallback "no" is evidence (§38.4), and then the preview again. One engine quirk to fix on the way:
status still keys on the ICP label, so under 0.2.0 an account with a label and zero answered
criteria reads "Ranked" with no tier (29 ranked rows in the preview).

**P3 · Urgency is a hand stamp that never ages.** `stated_timing_wins` puts the Pipedrive
lead-temperature dropdown above the computed signal ladder on 428 accounts. Facts never decay, so a
"within one week" stamp from February is Super Hot in September: of the 55 stamps saying within a
week or a month, 19 are older than 30 days and 13 older than 60. The standard is that behaviour
decays and fit does not; a timing stamp is behaviour. Closing it is a per-stamp horizon in the
rubric (a week-stamp expires after 14 days, a month-stamp after 45, a quarter-stamp after 120)
after which the computed ladder takes over, and feeding recorded contact events into the engine as
the signals they already are, so "computed" means something on more than 10 accounts. The question
was put to the owner on 15 Sep and not answered (§20); it is ruling 19 on the open list.

**P4 · Potential runs on defaults.** Winnable share is the default on every account; the
white-label share is the default on 94%; serviceable share is a guess. The owner has already said
the vendor-count method is wrong as written (§18.3). Nothing here is broken, but a Partner ceiling
should print as the assumption it is until a call captures the two discovery questions. The
cheapest honest change is confidence: potential confidence should read Low wherever winnable share
is defaulted, and the page should say "assumed" beside the band.

**P5 · Unknown ranks with "no".** Qualification counts only `present`; `absent` and `unknown` both
score zero. Two thirds of the 3,320 qualification slots are unknown against 7% recorded absent, so
an unresearched agency sits below a researched bad one, in the second key of the order. The ledger
(§10) calls it the largest unknown-as-evidence exposure in the live instrument and a register
question. The field's answer is three states per fact and a readiness axis that treats "nobody
asked" as its own band, which is what the grid in P1 does with "cold".

**P6 · Three point systems compete for one decision.** The rubric's key, the chase weights, and the
composite table. The field uses recency points for exactly one thing: ordering inside a cell, for
"who do I call today". Closing it is a ruling: the chase weights survive as the within-cell
tiebreak and nowhere else; `pb_chase_scores` is retired (owner decision 2, deferred in §37); the
page shows one rank.

**P7 · Nothing measures the grade.** 2 won, 67 lost, 31 retrodictable clients, ρ = 0.27 with a
confidence interval that includes zero. The snapshots accumulate (2,394 rows over two nights) with
no scoring pass. Vendors refuse to fit weights below 40 won and 40 lost; that is years away at
20–40 new agencies a year. The interim outcome that exists in volume is the quote: 97 quote events,
19 open. Closing it is a monthly lift report by cell (share of quotes and wins in each cell against
its share of accounts), the 6/12/24-month scoring pass, and a named date for re-running PRO-8.

**P8 · The write lanes are just starting to be used.** 7 overrides now (0 on 17 Sep, so the board
works), 0 promotions, 0 raters, no play named for any tier, 485 companies never contacted. A grade
only matters if someone makes a different call because of it. This is decision 3 (raters at
release) and R7 (plays with owners and SLAs), both recorded.

## 6 · The plan

Six moves, in order. Each says what it needs from the owner, roughly how long it takes, and what
"done" looks like. The first three are a rubric version each, previewed before activation, as the
runbook requires.

**Move 1 · Put readiness on the board (this week; one decision, one rubric version, one board
change).** Define readiness as rubric data (facts present, urgency, live positive signal; recorded
engagement once contact events feed the engine) and make the cell the first element of the chase
key, with the tier second. The board groups by cell and names the play. Preview it: the tier moves
on nobody; the order moves on almost everybody, which is why the preview must report order changes
as well as tier changes (a known gap, §10). Done when the top of the board is the 38 big-and-ready
accounts and the 66 big-and-cold sit in their own section with a nurture play.

**Move 2 · Make the six-criteria fit answerable, then activate it (two to three weeks).** Three
rulings first: the answered threshold (3 recommended), whether a fallback "no" is evidence (unknown
recommended), and whether the white-label signal becomes criterion seven (yes recommended; equal
weight). Then collection on the 197 ready accounts before anyone else: client budget size by a
person from the work page (ninety seconds each, about five hours in total), recurring shape from
calls and notes, capacity gap and build work from the site reader, whose queue of about 470
candidates needs the write-through ruling in §45 to stop re-forming nightly. Preview 0.2 against
the live tiers, read the diff, activate. Move the twelve inert adjustment rules out of the active
rubric into a parked block. Done when the base tier on the ready cells comes from observations and
the method page lists six or seven criteria instead of a map and fourteen rules.

**Move 3 · Let stamps age (one day).** Per-stamp horizons in the rubric; feed contact events into
the engine as signals so the computed ladder is live. Preview; expect urgency to fall on the stale
stamps and rise on accounts with recent replies. Done when `urgency_basis` reads computed on more
accounts than stated.

**Move 4 · Start the outcome loop now (one day to build, then monthly).** Three outcome events from
tables that already exist: first reply, quote sent, first invoice (promotion). A monthly lift-by-cell
report on the page. The 6/12/24-month scoring pass against Orbit and QuickBooks. A date for the
PRO-8 re-run written into the rubric's validation block. Done when the first report exists, even
with thin numbers; the value is the clock starting.

**Move 5 · Settle the point systems (one ruling).** Chase weights as within-cell tiebreak only;
composite table retired; one rank on the page. Done when nothing on the page or in the database
sums the reads.

**Move 6 · Plays, owners, raters (at release).** A play per cell with an owner and an SLA; the 1:1
list sized to the pod (the 38 today is about right for two people); a weekly review of the ready
cells; the rater questions in plain language on the page (§37 decision 3). Done when the register
shows decisions being made from the board every week.

### 6.1 · The decisions only the owner can make

| # | Decision | Recommendation | What it changes |
|---|---|---|---|
| D1 | Grid or sort: does readiness come before size in the chase order? | Grid. Tier stays a size label, exactly as ruled 15 and 17 Sep; only the order changes | the head of the board |
| D2 | Under the six-criteria fit: how many answered before a tier is published, and is a fallback "no" evidence? | 3 answered; a fallback "no" is unknown | how many accounts get a tier under 0.2 (today 591 would; at 3 answered, 237) |
| D3 | Do timing stamps age? | Yes, per stamp: 14 / 45 / 120 days | urgency on up to 428 accounts |
| D4 | The point systems | Chase weights as tiebreak only; composite retired | one rank on the page |
| D5 | Is the white-label signal a fit criterion? | Yes, criterion seven at equal weight | fit on the 54 accounts that carry it, and a reason to collect it |
| D6 | The vendor-count method (§18.3) | Keep the formula, print the ceiling as assumed until a rank is recorded; revisit when quotes give a share to measure | honesty of the Partner ceiling |
| D7 | Tier-1 size (decision 1 since July) | The big-and-ready cell, capped at what two people can work in a week | the 1:1 list |

## 7 · What this review did not do

It did not read the Grading Register, which no session has read directly; every PRO-number claim is
second-hand through the ledger, and the register wins where they disagree. It changed no parameter,
no read and no fact. It ran one preview that writes nothing. It did not re-derive the 9 Sep
research's evidence grades; it inherits STANDARDS' tags. The retrodiction cohort and the July
material live outside the repository. Counts move nightly, so every figure carries its date.

## 8 · Reproducing the numbers

Aggregate queries, no names. Run against the project through the Supabase MCP.

```sql
-- base tier provenance, adjustments fired, urgency basis
select scorecard->'fit'->>'icp_derivation', count(*) from pb_current_reads group by 1;
select a->>'id', count(*) filter (where (a->>'fired')::boolean)
  from pb_current_reads r, jsonb_array_elements(r.scorecard->'fit'->'adjustments') a group by 1;
select scorecard->'signals'->>'urgency_basis', count(*) from pb_current_reads group by 1;

-- the head of the board
select effective_tier, qualification_label, signal_urgency, engagement, count(*)
  from pb_prospect_board where rank <= 60 group by 1,2,3,4;

-- the sales team's grade against the engine
select s.payload->>'value', r.effective_tier, count(*)
  from pb_signals s join pb_current_reads r using (account_id)
 where s.type = 'prior_grade' and s.payload->>'field' = 'Grade' group by 1,2;

-- coverage of every fact
select key, count(distinct account_id) from pb_current_facts group by 1 order by 2 desc;

-- age of the hot stamps
select value #>> '{}', current_date - observed_at, count(*) from pb_current_facts
 where key = 'timing' and (value #>> '{}') in ('within_1_week','within_1_month') group by 1,2;
```

## 9 · Sources named in this review

The standards comparison in `docs/STANDARDS.md` carries the evidence grades. Two outside references
were consulted directly for §3: on ideal partner profiles and the four-C partner scoring,
[ZINFI on channel partner recruitment](https://www.zinfi.com/resources/channel-partner-recruitment-explained/),
[Forrester on recruiting the right partners](https://www.forrester.com/blogs/are-you-recruiting-the-right-channel-partners)
and [a partner-profile template](https://channels-as-a-strategy.com/ideal-partner-profile-template/);
on the three types of account-based marketing and their benchmark list sizes,
[ITSMA](https://www.itsma.com/three-approaches-to-scaling-abm/) and
[the ABM entry](https://en.wikipedia.org/wiki/Account-based_marketing).
