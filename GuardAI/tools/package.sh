#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the Chrome Web Store zip.
#
# This exists because the obvious thing — zipping the folder — produces a 26 MB
# package of which 25 MB is node_modules (jsdom and its dependency tree),
# alongside the entire test suite and this script. The extension itself is
# about half a megabyte. Shipping the rest is slow, leaks the test corpus, and
# invites questions in review about code that has no business being there.
#
# So the list below is an ALLOWLIST, not an ignore-list. Anything not named
# here does not ship. test/packaging.cjs checks that every file the manifest
# references is on it, so adding a content script and forgetting this file
# fails the suite rather than shipping a broken extension.
#
# Usage:  bash tools/package.sh
# Output: dist/guardai-<version>.zip
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version" 2>/dev/null || echo "dev")
OUT="dist/guardai-${VERSION}.zip"

# Everything that ships, and nothing else. settings.html is here despite not
# appearing in manifest.json — it is opened with chrome.tabs.create(), so
# nothing declares it and it is exactly the sort of file an allowlist loses.
FILES=(
  manifest.json
  background.js
  popup.html
  popup.js
  settings.html
  settings.js
  privacy-policy.html
  styles.css
  src
  icons
)

for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$OUT"
zip -r -q -X "$OUT" "${FILES[@]}" -x '*.DS_Store' -x '*/.*'

echo "$OUT  ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
