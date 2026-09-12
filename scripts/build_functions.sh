#!/usr/bin/env bash
# Bundle each Supabase Edge Function into one ES module for deployment through the Supabase MCP.
#
# Why a bundle: the MCP's deploy_edge_function takes every file inline in a single tool call, and
# the four functions' transitive TypeScript closure runs 75–165 KB each — too large for one call.
# esbuild folds a function and its _shared imports into one file at roughly a third of the size,
# strips comments and whitespace, keeps identifiers (readable stack traces) and leaves the
# `jsr:` / `npm:` / `https:` / `node:` specifiers external for the edge runtime to resolve.
#
# The bundle is a deterministic build of the committed sources: same commit + same esbuild
# version → same bytes. Record the commit and the bundle sha256 when you deploy (the RUNBOOK
# asks for both). The Supabase CLI, where available, can deploy the TypeScript directly instead:
#   supabase functions deploy <fn> --project-ref sgagrmapuovnjwvgsxbp --no-verify-jwt
#
# Deploying through the MCP carries the file as a JSON string, so every backslash in the bundle
# has to be escaped in that payload: a backslash sent singly arrives decoded to whatever it named.
#
# `--charset=utf8` exists to shrink that hazard rather than to be tidy. Without it esbuild escapes
# every non-ASCII character as `\uXXXX` — eleven of them in pb-notes alone, all em dashes and
# curly quotes inside ordinary strings. Those are the DANGEROUS ones, because JSON decodes `—`
# to an em dash silently: the function behaves identically, so nothing fails, and the only casualty
# is the sha256 recorded at deploy time, which then no longer identifies what is running. With
# `--charset=utf8` those characters are emitted as themselves and the remaining backslashes are
# all regex syntax (`\s`, `\S`, `\b`, `\.`, `\/`, `\0`, `\n`, `\t`, `\r`), where a wrong decode
# breaks the pattern loudly instead. pb-notes goes from 49 backslashes to 38 this way.
#
# Escape the payload, and confirm the deploy with a GET to the function.
# The two webhooks answer `{"ok":true,"service":"<slug>"}`; pb-sync, pb-score and pb-notes have no
# GET branch and answer 405 `{"error":"POST only"}`. Either proves it parsed and booted — a bundle
# that did not answers a boot error instead of reaching the method check.
#
# Usage: bash scripts/build_functions.sh [out_dir]   (default: ./dist/functions, git-ignored)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-dist/functions}"
ESBUILD_VERSION="0.24.2"
FUNCTIONS=(pb-sync pb-score pb-notes pb-fathom-webhook pb-pipedrive-webhook)

mkdir -p "$OUT"
for fn in "${FUNCTIONS[@]}"; do
  mkdir -p "$OUT/$fn"
  npx --yes "esbuild@${ESBUILD_VERSION}" "supabase/functions/$fn/index.ts" \
    --bundle --format=esm --platform=neutral --target=esnext \
    --external:'jsr:*' --external:'npm:*' --external:'https://*' --external:'node:*' \
    --minify-whitespace --minify-syntax --legal-comments=none --charset=utf8 \
    --outfile="$OUT/$fn/index.js" >/dev/null
  printf "%-24s %8d bytes  sha256 %s\n" "$fn" "$(wc -c < "$OUT/$fn/index.js")" "$(sha256sum "$OUT/$fn/index.js" | cut -c1-16)…"
done
echo "commit $(git rev-parse --short HEAD) · esbuild ${ESBUILD_VERSION} · deploy each $OUT/<fn>/index.js with entrypoint_path index.js, verify_jwt false"
