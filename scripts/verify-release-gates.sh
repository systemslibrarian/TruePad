#!/usr/bin/env bash
#
# Verify that every RELEASE-REQUIRED workflow passed for one exact commit.
#
# Usage:  scripts/verify-release-gates.sh <sha>
#         scripts/verify-release-gates.sh            (defaults to origin/master)
#
# Exit 0 only when every required check is PASS for that SHA. ABSENT, CANCELLED,
# PENDING, SKIPPED and FAIL all exit non-zero, because only PASS is green — see
# scripts/release-gates.ts for why absence in particular is not.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."

SHA="${1:-}"
if [ -z "$SHA" ]; then
    SHA="$(git -C "$ROOT" rev-parse origin/master)"
fi
# Full 40-hex, so a short SHA cannot silently address a different commit.
SHA="$(git -C "$ROOT" rev-parse "$SHA")"

command -v gh >/dev/null 2>&1 || { echo "gh is required to query workflow state" >&2; exit 2; }

# CAPTURED TO A FILE, then read — the same rule the symbol-table gate learned.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! gh run list --commit "$SHA" --limit 100 \
        --json workflowName,status,conclusion,createdAt > "$TMP/runs.json"; then
    echo "::error::could not query workflow runs for $SHA — this says nothing about the commit" >&2
    exit 2
fi

FAIL=0
node --experimental-strip-types "$HERE/release-gates-cli.ts" "$SHA" "$TMP/runs.json" || FAIL=1

# ---------------------------------------------------------------------------
# TWO REQUIRED GATES THAT NO WORKFLOW RUNS.
#
# docs/RELEASE-CHECKLIST-3.0.md Section A marks nine gates blocking. Seven are
# carried by a workflow; two are not, and nothing under .github/ executes them:
#
#   · the frozen crypto/wire diff -- checked here, because it is mechanical;
#   · the falsification matrix    -- a human procedure, reported as unautomated
#                                    rather than silently counted as passing.
#
# Until this existed, "every required check is green on GitHub" could not mean
# "the required set is green", because two of the required set were not on
# GitHub at all. That is the same absence-reads-as-green shape this command was
# written to close, one level up.
# ---------------------------------------------------------------------------
echo
echo "release anchors and unautomated gates"
echo

# The released tags, by exact identity. A release-verification command may reach
# the network; ordinary unit tests must not, and do not.
V2_TAG=e94b6a3ca8aa2111a1a320c7911044d808521326
V2_COMMIT=240d7f0fa847c8e135cddd3826e7d2da699d1567
V3_TAG=6377f9485da987ba450a81818b79b0848f5ca5f7
V3_COMMIT=996ee4edccfa899f43e74847fe1380cb8399b57d

check_anchor() {
    local name="$1" want_tag="$2" want_commit="$3"
    local got_tag got_commit
    got_tag="$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$name" | awk '{print $1}')"
    got_commit="$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$name^{}" | awk '{print $1}')"
    if [ "$got_tag" = "$want_tag" ] && [ "$got_commit" = "$want_commit" ]; then
        echo "  PASS      $name is where it has always been"
    else
        echo "  FAIL      $name MOVED -- tag ${got_tag:-<absent>} (want $want_tag),"
        echo "            peels to ${got_commit:-<absent>} (want $want_commit)"
        FAIL=1
    fi
}

if git -C "$ROOT" ls-remote --tags origin >/dev/null 2>&1; then
    check_anchor v2.0.0 "$V2_TAG" "$V2_COMMIT"
    check_anchor v3.0.0 "$V3_TAG" "$V3_COMMIT"
else
    # Not reachable is not "fine". This command exists to make a release
    # decision, and it must not make one on missing evidence.
    echo "  FAIL      could not reach origin to verify the release anchors"
    FAIL=1
fi

# Section A gate 8: the frozen crypto/wire must be byte-identical to v2.0.0.
if git -C "$ROOT" rev-parse -q --verify "$V2_COMMIT^{commit}" >/dev/null 2>&1; then
    if [ -z "$(git -C "$ROOT" diff --name-only "$V2_COMMIT" "$SHA" -- src/core src/spt)" ]; then
        echo "  PASS      frozen crypto/wire: src/core and src/spt unchanged since v2.0.0"
    else
        echo "  FAIL      frozen crypto/wire CHANGED since v2.0.0:"
        git -C "$ROOT" diff --name-only "$V2_COMMIT" "$SHA" -- src/core src/spt | sed 's/^/            /'
        FAIL=1
    fi
else
    echo "  FAIL      the v2.0.0 commit is not available locally, so the frozen-wire gate could not run"
    FAIL=1
fi

# Named, not counted. A gate nobody automated must be visible as such.
echo "  MANUAL    falsification matrix -- Section A marks it blocking and no workflow runs it;"
echo "            its result is recorded in docs/RELEASE-CHECKLIST-3.0.md, not by this command"

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RELEASE GATES: PASS for $SHA"
else
    echo "RELEASE GATES: FAIL for $SHA"
fi
exit "$FAIL"
