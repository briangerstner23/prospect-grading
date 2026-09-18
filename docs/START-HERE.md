# START HERE

One page. Read it before anything else in this repository, including `CLAUDE.md`.

If you are a new Claude session, a new operator, or a different Claude account being pointed at
this project for the first time, this file tells you what you have, what you do **not** have, and
what you must not assume.

---

## 1 · What this is, in one paragraph

The Prospect Book grades marketing agencies that are **not yet** White Label IQ clients. One row
per agency, four independent reads, never summed into a single score. The output is a rank and a
band, never a composite number. It scores ~830 agencies every night at 06:15 UTC and publishes a
board a person actually works from. It is a **separate system** from the Client Book, which grades
existing clients and lives in a different repository.

## 2 · The thing most likely to mislead you

**This repository is not the whole system, and that is deliberate.** Three things live outside it:

| What | Where | Why it is not here |
|---|---|---|
| **The Grading Register** — the authority | `wliq-momentum`, at `client-grading/ingest/prospect_rulings.json` | It governs both books, so it belongs to neither |
| **Every prospect fact** — accounts, facts, reads, the roster | Supabase project `sgagrmapuovnjwvgsxbp` | Rule 2: this repository is PUBLIC |
| **Credentials** | Supabase Vault (`PB_*`) | Same reason |

### Read this twice

`CLAUDE.md` rule 1 says: *"The register wins over the brief. The Grading Register's PRO-0 … PRO-18
are authoritative."* Seventeen PRO-numbers are cited across this repository's code and documents.

**No session has ever read the Register directly.** `docs/GRADING-REVIEW-2026-09-18.md` §7 states it
plainly: *"It did not read the Grading Register, which no session has read directly; every
PRO-number claim is second-hand through the ledger, and the register wins where they disagree."*

So: every PRO-citation you find here is inherited, not verified. If you ever get access to
`wliq-momentum`, checking the code against the Register is the single highest-value unclaimed job in
this project. Until someone does, treat PRO-numbers as *reported*, and say so when you rely on one.

## 3 · What you need connected to actually work

| Need | For | Without it |
|---|---|---|
| **Supabase MCP → `sgagrmapuovnjwvgsxbp`** | everything | You have the machine and no fuel: no accounts, no facts, no roster |
| **GitHub write access** | pushing, CI | You can read (public repo) but not change anything |
| `wliq-momentum` read access | the Register | You inherit an unverified authority (see above) |

Not required: Pipedrive, Fathom, Orbit and Gmail connectors. Those feed the book through webhooks
and Vault credentials inside Supabase, independently of any Claude account. A connector only helps a
*session* look something up.

**Known gap:** the GitHub Actions secret `SUPABASE_ACCESS_TOKEN` is **not set**, so CI's
"deploy-from-source" job skips every run. Edge functions are deployed by hand through the Supabase
MCP instead. Nothing is broken; it is simply not automatic, and the workflow says so when it skips.

## 4 · The one habit that matters

Every serious problem this project has had traces to the same cause: **parallel sessions writing
their own version of the truth into one repository and one live database.** On 18 September that
produced seven unmerged branches, five rulings numbered §50, a scoring engine pinned to a commit on
no mainline, and twenty-five database changes with no file.

So:

1. **One session at a time.** Finish or park one before starting the next.
2. **Start from `main`**, never from where the last session stopped.
3. **When a session says "applied", ask "filed?"** A database change with no migration file is the
   most dangerous state this project reaches.

## 5 · Prove you are oriented — five minutes

Do not trust any number written in prose, including in this file. Measure:

```bash
npm test                                          # every test, incl. the docs checks
node --experimental-strip-types scripts/reconcile.ts   # does the record match the running system?
ls core/rubric*                                   # which rubric files exist
```

Then, against the database:

```sql
select version, status from pb_rubric_versions where status = 'active';
select jobname, schedule, active from cron.job order by jobname;
```

`reconcile.ts` is the honest one: it compares what the repository *declares* against what is
actually *running*, and fails when they disagree. CI runs it on every push and every six hours. If
it is green, the record is true. If this file and `reconcile` disagree, **`reconcile` is right.**

## 6 · Where to go next

| You want | Read |
|---|---|
| The rules and the layout | `CLAUDE.md` |
| Why something is the way it is | `docs/DECISIONS.md` — the ledger, §1 … §60 |
| How to operate it | `docs/RUNBOOK.md` |
| The design | `docs/DESIGN.md` |
| What was true on a known-good date | `docs/STATE-SNAPSHOT-2026-09-17.md` |
| An orientation walkthrough | `docs/HANDOFF-2026-09-17.md` |

### Two quirks of `docs/DECISIONS.md` that will confuse you

1. **Two heading styles.** §1–§42 are written `## 12 · Title`; §43 onward are `## §43 — Title`.
   Both are decision numbers. Unifying them moves ~650 citations, so it has not been done.
2. **Six numbers mean two things.** §28 through §33 each name *two different rulings* — one in each
   heading style — because parallel sessions collided. 109 citations across 34 files are therefore
   ambiguous, and each needs reading in context to tell which is meant.

`scripts/docs_consistency_test.ts` grandfathers exactly those six and **fails the build on any new
collision**, so the count can only shrink. Cleaning up the six is a well-scoped, unclaimed job.

---

*If anything in this file disagrees with the running system, the running system is right and this
file is a bug. `scripts/docs_consistency_test.ts` keeps the checkable parts honest; the rest is on
whoever edits it.*
