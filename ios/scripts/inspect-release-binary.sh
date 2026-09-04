#!/usr/bin/env bash
#
# Inspect what a RELEASE build of the iOS Edition actually contains.
#
# Source review says what the code was written to do. This says what survived the
# optimiser and the linker into the artefact a person would install — which is a
# different question, and the only one an installer can check.
#
# WHAT IT LOOKS FOR:
#
#   1. No test-only surface. The deterministic KAT hook exists so the frozen
#      draft-10 vectors can be reproduced with fixed entropy. If its symbol is in
#      a release binary, the "structurally test-only" claim has stopped being
#      true, whatever the package manifest says.
#   2. No build-machine paths. An absolute path to someone's home directory is
#      not a vulnerability, but it is information about the build host that the
#      binary has no reason to carry, and it is how a reproducible-build claim
#      quietly becomes false.
#   3. No networking symbols. The edition performs no network I/O; the source
#      guard asserts that, and this asserts the linker agreed.
#   4. The X-Wing implementation that IS expected. A binary that silently lost
#      the vendored BoringSSL path would fall back to something else, and the
#      interop corpora would be the only thing that noticed.
#
# WHAT IT IS NOT: it is not a decompilation, and it does not claim the binary is
# free of every string worth hiding. It checks the specific things this project
# has committed to.
#
# Usage:  ios/scripts/inspect-release-binary.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$HERE/../TruePadKit"

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }
note() { printf '  ....  %s\n' "$*"; }

DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT

echo "== Building every shipping product for a real device, Release =="
cd "$KIT"
xcodebuild -resolvePackageDependencies > /dev/null 2>&1
for scheme in TruePadCore TruePadClaims TruePadStorage TruePadSPT TruePadUI; do
    xcodebuild -scheme "$scheme" \
               -destination 'generic/platform=iOS' \
               -configuration Release \
               -derivedDataPath "$DERIVED" \
               build > /dev/null 2>&1 || { fail "$scheme did not build"; exit 1; }
done
pass "all shipping products built for generic/platform=iOS"

PRODUCTS="$DERIVED/Build/Products/Release-iphoneos"
[ -d "$PRODUCTS" ] || { fail "no Release-iphoneos products directory"; exit 1; }

OBJECTS="$(find "$PRODUCTS" -name '*.o' | sort)"
[ -n "$OBJECTS" ] || { fail "no object files to inspect"; exit 1; }
note "inspecting $(echo "$OBJECTS" | wc -l | tr -d ' ') object files"

# TruePad's OWN objects. The vendored BoringSSL is third-party C and is inspected
# separately for what it must CONTAIN, not for what it must not.
OURS="$(echo "$OBJECTS" | grep -E '/TruePad(Core|Claims|Storage|SPT|UI)\.o$' || true)"
[ -n "$OURS" ] || { fail "none of TruePad's own objects were found"; exit 1; }

# THE SYMBOL TABLES AND STRINGS, CAPTURED ONCE INTO FILES.
#
# This is not an optimisation. `set -o pipefail` plus `grep -q` on a LARGE stream
# is a trap: grep exits at the first match and closes the pipe, `nm` dies of
# SIGPIPE, and pipefail reports the pipeline as FAILED -- so a "does it contain
# X" test takes the not-found branch whether or not X is there. Every check in
# the first version of this script was vacuous for exactly that reason, and the
# self-probes below exist because of it. Small `echo "$var" | grep -q` is safe
# (the write fits the pipe buffer and completes), which is why the other scripts
# in this repo are unaffected; 35,000 lines of `nm` output is not.
SYMS="$DERIVED/symbols.txt"
STRS="$DERIVED/strings.txt"
echo "$OURS" | xargs nm -a > "$SYMS" 2>/dev/null || true
echo "$OURS" | xargs nm -u > "$DERIVED/undefined.txt" 2>/dev/null || true
echo "$OURS" | xargs strings -a > "$STRS" 2>/dev/null || true

echo
echo "== 1. No test-only surface in a release binary =="
# The deterministic hook and the KAT support must be absent from what ships.
# `nm`, NOT `strings`. Swift symbol names live in the SYMBOL TABLE, and
# `strings -a` does not surface them: probing with `assessDeployment` -- a symbol
# that is certainly present -- found 0 hits through `strings` and 1 through `nm`,
# so the first version of this check was vacuous and passed for the wrong reason.
# Prove the symbol probe can fire: assessDeployment is certainly present.
if grep -qF "assessDeployment" "$SYMS"; then
    pass "the symbol probe works (assessDeployment is present, as it must be)"
else
    fail "the symbol probe cannot see a symbol that is certainly there — it is vacuous"
fi
for symbol in TruePadKATSupport DeterministicXWing TRUEPAD_KAT_SUPPORT eseed; do
    if grep -qF "$symbol" "$SYMS"; then
        fail "a release object mentions $symbol"
    else
        pass "no release object mentions $symbol"
    fi
done

echo
echo "== 2. No build-machine paths =="
# Swift embeds paths in debug info; Release with no dSYM should not carry the
# builder's home directory into the object text.
# Prove the string probe can fire: a Swift object always carries some literal
# text, so an empty extraction means the probe is broken rather than the binary
# clean.
STRING_COUNT="$(wc -l < "$STRS" | tr -d ' ')"
if [ "${STRING_COUNT:-0}" -lt 20 ]; then
    fail "only $STRING_COUNT strings extracted — the string probe is not working"
else
    pass "the string probe works ($STRING_COUNT strings extracted)"
fi
LEAKED="$(grep -oE '/Users/[A-Za-z0-9._-]+' "$STRS" | sort -u || true)"
if [ -n "$LEAKED" ]; then
    note "paths found: $(echo "$LEAKED" | tr '\n' ' ')"
    fail "a release object embeds a build-machine path"
else
    pass "no build-machine home path in TruePad's own objects"
fi

echo
echo "== 3. No networking symbols linked =="
# Prove the probe can fire before trusting what it does not find. Counting is the
# right shape here rather than naming an expected symbol: a specific runtime
# entry point (`swift_release`, say) is a TOOLCHAIN detail and guessing one wrong
# would make this self-check fail for the wrong reason -- which it did, on the
# first attempt. What must be true regardless of toolchain is that these objects
# import a substantial number of symbols; if they import none, the probe is
# broken and its silence about URLSession means nothing.
UNDEF_COUNT="$(wc -l < "$DERIVED/undefined.txt" | tr -d ' ')"
if [ "${UNDEF_COUNT:-0}" -lt 50 ]; then
    fail "only $UNDEF_COUNT undefined symbols found — the linkage probe is not working"
else
    pass "the linkage probe works ($UNDEF_COUNT undefined symbols across our objects)"
fi
for symbol in URLSession NSURLConnection CFSocket nw_connection getaddrinfo; do
    if grep -qF "$symbol" "$DERIVED/undefined.txt"; then
        fail "a release object imports $symbol"
    else
        pass "no release object imports $symbol"
    fi
done

echo
echo "== 4. The X-Wing implementation that is supposed to be there =="
BORING="$(find "$PRODUCTS" -name 'CCryptoBoringSSL.o' | head -1)"
if [ -z "$BORING" ]; then
    fail "CCryptoBoringSSL.o is not in the Release products"
else
    for symbol in CCryptoBoringSSL_XWING_encap CCryptoBoringSSL_XWING_decap; do
        if nm -g "$BORING" 2>/dev/null | grep -qF "$symbol"; then
            pass "the vendored BoringSSL provides $symbol"
        else
            fail "$symbol is missing — the X-Wing path is not the vendored one"
        fi
    done
fi

echo
echo "== Honest limitation =="
cat <<'EOF'
  This inspects the LINKED OBJECTS of a device Release build. It is not a
  decompilation and it does not prove the absence of every string worth hiding;
  it proves the specific commitments this project has made. In particular, the
  symbol XWING_encap_external_entropy IS present in anything linking swift-crypto
  and is NOT evidence of a TruePad affordance: upstream's own randomized
  XWING_encap draws 64 random bytes and calls it internally. What is checked
  above is what TruePad controls.
EOF

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- the release binary contains what it should and not what it should not."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
