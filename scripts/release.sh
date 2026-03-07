#!/usr/bin/env bash
set -euo pipefail

# Build a release tarball and publish it as a GitHub release.
# Usage: ./scripts/release.sh [patch|minor|major]
#   Defaults to "patch" if no argument given.

cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
VERSION=$(cat VERSION)
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  *) echo "Usage: $0 [patch|minor|major]"; exit 1 ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "$NEW_VERSION" > VERSION

# Build frontend
bun run build

# Create release archives
if ! command -v zip >/dev/null 2>&1; then
  echo "ERROR: zip command is required to create Windows release artifacts"
  exit 1
fi

RELEASE_FILES=(
  server.ts
  serverBuffer.ts
  src/pty.ts
  src/pty-unix.ts
  src/pty-windows.ts
  src/pty-worker.js
  package.json
  bun.lock
  VERSION
  hosts.example.json
  deploy/
  dist/
)

TARBALL="ting.sh-v${NEW_VERSION}.tar.gz"
ZIPFILE="ting.sh-v${NEW_VERSION}.zip"

COPYFILE_DISABLE=1 tar czf "$TARBALL" "${RELEASE_FILES[@]}"
zip -rq -X "$ZIPFILE" "${RELEASE_FILES[@]}"

echo "Built $TARBALL"
echo "Built $ZIPFILE"

# Commit version bump
git add VERSION
git commit -m "release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main --tags

# Create GitHub release
gh release create "v${NEW_VERSION}" "$TARBALL" "$ZIPFILE" \
  --title "v${NEW_VERSION}" \
  --generate-notes

rm "$TARBALL" "$ZIPFILE"
echo "Released v${NEW_VERSION}"
