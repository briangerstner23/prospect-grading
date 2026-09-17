/**
 * Structural checks for web/board.html — the working surface (DECISIONS §37).
 *
 *   node --experimental-strip-types scripts/board_page_test.ts
 *
 * The board has no pure-helper block to slice: it is a fetch and a render. What can be checked
 * without a browser is the contract it must not break, and each of these has a reason.
 *
 *  - It reads pb_prospect_board and NOTHING that anon may not select. A page that fetches a
 *    closed table does not fail loudly — PostgREST answers 401 and the section renders empty —
 *    so the check is on the source, not the symptom.
 *  - It never sorts or scores. The rank comes from the engine's chase_rank_key through the view
 *    (rule 4, PRO-0); a `.sort(` here would be the page quietly inventing an order.
 *  - It carries the publishable key only.
 *  - It says UNVALIDATED and anticipated (PRO-1r, PRO-8).
 *  - It fails visibly rather than showing stale rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "..", "web", "board.html"), "utf8");

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/* 1 · every table it reads is one anon may select */
const OPEN = ["pb_rubric_versions", "pb_runs"];
const CLOSED = ["pb_contacts", "pb_members", "pb_promotions", "pb_potential_snapshots",
  "pb_webhook_inbox", "pb_briefs", "pb_account_reads", "pb_chase_scores", "pb_chase_board"];
const fetched = [...new Set([...page.matchAll(/get\("([a-z_]+)\?/g)].map((m) => m[1]))];
check("reads the board through the definer function, not the view",
  /rpc\("pb_board"\)/.test(page) && !/get\("pb_prospect_board/.test(page));
for (const t of fetched) check(`fetches only open tables: ${t}`, OPEN.includes(t));
for (const t of CLOSED) {
  check(`never fetches ${t} (closed to anon, or an unruled composite)`, !new RegExp(`get\\("${t}\\?`).test(page));
}

/* 2 · the page never invents an order or a number */
check("never sorts: the rank is the engine's, through the view (rule 4)", !/\.sort\s*\(/.test(page));
check("the function returns the engine's order; the page does not re-ask for one", /order by b\.rank|rpc\("pb_board"\)/.test(page));
check("renders the view's own rank column", /esc\(r\.rank\)/.test(page));
// A word-level ban on "score" catches its own comments and the pb-score source filter. What
// matters is that no score REACHES THE PAGE: no score field is read off a row and no element
// renders one. pb_chase_board (which carries one) is already barred above.
check("no composite score is read from a row (PRO-0)", !/\br\.(score|chase_score|rank_band)\b/.test(page));
check("no score column is rendered", !/>\s*Score\s*</i.test(page));

/* 3 · credentials */
check("carries the publishable key only", /sb_publishable_/.test(page));
check("carries no service-role or secret key", !/service_role|SUPABASE_SERVICE|PB_SYNC_TOKEN|eyJ/.test(page));

/* 4 · the vocabulary the register requires */
check("prints UNVALIDATED (PRO-8)", /UNVALIDATED/.test(page));
check("prints 'anticipated' beside the tier words (PRO-1r)", /anticipated/i.test(page));
check("says absence of contact is not evidence (rule 5)", /absence of contact is not evidence/i.test(page));

/* 5 · failure is visible, not silent */
check("has a failure path that tells the reader", /could not be read/.test(page));
check("shows nothing rather than something stale", /an empty board is an/.test(page));

/* 6 · the shape the owner asked to keep */
check("keeps the three axes", /Three axes that never touch/.test(page));
check("keeps the never-contacted edge", /untouched_high_potential/.test(page));
check("states scarcity as the head of the chase order, not the tier", /Platinum <em>and<\/em> qualified/.test(page));

/* 7 · it is one file, no build step */
check("one inline script, no bundler", (page.match(/<script/g) ?? []).length === 1);
check("no import or require", !/\bimport\s|\brequire\(/.test(page));

console.log(`board_page: ${passed} checks, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
