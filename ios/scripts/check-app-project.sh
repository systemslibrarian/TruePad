#!/usr/bin/env bash
#
# Guard the iOS application project's configuration.
#
# WHY THIS EXISTS. `project.pbxproj` is edited by a GUI. A single click in Xcode
# can add a capability, link a framework, attach a shell script phase, or switch a
# bundle identifier, and the resulting diff is easy to approve without reading.
# This turns the settings TruePad actually depends on into a test.
#
# Two halves:
#   STATIC   — reads the committed project, plist and scheme. Always runs.
#   BINARY   — inspects a built .app if one is given. Skipped, loudly, if not.
#
# A NOTE ON SUBSTRING MATCHING, learned twice in this repo: `eseed` appears inside
# BoringSSL's `CTR_DRBG_reseed`, and `print(` appears inside `fingerprint(`. Every
# symbol check below therefore matches a PRECISE name, and the probes prove they
# can fire before their silence is trusted.
#
# Usage:
#   ios/scripts/check-app-project.sh
#   ios/scripts/check-app-project.sh /path/to/TruePad.app
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../.."
APPDIR="$ROOT/ios/TruePadApp"
PBX="$APPDIR/TruePadApp.xcodeproj/project.pbxproj"
PLIST="$APPDIR/TruePadApp/Info.plist"
SCHEME="$APPDIR/TruePadApp.xcodeproj/xcshareddata/xcschemes/TruePadApp.xcscheme"
BUILT_APP="${1:-}"

FAIL=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }
note() { printf '  ....  %s\n' "$*"; }

for f in "$PBX" "$PLIST" "$SCHEME"; do
    [ -f "$f" ] || { fail "missing $f"; exit 1; }
done

# THE PROJECT FILE WITH ITS COMMENTS STRIPPED.
#
# pbxproj carries two kinds of comment: the `/* Annotation */` Xcode writes after
# every object reference, and the explanatory header this project adds. Both are
# prose. Searching the raw file for a forbidden name matches the sentence that
# explains why the name is forbidden -- which is exactly what happened the first
# time this guard ran, failing on its own documentation. Configuration checks
# below read the STRIPPED file; only checks that deliberately inspect prose read
# the raw one.
PBX_CODE="$(mktemp)"
trap 'rm -f "$PBX_CODE"' EXIT
python3 - "$PBX" > "$PBX_CODE" <<'STRIP'
import re, sys
text = open(sys.argv[1]).read()
text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)   # /* ... */
text = re.sub(r'//[^\n]*', ' ', text)                 # // ...
sys.stdout.write(text)
STRIP

# The exact approved user-facing camera sentence. Any drift is a product change,
# not a wording tweak: this string is what the operator reads before granting the
# one permission the app asks for.
CAMERA_STRING="TruePad uses the camera only to scan a public receive QR code. Camera images are not saved or uploaded."

echo "== 1. No build-time code execution or remote resolution =="
for pattern in PBXShellScriptBuildPhase XCRemoteSwiftPackageReference repositoryURL \
               PBXCopyFilesBuildPhase ANDROID_HOME; do
    if grep -qF "$pattern" "$PBX_CODE"; then
        fail "project.pbxproj contains $pattern"
    else
        pass "no $pattern"
    fi
done
# The local package is the ONLY package path.
if grep -qF 'isa = XCLocalSwiftPackageReference;' "$PBX_CODE" \
   && grep -qE 'relativePath = \.\./TruePadKit;' "$PBX_CODE"; then
    pass "the only package reference is the local ../TruePadKit"
else
    fail "the local ../TruePadKit package reference is missing or changed"
fi

echo
echo "== 2. No competing project generator or package manager =="
for f in project.yml Project.swift Podfile Cartfile Package.swift .xcodegen; do
    if [ -e "$APPDIR/$f" ]; then
        fail "$f exists under ios/TruePadApp — this project is a plain committed .xcodeproj"
    else
        pass "no $f"
    fi
done

echo
echo "== 3. Nothing personal is committed =="
# A provisioning profile, a certificate, a private key, a Team ID or a device UDID
# in source control is a credential leak and a reproducibility problem at once.
LEAKS="$(cd "$ROOT" && git ls-files ios/TruePadApp | grep -E '\.(mobileprovision|p12|cer|certSigningRequest|pem|key)$' || true)"
if [ -n "$LEAKS" ]; then
    fail "credential-shaped files are committed: $LEAKS"
else
    pass "no provisioning profiles, certificates or keys committed"
fi
if grep -qE 'DEVELOPMENT_TEAM = "";' "$PBX_CODE"; then
    pass "DEVELOPMENT_TEAM is empty in the committed project"
else
    fail "DEVELOPMENT_TEAM is set in the committed project — pass it on the command line instead"
fi
# A 10-character uppercase alphanumeric Team ID, or a device UDID shape.
if grep -qE 'DEVELOPMENT_TEAM = [A-Z0-9]{10}' "$PBX_CODE"; then
    fail "a Team ID appears in the committed project"
else
    pass "no Team ID literal in the committed project"
fi
if grep -qE '000[0-9]{5}-[0-9A-F]{16}' "$PBX_CODE" "$PLIST" "$SCHEME"; then
    fail "a device UDID appears in committed configuration"
else
    pass "no device UDID in committed configuration"
fi

echo
echo "== 3b. One pinned resolution path, not two =="
# The vendored swift-crypto declares a REMOTE dependency on swift-asn1 (for
# _CryptoExtras, which is not linked), so resolving the graph reaches the network
# even though the shipping binary does not contain it. Both the kit and the app
# therefore carry a Package.resolved, and they must pin the SAME revision: two
# lockfiles disagreeing is precisely the "second resolution path for
# security-critical code" this project rules out.
KIT_RESOLVED="$ROOT/ios/TruePadKit/Package.resolved"
APP_RESOLVED="$APPDIR/TruePadApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
if [ ! -f "$APP_RESOLVED" ]; then
    fail "the app has no committed Package.resolved — its remote pin is unenforced"
elif [ ! -f "$KIT_RESOLVED" ]; then
    fail "the kit has no committed Package.resolved"
else
    if python3 - "$KIT_RESOLVED" "$APP_RESOLVED" <<'CMP'
import json, sys
def pins(path):
    d = json.load(open(path))
    return {p['identity']: (p.get('location'), p['state'].get('revision')) for p in d.get('pins', [])}
sys.exit(0 if pins(sys.argv[1]) == pins(sys.argv[2]) else 1)
CMP
    then
        pass "the app and the kit pin identical remote revisions"
    else
        fail "the app and the kit pin DIFFERENT remote revisions — two resolution paths"
    fi
    # And whatever is pinned must be reachable only through _CryptoExtras, which
    # is not linked. Anything else appearing here is a new remote dependency.
    UNEXPECTED="$(python3 -c "
import json,sys
d=json.load(open('$APP_RESOLVED'))
print(' '.join(p['identity'] for p in d.get('pins',[]) if p['identity'] != 'swift-asn1'))
")"
    if [ -n "$UNEXPECTED" ]; then
        fail "unexpected remote dependencies pinned: $UNEXPECTED"
    else
        pass "the only remote pin is swift-asn1 (reachable solely via unlinked _CryptoExtras)"
    fi
fi

echo
echo "== 3c. The one remote pin is not world-writable =="
# xcodebuild creates the directories under project.xcworkspace with the process
# umask, and on this machine it produced 0777. Git does not track directory
# modes, so this cannot be fixed by committing anything -- it recurs on whatever
# machine runs a build. It matters because that directory holds Package.resolved,
# the ONLY integrity control on the single remote fetch in this project: a
# world-writable parent means any local process can change which revision of
# swift-asn1 the next build pulls.
BAD_PERMS=0
for d in "$APPDIR/TruePadApp.xcodeproj/project.xcworkspace" \
         "$APPDIR/TruePadApp.xcodeproj/project.xcworkspace/xcshareddata" \
         "$APPDIR/TruePadApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm"; do
    [ -d "$d" ] || continue
    # Read the mode with python rather than `stat`: this machine's `stat` is GNU
    # coreutils, where -f means "file system", not "format" as in BSD stat. The
    # first version of this check silently fell through to the wrong tool and
    # printed a filesystem block instead of a mode.
    MODE="$(python3 -c "import os,stat,sys;print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])" "$d" 2>/dev/null)"
    if [ -n "$MODE" ] && python3 -c "import sys;sys.exit(0 if int(sys.argv[1],8) & 0o022 else 1)" "$MODE"; then
        fail "$(basename "$d") is group- or world-writable ($MODE) — chmod 755 it"
        BAD_PERMS=1
    fi
done
if [ "$BAD_PERMS" -eq 0 ]; then
    pass "no world-writable directory holds the remote pin"
fi

echo
echo "== 4. Identity, deployment target, signing style =="
BUNDLE_COUNT="$(grep -c 'PRODUCT_BUNDLE_IDENTIFIER = dev.systemslibrarian.truepad;' "$PBX_CODE" || true)"
OTHER_BUNDLE="$(grep -oE 'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;' "$PBX_CODE" | grep -v 'dev.systemslibrarian.truepad' || true)"
if [ "$BUNDLE_COUNT" -ge 2 ] && [ -z "$OTHER_BUNDLE" ]; then
    pass "bundle id is dev.systemslibrarian.truepad in every configuration ($BUNDLE_COUNT)"
else
    fail "bundle id is not uniformly dev.systemslibrarian.truepad (other: $OTHER_BUNDLE)"
fi
TARGET_COUNT="$(grep -c 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;' "$PBX_CODE" || true)"
OTHER_TARGET="$(grep -oE 'IPHONEOS_DEPLOYMENT_TARGET = [^;]+;' "$PBX_CODE" | grep -v '16.0' || true)"
if [ "$TARGET_COUNT" -ge 2 ] && [ -z "$OTHER_TARGET" ]; then
    pass "deployment target is 16.0 everywhere ($TARGET_COUNT)"
else
    fail "deployment target drifted (other: $OTHER_TARGET)"
fi
if [ "$(grep -c 'CODE_SIGN_STYLE = Automatic;' "$PBX_CODE" || true)" -ge 2 ]; then
    pass "automatic signing in every configuration"
else
    fail "signing style is not uniformly Automatic"
fi
# An entitlements file is how capabilities are actually granted. There is none,
# and there should be none: every capability TruePad might be given is one it has
# said it does not want.
if grep -qF 'CODE_SIGN_ENTITLEMENTS' "$PBX_CODE"; then
    fail "the project references an entitlements file"
else
    pass "no entitlements file is referenced (no capabilities to grant)"
fi
if [ -n "$(cd "$ROOT" && git ls-files 'ios/TruePadApp/**/*.entitlements' 2>/dev/null)" ]; then
    fail "an .entitlements file is committed"
else
    pass "no .entitlements file committed"
fi

echo
echo "== 5. Only the intended package products are linked =="
for product in TruePadUI TruePadStorage TruePadSPT; do
    if grep -qF "productName = $product;" "$PBX_CODE"; then
        pass "links $product"
    else
        fail "does not link $product"
    fi
done
for forbidden in TruePadKATSupport _CryptoExtras CryptoExtras SwiftASN1 spt-vector-tool; do
    if grep -qF "$forbidden" "$PBX_CODE"; then
        fail "project references $forbidden"
    else
        pass "no reference to $forbidden"
    fi
done

echo
echo "== 6. The declared OS surface (Info.plist) =="
# Read with plutil so this checks the PARSED value, not a line that happens to
# look right. A usage string differing by one character is a different promise.
ACTUAL_CAMERA="$(plutil -extract NSCameraUsageDescription raw -o - "$PLIST" 2>/dev/null || echo "<missing>")"
if [ "$ACTUAL_CAMERA" = "$CAMERA_STRING" ]; then
    pass "the camera usage string is exactly the approved sentence"
else
    fail "the camera usage string differs from the approved sentence"
    note "expected: $CAMERA_STRING"
    note "actual  : $ACTUAL_CAMERA"
fi
# Every usage description the app declares. Camera must be the ONLY one: each
# extra is a permission prompt for something TruePad does not do.
USAGE_KEYS="$(plutil -convert xml1 -o - "$PLIST" | grep -oE '<key>NS[A-Za-z]*UsageDescription</key>' | sed 's/<[^>]*>//g' | sort)"
if [ "$USAGE_KEYS" = "NSCameraUsageDescription" ]; then
    pass "camera is the only permission the app declares"
else
    fail "unexpected permission declarations: $(echo "$USAGE_KEYS" | tr '\n' ' ')"
fi
# Keys that would grant, imply, or invite a capability TruePad has ruled out.
for key in UIBackgroundModes NSAppTransportSecurity CFBundleURLTypes \
           NSUbiquitousContainers NSBonjourServices NSLocalNetworkUsageDescription \
           UTExportedTypeDeclarations UTImportedTypeDeclarations \
           CFBundleDocumentTypes NSUserActivityTypes com.apple.developer.associated-domains; do
    if plutil -extract "$key" raw -o - "$PLIST" >/dev/null 2>&1; then
        fail "Info.plist declares $key"
    else
        pass "no $key"
    fi
done
for key_value in "UIFileSharingEnabled:false" "LSSupportsOpeningDocumentsInPlace:false"; do
    key="${key_value%%:*}"; want="${key_value##*:}"
    got="$(plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null || echo "<missing>")"
    if [ "$got" = "$want" ]; then
        pass "$key is $want (the store is not browsable in Files)"
    else
        fail "$key is '$got', expected $want"
    fi
done

echo
echo "== 7. The committed scheme carries no instrumentation =="
for pattern in EnvironmentVariables CommandLineArguments MallocScribble \
               enableAddressSanitizer enableThreadSanitizer enableUBSanitizer; do
    if grep -qF "$pattern" "$SCHEME"; then
        fail "the scheme sets $pattern"
    else
        pass "scheme has no $pattern"
    fi
done
if grep -qF 'buildConfiguration = "Release"' "$SCHEME"; then
    pass "the scheme profiles and archives in Release"
else
    fail "the scheme does not use Release for profile/archive"
fi

echo
echo "== 8. The built application =="
if [ -z "$BUILT_APP" ]; then
    note "SKIPPED: no built .app supplied."
    note "This half is not optional evidence — it is simply not available in this"
    note "invocation. Pass a built bundle to check what actually linked:"
    note "    ios/scripts/check-app-project.sh /path/to/TruePad.app"
else
    BIN="$BUILT_APP/$(basename "${BUILT_APP%.app}")"
    [ -f "$BIN" ] || BIN="$BUILT_APP/TruePad"
    if [ ! -f "$BIN" ]; then
        fail "no executable found inside $BUILT_APP"
    else
        SYMS="$(mktemp)"; LINKED="$(mktemp)"
        trap 'rm -f "$SYMS" "$LINKED"' EXIT
        # Captured to FILES, then searched. `grep -q` on a large pipe under
        # `pipefail` reports failure when grep exits early on a match, which
        # silently inverts every "does it contain X" test.
        nm -a "$BIN" > "$SYMS" 2>/dev/null || true
        otool -L "$BIN" > "$LINKED" 2>/dev/null || true

        if [ "$(wc -l < "$SYMS")" -lt 100 ]; then
            fail "only $(wc -l < "$SYMS") symbols read — the probe is not working"
        else
            pass "the symbol probe works ($(wc -l < "$SYMS") symbols)"
        fi

        # PRECISE names. `eseed` alone would match CTR_DRBG_reseed.
        for symbol in TruePadKATSupport DeterministicXWing encapsulateDeterministically \
                      _CryptoExtras SwiftASN1; do
            if grep -qF "$symbol" "$SYMS"; then
                fail "the app binary contains $symbol"
            else
                pass "no $symbol in the app binary"
            fi
        done

        # The vendored X-Wing path must be the one that shipped.
        for symbol in CCryptoBoringSSL_XWING_encap CCryptoBoringSSL_XWING_decap; do
            if grep -qF "$symbol" "$SYMS"; then
                pass "the vendored BoringSSL provides $symbol"
            else
                fail "$symbol missing — this is not the vendored X-Wing path"
            fi
        done

        echo
        for framework in Network.framework CFNetwork.framework CloudKit.framework \
                         UserNotifications.framework CoreTelephony.framework; do
            if grep -qF "$framework" "$LINKED"; then
                fail "the app links $framework"
            else
                pass "the app does not link $framework"
            fi
        done

        # The built plist must carry the approved sentence too: the source plist
        # being right does not prove the packaged one is.
        BUILT_CAMERA="$(plutil -extract NSCameraUsageDescription raw -o - "$BUILT_APP/Info.plist" 2>/dev/null || echo "<missing>")"
        if [ "$BUILT_CAMERA" = "$CAMERA_STRING" ]; then
            pass "the PACKAGED Info.plist carries the approved camera sentence"
        else
            fail "the packaged camera sentence differs: $BUILT_CAMERA"
        fi

        MINOS="$(vtool -show-build "$BIN" 2>/dev/null | awk '/minos/{print $2; exit}')"
        if [ "$MINOS" = "16.0" ]; then
            pass "the built binary's minimum OS is 16.0"
        else
            fail "the built binary's minimum OS is '$MINOS', expected 16.0"
        fi
    fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "RESULT: PASS -- the app project declares only what TruePad has committed to."
else
    echo "RESULT: FAIL"
fi
exit "$FAIL"
