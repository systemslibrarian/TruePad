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
#   * every EXPECTED class must appear;
#   * the total must be at least MIN_TESTS;
#   * failures, errors and skips must all be zero.
#
# The expected-class list is maintained by hand ON PURPOSE. A class that silently
# stops running is exactly the failure this defends against, and a list derived
# from whatever happened to run could never notice.
#
#   usage: tools/verify-instrumentation.sh [results-dir]
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
results="${1:-$android/app/build/outputs/androidTest-results/connected}"

# Every instrumentation class that must run. Adding a class means adding it here.
EXPECTED_CLASSES="AccessibilityTest DeviceEngineTest HostileUriTest LargeFontTest ManifestHardeningTest UiJourneyTest"

# A floor, not an equality: adding tests is fine, losing them is not.
MIN_TESTS=44

if [[ ! -d "$results" ]]; then
  echo "no instrumentation results at $results — the suite did not run" >&2
  exit 1
fi

# shellcheck disable=SC2016
python3 - "$results" "$MIN_TESTS" $EXPECTED_CLASSES <<'PY'
import collections, glob, os, re, sys

results, min_tests = sys.argv[1], int(sys.argv[2])
expected = set(sys.argv[3:])

files = glob.glob(os.path.join(results, "**", "*.xml"), recursive=True)
if not files:
    print(f"no XML under {results} — the suite produced no results at all", file=sys.stderr)
    sys.exit(1)

per_class = collections.Counter()
failures = errors = skipped = 0
for path in files:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    for m in re.finditer(r'<testcase\b[^>]*\bclassname="([^"]+)"', text):
        per_class[m.group(1).rsplit(".", 1)[-1]] += 1
    failures += len(re.findall(r"<failure\b", text))
    errors += len(re.findall(r"<error\b", text))
    skipped += len(re.findall(r"<skipped\b", text))

total = sum(per_class.values())
problems = []

missing = sorted(expected - set(per_class))
if missing:
    problems.append("these classes did not run at all: " + ", ".join(missing))

if total < min_tests:
    problems.append(f"only {total} tests ran, expected at least {min_tests}")

if failures:
    problems.append(f"{failures} failing test(s)")
if errors:
    problems.append(f"{errors} erroring test(s)")
if skipped:
    problems.append(f"{skipped} skipped test(s) — a skipped security test is not a passing one")

for name in sorted(per_class):
    print(f"  {per_class[name]:3d}  {name}")
print(f"  ---  {total} tests, {failures} failures, {errors} errors, {skipped} skipped")

unexpected = sorted(set(per_class) - expected)
if unexpected:
    print("  note: classes not in the expected list ran too: " + ", ".join(unexpected))

if problems:
    print("\ninstrumentation verification FAILED:", file=sys.stderr)
    for p in problems:
        print("  - " + p, file=sys.stderr)
    sys.exit(1)

print(f"\ninstrumentation verified: {total} tests across {len(per_class)} classes, all passing")
PY
