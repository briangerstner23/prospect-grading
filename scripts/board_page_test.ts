/**
 * Structural checks for web/board.html — the working surface (DECISIONS §43).
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
import { readFileSync, existsSync } from "node:fs";
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
const CLOSED = ["pb_members", "pb_promotions", "pb_potential_snapshots",
  "pb_webhook_inbox", "pb_chase_scores", "pb_chase_board"];
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


/* 8 · the reader's choices, added 17 Sep after the owner saw it open dark */
check("opens LIGHT: no prefers-color-scheme rule decides the theme", !/prefers-color-scheme/.test(page));
check("dark is opt-in, under a data-theme attribute", /:root\[data-theme="dark"\]/.test(page));
check("the theme choice is remembered", /localStorage\.setItem\("pb-theme"/.test(page));
check("every localStorage touch is guarded (it throws in a private window)",
  (page.match(/localStorage\./g) ?? []).length === (page.match(/try \{[^}]*localStorage\./g) ?? []).length);

/* 9 · navigation between the screens */
check("navigates to the back office", /href="index\.html"/.test(page));
check("marks which screen you are on", /aria-current="page"/.test(page));


/* 10 · THE DOSSIER — the half this page shipped without (DECISIONS §49).
 * The owner ruled the 16 September artifact the layout to keep, dossier included. These pin the
 * sections so a later change cannot quietly drop them again, which is exactly what happened once.
 */
check("a row opens a dossier", /function openDossier/.test(page));
check("rows carry the account id that opens it", /data-account="/.test(page));
check("the dossier is read through pb_dossier()", /rpc\("pb_dossier", \{ p_account_id/.test(page));
// The dossier's SECTION NAMES are no longer pinned here, and that is the fix rather than a
// loosening. This list used to hold thirteen names and pass, while thirteen OTHER sections of the
// owner's approved layout were missing — because the list was written by reading the page I had
// just built. A check derived from the implementation cannot notice an absence: the absence is in
// the check too (DECISIONS §52).
//
// web/CONTRACT.json now owns the section names, written from the artifact the owner ruled, and
// scripts/contract_test.ts enforces presence, order and that nothing unrecorded was added. This
// file keeps what it is actually good at: the board's BEHAVIOUR.
check("the contract that owns the section names exists and is enforced",
  existsSync(join(here, "..", "web", "CONTRACT.json")) && existsSync(join(here, "contract_test.ts")));
check("the engine's reason sentence is shown verbatim", /read\.reason/.test(page));
check("the rubric version and fingerprint are shown", /rubric_fingerprint/.test(page));
check("facts show their evidence label", /evidence_label/.test(page));
check("prev / next / escape move between dossiers", /ArrowLeft/.test(page) && /Escape/.test(page));
// The dossier must render no PROSPECT address: not a contact's, not a call attendee's, not one
// out of a fact row. The SIGNER's own address is a different thing — the page shows it back to
// them as "recorded as <you>", which is how they know which account the register row will carry —
// so the ban is on the dossier's own data, by name, rather than on the word "email".
check("no prospect email address is rendered anywhere",
  !/\b(?:c|p|f|g|k|at|d|r|rd|br|acc)\.email\b/.test(page) && !/->>'email'/.test(page));
check("the only address the page shows is the signer's own",
  [...page.matchAll(/\b([A-Za-z_$][\w$]*)\.email\b/g)].every((m) => ["me", "u", "m"].includes(m[1])));
check("staff identifiers print as a name, not an address", /function localPart/.test(page));

/* 8 · the override panel (DECISIONS §50)
 *
 * The board writes in exactly one place, and it is the one thing on this page that can change
 * what the book says. Each check below is a way that could go wrong quietly:
 *
 *  - The page must not restate the rubric. Tiers, reason codes, the cap and the expiry are the
 *    contract (rule 4); a hard-coded list here would keep working after the rubric changed and
 *    would be wrong without failing.
 *  - The page must not imply it moved a tier. It writes a register row; the nightly run applies
 *    it, or refuses it. A reader who thinks the board already changed will misread the board.
 *  - pb_members is closed to anon. It may be read ONLY through the authenticated helper, with a
 *    session — never through get(), which carries the publishable key. The CLOSED loop above
 *    proves get() is not used for it; this proves the auth path is the one that reads it.
 *  - No session token may be baked into the file, and every storage touch stays guarded.
 */
check("the override is on the board itself, not only in the back office", /function overrideHtml/.test(page));
check("it writes one register row, of kind override", /kind: "override"/.test(page) && /authReq\("pb_register"/.test(page));
check("the write goes through the authenticated helper, never the anon one",
  !/get\("pb_register/.test(page) && !/rpc\("pb_register/.test(page));
check("tiers come from the rubric, not from a list in the page",
  /sp\.vocabulary && sp\.vocabulary\.tiers/.test(page));
check("reason codes come from the rubric", /ov\.reason_codes/.test(page));
check("the one-tier cap comes from the rubric", /ov\.max_tiers_moved/.test(page));
check("the expiry default comes from the rubric", /ov\.expiry_default_days/.test(page));
check("with no rubric it offers nothing rather than guessing", /offers nothing/.test(page));
check("the cap is stated before the reason is typed", /function capWarning/.test(page));
check("it never claims to have moved the tier", /does not move yet/.test(page));
// The lapse is the one way this board changes without anyone touching it, and a blank expiry
// field reads as "forever" while the engine actually derives set_at + the rubric default. If the
// page ever stops saying so, the reader is being quietly misled about the only silent change.
check("says plainly that a blank expiry is not forever", /clearing that date does not mean forever/.test(page));
check("points at a fact as the permanent correction", /facts never expire/.test(page));
check("it names when the override actually applies", /06:15 UTC/.test(page));
check("a refusal is attributed to the database, not the page", /the database decides this, not the page/.test(page));
check("the owner lane is the only one offered a form", /me\.role !== "owner"/.test(page));

/* 9 · the override from the list (DECISIONS §53)
 *
 * The tier chip on a row opens the same form the dossier carries. Three ways that goes wrong:
 *  - the chip's click also opens the dossier, so changing a grade navigates you somewhere else;
 *  - the chip lies, changing colour on click when the tier does not move until the nightly run;
 *  - the dialog and the dossier panel share element ids (they are the same form) and an unscoped
 *    getElementById hands the dialog the DOSSIER's fields — you type in one and submit another.
 *    That one is invisible in a screenshot and cost nothing to prevent, so it is pinned here.
 */
check("the tier chip is a real button, not a span with a handler", /button class="tier t-' \+ tierOf\(r\)/.test(page) || /class="tier t-' \+ tierOf\(r\) \+ ' ovrchip"/.test(page));
check("the chip opens the override, not the dossier", /button\[data-ovr\]/.test(page) && /stopPropagation/.test(page));
check("the dialog exists and can be closed", /function openOverride/.test(page) && /function closeOverride/.test(page));
check("Escape closes it", /e\.key === "Escape"/.test(page));
check("focus returns to the chip it was opened from", /ovReturnFocus/.test(page));
check("the form's lookups are SCOPED, so the dialog cannot drive the dossier's fields",
  /function wireOverride\(r, d, onDone, root\)/.test(page) && /scope\.querySelector/.test(page));
check("the dossier wires its own copy against its own container", /wireOverride\(row, d, null, dbody\)/.test(page));
check("one override implementation, reached two ways", (page.match(/function overrideHtml/g) ?? []).length === 1);
check("the chip does not pretend the tier moved", /still shows the engine's tier until then/.test(page));

/* 10 · signing in where the form is (DECISIONS §54)
 *
 * The override dialog shipped saying "sign in at the top of the page", which is not an answer to
 * someone standing in front of the form — and worse, this page and the back office kept SEPARATE
 * session stores on the same origin, so signing in on one did nothing for the other. Both pinned.
 */
check("the panel signs you in where you are, not somewhere else",
  /id="ovSend"/.test(page) && /id="ovMail"/.test(page));
check("it no longer sends the reader to the nav", !/Sign in at the top of the page/.test(page));
check("one function sends the link, used by the nav and the panel",
  (page.match(/function sendLink/g) ?? []).length === 1 && /sendLink\(addr\)/.test(page));
check("the back office session is read, so one sign-in covers both pages",
  /sb-sgagrmapuovnjwvgsxbp-auth-token/.test(page));
check("a borrowed session is never refreshed (rotating it signs the other page out)",
  /sess\.adopted/.test(page) && /let it lapse rather than rotate it/.test(page));
check("a borrowed session is never copied into this page's own store",
  /!x\.adopted/.test(page));
check("pb_members is read only with a session, through the auth helper",
  /authReq\("pb_members\?/.test(page) && !/get\("pb_members/.test(page));
check("signing in is stated as optional for reading", /Reading this book needs no account/.test(page));
check("no session token is baked into the page", !/access_token"\s*:\s*"[A-Za-z0-9._-]{20,}/.test(page));
check("every session-storage touch is guarded, like the theme",
  (page.match(/try \{ return localStorage|try \{ localStorage|try \{ return JSON\.parse/g) ?? []).length >= 3);

console.log(`board_page: ${passed} checks, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
