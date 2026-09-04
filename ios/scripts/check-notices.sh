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
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- the notices describe the code that is actually vendored."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
