# Prospect Book — what is outstanding, and what I need from you
18 September 2026. Ten agents investigated five questions against the live database and every
branch; each investigation was then adversarially re-checked by a second agent that re-ran the
measurements. All five came back "mostly sound" — meaning the substance held but individual
numbers were wrong. The corrected numbers are the ones used here.

---

## First, a correction to what I told you earlier

**I said the auto-approve "has never fired" and would "confirm nothing". That was wrong in the
way that matters.** The 06:00 scheduled job has genuinely never run — that part was right. But
the function was run **by hand three times on 18 September**, and it has already written facts
into your book:

| | |
|---|---|
| Decisions the machine has made about your book | **333** |
| Of those, facts actually written and still live | **89**, across **53 agencies** |
| Reviewed by a person | **0** |
| One batch that was undone | 267 decisions / 23 facts, undone 21 minutes later |

So this is not a future risk you are deciding about. It already happened, and nobody has read
it. For comparison, people have made 23 decisions on this queue. The machine has made 333.

**Two other things I told you that need correcting:**

- I cited "21 of 21 tests passing" and "22 of 22" as reassurance, more than once. The test suite
  loads seven old rubric versions and **never loads the one currently in force**. Those passes
  say nothing about whether the rules grading your agencies are correct.
- I described the pinned-commit risk as "nightly scoring stops". Closer to the truth: deleting
  those branches would **not** stop tonight's grading — the deployed function keeps running. What
  you would lose is the ability to redeploy, reproduce or read the code that is running. Serious,
  but a record-keeping loss rather than an outage.

---

## The thing nobody mentioned: your page has been frozen since Thursday night

Your repository's default branch is **not `main`**. It is one of the old session branches, six
commits behind. That single setting is why every attempt to publish the board page has failed
since 17 Sep 22:31 — the publishing environment only accepts the default branch. Every run since
has failed in 3 to 12 seconds.

So the page you have been looking at and making judgements from is a day and a half stale, and
the six-hourly health check has been running against old code the whole time.

**This is two clicks to fix and I cannot do it — it is a GitHub repository setting.**

---

## Question 2 — the 77 claims. My answer: don't switch it on as it stands.

An agent read all 77 by hand. **Roughly one in three attaches a real sentence to the wrong field
or the wrong company.** The pattern is consistent and it is always the same mistake: the sentence
was said by *your* side, or was about a third party named on the call.

Shaped examples, never named:
- your own agreed follow-up ("send an update early next week") became *the prospect's* one-week buying timeline
- a blank job-title field in the CRM became "we have not met a decision maker"
- "no alternative partners were mentioned on the call" became "they have no competing vendor" — twice
- a note about one developer plus one teammate became a company headcount of two
- a sentence stating *your own firm's* preference for ongoing work was recorded as the prospect's way of working

The quote check cannot catch this, and neither can the source gate added on 18 September: all 77
come from the two channels that gate already trusts. The check proves the sentence exists. It
proves nothing about who said it or who it was about.

**What switching it on would do:** 13 agencies change the words printed beside their name. Five
of those currently show your top tier.

**Where the real queue is.** Of the ~1,053 claims still waiting on a person, **831 come from one
reader — the website reader**, the one your own 18 September spot check found unreliable. Only
189 come from call summaries and 33 from CRM notes. Rejecting that one channel as a class takes
the human queue from about a thousand to about two hundred. That is the difference between
impossible and a week of tidying. A bulk-reject path already exists; a bulk-confirm path was
deliberately never built.

### Recommendation, in order
1. **Read the 89 facts already written.** Twenty minutes. If you don't like what you see, that is
   also your answer about the new lane.
2. **Decide about the website reader's 831** — that is the actual queue, and it is one decision.
3. **On this lane: switch it on for descriptive fields only** — 32 of the 77 sit on keys the
   current rubric never reads, so admitting them cannot move any tier. Needs a small change first
   (the policy can filter by channel today, not by field). Caveat from the verifier: "zero effect"
   means zero *under today's rules* — if you later activate the draft rubric waiting on your ICP
   decision, those 32 become grade-bearing retroactively.

### And a live one: tomorrow at 06:00
The scheduled job fires for the first time tomorrow. At 05:45 the sweep adds new claims; at 06:00
the approver writes whatever the three *already-enabled* lanes match, unattended; at 06:15 the
scorer publishes the result. They match zero rows today, but tomorrow's new claims are not today's.
**Doing nothing is a choice to let that run unwatched.** Say the word and I will disable the job
until you have decided.

---

## Question 3 — the decision ledger. My answer changed.

I previously said drop the renumbering. Having seen the measurements, that was too blunt — **the
defect it fixes is real**. Sections 28 through 33 each name two completely different decisions
right now, and 89 references across 28 files point at a number two rulings both claim.

But merging that branch as it stands is a trap the verifier caught: it **trades six duplicate
numbers for two new ones, and the two it creates are invisible at merge time** — no conflict
marker points at either. It also makes ~646 references wrong across the other branches, and
breaks 11 migration files that currently match what actually ran.

**Recommendation: the middle option.** Move only the six genuinely duplicated sections, leave
everything from 34 upward alone. One to two hours instead of a full day, and the other branches
stay correct. Do it *after* the rule below.

Take two things from that branch regardless: its translation table (so old citations still decode),
and commit `5cf22ef`, which fixes nine references that have genuinely pointed at the wrong section
since 17 September. That is a real bug fix unrelated to renumbering.

**Do the prevention first — under an hour.** A rule that new sections take the next free number,
plus a script that fails the build on a duplicate. You have had three collisions in three days and
nothing currently detects a fourth.

---

## The merge plan — proven, not predicted

An agent test-merged all seven branches in a throwaway copy and ran the suite. Six can land today
in a specific order, ending green. The seventh is the renumbering one, which should be redone
afterwards rather than merged.

| Step | Branch | What you get | Cost |
|---|---|---|---|
| 1–3 | the three clean ones | live scoring rule and both live functions stop existing only on side branches | minutes |
| 4 | LinkedIn + ceiling arithmetic | LinkedIn sourcing, ceiling shows its working | mechanical, scripted |
| 5 | the names check | catches agency names the current checker misses | mechanical, scripted |
| 6 | removals | taking an agency off the board | the only genuine logic conflicts — 3 judgement calls |
| — | renumbering | **do not merge** — redo per above | — |

Roughly half a day for all six. **If you only have an hour, the first four steps are a complete
stopping point on their own** and remove the two most dangerous exposures.

Correction to my earlier estimate: a fast-forward files **14** of the 25 missing migration files,
not 23. Getting the record complete needs four moves, not one, and about half a day.

---

## What I need from you

Ordered by cost-to-you, cheapest first. The first two are minutes and I cannot do either.

| # | Decision | My recommendation |
|---|---|---|
| 1 | **Set the default branch back to `main`** (GitHub setting) | Yes — unfreezes your page, two clicks |
| 2 | **Disable the 06:00 auto-approve job until you've decided?** | Yes, unless you want it running unwatched tomorrow |
| 3 | Shall I merge the six branches? (all, or first-four-only) | All six if you want it done; first four if you want it safe |
| 4 | The 831 website-reader claims — reject as a class? | Read a sample first, then decide. This is the real queue |
| 5 | The 77-claim lane | Descriptive fields only, after you've read the 89 |
| 6 | Ledger numbering | Prevention rule now; move only the six duplicates |

Two more worth an hour each, whenever: all nine of your overrides silently expire 16–17 December
2026 and nothing on the board will say so; and five of six override-refusal paths are silent.
