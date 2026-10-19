#!/usr/bin/env sh
# Fails if any private term appears in the repo.
# Terms come from $PRIVATE_TERMS (CI secret, newline-separated) or from the file
# given as $1 (local runs). The list itself never lives in this repo.
set -eu
terms_file="$(mktemp)"
trap 'rm -f "$terms_file"' EXIT
if [ "${1:-}" != "" ]; then
  grep -v '^[[:space:]]*$' "$1" > "$terms_file" || true
else
  printf '%s\n' "${PRIVATE_TERMS:-}" | grep -v '^[[:space:]]*$' > "$terms_file" || true
fi
if [ ! -s "$terms_file" ]; then
  echo "no private terms configured"; exit 1
fi
if grep -rniF -f "$terms_file" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage . ; then
  echo "private term found"; exit 1
fi
echo "no private terms found"
