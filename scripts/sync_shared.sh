#!/usr/bin/env bash
# Copies the pure modules the edge functions import into supabase/functions/_shared/.
#
# Supabase deploys a function directory plus whatever files the deploy call names, so the
# functions cannot reach ../../core or ../../ingest at runtime. They import byte-identical
# COPIES from _shared/core and _shared/ingest instead. This script is the only thing that
# writes those copies; edit the originals, re-run it, redeploy.
#
#   core/*.ts        (not *_test.ts)         → supabase/functions/_shared/core/
#   core/rubric.prospect.v0.1.json           → supabase/functions/_shared/core/
#   ingest/*.ts      (not *_test.ts)         → supabase/functions/_shared/ingest/
#
# Usage:  bash scripts/sync_shared.sh            copy (and remove stale copies)
#         bash scripts/sync_shared.sh --check    exit 1 if any copy differs from its original
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2
dest="supabase/functions/_shared"
check=0
[ "${1:-}" = "--check" ] && check=1

mkdir -p "$dest/core" "$dest/ingest"

sources=()
while IFS= read -r f; do sources+=("$f"); done < <(
  { find core ingest -maxdepth 1 -type f -name '*.ts' ! -name '*_test.ts'; echo core/rubric.prospect.v0.1.json; } | sort
)

drift=0
copied=0
for src in "${sources[@]}"; do
  target="$dest/$src"
  if [ "$check" -eq 1 ]; then
    if ! cmp -s "$src" "$target"; then
      echo "DRIFT  $target (differs from $src or missing)"
      drift=$((drift + 1))
    fi
  else
    cp -f "$src" "$target"
    copied=$((copied + 1))
  fi
done

# Remove copies whose original is gone (a renamed module must not linger in the deploy set).
for sub in core ingest; do
  for target in "$dest/$sub"/*; do
    [ -e "$target" ] || continue
    src="$sub/$(basename "$target")"
    if [ ! -f "$src" ]; then
      if [ "$check" -eq 1 ]; then echo "STALE  $target (no original at $src)"; drift=$((drift + 1));
      else rm -f "$target"; echo "removed stale $target"; fi
    fi
  done
done

if [ "$check" -eq 1 ]; then
  if [ "$drift" -gt 0 ]; then echo "sync_shared: $drift file(s) out of date — run scripts/sync_shared.sh"; exit 1; fi
  echo "sync_shared: ${#sources[@]} copies match their originals"
  exit 0
fi

# Verify byte-identity after copying.
for src in "${sources[@]}"; do
  cmp -s "$src" "$dest/$src" || { echo "sync_shared: copy of $src is not byte-identical" >&2; exit 1; }
done
echo "sync_shared: copied $copied file(s) into $dest/{core,ingest} (byte-identical)"
