import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * THE iOS PRIVACY MANIFEST MUST DESCRIBE THE CODE THAT SHIPS
 * ----------------------------------------------------------------------------
 * Apple requires a declared reason for a specific list of APIs. Two ways to get
 * this wrong, and this file exists to prevent both:
 *
 *   · DECLARING WHAT IS NOT THERE, because a longer manifest looks more
 *     conscientious. A reason that describes no call is decoration.
 *   · CALLING WITHOUT DECLARING, because the manifest was written once and the
 *     code moved. That is a submission rejection at best, and a false privacy
 *     statement at worst.
 *
 * TruePad reaches exactly one required-reason CATEGORY, through three calls in
 * TruePadStorage/DarwinFs.swift, all on paths inside its own container:
 * `stat` at :232 (a regular file, followed through symlinks, reads normally),
 * and `lstat` at :239 and :352 (existence WITHOUT following, because a `stat`
 * that follows would let a symlinked `destroyed.json` read as absent and a
 * destroyed pair become usable again). None of the three reads a timestamp —
 * only `st_mode` type bits — but Apple's category is keyed on the API, not on
 * the field. Hence FileTimestamp with reason C617.1.
 *
 * A NOTE ON THE PROBE ITSELF. The first version of this sweep reported "none"
 * while `setResourceValues` sat plainly in DarwinFs.swift — a false negative in
 * the checker, not a clean codebase. The positive control below exists because
 * that actually happened.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const APP_SRC = join(ROOT, "ios/TruePadApp/TruePadApp");
const KIT_SRC = join(ROOT, "ios/TruePadKit/Sources");
const MANIFEST = join(APP_SRC, "PrivacyInfo.xcprivacy");
const PBXPROJ = join(ROOT, "ios/TruePadApp/TruePadApp.xcodeproj/project.pbxproj");

/** Every shipping Swift file: the app target and the engine it links. Not tests. */
function shippingSwift(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".swift")) out.push(full);
    }
  };
  walk(APP_SRC);
  walk(KIT_SRC);
  return out;
}

const SHIPPING = shippingSwift().map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * Apple's required-reason categories, as REGEXES over shipping Swift source.
 *
 * `stat` NEEDED CARE, AND THE FIRST VERSION OF THIS GOT IT WRONG IN BOTH
 * DIRECTIONS. In Swift, `var resolved = stat()` is the imported C STRUCT's
 * zero-initialiser, not the syscall — TruePad writes exactly that on the line
 * before it calls the function. A plain `stat(` token therefore fires on correct
 * code. But EXCLUDING the token entirely, which is what this file did first,
 * missed the real `stat(target.path, &resolved)` call at DarwinFs.swift:232 and
 * saw only the two `lstat` calls. Neither a false positive nor a false negative
 * is acceptable in a gate that decides whether a declaration is required, so the
 * pattern distinguishes them: a call has arguments, an initialiser does not.
 */
const CATEGORIES: Record<string, RegExp[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    /\bl?stat\(\s*[^)\s]/,           // stat(path,…) / lstat(path,…), never stat()
    /\bfstat\(\s*[^)\s]/,
    /\bgetattrlist(bulk)?\(/, /\bfgetattrlist\(/,
    /NSFileCreationDate/, /NSFileModificationDate/,
    /\.creationDateKey/, /\.contentModificationDateKey/,
    /attributesOfItem/,
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: [
    /\bsystemUptime\b/, /\bmach_absolute_time\b/, /\bmach_continuous_time\b/,
  ],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    /volumeAvailableCapacity/, /NSURLVolumeAvailableCapacityKey/,
    /\bf?statfs\(/, /NSFileSystemFreeSize/, /\bsystemFreeSize\b/,
  ],
  NSPrivacyAccessedAPICategoryActiveKeyboards: [/\bactiveInputModes\b/],
  NSPrivacyAccessedAPICategoryUserDefaults: [
    /\bUserDefaults\b/, /\bNSUserDefaults\b/, /@AppStorage/,
  ],
};

/** Categories the shipping source actually reaches. */
function categoriesInSource(): string[] {
  return Object.entries(CATEGORIES)
    .filter(([, patterns]) => patterns.some((p) => p.test(SHIPPING)))
    .map(([c]) => c)
    .sort();
}

/** Categories the manifest declares. Parsed from the plist text. */
function categoriesDeclared(): string[] {
  const text = readFileSync(MANIFEST, "utf8");
  return [...text.matchAll(/<string>(NSPrivacyAccessedAPICategory[A-Za-z]+)<\/string>/g)]
    .map((m) => m[1])
    .sort();
}

describe("the privacy manifest is real and reaches the app", () => {
  it("finds the shipping source it claims to scan", () => {
    // POSITIVE CONTROL, and it is not ceremonial: the first version of this
    // sweep silently matched nothing at all.
    const files = shippingSwift();
    expect(files.length, "shipping Swift files").toBeGreaterThan(30);
    expect(SHIPPING.length, "bytes of shipping source").toBeGreaterThan(300_000);
    expect(SHIPPING, "the probe must see code known to be present")
      .toContain("setResourceValues");
    // ALL THREE required-reason calls, by the patterns the gate actually uses —
    // two `lstat` and one `stat`. An earlier version saw only the `lstat` pair.
    expect(SHIPPING).toMatch(/\blstat\(\s*[^)\s]/);
    expect(SHIPPING, "the real stat(2) call must be visible to the probe")
      .toMatch(/(?<!l)\bstat\(\s*[^)\s]/);
    // ...and the struct initialiser must NOT be what makes that true.
    expect(SHIPPING, "the fixture for the false-positive case must still exist")
      .toMatch(/=\s*stat\(\)/);
  });

  it("exists, parses, and is a resource of the APP target", () => {
    expect(statSync(MANIFEST).size).toBeGreaterThan(100);
    const pbx = readFileSync(PBXPROJ, "utf8");
    expect(pbx, "the manifest must be a file reference in the project")
      .toMatch(/PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference/);
    expect(pbx, "…and must be COPIED, or it never reaches the bundle")
      .toMatch(/PrivacyInfo\.xcprivacy in Resources/);
    // The app target's Resources PHASE, not the UI-test target's — and not the
    // target's buildPhases LIST, where the same identifier also appears. The
    // first version of this sliced from the list and compared the wrong bytes.
    const section = pbx.slice(
      pbx.indexOf("/* Begin PBXResourcesBuildPhase section */"),
      pbx.indexOf("/* End PBXResourcesBuildPhase section */"),
    );
    expect(section, "the resources section must be locatable").toContain("PBXResourcesBuildPhase");
    const appPhase = section.slice(
      section.indexOf("TP000000000000000000000C /* Resources */"),
      section.indexOf("TP0000000000000000000028 /* Resources */"),
    );
    expect(appPhase, "it must be in the APP target's Resources phase")
      .toContain("PrivacyInfo.xcprivacy in Resources");
  });
});

describe("the manifest declares exactly what the code does", () => {
  it("declares every required-reason category the shipping source reaches", () => {
    const used = categoriesInSource();
    const declared = categoriesDeclared();
    const undeclared = used.filter((c) => !declared.includes(c));
    expect(undeclared, `these required-reason APIs are called but NOT declared: `
      + `${undeclared.join(", ")}`).toEqual([]);
  });

  it("declares nothing the shipping source does not reach", () => {
    const used = categoriesInSource();
    const declared = categoriesDeclared();
    const spurious = declared.filter((c) => !used.includes(c));
    expect(spurious, `these categories are declared but no shipping code reaches `
      + `them — a reason that describes nothing: ${spurious.join(", ")}`).toEqual([]);
  });

  it("declares the FileTimestamp category, with the container reason", () => {
    // Pinned rather than derived: this is the one category TruePad genuinely
    // reaches, and C617.1 is the reason that matches WHY — metadata of files
    // inside the app's own container.
    const text = readFileSync(MANIFEST, "utf8");
    expect(categoriesInSource()).toEqual(["NSPrivacyAccessedAPICategoryFileTimestamp"]);
    expect(text).toContain("NSPrivacyAccessedAPICategoryFileTimestamp");
    expect(text).toContain("C617.1");
  });

  it("collects nothing and tracks nothing, which the binary audit supports", () => {
    const text = readFileSync(MANIFEST, "utf8");
    expect(text).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(text).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    expect(text).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  });
});

describe("the shipping app has no egress, which is what makes the above true", () => {
  it("imports no networking, cloud or tracking API in shipping source", () => {
    for (const banned of [
      "URLSession", "NSURLConnection", "CFSocket", "NWConnection",
      "getaddrinfo", "CloudKit", "NSUbiquitous", "AdSupport",
      "AppTrackingTransparency", "ASIdentifierManager",
    ]) {
      expect(SHIPPING, `shipping source references ${banned}; the "collects nothing" `
        + `declaration above would no longer be supportable`).not.toContain(banned);
    }
  });
});
