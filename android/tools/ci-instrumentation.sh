#!/usr/bin/env bash
#
# The on-device gate, as one command.
#
# This is what the CI emulator job runs once the device is up, and it is exactly
# what a developer should run locally against a booted emulator or a handset. One
# script rather than a list of YAML steps, so the gate is reviewable, testable,
# and the same in both places.
#
#   1. assert a device is actually attached and responsive;
#   2. run the instrumentation suite;
#   3. VERIFY it ran — a task that discovered nothing also exits 0;
#   4. run the on-device security checks.
#
# Step 3 is the point. Steps 1, 2 and 4 can all be green over an empty run.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$ANDROID_HOME/platform-tools/adb"

echo "=== device ==="
[[ -x "$ADB" ]] || { echo "adb not found at $ADB" >&2; exit 1; }

attached="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')"
if [[ -z "$attached" ]]; then
  echo "no authorised device attached — refusing to report a green gate over nothing" >&2
  "$ADB" devices -l >&2 || true
  exit 1
fi

# `adb devices` can list a device that is not yet answering. Ask it something.
if ! boot="$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" || [[ "$boot" != "1" ]]; then
  echo "the device is listed but has not finished booting (sys.boot_completed='${boot:-}')" >&2
  exit 1
fi

printf 'target: %s / API %s / %s\n' \
  "$("$ADB" shell getprop ro.product.model | tr -d '\r')" \
  "$("$ADB" shell getprop ro.build.version.sdk | tr -d '\r')" \
  "$("$ADB" shell getprop ro.build.type | tr -d '\r')"

echo
echo "=== instrumentation ==="
# Results from an earlier run must not be able to satisfy this one.
rm -rf "$android/app/build/outputs/androidTest-results/connected"

gradle_status=0
( cd "$android" && ./gradlew :app:connectedDebugAndroidTest --console=plain --stacktrace ) || gradle_status=$?

echo
echo "=== verifying the suite actually ran ==="
# Run this WHATEVER gradle said. A gradle failure is already red; what this adds
# is catching a gradle SUCCESS that tested nothing.
verify_status=0
"$here/verify-instrumentation.sh" || verify_status=$?

if (( gradle_status != 0 )); then
  echo "connectedDebugAndroidTest failed (exit $gradle_status)" >&2
  exit "$gradle_status"
fi
if (( verify_status != 0 )); then
  exit "$verify_status"
fi

echo
echo "=== on-device security checks ==="
"$here/device-security-check.sh"

echo
echo "on-device gate: PASS"
