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
