#!/usr/bin/env bash
#
# Regenerate (or verify) android/vectors/ from the RELEASED TruePad v2.0.0.
#
# The golden fixtures under android/vectors/ are the only thing standing between
# "the Kotlin port passes its own tests" and "the Kotlin port agrees with what
# actually shipped". A fixture nobody can regenerate is a fixture nobody can
# check, so this script exists to make the claim falsifiable:
#
#     ./tools/regenerate-vectors.sh          rewrite android/vectors/ from v2.0.0
#     ./tools/regenerate-vectors.sh --check  fail if the committed vectors differ
#
# THE RELEASE IS NEVER TOUCHED. Tag v2.0.0 is checked out into a throwaway
# DETACHED worktree under a temporary directory; the generator is copied in
# beside the released src/; node runs it there; the worktree is removed. No
# branch is created or moved, no tag is written, and the release commit is only
# ever read.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
repo="$(cd "$android/.." && pwd)"
tag="v2.0.0"
release="240d7f0fa847c8e135cddd3826e7d2da699d1567"

check=0
[[ "${1:-}" == "--check" ]] && check=1

command -v node >/dev/null || { echo "node is required (>= 22.18.0, for TypeScript type stripping)" >&2; exit 1; }

# The generator imports the released .ts directly, which needs node's native
# type stripping. Fail with a clear message rather than a stack trace.
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "node $(node -v) is too old; the released src/ is TypeScript and needs node >= 22.18.0" >&2
  exit 1
fi

peeled="$(git -C "$repo" rev-parse "$tag^{}")"
if [[ "$peeled" != "$release" ]]; then
  echo "REFUSING: $tag resolves to $peeled, not the released $release" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/truepad-v200.XXXXXX")"
out="$android/vectors"
if (( check )); then
  out="$(mktemp -d "${TMPDIR:-/tmp}/truepad-vectors.XXXXXX")"
fi

cleanup() {
  git -C "$repo" worktree remove --force "$work" >/dev/null 2>&1 || rm -rf "$work"
  (( check )) && rm -rf "$out"
  return 0
}
trap cleanup EXIT

git -C "$repo" worktree add --detach "$work" "$tag" >/dev/null

# The released engine transitively imports @noble/post-quantum: verbs.ts pulls in
# the sealed-transfer module, which these vectors never exercise but which still
# has to RESOLVE. A fresh worktree has no node_modules (it is gitignored), so the
# dependency has to come from somewhere.
#
# The worktree IS the release, so its own package.json and package-lock.json are
# the right authority. Reusing the checkout's node_modules is only a shortcut,
# and only when it already holds the exact version the release pins — a linked
# tree that disagreed with the release would quietly make these "released"
# vectors something else. Note the current branch predates that dependency
# entirely, so the shortcut usually does not apply.
pinned="$(node -p "require('$work/package.json').dependencies['@noble/post-quantum']")"
have=""
if [[ -d "$repo/node_modules/@noble/post-quantum" ]]; then
  have="$(node -p "require('$repo/node_modules/@noble/post-quantum/package.json').version" 2>/dev/null || echo "")"
fi
if [[ -n "$have" && "$have" == "$pinned" ]]; then
  ln -s "$repo/node_modules" "$work/node_modules"
else
  echo "installing $tag's own pinned dependencies in the worktree (@noble/post-quantum $pinned)..." >&2
  ( cd "$work" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
fi

mkdir -p "$work/_gen"
cp "$here/generate-vectors.mjs" "$work/_gen/generate-vectors.mjs"
node "$work/_gen/generate-vectors.mjs" "$out" >/dev/null

if (( check )); then
  if diff -ru "$android/vectors" "$out" >/dev/null; then
    echo "vectors are byte-identical to what $tag produces"
  else
    echo "VECTORS ARE STALE — android/vectors/ does not match what $tag produces:" >&2
    diff -ru "$android/vectors" "$out" >&2 || true
    exit 1
  fi
else
  echo "regenerated android/vectors/ from $tag ($release)"
fi
