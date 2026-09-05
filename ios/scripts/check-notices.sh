#!/usr/bin/env bash
#
# Verify that the iOS Edition's third-party notices still describe the code that
# is actually vendored.
#
# A notices file is a legal artefact and a supply-chain artefact at once. If it
# names a version that is no longer the vendored one, it is not merely stale — it
# is a false statement about what the product contains, and it is the document a
# reviewer would consult first. So the pins are checked against the tree rather
# than trusted.
#
# Run from anywhere:  ios/scripts/check-notices.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../.."
NOTICES="$ROOT/docs/THIRD-PARTY-NOTICES.md"
VENDOR="$HERE/../vendor"

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }

# The pins the notices must agree with, read from the sources of truth rather
# than restated here.
UPSTREAM_TAG="$(grep -oE 'UPSTREAM_TAG="[^"]+"' "$VENDOR/verify-vendor.sh" | head -1 | cut -d'"' -f2)"
UPSTREAM_COMMIT="$(grep -oE 'UPSTREAM_COMMIT="[^"]+"' "$VENDOR/verify-vendor.sh" | head -1 | cut -d'"' -f2)"
BORINGSSL_COMMIT="$(grep -oE 'BoringSSL Commit: [0-9a-f]{40}' "$VENDOR/swift-crypto/Package.swift" | head -1 | awk '{print $3}')"

echo "== Pins read from the tree =="
echo "  swift-crypto tag    : ${UPSTREAM_TAG:-<not found>}"
echo "  swift-crypto commit : ${UPSTREAM_COMMIT:-<not found>}"
echo "  BoringSSL commit    : ${BORINGSSL_COMMIT:-<not found>}"

[ -n "$UPSTREAM_TAG" ] && [ -n "$UPSTREAM_COMMIT" ] && [ -n "$BORINGSSL_COMMIT" ] \
    || { fail "could not read the pins from the tree"; exit 1; }

echo
echo "== 1. The notices name the exact vendored versions =="
for needle in "$UPSTREAM_TAG" "$UPSTREAM_COMMIT" "$BORINGSSL_COMMIT"; do
    if grep -qF "$needle" "$NOTICES"; then
        pass "THIRD-PARTY-NOTICES.md names $needle"
    else
        fail "THIRD-PARTY-NOTICES.md does not name $needle"
    fi
done

echo
echo "== 2. The upstream licence texts ship with the vendored code =="
for f in LICENSE.txt NOTICE.txt; do
    if [ -s "$VENDOR/swift-crypto/$f" ]; then
        pass "vendor/swift-crypto/$f present"
    else
        fail "vendor/swift-crypto/$f missing or empty"
    fi
done

echo
echo "== 3. The declared licences are the ones the files actually carry =="
if grep -q "Apache License" "$VENDOR/swift-crypto/LICENSE.txt"; then
    pass "swift-crypto ships the Apache-2.0 text"
else
    fail "swift-crypto LICENSE.txt is not the Apache-2.0 text"
fi
if grep -q "Apache License, Version 2.0" "$VENDOR/swift-crypto/Sources/CCryptoBoringSSL/crypto/xwing/xwing.cc"; then
    pass "BoringSSL sources carry their Apache-2.0 headers"
else
    fail "BoringSSL source header is not the expected Apache-2.0 notice"
fi

echo
echo "== 4. The iOS notices section exists and names its components =="
for needle in "iOS Edition" "swift-crypto" "BoringSSL" "fiat-crypto"; do
    if grep -qF "$needle" "$NOTICES"; then
        pass "notices mention $needle"
    else
        fail "notices do not mention $needle"
    fi
done

echo
echo "== 5. The AGPL-compatibility statement is present =="
if grep -q "AGPL-3.0-only compatible" "$NOTICES"; then
    pass "AGPL-3.0-only compatibility is stated"
else
    fail "the notices do not state AGPL-3.0-only compatibility"
fi

echo
echo "== 6. The vendored-patch claim matches the actual diff =="
#
# This section exists because the notices claimed "two [modifications], both in
# the vendored Package.swift; no file under Sources/ is modified" and "30 lines",
# while EXPECTED-PATCH.diff was 65 lines and patched a SHIPPING CRYPTO SOURCE.
# Every other check in this script passed at the time. A supply-chain notice that
# understates the delta is worse than none: it tells a reviewer not to look.
#
# Stated POSITIVELY — the notices must say the real size and name every patched
# Sources/ file. A check phrased as "the notices must not DENY the modification"
# matched this file's own quoted retraction of the old wording, which is the
# prose-versus-code mistake these guards have made before.
PATCH="$ROOT/ios/vendor/EXPECTED-PATCH.diff"
if [ ! -r "$PATCH" ]; then
    fail "EXPECTED-PATCH.diff is unreadable -- the delta claim cannot be checked"
else
    PATCH_LINES="$(wc -l < "$PATCH" | tr -d ' ')"
    PATCHED_FILES="$(grep '^+++ ' "$PATCH" | sed 's|^+++ vendored/||' | sort -u)"
    PATCH_FILE_COUNT="$(printf '%s\n' "$PATCHED_FILES" | grep -c . | tr -d ' ')"

    if [ "$PATCH_FILE_COUNT" -gt 0 ]; then
        pass "the patch probe works ($PATCH_FILE_COUNT patched file(s) seen)"
    else
        fail "no patched files parsed -- this probe is not working"
    fi

    if grep -qF "($PATCH_LINES lines)" "$NOTICES"; then
        pass "the notices state the real patch size ($PATCH_LINES lines)"
    else
        fail "the notices do not state the real patch size ($PATCH_LINES lines)"
    fi

    # EVERY patched file must be named. A patch under Sources/ is a change to
    # shipping code and a reviewer must be told which file.
    while IFS= read -r pf; do
        [ -n "$pf" ] || continue
        base="$(basename "$pf")"
        if grep -qF "$base" "$NOTICES"; then
            pass "the notices name the patched file $base"
        else
            fail "the patch modifies $pf, which the notices never name"
        fi
    done <<< "$PATCHED_FILES"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- the notices describe the code that is actually vendored."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
