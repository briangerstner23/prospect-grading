/**
 * WLIQ Prospect Book — what a sales meeting says stays behind sign-in (DECISIONS §65), pinned in text.
 *
 * Three guards keep the team's words about named agencies off the public reads: the sentinel block
 * inside the reader's migration (a leaking version cannot apply), the live canary in
 * pb_reconcile_state() that CI runs every six hours, and this file, which runs on every npm test
 * and needs no database. It reads the migrations, the function sources and the pages, and fails
 * when a later change would quietly undo a filter. The objects it pins are whole-object
 * replacements — one stale `create or replace` loses every ruling a later file added (§50a, §53a)
 * — so each is read from the NEWEST migration that defines it, never from a named file.
 *
 * It also pins the shapes the reader's design depends on: the four tables are closed to anon and
 * narrower than pb_facts for everyone else; no meeting migration grants anything to anon; the
 * decide function writes pb_facts with no quote and no link; nothing writes pb_fact_candidates;
 * the SQL copy of the title patterns equals MEETING_TITLE_PATTERNS; the schedule only posts when
 * there is work; the two definer reads of a removal's written reason (pb_removed, pb_removal)
 * answer a WLIQ address only, as pb_register's own policy does; the sentinel exercises the trace
 * strip on a real read before apply.
 *
 * Run: node --experimental-strip-types scripts/meeting_privacy_static_test.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { MEETING_TITLE_PATTERNS } from "../ingest/meeting_transcript.ts";
import { PROPOSAL_COLUMNS, PROPOSAL_DB_COLUMNS } from "../ingest/meeting_claims.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const migDir = join(root, "supabase/migrations");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

/** SQL with its line comments removed, so prose about a grant is never read as one. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
const text = new Map(files.map((f) => [f, readFileSync(join(migDir, f), "utf8")]));

/** The newest migration whose CODE matches `re`, and the text of that definition up to `end`. */
function newest(re: RegExp, end: RegExp): { file: string; body: string } {
  let hit = { file: "", body: "" };
  for (const f of files) {
    const sql = code(text.get(f) ?? "");
    const m = re.exec(sql);
    if (!m) continue;
    const rest = sql.slice(m.index);
    const e = end.exec(rest);
    hit = { file: f, body: e ? rest.slice(0, e.index + e[0].length) : rest };
  }
  return hit;
}

/* ------------------------------------------------------------------ *
 * 1 · pb_dossier: the three §65 filters, and every earlier ruling
 * ------------------------------------------------------------------ */
{
  const def = /create\s+(?:or\s+replace\s+)?function\s+public\.pb_dossier\s*\(/i;
  const d = newest(def, /\$function\$;/);
  check("a migration defines pb_dossier()", d.file !== "");
  // A patch-style redefinition (a DO block that executes replace() over the live body, the way
  // 20260918110000 added linkedin_url) is invisible to a text pin. It must never be the newest.
  const patchers = files.filter((f) => {
    const sql = code(text.get(f) ?? "");
    return /pb_dossier/.test(sql) && /pg_get_functiondef/i.test(sql) && /execute\s+replace\s*\(/i.test(sql);
  });
  const lastPatch = patchers[patchers.length - 1] ?? "";
  check("the newest change to pb_dossier() is a full definition, not a patch", lastPatch < d.file,
    `patched by ${lastPatch}, last fully defined by ${d.file}`);
  const must: Array<[string, string]> = [
    ["the sales_meeting facts filter", "f.source <> 'sales_meeting'"],
    ["the origin register filter", "coalesce(payload->>'origin', '') <> 'sales_meeting'"],
    ["the override.reason strip", "#- '{override,reason}'"],
    ["the override.approver strip", "#- '{override,approver}'"],
    ["STILL the removal filter (§59)", "kind <> all (array['removal', 'reinstatement'])"],
    ["STILL linkedin_url", "'linkedin_url', a.linkedin_url"],
    ["STILL the address scrub (§43a)", "'([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'"],
    ["STILL attendee names and side only", "'name', at->>'name', 'is_external', at->'is_external'"],
  ];
  for (const [what, needle] of must) check(`pb_dossier() (${d.file}) carries ${what}`, d.body.includes(needle));
  check("pb_dossier() reads no meeting table", !/pb_meeting/.test(d.body));
  check("pb_dossier() is still SECURITY DEFINER with a fixed search_path",
    /security\s+definer/i.test(d.body) && /set\s+search_path\s*=\s*public/i.test(d.body));
  check("the trace strip is conditional on a meeting-origin override",
    /when\s+exists\s*\(\s*select\s+1\s+from\s+pb_register\s+g[\s\S]{0,200}g\.kind\s*=\s*'override'[\s\S]{0,120}'sales_meeting'\s*\)\s*(?:or\s+exists\s*\([^()]*\)\s*)?then\s+jsonb_set\(\s*r\.scorecard\s+#-/i.test(d.body));
  // A merged record keeps its last read for good (pb_merge_accounts never moves a read; pb-score
  // scores prospect and parked only) while its override row moves to the survivor, so the
  // account-local test above finds nothing for it. A merged record is stripped whatever it holds.
  check("…or on the account being a merged record, whose read outlives the move of its override row",
    /'sales_meeting'\s*\)\s*or\s+exists\s*\(\s*select\s+1\s+from\s+pb_accounts\s+(\w+)\s+where\s+\1\.id\s*=\s*p_account_id\s+and\s+\1\.book\s*=\s*'merged'\s*\)\s*then\s+jsonb_set\(/i.test(d.body));
  const mergeSrc = code(readFileSync(join(migDir, "20260909120300_prospect_book_fixes.sql"), "utf8"));
  check("pb_merge_accounts still moves register rows and never a read (the case the merged-record strip covers)",
    /update\s+pb_register\s+set\s+account_id\s*=\s*p_target/i.test(mergeSrc) && !/update\s+(?:public\.)?pb_reads\b/i.test(mergeSrc) &&
    !files.some((f) => /create\s+or\s+replace\s+function\s+public\.pb_merge_accounts\b/i.test(code(text.get(f) ?? "")) && f > "20260909120300_prospect_book_fixes.sql"),
    "pb_merge_accounts was redefined after 20260909120300: re-check whether it now moves reads");
  // The engine writes the approver a second time, into trace.notes (core/engine.ts). The strip
  // rewrites that note in place, under the same condition, and the rewrite does what it says on
  // the engine's own sentence: the tiers and the code stay, the name goes.
  check("…and the approver leaves the engine's 'Override applied' note too",
    /jsonb_set\(\s*r\.scorecard\s+#-\s*'\{override,reason\}'\s+#-\s*'\{override,approver\}'\s*,\s*'\{trace,notes\}'/.test(d.body) &&
    /like\s+'Override applied:%'/.test(d.body));
  const rewrite = /regexp_replace\(n\s+#>>\s+'\{\}',\s*'([^']+)',\s*'([^']+)'\)/.exec(d.body);
  check("the note rewrite was found", rewrite !== null);
  if (rewrite) {
    // POSIX ARE and JavaScript agree on this pattern (no class shorthands, no lookarounds).
    const re = new RegExp(rewrite[1]);
    const js = rewrite[2].replace(/\\(\d)/g, "$$$1");
    const engineNote = (code: string, approver: string) => `Override applied: Silver → Gold (${code}, ${approver}).`;
    check("the rewrite keeps the tiers and the code and drops the approver",
      engineNote("relationship_known", "owner@example.test").replace(re, js) === "Override applied: Silver → Gold (relationship_known)." &&
      engineNote("no code", "someone, with a comma").replace(re, js) === "Override applied: Silver → Gold (no code).",
      engineNote("relationship_known", "owner@example.test").replace(re, js));
    const engineSrc = readFileSync(join(root, "core/engine.ts"), "utf8");
    check("core/engine.ts still writes the note in the shape the rewrite expects",
      engineSrc.includes("notes.push(`Override applied: ${computedTier} → ${ov.tier} (${ov.reason_code ?? \"no code\"}, ${ov.approver}).`);"));
  }
}

/* ------------------------------------------------------------------ *
 * 1a · pb_removed() and pb_removal(uuid): a WLIQ address or no rows
 * ------------------------------------------------------------------ */
{
  // Definer reads of pb_removals: pb_register's read policy cannot reach inside them, so each says
  // it itself. A removal's reason is free text a person may have typed from a meeting.
  for (const fn of ["pb_removed", "pb_removal"]) {
    const d = newest(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, "i"), /\$\$;/);
    check(`a migration defines ${fn}()`, d.file !== "");
    check(`${fn}() (${d.file}) returns rows only to a WLIQ address`, /\bwhere\b[\s\S]*\bpublic\.pb_is_wliq\(\)/i.test(d.body));
    check(`${fn}() (${d.file}) is still SECURITY DEFINER with a fixed search_path`,
      /security\s+definer/i.test(d.body) && /set\s+search_path\s*=\s*public/i.test(d.body));
    const toAnon = files.filter((f) => new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)[^;]*\\banon\\b`, "i").test(code(text.get(f) ?? "")));
    check(`no migration grants ${fn}() to anon`, toAnon.length === 0, toAnon.join(", "));
  }
}

/* ------------------------------------------------------------------ *
 * 2 · pb_current_facts and pb_reconcile_state: rule 9's new rank, and the canary
 * ------------------------------------------------------------------ */
{
  const v = newest(/create\s+or\s+replace\s+view\s+public\.pb_current_facts\b/i, /;/);
  check(`the newest pb_current_facts (${v.file}) ranks sales_meeting 0`, /when\s+'sales_meeting'\s+then\s+0\b/.test(v.body));
  check(`the newest pb_current_facts (${v.file}) restates security_invoker`, /with\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(v.body));
  const sqlOfView = code(text.get(v.file) ?? "");
  check("…and asserts it after the replace", /option_name\s*=\s*'security_invoker'/.test(sqlOfView));

  const r = newest(/create\s+or\s+replace\s+function\s+public\.pb_reconcile_state\s*\(/i, /\$\$;/);
  const rule9 = r.body.slice(r.body.indexOf("rule9 as ("), r.body.indexOf("notes_runs as ("));
  check(`the newest pb_reconcile_state (${r.file}) carries sales_meeting in its rule9 CASE`, /when\s+'sales_meeting'\s+then\s+0\b/.test(rule9));
  check("…and the meeting_privacy canary", r.body.includes("'meeting_privacy'") && r.body.includes("public.pb_dossier("));
  check("…and meetings_work", r.body.includes("'meetings_work'") && r.body.includes("'oldest_open_days'"));
  // Check 7's halt check reads the reader's newest finished run. This function is anon's, and a run's
  // notes (pb_runs.errors) name recordings and refs (RUNBOOK §33.6): status, time and counts only.
  const ml = /meeting_latest\s+as\s*\(([\s\S]*?)\n\)\s*,/.exec(r.body)?.[1] ?? "";
  check("…whose latest_run is the meeting reader's newest finished pb_runs row",
    /from\s+public\.pb_runs\b/i.test(ml) && /source\s*=\s*'sales_meeting'/.test(ml) &&
    /finished_at\s+is\s+not\s+null/i.test(ml) && /order\s+by\s+r\.finished_at\s+desc\s+limit\s+1\b/i.test(ml), ml);
  const lrAt = r.body.indexOf("'latest_run'");
  const lr = lrAt >= 0 ? r.body.slice(lrAt, r.body.indexOf("from meeting_latest", lrAt)) : "";
  check("…carrying the run's halted count", /l\.counts\s*->\s*'halted'/.test(lr));
  check("…and never pb_runs.errors (a run's notes name recordings; this function is anon's)",
    ml !== "" && lr !== "" && !/\berrors\b/.test(ml) && !/\berrors\b/.test(lr));
  check("the canary returns counts only (no quote column leaves it)",
    !/'meeting_privacy'[\s\S]{0,400}'(quote|needle|text)'\s*,/.test(r.body));
  // A merge moves the approved proposals and the register rows to the survivor and leaves the read,
  // so the merged record never appears among the accounts holding approvals; it is checked as theirs.
  const mc = /mp_checked\s+as\s*\(([\s\S]*?)\n\)\s*,/.exec(r.body)?.[1] ?? "";
  check("the canary also renders the records merged into the accounts it checks",
    /with\s+recursive\b/i.test(mc) && /a\.merged_into\s*=\s*c\.account_id\s+and\s+a\.book\s*=\s*'merged'/i.test(mc) &&
    /from\s+mp_checked\s+c\s*,\s*lateral\s*\(\s*select\s+public\.pb_dossier\(c\.account_id\)/i.test(r.body), mc);
  check("…and looks for the survivor's words in a merged record's dossier",
    /join\s+mp_docs\s+d\s+on\s+d\.owner_id\s*=\s*n\.account_id/i.test(r.body));
}

/* ------------------------------------------------------------------ *
 * 3 · the four tables, the grants, the six functions
 * ------------------------------------------------------------------ */
const meetingFiles = files.filter((f) => /pb_meeting|sales_meeting/.test(code(text.get(f) ?? "")) &&
  (/sales_meeting/.test(f) || /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.pb_meeting/i.test(code(text.get(f) ?? ""))));
check("the sales-meeting migrations are on disk", meetingFiles.length >= 2, meetingFiles.join(", "));
{
  let tables = 0;
  for (const f of files) {
    const sql = code(text.get(f) ?? "");
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(pb_meeting\w*)/gi)) {
      tables++;
      const t = m[1];
      const after = sql.slice(m.index);
      check(`${t}: row level security is enabled (${f})`, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i").test(after));
      check(`${t}: every privilege is revoked from anon AND authenticated (${f})`,
        new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?public\\.${t}\\s+from\\s+anon\\s*,\\s*authenticated`, "i").test(after));
      check(`${t}: authenticated gets SELECT back and nothing more (${f})`,
        new RegExp(`grant\\s+select\\s+on\\s+(?:table\\s+)?public\\.${t}\\s+to\\s+authenticated\\s*;`, "i").test(after) &&
        !new RegExp(`grant\\s+(?:all|insert|update|delete|truncate)[^;]*on\\s+(?:table\\s+)?public\\.${t}\\b`, "i").test(after));
      check(`${t}: its one policy is SELECT for the owner and rater lanes (${f})`,
        new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\s+for\\s+select\\s+to\\s+authenticated\\s+using\\s*\\(\\s*public\\.pb_is_wliq\\(\\)\\s+and\\s+public\\.pb_role\\(\\)\\s+in\\s*\\(\\s*'owner'\\s*,\\s*'rater'\\s*\\)\\s*\\)`, "i").test(after));
      check(`${t}: no write policy exists (${f})`,
        !new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\s+for\\s+(?:insert|update|delete|all)`, "i").test(sql));
    }
  }
  check("the four meeting tables are created", tables === 4, `${tables} found`);

  // The pure core and the table agree on every column: proposalRows() sends exactly
  // PROPOSAL_COLUMNS, and the database fills exactly PROPOSAL_DB_COLUMNS.
  const proposalsDdl = files.map((f) => code(text.get(f) ?? ""))
    .map((sql) => /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.pb_meeting_proposals\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1])
    .filter((x): x is string => typeof x === "string").pop() ?? "";
  const tableCols = proposalsDdl.split("\n").map((l) => /^\s{2}([a-z_]+)\s+[a-z]/.exec(l)?.[1])
    .filter((c): c is string => typeof c === "string" && c !== "constraint");
  const sorted = (xs: readonly string[]) => [...xs].sort();
  check("pb_meeting_proposals' columns are PROPOSAL_COLUMNS plus PROPOSAL_DB_COLUMNS, no more and no fewer",
    JSON.stringify(sorted(tableCols)) === JSON.stringify(sorted([...PROPOSAL_COLUMNS, ...PROPOSAL_DB_COLUMNS])),
    `table ${tableCols.length}: ${tableCols.join(",")}`);
  check("…and the insert columns are in PROPOSAL_COLUMNS' order",
    JSON.stringify(tableCols.filter((c) => PROPOSAL_COLUMNS.includes(c))) === JSON.stringify([...PROPOSAL_COLUMNS]));

  for (const f of meetingFiles) {
    const sql = code(text.get(f) ?? "");
    const toAnon = [...sql.matchAll(/\bgrant\b[^;]*\bto\b[^;]*\banon\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " ").trim());
    check(`${f} grants nothing to anon`, toAnon.length === 0, toAnon.join(" | "));
    check(`${f} never writes pb_fact_candidates (zero sales_meeting candidates, ever)`,
      !/insert\s+into\s+(?:public\.)?pb_fact_candidates\b/i.test(sql));
  }

  const a = meetingFiles.map((f) => code(text.get(f) ?? "")).join("\n");
  const six: Array<[string, string]> = [
    ["pb_decide_meeting_card", "authenticated"],
    ["pb_assign_meeting_mention", "authenticated"],
    ["pb_meeting_include", "authenticated"],
    ["pb_meeting_title_rule", "authenticated"],
    ["pb_dismiss_meeting", "authenticated"],
    ["pb_meeting_supersede", "service_role"],
  ];
  for (const [fn, who] of six) {
    const m = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(([\\s\\S]*?)\\$\\$;`, "i").exec(a);
    check(`${fn} is defined`, m !== null);
    if (!m) continue;
    const head = m[0].slice(0, m[0].indexOf("$$"));
    check(`${fn} is SECURITY DEFINER with search_path ''`, /security\s+definer/i.test(head) && /set\s+search_path\s*=\s*''/i.test(head));
    check(`${fn}: everything revoked from public and anon (the 20260918160352 lesson)`,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s+from\\s+public\\s*,\\s*anon\\b`, "i").test(a));
    check(`${fn}: executable by ${who} only`,
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s+to\\s+${who}\\s*;`, "i").test(a));
  }

  // The decide function writes a fact with no quote and no link: pb_facts is readable by every
  // signed-in address, so the words stay on the owner/rater-only proposal.
  const decide = /create\s+or\s+replace\s+function\s+public\.pb_decide_meeting_card\s*\([\s\S]*?\$\$;/i.exec(a)?.[0] ?? "";
  // Up to its `returning`, not the first ';' — the note's text carries one inside a literal.
  const ins = /insert\s+into\s+public\.pb_facts\b[\s\S]*?returning\s+id\s+into\s+\w+\s*;/i.exec(decide)?.[0] ?? "";
  check("pb_decide_meeting_card inserts into pb_facts", ins !== "");
  check("…naming no quote", !/\bquote\b/i.test(ins), ins.replace(/\s+/g, " ").slice(0, 160));
  check("…with evidence_url null right after the sales_meeting source", /'sales_meeting'\s*,\s*null\s*,/i.test(ins));
  check("…and the proposal it came from", /meeting_proposal_id/.test(ins) && /\bp\.id\b/.test(ins));
  // No register row a decision writes carries the quote: pb_register is readable by every signed-in
  // lane, the viewer's included, and an override's text is copied into pb_reads.scorecard.
  // Each insert up to its `returning`, or the end of its branch — a literal may hold a ';'.
  const regIns = [...decide.matchAll(/insert\s+into\s+public\.pb_register\b/gi)].map((m) => {
    const rest = decide.slice(m.index ?? 0);
    const ends = [/returning\s+id\s+into\s+\w+\s*;/i, /\n\s*(?:end\s+if|elsif)\b/i].map((re) => {
      const e = re.exec(rest);
      return e ? e.index + e[0].length : rest.length;
    });
    return rest.slice(0, Math.min(...ends));
  });
  check("pb_decide_meeting_card writes pb_register (fact notes, overrides, removals, reads)", regIns.length >= 4, String(regIns.length));
  check("…and no register insert names the quote", regIns.every((x) => !/\bp\.quote\b/i.test(x)),
    regIns.filter((x) => /\bp\.quote\b/i.test(x)).map((x) => x.replace(/\s+/g, " ").slice(0, 120)).join(" | "));
  check("…nor the recording (the proposal id is the pointer)", regIns.every((x) => !/'recording_id'/.test(x)));
  check("pb_decide_meeting_card holds the owner lane for tier calls and removals",
    /v_role\s*<>\s*'owner'[\s\S]{0,400}m\.kind\s+in\s*\(\s*'override'\s*,\s*'removal'\s*\)/i.test(decide));
  check("pb_decide_meeting_card re-derives against pb_current_facts", /from\s+public\.pb_current_facts\b/i.test(decide));
  check("pb_decide_meeting_card reads tiers, codes and expiry from the active rubric, never a literal",
    /'vocabulary'->'tiers'/.test(decide) && /'override'->'reason_codes'/.test(decide) && /'expiry_default_days'/.test(decide) &&
    !/interval\s+'90/i.test(decide) && !/'(Bronze|Silver|Gold|Platinum)'/.test(decide));

  // pb_facts: the column, its two-way check, and the trigger that keeps hand inserts out.
  check("pb_facts.meeting_proposal_id is added, nullable", /alter\s+table\s+public\.pb_facts\s+add\s+column\s+meeting_proposal_id\s+uuid\s+references\s+public\.pb_meeting_proposals/i.test(a));
  check("pb_facts_meeting_origin_check ties the source to the column both ways",
    /pb_facts_meeting_origin_check\s+check\s*\(\s*\(\s*source\s*=\s*'sales_meeting'\s*\)\s*=\s*\(\s*meeting_proposal_id\s+is\s+not\s+null\s*\)\s*\)/i.test(a));
  check("a trigger refuses the source and the column to every API role",
    /create\s+trigger\s+pb_facts_meeting_origin_guard\s+before\s+insert\s+or\s+update\s+on\s+public\.pb_facts[\s\S]{0,120}current_user\s+in\s*\(\s*'authenticated'\s*,\s*'anon'\s*,\s*'service_role'\s*\)/i.test(a));
  check("the proposal guard leaves only the decision columns mutable",
    /create\s+trigger\s+pb_meeting_proposal_guard\s+before\s+update\s+on\s+public\.pb_meeting_proposals/i.test(a) &&
    /to_jsonb\(new\)\s*-\s*array\['status',\s*'decided_by',\s*'decided_at',\s*'decision_note',\s*'result_id',\s*'superseded_by',\s*'account_id',\s*'matched_on',\s*'mention_state'\]/.test(a));
  check("migration A carries the sentinel and it rolls itself back", /do\s+\$sentinel\$/i.test(a) && /errcode\s*=\s*'PBS01'/.test(a) && /when\s+sqlstate\s+'PBS01'/.test(a));
  // The trace strip is exercised before apply, not only pinned in text: inside the rolled-back
  // block, a read whose scorecard carries the quote at override.reason and a random approver at
  // override.approver and in the engine's note; the dossier must render that read without either.
  const sentinel = /do\s+\$sentinel\$[\s\S]*?\$sentinel\$\s*;/i.exec(a)?.[0] ?? "";
  const rolledBack = sentinel.slice(0, sentinel.search(/errcode\s*=\s*'PBS01'/));
  const readIns = /insert\s+into\s+public\.pb_reads\b[\s\S]*?\);/i.exec(rolledBack)?.[0] ?? "";
  check("the sentinel writes a read inside its rolled-back block", readIns !== "");
  check("…whose override carries the quote as its reason and a random approver",
    /'reason'\s*,\s*'"'\s*\|\|\s*v_quote\b/.test(readIns) && /'approver'\s*,\s*v_appr\b/.test(readIns) &&
    /v_appr\s+text\s*:=\s*'pbappr'\s*\|\|\s*replace\(gen_random_uuid\(\)/.test(sentinel));
  check("…and whose trace carries the approver in the engine's note",
    /'notes'\s*,\s*jsonb_build_array\([^)]*\bv_note\b/.test(readIns) && /v_note\s*:=\s*'Override applied: '[^;]*v_appr\b/.test(rolledBack));
  check("…and the dossier must render that read, and fail on the quote or the approver",
    /'\{read,trace,override,tier\}'/.test(rolledBack) && /position\(v_quote\s+in\s+v_doc\)\s*>\s*0/.test(rolledBack) &&
    /position\(v_appr\s+in\s+v_doc\)\s*>\s*0/.test(rolledBack));
  // …and again once the account is merged away, its override row on the survivor and its read left.
  const afterMerge = rolledBack.slice(rolledBack.search(/update\s+public\.pb_accounts\s+set\s+book\s*=\s*'merged'/i));
  check("the sentinel merges the account (register to the survivor, book merged) and leaves its read",
    /update\s+public\.pb_register\s+set\s+account_id\s*=\s*v_surv\s+where\s+account_id\s*=\s*v_acct\s+and\s+kind\s*<>\s*'decision'/i.test(rolledBack) &&
    /update\s+public\.pb_accounts\s+set\s+book\s*=\s*'merged'\s*,\s*merged_into\s*=\s*v_surv/i.test(rolledBack) &&
    !/(?:update|delete\s+from)\s+public\.pb_reads\b/i.test(rolledBack));
  check("…then renders the merged record and fails on the quote or the approver",
    /v_dj\s*:=\s*public\.pb_dossier\(v_acct\)/.test(afterMerge) && /'\{read,trace,override,tier\}'/.test(afterMerge) &&
    /position\(v_quote\s+in\s+v_doc\)\s*>\s*0/.test(afterMerge) && /position\(v_appr\s+in\s+v_doc\)\s*>\s*0/.test(afterMerge));
  check("…and asks the canary to check it clean, then to count a leak on it",
    /'checked'\)::int,\s*0\)\s*<\s*2/.test(afterMerge) && /a deliberate leak on a merged record/.test(afterMerge));

  // The SQL copy of the title patterns (used when a title rule is forgotten) is MEETING_TITLE_PATTERNS.
  const sqlPatterns = /v_pattern\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i.exec(a)?.[1] ?? "";
  const fromSql = [...sqlPatterns.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const fromTs = MEETING_TITLE_PATTERNS.map((p) => p.source.replace(/^\\b/, "\\m").replace(/\\b$/, "\\M"));
  check("pb_meeting_title_rule's patterns equal MEETING_TITLE_PATTERNS (\\b → \\m … \\M)",
    JSON.stringify(fromSql) === JSON.stringify(fromTs), `sql ${JSON.stringify(fromSql)} vs ts ${JSON.stringify(fromTs)}`);
  check("MEETING_TITLE_PATTERNS are all case-insensitive", MEETING_TITLE_PATTERNS.every((p) => p.flags.includes("i")));
}

/* ------------------------------------------------------------------ *
 * 4 · the schedule posts only when there is work, and only the meeting source
 * ------------------------------------------------------------------ */
{
  const cronFile = files.filter((f) => /cron\.schedule\s*\(\s*'pb-meetings'/.test(code(text.get(f) ?? ""))).pop() ?? "";
  const sql = code(text.get(cronFile) ?? "");
  check("a migration schedules pb-meetings", cronFile !== "");
  check("pb-meetings runs every 3 minutes, clear of 05:00–06:59", /'pb-meetings'\s*,\s*'\*\/3 0-4,7-23 \* \* \*'/.test(sql));
  check("pb-meetings names ONLY sales_meeting", /'sources'\s*,\s*jsonb_build_array\(\s*'sales_meeting'\s*\)/.test(sql));
  check("pb-meetings keeps the nightly budget and concurrency", /'budget_ms'\s*,\s*110000/.test(sql) && /'concurrency'\s*,\s*6/.test(sql) && /timeout_milliseconds\s*:=\s*150000/.test(sql));
  check("pb-meetings posts only when there is work", /\)\s*where\s+exists\s*\(/i.test(sql) && /status\s*=\s*'waiting'/.test(sql) && /interval\s+'150 seconds'/.test(sql));
}

/* ------------------------------------------------------------------ *
 * 5 · pb_board() prints no register, fact or proposal text
 * ------------------------------------------------------------------ */
{
  const b = newest(/create\s+(?:or\s+replace\s+)?function\s+public\.pb_board\s*\(/i, /\$\$;/);
  check("a migration defines pb_board()", b.file !== "");
  check(`pb_board() (${b.file}) reads no meeting, register, fact or call text`,
    !/\bpb_meeting|\bpb_register\b|\bpb_facts\b|\bpb_fact_candidates\b|\bpb_calls\b|\bquote\b|\bnote\b/i.test(b.body));
  const cols = /returns\s+table\s*\(([\s\S]*?)\)\s*language/i.exec(b.body)?.[1] ?? "";
  check("pb_board() returns no reason, text, note or quote column", cols !== "" && !/^\s*(reason|text|note|quote|summary)\s/im.test(cols));
}

/* ------------------------------------------------------------------ *
 * 6 · the edge function and the public pages
 * ------------------------------------------------------------------ */
{
  const meetings = join(root, "supabase/functions/pb-notes/meetings.ts");
  if (existsSync(meetings)) {
    const src = readFileSync(meetings, "utf8");
    const forbidden = "pb_facts|pb_register|pb_fact_candidates|pb_calls|pb_signals|pb_contact_events";
    const write = new RegExp(`\\.from\\(\\s*["'\`](${forbidden})["'\`]\\s*\\)\\s*\\.(insert|upsert|update|delete)\\b`, "g");
    const sqlWrite = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?(${forbidden})\\b`, "gi");
    const hits = [...src.matchAll(write), ...src.matchAll(sqlWrite)].map((m) => m[0]);
    check("pb-notes/meetings.ts writes none of pb_facts, pb_register, pb_fact_candidates, pb_calls, pb_signals, pb_contact_events",
      hits.length === 0, hits.join(" | "));
  } else {
    console.log("  note: supabase/functions/pb-notes/meetings.ts is not written yet; its write-target pin runs once it exists");
  }
  for (const page of ["web/board.html", "web/dashboard.html", "web/method.html"]) {
    const p = join(root, page);
    check(`${page} exists`, existsSync(p));
    if (!existsSync(p)) continue;
    const html = readFileSync(p, "utf8");
    check(`${page} names no meeting table or source`, !/pb_meeting|sales_meeting/.test(html));
  }
  const harness = join(root, "scripts/meeting_privacy_check.sql");
  check("the operator harness exists", existsSync(harness));
  if (existsSync(harness)) {
    const h = code(readFileSync(harness, "utf8")).trim();
    check("the operator harness runs inside begin … rollback", /^begin;/i.test(h) && /rollback;$/i.test(h) && !/\bcommit\b/i.test(h));
    // A tier call is never taken as agreeing with a read pb_register has moved past: 4q (an override
    // written since the score) and 4r (one lapsed since) each send it as the page does and expect the
    // function's own refusal, and 4p's live override is a real register row written before the score.
    check("the harness refuses only_if_agrees against a read the register moved past (4q written since, 4r lapsed since)",
      /HARNESS 4q/.test(h) && /HARNESS 4r/.test(h) &&
      (h.match(/sqlerrm not like '%since the board was last scored%'/g) ?? []).length === 2 &&
      /insert into public\.pb_register \(kind, account_id, made_by, reason_code, text, payload, expires_at, created_at\)\s*values \('override', v_g,/.test(h));
  }
}

console.log(`meeting_privacy_static_test: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length) process.exit(1);
