/**
 * WLIQ Prospect Book — the ordinary words that are never, on their own, a reference to an account.
 *
 * Two readers need the same answer to "is this word distinctive enough to name an agency?":
 *
 *   · scripts/no_prospect_names.ts, rule 2 made mechanical. It matches each roster entry's first
 *     word against the repository, and a first word in these lists is never reported alone.
 *   · ingest/meeting_mentions.ts, the sales-meeting matcher. A spoken word in these lists is never
 *     a distinctive token, so it can never suggest an account by itself (DECISIONS §65).
 *
 * The lists were moved here VERBATIM from scripts/no_prospect_names.ts so that the two readers can
 * never drift apart: a word allowed in one place and distinctive in the other would mean the names
 * check and the matcher disagree about what names an agency. The script imports them back; its
 * behaviour is unchanged and still pinned by scripts/no_prospect_names_test.ts.
 *
 * PURE. Data only: no clock, no network, no filesystem. Runs under Deno and
 * `node --experimental-strip-types`.
 */

/** Account names that are ordinary English and would match everywhere. */
export const GENERIC: ReadonlySet<string> = new Set([
  "agency", "agencies", "test", "none", "individual", "confidential", "outsourced", "unincorporated",
  "momentum", "snap", "snapshot", "wonder", "haystack", "watermark", "avenue", "mega", "metropolis",
  "nomadic", "shift", "the deal", "the fold", "the escape", "illuminated", "intrigue", "techies",
  "moor", "unity", "not yet", "tbd", "good company", "second mile", "the machine", "franco",
]);

/**
 * Ordinary English. A first word in here is never reported on its own, because matching it would
 * flag this repository's own prose rather than a reference to an account.
 *
 * **The rule for adding a word: it is ordinary English, used here in its ordinary sense. Never
 * because a particular finding was inconvenient.** The first run of the first-word rule against
 * the live roster made the distinction concrete: 453 hits over 24 words, of which 23 were this
 * repository writing English (a tier name, a TypeScript global, a journey stage, the start of a
 * sentence) and one was a real breach — an account named by its first word alone, three times, in
 * a passage about that account. Allowlisting all 24 would have made the check green and useless.
 *
 * Every word here is a blind spot: an account whose name starts with it is caught only by its
 * whole name. That is the trade this check makes to stay worth running. Given names and words
 * that read as a brand stay out, because those are exactly the cases a reader must look at.
 */
export const FIRST_TOKEN_ALLOW: ReadonlySet<string> = new Set([
  // What agency names are made of.
  "digital", "agency", "marketing", "creative", "design", "content", "social", "studio", "brand",
  "media", "branding", "consulting", "advertising", "partners", "partner", "communications",
  "interactive", "collective", "solutions", "solution", "strategy", "ventures", "graphics",
  // The book's own vocabulary: tiers, bands, reads, the things it writes about all day.
  "silver", "bronze", "platinum", "signal", "signals", "evidence", "potential", "anticipated",
  "override", "rubric", "prospect", "account", "accounts", "engine", "register", "roster",
  "ranking", "grading", "promotion", "delivery", "revenue", "website", "webhook", "request",
  "response", "fixture", "artifact", "migration", "identity", "candidate", "confidence",
  "crypto",
  // Ordinary English and ordinary technical English, six letters or more.
  "address", "advanced", "against", "already", "analysis", "another", "answer", "anything",
  "appear", "applied", "approach", "archive", "around", "article", "assign", "attempt", "author",
  "average", "backup", "balance", "before", "behind", "believe", "benefit", "better", "between",
  "beyond", "billing", "branch", "broken", "browser", "budget", "builder", "building", "business",
  "button", "cannot", "capital", "capture", "center", "central", "certain", "change", "changes",
  "channel", "charge", "choice", "choose", "circle", "client", "clients", "closed", "collect",
  "column", "combine", "coming", "command", "comment", "commerce", "common", "company", "compare",
  "complete", "concept", "concern", "confirm", "connect", "consider", "console", "contact",
  "contain", "context", "continue", "contract", "control", "convert", "correct", "counter",
  "course", "create", "created", "credit", "current", "custom", "customer", "dashboard",
  "database", "decide", "decision", "declare", "default", "define", "degree", "delete", "deliver",
  "demand", "depend", "deploy", "describe", "desktop", "detail", "details", "detect", "develop",
  "device", "direct", "direction", "director", "display", "distance", "district", "domain",
  "double", "during", "dynamic", "easier", "editor", "effect", "effort", "either", "element",
  "enable", "energy", "engage", "enough", "ensure", "entire", "entity", "escape", "events",
  "everything", "exactly", "example", "except", "exchange", "execute", "exists", "expand",
  "expect", "expert", "explain", "export", "express", "extend", "external", "extract", "factor",
  "failed", "failure", "family", "feature", "figure", "filter", "finally", "finance", "finding",
  "finish", "folder", "follow", "forecast", "format", "former", "formula", "forward", "freedom",
  "friend", "friends", "frozen", "function", "further", "future", "gather", "general", "generate",
  "global", "ground", "growth", "handle", "happen", "header", "health", "helper", "hidden",
  "higher", "history", "holding", "however", "ignore", "images", "impact", "import", "improve",
  "include", "income", "increase", "indeed", "industry", "initial", "inline", "inside", "insight",
  "install", "instead", "integer", "intent", "interest", "internal", "invalid", "invoice",
  "island", "itself", "keyword", "landing", "language", "larger", "largest", "latest", "launch",
  "leader", "leading", "leaving", "legacy", "length", "lesson", "letter", "library", "license",
  "likely", "limited", "linear", "listen", "little", "living", "loading", "locale", "locate",
  "location", "logging", "logical", "longer", "looking", "machine", "manage", "manager", "manual",
  "mapping", "margin", "market", "master", "matter", "matters", "maximum", "meaning", "measure",
  "medium", "member", "memory", "mention", "message", "method", "middle", "migrate", "minimum",
  "minute", "mirror", "mission", "mobile", "modern", "module", "moment", "monitor", "mostly",
  "moving", "multiple", "narrow", "native", "natural", "nearly", "needed", "network", "neutral",
  "normal", "nothing", "notice", "number", "object", "obtain", "obvious", "office", "offset",
  "online", "opened", "opening", "operate", "option", "orange", "organic", "origin", "outdoor",
  "outline", "output", "overall", "package", "parent", "partial", "passed", "pattern", "payment",
  "pending", "people", "percent", "perfect", "period", "person", "phrase", "picture", "planning",
  "platform", "please", "plugin", "policy", "portal", "portion", "position", "possible", "posted",
  "practice", "precise", "predict", "prefer", "prefix", "premium", "prepare", "present", "pretty",
  "prevent", "preview", "primary", "private", "problem", "process", "produce", "product",
  "profile", "profit", "program", "project", "promise", "prompt", "proper", "propose", "protect",
  "provide", "public", "publish", "purpose", "quality", "quarter", "question", "quickly", "random",
  "rather", "reader", "reading", "reason", "receive", "recent", "record", "reduce", "reform",
  "refresh", "refuse", "regard", "region", "regular", "reject", "relate", "release", "remain",
  "remote", "remove", "render", "repair", "repeat", "replace", "report", "require", "research",
  "reserve", "resolve", "resource", "respond", "restore", "result", "retain", "return", "reverse",
  "review", "revise", "routine", "running", "safety", "sample", "schedule", "schema", "school",
  "science", "screen", "script", "search", "season", "second", "secret", "section", "sector",
  "secure", "select", "seller", "sender", "senior", "series", "serious", "server", "service",
  "session", "setting", "several", "shadow", "shared", "sharing", "should", "similar", "simple",
  "simply", "single", "slight", "society", "software", "source", "special", "specific", "spread",
  "square", "stable", "staging", "standard", "starting", "static", "station", "status", "storage",
  "stored", "stream", "street", "strict", "string", "strong", "student", "submit", "subject",
  "success", "suggest", "summary", "supply", "support", "suppose", "surface", "survey", "switch",
  "symbol", "system", "target", "template", "terminal", "testing", "theory", "though", "thread",
  "through", "ticket", "timing", "toggle", "toward", "tracking", "traffic", "transfer", "travel",
  "trigger", "trouble", "trusted", "typical", "unable", "unique", "united", "unless", "update",
  "upgrade", "upload", "useful", "utility", "values", "vendor", "verify", "version", "vertical",
  "viewer", "virtual", "visible", "vision", "visual", "volume", "waiting", "wanted", "warning",
  "watching", "weather", "weekly", "weight", "welcome", "whatever", "whether", "window", "winning",
  "within", "without", "wonder", "worker", "working", "writer", "writing", "written", "yellow",
]);

/** A first token shorter than this is too weak to stand on its own as evidence of a name. */
export const MIN_TOKEN = 6;
