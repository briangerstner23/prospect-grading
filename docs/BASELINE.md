# Baseline — v0.1.0, frozen 10 September 2026

The grades this file records are the comparison point for every change that follows. Nothing
here is a ruling. It exists because the honest test of a grading model is *"what did it say
before we knew the answer, and what happened next"*, and that test is only possible if the
"before" is written down and left alone.

Freeze the tiers on a date, wait 6–12 months, then compare. This is the date.

## 1 · What is frozen

| | |
|---|---|
| Scoring run | `27724bb7-c002-40d3-bad3-3f93825ffeb6` — the nightly cron run of 10 Sep 2026, 06:15:06 UTC |
| Rubric | `0.1.0`, spec sha256 `77e436ce18d682fa2e0608edfe681bbdb99854fe118650ac79713b7dca671400`, engine fingerprint `18e704f2` |
| Commit | `09fdc15f5c75f881dfb15d5954b3f08daec45ad0`, also reachable as branch **`baseline-v0.1.0`**. A `v0.1.0-baseline` tag exists locally but could not be pushed — this environment's git proxy refuses tag refs with a 403 — so the branch is the shared anchor. |
| Accounts scored | 680 (one read each; `pb_current_reads` = this run) |
| Baseline fingerprint | `9b14748cb0d5e83e70269fca5402fa87` |

The fingerprint is `md5` over `account_id|effective_tier|status|cell` for all 680 rows, ordered
by account id under the `C` collation. Re-computing it and getting the same value proves the
baseline has not moved:

```sql
select md5(string_agg(account_id::text || '|' || coalesce(effective_tier,'-') || '|' ||
       coalesce(status,'-') || '|' || coalesce(cell,'-'), chr(10) order by account_id::text collate "C"))
from pb_reads where run_id = '27724bb7-c002-40d3-bad3-3f93825ffeb6';
```

## 2 · The distribution, as of the freeze

| Anticipated tier | | Status | | Dimension A facts present | |
|---|---|---|---|---|---|
| Bronze | 350 | Ranked | 610 | 0 of 4 | 226 |
| Silver | 163 | Unclassified | 61 | 1 of 4 | 305 |
| Gold | 104 | Parked | 9 | 2 of 4 | 129 |
| Platinum | 2 | | | 3 of 4 | 13 |
| (unclassified) | 61 | | | 4 of 4 | 7 |

Every scorecard carries `anticipated: true` and `validation: UNVALIDATED`.

## 3 · What must not happen to it

- **Do not delete from `pb_reads`.** It is append-only by design; a re-score adds rows and
  leaves these. `pb_current_reads` shows the latest per account, so it stops pointing at this
  run the moment anything re-scores — which is fine and expected. The baseline is the `run_id`,
  not the view.
- **Do not edit `core/rubric.prospect.v0.1.json` or the `0.1.0` row.** A change is a new
  version file and a new `pb_rubric_versions` row, previewed before activation (CLAUDE.md
  rule 4). Both versions coexist; that is what makes the comparison possible.
- **Do not hand-edit a read** (rule 6). `pb-score` writes them or nothing does.

## 4 · The test this baseline exists for

Pre-registered here so it cannot be chosen after the fact.

**Outcome.** For every one of the 680 accounts: did it become a paying client within 12 months
of 10 Sep 2026 (yes/no), and revenue in that window, counting **zero** for accounts that bought
nothing. Not first-year revenue among winners only — that restriction is what made the earlier
cohort test uninformative (§5).

**Four rankings compared on the same accounts, each recorded in advance:**

1. the v0.1.0 tier and chase order frozen above;
2. a 3–6 item equal-weight fit checklist;
3. recency of last project, for accounts with any billing history;
4. each rater's own ranking of their named accounts, written down before the window opens.

**Reported as** Spearman's rho *and* Kendall's tau-b (tau-b handles the heavy tier ties better),
each with a 95% interval, plus a plain table of win rate and revenue by tier.

**The bar for letting the model steer routing** — all three, not any one:

- the low end of the 95% interval is above zero;
- win rate and revenue rise Bronze → Platinum with no reversals;
- it beats rankings 2, 3 and 4.

## 5 · Why the existing ρ = 0.27 is not evidence of failure

`docs/DECISIONS.md` decision 3 records that the cohort test "failed". The rubric carries the
full figure: **ρ = 0.270, CI [−0.142, 0.647], n = 31**, against cohort year-one billings.

Three things follow. The interval spans zero, so the result is compatible with the model being
useless *and* with it being good — it does not distinguish. The cohort is clients only, so the
range is restricted by selection, which pushes an observed correlation down. And detecting a
true 0.27 at 80% power needs roughly 110 accounts, not 31.

So PRO-8's threshold was not met, and the label **UNVALIDATED** is correct and stays. But
"not yet shown to work" is not "shown not to work", and no change to the rubric should be
justified by that number. Change the model where the *structure* is wrong; leave the weights
alone until an adequately powered test says something.
