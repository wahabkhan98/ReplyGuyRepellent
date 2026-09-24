#!/bin/sh
# Point this checkout at your own deployed proxy, without ever committing the URL.
#
#   sh scripts/use-local-proxy.sh https://your-project.vercel.app
#   sh scripts/use-local-proxy.sh --unset      # back to the placeholder, tracked again
#
# It edits background.js and manifest.json, then marks both with skip-worktree, so git
# stops showing them as modified and `git add -A` can't sweep your URL into a commit.
set -e
cd "$(dirname "$0")/.."

FILES="extension/background.js extension/manifest.json"
PLACEHOLDER="REPLACE-ME.vercel.app"

unmark() { for f in $FILES; do git update-index --no-skip-worktree "$f" 2>/dev/null || true; done; }
mark() {
  for f in $FILES; do
    git update-index --skip-worktree "$f" 2>/dev/null ||
      echo "warning: could not mark $f skip-worktree; don't commit it by accident." >&2
  done
}

if [ "$1" = "--unset" ]; then
  unmark
  git checkout -- $FILES 2>/dev/null || true
  echo "Restored the placeholder. Both files are tracked normally again."
  exit 0
fi

HOST=$(printf '%s' "$1" | sed -E 's#^https?://##; s#/.*$##')
if [ -z "$HOST" ]; then
  echo "usage: sh scripts/use-local-proxy.sh https://your-project.vercel.app" >&2
  exit 1
fi

# Start from whatever host is currently in the files, so re-running with a new URL works.
CURRENT=$(sed -n "s#.*const PROXY_URL = 'https://\([^/]*\)/api/score';#\1#p" extension/background.js)
[ -n "$CURRENT" ] || CURRENT="$PLACEHOLDER"

unmark
for f in $FILES; do
  sed "s#$CURRENT#$HOST#g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
mark

echo "Using https://$HOST/api/score"
echo "git now ignores your changes to: $FILES"
echo "Reload the extension at chrome://extensions."
