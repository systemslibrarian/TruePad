#!/usr/bin/env bash
#
# Inspect an .xcarchive for the things App Store Connect rejects, and for the
# things TruePad has promised about what it ships.
#
# WHY THIS EXISTS SEPARATELY FROM inspect-release-binary.sh. That script asks
# "what survived the optimiser into the binary". This asks "would Apple take this
# bundle, and is it the product we said it was". They fail for different reasons
# and a green one says nothing about the other.
#
# AND WHY IT EXISTS AT ALL: `xcodebuild archive` reports ARCHIVE SUCCEEDED for a
# bundle with no app icon, and Xcode's own `-validate-for-store` passed one too.
# The icon is rejected at UPLOAD (ITMS-90713). A green archive is not evidence of
# uploadability, so something has to check before the upload does.
#
# Usage:  ios/scripts/check-app-store-archive.sh <path-to.xcarchive>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The captured-symbol machinery, shared rather than re-implemented: a live
# `nm | grep -q` under pipefail is how a present symbol was once reported missing.
# shellcheck source=lib/symtab.sh
. "$HERE/lib/symtab.sh"

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] || { echo "usage: $0 <path-to.xcarchive>" >&2; exit 2; }
[ -d "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 2; }

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }
note() { printf '  ....  %s\n' "$*"; }

APP="$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' | LC_ALL=C sort | head -1)"
[ -n "$APP" ] || { echo "  FAIL  no .app inside $ARCHIVE" >&2; exit 1; }
PLIST="$APP/Info.plist"
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || true; }

echo "inspecting $(basename "$APP") from $(basename "$ARCHIVE")"

# ---- what TruePad has committed to being --------------------------------
EXPECT_ID="dev.systemslibrarian.truepad"
EXPECT_VERSION="3.0.0"

echo
echo "== 1. Identity =="
got="$(plist CFBundleIdentifier)"
[ "$got" = "$EXPECT_ID" ] && pass "bundle identifier is $EXPECT_ID" \
    || fail "bundle identifier is '${got:-<absent>}', expected $EXPECT_ID"
# The stale clone package put two independent pad stores on one handset once.
case "$got" in
    *.b|*.debug|*.dev) fail "the bundle identifier carries a clone/dev suffix" ;;
    *) pass "no clone or development suffix in the identifier" ;;
esac

got="$(plist CFBundleShortVersionString)"
[ "$got" = "$EXPECT_VERSION" ] && pass "marketing version is $EXPECT_VERSION" \
    || fail "marketing version is '${got:-<absent>}', expected $EXPECT_VERSION"

# A build number must exist, be a positive integer, and be uploadable.
build="$(plist CFBundleVersion)"
if [ -z "$build" ]; then
    fail "CFBundleVersion is absent — App Store Connect requires a build number"
elif ! printf '%s' "$build" | grep -qE '^[0-9]+(\.[0-9]+){0,2}$'; then
    fail "CFBundleVersion '$build' is not a valid dotted-integer build number"
elif [ "$(printf '%s' "$build" | cut -d. -f1)" -lt 1 ]; then
    fail "CFBundleVersion '$build' is not positive"
else
    pass "build number is $build"
fi

echo
echo "== 2. The app icon =="
# THE ONE APPLE REJECTS AT UPLOAD RATHER THAN AT BUILD.
icon_name="$(plist CFBundleIconName)"
if [ -z "$icon_name" ]; then
    fail "CFBundleIconName is ABSENT — App Store Connect rejects this (ITMS-90713)"
    note "the asset catalog is wired, but AppIcon.appiconset has no artwork;"
    note "see docs/APP-ICON-SPEC.md — this is an ARTWORK blocker, not a code one"
else
    pass "CFBundleIconName is $icon_name"
fi
if [ -f "$APP/Assets.car" ]; then
    pass "a compiled asset catalog is present"
else
    fail "no Assets.car — no compiled icon reached the bundle"
fi

echo
echo "== 3. Nothing that must not ship =="
found="$(find "$APP" \( -iname '*.xctest' -o -iname '*XCTest*' -o -iname '*UITests*' \) | head -5 || true)"
[ -z "$found" ] && pass "no test bundle inside the app" \
    || { fail "a test bundle is inside the app:"; printf '%s\n' "$found" | sed 's/^/            /'; }

if [ -d "$APP/Frameworks" ]; then
    note "embedded frameworks:"; ls "$APP/Frameworks" | sed 's/^/            /'
    fail "unexpected embedded frameworks — TruePad links statically"
else
    pass "no embedded frameworks"
fi

for key in UIBackgroundModes CFBundleURLTypes NSAppTransportSecurity UIFileSharingEnabled_true; do
    case "$key" in
        UIFileSharingEnabled_true)
            v="$(plist UIFileSharingEnabled)"
            [ "$v" = "true" ] && fail "UIFileSharingEnabled is true — the store would be reachable from Files" \
                || pass "file sharing is not enabled" ;;
        *)
            v="$(plist "$key")"
            [ -z "$v" ] && pass "no $key" || { fail "unexpected $key present"; note "$v"; } ;;
    esac
done

echo
echo "== 4. What must be declared =="
[ -f "$APP/PrivacyInfo.xcprivacy" ] && pass "the privacy manifest reached the bundle" \
    || fail "PrivacyInfo.xcprivacy is missing from the app bundle"

v="$(plist ITSAppUsesNonExemptEncryption)"
[ "$v" = "true" ] && pass "ITSAppUsesNonExemptEncryption is true" \
    || fail "ITSAppUsesNonExemptEncryption is '${v:-<absent>}' — TruePad ships encryption, so true is the truthful answer"

cam="$(plist NSCameraUsageDescription)"
if [ -z "$cam" ]; then
    fail "NSCameraUsageDescription is absent, but the app uses the camera"
elif printf '%s' "$cam" | grep -qiE 'not (saved|uploaded)'; then
    pass "the camera purpose string states the retention limit"
else
    fail "the camera purpose string no longer says images are not saved or uploaded"
fi

echo
echo "== 5. Entitlements =="
ENT="$ARCHIVE/entitlements.plist"
codesign -d --entitlements :- "$APP" > "$ENT" 2>/dev/null || true
if [ ! -s "$ENT" ]; then
    pass "no entitlements embedded (expected for an unsigned archive, and TruePad requests no capability)"
else
    for bad in aps-environment com.apple.developer.icloud com.apple.developer.networking \
               com.apple.security.application-groups com.apple.developer.associated-domains; do
        if grep -qF "$bad" "$ENT"; then fail "unexpected entitlement: $bad"; fi
    done
    pass "no unexpected capability entitlement"
fi

echo
echo "== 6. The binary, by captured symbols =="
BIN="$APP/$(plist CFBundleExecutable)"
SYMS="$ARCHIVE/undefined-symbols.txt"
if nm -u "$BIN" > "$SYMS" 2>/dev/null; then
    n="$(wc -l < "$SYMS" | tr -d ' ')"
    if [ "$n" -lt 200 ]; then
        fail "only $n undefined symbols — the probe is not working, so its silence means nothing"
    else
        pass "the symbol probe works ($n undefined symbols)"
        for s in URLSession NSURLConnection CFSocket nw_connection getaddrinfo CloudKit AdSupport ATTracking; do
            if symtab_has "$SYMS" "$s"; then fail "the app imports $s"; else pass "no $s"; fi
        done
        for s in TruePadKATSupport DeterministicXWing TRUEPAD_KAT_SUPPORT; do
            if symtab_has "$SYMS" "$s"; then fail "test-only surface in the shipping app: $s"; else pass "no $s"; fi
        done
    fi
else
    fail "nm could not read the app binary — the probe failed; this says nothing about the app"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- this archive is shaped like something Apple would accept."
    echo "        It says NOTHING about signing, which is a separate step."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
