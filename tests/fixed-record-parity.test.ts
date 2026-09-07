import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_CIPHERTEXT_BYTES } from "../src/core/wc-one-time.ts";

/* ============================================================================
 * One fixed-record rule, three editions
 * ----------------------------------------------------------------------------
 * A fixed record size is bounded by FOUR things: it is an integer, at least 32,
 * a multiple of 16, and no larger than the smaller of the pad's capacity and
 * MAX_CIPHERTEXT_BYTES. Every engine enforces all four. The SCREENS did not.
 *
 * Android enforced only capacity, so on a Large pad it accepted values four
 * times what its engine would carry and printed the wrong limit while doing it —
 * reported from a handset. The Browser had the same shape: integer, >= 32,
 * <= capacity, with neither the multiple-of-16 rule nor the ceiling. Both are
 * fixed; this is what stops them drifting apart again, and stops iOS drifting
 * away from either.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("every edition's create screen enforces the engine's whole rule", () => {
  const browser = read("src/browser/ui/create-pair.ts");
  const android = read(
    "android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/FixedRecordIntake.kt",
  );
  const ios = read("ios/TruePadKit/Sources/TruePadUI/Presentation.swift");

  it("agrees on the constants", () => {
    expect(MAX_CIPHERTEXT_BYTES).toBe(1_048_576);
    // POSITIVE CONTROL: all three sources really loaded.
    expect(browser).toContain("function problem()");
    expect(android).toContain("object FixedRecordIntake");
    expect(ios).toContain("public enum FixedRecordIntake");
  });

  it("bounds the size by the LOWER of the pad capacity and the engine limit", () => {
    expect(browser, "the browser screen does not take the minimum of the two bounds")
      .toContain("Math.min(state.e, MAX_CIPHERTEXT_BYTES)");
    expect(android, "the Android rule does not take the minimum of the two bounds")
      .toContain("minOf(encryptionCapacity, engineLimit.toLong())");
    expect(ios, "the iOS rule does not take the minimum of the two bounds")
      .toContain("min(encryptionCapacity, engineLimit)");
  });

  it("requires a multiple of 16 on every edition", () => {
    expect(browser, "the browser screen accepts a non-multiple").toContain("state.f % 16 !== 0");
    expect(android, "the Android rule accepts a non-multiple").toContain("value % MULTIPLE_OF == 0");
    expect(ios, "the iOS rule accepts a non-multiple").toContain("value % multipleOf != 0");
  });

  it("keeps the floor at 32 on every edition", () => {
    expect(browser).toContain("state.f < 32");
    expect(android).toContain("MINIMUM_BYTES = 32");
    expect(ios).toContain("minimumBytes = 32");
  });

  it("promises not to round, in the words the operator reads", () => {
    // The refusal must say the number is left alone. An operator who typed 100
    // and silently got 112 would have been told something false about their pad.
    expect(browser).toContain("will not round your number for you");
    expect(ios).toContain("will not round your number for you");
  });
});

/* ============================================================================
 * One fixed-record CAPACITY rule, four engines and three interfaces
 * ----------------------------------------------------------------------------
 * The rule the engines must share: on a fixed store every send spends exactly F
 * encryption bytes and one record, so
 *
 *     maxRemainingSends = min(remainingRecords, floor(remainingBytes / F))
 *
 * and on a variable store it stays `remainingRecords`, which is a true maximum
 * because a send can be one byte.
 *
 * THE BEHAVIOUR IS TESTED, NOT DESCRIBED, in three places that drive the real
 * engines: tests/fixed-record-capacity.test.ts (Browser + CLI),
 * FixedRecordCapacityTest.kt (Android) and FixedRecordCapacityTests.swift (iOS).
 * Each of those burns until its engine refuses and checks the count against what
 * the meter promised, so none of them can agree with a formula that is wrong.
 *
 * WHAT IS LEFT FOR THIS FILE is the thing no single-edition test can see: that
 * all four engines still consult the record spec at all, and that the screens
 * read the bounded figure rather than the raw record total. Android's screens
 * printed `remainingRecords` directly, bypassing the engine's figure entirely —
 * so fixing the engine alone would have left the handset saying the old number.
 * ========================================================================= */

describe("every engine bounds the message count by the fixed record size", () => {
  const engines = {
    "src/browser/engine/verbs.ts": read("src/browser/engine/verbs.ts"),
    "src/cli/v2/truepad2.ts": read("src/cli/v2/truepad2.ts"),
    "android/truepad-storage/.../Verbs.kt": read(
      "android/truepad-storage/src/main/kotlin/dev/systemslibrarian/truepad/storage/Verbs.kt",
    ),
    "ios/TruePadKit/Sources/TruePadStorage/Verbs.swift": read(
      "ios/TruePadKit/Sources/TruePadStorage/Verbs.swift",
    ),
  };

  it("found all four engines, and each one still computes a meter", () => {
    // POSITIVE CONTROL. Every assertion below is vacuous against an empty read.
    for (const [name, src] of Object.entries(engines)) {
      expect(src.length, `${name} did not load`).toBeGreaterThan(1000);
      expect(src, `${name} no longer computes remainingRecords`).toContain("remainingRecords");
    }
  });

  it("takes the minimum of the record budget and the byte budget", () => {
    expect(engines["src/browser/engine/verbs.ts"])
      .toContain("Math.min(remainingRecords, sendsAffordableByBytes)");
    expect(engines["src/cli/v2/truepad2.ts"])
      .toContain("Math.min(remainingRecords, sendsAffordableByBytes)");
    expect(engines["android/truepad-storage/.../Verbs.kt"])
      .toContain("minOf(remainingRecords, sendsAffordableByBytes)");
    expect(engines["ios/TruePadKit/Sources/TruePadStorage/Verbs.swift"])
      .toContain("min(remainingRecords, sendsAffordableByBytes)");
  });

  it("derives the byte budget from the record spec, not from a constant", () => {
    // The defect was that NOTHING here read `head.record`. If an engine stops
    // consulting it, the minimum above becomes min(n, n) and does nothing.
    expect(engines["src/browser/engine/verbs.ts"]).toContain('recordSpec.kind === "fixed"');
    expect(engines["src/cli/v2/truepad2.ts"]).toContain('recordSpec.kind === "fixed"');
    expect(engines["android/truepad-storage/.../Verbs.kt"]).toContain("is RecordSpec.Fixed ->");
    expect(engines["ios/TruePadKit/Sources/TruePadStorage/Verbs.swift"]).toContain("case .fixed(let f):");
  });
});

describe("every interface shows the bounded figure, not the raw record total", () => {
  it("names maxRemainingSends where it says how many messages are left", () => {
    // ANDROID IS WHY THIS EXISTS. Its pad screen, its pad-list status word and
    // its security details all read `remainingRecords` straight from the meter,
    // so the engine's figure was computed and then ignored on the one edition
    // that had been physically validated.
    const androidScreens = read(
      "android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt",
    );
    expect(androidScreens).toContain("sending?.maxRemainingSends?.toString()");
    expect(androidScreens).toContain("it.maxRemainingSends == 0L");
    expect(androidScreens, "the Android pad screen is back to printing the raw record total")
      .not.toContain("sending.remainingRecords");
    // AND IT DOES NOT GUESS THE HALF EITHER. `sendDirection` resolved a null role
    // to B->A, so the figure was confidently the wrong direction's budget.
    expect(androidScreens).toContain("Unknown — TruePad cannot tell which half is yours");

    const iosPad = read("ios/TruePadKit/Sources/TruePadUI/PadViews.swift");
    expect(iosPad).toContain('KeyValueRow("Messages you can still send"');
    expect(iosPad).toContain("row.maxRemainingSends");

    const browserDash = read("src/browser/ui/dashboard.ts");
    expect(browserDash).toContain("].maxRemainingSends");
    const browserFormat = read("src/browser/ui/format.ts");
    expect(browserFormat).toContain("m.maxRemainingSends <= 0");
  });

  it("tells the operator how messages are packaged, so the smaller number is explicable", () => {
    // A count that silently drops because of a setting made at creation, with
    // nothing on screen naming that setting, is a number the operator cannot act
    // on. All three editions carry the same row, in the same words.
    const label = "Message packaging";
    expect(read("src/browser/ui/dashboard.ts")).toContain(label);
    expect(read("android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt"))
      .toContain(label);
    expect(read("ios/TruePadKit/Sources/TruePadUI/PadViews.swift")).toContain(label);

    // THE RENDERED VALUE, NOT JUST THE LABEL. Asserting only that each source
    // contains "B per record" could not see the Browser thousands-separating its
    // number while the handsets did not, so at F = 1024 the same pad read two
    // different ways. The interpolation is compared directly.
    expect(read("src/browser/ui/format.ts"))
      .toContain("`Fixed · ${record.bytes} B per record`");
    expect(read("android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/FixedRecordIntake.kt"))
      .toContain('"Fixed · ${record.bytes} B per record"');
    expect(read("ios/TruePadKit/Sources/TruePadUI/Presentation.swift"))
      .toContain('"Fixed · \\(bytes) B per record"');
    for (const src of [
      read("src/browser/ui/format.ts"),
      read("android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/FixedRecordIntake.kt"),
      read("ios/TruePadKit/Sources/TruePadUI/Presentation.swift"),
    ]) {
      expect(src).toContain("B per record");
      expect(src).toContain("Variable length");
    }
  });
});
