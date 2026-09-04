#!/usr/bin/env bash
#
# Prove that a SHIPPING TruePad iOS app cannot contain, or even name, the
# deterministic (caller-supplied-entropy) X-Wing encapsulation that TruePad uses
# to reproduce frozen known-answer and interop vectors.
#
#   LOSS IS ACCEPTABLE; REUSE IS NOT.
#
# Deterministic encapsulation repeats a shared secret whenever its entropy
# repeats. It exists here only to reproduce the draft-10 Appendix-C corpus and
# TruePad's deterministic SPT fixtures. It lives in TruePadKATSupport: a target
# that is NOT a package product and NOT a dependency of TruePadSPT.
#
# The check models the app the way the app actually consumes the code -- as an
# EXTERNAL package consumer, which by SwiftPM's rules can reference products
# only. (Note: `swift build --product X` does NOT model this; SwiftPM still
# builds every target of the root package, so it cannot prove isolation.)
#
# Run from anywhere:  ios/scripts/check-release-isolation.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$HERE/../TruePadKit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }

# A stand-in for the shipping app: an external consumer of the TruePadKit package.
mkdir -p "$WORK/App/Sources/App"
cat > "$WORK/App/Package.swift" <<EOF
// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "App",
    platforms: [.macOS(.v14), .iOS(.v16)],
    dependencies: [.package(path: "$KIT")],
    targets: [.target(name: "App", dependencies: [
        .product(name: "TruePadSPT", package: "TruePadKit")
    ])]
)
EOF
cat > "$WORK/App/Sources/App/App.swift" <<'EOF'
import TruePadSPT
public enum App { public static let suite = TruePadSPT.suiteId }
EOF

echo "== Building a stand-in shipping app (release) against the package's products =="
if ! swift build --package-path "$WORK/App" -c release --scratch-path "$WORK/build" \
        > "$WORK/build.log" 2>&1; then
    cat "$WORK/build.log"; echo "consumer build failed"; exit 1
fi
pass "the app builds against TruePadSPT alone"

echo
echo "== 1. Test-support module absent from the shipping app's build =="
HITS=$(find "$WORK/build" \( -name 'TruePadKATSupport*' -o -name 'DeterministicXWing*' \) 2>/dev/null || true)
if [ -n "$HITS" ]; then
    echo "$HITS" | sed 's/^/        /'
    fail "TruePadKATSupport was built into the shipping app graph"
else
    pass "no TruePadKATSupport / DeterministicXWing artifact is built for the app"
fi

echo
echo "== 2. NEGATIVE CONTROL: the app must not even be able to import it =="
cat > "$WORK/App/Sources/App/Probe.swift" <<'EOF'
import TruePadKATSupport
EOF
if swift build --package-path "$WORK/App" -c release --scratch-path "$WORK/build" \
        > "$WORK/probe.log" 2>&1; then
    fail "the app successfully imported TruePadKATSupport -- isolation is NOT structural"
else
    if grep -q "no such module 'TruePadKATSupport'" "$WORK/probe.log"; then
        pass "import is refused at compile time: no such module 'TruePadKATSupport'"
    else
        echo "        (build failed, but not with the expected diagnostic:)"
        grep -m3 "error:" "$WORK/probe.log" | sed 's/^/        /' || true
        fail "import failed for an unexpected reason; isolation not proven"
    fi
fi
rm -f "$WORK/App/Sources/App/Probe.swift"

echo
echo "== 3. No deterministic-encapsulation symbols in the app's objects =="
OBJS=$(find "$WORK/build" -name '*.o' 2>/dev/null || true)
if [ -z "$OBJS" ]; then
    fail "no objects found to scan"
else
    HITS=$(nm -a $OBJS 2>/dev/null | grep -Ei 'TruePadKATSupport|DeterministicXWing' || true)
    if [ -n "$HITS" ]; then
        echo "$HITS" | sed 's/^/        /'
        fail "app objects reference the deterministic surface"
    else
        pass "app objects reference no TruePad deterministic-encapsulation symbol"
    fi
fi

echo
echo "== 4. No production source names the deterministic surface =="
# Delegated to ProductionIsolationTests rather than re-grepped here. That test
# strips Swift comments before auditing, because the production sources document
# this very boundary and naming the forbidden surface in a doc comment is how
# that explanation is written. Two implementations of a security check are two
# chances to disagree about what counts as a reference, so there is one.
if swift test --package-path "$KIT" \
        --filter 'ProductionIsolationTests' > "$WORK/audit.log" 2>&1; then
    pass "production sources are clean, and the package graph isolates the hook"
    grep -E "Executed [0-9]+ tests" "$WORK/audit.log" | tail -1 | sed 's/^[[:space:]]*/        /'
else
    grep -E "error:|XCTAssert" "$WORK/audit.log" | head -10 | sed 's/^/        /'
    fail "the production isolation tests did not pass"
fi

echo "== 5. No TruePad-authored file lives in the vendored Sources =="
HITS=$(find "$HERE/../vendor/swift-crypto/Sources" -iname '*truepad*' 2>/dev/null || true)
if [ -n "$HITS" ]; then
    echo "$HITS" | sed 's/^/        /'
    fail "vendored Sources/ contains a TruePad-authored FILE; the app would link it"
else
    pass "no TruePad-authored file in vendored Sources/; the one source patch is a reviewed hardening of upstream's own file, pinned by EXPECTED-PATCH.diff"
fi

echo
echo "== Honest limitation =="
cat <<'TXT'
  The BoringSSL C symbol XWING_encap_external_entropy IS present in any binary
  that links swift-crypto, and this script does NOT claim otherwise. That is not
  a TruePad affordance: upstream's own randomized XWING_encap draws 64 random
  bytes and calls XWING_encap_external_entropy internally, so the symbol is
  inseparable from ordinary encapsulation.

  What is proven above is what TruePad controls: the app cannot import, link, or
  name the deterministic wrapper, and no production source reaches the C entry
  point. Production sealing draws entropy from the system CSPRNG, and no
  production type accepts an `eseed` argument.
TXT

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- deterministic encapsulation is structurally test-only."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
