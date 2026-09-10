# Fit v0.2 — six observable criteria

A specification, not an implementation. It defines what gets asked, what counts as an answer,
and where the answer may come from, so that Apollo, a rater and a future collector all record
the same fact the same way. Nothing here is ruled; every criterion carries basis `reasoned`
and is a toggle.

## Why this exists

Dimension B — *is this work we're good at* — is currently carried by two fields:
`icp_class` on 90% of the book and `service_shape` on 12%. The result is that **571 of 680
anticipated tiers (84%) are the ICP class translated into a tier word**, unmoved by any of the
fourteen adjustment rules, because those rules read fields that hold no data at all
(`inhouse_dev_team`, `recurring_revenue_share`, `niche_positioning`, `already_outsources`,
`vertical_depth` — zero facts each).

So the fit read is a relabelled human judgment. These six criteria replace it with six
observations, each of which a person can check without a meeting.

Scope is Dimension B only. **Qualification (Dimension A) is not touched** — whether a deal is
real stays a separate read on a separate record, and a missing qualification fact must never
pull a fit grade down.

## The criteria

Each is answered **yes / no / unknown**. Unknown is not a no: a criterion nobody could
establish scores nothing and is not held against the agency (rule 5, *unknown is never
evidence*). Equal weight, no coefficients — fitted weights do not beat equal weights at this
sample size, and there will not be enough won-and-lost outcomes to fit any for years.

### 1 · `sells_build_work` — do they sell what we deliver?

**Yes when** the agency's own service list includes website builds, web applications, custom
development, e-commerce builds or app development — work WLIQ delivers.
**No when** the offer is strategy, media buying, brand, PR, content or SEO with no build
component.
**Unknown when** services are described only in abstractions ("digital transformation",
"growth partner") with no deliverable named.

*Sources:* Apollo keywords and industry; the agency's services page; Pipedrive "services of
interest". *Failure mode:* agencies list build work they subcontract or no longer sell. This
criterion says the demand exists, not that they are good at it.

### 2 · `no_inhouse_dev_team` — do they need someone to build?

**Yes when** no developer, engineer or technical roles appear on the team page, in job
postings, or in the headcount breakdown — the build capacity is not in the building.
**No when** developers are named, a technical lead exists, or they advertise engineering
capacity.
**Unknown when** the team is not published.

*Sources:* team page; careers page; Apollo departmental headcount. *Failure mode:* the strongest
single predictor in the July research and the easiest to get wrong — a two-person dev team can
mean they need overflow help, not that they need none. Where headcount is over ~40 and
developers are present, this is a genuine no.

### 3 · `client_budget_size` — who are their clients?

**Yes when** the agency's published work is majority for organisations that can buy real
projects: regional or national brands, funded companies, multi-location operators,
institutions.
**No when** the portfolio is majority single-location local businesses — one restaurant, one
salon, one trades business, one local practice.
**Unknown when** no client work is published, or fewer than three clients are identifiable.

*Sources:* **a person reading the agency's work or portfolio page. No API supplies this.**
*Failure mode:* portfolios show the flattering end of a client list. Read it as a ceiling on
what they sell, not an average. *Why it matters:* for a white-label supplier the client's
client sets the ticket size and the technical depth — the same service sold to a hospital
system and to a corner café are not the same business to WLIQ.

**Rater rule:** decide in ninety seconds from the work page. If you cannot, record unknown.
Do not research the clients individually; the point is what the agency chooses to show.

### 4 · `size_band_fit` — are they the right size?

**Yes when** headcount is roughly 8–40: enough client flow to need outside capacity, not
enough scale to have built a development team.
**No when** under 8 (the owner does everything, and the economics rarely clear the floor) or
over 40 with in-house build capacity.
**Unknown when** headcount is not established.

*Sources:* Apollo employee count; LinkedIn; the team page. *Failure mode:* purchased headcount
for firms under about ten people is mostly estimated rather than reported — for the smallest
agencies this field is noise, and `headcount_label` must say whether it was evidence or a guess.

### 5 · `recurring_work_shape` — will this repeat?

**Yes when** the agency sells retainers, care plans, managed services or ongoing support —
work that recurs rather than ends.
**No when** everything is project-shaped with a defined finish.
**Unknown** by default: this is rarely visible from outside.

*Sources:* services page pricing language; a discovery call. *Failure mode:* expect this to be
mostly unknown until someone asks. That is the correct outcome, not a gap to fill with a guess.

### 6 · `is_agency` — are they reselling our work?

**Yes when** they serve clients and would resell WLIQ's work under their own name.
**No when** they are a direct end-business buying for themselves — in scope under PRO-4, kept,
flagged, and excluded from agency-only adjustments.
**Unknown when** the model is unclear.

*Sources:* already recorded on 82% of the book from Pipedrive organisation type.

## Scoring

Count the yeses. Six criteria, one point each, no weights.

| Yeses | Fit reading |
|---|---|
| 5–6 | Strong |
| 3–4 | Moderate |
| 1–2 | Weak |
| 0 | No fit established |

**Answered count is reported beside the score and never folded into it.** "Strong on 5 of 6
answered" and "Strong on 5 of 6, two unknown" are different states and the page must show
which. This is the separation the current build gets wrong by letting missing facts suppress a
tier.

How the score maps onto a tier word is deliberately left open until there is something to
calibrate against. Until then it is reported as a fit reading beside the existing anticipated
tier, not instead of it.

## Fact keys

Every key is a `ProspectFeatures` key and a `pb_facts.key`, snake_case, with the usual
`evidence_label` of `evidence` / `inferred` / `claimed` / `unknown`.

| Key | Type | Notes |
|---|---|---|
| `sells_build_work` | boolean \| null | |
| `no_inhouse_dev_team` | boolean \| null | replaces reading `inhouse_dev_team` inverted |
| `client_budget_size` | `"buys_real_projects"` \| `"local_small"` \| null | |
| `client_evidence_count` | number \| null | how many clients were identifiable; guards criterion 3 |
| `size_band_fit` | boolean \| null | derived from `headcount`, not entered directly |
| `recurring_work_shape` | boolean \| null | |
| `is_agency` | boolean \| null | exists |

Two of these — `size_band_fit` and `is_agency` — are derivable from fields the book already
holds. The other four are new and none has a value today.

## What this does not do

It does not fit weights, and must not until roughly 100 won and 100 lost outcomes exist. It
does not change Dimension A. It does not touch the Client Book, whose method grades a live
relationship on margin, payment and momentum — none of which a prospect has, which is why
PRO-17 keeps the two systems apart. And it ships **UNVALIDATED (PRO-8)** like everything else
here, because a criterion set chosen by judgment is a hypothesis until outcomes test it.

## Before it can be built

1. `core/prospect_types.ts` carries a *do not change* note in CLAUDE.md. Four new keys means
   that note has to be addressed deliberately rather than worked around.
2. Collection is unresolved: this environment's egress proxy blocks agency websites
   (createfervor.com, egcgroup.com and theferg.com all refused), so criteria 1, 2, 3 and 5
   cannot be gathered from here. Apollo can supply 1, 4 and 6 at scale once a credit budget is
   set (PHASE0 A6, still open). Criterion 3 needs a person.
3. The slice to score first is the 200 in Sales Call Done or Quoting; 196 of them carry a
   domain, 121 a headcount, 27 a service shape.
