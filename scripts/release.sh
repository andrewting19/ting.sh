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

# Create release tarball
TARBALL="ting.sh-v${NEW_VERSION}.tar.gz"
COPYFILE_DISABLE=1 tar czf "$TARBALL" \
  server.ts \
  serverBuffer.ts \
  VERSION \
  hosts.example.json \
  dist/

echo "Built $TARBALL"

# Commit version bump
git add VERSION
git commit -m "release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main --tags

# Create GitHub release
gh release create "v${NEW_VERSION}" "$TARBALL" \
  --title "v${NEW_VERSION}" \
  --generate-notes

rm "$TARBALL"
echo "Released v${NEW_VERSION}"
