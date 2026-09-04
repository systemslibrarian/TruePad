#!/usr/bin/env bash
#
# Prove the committed android/vectors/ wire fixtures are byte-identical to what
# the CURRENT source tree produces — the branch you are on (e.g. master), not
# only the v2.0.0 release.
#
# regenerate-vectors.sh pins v2.0.0: it proves the fixtures match what SHIPPED.
# This script closes the complementary gap: master's message/store wire is
# supposed to be byte-identical to v2.0.0, and if it ever drifted, the
# release-pinned check would still pass while the Kotlin twin quietly stopped
# matching the code it now ships beside. So this regenerates from THIS checkout's
# own src/ and fails on any difference.
#
#     ./tools/verify-vectors-current.sh   # exits nonzero if a fixture drifted
#
# Three fixtures are 3.0 artifacts NOT produced by this wire generator, so they are
# excluded from the comparison; each is proven by its own cross-language tests:
# deployment-evaluator-v3.json (scripts/gen-evaluator-corpus.ts; DeploymentCorpusTest
# + the TS deployment-evaluator-corpus test), spt-interop.json (scripts/gen-spt-interop.ts;
# SptInteropTest + tests/spt-interop-corpus, which re-seals and compares so a stale
# corpus cannot survive), spt-android-generated.json (the Android Edition's own
# seal output, written by SptAndroidCorpusTest and opened + resealed byte-
# identically by the iOS SptCrossEditionCorpusTests; it also carries
# production-entropy cases that are unreproducible by construction), and
# xwing-draft10-appendix-c.json (the vendored X-Wing
# draft-10 Appendix C KATs; XWingKatTest + tests/spt-xwing).
# (The deployment-evaluator corpus is additionally pinned byte-identical to the
#  canonical test-vectors/ copy at the end of this script.)
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
repo="$(cd "$android/.." && pwd)"

command -v node >/dev/null || { echo "node is required (>= 22.18.0, for TypeScript type stripping)" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "node $(node -v) is too old; src/ is TypeScript and needs node >= 22.18.0" >&2
  exit 1
fi

# The generator does `await import("../src/core/...")` relative to its own file
# and runs `spec/reference/vectors.mjs` relative to the cwd, so it must live one
# level under the repo root and run with the repo as cwd.
gendir="$(mktemp -d "$repo/.tp-vectors-gen.XXXXXX")"
out="$(mktemp -d "${TMPDIR:-/tmp}/truepad-vectors-current.XXXXXX")"
cleanup() { rm -rf "$gendir" "$out"; return 0; }
trap cleanup EXIT

cp "$here/generate-vectors.mjs" "$gendir/generate-vectors.mjs"
( cd "$repo" && node "$gendir/generate-vectors.mjs" "$out" >/dev/null )

if diff -ru "$android/vectors" "$out" -x deployment-evaluator-v3.json -x spt-interop.json -x xwing-draft10-appendix-c.json -x spt-android-generated.json >/dev/null; then
  echo "vectors are byte-identical to what THIS source tree ($(git -C "$repo" rev-parse --short HEAD)) produces"
else
  echo "VECTORS DRIFTED FROM THE CURRENT SOURCE TREE:" >&2
  diff -ru "$android/vectors" "$out" -x deployment-evaluator-v3.json -x spt-interop.json -x xwing-draft10-appendix-c.json -x spt-android-generated.json >&2 || true
  exit 1
fi

# The deployment-evaluator corpus is not a wire vector, but the Android JVM
# conformance test reads the android/vectors/ copy while the canonical copy the
# TS derives lives at repo-root test-vectors/. Pin them byte-identical here too,
# so the Android side proves its own corpus is the canonical one rather than
# leaning entirely on the TS suite to notice a drift.
canonical="$repo/test-vectors/deployment-evaluator-v3.json"
androidcopy="$android/vectors/deployment-evaluator-v3.json"
if [[ -f "$canonical" && -f "$androidcopy" ]]; then
  if cmp -s "$canonical" "$androidcopy"; then
    echo "deployment-evaluator corpus is byte-identical to the canonical test-vectors/ copy"
  else
    echo "DEPLOYMENT CORPUS DRIFT: android/vectors/ copy differs from test-vectors/ canonical:" >&2
    diff -u "$canonical" "$androidcopy" >&2 || true
    exit 1
  fi
fi
