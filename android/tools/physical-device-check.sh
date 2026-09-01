#!/usr/bin/env bash
#
# THE PHYSICAL-HANDSET GATE.
#
# Everything else in this repository can be proved on an emulator. This cannot:
# an emulator has no real flash translation layer, no vendor backup
# implementation, and a TEE only in the sense that it is simulated. So this
# script REFUSES TO RUN against one. That refusal is the feature — a physical
# gate that quietly accepts an emulator is worse than no gate, because it
# produces evidence that reads as hardware validation and is not.
#
#   usage:  android/tools/physical-device-check.sh [-s <serial>]
#
# Connect ONE authorised handset with USB debugging on, then run it. It installs
# a fresh debug build, wipes the app's data, and runs the full on-device gate
# plus the checks that only mean something on real hardware.
#
# WHAT IT DOES NOT PROVE, and will not print:
#   * that flash forgot anything. Destruction unlinks a reference; the bytes are
#     the flash controller's business and no software can see them. §17 of
#     FORMAT-V2 says exactly this and it is not softened here.
#   * that a TEE or StrongBox protects pad material. TruePad does NOT use the
#     Keystore for pad material (docs/ANDROID-SECURITY.md §5). This script
#     records whether the hardware HAS one purely as device provenance, and that
#     record is not a security claim.
#   * that the vendor's backup implementation honours what the manifest asks.
#     It observes the configuration the platform reports; whether a particular
#     OEM cloud path respects it is outside what a handset can show.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$ANDROID_HOME/platform-tools/adb"
PKG=dev.systemslibrarian.truepad

serial=""
[[ "${1:-}" == "-s" ]] && { serial="${2:-}"; shift 2; }
adb() { if [[ -n "$serial" ]]; then "$ADB" -s "$serial" "$@"; else "$ADB" "$@"; fi; }

fail=0; checks=0; notes=0
note() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; checks=$((checks+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; checks=$((checks+1)); }
info() { printf '  INFO  %s\n' "$1"; notes=$((notes+1)); }

[[ -x "$ADB" ]] || { echo "adb not found at $ADB" >&2; exit 1; }

# ------------------------------------------------------------- the refusal ---
# Portable to bash 3.2, which is what macOS ships — no mapfile, no readarray.
attached=""
count=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  attached="$attached $line"
  count=$((count + 1))
done <<EOF
$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
EOF
if (( count == 0 )); then
  echo "no authorised device attached." >&2
  echo "Connect a handset, enable USB debugging, accept the RSA prompt, then re-run." >&2
  adb devices -l >&2 || true
  exit 1
fi
if (( count > 1 )) && [[ -z "$serial" ]]; then
  echo "more than one device attached; choose one with -s <serial>:" >&2
  adb devices -l >&2
  exit 1
fi

model="$(adb shell getprop ro.product.model | tr -d '\r')"
brand="$(adb shell getprop ro.product.brand | tr -d '\r')"
manufacturer="$(adb shell getprop ro.product.manufacturer | tr -d '\r')"
release="$(adb shell getprop ro.build.version.release | tr -d '\r')"
api="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
build_type="$(adb shell getprop ro.build.type | tr -d '\r')"
hardware="$(adb shell getprop ro.hardware | tr -d '\r')"
qemu="$(adb shell getprop ro.kernel.qemu | tr -d '\r')"
fingerprint="$(adb shell getprop ro.build.fingerprint | tr -d '\r')"

# Every way an emulator gives itself away. Any one of them is disqualifying.
emulator_reasons=""
add_reason() { emulator_reasons="$emulator_reasons  $1
"; }
[[ "$qemu" == "1" ]]                 && add_reason "ro.kernel.qemu=1"
[[ "$hardware" == ranchu*   ]]       && add_reason "ro.hardware=$hardware"
[[ "$hardware" == goldfish* ]]       && add_reason "ro.hardware=$hardware"
[[ "$model" == sdk_* ]]              && add_reason "model=$model"
[[ "$model" == *Emulator*  ]]        && add_reason "model=$model"
[[ "$brand" == generic* ]]           && add_reason "brand=$brand"
[[ "$fingerprint" == *generic* ]]    && add_reason "fingerprint contains 'generic'"
[[ "$fingerprint" == *sdk_gphone* ]] && add_reason "fingerprint contains 'sdk_gphone'"

if [[ -n "$emulator_reasons" ]]; then
  echo "REFUSING: this target is an emulator, not physical hardware." >&2
  printf '%s' "$emulator_reasons" >&2
  echo >&2
  echo "Emulator coverage already exists and runs in CI:" >&2
  echo "    android/tools/ci-instrumentation.sh" >&2
  echo "This script exists only to produce PHYSICAL-DEVICE evidence, so it will" >&2
  echo "not run here. Accepting an emulator would manufacture exactly the" >&2
  echo "evidence it is supposed to gather." >&2
  exit 2
fi

printf 'PHYSICAL DEVICE\n'
printf '  manufacturer : %s\n' "$manufacturer"
printf '  brand        : %s\n' "$brand"
printf '  model        : %s\n' "$model"
printf '  Android      : %s (API %s)\n' "$release" "$api"
printf '  build type   : %s\n' "$build_type"
printf '  fingerprint  : %s\n' "$fingerprint"

# ------------------------------------------------------------ provenance -----
note "hardware provenance (recorded, NOT a security claim)"
km="$(adb shell 'cmd android.security.keystore listEntries 2>/dev/null | head -1' 2>/dev/null | tr -d '\r' || true)"
strongbox="$(adb shell pm list features 2>/dev/null | grep -c 'android.hardware.strongbox_keystore' || true)"
hw_keystore="$(adb shell pm list features 2>/dev/null | grep -c 'android.hardware.hardware_keystore' || true)"
info "StrongBox feature present: $([ "${strongbox:-0}" != "0" ] && echo yes || echo no)"
info "hardware_keystore feature present: $([ "${hw_keystore:-0}" != "0" ] && echo yes || echo no)"
info "TruePad does NOT use the Keystore for pad material, so neither line above is a TruePad claim (docs/ANDROID-SECURITY.md §5)"
[[ -n "$km" ]] && true

# --------------------------------------------------- the full on-device gate --
note "instrumentation suite and on-device security checks"
if [[ -n "$serial" ]]; then export ANDROID_SERIAL="$serial"; fi
if "$here/ci-instrumentation.sh"; then
  ok "the full on-device gate passed on physical hardware"
else
  bad "the on-device gate failed on physical hardware"
fi

# --------------------------------------------------- physical-only observations
note "storage mapping, as the device reports it"
store="$(adb shell run-as "$PKG" sh -c 'cd files/truepad 2>/dev/null && pwd' 2>&1 | tr -d '\r' || true)"
witness="$(adb shell run-as "$PKG" sh -c 'cd no_backup/truepad 2>/dev/null && pwd' 2>&1 | tr -d '\r' || true)"
if [[ "$store" == */files/truepad ]]; then ok "store path: $store"; else bad "unexpected store path: ${store:-<none>}"; fi
if [[ "$witness" == */no_backup/truepad ]]; then ok "witness path: $witness"; else bad "unexpected witness path: ${witness:-<none>}"; fi
if [[ "$store" != "$witness" ]]; then
  ok "store and witness are different trees, which is what makes a rollback detectable"
else
  bad "store and witness resolved to the same tree"
fi

note "backup configuration, as the platform reports it"
bmgr="$(adb shell bmgr enabled 2>&1 | tr -d '\r' || true)"
info "device backup manager: ${bmgr:-unknown}"
flags="$(adb shell dumpsys package "$PKG" 2>/dev/null | grep -oE 'flags=\[[^]]*\]' | head -1 || true)"
if printf '%s' "$flags" | grep -q 'ALLOW_BACKUP'; then
  bad "the installed package still carries ALLOW_BACKUP: $flags"
else
  ok "the installed package does not carry ALLOW_BACKUP"
fi
# An `adb backup` of an allowBackup=false app must produce nothing usable. The
# command is deprecated and removed on some builds, so a missing command is
# reported rather than treated as a pass.
tmp_ab="$(mktemp)"
if adb backup -f "$tmp_ab" "$PKG" >/dev/null 2>&1; then
  size=$(wc -c < "$tmp_ab" | tr -d ' ')
  if (( size <= 1024 )); then
    ok "adb backup produced nothing usable ($size bytes)"
  else
    bad "adb backup produced $size bytes for an allowBackup=false app — inspect it"
  fi
else
  info "adb backup is unavailable on this build; the ALLOW_BACKUP flag check above stands alone"
fi
rm -f "$tmp_ab"

note "screen capture, on real hardware"
adb shell am start -n "$PKG/.app.MainActivity" >/dev/null 2>&1
sleep 3
shot="$(mktemp).png"
if adb exec-out screencap -p > "$shot" 2>/dev/null && [[ -s "$shot" ]]; then
  # FLAG_SECURE blanks the captured surface. A screenshot of a secure window is
  # a uniform frame, so an almost-zero unique-colour count is the signature.
  colours="$(python3 - "$shot" <<'PY' 2>/dev/null || echo unknown
import sys, zlib, struct
# Count distinct 4-byte pixels without a PNG library: parse IDAT and unfilter.
try:
    data = open(sys.argv[1], 'rb').read()
    pos, idat, w, h, bpp = 8, b'', 0, 0, 4
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]; typ = data[pos+4:pos+8]
        if typ == b'IHDR':
            w, h = struct.unpack('>II', data[pos+8:pos+16])
        elif typ == b'IDAT':
            idat += data[pos+8:pos+8+ln]
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    out, prev = set(), bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i+stride]); i += stride
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0
            b = prev[x]; c = prev[x-bpp] if x >= bpp else 0
            if   f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a+b)//2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        for x in range(0, stride, bpp):
            out.add(bytes(line[x:x+bpp]))
        prev = line
    print(len(out))
except Exception:
    print('unknown')
PY
)"
  if [[ "$colours" == "unknown" ]]; then
    info "screenshot captured but could not be analysed; inspect $shot by hand"
  elif (( colours <= 4 )); then
    ok "a screenshot of the app is blank ($colours distinct pixel values) — FLAG_SECURE is honoured"
  else
    bad "a screenshot of the app has $colours distinct pixel values; FLAG_SECURE may not be honoured on this device"
  fi
else
  info "screencap unavailable; FLAG_SECURE is still asserted on the window by the instrumentation suite"
fi
rm -f "$shot"

note "clipboard"
info "clipboard contents are not readable from adb on modern Android by design, so this is not asserted here; the app marks copies sensitive on API 33+ and says plainly that other apps can read the clipboard"

# ------------------------------------------------------------------ verdict ---
printf '\n'
MIN_CHECKS=8
if (( checks < MIN_CHECKS )); then
  echo "only $checks checks ran, expected at least $MIN_CHECKS — this script tested almost nothing" >&2
  exit 1
fi
if (( fail == 0 )); then
  echo "PHYSICAL DEVICE CHECK: PASS on $manufacturer $model / Android $release (API $api)"
  echo "  $checks checks, $notes recorded observations"
  echo "  This is physical-hardware evidence for everything above. It remains true that"
  echo "  software cannot prove flash erasure, and TruePad still makes no Keystore claim."
else
  echo "PHYSICAL DEVICE CHECK: FAILURES on $manufacturer $model / Android $release (API $api)" >&2
fi
exit "$fail"
