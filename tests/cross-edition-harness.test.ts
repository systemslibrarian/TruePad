import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * The physical harness must be able to pass
 * ----------------------------------------------------------------------------
 * `scripts/cross-edition-physical.sh` drives two handsets through one ceremony.
 * It is not run by CI — it needs a Samsung and an iPhone on the desk — so nothing
 * noticed when it stopped being able to succeed. Two ways it had, and both were
 * silent until someone spent fifteen minutes finding out:
 *
 *   1. The Android half blocks on `awaitFile("iphone-json.txt")` for its whole
 *      900-second budget and then fails. The iOS half emits the artifact and the
 *      script never collected it. The file mtimes say why: the script was last
 *      edited an hour BEFORE both test halves gained the canonical-JSON leg.
 *
 *   2. The final check grepped the courier log for `opened=`, which nothing has
 *      ever emitted — the Android half emits `opened-tp2=` and `opened-json=` —
 *      so the comparison was "" == "ok" and the run died at the last line.
 *
 * Both failed CLOSED, which is the right direction and is why this is evidence
 * machinery rather than a leak. This file holds the three sides against each
 * other so the next divergence is a red test rather than a wasted ceremony.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const script = read("scripts/cross-edition-physical.sh");
const androidTest = read(
  "android/app/src/androidTest/kotlin/dev/systemslibrarian/truepad/app/CrossEditionTest.kt"
);
const iosMessage = read("ios/TruePadApp/TruePadAppUITests/CrossEditionMessageTest.swift");

/** Every file the Android half waits for a courier to deliver. */
function awaitedFiles(): string[] {
  return [...androidTest.matchAll(/awaitFile\("([^"]+)"\)/g)].map((m) => m[1]);
}

/** Every `TP-COURIER` key the Android half actually emits. */
function emittedKeys(): string[] {
  return [...androidTest.matchAll(/\bout\("([^"]+)"/g)].map((m) => m[1]);
}

/** Every `TP-COURIER` key the script greps the log for. */
function grepedKeys(): string[] {
  return [
    ...script.matchAll(/TP-COURIER: \*([a-z0-9-]+)=/g),
    ...script.matchAll(/courier_line\s+([a-z0-9-]+)\b/g),
    ...script.matchAll(/for key in ([a-z0-9 -]+); do/g)
  ].flatMap((m) => m[1].trim().split(/\s+/));
}

describe("the two-device harness and the tests it drives agree", () => {
  it("found all three sides", () => {
    // POSITIVE CONTROL. Every assertion below is satisfied by an empty list.
    expect(script.length).toBeGreaterThan(4000);
    expect(awaitedFiles().length).toBeGreaterThanOrEqual(3);
    expect(emittedKeys().length).toBeGreaterThanOrEqual(3);
    expect(iosMessage).toContain("emit(");
  });

  it("delivers every file the Android half blocks on", () => {
    for (const file of awaitedFiles()) {
      expect(script, `nothing pushes ${file}, so the Android half waits for it and then fails`)
        .toContain(`"$DROP/${file}"`);
    }
  });

  it("clears every couriered file before the run, so a stale one cannot be consumed", () => {
    // `awaitFile` accepts a file that is ALREADY there. A leftover from a
    // debugging session would be read as this run's evidence and reported as a
    // pass, which is the one failure mode of this harness that is not fail-closed.
    // BOUNDED EXPLICITLY. `indexOf` returns -1 when a marker moves, and
    // `slice(-1)` is an offset from the END — so a renamed marker would have made
    // this check read one character and pass every assertion by finding nothing.
    const from = script.indexOf("rm -f $DROP/");
    const to = script.indexOf("adb logcat -c");
    expect(from, "the cleanup block's start marker has moved").toBeGreaterThan(-1);
    expect(to, "the cleanup block's end marker has moved").toBeGreaterThan(from);
    const cleanup = script.slice(from, to);
    for (const file of awaitedFiles()) {
      expect(cleanup, `${file} is not cleared before the run`).toContain(file);
    }
  });

  it("greps only for courier keys the Android half emits", () => {
    const emitted = emittedKeys();
    for (const key of grepedKeys()) {
      expect(emitted, `the script waits for TP-COURIER key "${key}", which nothing emits`)
        .toContain(key);
    }
  });

  it("checks BOTH spellings opened, not just the compact one", () => {
    const greped = grepedKeys();
    expect(greped).toContain("opened-tp2");
    expect(greped).toContain("opened-json");
  });

  it("states the expected plaintext explicitly instead of relying on matching defaults", () => {
    // Both halves carry a default for each message and the defaults happen to be
    // equal. A run that depends on that proves nothing the moment one is edited.
    expect(script).toContain("-e expect ");
    expect(script).toContain("-e expectJson ");
    expect(script).toContain("TEST_RUNNER_MESSAGE=");
    expect(script).toContain("TEST_RUNNER_JSON_MESSAGE=");
    // And the iOS half must still read the variables the script sets.
    expect(iosMessage).toContain('environment["MESSAGE"]');
    expect(iosMessage).toContain('environment["JSON_MESSAGE"]');
    expect(androidTest).toContain('args.getString("expect")');
    expect(androidTest).toContain('args.getString("expectJson")');
  });

  it("agrees with BOTH halves about what the messages say", () => {
    // The script passes the expected plaintexts explicitly, so the defaults on
    // each side are fallbacks — but three independent copies of one string is
    // three places for it to drift, and the ceremony's whole assertion is that
    // what one device sent is what the other read. The values are held together.
    const script = read("scripts/cross-edition-physical.sh");
    const iosMsg = /IOS_MSG="([^"]+)"/.exec(script)?.[1];
    const iosJsonMsg = /IOS_JSON_MSG="([^"]+)"/.exec(script)?.[1];
    expect(iosMsg, "the script no longer names the compact message").toBeTruthy();
    expect(iosJsonMsg, "the script no longer names the canonical message").toBeTruthy();

    // The iOS half's fallbacks.
    expect(iosMessage, `the iOS default for MESSAGE has drifted from "${iosMsg}"`)
      .toContain(`?? "${iosMsg}"`);
    expect(iosMessage, `the iOS default for JSON_MESSAGE has drifted from "${iosJsonMsg}"`)
      .toContain(`?? "${iosJsonMsg}"`);
    // The Android half's fallbacks.
    expect(androidTest, `the Android default for expect has drifted from "${iosMsg}"`)
      .toContain(`?: "${iosMsg}"`);
    expect(androidTest, `the Android default for expectJson has drifted from "${iosJsonMsg}"`)
      .toContain(`?: "${iosJsonMsg}"`);
  });

  it("treats an iOS skip as a failure, because xcodebuild exits 0 for both", () => {
    // The two cross-edition classes skip themselves unless the ceremony opt-in is
    // set. A mis-set variable would otherwise be caught only indirectly, minutes
    // later, by a missing artifact.
    expect(script).toContain("assert_ios_ran");
    expect(script).toMatch(/Test Case .\* skipped/);
    expect((script.match(/assert_ios_ran "\$evid\//g) ?? []).length,
      "not every iOS invocation is checked for having actually run").toBe(2);
  });

  it("keeps its evidence out of the repository", () => {
    // The bundle it writes includes `02-transfer.tps2`, a sealed pad transfer
    // package pulled off the iPhone. One run followed by `git add -A` would put
    // it in history, where deleting it later does not remove it.
    expect(script).toMatch(/EVIDENCE_DIR:-artifacts\/cross-edition/);
    expect(read(".gitignore"), "artifacts/ is not ignored, and the harness writes a sealed pad into it")
      .toMatch(/^artifacts\/$/m);
  });
});
