#!/usr/bin/env bash
# Runs every *_test.ts in the repository with Node's type stripping, then checks that the
# edge functions' _shared/ copies of core/ and ingest/ match their originals.
#
# Test files are discovered under core/, ingest/, explain/, scripts/ and supabase/functions/
# — excluding supabase/functions/_shared/core and _shared/ingest, which are byte-identical
# COPIES written by scripts/sync_shared.sh and are already covered by their originals.
#
# No test runner, no dependencies: each test file is a plain script that exits non-zero on
# failure. This wrapper exits non-zero if any of them does, or if the shared copies have
# drifted (`bash scripts/sync_shared.sh --check`), and prints a summary.
#
# Usage:  bash scripts/test_all.sh        (or: npm test)
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

if ! command -v node >/dev/null 2>&1; then
  echo "test_all: node is not installed (Node 22+ is required for --experimental-strip-types)" >&2
  exit 2
fi

mapfile -t files < <(
  {
    find core ingest explain scripts -type f -name '*_test.ts' 2>/dev/null
    find supabase/functions -type f -name '*_test.ts' \
      -not -path 'supabase/functions/_shared/core/*' \
      -not -path 'supabase/functions/_shared/ingest/*' 2>/dev/null
  } | sort -u
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "test_all: no *_test.ts files found under core/, ingest/, explain/, scripts/ or supabase/functions/" >&2
  exit 1
fi

passed=0
failed=0
failed_files=()

for f in "${files[@]}"; do
  echo "── $f"
  if node --experimental-strip-types --no-warnings=ExperimentalWarning "$f"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failed_files+=("$f")
  fi
  echo
done

# Final step: the deployed copies must match their originals, or a redeploy ships stale code.
echo "── bash scripts/sync_shared.sh --check"
sync_status="in sync"
if ! bash scripts/sync_shared.sh --check; then
  sync_status="DRIFT"
fi
echo

echo "══════════════════════════════════════════════"
echo "test_all: ${#files[@]} test file(s) — $passed passed, $failed failed; shared copies: $sync_status"
if [ "$failed" -gt 0 ]; then
  for f in "${failed_files[@]}"; do echo "  FAILED  $f"; done
fi
if [ "$sync_status" != "in sync" ]; then
  echo "  FAILED  supabase/functions/_shared copies differ from core/ or ingest/ — run: bash scripts/sync_shared.sh"
fi
if [ "$failed" -gt 0 ] || [ "$sync_status" != "in sync" ]; then
  exit 1
fi
exit 0
