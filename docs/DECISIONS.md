# Decisions — the brief's open items resolved against the register

The 9 Sep build brief (section 9) listed seven decisions. Between 4 and 9 September Brian ruled
most of them in the Grading Register (`wliq-momentum`, `client-grading/ingest/prospect_rulings.json`),
some in the opposite direction from the brief's recommendation. The brief says the register
wins. This file records how each landed, what in the brief it changed, and the assumptions the
build proceeds on. Nothing here is a new ruling.

## 1 · The seven decisions

| # | Brief asked | Register says | Build does |
|---|---|---|---|
| 1 | Tier-1 size: plan against 15–20, hold the rest of the 46 as Tier-2 candidates? | Not ruled. PRO-0 says the grade orders the chase list; tier sizing is Brian's allocation ("grading ≠ organizing", ruled July). | The engine outputs a `chase_rank_key`; no capacity cap is applied in the grade. The tier→play table is configuration for Phase 3. |
| 2 | ICP changes: floor ICP-3 at $10K, drop ICP-6, add recurring / niche / AM-PM / AI-positive as scored attributes? | **PRO-4: ICP-6 stays in scope, flagged**, excluded from agency-only weights. PRO-15: keep the six ICPs and the July structure; test each piece as data arrives. | ICP-6 rows graded, flagged "Direct-to-client", agency-only adjustments skipped. The ICP-3 floor and the four research attributes are **named adjustment rules with basis `reasoned`**, toggleable, inside the ruled one-grade net cap. |
| 3 | Weights: run the lift analysis first, or equal weights and calibrate after a quarter? | PRO-12: enrichment first, then fit. PRO-8: pre-registered rank agreement ≥ 0.5; the cohort test on tier vs year-one ran and **did not meet it** (ρ = 0.270, **CI [−0.142, 0.647], n = 31, clients only**); the pre-signing harvest has not run. The interval spans zero, so the test did not distinguish a useless model from a good one — see `docs/BASELINE.md` §5. UNVALIDATED stands; "not yet shown to work" is not "shown not to work". | v0.1 ships **UNVALIDATED (PRO-8)** on every scorecard, with equal (±1 rung) adjustments and every basis labelled. The fit runs when the harvest exists; it is not in this repo's Phase 1. |
| 4 | Who rates prospects and holds the override lane? | **PRO-5 (revised):** the two sales raters rate their own rows; Brian may stand in, recorded as a stand-in; **Brian alone overrides**. Deepak's lane is retired. PRO-2r: there are no judgment questions — raters enter **facts**. | `pb_members.role` = owner / rater / viewer; `pb_facts.entered_by` + `stand_in`; override insert policy is owner-only; per-rater comparison is a first-class report (later phase). |
| 5 | SPICED as the shared qualification record, MEDDIC-lite above $35K/yr? | Not ruled. PRO-2r's Dimension A (money, authority, timing, specification) is the ruled qualification test. | Dimension A is the qualification read. SPICED's fields (pain, impact, critical event, decision) are the Fathom call-extraction schema, which feeds Dimension A and deal health; nothing is scored on them. |
| 6 | Pipedrive stays the deal-motion record with write-back, or the Prospect Book becomes the record? | **PRO-6: Pipedrive is the source of truth for the roster, until it is not.** The Orbit CRM and the sales spreadsheet are uncertified. The database is still the grading record (the brief's architecture rule, not contradicted). | `pb_accounts.roster_certified` is true only for rows Pipedrive carries. Every other list seeds rows flagged "Roster source uncertified" and still graded (a grade is labelled, never withheld). Write-back is Phase 3. |
| 7 | Share the Prospect Book publicly like the Client Book, or keep it private? | **PRO-7: anyone at WLIQ who signs in.** Not public. | **Superseded on 10 Sep 2026 by Brian's instruction: the book reads publicly.** See §5. Writes are unchanged and still by lane (PRO-5). |

## 2 · Where the register changed the brief

| Brief | Register | Consequence in this build |
|---|---|---|
| "The Prospect Book must share the Client Book's identity spine" | **PRO-17 (9 Sep): two independent systems that connect as a prospect becomes a client.** | Own repo, own tables (`pb_*`), own identity list. The accepted cost — two identity systems — is contained at one human checkpoint (PRO-18). |
| Fit grade **A to D** | **PRO-1r: the client tier words**, labelled *anticipated*, with confidence. | Platinum / Gold / Silver / Bronze. The research's A/B/C/D reads as Platinum/Gold/Silver/Bronze. |
| Year-1 dollars as a figure (quote or ICP prior $145K…$22K) | **PRO-16: a rough band is enough**; the July prior table is biased high (cohort median $16,318). | `year1_band` from five fitted anchors; ICP prior **band**, labelled reasoned. |
| Gates park the record | **PRO-0: the grade is not a gate**; gates may run as an operational filter. | Gates set `status = Parked` and the grade is still computed and stored. |
| Broker-character gate | **PRO-2r: character is not a grading input; PRO-2r-a (safety gate) open.** | Flag only. Mode is a toggle. |
| Seed from Notion, Tier 1 Book, Gotham, Brian Trip | **PRO-6: only Pipedrive is certified.** | Seeded as uncertified intake, flagged; Pipedrive confirmation certifies. |
| Cloudflare Workers + Supabase | The Client Book runs on Supabase Edge Functions; this container has no route to the Cloudflare API or to `*.supabase.co`, only the Supabase MCP. | Supabase Edge Functions + pg_cron + Vault. One system, deployable from a session. |

## 3 · Assumptions the build proceeds on (each is a toggle in the rubric)

1. **ICP → base tier**: High → Gold, Medium → Silver, Low → Bronze; Platinum earned by the
   platinum rule (adjusted Gold + Partner ceiling with climb evidence + ≥ 3 of 4 facts). The
   July mapping was never ruled; this is its restatement on four words, marked `unruled_default`.
2. **Minimum Dimension A facts to publish a tier: 0.** The tier is shown with the
   qualification label beside it. Open in the register.
3. **Economic floor basis: deal size, $2K.** Open since July.
4. **Net adjustment cap −1** mirrors the ruled +1.
5. **Promotion confirmation lane: owner.** Open in the register (PRO-18 "who confirms").
6. **Notion "Active project / immediate need?" ≈ specification.** An approximation, noted on
   every seeded fact; a rater's entry supersedes it.
7. **Year-1 ICP prior bands** from cohort tier medians and ICP ticket midpoints; unfitted per
   ICP and labelled so.
8. **Signal weights and lifespans** from the research catalog; to be re-cut where the
   staircase breaks once outcomes exist.

## 4 · Two things to flag before the next step

- **This repository is public.** The Client Book's GOV-1 ruling ("everything in, including
  the raw pulls") was made for a *private* repo. Until `prospect-grading` is private, no
  prospect names, dollar bands, seed exports, gate reports or the build-kit documents (which
  carry Notion URLs, credit balances and staff names) are committed here. Code, schema, the
  rubric and synthetic fixtures only. Note that as of §5 the *data* is public anyway, through
  the page — but the rule stands for this repository, which is a different surface with a
  different audience and no way to take a commit back.

## 5 · The book reads publicly (10 Sep 2026)

Brian's instruction, given after the exposure was put to him in these words: the page is on
GitHub Pages at a URL served to anyone who asks for it, from a public repository, so the link
is discoverable without anyone sharing it. He asked for it anyway; migration
`20260910190000_prospect_book_public_read.sql` implements it, and this section is why.

**This reverses how PRO-7 was implemented, and PRO-7 has not itself been re-ruled.** The
register still reads "anyone at WLIQ who signs in". Someone should take that back to the
register and settle it; until then the code follows the owner and this file records the gap.

What is now readable by anyone, no sign-in: the roster of 680 agencies by name, every
anticipated tier, confidence, band and flag, the facts with their notes and evidence labels,
the signals, the deals, the calls (including summaries and attendee names and addresses), the
register, and the merge queue.

What is not: **`pb_contacts`** — 817 named people at other companies with their email
addresses, the largest block of personal data in the book, which the page never reads and
which stays behind the sign-in; `pb_members` (WLIQ staff and their lanes); `pb_webhook_inbox`
(raw delivery bodies); `pb_promotions` and `pb_potential_snapshots`.

**Every write path is unchanged.** Anonymous inserts are refused — verified against the live
REST endpoint with the publishable key: reads return 200, an insert into `pb_facts` returns
401. Entering a fact or a hand signal still needs a rater's signed-in WLIQ address, an
override still needs the owner's, and the page now treats signing in as what grants a lane
rather than as the gate on the door.

Two consequences worth holding in mind. A prospect who searches for their own name can read
their own grade, the notes behind it and what WLIQ thinks the relationship is worth — and so
can a competitor, in bulk. And reversing this restores the gate but un-publishes nothing that
was read, copied or indexed while the book was open.

## 6 · Where the roster came from

- **Pipedrive was unreadable until 9 Sep, 17:15 UTC, and is now connected.** It is the ruled
  source of truth for the roster and the source of the qualification facts Brian named first.
  The certified roster is derived from the Client Journey cards: an organisation with a card
  in New, Schedule Sales Call, Sales Call Done, Quoting, Quote Lost or Unqualified/DNC (the
  last parked), plus organisations on open pipeline-1 deals with no card. Client-stage cards
  are Agency Partners (PRO-10) and never enter the book. On 9 Sep that is 665 organisations,
  against 62 Notion rows. What still needs a person: the webhook (created in Pipedrive's
  settings against a Basic-auth secret in Vault) and, for write-back later, an API token
  (`PB_PIPEDRIVE_API_TOKEN`); the MCP itself is an OAuth grant the app cannot reuse.

## 7 · Proposed from the evidence review — **not decided**

An external evidence review (10 Sep 2026, questions A–G) proposed the changes below. **None is
ruled and none is built.** They are recorded here before any code moves, with the register
ruling each one touches, so that whoever decides can see what is being traded. The baseline
they would be measured against is frozen in `docs/BASELINE.md`.

Ordered by the review's own priority, which puts data ahead of weights.

| # | Proposed change | What it touches | Cost of being wrong |
|---|---|---|---|
| P1 | Link billing (Orbit) to the roster, and move any account with billing history into the Client Book | **PRO-10** as implemented. The cross-check today matches against the Client Book's own roster, and that roster is missing partners — two were found by hand in one sitting. Nothing in this repo can fix a gap in the other system's list. | Low. This corrects records that are wrong today: real partners graded as cold prospects. |
| P2 | Qualification assessed **on the open deal, not on the account**; three states per fact (not asked / asked but unknown / known) instead of two | **PRO-2r.** Dimension A stays the qualification test; what changes is where it is recorded and that "not asked" stops reading as "not present". Also the **platinum rule**, which currently requires 3 of 4 facts on the *account* (basis `reasoned`, so a toggle, not a ruling). | Medium. If refusing to state budget or timing is itself a signal about an agency, moving the fact off the account hides it. Testable: compare accounts asked-and-declined against asked-and-answered. |
| P3 | Fit scored for every account from what is visible externally, with an evidence level shown beside the tier that never moves the tier | **PRO-12** (enrichment first, then fit) — this is that sequence. Adds an enrichment source; Apollo is connected and unspent (A6). | Medium. Purchased headcount for agencies under ~10 people is mostly estimated, so a fit score leaning on it is noise for the smallest rows. |
| P4 | Cut the actively-worked list to what two raters can cover; everything else sits in a pool that events promote from | Nothing ruled. Decision 1 (tier-1 sizing) was left to Brian's allocation and is still open. | Low, and reversible. |
| P5 | Pre-register the four-way ranking comparison and check it at 6–12 months | **PRO-8.** This is how the ruled threshold finally gets tested on an adequate sample. | None. Not doing it is the risk. |

Two things the review argued *against* doing, recorded because they are easy to drift into:

- **Do not re-cut weights from outcomes yet.** At 20–40 new agencies a year, a validation-grade
  sample takes years; vendor CRMs refuse to train a model below 40 won + 40 lost (Microsoft) or
  200 + 200 (Salesforce). Equal weights with every basis labelled is the correct posture until
  then, which is what v0.1 already does.
- **Do not treat ρ = 0.27 as a verdict.** See §5 of `docs/BASELINE.md`.

The review also made the case against the whole exercise: for two raters and 680 accounts, the
value may sit in coverage and hygiene — duplicates, who is already a partner, who has not been
touched — rather than in ranking. On today's evidence that case is strong, and the merge queue
(75 unconfirmed matches, 48 of them from Orbit) is the first place it pays.

---

## 8 · ICP is retired as the fit read (11 September 2026)

**Owner decision.** Dimension B no longer takes its base tier from the ICP class. Six
observable criteria carry it instead. ICP is still classified and still printed — as a
descriptive label.

### Why

The Apollo enrichment of the 200 warmest prospects (195 domains, 173 matched, 173 credits)
made the ICP ordering measurable for the first time. Against an equal-weight score built from
three now-observable criteria:

**r = −0.135, 95% CI [−0.28, +0.01], n = 172.**

The interval barely touches zero and rules out any meaningful positive relationship. The
ordering carries no fit information, and leans slightly negative.

Broken out by class, it is close to inverted. ICP-1 — *Established Full-Service Partner*,
mapped to Gold, July priority A — is the **worst-fitting class in the book**: mean 1.04 of 3,
median headcount 115, and **22 of its 24 accounts already employ engineers**. ICP-3, *Lean
Boutique Operator*, mapped to Bronze at priority B+, is the second best and carries 83 of 170
accounts. The two classes that matter most by volume were mapped backwards.

### The cause is the flow, not the definitions

Classification step 3 reads:

```
agency_type == full_service AND headcount >= 11 AND revenue_band in [5-10M, 10-25M, >25M] → ICP-1
```

A floor with **no ceiling**, plus revenue as a *positive* signal. For a white-label supplier
both are backwards: the bigger and richer the agency, the more likely it has already hired the
developers. The definition and the rule disagree and the rule wins — ICP-1's own definition
says *"employees 11–50 (some 25–100)"* while the flow admits a 380-person agency. No class in
the flow has an upper bound.

ICP-6 (*Direct End-Client*) mapping to **Silver** also placed non-agencies above every lean
boutique; nine of the eleven non-agencies found in the warm list sit there.

### What was and was not touched

- **ICP definitions: unchanged, verbatim, under PRO-15.** Rewriting them would be a new ruling,
  and nothing in this repo is a new ruling (rule 1).
- **The classification flow: unchanged.** The missing upper bound is left exactly as it is. The
  class it produces is now a label, so the defect no longer reaches a grade.
- **`base_tier_from_icp`: retired**, and kept in the spec as `base_tier_from_icp_retired` with
  the map as it stood, so the v0.1.0 baseline stays readable.
- **`base_tier_from_fit`: added** — six criteria, equal weight, one point each, bands 5+ → Gold,
  3–4 → Silver, 0–2 → Bronze. Platinum stays *earned* by `platinum_rule`, never a base.
- **Potential still keys its year-1 prior band off the ICP class** (PRO-16). That is a separate
  read and was not in evidence here; it is left alone and stated as such in the spec.

Nothing above is ruled. Every criterion carries `basis: reasoned` and is a toggle.

### Why `core/prospect_types.ts` changed

CLAUDE.md carried *"types, do not change"* on that file. Retiring ICP as the fit read requires
four feature keys that did not exist, so the note had to be addressed rather than worked
around. The change is **additive and nullable only** — no existing key changed type, name or
meaning. Rubric 0.1.0 does not read the new keys, so it grades identically and
`docs/BASELINE.md` stays reproducible; `core/engine_test.ts` asserts exactly that, in both
directions, on the same synthetic account.

The engine chooses its path by **which key the rubric carries**, never by a flag: a rubric with
`dimension_b.base_tier_from_fit` takes the criteria path, one with `base_tier_from_icp` takes
the ICP path.

### Status

`0.2.0` is registered in `pb_rubric_versions` as **draft**, spec sha256
`09d4e8cb36baa1d041968df3165b6e95aefe5a7a0e5ca3ba2538e08095c4f3d1`. **0.1.0 remains active.**
Nothing has been re-scored. Preview before activating, per rule 4:

```
POST $FN/pb-score?rubric=0.2.0&preview=1
```

### The preview runs, and it found the one thing to settle first (11 September 2026)

The first preview attempt failed outright, and the cause is worth recording because it will
recur: **the deployed `pb-score` predated the engine branch that reads `base_tier_from_fit`.**
It took the ICP path unconditionally and raised
`'dimension_b.base_tier_from_icp.map.ICP-3' must be one of … (got nothing)` on every ranked row.
The draft was never at fault — its stored spec matched the repo byte for byte. **A rubric that
moves a decision into a new spec key needs the function redeployed before the preview means
anything**; the version number in `pb_rubric_versions` says nothing about which engine is live.

With the current engine the preview is clean, and it changes a large share of the book — almost
all of it downward. The cause is not that the agencies read worse. It is that **the six criteria
are unanswered for nearly the whole roster**: only a handful of accounts have five or more of
the six on record, and the Gold band needs `min_yes >= 5`. Gold becomes nearly unreachable by
arithmetic, not by judgement.

That exposes the one place this draft leaks against rule 5. `base_tier_from_fit` scores
yes-answers, so **inside the band lookup an unknown and a "no" are the same thing** — both add
nothing. The spec is explicit that "Strong on 5 of 6 answered" and "Strong on 5 of 6, two
unknown" are different states, and `criteria_answered` does travel beside the score. But the
TIER only consults it through `unclassified_when_answered_below`, which the draft sets to **1**.
One answered criterion is therefore enough to publish a tier, so a barely-read agency lands in
the lowest band rather than in Unclassified — graded on ignorance, which is exactly what rule 5
forbids.

**Not resolved here.** It is a toggle and the owner sets it. The two honest directions:

- raise `unclassified_when_answered_below` so a thinly-read agency is Unclassified rather than
  quietly Bronze — the answer that matches rule 5, at the cost of a larger Unclassified pile; or
- answer the criteria first and activate afterwards. The answers are in the written record:
  the `fathom_call` channel is read, `pipedrive_note` and `email` are still dark for want of
  their credentials (`docs/RUNBOOK.md` §17).

Either way, **activating 0.2.0 before one of those is done would restate the roster's ignorance
as a demotion**, and the page would print it beside the word *anticipated* as though it were a
finding.

### The non-agencies

Eleven accounts in the warm list are not agencies (a tax service, a counselling practice, an
investment firm, a consumer-goods manufacturer, a fitness equipment maker, an NGO, an ad-tech
platform, a fintech, a trade association, a direct nonprofit, an aeromedical consultancy).
The owner asked for them parked.

They are **not hard-parked**, because parking fires from a gate in `park` mode and **PRO-4 rules
direct end-clients explicitly in scope, flagged, and excluded from agency-only fit weights**. A
park gate here would contradict the ruling. What was done instead is what PRO-4 prescribes, and
reaches the same operational outcome: `is_agency = false` recorded as a fact,
`relationship_type = direct` on the account, and a `decision` row per account in `pb_register`.
Criterion 6 then answers *no*, the fit score sinks, and they leave the top of the chase order on
the evidence rather than by fiat.

Three further accounts are **white-label suppliers selling into agencies** — the same business
model as WLIQ on the marketing side; one describes itself as *"the agency's agency."* These are
channel or competitive relationships, not build buyers. Their grading is untouched; each carries
a `note` row in the register labelling it, because the label is the point.

---

## 9 · Notes become a source, and evidence outranks recency (11 September 2026)

Owner decision, measured before it was made.

### What was measured

Eight accounts with first-party Pipedrive notes were read against what the book already held.
The notes filled **20 of 48 cells** (six fit criteria × eight accounts) as quote-backed facts and
queued 10 more for a person. Apollo filled 16, almost all of them headcount.

Where both spoke — eleven cells — **they disagreed on five, and Apollo was wrong on all five.**
Each disagreement resolves the same way: Apollo describes what a company **is**; the note records
what it **buys**. A construction consultancy that asks us to build custom API integrations is not
"not an agency" for our purposes; a cybersecurity consultancy that already employs developers does
not "have no dev team" because the industry label says consulting. Fit is a buying question, so
the buying record wins.

One account had **no Apollo match at all** while its note named three institutional clients and
answered all six criteria. Two accounts had nothing but PandaDoc links and correctly yielded
nothing — silence is a result.

### What changed as a consequence

**`pb_current_facts` now ranks evidence above recency.** It resolved ties by `created_at desc`
alone, which was fine while every fact came from a machine sweep and became wrong the moment a
quote-backed note could be overwritten by the next morning's Apollo run. The order is now
`evidence > inferred > unknown`, then newest written, then newest observed. Within one label
nothing moves, so no existing resolution changed. `ingest/resolve_features.ts::latestFactPerKey`
carries the same order; the view is what `pb-score` reads and the function is what the pure path
reads, and the two must not drift.

**Reading notes is now a nightly process, not an errand.** `pb-notes` pulls what changed since
the watermark, a model reads each note into claims, and `ingest/notes_sweep.ts` decides what the
model is allowed to have said.

### Why an unattended model call is safe here

Not because the model is trusted — because it is checked.

Every claim must carry the sentence that supports it, and `verifyClaims` tests that sentence
against the note's own text. **A quote that is not in the note is stripped**, which drops the
claim to the review queue under the no-quote rule in `ingest/pipedrive_notes.ts`. An invented
sentence is therefore structurally unable to reach `pb_facts`. Everything else is a whitelist:
nine extractable keys, the values each may hold, a cap per note; anything unexpected is dropped
and counted, never coerced.

The rest is rule 8's shape applied to facts. A claim without a verbatim sentence, or below high
confidence, or contradicting something a **person** recorded, becomes a `pb_fact_candidates` row
rather than a write. `pb_review_fact_candidate` carries a reviewer's decision through in one
transaction: the fact, dated by the note rather than by today; every other open proposal for that
key closed with it; and a register row either way.

### A verified quote proves provenance, not truth (added the same day)

The quote check answers *did someone write this?* It does not answer *is this so?* — and the
real notes are full of sentences that pass it while being pure opinion. Two from the corpus:

> "Classified GENUINE, ICP-5 (Strategic Consultant), Priority B, Moderate fit, HIGH white-label
> signal."

> "he did seem incredibly knowledgeable and incredibly experienced"

Both are verbatim. Neither is checkable. Writing them as `evidence` would launder a rater's
judgement into a fact and then feed it to the engine as though it had been observed.

So a claim must now declare whether its supporting sentence is an **observation** — something
about the world a reader could check — or a **judgement**. Only an observation can write itself;
a judgement reaches a person however confident the reader was, carrying its sentence so the
reviewer can weigh it. Absent is read as a judgement: the cautious default, not the convenient
one.

The model's own answer is not the last word, because a model that wants to be useful will call
an opinion an observation. `JUDGEMENT_MARKERS` — 46 hedges, classifications and ratings, every
one drawn from a real note — overrules it, and either vote for judgement is decisive. On the
corpus it correctly passes *"They work with one or two freelancers for web projects"* and
*"lack in-house design/development capabilities"* while catching both sentences above.

This is the honest limit of the whole design: **the machine can prove where a sentence came
from and can recognise the shape of an opinion. It cannot tell you whether the sentence is
true.** Only a person does that, which is what the queue is for.

The account sheet now shows the same chain in reverse — **Where this grade came from** lists
every input the engine read, what supplied it, the verbatim sentence, and whether the rule that
read it fired. An input with no fact behind it says so, and says what rule 5 means for it.

### What is not settled

The precision of the extractor itself. The eight-account pass was read by hand, which measures
coverage and catches Apollo's errors but cannot grade the reader against itself. The review queue
is the standing measurement: confirm and reject rates per key, per extractor version, are the
number to watch once raters are working it. A new prompt is a new `EXTRACTOR_VERSION`, which
re-reads every note rather than silently mixing two readings.

---

## 10 · The chase order collapses, and the fix is not a longer key (13 September 2026)

**Nothing is ruled here and no ordering changed.** This section records a diagnosis, the three
designs that were tested against it, and why each was rejected on measurement rather than on
taste. It exists so the next person does not re-derive it — and so that if someone does extend the
chase key later, they do it knowing what was already tried.

### The complaint

Past roughly rung 34 the roster is alphabetical. The sales team's list of 613 ranked accounts
resolves to **47 distinct chase keys**; 22 accounts sit alone, **481 (78.5%) sit in a tie of 20 or
more**, and the bottom 206 positions are exactly two blocks of 135 and 71.

### What is actually wrong — it is not a shortage of tie-breakers

The key is `[tier, -facts_present, -urgency, -year1_band, name]` (`core/engine.ts:837-843`).

- **The name does the ordering.** The four terms carry 3.999 bits; a total order over 613 accounts
  needs 9.260. Walking the list top to bottom, **566 of the 612 consecutive steps are decided by
  the agency name** — tier decides 3.
- **Term 4 is dead weight.** Only 2 of 5 bands occur, 89% sit in one, and it is nearly a function
  of the tier: every Bronze and every Silver account is `$6K–16K`. It adds 8 rungs and removes
  **zero** from the largest tie group.
- **Three of four terms are defaults, not measurements.** 613 of 613 accounts take `year1_band`
  from the ICP prior and 613 of 613 take their base tier from the ICP class — an ordering the owner
  measured at **r = −0.135** against observable fit (§8). The key is two live terms wearing four.
- **The key already breaks rule 5, and it shipped.** `qualify()` counts only cells equal to
  `present`; `absent` and `unknown` both score zero. Of 2,452 qualification slots, **67.9% are
  `unknown` against 6.9% recorded `absent`**, and 125 of the 167 accounts at the floor of term 2
  have all four facts unknown with no recorded negative anywhere. Term 3 leaks the same way: **222
  of 389 Cold accounts are Cold from silence**, not from a stated "no timeline". Because Bronze and
  Cold are index 0 of their orders, *an unresearched agency is placed below a researched bad one.*
  Whether an unasked question should rank with a "no" is a **PRO-2r question for the register**, not
  a fix to make in `engine.ts`. It is the largest unknown-as-evidence exposure in the live
  instrument.

### Why a longer key was rejected

Three designs were built and each was judged against the rulings, the live data and the sales
desk. All three failed on measurement:

- **The material is not there.** Of the 135-account largest tie group, **exactly one** has an
  evidence-labelled fact, none has a call, and 102 have no scoring signal. Book-wide only 33 of 613
  accounts carry any evidence-labelled fact and 6,851 of 7,073 facts are `inferred`.
- **The ceiling is low and the frontier only moves.** Throwing *every* unused source at the key —
  decayed total, real-signal count, evidence-fact count, open-deal flag, Apollo headcount — takes
  47 rungs to 182 and the largest tie from 135 to 72, and still leaves **497 of 613 (81%) inside an
  alphabetical tie**.
- **The best design moved 2 accounts.** Its flagship cohort, accounts with an open deal, went from
  mean position 233 to 214; the count inside the top 50 was 3 before and 3 after — the same 3.
- **The signals are a seed artifact.** 1,149 of 1,479 signal rows are weight-0 `prior_grade`. Of
  the accounts with a live positive signal, 37 of 50 are `manual_note` rows from the July Notion
  import, confined to 14–27 July 2026 and sharing one decay expiry. Ordering by signal recency
  orders by a one-time import that expires all at once.
- **Density is not value.** Inside the 135 group the largest silent agency is 62 employees and the
  largest noisy one is 17. A coverage tie-break puts the 17 above the 62 and calls it order.
- **`headroom` is `headcount × 8750`**, and headcount disagrees with Apollo on ~89% of rows where
  both exist (r = 0.253, biased low, `inferred` on all 463). It has the cardinality to break the
  tie and no business being trusted with it.

A 135-way tie is the instrument reporting, correctly, that it cannot rank those accounts. Under
PRO-0 an honest refusal outranks a fabricated order.

### Two procedural facts found on the way

- **The activation gate is blind to ordering.** Rule 4 says a new rubric version is previewed
  before activation, but `?rubric=…&preview=1` returns only `{account_id, name, from_tier, to_tier,
  from_status, to_status, changed}` (`_shared/score_pure.ts:95-107`). A change that reorders the
  entire book without moving a tier previews as **no change at all**. Any future ordering work must
  extend the preview diff first, or it ships unreviewed.
- **Nothing stamps the engine.** `rubric_fingerprint` is `fingerprint(rubric)`, so an engine-only
  key change writes differently-ordered reads under an identical stamp. See `docs/BASELINE.md` §1.

### What actually fixes it, in order

Each step is cheaper than the key change and each makes the *next* measurement of the key honest.

1. **Work the identity queue** — 75 rows, 48 from Orbit, and 38 of those accounts are in the live
   Ranked list. This is a fault in *who is on the list*, which outranks a fault in their order.
   §7 P1 already called it the first place it pays.
2. **Set `PB_ANTHROPIC_API_KEY`.** It lights the `fathom_call` sweep with no second credential and
   starts producing the evidence-labelled facts any tie-break needs to be honest.
3. **Work the 37 Dimension A fact candidates.** They move `facts_present` — a term the key already
   has — with no rubric change at all.
4. **Then, and only if the top-of-list complaint persists**, revisit the key. The complaint is real
   in one place: restricted to the top 100 the material *is* there (70 carry a real signal, 54
   carry Apollo, only 16 are featureless), and those 100 accounts get 21 rungs with a 23-way tie at
   positions 71–93. That is the zone two raters can cover, and it is worth fixing on its own.

Anyone doing step 4 must first fix a latent rule-4 violation: **the key's terms and directions are
hard-coded in `engine.ts:837-843` while the rubric's `chase_rank_key.keys` is read only by
`explain/generate_method.ts`** — it is documentation, not data. Changing the engine alone would
leave `METHOD.md` §15 confidently wrong and `method_test` green, because that test asserts only
that the rubric's five strings appear in the doc and has no engine coupling at all.

And it must be **additive**: `chase_rank_key` is typed `[number, number, number, number, string]`
(`core/prospect_types.ts:385`), and appending to that tuple is a retype, which CLAUDE.md forbids.
A new nullable sibling key leaves the frozen order stored, recoverable and reportable as
BASELINE §4's pre-registered ranking #1, with the refinement entered as an additional ranking
rather than replacing it.

---

## 11 · One meeting, several recorders (13 September 2026)

`pb_calls` was keyed on `fathom_recording_id`. That is the identity of a **recording**, and
Fathom issues one per **recorder** — so a call several WLIQ people sat on with Fathom running
wrote one row each, and the nightly sweep read every one of them and extracted the same facts
over again.

Measured against the live table: **four of the twelve rows were one meeting** — four recording
ids, one account, one title, `held_at` spanning eleven seconds, four different `recorded_by`
addresses. A third of the table.

### What the four rows actually agreed about

Choosing the key meant checking, not guessing. Across those four rows:

| | |
|---|---|
| `held_at` | **differed** — 18:02:12, :15, :20, :23; each recorder's own start |
| internal attendees | **differed** — Fathom substitutes the recorder's own address into the invitee list, so one row carried a colleague the other three did not |
| title | identical |
| **external** attendees | identical — they come from the calendar invite, not from the recorder |

So an attendee-set match would have failed on exactly the row it most needed to catch. The key
is the **UTC date, the normalised title, and the external attendee addresses**
(`meetingKey()`, `ingest/fathom_webhook.ts`).

### Why no time window

A window has to be evaluated against rows already stored, which a pure function cannot see, and
bucketing a timestamp only moves the problem to the bucket edge. The date does the separating
instead: a weekly call with the same title and the same people is correctly two meetings.

The one case this gets wrong is a call whose recorders straddle UTC midnight — they key apart
and the meeting stays duplicated. That is the failure direction to want: it degrades to the old
behaviour rather than merging two meetings that were never one.

### Collapse at read time, not at write time

Every recording keeps its row. The extra recorders are evidence the meeting happened and each
may hold a different transcript, so nothing is deleted and nothing is refused on write. The
sweep picks one row per `(account_id, meeting_key)` instead
(`oneRecordingPerMeeting`, `ingest/notes_sweep.ts`).

Two rules there are deliberate, and both are the same rule the engine follows elsewhere:

- **A null key is never grouped with another null.** A recording with nothing to key on stays
  its own meeting rather than collapsing into every other unkeyable one — unknown is not a
  bucket you can be sorted into.
- **The representative is the earliest recording id, chosen without reading content.** They are
  summaries of one conversation, so there is nothing to choose between them; a content rule
  ("the longest summary") would hand the meeting to a different row whenever a summary was
  revised, and the book would read a call it had already read.

The sweep also selects **before** applying its watermark, not after. Filtering by the watermark
first would let a second recorder's row, touched later than the one already swept, arrive alone
and be read as a meeting of its own — which is the original defect wearing a different hat.

### Why this is not only tidiness

§10 rejected ordering the book by evidence density, partly because density is untrustworthy.
Duplicated calls are one of the reasons it is untrustworthy: they inflate the fact counts that
any such ordering would read. This does not make density trustworthy — 33 of 613 accounts carry
an evidence-labelled fact and that does not change — but it removes one way the count could
have been wrong.

### State

The column and the back-fill are applied (`20260913200000_prospect_book_call_meeting_key`);
all twelve stored rows now carry a key and resolve to **nine meetings**. The code is committed
and the bundles are built, but **pb-fathom-webhook and pb-notes are not yet redeployed**, so
the webhook still writes rows without a key until they are. That is safe in the meantime: an
unkeyed row is its own meeting, which is the behaviour that was there before.

The ~175-meeting Fathom back-fill from 19 August has still never run. It goes through this same
parser, so it will key its rows on the way in — but it must run **after** the redeploy, or it
will import the whole history unkeyed and in bulk.

---

## 12 · The book is a CRM mirror, and the roster is not all agencies (13 September 2026)

Asked whether the book is really reading Fathom, the notes and the other sources, the answer is
no, and the measurements are worth keeping.

### What the book is actually made of

Of 7,073 facts, **5,729 are scraped Pipedrive fields** labelled `inferred`. The three most
numerous facts in the entire book are `pipedrive_salesperson` (638), `pipedrive_cj_deal_id` (637)
and `pipedrive_cj_stage` (637) — CRM plumbing, not knowledge about an agency. The single most
common recorded fact about a prospect is **the name of the WLIQ salesperson assigned to them**.

Facts that came from a conversation: **88**, across 25 of 680 accounts. **638 of 680 accounts
carry no evidence-labelled fact at all.**

| Source | accounts reached |
|---|---|
| `pipedrive_note` | 21 |
| `fathom_call` | 7 |
| `email` | 0 — no credential |
| Orbit | 0 facts; identity candidates only |

### Why that breaks MQL → SQL

Dimension A is the qualification read. Where its four facts come from:

| | someone said it | read off a CRM field |
|---|---|---|
| `authority` | 5 | 313 — a job title containing "VP" or "Director" |
| `timing` | 3 | 404 — a deal stage or close date |
| `specification` | 14 | 45 — a deal in Refine/Discussion |
| `money` | 6 | 69 — a number typed into a deal |

**97% of qualification is inference from CRM plumbing.** An agency reads `authority: present`
because somebody's title says Vice President, not because they said they can sign. Until that
changes, a sales-qualified label is a restatement of what Pipedrive already held.

### Fathom, measured against the book

The book holds 12 recordings — 9 meetings — newest 19 August. The Fathom API returns **260
meetings between 11 August and 11 September alone**, with more behind the cursor. Among them:
"Ridge Media LLC : Riverside GBP report Walk Through" (3 Sep, twice), "WLIQ/Image Shoppe: Weekly
Meeting" (1 and 8 Sep), "Campfire Digital : Next Action Planning" (27 Aug). Ridge Media is
**rung 9** of the chase list; the book had never read a word anyone said to them.

### Three faults in who is on the list

1. **24 duplicate agencies**, 48 rows, 37 of them in the live chase list — almost all one
   certified Pipedrive row plus one uncertified Notion-seed row. Nettra Media occupied rungs 8
   and 28 simultaneously.
2. **104 accounts with no domain.** Domain is the join key for attributing a call or an email, so
   those accounts are structurally unreachable by Fathom or Gmail however often the sweep runs.
3. **153 of 613 ranked accounts are recorded `is_agency: false`**, and 116 are ICP-6 (direct end
   client). A quarter of the chase list is companies WLIQ does not sell to — restaurants,
   plumbers, shipping firms — plus rows named `Test`, `TBD`, `None`, `not yet`, `Individual`, and
   several that are people rather than companies.

### What was done

- **18 duplicates merged** through `pb_merge_accounts`, each recorded in `pb_register`. The
  certified Pipedrive row survives (PRO-6); the Notion row's facts, signals, contacts and
  candidates move to it. 680 accounts → 662.
- **Ridge Media LLC given its domain** (`ridgemediallc.com`), evidenced by the external attendee
  on two Fathom recordings, and recorded in the register.
- Re-scored: 601 ranked, 54 unclassified, 7 parked, 0 errors.

### What is left, and who owns it

- **5 duplicate pairs carry two different domains each** — Altitude Marketing vs Altitude
  Marketing & Media Partners, Bloor Advisory vs Bloor Capital, Arcanum, BCom, Dynamic Marketing
  Consultants. These may be separate companies rather than duplicates; a person decides (rule 8).
- **Two rows named `TBD`**, both Pipedrive placeholders, are not agencies and should leave the book.
- **85 accounts still lack a domain**, but only about 20 are real agencies. The rest are the
  non-agency contamination above. Their contact emails are no help: 64 of them have one and every
  single one is a personal mailbox (54 are gmail).
- **The non-agency question is a ruling, not a cleanup.** PRO-4 keeps direct-to-client in scope
  with a flag; whether 153 ranked non-agencies should be parked instead is the owner's call, and
  nothing here pre-empts it.

---

## 13 · One roster, several books (13 September 2026)

Correcting §12. The 153 ranked rows recorded `is_agency: false` are **not contamination** — they
are a different cohort. WLIQ holds several relationships, each needing the same evidence and a
different grade (owner, 13 Sep 2026):

| Cohort | Standing today |
|---|---|
| **Agency partners** | the core focus; the only cohort rubric 0.1.0 actually describes |
| **Direct clients** | also a focus; graded today as though they were agencies |
| **Peer communities** | critical for longer-term growth — AMI, BABA, the Think Tank |
| **Friends of WLIQ** | a real Pipedrive Client Journey stage (69) |
| others | the vocabulary is not yet complete |

**The same data matters for every cohort. The grading does not.** Agency partners are the focus
now; the other cohorts' grading is later work.

### What the book actually held

`pb_accounts` had no cohort dimension at all — only `relationship_type` (agency 422, direct 158,
null 81), which covers two of them. Nothing for peer communities or Friends of WLIQ.

And the gap is not theoretical: **all 31 Friends-of-WLIQ organisations in Pipedrive are absent
from `pb_accounts` entirely** — among them *Agency Management Institute*, AMIN Worldwide,
Predictive ROI, Sakas and Company, Agency Builders and Dynamic Agency OS. The rubric carries an
adjustment, `ADJ-REF`, that rewards a "referral from the Brian / AMI / BABA network", and it fires
on real accounts — while the network it names is tracked nowhere in the book.

That stage also mixes cohorts: peer bodies sit beside vendors (WP Engine) and ordinary agencies
(Spindustry, SJ Innovation, B Squared Media). "Friends of WLIQ" is a journey stage, not a cohort,
and cannot be lifted wholesale.

### What was done

`20260913160000_prospect_book_account_cohort` adds a **nullable, unconstrained** `cohort` column
and derives only what the book already states:

| cohort | accounts | ranked | carry any evidence |
|---|---|---|---|
| agency_partner | 422 | 410 | 29 |
| direct_client | 170 | 167 | 9 |
| (unassigned) | 61 | 23 | 4 |
| not_a_prospect | 9 | 1 | 0 |

No check constraint: the vocabulary is the owner's and is not yet complete, so nothing here
forecloses it. **No grade changed** — the column records which book a row belongs to so grading
can be scoped per cohort later. Today the chase list still mixes 410 agency partners with 167
direct clients, because rubric 0.1.0 has one rubric and applies it to everyone.

### The vocabulary, settled for now (owner, 13 September 2026)

Start with these five and add more later:

`agency_partner` · `direct_client` · `peer_community` · `friend_of_wliq` · `not_a_prospect`

**Agency partner is the focus. Direct client is registered as the next cohort to be graded.**
Peer communities and Friends of WLIQ keep collecting evidence and wait for their own grading.

### Orbit is the authority on which of the two a company is

The owner's instruction was to take the cohort from the labelling the source systems already
carry. Both were read:

- **Orbit `client_type`** — `Agency` (74) and `Direct Client` (26) across 601 clients, 90 of the
  100 typed ones also carrying a website. Orbit is where the work actually ran, so it is the
  authority on what a company is to WLIQ.
- **Pipedrive** turned out **not** to carry a cohort. Its organisation labels are empty on the
  rows checked, and the Client Journey deal labels are relationship qualifiers, not cohorts:
  `Personal Relationship with Brian`, `Pending For Relationship`, `New Inquiry 2026`. "Friends of
  WLIQ" is a *stage* in that pipeline, not a label, and it mixes peer bodies with a hosting
  vendor and ordinary agencies — so it cannot be lifted wholesale into a cohort.

46 book accounts matched a typed Orbit client on domain or exact name. **10 were corrected or
filled**, each recorded in `pb_register` with the Orbit client id, its `client_type` and how it
matched — four that Orbit calls an Agency were sitting outside the agency focus, and *Call to
Freedom*, currently rung 5 and graded Gold as an agency prospect, is a Direct Client in Orbit.

| cohort | accounts | ranked | confirmed by Orbit |
|---|---|---|---|
| agency_partner | 430 | 416 | 25 |
| direct_client | 168 | 164 | 3 |
| (unassigned) | 55 | 20 | — |
| not_a_prospect | 9 | 1 | — |

### What is not settled

- **Scoping the grade to `agency_partner`.** A rubric change and a new version, not a column
  default. Until it lands the chase list still mixes 416 agency partners with 164 direct clients.
- **Grading for `direct_client`** — registered as the next cohort, not yet designed.
- **Loading `peer_community` and `friend_of_wliq`.** The 31 Friends-of-WLIQ organisations are
  still absent from `pb_accounts`, and a peer body still has to be told apart from a vendor.
- **The remaining 55 unassigned**, of which 20 are ranked.

## 14 · The conversation arrives, and it changes what the CRM said (13 September 2026)

The back-fill of §12's finding ran today. `pb-fathom-webhook` had only ever been told about
meetings recorded after it was created on 12 September, so the book held thirteen calls. Fathom
held the rest.

### What ran

The crawl fetched inside Postgres — `PB_FATHOM_API_KEY` never leaves Vault, and the build
container has no route to `api.fathom.ai` in any case — and each staged meeting was then
**replayed through the live webhook** with a genuine Standard Webhooks signature. That is the
design decision worth keeping: attribution, `meeting_key` and the identity-candidate rules are
the production ones by construction. A back-fill with its own parser would have been a second
implementation of `ingest/fathom_webhook.ts`, free to drift from it in silence.

| | |
|---|---|
| Meetings crawled | **1,800** (13 Feb → 12 Sep 2026, 180 pages, 1 rate-limit miss recovered) |
| Replayed | 987 — every meeting with an external attendee, all verified, none failed |
| Skipped | 813 with no external attendee |
| Recordings → meetings | 987 rows collapsed to **807 meetings** by `meeting_key` |
| Attributed to an account | 161 rows across **83 accounts** |
| Read by `pb-notes` | 129 meetings, in nine runs |
| Facts written | **263**, every one evidence-labelled, across 66 accounts |
| Claims queued, not written | 418 fact candidates; 874 identity candidates |

**Why 813 meetings were skipped.** A meeting with no external attendee cannot be attributed to
an account, so it can carry no claim about a prospect; replayed, it would have added 813
unattributed `pb_calls` rows that `pb-notes` never reads. They stay in `pb_fathom_backfill` with
status `skipped` — nothing was deleted, and flipping the status replays them if internal
meetings are ever mined for prospect mentions.

### What it changed

Facts that came from something a person actually said went from **88 to 320**. Accounts holding
at least one evidence-labelled fact went from **42 to 91**.

And the precedence rules did the work they were written for, out loud, in `pb_runs.errors`:

- *"is_agency: the note disagrees with pipedrive — the note wins and the row is flagged."*
- *"headcount: the note disagrees with apollo — the note wins and the row is flagged."*
- *"timing: held by pipedrive_note (evidence) and the note disagrees — queued for review, not written."*
- *"Note 154109412: the sentence offered for money is not in the note; the claim is kept for
  review but can never become a fact."*

The first two are a conversation overruling a CRM field. The third is evidence against evidence,
which is a person's call and not the engine's. The fourth is §9's quote check refusing a sentence
the model could not point to — the guarantee that an invented quote cannot reach `pb_facts`.

### What it did not change

**The chase order still collapses.** Ignoring the name tiebreaker, 680 accounts resolve to 61
distinct keys, 25 of them alone, 503 accounts sitting in ties of twenty or more, and the largest
single tie is 134. Before the back-fill it was 47 keys and a largest tie of 135. §10 said the fix
is evidence rather than a longer key; this is the first real evidence and it moved the tie by
almost nothing, because it landed on 66 accounts out of 680.

That is not a failure of the back-fill. It is the measurement that §10 asked for, and it says the
remaining 589 accounts are still graded on CRM fields alone.

### The finding underneath

Of the top forty companies by meeting count over seven months, **four are accounts in the book**.
The busiest — 39 meetings, the most recent three days ago — is not one. Neither is Agency
Management Institute, at twelve meetings, whose network `ADJ-REF` exists to reward.

So the roster and the calendar disagree about who WLIQ's prospects are, and the calendar is the
one with evidence behind it. 874 identity candidates across roughly 120 external domains are
queued for review; that queue, not another rubric change, is where the next real movement is.
Rule 8 holds — a person decides which of those domains becomes an account.
