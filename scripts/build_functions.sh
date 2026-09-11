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
# has to be escaped in that payload: a bundle's `\uXXXX` (in a regex literal, say) sent as a
# single backslash arrives decoded to the character it names. Semantically identical, but the
# deployed bytes then differ from the bundle's and the sha256 recorded at deploy time no longer
# matches what is running. Escape the payload, and confirm the deploy with a GET to the function
# (each answers `{"ok":true,"service":"<slug>"}`), which proves it parsed and booted.
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
    --minify-whitespace --minify-syntax --legal-comments=none \
    --outfile="$OUT/$fn/index.js" >/dev/null
  printf "%-24s %8d bytes  sha256 %s\n" "$fn" "$(wc -c < "$OUT/$fn/index.js")" "$(sha256sum "$OUT/$fn/index.js" | cut -c1-16)…"
done
echo "commit $(git rev-parse --short HEAD) · esbuild ${ESBUILD_VERSION} · deploy each $OUT/<fn>/index.js with entrypoint_path index.js, verify_jwt false"
