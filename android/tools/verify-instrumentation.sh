#!/usr/bin/env bash
#
# Prove the instrumentation suite ACTUALLY RAN.
#
# A connected-test task that discovers nothing exits 0. So does one whose APK
# never installed, whose emulator was not really up, or whose test filter matched
# no class. Every one of those is a green tick over an empty run, and the whole
# point of putting instrumentation in CI is lost if the job cannot tell them
# apart from success.
#
# This reads the JUnit XML the run produced and refuses anything that is not a
# complete, passing suite:
#
#   * the results directory must exist and contain XML;
#   * every EXPECTED class must appear, with AT LEAST its expected count;
#   * failures, errors and skips must all be zero.
#
# The table is maintained by hand ON PURPOSE, and it is PER CLASS on purpose too.
# A list derived from whatever happened to run could never notice a class going
# missing — the check would rewrite its own expectation to match the loss. So
# would a list derived from the SOURCE TREE, which is why that is not done either:
# deleting a test file would delete the expectation along with it.
#
# WHY PER-CLASS RATHER THAN ONE TOTAL. It used to be a single floor of 44 while
# the suite was 51. That number was the sum of the six classes listed at the time,
# and two classes were added afterwards without either line being touched — so
# BOTH new classes (ScannerOfflineTest and SptDeviceTest, 7 tests between them)
# could have stopped running entirely and the total would still have cleared the
# floor. A single total lets a whole class hide behind growth elsewhere; a
# per-class expectation cannot.
#
#   usage: tools/verify-instrumentation.sh [results-dir]
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
results="${1:-$android/app/build/outputs/androidTest-results/connected}"

# EVERY instrumentation class that must run, and how many tests each must
# contribute. Adding a class means adding a line; adding tests to a class means
# raising its number. Each is a FLOOR, not an equality — growth is fine, loss is
# not — and the suite total is their sum, so the two can never disagree.
EXPECTED="\
AccessibilityTest=8
DeviceEngineTest=7
FixedRecordSmokeTest=1
NavigationSmokeTest=3
HostileUriTest=7
LargeFontTest=3
ManifestHardeningTest=7
ScannerOfflineTest=5
SptDeviceTest=2
UiJourneyTest=12"

if [[ ! -d "$results" ]]; then
  echo "no instrumentation results at $results — the suite did not run" >&2
  exit 1
fi

# shellcheck disable=SC2016
python3 - "$results" "$EXPECTED" <<'PY'
import collections, glob, os, re, sys

results = sys.argv[1]
expected = dict((k, int(v)) for k, v in
                (line.split("=") for line in sys.argv[2].split() if line))

files = glob.glob(os.path.join(results, "**", "*.xml"), recursive=True)
if not files:
    print(f"no XML under {results} — the suite produced no results at all", file=sys.stderr)
    sys.exit(1)

per_class = collections.Counter()
failures = errors = skipped = 0
failure_text = []
for path in files:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    for m in re.finditer(r'<testcase\b[^>]*\bclassname="([^"]+)"', text):
        per_class[m.group(1).rsplit(".", 1)[-1]] += 1
    failures += len(re.findall(r"<failure\b", text))
    errors += len(re.findall(r"<error\b", text))
    skipped += len(re.findall(r"<skipped\b", text))
    # ONE ENTRY PER FAILURE. Collecting the message attribute AND the element
    # body counted each failure twice, so the "most of them" test below fired at
    # roughly a quarter. The body carries the stack; the attribute carries the
    # same first line, so the body alone is enough and is never absent.
    failure_text.extend(re.findall(r"<(?:failure|error)\b[^>]*>(.{0,400})", text, re.S))

# A SLEEPING HANDSET IS NOT A BROKEN PRODUCT, and this could not tell them apart.
#
# This Samsung stops the activity when the screen goes off, so a suite started
# against a dozing phone reports EVERY UI test as a failure — 27 of 55 in one
# run, with "No compose hierarchies found in the app" and "Activity never becomes
# requested state [RESUMED]" as the messages and an empty crash buffer. That reads
# exactly like a product that no longer launches, and it cost a full cycle to
# tell apart. The cross-edition harness already knows to run
# `adb shell svc power stayon usb` and `input keyevent KEYCODE_WAKEUP` first; the
# plain `connectedDebugAndroidTest` path has no such preflight.
#
# A gate that reports a false RED is not harmless. It is how people learn to
# discount the gate. This still FAILS — the suite genuinely did not run — but it
# says which of the two it is looking at.
ASLEEP = ("No compose hierarchies found",
          'never becomes requested state "[RESUMED]"',
          "Activity never becomes requested state")
asleep_hits = sum(1 for t in failure_text if any(sig in t for sig in ASLEEP))

total = sum(per_class.values())
problems = []

for name in sorted(expected):
    ran = per_class.get(name, 0)
    if ran == 0:
        problems.append(f"{name} did not run at all — expected {expected[name]} tests")
    elif ran < expected[name]:
        problems.append(f"{name} ran {ran} tests, expected at least {expected[name]}")

# NO TOTAL-COUNT BACKSTOP HERE, DELIBERATELY.
#
# There used to be `if total < min_tests` with min_tests = sum(expected.values()),
# described as catching "an EXPECTED table that has itself been gutted". It could
# do neither thing. It could not fire independently: if the per-class loop above
# found nothing wrong then per_class[name] >= expected[name] for every name, so
# total >= sum(expected) = min_tests and the condition is false exactly when it
# would have mattered. And it could not catch a gutted table, because deleting a
# row lowers min_tests by the same amount it lowers the expectation — the check
# moves with the thing it is supposed to be checking.
#
# A table gutted on purpose is caught OUTSIDE this script, by
# tests/stated-counts.test.ts, which holds this table against the classes that
# actually exist in the tree. That check works precisely because it reads a
# different source of truth. This one could not.

if failures:
    problems.append(f"{failures} failing test(s)")
if errors:
    problems.append(f"{errors} erroring test(s)")
if skipped:
    problems.append(f"{skipped} skipped test(s) — a skipped security test is not a passing one")

for name in sorted(per_class):
    print(f"  {per_class[name]:3d}  {name}")
print(f"  ---  {total} tests, {failures} failures, {errors} errors, {skipped} skipped")

unexpected = sorted(set(per_class) - set(expected))
if unexpected:
    # NOT a failure, but it must be loud: a class running without an entry is a
    # class nobody will notice the loss of later.
    print("  note: these classes ran but have NO expected count, so their loss "
          "would go unnoticed — add them to EXPECTED: " + ", ".join(unexpected))

if problems:
    print("\ninstrumentation verification FAILED:", file=sys.stderr)
    for p in problems:
        print("  - " + p, file=sys.stderr)
    # A MAJORITY, counted once each. And it says "most" only when it means it.
    if failures and asleep_hits * 2 > failures:
        print("\n  THE HANDSET WAS PROBABLY ASLEEP, not broken: most failures say the\n"
              "  activity never resumed or that no compose hierarchy was found, which is\n"
              "  what a screen-off device looks like from here. Wake it and re-run:\n"
              "      adb shell svc power stayon usb\n"
              "      adb shell input keyevent KEYCODE_WAKEUP\n"
              "      adb shell wm dismiss-keyguard\n"
              "  This is still a FAILURE — the suite did not run — but it is not evidence\n"
              "  about the product.", file=sys.stderr)
    sys.exit(1)

print(f"\ninstrumentation verified: {total} tests across {len(per_class)} classes, all passing")
PY
