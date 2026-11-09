#!/usr/bin/env bash
# Tags and publishes a release that the `Release` workflow built on `release/vX.Y.Z`.
# The `Publish release` workflow runs it with a token from the release App. Run by hand, it
# needs an org admin, because the tag ruleset blocks everyone else from writing `v*` tags.
# Safe to rerun: it skips every step that is already done.
#
# Usage: scripts/publish-release.sh [--dry-run] [--verified=SHA] vX.Y.Z
#   --dry-run       print the commands that write tags or the release instead of running them,
#                   and end with the line `verified build commit SHA` after the rebuild
#   --verified=SHA  skip the rebuild of dist/ and refuse unless the build commit is SHA.
#                   Pass only a SHA that a dry run reported as verified.
# Environment: REMOTE (default origin), REPO (default manki-review/manki),
#   WAIT_SECONDS (default 900) to wait for the build commit.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 [--dry-run] [--verified=SHA] vX.Y.Z" >&2
  exit 2
}

DRY_RUN=false
VERIFIED=""
TAG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verified=*)
      VERIFIED="${arg#--verified=}"
      [[ "$VERIFIED" =~ ^[0-9a-f]{40}$ ]] || usage
      ;;
    -*) usage ;;
    *)
      [ -z "$TAG" ] || usage
      TAG="$arg"
      ;;
  esac
done
[[ "$TAG" =~ ^v([0-9]+)\.[0-9]+\.[0-9]+$ ]] || usage
VERSION="${TAG#v}"
MAJOR="v${BASH_REMATCH[1]}"
BRANCH="release/$TAG"
REMOTE="${REMOTE:-origin}"
REPO="${REPO:-manki-review/manki}"
WAIT_SECONDS="${WAIT_SECONDS:-900}"

cd "$(git rev-parse --show-toplevel)"

run() {
  if $DRY_RUN; then
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Prints the commit a remote tag points at, or nothing when the tag doesn't exist.
remote_tag_commit() {
  git ls-remote --tags "$REMOTE" "refs/tags/$1" "refs/tags/$1^{}" |
    awk -v ref="refs/tags/$1" '$2 == ref { direct = $1 } $2 == ref "^{}" { peeled = $1 } END { print (peeled != "" ? peeled : direct) }'
}

# Prints the highest remote vX.Y.Z tag matching the glob, counting $TAG as already pushed.
newest_tag() {
  local tags
  tags=$(git ls-remote --tags --refs "$REMOTE" "refs/tags/$1" | sed 's#.*refs/tags/##') ||
    die "git ls-remote $REMOTE failed"
  printf '%s\n%s\n' "$tags" "$TAG" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
}

# Prints absent, draft or published.
release_state() {
  local out
  if out=$(gh release view "$TAG" -R "$REPO" --json isDraft --jq .isDraft 2>&1); then
    if [ "$out" = true ]; then echo draft; else echo published; fi
  elif [[ "$out" == *"release not found"* ]]; then
    echo absent
  else
    die "gh release view $TAG failed: $out"
  fi
}

fetch() {
  git fetch --quiet "$REMOTE" "+refs/heads/main:refs/remotes/$REMOTE/main" \
    "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"
}

has_dist() {
  [ -n "$(git ls-tree --name-only "$1" dist/)" ]
}

if [ -z "$(git ls-remote --heads "$REMOTE" "refs/heads/$BRANCH")" ]; then
  die "$BRANCH doesn't exist on $REMOTE. Push the release commit to it first, see RELEASE.md."
fi

deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  fetch
  BUILD=$(git rev-parse "refs/remotes/$REMOTE/$BRANCH")
  has_dist "$BUILD" && break
  [ "$SECONDS" -lt "$deadline" ] || die "no build commit on $BRANCH after ${WAIT_SECONDS}s. Check the Release workflow run."
  echo "waiting for the Release workflow to push the build commit to $BRANCH"
  sleep 15
done
if [ -n "$VERIFIED" ] && [ "$BUILD" != "$VERIFIED" ]; then
  die "$BRANCH points at $BUILD, not the verified build commit $VERIFIED"
fi

read -r -a parents <<<"$(git rev-list --parents -n 1 "$BUILD")"
[ "${#parents[@]}" -eq 2 ] || die "build commit $BUILD must have exactly one parent"
RELEASE_COMMIT="${parents[1]}"
git merge-base --is-ancestor "$RELEASE_COMMIT" "refs/remotes/$REMOTE/main" ||
  die "release commit $RELEASE_COMMIT is not on $REMOTE/main"
prev_version=$(git show "$RELEASE_COMMIT^:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
[ "$prev_version" != "$VERSION" ] ||
  die "release commit $RELEASE_COMMIT doesn't bump the version to $VERSION. Point $BRANCH at the commit that does."
if has_dist "$RELEASE_COMMIT"; then
  die "release commit $RELEASE_COMMIT already contains dist/"
fi

# A fresh build of the release commit must reproduce the build commit's tree exactly,
# so nothing but the built dist/ can reach the tag.
WORK=$(mktemp -d)
NOTES="$WORK.notes.md"
cleanup() {
  git worktree remove --force "$WORK" >/dev/null 2>&1 || { rm -rf "$WORK"; git worktree prune; }
  rm -f "$NOTES"
}
trap cleanup EXIT
git worktree add --quiet --detach "$WORK" "$RELEASE_COMMIT"
(
  cd "$WORK"
  pkg_version=$(node -p "require('./package.json').version")
  [ "$pkg_version" = "$VERSION" ] || die "package.json version $pkg_version at $RELEASE_COMMIT doesn't match $TAG"
  node scripts/check-changelog-version.js
  [ -z "$VERIFIED" ] || exit 0
  echo "rebuilding dist/ at $RELEASE_COMMIT to verify the build commit"
  npm ci --silent >/dev/null
  npm run --silent build >/dev/null
  git add -f dist/
  if ! git diff --cached --quiet "$BUILD"; then
    git diff --cached --stat "$BUILD" >&2
    die "build commit $BUILD is not $RELEASE_COMMIT plus a fresh dist/"
  fi
)

awk -v heading="## [$VERSION]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$WORK/CHANGELOG.md" >"$NOTES"
grep -q '[^[:space:]]' "$NOTES" || die "CHANGELOG.md at $RELEASE_COMMIT has no section for $VERSION"

tag_commit=$(remote_tag_commit "$TAG")
state=$(release_state)
if [ -z "$tag_commit" ]; then
  run git tag -fa "$TAG" "$BUILD" -m "$TAG"
  run git push "$REMOTE" "refs/tags/$TAG"
elif [ "$tag_commit" != "$BUILD" ]; then
  if [ "$state" = published ]; then
    die "$TAG is published at $tag_commit and can't move to $BUILD. Cut a new patch release."
  fi
  die "$TAG points at $tag_commit, not the build commit $BUILD. Delete the tag on $REMOTE and rerun."
else
  echo "$TAG already points at $BUILD"
fi

newest=$(newest_tag 'v*')
newest_in_major=$(newest_tag "$MAJOR.*")
major_commit=$(remote_tag_commit "$MAJOR")
latest=false
[ "$newest" = "$TAG" ] && latest=true
if $DRY_RUN && [ "$state" != published ]; then
  echo "release notes:"
  cat "$NOTES"
fi
# A token without push access sees a draft as absent, so both paths publish the same notes.
case "$state" in
  absent) run gh release create "$TAG" -R "$REPO" --verify-tag --title "$TAG" --notes-file "$NOTES" --latest="$latest" ;;
  draft) run gh release edit "$TAG" -R "$REPO" --draft=false --title "$TAG" --notes-file "$NOTES" --latest="$latest" ;;
  published) echo "release $TAG is already published" ;;
esac

if [ "$newest_in_major" != "$TAG" ]; then
  echo "$MAJOR stays where it is, because a newer $MAJOR release exists"
elif [ "$major_commit" = "$BUILD" ]; then
  echo "$MAJOR already points at $BUILD"
else
  run git tag -fa "$MAJOR" "$BUILD" -m "Update $MAJOR tag to $TAG"
  run git push --force "$REMOTE" "refs/tags/$MAJOR"
fi

if $DRY_RUN && [ -z "$VERIFIED" ]; then
  echo "verified build commit $BUILD"
fi
