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
| 4 | Who rates prospects and holds the override lane? | **PRO-5 (revised):** the two sales raters rate their own rows; Brian may stand in, recorded as a stand-in; **Brian alone overrides**. A third rater lane is retired. PRO-2r: there are no judgment questions — raters enter **facts**. | `pb_members.role` = owner / rater / viewer; `pb_facts.entered_by` + `stand_in`; override insert policy is owner-only; per-rater comparison is a first-class report (later phase). |
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
meetings between 11 August and 11 September alone**, with more behind the cursor. Among them a
report walk-through with a chase-list agency (3 Sep, twice), a weekly meeting with another
(1 and 8 Sep), and a next-action planning call with a third (27 Aug). The first of those is
**rung 9** of the chase list; the book had never read a word anyone said to them.

### Three faults in who is on the list

1. **24 duplicate agencies**, 48 rows, 37 of them in the live chase list — almost all one
   certified Pipedrive row plus one uncertified Notion-seed row. One agency occupied rungs 8
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
- **One account given its domain**, evidenced by the external attendee on two Fathom recordings,
  and recorded in the register.
- Re-scored: 601 ranked, 54 unclassified, 7 parked, 0 errors.

### What is left, and who owns it

- **5 duplicate pairs carry two different domains each** — in three of them one name is a
  lengthened form of the other (an agency and an agency "& Media Partners"), in the rest the two
  names share a first word only. These may be separate companies rather than duplicates; a person
  decides (rule 8).
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
from `pb_accounts` entirely** — the owner's peer network: the agency-owner membership body he
belongs to, two agency-buyer networks, a research partner, a consultancy and two operator
communities. The rubric carries an adjustment, `ADJ-REF`, that rewards a referral from exactly
that network, and it fires on real accounts — while the network it names is tracked nowhere in
the book. (Named here originally; shaped on 16 Sep when those organisations entered the roster
and rule 2 began to bite — see the note at the end of §28.)

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

---

## 15 · The calendar does not disagree with the roster (13 September 2026)

§14 closed by saying the roster and the calendar disagree about who WLIQ's prospects are, and
that the calendar is the one with evidence behind it. That reading was wrong, and this section
corrects it. The cross-reference §14 left unfinished has now been run, and it says the opposite.

### What was measured

Every external domain carrying an open Fathom identity candidate — 183 of them, 659 meetings over
seven months — was matched against three sets: the Orbit client list, every Pipedrive
organisation, and `pb_accounts`. For each domain that matched a Pipedrive organisation, the most
recently updated **open** Client Journey card was read and its stage compared against the roster
rule in `scripts/seed_README.md`.

| Class | Domains | Meetings |
|---|---:|---:|
| Card in Active / Inactive / Past / Lost Client | 68 | 453 |
| No record in Pipedrive, Orbit or the book | 69 | 93 |
| Card in Friends of WLIQ | 9 | 39 |
| Orbit client, no Client Journey card | 10 | 29 |
| Pipedrive organisation, no open card | 13 | 20 |
| Already an account, domain column blank | 4 | 14 |
| Card in a prospect stage, absent from the book | 5 | 10 |
| Already an account with a domain | 5 | 1 |

### What it means

**453 of 659 meetings — 69% — are with companies whose card is in a partner stage.** PRO-10
excludes those by design: *cards in Active / Inactive / Past / Lost Client are Agency Partners and
never enter.* A further 39 meetings are Friends of WLIQ, which the same rule calls not a sales
relationship. The exclusions match the rule exactly.

The check in the other direction agrees. Of the 680 accounts in the book today, **one** now sits
in a partner stage — a card that moved on 11 September, which is a promotion to process under
PRO-18, not a leak.

So the roster is not out of step with the calendar. The calendar is mostly partner work, and this
book is not for partner work. A busy domain is evidence of a relationship, never evidence that
the relationship is a prospect — the same shape as rule 5, one level up: **volume is not a
qualification.** Nothing here is a new ruling; it is PRO-10 applied to a list that looked like a
gap and was not.

### The two real gaps

**Five prospect-stage cards are absent from the book.** All five postdate the 9 September seed.
The gap is therefore not a seed defect but a missing habit: nothing re-runs the roster. A
recurring roster sync closes it permanently; adding the five rows by hand does not.

**The uncertified Notion intake splits the book, and the split is nearly closed.** Of the 39
accounts carrying no `pipedrive_org_id`, **18 were already merged in an earlier session** —
`pb_merge_accounts` clears the duplicate's `pipedrive_org_id` when it retires the row, so a
count taken on that column alone reads a resolved merge as an open one. Counting live rows
instead (`book <> 'merged'`) left **five** exact-name pairs open, the same five §14's handoff
called ambiguous.

Ambiguous was the right word, and the reason is instructive: in all five the names matched
exactly and the *domains did not*. Rule 8 refuses that, correctly — an exact name with a
conflicting domain is not high confidence, it is the shape a name collision takes. Resolving
them needed evidence about the companies, not a better string match:

| Pair | Evidence | Outcome |
|---|---|---|
| Two domains, one Orbit client carrying both | the client row lists one domain as its website and the other in its contact address | merged |
| Two domains, one company publishing both | the certified site publishes the other domain as its own contact address | merged |
| Two domains, one company operating both | the company's own listings name both as its sites | merged |
| Same name, different cities | two agencies, different states, unrelated | **not** merged |
| Same name, different markets | two agencies, different specialisms, unrelated | **not** merged |

Three merged on 13 September, moving 45 facts, 14 signals, 5 contacts and 4 identity candidates
onto the surviving certified rows. The two collisions are recorded as `decision` rows on the
accounts themselves so the next sweep does not re-open them.

So the book is 659 live accounts and 659 companies, not 680 rows over some smaller number of
companies: the duplication was real but had largely been worked already. Two of the five
remaining were never duplicates at all. The high-key attach rule stays exactly as it is — the
five it deferred were five it *should* have deferred, and two of them would have been wrong to
merge. That is the rule earning its keep, not failing.

A separate five accounts, also from the Notion intake, duplicate a Pipedrive organisation whose
card is in a partner stage. Those are not in-book duplicates — the partner-stage organisation
never entered the book — so they are not a merge. They are rows PRO-10 would have refused had
the intake carried a CRM link, and what to do with them is the cohort scoping question below.

### What this does not decide

Whether a partner-stage company should be readable in this book at all is the cohort scoping
question — rubric 0.1.1, offered on 13 September and deferred in favour of the back-fill. It
stays a toggle, not a ruling. This section only records that the current exclusions are correct
under PRO-10 as written, and that the roster needs re-running rather than re-deciding.

## 16 · What actually blocks rubric 0.2.0, measured (14 September 2026)

§8 left 0.2.0 unactivated for a stated reason: the six fit criteria are unanswered for most of
the roster, so activating would "restate the roster's ignorance as a demotion". That was the
right call, and it named two directions without measuring either. This section measures both.

The count is over the 659 accounts with `book in (prospect, parked)`, against `pb_current_facts`.

### Per-criterion coverage

| Criterion | Accounts answered | Share | Of which `evidence` |
|---|---|---|---|
| `is_agency` | 565 | 85.7% | 44 |
| `headcount` | 454 | 68.9% | 10 |
| `sells_build_work` | 189 | 28.7% | 34 |
| `no_inhouse_dev_team` | 175 | 26.6% | 30 |
| `recurring_work_shape` | 20 | 3.0% | 20 |
| `client_budget_size` | 6 | 0.9% | 6 |

The shortfall is not spread evenly — it is concentrated in **two criteria**. Gold needs
`min_yes >= 5` of 6, and two of the six are recorded for under 3% of the book, so the Gold band
is closed by arithmetic to all but **13 accounts (2.0%)**. That is the whole of §8's finding,
located: it is not that the roster reads badly, it is that `client_budget_size` and
`recurring_work_shape` are almost entirely unrecorded.

Answered-count distribution today: 6 answered — 3 accounts; 5 — 10; 4 — 153; 3 — 23; 2 — 267;
1 — 126; 0 — 77.

### What clearing the review queue would do — and would not

`pb_fact_candidates` holds **418 proposed rows**, and they are weighted towards exactly the two
thin criteria: `client_budget_size` 44 proposals over 36 accounts, `recurring_work_shape` 37 over
33, `sells_build_work` 50 over 37, `no_inhouse_dev_team` 46 over 35. So the extractor is finding
these; nothing is being collected badly.

Confirming **every** proposed candidate would move the book to:

| | ≥ 5 answered (Gold reachable) | ≥ 3 answered (Silver reachable) | < 3 answered |
|---|---|---|---|
| today | 13 | 189 | 470 |
| whole queue confirmed | 54 | 202 | 457 |

That is the number worth having. Clearing the queue **quadruples** the rows that can reach Gold
and barely moves everything else: 457 of 659 (69%) would still have fewer than three of six
answered. **Clearing the queue is necessary and not sufficient.** Activating 0.2.0 on the far
side of a fully-worked queue would still demote most of the book for want of evidence, so §8's
conclusion stands on measured ground rather than on estimate.

### The queue has nobody to work it

418 proposed, and **3 candidates have ever been reviewed**. `pb_members` holds 2 owners and
**0 raters**. The review queue and its UI were built, and then no one was given the lane to use
them. This is the cheapest unblock on the list and it is not a code change.

### One stale note corrected

§8 records `pipedrive_note` and `email` as "dark for want of their credentials".
`PB_PIPEDRIVE_API_TOKEN` went into Vault on 12 September and the sweep has been running since —
`pb_facts` 7,007 → 7,305 and candidates 10 → 418 over the three days. The Pipedrive channel is
no longer dark. `PB_PIPEDRIVE_WEBHOOK_BASIC` is still unset, which is a different gap.

### What this does not decide

`unclassified_when_answered_below` stays a toggle at **1**, and one answered criterion is still
enough to publish a tier — the rule-5 leak §8 identified is unchanged and unruled. Nothing here
activates 0.2.0 or moves a threshold. It measures the two directions §8 offered so the owner can
choose between them with the numbers in hand.

## 17 · Climb evidence is engagement depth, not revenue history (owner ruling, 14 September 2026)

**Ruled.** This settles the climb-evidence requirement, one of the five July elements the ledger
records as never ruled. It stays a rubric toggle; what changes is that it now has an answer and a
reason rather than an inherited default.

### What prompted it

The owner asked why the book showed only two anticipated Platinum rows. The funnel explains it:
Platinum requires adjusted tier Gold **and** a Partner ceiling **and** three of four Dimension A
facts, and adjustments are barred from reaching Platinum on their own. 106 accounts clear the
first. **Six** clear the second. The binding constraint is the ceiling, and the ceiling is capped
to Project without climb evidence — which 9 accounts of 680 carry, all of them from the original
Notion seed's "proof of growth" field. 228 rows are explicitly flagged `Ceiling capped: no climb
evidence`.

So the tier was not a judgement about those agencies. It was the absence of a recorded input.

### The ruling

The owner's reasoning: a prospect cannot show revenue history, because by definition it has not
invoiced. What it *can* show is **engagement depth** — expressed interest, evidenced.

Half of the inherited list asked for the wrong thing, and the published work on B2B selling names
the right ones precisely:

| Signal | Weight | Basis |
|---|---|---|
| 2nd person engaged | strong | Stakeholder expansion is the best-attested predictor of close in B2B — multi-threading is repeatedly measured at multiples of the single-threaded win rate (Gong, Demandbase) |
| Champion identified | strong | MEDDICC's champion test: someone spends political capital when we are not in the room. Good intel alone is a *coach*, not a champion |
| Structural break | strong | SPICED's Critical Event — a dated forcing function |
| Future-state language | weak | Gong: speaking as though the decision is made |
| Strategy question asked | weak | Coach-level interest; real, but demoted from its previous equal footing |
| ~~2nd project scoped~~ | retired | Requires a first project |
| ~~Referred someone~~ | retired | Requires a delivered outcome |

**One strong signal lifts the ceiling, or two weak ones** (`lift_requires: {strong: 1, weak: 2}`).
Previously any one signal lifted it, which put a strategy question on the same footing as a
champion.

Every surviving signal is a **quotable event** — a second person joined, they offered the executive
meeting, they said "when we roll this out", the deadline is March. None is an impression. That is
deliberate: the sweep's existing rails (verbatim quote, and the observation/judgement lexicon) then
do the quality control for free, and "seemed keen" cannot become evidence.

### What it changes, measured before activating

Only a row carrying climb evidence can move, so the blast radius is exactly those 9. Applying the
new rule to the current reads: **two rows change, both because `2nd project scoped` is retired.**
One drops from a Partner ceiling to Project and loses Platinum; one drops a Partner ceiling to
Project and keeps its tier. The other seven are unchanged — six carry a strong signal, one already
sat at Project.

**Anticipated Platinum therefore goes from two to one.** That is the honest short-term cost of the
ruling and it is recorded here rather than discovered later. The route back up is the extractor:
`climb_signals` is now extractable from the written record (`notes_sweep.ts`, prompt `notes@v4`), so
multi-threading and champion behaviour can be read from calls instead of waiting on a seed field
nobody fills.

### Where it lives, and what is not done

`core/rubric.prospect.v0.1.2.json`, registered in `pb_rubric_versions` as **draft**, spec sha256
`8e1e9207…`, rubric fingerprint `d8bc859e`. The stored spec was derived from the stored 0.1.0 by
patching the one path, and verified to differ from it in exactly `version` and
`potential.climb_evidence` and to match the repo file.

The engine picks its shape from what the rubric carries — `potential.climb_evidence.lift_requires`
present means weighted, absent means any-one-lifts — the same way the base tier picks between
`base_tier_from_fit` and `base_tier_from_icp`. **0.1.0 scores exactly as it did**, which is what
keeps the frozen baseline reproducible. `docs/BASELINE.md` warns that nothing in the data stamps
the engine, so an engine change has to be written down by hand: this is that record.

Not done, and each is deliberate:

- **Not activated.** 0.1.2 is a draft. And it must not be previewed against the deployed
  `pb-score` until that function carries this engine — §8 records exactly this trap, where a
  preview of 0.2.0 failed because the deployed function predated the branch that read its new
  key. A preview run before the redeploy would report the old any-one-lifts behaviour and mean
  nothing.
- **0.2.0 still carries the old climb block.** If the fit-criteria draft is ever activated it would
  silently restore the retired signals and the flat weighting. The two drafts need reconciling
  before either is activated.
- **The strong/weak split is a first setting, not a finding.** One strong or two weak is a
  judgement about relative evidential worth; the queue's confirm and reject rates per signal are
  what would turn it into a measurement.

## 18 · Three owner answers on sequencing, the lift bar, and what a vendor count means (14 September 2026)

Put to the owner after §17 was measured. Recorded here because two are rulings on how the book
proceeds and the third is a challenge to a locked method that this session did not resolve.

### 1 · Settle the fit read before spending on climb evidence — RULED

The measurement behind §17 turned up something that reframes it. **Every Gold row in the book is
Gold because of a stated ICP label, not an observation**: `criteria_answered` is 0 on all 659 live
rows, and all 100 Gold rows carry `base_tier_source = icp` with `icp_derivation = stated`. The
Platinum door needs fit Gold, so every Platinum-capable row rests on that label.

Draft 0.2.0 retires ICP as the fit read and needs 5 of 6 observable criteria for Gold; a score of 0
lands in the lowest band. Only 3 live accounts hold facts for five or more of the six, and one
criterion (`size_band_fit`) is recorded for none. So **under the fit ruling already drafted, at most
3 accounts could be Gold at all** — and therefore at most 3 could ever be Platinum, however much
climb evidence is gathered.

Ruled: settle 0.2.0 before any climb-evidence campaign. Collecting engagement evidence to unlock
Platinum rows denominated in a label already marked for withdrawal is work that may not survive its
own premise.

### 2 · The one-strong-or-two-weak bar was intended — CONFIRMED

§17 raised the bar as well as retiring two signals: under 0.1.0 any single signal lifted a ceiling,
under 0.1.2 a single weak one does not. That was put to the owner explicitly, together with the
observation that a keyword proxy over the call summaries finds strategy-question language in 87 of
158, against 29 for champion or second-person language and 12 for a dated forcing event — so the
rule halves the weight of what the calls most often contain.

Confirmed as ruled. A strategy question is coach-level interest, and the bar stands. 0.1.2 needs no
change.

### 3 · A vendor count is potential, not only dilution — OPEN, and the method is wrong as written

The owner was asked whether to start recording vendor rank, on the grounds that all 143
Partner-proposed rows run on a defaulted `winnable_share` of 0.5 and there is not one vendor-rank
fact in the book. He rejected the framing, and the arithmetic supports him.

The wallet-allocation rule is `winnable = (1 − our_rank/(n_vendors+1)) × (2/n_vendors)`. Holding
rank at #1:

| Vendors | Our share at rank 1 |
|---|---|
| 2 | 0.667 |
| 3 | 0.500 |
| 4 | 0.400 |
| 5 | 0.333 |
| 6 | 0.286 |

The wallet it multiplies is `headcount × revenue_per_head × outsourceable_share × serviceable_share`
and **does not contain `n_vendors` at all**. So vendor count enters the model once, as a divisor.
An agency buying the work we sell from six vendors scores lower headroom than one buying from two,
even when we are its first choice — although using six vendors for this work is itself evidence that
it buys a great deal of it.

The owner's reading: multiple vendors means they are selling a lot of what we do, which is more
opportunity, not less; and being second is a position that can be improved, not a fixed property.
Both are about a PROSPECT, where we may not be a vendor at all yet and rank is a starting point.

**Not resolved here.** The headroom method is locked (PRO-16) and this is a change to it, so it is a
ruling and not a patch. What the next session needs to decide: whether `n_vendors` should also raise
the wallet (as evidence of outsourcing volume) rather than only divide our share of it, and whether
`our_rank` should be read as a current position with a climb path rather than a fixed allocation.
Until then, the defaulted 0.5 stands on all 143 rows and the ceiling it produces should be read as an
assumption, not a finding.

## 19 · The fit read asked the wrong question about developers (owner ruling, 15 September 2026)

Found while working the fact queue by hand, one claim at a time — which is the only reason it was
found at all.

### What happened

One account is a thirty-year-old New England agency. The owner was on site on 20 August; their
web/ops director closed the meeting with *"I'm ready to go. I'm sold."* They run dozens of sites,
their workload swings between 5 and 500 hours a month, and they had just been burned by an offshore
vendor. They are, by any sales reading, one of the better prospects in the book.

While confirming their facts the owner supplied one more: **they have a developer, plus a new hire
to lead the dev team.** Recorded honestly, that is `no_inhouse_dev_team = false` — and under draft
0.2.0 it scores AGAINST them. Gold needs five of six criteria; this took one away from an agency
that had just said it was sold.

The rubric predicted this in its own words. The criterion's `failure_mode` read:

> The strongest single predictor in the July research and the easiest to get wrong: a two-person
> dev team can mean overflow need, not no need.

Miranda is that sentence, live. The criterion asked *"is there a developer in the building"* when
the thing that predicts a sale is *"do they have more build work than they can absorb"*. Miranda
answers no to the first and yes to the second.

### Ruled

Re-word the criterion, before 0.2.0 is activated. Put to the owner as three options — leave it,
re-word it, or park it as an open ruling — and re-wording was chosen, on the grounds that the
failure mode had just been demonstrated on a live prospect and 0.2.0 is not yet active, so the
change costs nothing today.

### How it was implemented, and the one constraint that shaped it

`core/prospect_types.ts` takes **additive, nullable changes only** — never rename, retype or
repurpose an existing key (§8). So the criterion could not simply be re-read against
`no_inhouse_dev_team` with a new meaning. That would have silently changed what 175 already
collected facts assert.

Instead:

- a NEW nullable feature, `build_demand_exceeds_capacity`, asks the question that predicts a sale;
- `no_inhouse_dev_team` keeps its meaning, its facts and its resolver untouched;
- the criterion (now keyed `build_capacity_gap`) reads the new feature and declares
  `fallback_feature: "no_inhouse_dev_team"`. The engine reads the fallback **only** when the
  primary is null, never as an override, and the trace records `answered_by` so a reader can
  always tell a direct answer from a stand-in.

Having no developer at all is one way to have a capacity gap. It is not the only one, and it was
never the interesting one.

The fallback is resolved in the ENGINE, not in `resolve_features.ts`, on purpose: resolving it in
both places would collapse the distinction between "they told us demand overruns them" and "we
inferred it because nobody is listed on the team page", which is exactly the distinction this
ruling exists to preserve.

Rule 5 is untouched: if both features are null the criterion is unanswered, scores nothing, and
counts neither way.

### What this does not settle

The new feature has no collector yet. Every account answers this criterion through the fallback
until someone records `build_demand_exceeds_capacity` — so in practice 0.2.0 behaves today exactly
as it did before the re-wording, and improves only as the new fact is gathered. The obvious source
is the portfolio read discussed the same day: an agency that lists build services while
outsourcing them, or advertises for developers it cannot keep, is telling you about its capacity.

Miranda's own three facts were recorded during the session that produced this ruling:
`client_budget_size = buys_real_projects`, `sells_build_work = true`, `no_inhouse_dev_team = false`
— the last with the reasoning above in its note, so the record shows why a false there is not the
mark against them it looks like.

## 20 · Potential stopped depending on engagement (owner ruling, 15 September 2026)

### What was wrong

Two words had been welded together. **"Project" is a size** — a headroom band under $35K.
**"Cold" is a behaviour** — and it changes the moment someone engages. The climb-evidence rule
joined them:

> The ceiling may not exceed Project without at least one observed climb signal.

Basis: `unruled_default`. Never ruled; adopted by the build from the July stage notes.

Measured on 14 September, across 499 prospects:

| Platinum gate | Passing |
|---|---|
| adjusted tier = Gold | 95 |
| qualification present_count ≥ 3 | 38 |
| **ceiling = Partner** | **6** |
| all three → Platinum | **2** |

492 accounts sat at a Project ceiling — including accounts carrying **$9.6M of headroom** — and
**139 had headroom above the $100K Partner band**. They were not small. They were capped because
no climb signal had ever been recorded: the book holds 1,479 signals across nine types and **not
one** of the five the rule wants (2nd person engaged, Strategy question asked, 2nd project scoped,
Referred someone, Structural break).

So a gate that was never ruled, fed by a signal type nothing collects, was deciding how big every
prospect in the book could be. The owner's words: *"cold does not mean Project, cold is changed
based on engagement"*, and *"this is preventing me from properly assessing the potential of
prospects"*.

### Ruled

**Platinum is potential, not deal reality.** Owner, 15 September: *"platinum does not mean the deal
is real, it means that they have the potential to reach this level."*

Three axes, and each answers its own question:

| Axis | Question | Where it lives |
|---|---|---|
| **Tier** — Bronze → Platinum | What could they be worth? | `effective_tier` |
| **Confidence** — High / Medium / Low | How well do we know them? | `dimension_b.confidence` |
| **Engagement** — Super Hot → Cold | Are they live right now? | `signals.urgency` |

Interactions, calls and climb signals raise **confidence** and drive **engagement**. Neither touches
potential.

### The change, which is two deletions

1. `potential.climb_evidence.caps_ceiling: false`. Climb evidence is still computed, still traced,
   still part of the relationship — it no longer caps the size. The key defaults to **true** when
   absent, so 0.1.0 scores exactly as it always did (docs/BASELINE.md).
2. `qualification.present_count >= 3` removed from `dimension_b.platinum_rule`. It was already an
   input to `dimension_b.confidence` (High requires `present_count >= 3`) and already the second
   element of `chase_rank_key`. Gating the tier on it made one input do three jobs, and the tier
   job was the wrong one: it made Platinum unreachable for any agency we had not yet called.

Nothing was added. Both gates came out.

### What it produces, computed from the stored scorecards

Headroom and adjusted tier are unchanged by this ruling, so the new distribution is exact rather
than estimated:

| | 0.1.0 | 0.3.0 |
|---|---|---|
| Partner ceiling | 6 | **139** |
| Platinum | 2 | **66** |

The 66, by engagement: **7** Super Hot or Hot, **9** Warm, **50** Cold.

That last number is the point of the ruling. Fifty agencies with Platinum-level potential that
nobody has called, which the book previously displayed as Silver and Bronze. They are not a sales
queue — the owner: *"the cold prospect is more of a signal to invest in nurturing"*. Engagement
decides who to call; potential decides who is worth the nurture spend.

### What this does NOT change

- **A small agency is still small.** A one-person shop still ceilings at Project; an engine test
  pins it. The ruling removes a cap, it does not inflate anyone.
- **The chase order.** `chase_rank_key` still reads tier → qualification → urgency → year-one band,
  so a qualified Platinum still outranks a cold one.
- **`stated_timing_wins`.** Still true: an agency that said "no timeline" is still Cold even if it
  has since asked a strategy question. That was put to the owner and not answered, so it stands
  unchanged rather than being decided here.
- **PRO-8.** Every tier still prints UNVALIDATED. Sixty-six Platinums on an unvalidated rubric are
  sixty-six hypotheses, not sixty-six wins.

### Still open after this

- **Nothing collects climb signals**, so engagement and confidence are both thinner than they
  should be. §18 measured strategy-question language in 87 of 158 call summaries; none of it is
  extracted as a signal. That is now the highest-value collector to build.
- **`urgency` is the wrong name** for what it computes — a decayed sum of the prospect's behaviour.
  It describes *them*, not our obligation. Renaming it `engagement` was proposed and is not ruled.
- 0.3.0 is a **draft**. It is not activated, and `pb-score` must be redeployed before it can be
  previewed live — the deployed bundle predates `caps_ceiling` and would ignore it.

## 21 · Headcount was the wrong number (owner ruling, 15 September 2026)

### What was wrong

The wallet is `headcount × revenue_per_head × outsourceable_share × serviceable_share`, and
`revenue_per_head` is benchmarked at $150–200K from *"Promethean $163K avg, SPI $168K"* — revenue
per person **doing the work**. So the term headcount multiplies has always meant delivery capacity;
headcount was a proxy for it, and a good one while agency people were employees.

The owner: *"1 person can still be platinum, i have had 1 person clients that have a large client,
also, up top is 2 people with 30 contractors, agency models are changing, the difference is maturity
in the 1 person and their experience in running an agency."*

A two-person agency with thirty contractors delivers like a thirty-two-person shop and reads as 2.
The proxy is off by sixteen times, and it is off in exactly the direction the market has moved.

Measured across 499 prospects:

| Payroll | Agencies | Reach Gold | Partner-band headroom |
|---|---|---|---|
| 1–2 | 154 | 6 | **0** |
| 3–5 | 37 | 7 | **0** |
| 6–10 | 32 | 7 | 3 |
| 11–30 | 83 | 21 | 69 |
| 31+ | 67 | 44 | 67 |
| unknown | 126 | 10 | 0 |

**191 agencies at five people or fewer, none of which can reach the Partner band at any setting of
the other terms** — at the blended rate a five-person shop caps near $65K against a $100K threshold.
A further 126 have no headcount at all and so get no wallet.

### Ruled

**A. Delivery capacity replaces payroll in the wallet. Maturity is recorded, not an input.**

`delivery_headcount` — employees plus regular contractors, the people who actually deliver — is a
new nullable feature. The wallet prefers it and **falls back to `headcount`**, so every account
already scored is unaffected and nothing collected is lost. The trace carries `capacity_from` so a
reader can see which number was used.

`years_operating` is recorded, traced and printed, and **changes no number**.

### Why maturity is not a wallet input

Maturity does not make an agency bigger. A twenty-year-old solo shop is not a larger wallet than a
two-year-old one; where it has larger clients, `client_budget_size` already says so, and putting
maturity into the wallet would count that twice. What maturity plausibly predicts is delivery risk,
rate tolerance and whether a partnership lasts — ceiling-type, economics and confidence questions,
not size ones. It is recorded so those can be tested against outcomes before anyone wires it into
an arithmetic.

This also resolves an apparent contradiction in the same session. Of a one-person studio the
owner said *"they're really small too for one person… not quite meet the goal for
platinum"*, and of one-person agencies in general, *"1 person can still be platinum"*. Both hold: a
solo operator with a thirty-strong bench and enterprise clients has Platinum capacity; a solo
operator with neither has a good small business. Experience makes them a good client, not a big one.

### Why this is not a change to PRO-16

PRO-16 locks the headroom **method**. The formula is untouched — same terms, same order, same
shares. What changed is which measurement fills the capacity term, and the change restores the
method's own stated basis (revenue per person doing the work) rather than departing from it.

Deliberately **not** bundled with §18.3, the open vendor-count question. That one would change the
formula's shape — whether `n_vendors` should multiply the wallet as well as divide our share — and
folding a correction into a redesign is how a locked method quietly stops meaning anything.

### A test that was wrong, and is now right

§20 pinned *"a one-person agency still ceilings at Project"* as a guardrail against the ceiling
ruling inflating anyone. It encoded precisely the assumption this ruling rejects. It now reads: one
on payroll **with no capacity recorded** ceilings at Project. The cap comes from not knowing, never
from being small.

### Still open

Nothing collects either fact yet, so every account resolves through the fallback and today's
numbers are unchanged — the same trap as `build_demand_exceeds_capacity` in §19. Both are
portfolio-readable: a team page gives capacity, a "founded 2002" line gives maturity, and at least
one account's own note already carries the latter unextracted. The collector is the next build, and until it
exists this ruling is potential rather than effect.

## 22 · Which source wins, and reading the agency's own site (15 September 2026)

### What was wrong

`pb_current_facts` resolved a contested key by `evidence_label`, then `created_at desc`. Within
one label that made **write order** the tiebreak — not a judgement about quality, an accident of
which seed ran last.

Measured across the prospect book on 15 September:

| | |
|---|---|
| accounts carrying a headcount from **both** Apollo and Pipedrive | 111 |
| of those, the two agree | 12 |
| median Apollo ÷ Pipedrive | **2.00** (upper quartile 9.25) |
| disagree by 2× or more | 69 |
| **land on opposite sides of the 12-person Partner threshold** | **38** |

Apollo wins 109 of the 111 today. Not because it is better: the Apollo seed ran 11 September and
the Pipedrive seed 9 September. Re-running the Pipedrive seed — which is how an account is
admitted (RUNBOOK §23) — writes rows dated today and silently flips all 109 back, moving 38
ceilings across a band. The rule below is a latch, not a repair: today's answer is right by luck.

### Ruled

One order, stated once, ranking a source by how close it is to someone who actually knows.
It sits **between** the evidence label and recency, so nothing here weakens rule 9's first clause.

```
rater  >  fathom_call  >  pipedrive_note  >  website  >  notion_master  >  apollo  >  pipedrive  >  (anything else)
```

An unlisted source sorts **last**, so adding a collector never silently outranks a person.

Apollo above Pipedrive is the one placement resting on evidence rather than principle, and the
evidence is thin — nine accounts have a headcount someone stated on a recorded call:

| Stated on the call | Apollo | Pipedrive |
|---|---|---|
| 100 | 400 | — |
| 16 | 17 | — |
| 15 | 36 | — |
| 15 | 9 | — |
| 11 | 11 | 30 |
| 4 | 3 | 6 |
| 1 | 1 | — |

Apollo is exact twice and within 25% four times of the seven it covers; Pipedrive overcounts both
of the two it covers. Both errors that matter are **overcounts**, which is the LinkedIn mechanism
showing through — Apollo's headcount counts profiles claiming the employer, so it carries alumni
and contractors. Since headroom is `headcount × $8,750` (§20), an overcounting source inflates
the whole book. n = 7 is a default, not a finding; it is written down so the next nine calls can
overturn it.

Effect on the book: twelve headcounts changed hands (Notion master list 12 → 24 winners, Apollo
163 → 154, Pipedrive 189 → 186). Nine changed value. Small, which is the point — the rule exists
for the flip that had not happened yet.

### The site is the source that should win

The owner, 15 September: *"use the site and do what is needed for accuracy."*

A team page is the number an agency will defend in public, and unlike LinkedIn it shows **roles** —
which is what separates "eleven people" from "eleven people, two of whom build things", i.e.
`delivery_headcount` (§21). So `website` is ranked above Apollo and Pipedrive and below anything a
person said.

Migration 20260915130000 gives `pb_website_reads` a `path` column, so one row is one page, and
lets the caller name which paths to try. Sub-pages are only queued for an account whose front page
already returned 200 — no point spending five requests on a domain that does not resolve.

Nothing here writes a fact. The fetch stores text; extraction stays with pb-notes, behind the
quote check, the judgement check and `pb_fact_candidates` (rule 8). A machine reading a team page
proposes; a person decides.

## 23 · Rule 2 was broken for five days, and what that costs (16 September 2026)

**Not a ruling. A breach of an existing one, found and repaired here so it is on the record.**

Rule 2 says no prospect data in this repository, because the repository is public. On 16 September
a check against the account roster found **26 distinct agencies, two real people, two agency
domains and two per-account deal values** in tracked files:

| Where | What | Since |
|---|---|---|
| `docs/PLAN.md` | fifteen agencies, a $47,955 deal, a $117–141K deal, a colleague's first name | 16 Sep |
| `docs/RUNBOOK.md` §26 | two agencies with their headcounts | 16 Sep |
| `20260916090100` (comment) | the same two | 16 Sep |
| `docs/DECISIONS.md` §§4, 13, 19, 21 | thirteen agencies, one domain, three meeting titles, a colleague's first name | 11–13 Sep |
| `ingest/fathom_webhook_test.ts`, `notes_sweep_test.ts` | a real colleague's full name against a barely disguised agency domain, in a fixture | 11 Sep |

*(The first count written here said "fifteen agency names", which was the PLAN.md figure read as
the total. The number is 26 across all five rows. Counting by hand is how it got to 26 in the first
place; the script below is the count.)*

Every one is removed at this commit. The passages keep their substance — an example becomes "a
counted 35 rather than Apollo's 68", a fixture becomes a genuinely invented name — because the
point each was making was never the identity.

**Removing them from `HEAD` does not remove them from history.** The repository is public
(`visibility: public`, confirmed by API, not assumed), so those commits have been fetchable since
11 September and remain so. Three options, and the choice is the owner's:

1. **Make the repository private.** One switch, closes everything at once, including history.
   It does not un-publish what has already been fetched, but nothing new can be.
2. **Rewrite the branch history** and force-push. Removes the names from the commits; GitHub still
   serves an orphaned commit by its SHA for a while, and anyone with a clone keeps theirs.
3. **Leave history as it is** and hold the line from here. Defensible — these are company names and
   public headcounts, not secrets — but it is a decision, not a default.

Nothing here rewrites history on its own; that is an outward-facing, irreversible action on a
public branch.

**Why it kept happening:** every one of these entered as an *example* — the concrete case that made
a ruling legible. That instinct is right and the examples should stay; they just have to be shaped,
not named. A useful example is "an agency Apollo listed at 68 with 35 people on its team page".

**The check is now mechanical.** Pull `pb_accounts.name`, match every tracked text file against it
case-sensitively on word boundaries, and expect nothing. Run it before any commit that adds prose
to `docs/` or a comment to a migration. It found all fifteen in one pass and it costs one query.


## 24 · Engagement is recorded contact, not a stage label (owner ruling, 16 September 2026)

**Ruled.** The owner, 16 September, on the proposal to stop deriving engagement from the CRM
stage: *"for 5 and the stage labels, yes make this change, it does not seem accurate."*

### What was wrong

`urgency` came from a Pipedrive dropdown — Super Hot / Hot / Warm / Cold — and it was the heaviest
single input in every chase ordering. It carries no date, no direction and no source. Measured
against what is actually recorded:

| The CRM says | engaged | responsive | pursued | fading | dormant | nothing on file |
|---|---|---|---|---|---|---|
| Super Hot (15) | 2 | 5 | 0 | 5 | 3 | 0 |
| Hot (47) | 3 | 2 | 1 | 7 | 4 | 30 |
| Warm (178) | 3 | 1 | 0 | 5 | 1 | 168 |
| Cold (458) | 5 | 12 | 2 | 29 | 5 | 405 |

Two readings, both damaging. Of the 62 accounts the CRM calls Hot or Super Hot, **five are in live
contact**; twelve are fading, seven dormant and thirty have nothing recorded at all. And of the 458
it calls Cold, **seventeen are in live contact** — five of them inside the last thirty days.

The worst individual cases are the ones that motivated the ruling: an account that had ended its
relationship with WLIQ read `Hot` and ranked second on the chase list, its last recorded contact
195 days old; the account ranked *first* read `Super Hot` on a single touch 106 days ago; and an
account in active conversation read `Cold`.

### What replaces it

`pb_contact_events` (migration 20260916140000): one row per **recorded** contact — a call, an
email, a CRM note, a quote — each with a date, a direction and a traceable source id. It is an
observation, never a judgement.

`pb_engagement` derives the label:

| Label | Means |
|---|---|
| `engaged` | they replied, or attended a call, within 30 days |
| `responsive` | the same within 90 days |
| `pursued` | we contacted them within 30 days and they have not come back |
| `fading` | some contact within 180 days |
| `dormant` | nothing for 180 days |
| `unknown` | **nothing recorded** — which is not the same as cold |

Three properties the stage label did not have: a date, so it decays honestly; a direction, so a
reply outranks a send; a source id, so any row can be re-checked.

**`unknown` is the important one.** Rule 5 says unknown is never evidence, and the old label broke
that by rendering "nobody has written anything down" as `Cold`. Those are different claims. Today
603 accounts are `unknown`, and most of that is a sweep that has not been run yet, not an absence
of contact — so `unknown` must never be scored as a negative.

### A correction made during the build

The first cut tested `direction = 'inbound'` for "they came back to us". A recorded call is stored
as `mutual` — both sides showed up — so an account with nineteen calls and no email read as
`pursued`. Attending a call is at least as strong as replying to an email. Both now count
(`last_engaged`), and `last_reply` is kept separately for anyone who wants the stricter test.

### What is NOT ruled here

The stage label is not deleted. `pb_engagement.stage_label` carries it alongside, so the two can be
compared rather than swapped, and so a stale label is visible as a stale label. Whether the label
should break ties, and what weight `engagement` carries in the chase ordering, remain the open
`stated_timing_wins` question and the unruled chase weights (PRO decisions 1 and 5).


## 25 · The identity registry is mirrored, not re-derived (16 September 2026)

The `wliq-mdm` identity registry maintains what this book has been guessing at: which company is
which, which Orbit and Notion records belong to it, what it has been called, and what must never
become a company at all. Version 0.5.1 covers 29 companies and 53 source records, every one
re-read against the live system on 3 and 13 September.

It is mirrored here (migration 20260916160000) rather than re-derived, because re-deriving it is
exactly how this book got the following wrong:

- **An account filed under WLIQ's own domain**, carrying 53 of our own projects. The registry
  lists WLIQ by name as junk; this book reached it by domain, so a name-only check missed it.
  `pb_mdm_junk` now accepts a `domain` kind and the account is reported by `pb_mdm_junk_hits`.
- **Two accounts that are one company** — a row titled with a person's name and a row titled with
  the company's. The registry rules the company canonical and keeps the person as a
  *non-authoritative* alias so the source row still resolves.
- **An account under a project label** rather than a company name, with the same treatment.
- **A pair the registry has ruled are different companies**, scored 0.978 on fuzzy name match.
  Both halves are in this book. `pb_mdm_poison_pairs` stores the score precisely as the proof that
  no similarity threshold is merge-safe.

### What the mirror must not discard

**Review state is data.** Rows are green (re-verified against a live system), yellow (documented,
with an open question) or white (name only): 22 / 6 / 1. A yellow row is not a confirmed row.

**Notion Client IDs are reference only** (registry rule R4). They are stored for traceability and
`pb_mdm_resolution` must never join on them — it matches domain, then alias, then canonical name.

**The registry is not signed off.** Its own review sheet says nothing changes until the owner
answers per company. `signed_off_at` stays null and the resolution view reports `pending_signoff`,
so no downstream job can mistake a draft for a ruling.

### Direction of travel

This book **reads** the registry and never writes to it. Where this book observes something the
registry has not seen — the junk domain above — the row is marked `origin = 'prospect-book'`,
which makes it a proposal to the registry's steward, not an edit. Same posture as
`pb_roster_drift`: it reports, a person decides.

### Still open

The registry's own questions carry over and are not ours to answer: the QuickBooks connector and
a domain-only join (R3), the Phase C load order, and role-scoped billing visibility.


## 26 · Nine owner rulings on how the chase list should behave (16 September 2026)

Answers to the six questions raised in the 16 September diagnosis, plus three more the owner
volunteered. Several **reverse** what had just been built, and the reversals are the valuable part.

### 1 · Delivery is not a disqualification — REVERSES what was built

The proposal was: an account with an active Orbit project leaves the chase list for a promotion
queue. Ruled the opposite, for three reasons:

- an Orbit project is very often a **quote**, which means they are mid-decision — *"that means
  they're even hotter and deserve even more attention"*;
- after signature the account hands to an account manager, and **that transition is the moment of
  maximum exposure**: *"we've invested so much money in them at this point"*;
- a client buying one line is a prospect for **every line they are not already buying**.

So an Orbit project changes the **lane**, never membership. `pb_mdm_resolution.lane` says how to
work an account and removes nothing (migration 20260916170000). The view had already shipped with
the wrong advice in it; that text is replaced, not amended.

### 2 · A live quote outranks conversation

`pb_engagement_shape` adds `quote_state`: a quote raised in the last 60 days is `quote_open` and
means mid-decision. Measured immediately: of ten accounts with an open quote, **four read `Cold`
in the CRM** and one read `Warm`. Reported beside engagement rather than folded into it, so the
two can disagree visibly.

### 3 · A lost quote is not a lost client

*"Just because a quote is lost does not mean we have lost the client. A no is a positive sign."*
A priced conversation is an asset: it can be re-shaped, and the loss may have been our scoping
rather than their budget. `Quote Lost` must never become a terminal state, and a price refusal
is a dated event with a reason, not a permanent exclusion.

### 4 · The stage label means nothing unless confirmed

Confirms §24. The dropdown is a tiebreak at most.

### 5 · Chase-list size: up to 100

*"I said 60 because that seemed like a good number… I have capacity to chase 100 at the highest
volume right now."* So the target is the top 100 and the tuning bias is **recall over precision**
— missing a live account costs more than carrying an extra one. That is a reversal of how the
60-row list was built, which optimised for neither.

### 6 · What makes a fact

*"Facts happen in our engagement when we actually learn something from talking to them — through
email, through Fathom calls, through conversations, through our own discussions."* A fact is
learned in contact. A field copied from a CRM is a record, not a fact; this is why `rater` outranks
every machine source in rule 9, and why three rater facts in the system's lifetime is the ceiling
on everything else.

### 7 · Identity work continues across every source

Domains and call attribution are to be dug out of email, the calendar, Fathom invitee lists, Orbit
attachments and the Notion prospecting lists — not from a single field. For the unattached calls
the owner names the method: **match the agency name and URL, not the email domain alone.**

### 8 · One screen per account

Approved in principle; the design is open and the owner has offered to answer questions on it.

### 9 · Connected systems are the source now

Orbit, Gmail and Fathom are reachable over MCP in session. A missing Vault secret blocks the
*nightly* job, not the work — and asking for a credential that is already in hand was the wrong
answer on 16 September.


## 27 · The Orbit companies are in the book, and Orbit is read-only forever (16 September 2026)

Two instructions from the owner, on the same message. They pull in opposite directions and both
are kept.

### Bring them in

187 companies existed in Orbit with no account here: agencies, and companies with live project
work. Under §26 a client is still a prospect, so their absence was the gap. **151 were admitted**
(`pb_admit_from_orbit`), taking the book from 698 accounts to 849.

**What an admission asserts: existence, and nothing else.** The owner: *"Don't make too dramatic
assumptions. Again, just because they have a project or a quote or things in Orbit, the grading is
still important."* So an admitted account carries

- no `is_agency` fact — an Orbit project says we work together, not what kind of company they are;
- no tier, no grade, no engagement;
- `roster_certified = false`, because PRO-6 certifies Pipedrive only.

Verified after the run: **0 grades and 0 facts** on the 151. Each one carries a `pb_register` note
recording the Orbit id, status, project count and account manager, and saying in the row itself
that nothing beyond existence is claimed.

**35 were held back, none silently.** `pb_orbit_admission_queue` gives the reason for each: 32 are
named as another agency's end client (the parenthetical-owner pattern — admitting them would put a
partner's customer list on our prospect list), 1 is a name collision that is a merge question
rather than an admission, and 2 are demo or junk rows the identity registry already names.

### Never write to Orbit

*"Do not, absolutely do not write anything into Orbit."* This is now **rule 11** in CLAUDE.md and
it is unconditional. Orbit is the delivery system: a wrong row there reaches real projects, real
invoices and real people. Only `list_*` and `get_*` are permitted — never `create_client`,
`create_project`, `update_project`, `create_task`, `update_task`, `add_task_comment`,
`complete_task` or any other mutation, in any session, for any reason, **including to "correct"
something this book believes is wrong.** Disagreement goes into a report a person reads, exactly
as `pb_roster_drift` does for the Pipedrive roster.

### One contract change

`roster_source` gains `orbit`. Additive, and `core/prospect_types.ts` gains the same member in the
same commit so the type and the check constraint cannot drift (DECISIONS §8).

## §28 — The email sweep: every prospect domain, read once

**16 Sep 2026.** Owner instruction, twice: *"YES SWEEP EMAL ALSO"*, then *"yes"* to running it
to completion. Email was the largest hole in the book. `pb_facts` was 78% a Pipedrive mirror and
held **nothing** from email, so 603 of 849 accounts read `unknown` on engagement — not because
no one had ever talked to them, but because nobody had looked.

### What ran

Every distinct domain on `pb_accounts` — **709** of them — queried against the mailbox as
`{from:DOMAIN to:DOMAIN} newer_than:3y`, in batches, newest-first. Our own domain and one
known junk domain were excluded, leaving 707 swept.

**273 domains had email. 195 had a reply from them. 91 had a reply inside 90 days.**

That is the headline: **more than a third of the book had an email history nobody had read**,
and for 91 of them the other side answered this quarter.

### What a sweep row asserts, and what it does not

`pb_gmail_sweep` holds a domain, a last-inbound date, a last-outbound date, a thread count and
`truncated`. `truncated` is **true on every row**, and that is not a defect to fix later — it is
the honest label. The sweep reads page 1 of each query, newest first, which is exactly what
recency needs and is useless for volume. So a null date means *nothing recent was found*, never
*nothing exists*. Rule 5 holds: unknown is not evidence.

A row asserts that mail crossed between us and that domain on that date. It does not say who,
what about, or that it concerned buying anything. It is evidence of **contact**, which is what
`pb_engagement` reads. It is never a fact about the company, and nothing here reaches `pb_facts`.

### Why the load is a staging table and not a direct insert

The sweep runs outside the database and comes back keyed by *domain*. Which account a domain
belongs to is a join. Joins run in the database. This is the rule that `20260916180000` was
written to record after a hand-typed domain list was contaminated by merging in names from a
different source and produced a wrong headline number. `pb_gmail_sweep` carries the domain and
the two dates and nothing else; `pb_accounts` decides the account, inside
`pb_contact_events_from_gmail()`.

The local domain list was verified before any query ran: `md5` of the sorted list on disk against
`md5(string_agg(...))` in the database. Same digest, same count. A checksum, not a hand count —
the lesson from §23.

### What it changed

448 email events across 277 accounts. `unknown` engagement fell from 603 to **536**; 49 accounts
read `engaged` and 51 `responsive`, so **100 accounts have a live reply** where the book
previously had nothing at all.

### What is still not known

Volume, and anything older than page 1. Both are recoverable by paginating the same queries, and
neither changes a recency read. Body text was never fetched, so the sweep proposes no facts and
needs no `pb_fact_candidates` review.

### A note rule 2 only learned today: the roster grows under the prose

Running `scripts/no_prospect_names.ts` against the **current** roster caught two occurrences in
`docs/DECISIONS.md` that were clean when they were written. They became breaches because the
companies they named entered `pb_accounts` later — one through the Orbit admission (§27), one
through the peer-community cohort work itself.

So rule 2 is not a thing you pass once. A sentence that was safe in August can be a breach in
September without a single character changing, because **the check's other input moved**. The
script must be re-run against the live roster before every commit that adds prose, not only when
prose looks risky. Both occurrences are now shaped rather than named, and the run is clean.

The roster file the check reads is itself pulled from the database and verified by checksum
before use — `md5` of the sorted names on disk against `md5(string_agg(...))` in the database,
per chunk. That caught a real transcription error on the first attempt: one account name carries a
non-breaking space (U+00A0) where a reader sees an ordinary one, and it had been flattened to
ASCII on the way to disk. One byte in 826 names. A hand count would never have found it; the
checksum found it in two queries. This is the §23 lesson holding: the script is the count, and the
checksum is the count of the thing the script counts.

## §29 — The orphan calls were never orphans, and the quote history

**16 Sep 2026.** Two sweeps finishing the work §27 and §28 started.

### 826 recorded calls with no account

`pb_calls` held 987 conversations and 826 of them were attached to nothing. The obvious reading
is that call attribution is broken. It was not. Every one of those calls has an external domain;
the accounts those domains belong to simply **were not in the book**. They are delivery calls
with companies the Prospect Book had never heard of, because the Prospect Book only knew
Pipedrive.

Admitting 151 companies from the delivery system (§27) made **582 of the 826 matchable by exact
domain**, and the proof that the diagnosis was right is that **every single match lands on a
`roster_source = 'orbit'` account**. Not one lands on a Pipedrive account. The calls were never
unmatched prospects; they were unrecorded relationships.

**558 attached, 65 accounts, 24 refused.** Attribution is an identity decision, so rule 8 governs
it: exactly one matching account attaches (the same exact-domain rule the Fathom webhook already
applies at ingest), more than one never does. The 24 refusals split into two shapes, and the shape
matters:

- **16** where one company sits in the book under **two account records sharing one domain**. Had
  the function taken "the first" match these would all have been silently given to whichever row
  sorted first, and half that company's history would be filed under a record nobody reads.
- **8** genuinely **multi-party** — a call with two different agencies present. There is no right
  single answer, so there is no answer.

Nothing here reads a transcript or proposes a fact. It says which account a conversation belongs
to. The facts inside remain pb-notes' job, through `pb_fact_candidates`, where a person approves
them.

### A review queue that dropped the harder half

The first cut of `pb_call_attribution_candidates` grouped by **(call, domain)** and asked whether
that domain matched more than one account. That finds the duplicate-record shape and is blind to
the multi-party one: two different domains on one call each match exactly one account, so
per-domain grouping calls both unambiguous while the call as a whole is not. The view reported
16; the function, which groups per call, refused 24.

The function was never wrong. The *queue* was, and that is the worse failure — a wrong count is
visible, a review queue that quietly omits a category looks complete. It now groups per call and
names which shape each row is.

### Three bugs that `create function` accepted

`pb_attribute_orphan_calls` was created cleanly three times with `group by <uuid> and not
exists (…)`, then with `min(uuid)` (which is not a Postgres function), then with two pb_register
column names that do not exist. Postgres does not fully resolve a plpgsql body at CREATE time.

The part worth keeping is why the **dry run did not catch any of them**: the dry-run branch
returns before it reaches the insert. Three clean dry runs, three broken write paths. A dry run
that does not exercise the write path is not a rehearsal of the write path — it is a rehearsal of
the count.

### The quote history

All 11 pages of quote-stage work in the delivery system: **213 projects, 80 distinct companies**.
The owner's ruling (§26) is that a quote is engagement of the strongest kind, an open quote is the
hottest state an account can be in, and a lost quote is still a signal — *"a no is a positive
sign."* So the whole history loads, not just the fresh end.

**86 quote events across 94 accounts. 22 accounts have a quote open (≤60 days), 56 were quoted
within six months** — against 10 quoted accounts before.

Names came in the delivery system's spelling, not the book's. `pb_norm_company` handles what is
mechanical — ampersand for "and", a leading "The", a trailing legal suffix — and **five companies
still missed**. Two were spelling and the normaliser now covers them. The remaining **three are
aliases**: a typo in the source, a brand name against a legal name, and a parenthetical naming
the agency behind a sub-brand. Those stay in `pb_orbit_quote_unmatched` for a person.

A regex loose enough to match those three would also silently match companies that are genuinely
different. The normaliser deliberately stops where spelling stops and identity begins.

### Where engagement stands

Across §27, §28 and §29, on 849 accounts:

| | before today | now |
|---|---|---|
| `unknown` engagement | 603 | **498** |
| `engaged` (replied ≤30d) | — | **64** |
| `responsive` (replied ≤90d) | — | **52** |
| quote open (≤60d) | — | **22** |
| calls attached to an account | 161 | **719** |
| contact events | 224 | **1,349** |

498 accounts still read `unknown`, and that is honest: most are Apollo-sourced names nobody has
ever contacted. The difference is that it is now a statement about them rather than a statement
about what the book had bothered to read.

## §30 — The chase board, rebuilt on evidence

**16 Sep 2026.** The owner asked for the top 100 rebuilt on what is recorded rather than on stage
labels, and for "a substantive increase in the confidence and quality of these choices." This is
that board: `pb_chase_board`, every one of the 849 accounts ranked, migration 20260916220000.

### What the old list was actually ranking

The old chase list held **146 rows** — the accounts that happened to have been researched. Ranking
them was ranking the book's own reading history. The stage label underneath was no better. Of the
**184 accounts sitting in "Schedule Sales Call", 7 are in live contact and 140 have nothing ever
recorded against them**; "Sales Call Done" holds 155 with 67 in the same state; "Unqualified/DNC"
holds 160, of which 4 have replied to something in the last 90 days. A stage tells you what
somebody once filed. It does not tell you whether anyone is talking to us.

**20 of that old top 100 survive into the new one.** Twenty-eight of them now score zero or less.

### What it ranks on instead

Ten signals, all drawn from recorded contact (§24, §28, §29), scored against the owner's rulings
in §26:

| signal | points | why |
|---|---:|---|
| quote open (≤60d) | 50 | the hottest state an account can be in |
| replied ≤30d | 40 | they answered, recently |
| replied ≤90d | 25 | they answered |
| quoted ≤180d | 20 | including a loss — "a no is a positive sign" |
| delivering now | 18 | a client is still a prospect |
| a recorded call exists | 12 | they gave us time |
| contact ≤180d, no reply | 8 | re-engage |
| more than one channel | 6 | |
| written to, never answered | −5 | |
| contact exists, nothing in six months | −10 | |
| **CRM stage** | **0** | **deliberately** |

The weights are **data, not SQL** (rule 4): `pb_chase_weights`, version `chase-evidence-0.1`.
Reordering the chase is an insert and a new version, never an edit to the view.

The stage still appears on every row, at zero points, as `cj_stage`. A board that hides the number
it refuses to use cannot be argued with, and the owner should be able to see the disagreement.

### Two ranks, because one number cannot answer both questions

Ranked purely on contact, **91 of the top 100 are companies we already deliver for**. That is the
§26 ruling working exactly as stated — delivery is a relationship, and the handover is the moment
to nurture hardest — and it is also a board that would quietly starve new-logo work. Both things
are true.

So the view carries `new_logo_rank`: the same score over the **612 accounts with no active
delivery work**. The top 50 of that list all score positive. Neither rank is a filter someone has
to remember to apply, and neither is the "real" one.

The other thing the board shows about itself: **66 of the top 100 have no grade at all** and 67
have no Pipedrive stage. They arrived through the delivery system (§27) and the engine has never
read them. That is the queue for the next scoring run, and it is a better queue than the one the
research pass chose by hand.

### Three bugs, and the one that matters

`filter` attaches only to an aggregate, never to a scalar subquery — the weights are now read
through a one-row view. And `pb_mdm_resolution` is per **record**, not per company, so joining it
directly fanned the board out to **852 rows for 849 accounts**, with one company appearing twice in
the top ten. A fan-out inside a ranked list is the worst-shaped bug available: the total is barely
wrong, the duplicates sort adjacent so they read as a tie, and the thing being multiplied is the
thing being counted.

The third is the one worth the section, and the first account of it written here was **also
wrong** — corrected below, same day.

The view's first cut had a column called `stage_label` holding `pb_accounts.status` — the book's
own lifecycle (Ranked / Unclassified / Merged / Parked), which is not a stage at all. Every check
of the board's headline claim ran against that column and came back plausible: "66 of the top 100
are Cold or Unclassified" was 66 rows of `Unclassified` and zero rows of `Cold`.

The conclusion drawn from that zero was that **no row anywhere in the database says `Cold`**. It
was written into this section as the moral of the story. It is false. `Cold` is one of five values
in `pb_reads.urgency`, surfaced as `pb_engagement.stage_label`, and 458 accounts carry it.

So there are **three different columns** a reader could reasonably call "the stage", and the first
cut of the board picked the wrong one of the three, then read a null result off it as proof that
the second one did not exist:

| column | what it actually is | values |
|---|---|---|
| `pb_reads.urgency` | the CRM's heat read | Super Hot · Hot · Warm · Cold |
| `pipedrive_cj_stage` (fact) | the pipeline stage | New · Schedule Sales Call · Sales Call Done · Quoting · Quote Lost · Unqualified/DNC |
| `pb_accounts.status` | the book's own lifecycle | Ranked · Unclassified · Merged · Parked |

The board now carries the first two, both at zero points, as `crm_urgency` and `cj_stage`, and
surfaces the third as `account_status`.

Read against the right column, the finding is stronger than either wrong version of it. Of the
**62 accounts marked Hot or Super Hot, 17 are in live contact and 15 have nothing ever recorded**.
Of the **458 marked Cold, 33 are in live contact** — twice as many live conversations as Hot and
Super Hot combined. And the **151 accounts carrying no label at all hold 57 of them**, more live
contact than all 683 labelled accounts put together.

Two lessons, and the second is the one that nearly got away. A filter naming a value its column
cannot hold returns a number rather than an error, so it should be a test that fails when the
value set changes, not a predicate in a report. But the worse error was inferring from `count = 0`
that the *value* does not exist, when all it establishes is that it does not exist **in the column
queried**. A zero is evidence about the query, not about the world, and this repository's own
rule 5 already says so — unknown is never evidence. It applies to the book's readings of itself
exactly as it applies to the accounts.

### Twenty-five companies entered twice

`pb_duplicate_accounts` (migration 20260916220100) names them. Most are a Notion/Pipedrive
double-load where one record carries the domain and the other does not. Two are the same company
entered twice from the delivery system under one domain — which is what made 16 recorded calls
unattributable in §29, and what the chase board's fan-out was a second symptom of. Merging is an
identity decision, so rule 8 governs: the view proposes, a person decides.

## §31 — The board ranks companies, not account records

**16 Sep 2026.** Owner instruction, on being shown that the top 100 listed four companies twice:
*"collapse duplicates."*

### What the duplicates were doing

25 companies are in the book twice (§30, `pb_duplicate_accounts`). Ranking their records
separately is not a cosmetic problem. Seven of the pairs have a **30-point-plus gap between their
two records**, because the evidence is split: one record holds the reply, the other holds the
quote. Seven pairs touch the top 100. On **two of them the records contradict each other** — one
resolved to `quote_open`, the other to `pursued`, so the board printed "quote open" on one row and
"never answered" on another, for the same company, nine ranks apart. Both rows understated the
relationship and neither was the company.

`pb_chase_board` now groups by normalised name: **824 companies over 849 records**, every record
accounted for, no company appearing twice.

### The union is over events, never over flags

OR-ing the two records' derived flags is the obvious shortcut and it manufactures states that
cannot exist — `engaged` and `pursued` together, "replied <30d · never answered" on one line.
Engagement is a case expression over dated observations, so the only correct way to merge two
records' engagement is to merge their **observations** and evaluate the expression once.

`pb_company_engagement` is `pb_engagement`'s derivation verbatim, grouped one level up. The
thresholds are not restated; if they move in `pb_engagement` they must move here, and that
duplication is the price of not inventing a second definition of "engaged". Checked after
applying: zero rows carry a contradictory pair.

### This is not a merge

Nothing is written to `pb_accounts` and no identity is asserted. Every grouped row carries
`records` and `duplicate_records`, so the duplication stays visible instead of being quietly
absorbed — the owner asked for the ranking to be right, not for the problem to disappear. The 25
merges remain in `pb_duplicate_accounts` for a person (rule 8). If the grouping is wrong for some
pair, the remedy is to drop a view rather than to unpick a write.

One number moved for the right reason: **quote_open fell from 22 to 19**. Three of the 22 were the
same quote counted under both records of a pair. 19 is the number of companies with an open quote;
22 was never a fact about the world.

### A quote carried under a domain

The quote sweep left three unmatched names (§29). One was not a spelling variant at all — the
delivery system carries the company under its **domain** instead of its name, which no amount of
name normalisation will ever reach. An exact domain match is the `high` confidence bar rule 8
sets and the same test the Fathom webhook already applies, so the join now also matches
`lower(client_name) = lower(domain)`, as a **rule** rather than a hand-entered alias row. Nothing
asserts that two names mean the same company; only that a string which is exactly an account's
domain identifies that account. One quote attached, and that company moved from #62 to #27.

The remaining two stay unmatched on purpose: a one-character typo in the source, and a
parenthetical naming the agency behind a sub-brand. Both are probably right; neither is mechanical.
A regex loose enough to catch a typo is loose enough to merge two companies that differ by a
letter, and the book would have no way to tell which it had done.

## §32 — §20 was ruled on 15 September and never reached the engine

**16 Sep 2026.** The owner asked why the book showed zero Platinum when he remembered
sixty-odd. The answer is that §20 — his own ruling, recorded in this file on 15 September —
was never implemented. It is now, as rubric **0.1.3**, active.

### What was actually wrong

§20 describes the fix as two deletions. Neither was ever made. The active rubric 0.1.0 still
carried `qualification.present_count >= 3` in `dimension_b.platinum_rule.requires_all`, and
`potential.climb_evidence.caps_ceiling` was still absent — a key that **defaults to true**.
The 0.2.0 draft did not carry them either. So every nightly run since 15 September re-applied
both gates.

Worse, the engine source *did* carry the change: `engine.ts` reads `caps_ceiling` and the
comment there cites §20 by name. The **deployed** pb-score did not. It was built on 14
September, a day before the ruling, and had never been redeployed. Two rulings were sitting
in the repository unshipped: §19's `build_demand_exceeds_capacity` fit criterion and §20's
two deletions.

A ruling is not applied when it is written down, and not when the code is merged. It is
applied when the artefact that runs at 06:15 contains it. Nothing in this book checked that,
and the gap was visible only because the owner remembered a number.

### The funnel, before

| gate | passing (of 698 scored) |
|---|---:|
| Gold base tier | 104 |
| ≥ $100K headroom — the money is there | 148 |
| **ceiling = Partner** | **5** |
| Gold **and** Partner | 1 |
| …**and** 3+ qualification facts | **0** |

Zero Platinum was never the engine disagreeing. It was starvation: average qualification
facts present was **1.01 of 4**, and 223 accounts had none. A gate fed by a signal type the
book does not collect was deciding how big every prospect could be.

### After

Rubric 0.1.3 (0.1.0 plus exactly the two deletions, nothing else — the 0.2.0 ICP change stays
a draft), with pb-score redeployed from commit `f265702`:

| | before | after |
|---|---:|---:|
| ceiling = Partner | 5 | **143** |
| ceiling = Embedded | 2 | **83** |
| **Platinum** | **2** | **67** |
| Platinum among prospects | 1 | **60** |

Of the 60 Platinum prospects, **23 have never had a single recorded contact** and **49 are
labelled Cold** by the CRM. That is the ruling working exactly as stated: potential is what
they could be worth, engagement is whether they are live right now, and the two do not touch.

### The prose was corrected with the data

Both blocks carried text the engine puts in its trace. `climb_evidence.rule` still said "the
ceiling may not exceed Project without at least one observed climb signal" and its basis was
`unruled_default`; the platinum rule's `why` still argued that "a Gold that is not yet real
ranks below a Gold that is" — the exact conflation §20 removed. Changing the thresholds and
leaving the reasons would have produced a trace that explains the old behaviour while the new
one runs. Both were rewritten in the same version, and the climb basis is now `ruled`.

### An outage, caused while fixing this

Deploying pb-score through the MCP means carrying the whole 81 KB bundle in one tool call. On
the first attempt a placeholder string was sent in place of the bundle. It deployed cleanly as
v7 and pb-score answered `WORKER_ERROR` until v8 replaced it about ten minutes later — inside
the working day, thirteen hours before the nightly run, so no scheduled job was missed.

The deploy tool reports success on a syntactically valid request; nothing about the payload
being a seven-character placeholder made it fail. The check that caught it was a GET against
the deployed function, and the check that proved the fix was fetching the deployed bytes back
and diffing them against `dist/`. That diff should be the standard last step of any MCP
deploy, and it is the only thing that distinguishes "the API accepted it" from "the right code
is running." The restored v8 differs from the built bundle by one trailing newline and nothing
else.

## §33 — The prospect board ranks potential; engagement is a column

**16 Sep 2026.** Owner: *"If you have platinum potential, then it doesn't matter about the
engagement… the engagement is different than their potential. Is that correct?"* It is, it was
already ruled in §20, and the board I had built contradicted it.

### What the contact board got wrong

`pb_chase_board` ranks on recorded contact. Measured against the 61 highest-potential
prospects, it put **one** of them in its top 100. The worst sat at rank **816**. Thirty-five
scored zero or less and did not appear at all.

Three faults, and only the first was visible:

1. **It ranked on engagement.** §20 says potential is what they could be worth and engagement
   is whether they are live right now. A board that folds one into the other answers neither
   question.
2. **It invented an ordering.** The rubric already defines the chase order — `chase_rank_key`:
   tier, then qualification facts present, then urgency, then year-one band — and `grade()`
   writes it into every scorecard. Rule 4 says the rubric is data. A `pb_chase_weights` table
   competing with the rubric's own key is a second source of truth for one decision, and the
   one I wrote scored tier, headroom and deal size at **zero**.
3. **It produced a composite number.** 126, 111, 96. The book's first line is four reads
   *never summed*, output as a rank and bands, never a number (PRO-0). I summed them.

### What replaced it

`pb_prospect_board` sorts on the five elements of the engine's `chase_rank_key`, read out of
the scorecard. It defines no ordering of its own: change the chase order by editing the rubric
and re-scoring, and this view does not move.

Worth noticing what that key already does with engagement — **urgency is the third element**,
after tier and qualification. Liveness breaks ties between equals; it is never a reason to
outrank a bigger prospect. §20 was expressed as an ordering in the rubric the whole time.

One row per company (§31), and a company's potential is the **best-evidenced read among its
records**, picked by the same key rather than by whichever record leads on contact. That
promotes one company whose Platinum read sits on its non-lead record.

### What it shows

599 prospect companies. **89 of the top 100 are Gold or Platinum** — against one before. Every
one of the top 25 is `Platinum × Partner`. **43 of the top 100 have never had a single recorded
contact**, and an `untouched_high_potential` flag names the 42 Gold-or-better companies in that
state, because "real size, nobody has ever tried" is the most actionable row in the book and
was the least visible.

The contact board stays. It is genuinely useful — it is the answer to "who do I call today,"
and the account managers want it. It is simply not the answer to "who are the best prospects,"
and giving one list to both questions is what made the top 100 wrong.

### The third axis is empty, and that is the next job

§20's three axes are tier, **confidence**, and engagement. Confidence reads Medium on 380
companies and Low on 147 — and **High on none of them**, because High needs three of four
qualification facts and the average is 1.01. The ranking is sound and the confidence behind it
is thin everywhere. That is not a scoring problem; it is 548 recorded calls nobody has read.

> **Numbering note (17 September 2026).** §22–§27 below were written by the 16 September session on
> branch `claude/new-session-glwxzh`; §28–§37 by the 17 September session on
> `claude/amazing-mayer-umftf0`. The two branches ran in parallel and both numbered from §22, so on
> merge the later set was shifted by six. Any reference to §22–§31 written before 17 September
> means the 16 September set; every reference in this file and in the 17 September documents has
> been corrected to the numbers used here. See §38.

## 28 · The research was never checked against the build (16 September 2026)

**Not a ruling.** This section records a measurement and creates a standing check. Every gap it
names is a candidate for a ruling and none of them is one. Where this section and the register
disagree, the register wins.

### What prompted it

The owner asked whether what was built still matched the research it came from. The research —
an external document of 9 September, ~150 sources read and ~80 cited — closes with **ten
requirements written for whoever built this repo** and **seven decisions it asked the owner to
make**. Nothing in this repository has ever referenced them. No session has read that document.

That turns out to have cost real work. §16 measured the coverage shortfall that R4's calibration
loop was designed to expose. §19 and §21 each ended on "nothing collects this yet" for features
the research had already named as collectable. Three sessions independently rediscovered ground
the research had mapped, because the map was not in the repo.

### What was measured

Ten requirements, scored against the code: **R1 met · R2, R3, R4, R6, R8, R9, R10 partial ·
R5 divergent · R7 not met.** The six "do not build" prohibitions are honoured six for six,
the composite-score one structurally rather than by intention. Of the seven decisions, three are
answered, one was answered further than asked (ICP retired entirely as the fit read, §8), and
three are open — including **who rates**, which is the constraint currently binding the book.

Three findings are worth naming here rather than leaving in the ledger.

**Every significant gap is the same gap.** R4's calibration loop, R9's three measurement rituals
and R6's thresholds are all the *measuring* half of the design. The scoring half was built well;
the half that tells you whether the scoring is any good was not built at all. The research is
explicit that a score without calibration is a dashboard nobody actions, and PRO-8's UNVALIDATED
stamp has been correct the whole time for exactly this reason.

**Two of the four gates do not gate.** The research names four — service shape, economics, broker
character, geography. `broker_character` runs in `flag` mode because PRO-2r-a is unruled, which is
recorded and deliberate. **`geography` runs in `off` mode, and nothing records why.** That is not a
ruling and not an open item anywhere; it is a switch nobody has looked at.

**The strongest predictor in WLIQ's own data is not in the fit read.** The research calls the
white-label signal "the single strongest predictor you found" — roughly an 80% active rate. In
this repo `wl_signal` only sets the outsourceable share inside Potential. It has never been
proposed as a fit criterion, and never rejected as one. Rubric 0.2's narrowing from twelve
researched attributes to six answerable criteria is defensible; this particular omission looks
like an accident rather than a choice, and it deserves a ruling either way.

### What was done

`docs/RESEARCH-CONFORMANCE.md` is a standing ledger: one row per requirement, per prohibition and
per decision, with its state and what is missing. It carries aggregate counts only, no external
document identifiers, per rule 2.

`scripts/conformance_test.ts` runs the ledger's machine-checkable claims on every `npm test`.
The design point is that each check states what is true **today, including the gaps** — so closing
a gap fails the build until the ledger is updated to say so, and a gap that quietly reopens fails
it too. Drift is caught in both directions. Fourteen claims are checked automatically; eight
cannot be answered from the repo (a credential, a row count, a person) and are printed on every
run with the date they were last verified, never failing the build.

### The limit of this, stated plainly

**The Grading Register has still never been read by this repo.** It is a Claude artifact rather
than a file, and every PRO-number claim in `docs/` — including in this section — is second-hand
through earlier sessions. The research is advisory and the register governs, so the one input
that actually binds is the one no conformance check can see. Getting the register into a form a
session can read is a larger unblock than anything in the ledger.

### What this does not decide

No threshold moves. No gate mode changes. No rubric is activated. Geography stays `off`, the
white-label signal stays out of the fit read, and decision 4 stays unanswered — all three are now
written down where the next session will trip over them instead of rediscovering them.

## 29 · What the 17 September audit found: the rubric grading the book had no file (17 September 2026)

**Not a ruling.** A measurement, a version point, and a rule adopted for how work lands from now
on. Every figure is from the database on 17 Sep and reproducible from `docs/STATE-SNAPSHOT-2026-09-17.md`.

### What prompted it

The owner asked whether iteration had damaged the foundation and where in the build he actually
was. §28 had compared the repo to the research's ten requirements and found the gaps were all in
the measuring half of the design. That comparison was made against a file — and the file was not
the rubric grading the book.

### The version point

Commit `e20b702`. Its companion is `docs/STATE-SNAPSHOT-2026-09-17.md`, generated from live queries.

### What was found, in order of harm

**Fathom has never delivered.** All 988 `source=fathom` rows in `pb_webhook_inbox` carry
`user-agent: pg_net/0.19.5` — this database posting to its own endpoint during the 13 Sep
back-fill. The Pipedrive rows carry `user-agent: Pipedrive Webhooks` and are unambiguously
external. The newest call in `pb_calls` was held 11 Sep. `docs/PHASE0.md` recorded P0-2 and P1-4
as Pass citing those 988 rows; both are corrected. Calls held since 11 Sep with real prospects
are not in the book. This is the only finding with ongoing loss.

**The active rubric existed only as a database row.** Version 0.1.3 was activated 16 Sep 17:32
UTC and has graded 829 accounts. `grep -r "0.1.3"` over the repository returned nothing. It is
now `core/rubric.prospect.v0.1.3.json`, recovered from `pb_rubric_versions.spec`. Verified by the
engine's own `fingerprint()`: the file produces `909b3747`, and every one of the 829 reads
recorded `909b3747`. The 9,439 reads under 0.1.0 likewise match `core/rubric.prospect.v0.1.json`
at `18e704f2`. Both lineages reproduce.

**Recovering it showed that §17 is not in the live rubric.** 0.1.3 is 0.1.1 plus the §20 ceiling
change. Its climb-signal set is the pre-§17 five — including "2nd project scoped" and "Referred
someone", which §17 retired as impossible for a prospect — and `lift_requires` is absent. §17
exists only in the 0.1.2 file, a registered draft with zero reads. Consequence: `notes_sweep.ts`
may propose `Champion identified` and `Future-state language`, which the running rubric does not
recognise. The extractor and the engine disagree about what a climb signal is. Because §20 set
`caps_ceiling: false`, the missing bar changes no tier today; the vocabulary split is real
regardless.

**Thirty-three applied migrations have no file.** 64 Prospect Book migrations are applied (the
project is shared; 75 in total), 31 `.sql` files are on disk, matched by name because the
timestamps differ. Everything from `prospect_book_research_log` (16 Sep) onward — boards, an MDM
registry, contact events, a chase score — is a second system built entirely in the database with
no file, no test and no entry here.

**A composite score was built.** `pb_chase_scores` holds 146 rows of a summed −18..123. The
founding rule of this instrument is four reads, never summed. Nothing prevented it.

**Every write lane on the page is unused.** Register kinds are only `decision` and `note`: zero
overrides, zero promotions, zero manual signals, ever. Two owners, zero raters.

**Documents described a system that was not running.** PHASE0.md (two false Pass entries),
METHOD.md (generated from a file, not from the active rubric), and CLAUDE.md's own layout line
(named two rubric files when there were six — which is why §28's gate checks were run against
the retired 0.1.0 and reported as if active). PHASE0 and CLAUDE.md are corrected in the version
point; METHOD.md waits on repair item 5.

### Where the build actually is

Measured against the brief's own acceptance tests: two-thirds through Phase 2, on a Phase 0 that
was never finished and has since gone dark, with Phase 3 machinery built and never used and
Phase 4 not started. No phase is accepted. Phase 2 — the engine, the four reads, rubric-as-data —
is much the best-built part.

### What did not need tearing up

Recorded so the repair does not overreach. The §20 ruling measured, predicted and verified
(predicted Partner 6→139 and Platinum 2→66; got 143 and 67). The contract held twice under
pressure (`build_demand_exceeds_capacity` and `delivery_headcount` were added as new questions
rather than re-reading old keys). The frozen 10 Sep baseline still reproduces byte-identically.
Every read carries version, fingerprint, run, as-of date, scorecard, hash and a trace — all
10,268 are individually reconstructible, which is the expensive half of governance and is done.
`BASELINE.md`'s power arithmetic is more careful than any sales-tooling source found.

### The rule adopted

**Nothing is activated that does not have a file, and nothing has a file that is not tested.**
The cause of all of the above is one asymmetry: the Supabase tooling makes writing to the
database exactly as easy as writing to a file, and a file requires a commit while a database
write does not. The remedy is not to ask a person to remember; it is
`scripts/conformance_test.ts` (hardened 17 Sep: completeness gate, expiring manual claims, the
active rubric pinned by the engine's fingerprint) and a `scripts/reconcile.ts` that compares the
file to the database — specified in `docs/RESEARCH-CONFORMANCE.md`, not yet built.

### What this does not decide

Whether the 16 Sep boards and the chase score stay or go; whether the page or the boards are the
working surface; whether there is ever a second rater; whether the gate should bite. Those are
the owner's, listed in `docs/REPAIR-PLAN.md`. No threshold moves and nothing is activated.


## 30 · Fathom, reconnected from the database, and what the 12 September entry got wrong (17 September 2026)

**Not a ruling.** Repair item 1 of `docs/REPAIR-PLAN.md`, executed; the record of what was found
on the way.

### What was done

A webhook was created through Fathom's REST API from `pg_net`, with the API key read inside the
call: `POST /external/v1/webhooks`, `201 Created`, id `NYMFoCciM4MNbUi3`, destination
`<FN>/pb-fathom-webhook`, both trigger types, all four includes. The receiver answers `200
{"ok":true}`. The signing secret was moved from the response row into Vault by SQL, verified by
shape only, and the plaintext response rows scrubbed; the 12 Sep value is kept as
`PB_FATHOM_WEBHOOK_SECRET_20260912`.

The 12–17 Sep gap was back-filled with the existing crawl: one page of Fathom's newest-first
list landed 10 new meetings, all on 16 Sep — Fathom's own list shows nothing recorded 12–15 Sep
(a weekend, then two quiet days). All 10 posted through the receiver and verified; 7 were
external and became `pb_calls` rows with attendees, the other 3 were internal and correctly did
not.

### Three things the runbook had wrong

**The field is `destination_url`.** Sending `url` returns `400 {"error":"Url can't be blank"}` —
a Rails validation on an attribute the parameter never reached. That is the same error the MCP
produced on 12 Sep, and the runbook concluded the MCP was dropping the field. It was not; the
MCP sends `destination_url`, which is right. Whatever failed on 12 Sep, it was not that.

**The signing secret is per-account.** The secret Fathom returned on 17 Sep is byte-identical to
the one stored on 12 Sep. So the receiver was always able to verify a delivery; none ever came.
Rotating the secret on webhook creation is a no-op and the runbook now says so.

**"Done" was written on the wrong evidence.** The 12 Sep entry, and PHASE0's two Pass rows,
rested on 988 "verified deliveries" that were this database posting to itself. The runbook now
states the only acceptable proof: an inbox row carrying Fathom's user agent that verifies and
becomes a call.

### What is still not proven

Exactly that. No `pb_webhook_inbox` row has ever carried a Fathom user agent, and none can be
manufactured — it needs a recording to finish. The ledger row is `RECON-fathom-proof-pending`
and it closes only on that evidence. Until it does, Fathom is *set up*, not *fixed*. There is no
list endpoint, so a stale 12 Sep webhook may still exist in the Fathom UI; a duplicate delivery
is harmless (calls dedupe on meeting key), and the owner should delete anything that is not
`NYMFoCciM4MNbUi3`.

### What this does not decide

Nothing about the rubric, the reads, or any threshold. One connector, one gap, one correction to
the record.


## 31 · §17 restored to the rubric that grades the book (17 September 2026)

**Not a ruling.** Repair item 2, executed. The record of a ruling that had been lost between the
file that carried it and the row that graded.

### What was wrong

Version 0.1.3 — active since 16 Sep, 829 reads — was 0.1.1 plus §20's ceiling change. It did not
contain §17, the 14 Sep owner ruling on climb evidence: the five engagement-depth signals, the
one-strong-or-two-weak bar, and the two signals retired as impossible for a prospect. §17 lived
only in the 0.1.2 file, a registered draft with zero reads. So `ingest/notes_sweep.ts` could
propose `Champion identified` and `Future-state language` and the engine did not know them, while
`2nd project scoped` and `Referred someone` were collectable again.

### What was done

`core/rubric.prospect.v0.1.4.json` is 0.1.3 with its `potential.climb_evidence` replaced by
0.1.2's, keeping §20's rule text and `caps_ceiling: false`. Twenty-six leaves differ from 0.1.3,
all inside that block plus `version`. Engine fingerprint `1d83b2e3`, pinned in `engine_test.ts`;
PB04 and PB20 carry `expected["0.1.4"]` scorecards generated by the harness itself.

It was registered through `pb-sync`'s `rubric` action — the designed path — with the spec
constructed server-side from the graded 0.1.2 and 0.1.3 rows, so it never passed through a
transcript; the registered row's climb block was then proven structurally identical to the file's.
Previewed across the whole book before activation: **829 scored, 0 errors, 0 changed** — no tier,
status or confidence moved anywhere, and the ranked / unclassified / parked split (598 / 224 / 7) is
identical to 0.1.3's. Then activated through the same action, which retired 0.1.3.

### Why nothing moved, stated so it is not misread

Because §20 set `caps_ceiling: false`, climb evidence no longer gates the ceiling, so the
restored bar changes no tier today. What changed is the vocabulary: the engine again recognises
what the extractor proposes, and once more refuses the two signals a prospect cannot honestly
carry. Facts collected tonight can be used by the engine scoring tonight. If the owner ever
re-rules that climb evidence should cap, the bar is already in place.

### Two small things found on the way

`pb_rubric_versions.spec_sha256` has been computed two ways — `pb-sync` hashes
`JSON.stringify(spec)`, the raw-inserted 0.2.0 row hashes `spec::text`. Nothing reads the column.
And the deployed-versions line in CLAUDE.md said pb-score v6; it is v8, built 16 Sep 17:31 UTC,
one minute before 0.1.3 was activated — the §20 engine change *was* in production (452 of 829
reads carry its note). Read versions from `list_edge_functions`, as the file already says.

### What this does not decide

Whether climb evidence should cap again; whether the gate bites; anything in Track B. One ruling
put back where it belonged.


## 32 · Four migrations that ran without a file, filed verbatim (17 September 2026)

**Not a ruling.** Repair item 3, first half.

Supabase stores every applied migration's SQL in `supabase_migrations.schema_migrations.statements`,
so filing a migration that ran without a file is transcription, not reconstruction: the body is
byte-for-byte what executed. Of the 33 unfiled entries in the version point, 4 predate the 16 Sep
boards work and are now in `supabase/migrations/`, each headed with the version it was applied as:

| Filed as | Applied as | What it is |
|---|---|---|
| `20260913060100_…movement_views_null_rank_fix` | `20260913002739` | the `pb_movement` view, null-rank safe |
| `20260915090100_…fact_source_precedence` | `20260915233744` | `pb_current_facts` gains a source-precedence tier between evidence label and recency |
| `20260915090200_…website_team_pages` | `20260915233846` | `pb_website_reads.path`; `pb_website_fetch_begin` takes paths |
| `20260915090300_…website_retry_window` | `20260915234417` | the fetch retries on last-tried, not last-ok; duplicate reads pruned |

Filed timestamps follow the on-disk clock, not the applied one, so a fresh replay keeps order;
the reconciliation check (repair item 4) matches by name. The second is worth a note on its own:
it changed the rule-9 resolution order — `evidence > inferred > unknown`, **then source
precedence (rater, fathom_call, pipedrive_note, website, notion_master, apollo, pipedrive)**, then
recency — on 15 Sep, and `ingest/resolve_features.ts::latestFactPerKey` must be checked against
it. That check is queued, not done.

The remaining 29 — `prospect_book_research_log` through `prospect_book_prospect_board`, the
boards, the MDM registry, contact events, the chase score — are held until the owner decides
whether that system stays (decision 2). Their SQL is saved outside the repository so the decision
can be taken without losing anything either way.


## 33 · Rule 9 drifted for two days, and the check that said it had not was reading a stale file (17 September 2026)

**Not a ruling.** A defect, its cause, and the fix — recorded because the cause is the pattern this
whole repair is about.

On 15 Sep the `pb_current_facts` view gained a **source-precedence** tier between the evidence
label and recency — `rater > fathom_call > pipedrive_note > website > notion_master > apollo >
pipedrive > else` — in `prospect_book_fact_source_precedence`, a migration applied without a file.
`ingest/resolve_features.ts::latestFactPerKey` was not changed. Rule 9 says the two must not
drift. They did: on 17 Sep, **50 of 6,983 keys across 19 accounts** resolved to a different row
under the two orders, **24 of them to a different value**.

Production reads were not wrong — pb-score feeds the view's already-resolved rows into the
function, where the second sort is a no-op — so the drift bit the pure path: tests, fixtures,
local grading, and the explanation of how a fact wins. It also bit this session: on 16 Sep the
rule-9 check was closed as "holds" after comparing the function to the view definition in the
**filed** 11 Sep migration. The live view had been replaced four days earlier by one that had no
file. A check that reads the repo cannot see a change that never reached it — which is the
reconciliation gap `scripts/reconcile.ts` (repair item 4) exists to close.

Fixed: the function carries the view's order verbatim, `resolve_features_test.ts` pins it with
four cases (a rater's older fact beats Apollo's newer one; call beats site beats Apollo; an
unlisted source ranks last; the evidence label still outranks source), CLAUDE.md rule 9 now states
the real order, and the ledger carries an auto check on the function and a manual row with the
query that must return zero.

The deployed pb-score (v8, 16 Sep 17:31) predates this fix and was deliberately not redeployed by
hand: production reads are unaffected, since pb-score feeds the view's already-resolved rows into
the function, and an 81KB bundle pasted through the MCP is the one step here with a real chance
of silent corruption. Repair item 4's CI deploy owns it; the ledger row
`RECON-pb-score-bundle-behind-source` carries the probe (`SOURCE_RANK` in the deployed source).


## 34 · The other half of the check: declared versus running, from CI, with no secrets (17 September 2026)

**Not a ruling.** Repair item 4, executed.

`scripts/conformance_test.ts` reads the repository and fails when the ledger stops matching the
code. It cannot see the database, and on 17 Sep that blind spot held four findings at once — the
active rubric with no file, 33 applied migrations with no file, a source that had never delivered,
and a rule-9 drift — behind an entirely green suite. This closes the other half.

`public.pb_reconcile_state()` returns, as one jsonb, the facts needed to compare declared with
running: the active rubric's version and spec; the applied `prospect_book_*` migration names;
per-source liveness measured on **external** evidence only (a webhook row whose user agent is not
`pg_net`, or a finished run — a row this database posted to itself is not proof of anything, which
is how PHASE0 carried a false Pass for five days); and the rule-9 mismatch count. Aggregates,
timestamps and identifiers; nothing row-level; nothing from `pb_contacts`. It is `security
definer` so it can read the inbox and `schema_migrations`, and it is granted to `anon` — the first
such grant in the book, made deliberately: everything it returns is either already public under
§5 or is a count. It has a migration file, applied through the MCP in the same commit.

`scripts/reconcile.ts` fetches it with the page's own publishable key and checks four things: the
active rubric agrees four ways (database version, database spec fingerprint, file fingerprint,
and the fingerprint the current reads carry); every applied migration has a file, matched by name,
with the 29 boards migrations on a known-unfiled list that should only shrink; each source is
alive within a stated budget, Fathom on `warn` until its first external delivery ever, the others
on `fail`; and rule 9 has zero mismatches. `scripts/reconcile_test.ts` exercises every failure
branch against canned states, because a check that has only ever passed has not been shown to
detect anything.

`.github/workflows/ci.yml` runs `npm test` on every push, `reconcile` on every push and every six
hours — the database can drift without a push, which is how it drifted the first time — and, on
the default branch, deploys the five edge functions **from source** with the Supabase CLI. That
last job does nothing until `SUPABASE_ACCESS_TOKEN` exists as a repository secret; it says so and
skips. When it runs, the deployed pb-score stops being behind source (§33) without anyone
carrying a bundle by hand.

What this does not do: read the Grading Register, decide anything about the boards, or make a
red reconcile go green by itself. A red reconcile means the system and the record disagree; the
fix is to the system, or to the record with a reason here.

**Addendum, 17 Sep 07:10 UTC.** The on-push reconcile works (CI runs #1–#6 green). The
six-hourly *scheduled* one has never fired: GitHub evaluates `schedule` triggers only against the
workflow file on the repository's default branch, and the default is still
`claude/new-session-8qkstx`, which has no `ci.yml`. So "every 6 h" above is true only once this
branch is the default or merged into it — REPAIR-PLAN decision 5. Until then drift between pushes
goes unchecked, which is exactly the window the schedule exists to close.

## 35 · METHOD.md described a rubric nothing ran; now it is generated from the active file and held there (17 September 2026)

`docs/METHOD.md` is the page a salesperson quotes. Until today it was generated from
`core/rubric.prospect.v0.1.json` — version 0.1.0, retired — while 0.1.3 and then 0.1.4 graded the
book. `explain/method_test.ts` guarantees the document matches *its* rubric byte for byte; it
never asked whether that rubric was the one running. This is REPAIR-PLAN item 5.

What changed:

- `explain/generate_method.ts` defaults to `rubric.prospect.v0.1.4.json`, and `docs/METHOD.md`
  is regenerated from it. Section 10b now reads `caps_ceiling` the way the engine does: when it is
  false the document says the ceiling comes from headroom alone and the "Ceiling capped" flag is
  never raised, instead of describing a cap that §20 removed. The strength of each climb signal,
  the lift bar (one strong or two weak) and the two retired signals are printed, so §17 is
  visible on the page as well as in the engine.
- `scripts/conformance_test.ts` gained `ACTIVE-method-source`: the generator's default file must
  be the ledger's `active_rubric.file`. Activating a new version without repointing the
  generator now fails `npm test`, alongside the fingerprint pin from §29.
- Deal-health `params` are printed sorted by name. 0.1.4 was written back from the database,
  whose `jsonb` reorders keys; a document must not change because a file was round-tripped.
  The other tables that reordered (aliases, ICP maps) follow the file's order and are unchanged
  in content.

The 0.1.0 fixtures and `docs/BASELINE.md` are untouched; the fixture half of item 5 landed in
§31 (PB04 and PB20 pinned on 0.1.4).

## 36 · Potential snapshots accumulate nightly; the freeze at promotion is a selection, not a write (17 September 2026)

REPAIR-PLAN item 6. `pb_potential_snapshots` had the research's full schema and zero rows since
9 Sep. Requirement R4 — freeze what the book claimed, score it against what happened — is the
only mechanism that can ever say whether the grade predicts anything, and every night it does
not run is evidence lost. The plan asked one question to be settled before code: the brief says
freeze "at first SOW", which is a Client Book event, and this repository may never read the
Client Book's tables or import its keys (PRO-17). How is a snapshot frozen at the promotion
boundary without crossing it?

**The ruling in code.** Nothing crosses. Three parts:

1. **Accumulate every night.** pb-score writes one row per ranked account (status `Ranked` or
   `Overridden`) on every non-preview run: `taken_at` = the run's `as_of` date, `estimator` =
   `year1_band_edges@<rubric version>`. A re-run the same day replaces the day's row (unique on
   account, day, estimator — migration `20260917110000`), so evidence is never doubled.
2. **Freeze by selection.** The promotion boundary already exists inside this book:
   `pb_promotions.first_invoice_at`, the date a *person* confirms under PRO-18. The frozen
   snapshot for a promoted account is the newest row with `taken_at <= first_invoice_at` for the
   estimator being scored. No second write, no flag, no Client Book key: a query.
3. **Actuals from the systems of record, not the Client Book.** The rubric's own note says the
   snapshot is "scored against Orbit and QuickBooks actuals". Orbit is already a source here
   (`ingest/orbit_quotes.ts`); QuickBooks would be another. The scoring pass (6/12/24 months)
   reads billing, not `client-grading`'s tables, and is NOT built today — the ledger carries
   `R4-scoring-pass-absent` so its absence stays visible.

**What a snapshot holds.** Only what the engine actually claims. `p10_12m` and `p90_12m` are the
active rubric's year-one band edges (the lowest band's floor is 0; the top band is open, so its
p90 is null). `p50_12m`, the 24-month interval and the two probabilities are **null**: PRO-16
dropped the point estimate, and no estimator for the rest exists. A null is an explicit "not
estimated", never a zero — unknown is never evidence, in this table as everywhere. `assumptions`
keeps every input a later estimator could re-derive from (headroom, wallet, winnable share,
ceiling, confidence, facts present, urgency, rubric fingerprint, run id), so the estimator can be
replaced without losing the history; the `estimator` column names which one produced a row.

**What this does not do.** It does not choose the estimator that will eventually fill p50 and
the probabilities; the cohort quartiles in `year1_bands_basis` (n = 31) are the obvious
candidate for a naive baseline, and that is Track B's question, not this repair's. It does not
score anything. It does not touch grants: service role writes, `authenticated` reads through
the 9 Sep policy, `anon` holds nothing on this table.

First rows: **598**, written 17 Sep 02:43 UTC by run `9290fe00` on pb-score v9 (one per ranked
account; 224 unclassified and 7 parked rows get none). Every one carries p10 and p90 and none
carries p50. All 598 fall in two bands — the ICP prior bands `$6K–16K` (536) and `$16K–46K`
(62) — because no ranked account carries a quote today: until quotes flow in, the estimator is
in practice the ICP prior map, which is a fact Track B should weigh when it proposes a naive
baseline. The ledger row `R4-snapshots-empty` keeps its id so the flip is visible in history.

## 37 · The working surface is the Prospect Board; the boards stay; raters join at release (17 September 2026)

Three of the five owner decisions in `docs/REPAIR-PLAN.md`, answered by the owner on 17 Sep.
Recorded in the owner's terms first, then what follows from them.

**Decision 1 — the surface is "the page", and the page is the 16 Sep Prospect Board.** The owner
pointed at the board he has been working from (a claude.ai artifact: the top 100 of
`pb_prospect_board` as of 16 Sep, with a dossier per row) and said: *"This artifact is the page
that I want to codify, and I want to work from here and iteratively, continuously improve this
page. I want this page to be recorded as the page. Now we can make more user experience, format
and layout and design it so it's more usable, but I don't want to reinvent this constantly."*
And on what it shows: *"I don't know if these numbers and grades and everything are accurate …
I always want the best, most accurate, most confident data to be displayed on these screens."*

What that artifact is, measured: a **static snapshot** — 100 rows of JSON embedded in the HTML,
no fetch, no Supabase, rubric 0.1.3 (retired the next day), taken 16 Sep. It renders
`pb_prospect_board`, a view that ranks one row per company by the engine's own
`chase_rank_key` and carries **no composite score** (the view's comment says so and its SQL
confirms it — it reads `pb_current_reads.scorecard->'chase_rank_key'`). The dossier draws on
briefs, research reads, contacts, calls, facts, signals and the register. The `pb_chase_scores`
table (146 rows, a weighted `score int`) belongs to the *older* contact-ordered chase board, not
to this view.

What follows:

1. **The board becomes a live page in this repository**, reading the database on every load and
   showing the active rubric's reads, so "the most confident data" is by construction the
   nightly's — never a snapshot. The 16 Sep artifact is superseded the moment the live page
   exists; its design (rank by potential; tier, confidence and engagement as three axes that never
   touch; a dossier per row) is the design to keep and iterate.
2. **`web/index.html` is not replaced; it becomes the entry surface.** Today it is the signed-in
   back office (sign-in, candidate review, merges, the register). Decision 3 below needs exactly
   that: a page where people enter answers. Two pages, one record.
3. **Decision 2 follows from decision 1: the 16 Sep boards system stays.** Its 29 migrations are
   filed verbatim from `schema_migrations.statements` (the same way §32 filed four), tested, and
   the ledger's `known_unfiled_migrations` list goes to zero. `pb_prospect_board` is currently
   revoked from `anon` and `authenticated`; a live page needs a read grant, and under §5 (reads are
   public) that is `select` to `anon` on the view — with the dossier's contact and people data
   staying behind sign-in, because `pb_contacts` stays closed (CLAUDE.md).
4. **`pb_chase_scores` needs its own ruling**, deferred: it is a composite number, which the
   research's "do not build" list and PRO-0 both refuse. It is not what the board ranks by, so it
   can wait; it should not be displayed anywhere until ruled.

**Decision 3 — a second rater: yes, at release, with conditions.** *"We're still in development,
but once we release this, I need other people on the team to also contribute and answer the
questions. The key is the questions have to be in clear, direct, and plain language. And there
has to be a page where we can enter the information, and these records and decisions are kept
and can be evaluated."* So: PRO-5's rater lane is used, not struck; the Blind Test and per-rater
calibration stay in the plan as *release* work, not debt; and the entry page's requirement is
written here so it is not lost — every question a rater answers is a plain-language question
whose answer lands as a `pb_facts` row with `entered_by`, `observed_at` and an evidence label,
exactly as rule 8 already requires. The gate questions are the first candidates: 795 of 850
accounts have economics unknown and 758 have service shape unknown, which is why no gate can
bite today whatever its mode (unknown never parks).

**Not decided here:** decision 4 (does the gate bite — the owner asked for a worked example
first), decision 5 (the default branch), and STANDARDS §9's A1 and A2. Each is re-asked with
an example.

**Privacy note for the owner, not a ruling:** the 16 Sep artifact is shared by link and carries
contact names and staff names in its dossiers. The database keeps `pb_contacts` closed to the
public on purpose. The live page should follow the database, not the artifact.
