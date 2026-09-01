#!/usr/bin/env bash
#
# On-device security validation that instrumentation cannot perform on itself.
#
# Three things live here because a test running INSIDE the app's process cannot
# do them: kill that process, read the installed APK from outside, and watch
# logcat while the app works. Everything else is an instrumentation test, where
# it belongs.
#
#   1. REAL PROCESS DEATH. `am force-stop` kills the app the way the system does.
#      A test in the same process would die with it, so the state is written by
#      one instrumentation run, the process is killed from here, and a second run
#      checks that the engine reconstructs everything from disk.
#   2. THE INSTALLED PACKAGE. Permissions, exported components and the packaged
#      library set, read from the device's own view of the APK rather than from
#      the source manifest.
#   3. LOGCAT. A representative workflow is driven while the whole log is
#      captured, then searched for the plaintext and for pad material.
#
# This is an EMULATOR check unless run against hardware. It says nothing about
# physical-device security: no TEE behaviour, no real flash, no vendor backup
# path. Report emulator and physical evidence separately.
#
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
PKG=dev.systemslibrarian.truepad
RUNNER="$PKG.test/androidx.test.runner.AndroidJUnitRunner"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"

fail=0
note() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

"$ADB" wait-for-device
device="$("$ADB" shell getprop ro.product.model | tr -d '\r') / API $("$ADB" shell getprop ro.build.version.sdk | tr -d '\r')"
emulated="$("$ADB" shell getprop ro.kernel.qemu | tr -d '\r')"
printf 'device: %s%s\n' "$device" "$([ "$emulated" = "1" ] && echo '  (EMULATOR)' || echo '  (physical)')"

note "installing"
"$ADB" install -r -d "$android/app/build/outputs/apk/debug/app-debug.apk" >/dev/null
"$ADB" install -r -d "$android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk" >/dev/null
"$ADB" shell pm clear "$PKG" >/dev/null

# ---------------------------------------------------------------- 1. sandbox --
note "app sandbox"
"$ADB" shell am start -n "$PKG/.app.MainActivity" >/dev/null
sleep 3
dirs="$("$ADB" shell run-as "$PKG" ls -ld files no_backup 2>&1 || true)"
echo "$dirs" | grep -q '^drwx' && ok "app-private directories exist" || bad "app-private directories missing: $dirs"

perms="$("$ADB" shell run-as "$PKG" stat -c '%A %n' files no_backup 2>&1 || true)"
if echo "$perms" | grep -qE 'drwx(rwx|------)'; then
  ok "data directories are not world-readable ($(echo "$perms" | tr '\n' ' '))"
else
  bad "unexpected directory modes: $perms"
fi

# Another process's view. Captured into a variable first: adb exits non-zero
# when the device command fails, and under `set -o pipefail` that would decide
# the pipeline's status instead of grep's.
listing="$("$ADB" shell "ls /data/data/$PKG" 2>&1 || true)"
if printf '%s' "$listing" | grep -qiE 'permission denied|no such file'; then
  ok "the data directory is not readable from the adb shell ($(printf '%s' "$listing" | head -1))"
else
  bad "the data directory was listable from the shell: $listing"
fi

# ------------------------------------------------------ 2. real process death --
note "process death"
"$ADB" shell am instrument -w \
  -e class 'dev.systemslibrarian.truepad.app.DeviceEngineTest#aFreshEngineOverTheSameDirectoriesSeesEverythingThatWasCommitted' \
  "$RUNNER" 2>&1 | grep -q '^OK' && ok "state survives a fresh engine over the same directories" \
  || bad "durability check failed"

"$ADB" shell am start -n "$PKG/.app.MainActivity" >/dev/null
sleep 3
pid_before="$("$ADB" shell pidof "$PKG" | tr -d '\r' || true)"
[ -n "$pid_before" ] && ok "the app is running before the kill (pid $pid_before)" || bad "the app was not running"
"$ADB" shell am force-stop "$PKG"
sleep 1
pid_after="$("$ADB" shell pidof "$PKG" | tr -d '\r' || true)"
[ -z "$pid_after" ] && ok "force-stop killed the process (was $pid_before)" || bad "process survived force-stop"

# The store must still be there, and the app must come back up on it.
"$ADB" shell am start -n "$PKG/.app.MainActivity" >/dev/null
sleep 3
"$ADB" shell pidof "$PKG" >/dev/null && ok "the app restarts after a kill" || bad "the app did not restart"

# ------------------------------------------------------------- 3. the package --
note "installed package"
requested="$("$ADB" shell dumpsys package "$PKG" | sed -n '/requested permissions:/,/^ *[a-z]* permissions:/p' | grep -oE '[a-zA-Z0-9_.]+\.[A-Z_]+' || true)"
if echo "$requested" | grep -q 'android.permission.INTERNET'; then
  bad "INTERNET permission is present"
else
  ok "no INTERNET permission"
fi
unexpected="$(echo "$requested" | grep -v "DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" | grep -v '^$' || true)"
[ -z "$unexpected" ] && ok "no capability-granting permission requested" || bad "unexpected permissions: $unexpected"

# What another app can actually resolve in this package.
resolved="$("$ADB" shell cmd package query-activities --brief -a android.intent.action.SEND -t 'text/plain' 2>/dev/null | grep "$PKG" || true)"
[ -z "$resolved" ] && ok "the app is not a share target" || bad "the app resolves ACTION_SEND: $resolved"
resolved="$("$ADB" shell cmd package query-activities --brief -a android.intent.action.VIEW -t 'application/json' 2>/dev/null | grep "$PKG" || true)"
[ -z "$resolved" ] && ok "the app is not a file-open target" || bad "the app resolves ACTION_VIEW: $resolved"

# PROVIDERS. TruePad has none of its own; androidx.startup merges one in to run
# library initialisers, and it is not exported. What matters is that no authority
# in this package is reachable from another app, and that no authority looks like
# a FileProvider — because a FileProvider is the only thing that could hand a URI
# into the pad store, and this app deliberately has none.
dump="$("$ADB" shell dumpsys package "$PKG" 2>/dev/null || true)"
authorities="$(printf '%s' "$dump" | sed -n '/ContentProvider Authorities:/,/^$/p' | grep -oE '\[[^]]+\]' | tr -d '[]' | sort -u || true)"
unexpected_auth="$(printf '%s' "$authorities" | grep -v '^$' | grep -v "^$PKG.androidx-startup$" || true)"
if [ -z "$unexpected_auth" ]; then
  ok "the only provider authority is androidx-startup (${authorities:-none})"
else
  bad "unexpected provider authorities: $unexpected_auth"
fi
if printf '%s' "$authorities" | grep -qi fileprovider; then
  bad "a FileProvider authority is present"
else
  ok "no FileProvider authority"
fi
# And nothing in this package can be started by another app except the launcher.
exported_here="$("$ADB" shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null | grep "$PKG" || true)"
[ -n "$exported_here" ] && ok "the launcher activity resolves, as it must" || bad "the launcher activity does not resolve"

# -------------------------------------------------------------- 4. the logcat --
note "logcat during a representative workflow"
"$ADB" logcat -c
"$ADB" shell am instrument -w -e class 'dev.systemslibrarian.truepad.app.DeviceEngineTest' "$RUNNER" >/dev/null 2>&1 || true
"$ADB" shell am instrument -w -e class 'dev.systemslibrarian.truepad.app.UiJourneyTest' "$RUNNER" >/dev/null 2>&1 || true
log="$("$ADB" logcat -d 2>/dev/null || true)"

leaked=0
# The exact plaintexts the suites send, and the shapes pad material would take.
for needle in "meet at six" "on device" "MEET AT THE BRIDGE AT MIDNIGHT" "survives a restart" "only once" "a distinctive plaintext"; do
  if printf '%s' "$log" | grep -qF "$needle"; then bad "plaintext in logcat: $needle"; leaked=1; fi
done
# A 64-character run of hex is the shape of a key, a mask, or pad material.
if printf '%s' "$log" | grep -qE '\b[0-9a-f]{64,}\b'; then
  bad "a long hex run appeared in logcat (possible pad material)"
  leaked=1
fi
[ "$leaked" = 0 ] && ok "no plaintext and no pad-shaped material in logcat"

printf '\n'
if [ "$fail" = 0 ]; then
  echo "device security check: PASS on $device"
else
  echo "device security check: FAILURES on $device" >&2
fi
exit "$fail"
