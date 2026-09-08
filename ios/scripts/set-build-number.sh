#!/usr/bin/env bash
#
# Set CURRENT_PROJECT_VERSION everywhere it appears, in one operation.
#
# WHY A SCRIPT. The value lives in FOUR build configurations — the app's Debug and
# Release, and the UI-test target's Debug and Release. Editing it by hand means
# editing it four times and getting it right four times, and the failure mode is
# an archive whose build number disagrees with itself. `tests/release-state.test.ts`
# already asserts all four agree; this is how they are kept agreeing.
#
# App Store Connect requires the build number to increase monotonically for a
# given marketing version. It does NOT have to equal anything else, and it is not
# a release number: bumping it is a TestFlight upload, not a GitHub release.
#
# Usage:  ios/scripts/set-build-number.sh <positive integer>
#         ios/scripts/set-build-number.sh --show
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PBX="$HERE/../TruePadApp/TruePadApp.xcodeproj/project.pbxproj"

current() { grep -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBX" | grep -oE '[0-9]+' | LC_ALL=C sort -u; }

if [ "${1:-}" = "--show" ] || [ $# -eq 0 ]; then
    vals="$(current)"
    n="$(printf '%s\n' "$vals" | grep -c . || true)"
    if [ "$n" -ne 1 ]; then
        echo "INCONSISTENT: the project declares more than one build number:" >&2
        printf '  %s\n' $vals >&2
        exit 1
    fi
    echo "$vals"
    exit 0
fi

NEW="$1"
printf '%s' "$NEW" | grep -qE '^[0-9]+$' || { echo "build number must be a positive integer" >&2; exit 2; }
[ "$NEW" -ge 1 ] || { echo "build number must be >= 1" >&2; exit 2; }

OLD="$(current | head -1)"
if [ "$NEW" -le "$OLD" ]; then
    # Refused rather than warned: a build number that goes backward is rejected by
    # App Store Connect, and finding that out at upload time is the expensive way.
    echo "refusing to set $NEW: it is not greater than the current $OLD" >&2
    exit 1
fi

/usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION = ${OLD};/CURRENT_PROJECT_VERSION = ${NEW};/g" "$PBX"
echo "build number $OLD -> $NEW in $(grep -c "CURRENT_PROJECT_VERSION = ${NEW};" "$PBX") configurations"
echo "remember: tests/release-state.test.ts pins this value deliberately — update it in the same commit."
