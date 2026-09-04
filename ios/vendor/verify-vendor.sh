#!/usr/bin/env bash
#
# Verify the vendored swift-crypto tree against pristine upstream.
#
# TruePad vendors apple/swift-crypto because ordinary package resolution cannot
# produce the build TruePad needs on Apple platforms (see README.md). Vendoring
# ~16 MB of third-party cryptography is only acceptable if a reviewer can see, in
# seconds and without diffing by hand, exactly what TruePad changed.
#
# This script fetches pristine upstream at the pinned commit, removes the paths
# TruePad intentionally does not vendor (PRUNED-PATHS.txt), diffs the result
# against the vendored tree, and requires the diff to equal EXPECTED-PATCH.diff
# byte for byte. Any unreviewed drift -- in either direction -- fails.
#
#   ./verify-vendor.sh          verify (CI mode; exits non-zero on drift)
#   ./verify-vendor.sh --write  regenerate EXPECTED-PATCH.diff after a reviewed change
#
# Offline / mirrored use: set TRUEPAD_SWIFT_CRYPTO_MIRROR to any git URL or path
# that carries the pinned commit.
set -euo pipefail

UPSTREAM_URL="${TRUEPAD_SWIFT_CRYPTO_MIRROR:-https://github.com/apple/swift-crypto.git}"
UPSTREAM_TAG="4.5.2"
UPSTREAM_COMMIT="da9d28d69ebe3894b18376c8f2395c2f37b8448f"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDORED="$HERE/swift-crypto"
EXPECTED="$HERE/EXPECTED-PATCH.diff"
PRUNE_LIST="$HERE/PRUNED-PATHS.txt"

MODE="verify"
[ "${1:-}" = "--write" ] && MODE="write"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "upstream : $UPSTREAM_URL"
echo "tag      : $UPSTREAM_TAG"
echo "commit   : $UPSTREAM_COMMIT"
echo

echo "== Fetching pristine upstream =="
git clone --quiet --depth 1 --branch "$UPSTREAM_TAG" "$UPSTREAM_URL" "$WORK/pristine" 2>/dev/null
ACTUAL_COMMIT="$(git -C "$WORK/pristine" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$UPSTREAM_COMMIT" ]; then
    echo "FAIL: tag $UPSTREAM_TAG resolves to $ACTUAL_COMMIT, expected $UPSTREAM_COMMIT"
    echo "      (a moved tag is a supply-chain event, not a merge conflict)"
    exit 1
fi
echo "  commit matches the pin"

echo
echo "== Removing paths TruePad intentionally does not vendor =="
COUNT=0
while IFS= read -r path; do
    case "$path" in ''|\#*) continue ;; esac
    rm -rf "${WORK:?}/pristine/${path:?}"
    COUNT=$((COUNT + 1))
done < "$PRUNE_LIST"
echo "  pruned $COUNT paths (see PRUNED-PATHS.txt)"

# Anything left in pristine but missing from the vendored tree, or vice versa,
# now shows up in the diff as an add/remove rather than being silently ignored.
echo
echo "== Diffing vendored tree against pristine upstream =="
cp -R "$VENDORED" "$WORK/vendored"
# Strip the per-run mtime that diff appends to ---/+++ headers, so the recorded
# patch is a function of CONTENT only and does not churn on every checkout.
# (awk, not sed: BSD sed does not interpret \t.)
( cd "$WORK" && diff -ruN pristine vendored 2>/dev/null \
    | awk 'BEGIN { FS = "\t" } /^(---|\+\+\+) / { print $1; next } { print }' \
    > actual.diff || true )
LINES=$(wc -l < "$WORK/actual.diff" | tr -d ' ')
echo "  diff is $LINES lines"

if [ "$MODE" = "write" ]; then
    cp "$WORK/actual.diff" "$EXPECTED"
    echo
    echo "WROTE $EXPECTED -- review it, then commit it."
    exit 0
fi

if [ ! -f "$EXPECTED" ]; then
    echo "FAIL: $EXPECTED is missing; run --write and review the result."
    exit 1
fi

if diff -u "$EXPECTED" "$WORK/actual.diff" > "$WORK/drift.diff"; then
    echo
    echo "RESULT: PASS -- the vendored tree is pristine upstream $UPSTREAM_TAG plus"
    echo "        exactly the reviewed patch in EXPECTED-PATCH.diff."
    exit 0
else
    echo
    echo "RESULT: FAIL -- unreviewed vendor drift."
    echo "        Difference between the expected patch and reality:"
    sed 's/^/        /' "$WORK/drift.diff" | head -100
    exit 1
fi
