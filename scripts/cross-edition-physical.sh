#!/usr/bin/env bash
#
# THE PHYSICAL ANDROID↔iPHONE CROSS-EDITION CEREMONY.
#
# Two real handsets, one pad, four artifacts carried between them by this script.
# Neither edition re-creates what the other produced. What is checked, exactly,
# because "every artifact is hashed on the device that made it and hashed again
# where it lands" was a stronger sentence than the run performs:
#
#   · transfer.tps2      — hashed on the host after collection and again on the
#                          handset after the push; the run fails if they differ.
#   · iphone-tp2.txt     — same, host then handset.
#   · iphone-json.json   — same, host then handset.
#   · the Android TP2 and canonical JSON — carried out through the courier log
#     and hashed on the HOST only. The iPhone asserts what it received against
#     the sha the harness passes it (ANDROID_TP2_SHA), which is a check on the
#     consuming device but not an independent hash taken there.
#
# So: three of the artifacts are hashed at both ends, and the Android-produced
# pair are hashed once and compared against that value on the far side. Both are
# real checks; only one of them is the stronger claim this comment used to make
# about all of them.
#
# THE INVARIANT THAT SHAPES THIS FILE. All Android steps whose accumulated state
# is part of the proof run in ONE instrumentation invocation. `connectedAndroidTest`
# reinstalls the app on every invocation, which wipes its data, so the app is
# installed ONCE here and the exchange is then driven through `am instrument`.
# This script brackets that single invocation and does the carrying.
#
#   iPhone seals ──▶ transfer.tps2 ──▶ Android opens and commits
#   Android writes ──▶ TP2 + canonical JSON ──▶ iPhone opens both
#   iPhone writes ──▶ TP2 ──▶ Android opens
#
# WHAT IS REAL AND WHAT IS SCRIPTED. Every decision that carries security is taken
# in the interface on a handset: creating the pad, publishing the one-time receive
# code, comparing the twelve words, sealing, committing, writing and opening. The
# script is the courier and the notary, and nothing else.
#
# usage: scripts/cross-edition-physical.sh
#   ANDROID_SERIAL   adb serial            (default: the only attached device)
#   IOS_DEVICE_ID    devicectl identifier  (default: the only paired device)
#   DEVELOPMENT_TEAM Apple Team ID         (required; not stored in source control)
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evid="${EVIDENCE_DIR:-artifacts/cross-edition/$stamp}"
mkdir -p "$evid"
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$evid/run.log"; }
die() { log "FAIL: $*"; exit 1; }

APP_ID="dev.systemslibrarian.truepad"
TEST_ID="$APP_ID.test"
RUNNER="androidx.test.runner.AndroidJUnitRunner"
CLASS="dev.systemslibrarian.truepad.app.CrossEditionTest#crossEditionExchange"
DROP="/data/local/tmp"
IOS_MSG="hello from the iPhone"
# THE SECOND MESSAGE, in the canonical spelling. Passed EXPLICITLY to both halves
# below: the Android test and the iOS test each carry a default for it, the two
# defaults happen to be the same string, and a run that relies on that is a run
# that stops proving anything the moment one of them is edited.
IOS_JSON_MSG="the iPhone in canonical form"
DD="${DERIVED_DATA:-/tmp/tp-dd}"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# ------------------------------------------------- 0. exactly one owner, ever
#
# EVERY AMBIGUOUS RESULT IN THIS CEREMONY'S HISTORY CAME FROM TWO PROCESSES
# TOUCHING ONE HANDSET. A second invocation reinstalled both APKs underneath a
# live instrumentation run; `devicectl` attaching to the app container killed an
# XCTest runner mid-session. Neither was a product fault and both looked like one.
# So: this script refuses to start rather than compete.
LOCK="${TMPDIR:-/tmp}/truepad-cross-edition.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another ceremony holds $LOCK — refusing to run two at once" >&2
  exit 2
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

for pattern in "xcodebuild" "devicectl" "am instrument" "XCTAgent"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "a '$pattern' process is already running — it would race this ceremony." >&2
    echo "stop it and retry; this script will not compete for the devices." >&2
    pgrep -fl "$pattern" | head -5 >&2
    exit 2
  fi
done

# ---------------------------------------------------------------- 0. preflight
ANDROID_SERIAL="${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')}"
[[ -n "$ANDROID_SERIAL" ]] || die "no Android device attached"
IOS_DEVICE_ID="${IOS_DEVICE_ID:-$(xcrun devicectl list devices 2>/dev/null \
  | awk '/available|connected/{print $3; exit}')}"
[[ -n "$IOS_DEVICE_ID" ]] || die "no paired iPhone"
[[ -n "${DEVELOPMENT_TEAM:-}" ]] || die "set DEVELOPMENT_TEAM (a Team ID does not belong in source control)"

adb() { command adb -s "$ANDROID_SERIAL" "$@"; }

{
  echo "run                 $stamp"
  echo "commit              $(git rev-parse HEAD)"
  echo "tree                $(git rev-parse HEAD^{tree})"
  echo "worktree            $(git status --porcelain | wc -l | tr -d ' ') paths differ from HEAD"
  echo "worktree-digest     $(git status --porcelain | shasum -a 256 | cut -d' ' -f1)"
  echo "android-serial      $ANDROID_SERIAL"
  echo "android-model       $(adb shell getprop ro.product.model | tr -d '\r')"
  echo "android-release     $(adb shell getprop ro.build.version.release | tr -d '\r')"
  echo "android-build       $(adb shell getprop ro.build.display.id | tr -d '\r')"
  echo "ios-device          $IOS_DEVICE_ID"
  echo "ios-model           $(xcrun devicectl device info details --device "$IOS_DEVICE_ID" 2>/dev/null \
                                | awk -F': *' '/marketingName|productType/{print $2; exit}')"
  echo "ios-os              $(xcrun devicectl device info details --device "$IOS_DEVICE_ID" 2>/dev/null \
                                | awk -F': *' '/osVersionNumber|osBuildUpdate/{print $2}' | paste -sd' ' -)"
  echo "xcode               $(xcodebuild -version | paste -sd' ' -)"
} | tee "$evid/environment.txt"
# REACHABLE, NOT MERELY LISTED. `adb devices` shows a handset that has gone to
# sleep; a shell round-trip proves it will actually answer.
adb shell true >/dev/null 2>&1 || die "the Android device is listed but not answering"
xcrun devicectl device info details --device "$IOS_DEVICE_ID" >/dev/null 2>&1 \
  || die "the iPhone is paired but not answering — unlock it and retry"
log "both devices answered; evidence -> $evid"

# ------------------------------------------------- 1. install ONCE, then never
log "building and installing the Android app and its instrumentation, once"
( cd android && ./gradlew --quiet :app:assembleDebug :app:assembleDebugAndroidTest ) \
  >"$evid/android-build.log" 2>&1 || { tail -30 "$evid/android-build.log"; die "Android build failed"; }
adb install -r -g android/app/build/outputs/apk/debug/app-debug.apk >>"$evid/run.log" 2>&1
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >>"$evid/run.log" 2>&1

# A KNOWN-CLEAN iPHONE, RECORDED AS EVIDENCE. Uninstalling removes the app's
# container outright: pads, receive requests, scratch and any share sheet left up
# by an earlier attempt. State accumulated across runs is otherwise indistinguishable
# from a product defect, which is the ambiguity this step exists to remove.
log "clearing iPhone application state (uninstalling $APP_ID)"
if xcrun devicectl device uninstall app --device "$IOS_DEVICE_ID" "$APP_ID" \
     >>"$evid/ios-clear.log" 2>&1; then
  IOS_CLEARED="uninstalled before the run (container removed)"
else
  IOS_CLEARED="not installed at start (nothing to remove)"
fi
log "iPhone state: $IOS_CLEARED"
echo "ios-state-cleared   $IOS_CLEARED" >> "$evid/environment.txt"

log "building the iOS app and its UI tests for the device"
( cd ios/TruePadApp && xcodebuild build-for-testing -scheme TruePadApp \
    -destination "platform=iOS,id=$IOS_DEVICE_ID" -derivedDataPath "$DD" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" ) >"$evid/ios-build.log" 2>&1 \
  || { tail -30 "$evid/ios-build.log"; die "iOS build failed"; }

# REINSTALL EXPLICITLY AFTER CLEARING, AND LET IT SETTLE.
# Uninstalling immediately before `test-without-building` left the runner unable
# to start at all — "never finished bootstrapping ... crashed while preparing to
# run tests", before any test body ran. Installing the freshly built app first,
# and giving the device a moment, removes that race.
settle_ios() {
  local app="$DD/Build/Products/Debug-iphoneos/TruePadApp.app"
  [[ -d "$app" ]] || return 0
  xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$app" \
    >>"$evid/ios-clear.log" 2>&1 || true
  sleep 6
}

# THE TWO-DEVICE OPT-IN. `xcodebuild` forwards a host variable named
# TEST_RUNNER_<X> into the test runner's environment as <X>, which is how every
# other input below reaches the device. The cross-edition classes SKIP themselves
# unless this says the harness is driving, so `xcodebuild test -scheme TruePadApp`
# on its own no longer reports three failures for tests that need a second phone.
export TEST_RUNNER_TRUEPAD_PHYSICAL_CEREMONY=1

# A SKIP IS NOT A PASS, and xcodebuild exits 0 for both.
#
# The two cross-edition classes now skip themselves unless
# TEST_RUNNER_TRUEPAD_PHYSICAL_CEREMONY says the harness is driving — which is
# right, and which means a mis-set variable would sail through here and be caught
# only indirectly, two minutes later, by a missing artifact. Checked directly.
assert_ios_ran() {  # assert_ios_ran <log> <what>
  grep -q "Test Case .* passed" "$1" \
    || { tail -30 "$1"; die "the iPhone $2 test did not run (skipped, or no test matched)"; }
  ! grep -q "Test Case .* skipped" "$1" \
    || { tail -30 "$1"; die "the iPhone $2 test SKIPPED — is TEST_RUNNER_TRUEPAD_PHYSICAL_CEREMONY set?"; }
}

ios_test() {  # ios_test <TestClass/method> <xcresult-name>
  ( cd ios/TruePadApp && xcodebuild test-without-building -scheme TruePadApp \
      -destination "platform=iOS,id=$IOS_DEVICE_ID" -derivedDataPath "$DD" \
      -resultBundlePath "$root/$evid/$2.xcresult" \
      -only-testing:"TruePadAppUITests/$1" )
}
# The exact bytes the device emitted. Attachments export under UUID file names,
# with the name the test gave them recorded in manifest.json — so the manifest is
# what maps one to the other, and matching on the file name finds nothing.
ATT_LOOKUP='
import json, sys
for entry in json.load(open(sys.argv[1])):
    for a in entry.get("attachments", []):
        if sys.argv[2] in a.get("suggestedHumanReadableName", ""):
            print(a["exportedFileName"]); raise SystemExit(0)
raise SystemExit(1)
'
attachment() {  # attachment <xcresult> <name> <out>
  local dir="$root/$evid/$1-attachments" found
  [[ -f "$dir/manifest.json" ]] || xcrun xcresulttool export attachments \
    --path "$root/$evid/$1.xcresult" --output-path "$dir" >/dev/null 2>&1 || true
  [[ -f "$dir/manifest.json" ]] || return 1
  found="$(python3 -c "$ATT_LOOKUP" "$dir/manifest.json" "$2")" || return 1
  [[ -n "$found" && -f "$dir/$found" ]] || return 1
  cp "$dir/$found" "$3"
}

# The app was just uninstalled; put the freshly built one back and let the device
# settle before any test tries to attach to it.
settle_ios

# ------------------------------------------------------- 2. the drop box, clean
#
# A CLEAN SLATE BEFORE THE INVOCATION, never during it. The exchange asks for a
# FRESH one-time receive code and a pad that arrived by sealed transfer; pads and
# outstanding codes left by an earlier attempt make both ambiguous. Clearing here
# does not touch the invariant — everything whose accumulated state is part of the
# proof happens after this line, inside a single `am instrument` run.
# THE HANDSET MUST STAY AWAKE. The Android half spends minutes idle at its
# checkpoints while the iPhone works, and this Samsung kills a backgrounded
# activity when the screen goes off — which presented as "Process crashed." with
# no Java stack anywhere, seventeen seconds after the receive code was published.
adb shell svc power stayon usb >/dev/null 2>&1 || true
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
adb shell "am force-stop $APP_ID" >/dev/null 2>&1 || true
adb shell "pm clear $APP_ID" >/dev/null 2>&1 || true
# EVERY COURIERED FILE, not just two of them. `awaitFile` accepts any file that
# is already there, so a leftover from an earlier or hand-driven run would be
# consumed as this run's evidence and reported as a pass.
adb shell "rm -f $DROP/transfer.tps2 $DROP/iphone-tp2.txt $DROP/iphone-json.txt" || true
# AND THE CLIPBOARD, WHICH IS ALSO A COURIER HERE. The reasoning above applies to
# it exactly: the ceremony carries a TPR2 receive code and two TP2 envelopes
# across the clipboard, and a leftover from an earlier run is a correctly
# prefixed, entirely stale value. `CrossEditionTest` now refuses any value that
# has not CHANGED since before its Copy click, so this is belt and braces rather
# than the only defence — but leaving a stale carrier in place while clearing
# the other three was an inconsistency, not a decision.
adb shell "am broadcast -a clipper.set -e text ''" >/dev/null 2>&1 || true
adb shell "service call clipboard 2" >/dev/null 2>&1 || true
adb logcat -c

# --------------------------- 3. ONE instrumentation invocation, in the background
log "starting the single Android instrumentation invocation"
( adb shell "am instrument -w -r \
    -e class $CLASS \
    -e drop $DROP -e waitSeconds 900 -e expect '$IOS_MSG' -e expectJson '$IOS_JSON_MSG' \
    $TEST_ID/$RUNNER" ) >"$evid/android-instrument.log" 2>&1 &
INSTR=$!
trap '[[ -n "${INSTR:-}" ]] && kill "$INSTR" 2>/dev/null; rmdir "$LOCK" 2>/dev/null || true' EXIT

courier_line() {  # courier_line <key> <timeout-seconds>
  local key="$1" deadline=$(( $(date +%s) + ${2:-300} )) line
  while (( $(date +%s) < deadline )); do
    line="$(adb logcat -d -s TP-COURIER 2>/dev/null | sed -n "s/.*TP-COURIER: *$key=//p" | tail -1)"
    [[ -n "$line" ]] && { printf '%s' "$line"; return 0; }
    kill -0 "$INSTR" 2>/dev/null || { log "the instrumentation exited early"; return 1; }
    sleep 3
  done
  return 1
}

# ------------------------------------------- 4. Android publishes the receive code
log "waiting for Android to publish a fresh one-time receive code"
TPR2="$(courier_line tpr2 300)" || { tail -20 "$evid/android-instrument.log"; die "no receive code was published"; }
printf '%s' "$TPR2" > "$evid/01-android-receive-code.txt"
[[ "$TPR2" == TPR2:* ]] || die "what Android published is not a receive request"
log "receive code published ($(wc -c <"$evid/01-android-receive-code.txt" | tr -d ' ') bytes)"

# ------------------------- 5. iPhone seals a fresh fixed-record pad to that code
log "iPhone: sealing a fresh 256-byte fixed-record pad to the Android code"
TEST_RUNNER_TPR2="$TPR2" \
  ios_test "CrossEditionSealTest/testSealAFixedRecordPadToTheAndroidReceiveCode" seal \
  >"$evid/ios-seal.log" 2>&1 \
  || { tail -30 "$evid/ios-seal.log"; die "the iPhone seal did not complete"; }
assert_ios_ran "$evid/ios-seal.log" "seal"

# COLLECTED AFTER THE SESSION ENDS, NOT DURING IT. Attaching to the app container
# with devicectl while the test was running killed the runner; the seal test
# therefore stops with the share sheet still up, leaving tmp/transfer.tps2 in
# place for exactly this copy.
log "collecting transfer.tps2 from the iPhone app container"
deadline=$(( $(date +%s) + 120 ))
while (( $(date +%s) < deadline )); do
  xcrun devicectl device copy from --device "$IOS_DEVICE_ID" \
      --domain-type appDataContainer --domain-identifier "$APP_ID" \
      --source tmp/transfer.tps2 --destination "$evid/02-transfer.tps2" \
      >>"$evid/devicectl.log" 2>&1 && [[ -s "$evid/02-transfer.tps2" ]] && break
  sleep 4
done
[[ -s "$evid/02-transfer.tps2" ]] || { tail -20 "$evid/devicectl.log"; die "the sealed package was never collected from the iPhone"; }
# `set -e` turns a failing command substitution into a silent abort — this step
# did exactly that once, ending the run with no explanation at all.
attachment seal pad-label "$evid/pad-label.txt" \
  || die "the seal run emitted no pad label, so the reply cannot address the right pad"
IOS_LABEL="$(tr -d '\n' < "$evid/pad-label.txt")"
[[ -n "$IOS_LABEL" ]] || die "the pad label came back empty"
SEAL_HASH="$(sha "$evid/02-transfer.tps2")"
log "sealed package collected: $SEAL_HASH ($(wc -c <"$evid/02-transfer.tps2" | tr -d ' ') bytes), pad '$IOS_LABEL'"

# ---------------------------------------------- 6. courier it, and prove the bytes
adb push "$evid/02-transfer.tps2" "$DROP/transfer.tps2" >>"$evid/run.log" 2>&1
adb shell chmod 644 "$DROP/transfer.tps2" || true
LANDED="$(adb shell "sha256sum $DROP/transfer.tps2" | awk '{print $1}' | tr -d '\r')"
[[ "$SEAL_HASH" == "$LANDED" ]] \
  || die "the sealed package changed in transit: $SEAL_HASH -> $LANDED"
log "carried intact: $LANDED"

# ------------------------------- 7. Android commits it and writes both spellings
log "waiting for Android to open, commit and derive its role"
ROLE="$(courier_line role 420)" || { tail -30 "$evid/android-instrument.log"; die "Android never committed the pad"; }
[[ "$ROLE" == "B" ]] || die "a received pad must make this device party B, not '$ROLE'"
log "Android committed the pad and derived role B"

ANDROID_TP2="$(courier_line android-tp2 420)"  || die "Android produced no compact envelope"
ANDROID_JSON="$(courier_line android-json 420)" || die "Android produced no canonical envelope"
printf '%s' "$ANDROID_TP2"  > "$evid/03-android-tp2.txt"
printf '%s' "$ANDROID_JSON" > "$evid/04-android-canonical.json"
A_TP2_HASH="$(sha "$evid/03-android-tp2.txt")"
log "Android messages captured: TP2 $A_TP2_HASH"

# ------------------- 8. iPhone opens both spellings and writes one back
log "iPhone: opening the Samsung's TP2 and canonical JSON, then replying"
TEST_RUNNER_PAD="$IOS_LABEL" \
TEST_RUNNER_ANDROID_TP2="$ANDROID_TP2" \
TEST_RUNNER_ANDROID_TP2_SHA="$A_TP2_HASH" \
TEST_RUNNER_ANDROID_JSON="$ANDROID_JSON" \
TEST_RUNNER_EXPECT_TP2="hello from the Samsung" \
TEST_RUNNER_EXPECT_JSON="the second one, in canonical form" \
TEST_RUNNER_MESSAGE="$IOS_MSG" \
TEST_RUNNER_JSON_MESSAGE="$IOS_JSON_MSG" \
  ios_test "CrossEditionMessageTest/testOpenBothSpellingsFromAndroidThenSendBack" message \
  >"$evid/ios-message.log" 2>&1 \
  || { tail -30 "$evid/ios-message.log"; die "the iPhone could not open what Android sent"; }
assert_ios_ran "$evid/ios-message.log" "message"
log "the iPhone opened both spellings from Android"

attachment message iphone-tp2 "$evid/05-iphone-tp2.txt" || die "the iPhone emitted no reply"
tr -d '\n' < "$evid/05-iphone-tp2.txt" > "$evid/05-iphone-tp2.trimmed" && mv "$evid/05-iphone-tp2.trimmed" "$evid/05-iphone-tp2.txt"
I_TP2_HASH="$(sha "$evid/05-iphone-tp2.txt")"

adb push "$evid/05-iphone-tp2.txt" "$DROP/iphone-tp2.txt" >>"$evid/run.log" 2>&1
I_LANDED="$(adb shell "sha256sum $DROP/iphone-tp2.txt" | awk '{print $1}' | tr -d '\r')"
[[ "$I_TP2_HASH" == "$I_LANDED" ]] \
  || die "the iPhone's reply changed in transit: $I_TP2_HASH -> $I_LANDED"
log "the reply carried intact: $I_LANDED"

# THE SECOND SPELLING, WHICH THE ANDROID HALF BLOCKS ON. The iOS test emits it
# (`emit("iphone-json", json)`) and this step never collected it, so step 4 of
# CrossEditionTest sat in `awaitFile("iphone-json.txt")` for the full 900-second
# budget and then failed — a quarter of an hour after the last thing either
# device actually did, with every other artifact already carried correctly.
attachment message iphone-json "$evid/06-iphone-json.json" || die "the iPhone emitted no canonical envelope"
tr -d '\n' < "$evid/06-iphone-json.json" > "$evid/06-iphone-json.trimmed" && mv "$evid/06-iphone-json.trimmed" "$evid/06-iphone-json.json"
I_JSON_HASH="$(sha "$evid/06-iphone-json.json")"
adb push "$evid/06-iphone-json.json" "$DROP/iphone-json.txt" >>"$evid/run.log" 2>&1
I_JSON_LANDED="$(adb shell "sha256sum $DROP/iphone-json.txt" | awk '{print $1}' | tr -d '\r')"
[[ "$I_JSON_HASH" == "$I_JSON_LANDED" ]] \
  || die "the iPhone's canonical envelope changed in transit: $I_JSON_HASH -> $I_JSON_LANDED"
log "the canonical envelope carried intact: $I_JSON_LANDED"
{
  echo "iphone-artifact-sha256     $SEAL_HASH   (produced on iPhone)"
  echo "android-received-sha256    $LANDED      (consumed on Android)"
  echo "android-tp2-sha256         $A_TP2_HASH  (produced on Android)"
  echo "iphone-received-sha256     $A_TP2_HASH  (asserted inside the iOS test)"
  echo "iphone-reply-sha256        $I_TP2_HASH  (produced on iPhone)"
  echo "android-received-reply     $I_LANDED    (consumed on Android)"
  echo "iphone-reply-json-sha256   $I_JSON_HASH (produced on iPhone)"
  echo "android-received-json      $I_JSON_LANDED (consumed on Android)"
} > "$evid/chain.txt"

# --------------------------------------- 9. Android opens it; the run must end OK
log "waiting for Android to open the iPhone's message and for the invocation to end"
wait "$INSTR" || true
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
grep -q "OK (1 test)" "$evid/android-instrument.log" \
  || { tail -40 "$evid/android-instrument.log"; die "the Android invocation did not end green"; }
# BOTH SPELLINGS. Nothing has ever emitted a bare `opened=` key — the Android
# half emits `opened-tp2=` and `opened-json=` — so this test could only ever
# compare an empty string to "ok" and die. Checking one of the two would also
# have let the canonical-JSON leg fail silently.
for key in opened-tp2 opened-json; do
  [[ "$(adb logcat -d -s TP-COURIER | sed -n "s/.*TP-COURIER: *$key=//p" | tail -1)" == "ok" ]] \
    || die "Android did not open the iPhone's message ($key) to what it sent"
done
adb logcat -d -s TP-COURIER > "$evid/android-courier.log"

# ------------------------------------------------------------- 10. the evidence
cat > "$evid/RESULT.md" <<EOF
# Physical cross-edition ceremony — PASS

    run              $stamp
    commit           $(git rev-parse HEAD)
    tree             $(git rev-parse HEAD^{tree})
    worktree         $(git status --porcelain | wc -l | tr -d ' ') paths differ from HEAD
    Android          $(adb shell getprop ro.product.model | tr -d '\r') / Android $(adb shell getprop ro.build.version.release | tr -d '\r') / $(adb shell getprop ro.build.display.id | tr -d '\r')
    iPhone           $IOS_DEVICE_ID
    iPhone state     $IOS_CLEARED

## The artifacts, and that each survived the carry

    iOS -> Android   transfer.tps2
                     made on iPhone   $SEAL_HASH
                     read on Android  $LANDED
    Android -> iOS   TP2 envelope     $A_TP2_HASH
    iOS -> Android   TP2 reply
                     made on iPhone   $I_TP2_HASH
                     read on Android  $I_LANDED

## What the devices did

    Android published a fresh one-time receive code
    iPhone sealed a fresh 256-byte fixed-record pad to it, twelve words compared in the UI
                        BY AUTOMATION — asserted by the harness, not spoken aloud by two people
    Android opened and committed it, and derived role B from how it arrived
    Android TP2         -> opened on iPhone
    Android canonical   -> opened on iPhone (a second message; a record is one-time)
    iPhone TP2          -> opened on Android

All Android steps ran in ONE instrumentation invocation; the app was installed
once, before it began, and never reinstalled during it.
EOF
adb shell svc power stayon false >/dev/null 2>&1 || true
log "PASS — $evid/RESULT.md"
