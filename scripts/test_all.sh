#!/usr/bin/env bash
# Runs every *_test.ts under core/, ingest/ and explain/ with Node's type stripping.
# No test runner, no dependencies: each test file is a plain script that exits non-zero
# on failure. This wrapper exits non-zero if any of them does, and prints a summary.
#
# Usage:  bash scripts/test_all.sh        (or: npm test)
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

if ! command -v node >/dev/null 2>&1; then
  echo "test_all: node is not installed (Node 22+ is required for --experimental-strip-types)" >&2
  exit 2
fi

mapfile -t files < <(find core ingest explain -type f -name '*_test.ts' 2>/dev/null | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "test_all: no *_test.ts files found under core/, ingest/ or explain/" >&2
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

echo "══════════════════════════════════════════════"
echo "test_all: ${#files[@]} test file(s) — $passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
  for f in "${failed_files[@]}"; do echo "  FAILED  $f"; done
  exit 1
fi
exit 0
