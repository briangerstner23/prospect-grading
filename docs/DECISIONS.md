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
| 3 | Weights: run the lift analysis first, or equal weights and calibrate after a quarter? | PRO-12: enrichment first, then fit. PRO-8: pre-registered rank agreement ≥ 0.5; the cohort test on tier vs year-one ran and **failed** (ρ = 0.27); the pre-signing harvest has not run. | v0.1 ships **UNVALIDATED (PRO-8)** on every scorecard, with equal (±1 rung) adjustments and every basis labelled. The fit runs when the harvest exists; it is not in this repo's Phase 1. |
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
