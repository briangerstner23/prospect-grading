# PLAN — turning effort into a book that learns

**Status: proposed, not ruled.** Written 16 September 2026 after the owner asked whether the
chase-list work was accumulating in Supabase or only iterating. The honest answer was *only
iterating*, and this is the plan to change that. Nothing here is a ruling; `docs/DECISIONS.md`
records what actually lands.

---

## 1 · Where the work went

Two days of effort produced three kinds of output. Only one of them survives a container restart.

| Produced | Lives in | Survives? |
|---|---|---|
| Migrations, engine changes, source precedence, the website fetcher | the repo + Supabase | **yes** |
| 844 stripped site page texts across 380 agencies | `pb_website_reads` | **yes** |
| 146 site reads — each field with a verbatim quote, each checked by a skeptic (283 claims stripped) | a JSON file in `/tmp` | **no** |
| 80 sales briefs — location, headcount + confidence, our history, partner angle, watch-outs, next step | a JSON file in `/tmp` | **no** |
| The chase ranking and the weights that produced it | a Python file in `/tmp` | **no** |
| A critic's review of the ranking | a JSON file in `/tmp` | **no** |

And the number that matters most:

```
select count(*) from pb_facts where source = 'website';   -->  0
```

We read 380 agencies' websites and the book knows nothing new about any of them. The tier the
engine computes tonight is the tier it would have computed without any of this work.

## 2 · The tables already exist. They are empty.

This is not a system that needs building. It is a system that was built and never switched on.

| Table | Designed to hold | Rows today |
|---|---|---|
| `pb_fact_candidates` | a machine's claim + `quote` + `evidence_label` + `source` + `confidence` + `extractor` + `conflicts` + `current_value`, awaiting a person | 456, of which **431 unreviewed**; **0** from `website` |
| `pb_potential_snapshots` | `p10/p50/p90` at 12m and 24m, `p_35k_12m`, `p_100k_24m`, then `actual_6m/12m/24m` and `brier` | **0, ever** |
| `pb_promotions` | the moment a prospect becomes a client (PRO-10, PRO-18) | **0** — while three accounts in our own top seven are already clients |

`pb_fact_candidates` has a `quote` column and a `confidence` column. That is precisely the shape
the site readers produced, field for field. The pipe was laid and nothing was ever poured down it.

`pb_potential_snapshots` is the learning loop. It has columns for the prediction *and* columns for
what actually happened. Zero rows means no prediction has ever been checked against an outcome,
which is why PRO-8 validation sits at rho 0.270 and does not move. It will not move on its own.

## 3 · Five moves, in order

### Move 1 — land the reads as fact candidates · **this week, time-critical**

The 146 reads carry quoted, skeptic-checked values for `is_agency`, `agency_type`,
`headcount` (counted off team pages), `delivery_headcount`, `sells_build_work`,
`build_demand_exceeds_capacity`, `recurring_work_shape`, `client_budget_size`, `wl_signal`,
`years_operating`, plus a reasoned `serviceable_share`. Write each as a `pb_fact_candidates` row
with `source = 'website'`, the verbatim quote in `quote`, the skeptic's verdict in `note`, and
`conflicts` set where it disagrees with what is already on file.

Two rules make this safe and they are already in the book: rule 8 (a machine proposes, a person
decides) and the source precedence ruled on 15 September (`website` outranks `apollo` and
`pipedrive`). So a confirmed counted headcount immediately beats Apollo's inflated one — a counted
35 against Apollo's 68, a counted 10 against 30, a call-stated 15 against 36.

**Do not dump all of them.** 431 candidates are already unreviewed; adding 900 more makes the queue
useless. Propose only fields that would *change* something: a value that differs from what is on
file, or fills a null the engine currently defaults. Rank the queue by how much the tier moves.

*Time-critical because the source data is in a session scratch directory that is deleted when the
container is reclaimed.* Everything else here can wait a week; this cannot.

### Move 2 — give the briefs and the ranking a home

Two new tables, both service-role written, both versioned by `generated_at`:

- `pb_briefs` — one row per (account, generated_at): the brief JSON, the model, a hash of the
  inputs it was built from. Then December's brief can be diffed against September's and you can
  see what changed about an agency rather than regenerating an opinion from scratch at full cost.
- `pb_chase_scores` — one row per (account, run): the score, the breakdown, the weights version,
  and the exclusion reason where one applies. A rank becomes reproducible and comparable over time.

### Move 3 — the chase weights become rubric data

Today the ranking that decides who gets called lives in a Python file nobody can review, while the
engine has its own `chase_rank_key`. Two rankings, one of them undocumented. Rule 4 says the rubric
is data: make the chase weights `core/rubric.chase.v0.1.json` with a `pb_rubric_versions` row, so
they are versioned, previewable and diffable like every other threshold in the book. Then
"why is this one first" is answered by a spec, not by a script in a temp directory.

### Move 4 — take the first snapshot · **the actual answer to "are we learning"**

Freeze today's prediction for the top 60 into `pb_potential_snapshots`: anticipated tier, ceiling,
headroom band, chase score, confidence, and the assumptions behind them. Then score it at 90 and
180 days against what really happened. The rubric already specifies this (`snapshot_at_signing`,
`scored_at_months [6, 12, 24]`); nothing has ever been written.

Without this, every future session re-derives opinions from the same thin evidence and nobody can
say whether the book got better. With it, in 90 days there is a measurable answer: did the top 20
convert at a higher rate than 21–60, and did the engine's tier predict anything the chase score did
not. That is the difference between accumulating and iterating, and it costs one migration plus one
insert.

### Move 5 — outcomes write back

`pb_promotions` is empty while three accounts in our own top seven are already delivering with
WLIQ — the chase list found that out by reading call notes, not because the book knew. Close the
edge: a won deal or a promotion writes a row, and an account that becomes a client leaves the chase
list automatically instead of being caught by a critic.

## 4 · The brief concerns, by how confidently we can fix them

**Mechanical — a query or a data load, no judgement needed**

1. *Apollo headcounts run high.* ~39 accounts have a counted team-page number from the reads.
   Part of Move 1; fixes itself the moment those candidates are confirmed.
2. *`is_agency` null lets non-agencies through* — three in the top 60 were never flagged.
   Part of Move 1 — the reads have it quoted for most of them.
3. *Deals contradicting themselves.* One account sits at stage "Quote Lost" with a five-figure
   deal still open. `pb_deals` has `stage_entered_at`, `status`, `value` — a nightly exception
   report is a view, not a project. Add it to the movement views.
4. *Stale live deals.* A quote promised in June and never sent, a six-figure deal untouched since
   August, three more promised quotes with no delivery recorded. Same exception report: open deal,
   no stage movement in N days.
5. *pb-notes filing WLIQ's own numbers as prospect facts* — one account carries `headcount = 100`
   quoting "WL IQ is a 100-person team". Already specified: a subject check in `notes_sweep.ts`, a
   phrase pre-filter as rubric data, and a migration lowering the three bad rows to `unknown`.

**Needs a ruling from you**

6. *Engagement is a CRM stage label, not contact.* 22 of the top 60 sit at "Sales Call Done" with
   no call on file; one account has been "Super Hot" for seven months. The chase score already
   halves engagement when there is no recorded call, but that is my patch, not the engine's rule.
   The engine question is whether `stated_timing` should decay when the stage has not moved in N
   days. That is a rubric toggle and it is the critic's number-one method problem — but
   `stated_timing_wins` is an open item you have not ruled, so I am not touching it.

**Cannot be fixed with data**

7. *The 22 missing calls.* I checked: 826 calls in `pb_calls` have no account attached, but only
   **one** matches a prospect domain — the rest are Client Book calls. Those calls were never
   recorded. No amount of re-attribution recovers them. The fix is that the call gets recorded,
   or the outcome gets typed into Pipedrive, at the time. Until that changes, roughly a third of
   the chase list will keep resting on a stage label with nothing behind it.

## 5 · What "consistent" means here

Three loops have to close, and today none of them do:

- **Read → know.** A machine reads something, a person confirms it, the engine uses it. Broken at
  the last step: 380 reads, 0 facts. Move 1.
- **Assess → remember.** An assessment is stored, versioned and diffable, not regenerated. Broken
  entirely. Moves 2 and 3.
- **Predict → check.** A prediction is frozen and scored against what happened. Never started.
  Moves 4 and 5.

Until those close, every session starts from the same evidence and produces a fresh opinion at full
cost, and the only thing that accumulates is the engine — not the knowledge.
