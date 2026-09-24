#!/bin/sh
# Builds reply-guy-repellent.zip for the GitHub release, without the localhost fixture match.
#   sh scripts/build-zip.sh
set -e
cd "$(dirname "$0")/.."

if grep -q "^const PROXY_URL = .*REPLACE-ME" extension/background.js; then
  echo "warning: PROXY_URL is still the placeholder; the zip will run keywords only." >&2
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/rgr.XXXXXX")/reply-guy-repellent"
mkdir -p "$STAGE"
cp -R extension/. "$STAGE"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const cs of m.content_scripts) cs.matches = cs.matches.filter((u) => !u.startsWith("http://localhost"));
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
' "$STAGE/manifest.json"

rm -f reply-guy-repellent.zip
(cd "$(dirname "$STAGE")" && zip -qr -X "$OLDPWD/reply-guy-repellent.zip" reply-guy-repellent -x "*.DS_Store")
echo "built reply-guy-repellent.zip"
