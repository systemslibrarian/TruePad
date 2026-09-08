import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * THE DISTRIBUTION CONFIGURATION
 * ----------------------------------------------------------------------------
 * Everything an App Store archive needs that is not code: the icon catalog, the
 * export path, and the absence of anybody's signing credentials.
 *
 * THE ICON CHECKS ARE SHAPED TO SURVIVE THE ARTWORK ARRIVING. They assert the
 * STRUCTURE — catalog wired, one 1024×1024 slot, build setting present — and then
 * assert CONSISTENCY: if a filename is declared, the file must exist. So they pass
 * both before and after the picture is supplied, and fail on the state that would
 * actually hurt: a Contents.json naming a file that is not there.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const APP = join(ROOT, "ios/TruePadApp/TruePadApp");
const CATALOG = join(APP, "Assets.xcassets");
const ICONSET = join(CATALOG, "AppIcon.appiconset");
const PBXPROJ = join(ROOT, "ios/TruePadApp/TruePadApp.xcodeproj/project.pbxproj");
const EXPORT_OPTIONS = join(ROOT, "ios/TruePadApp/ExportOptions.plist");

const pbx = readFileSync(PBXPROJ, "utf8");

describe("the app icon infrastructure is wired, whatever the artwork state", () => {
  it("has an asset catalog with an AppIcon set", () => {
    expect(existsSync(CATALOG), "Assets.xcassets must exist").toBe(true);
    expect(existsSync(ICONSET), "AppIcon.appiconset must exist").toBe(true);
    expect(existsSync(join(CATALOG, "Contents.json"))).toBe(true);
    expect(existsSync(join(ICONSET, "Contents.json"))).toBe(true);
  });

  it("declares exactly one 1024x1024 universal iOS slot", () => {
    const c = JSON.parse(readFileSync(join(ICONSET, "Contents.json"), "utf8"));
    expect(Array.isArray(c.images)).toBe(true);
    const big = c.images.filter((i: { size?: string }) => i.size === "1024x1024");
    expect(big.length, "exactly one App Store marketing icon slot").toBe(1);
    expect(big[0].idiom).toBe("universal");
  });

  it("names a file only if that file is actually there", () => {
    // THE FAILURE THAT WOULD ACTUALLY HURT. A Contents.json referencing missing
    // artwork produces a build warning and an icon-less bundle — which reads as
    // "done" to anyone who only checks that a filename is present.
    const c = JSON.parse(readFileSync(join(ICONSET, "Contents.json"), "utf8"));
    for (const image of c.images as { filename?: string }[]) {
      if (!image.filename) continue;
      expect(existsSync(join(ICONSET, image.filename)),
        `AppIcon Contents.json names ${image.filename}, which is not in the iconset`)
        .toBe(true);
    }
  });

  it("is a resource of the APP target, with the build setting to match", () => {
    expect(pbx).toMatch(/Assets\.xcassets \*\/ = \{isa = PBXFileReference/);
    expect(pbx, "the catalog must be COPIED or no icon reaches the bundle")
      .toMatch(/Assets\.xcassets in Resources/);
    const section = pbx.slice(
      pbx.indexOf("/* Begin PBXResourcesBuildPhase section */"),
      pbx.indexOf("/* End PBXResourcesBuildPhase section */"),
    );
    const appPhase = section.slice(
      section.indexOf("TP000000000000000000000C /* Resources */"),
      section.indexOf("TP0000000000000000000028 /* Resources */"),
    );
    expect(appPhase).toContain("Assets.xcassets in Resources");
    // Both app configurations, or one of Debug/Release silently differs.
    const n = (pbx.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g) ?? []).length;
    expect(n, "ASSETCATALOG_COMPILER_APPICON_NAME in both app configurations").toBe(2);
  });

  it("ships no placeholder artwork masquerading as final", () => {
    // Not a ban on images — a ban on the specific dishonesty of a filler icon
    // committed to turn the archive gate green. If a real icon arrives it will
    // have a filename in Contents.json, which the consistency test above covers.
    const images = readdirSync(ICONSET).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    const c = JSON.parse(readFileSync(join(ICONSET, "Contents.json"), "utf8"));
    const named = (c.images as { filename?: string }[]).map((i) => i.filename).filter(Boolean);
    const orphans = images.filter((f) => !named.includes(f));
    expect(orphans, `these images sit in the iconset but no slot references them: `
      + `${orphans.join(", ")}`).toEqual([]);
  });
});

describe("the export path carries no secrets", () => {
  it("exists and targets App Store Connect with automatic signing", () => {
    const p = readFileSync(EXPORT_OPTIONS, "utf8");
    expect(p).toContain("<string>app-store-connect</string>");
    expect(p).toContain("<string>automatic</string>");
  });

  it("contains no team, profile, or credential", () => {
    const p = readFileSync(EXPORT_OPTIONS, "utf8");
    // teamID is supplied on the command line so an account identity never becomes
    // a committed fact. provisioningProfiles would pin the file to one developer.
    for (const forbidden of ["<key>teamID</key>", "<key>provisioningProfiles</key>",
                             "<key>signingCertificate</key>", "<key>installerSigningCertificate</key>"]) {
      expect(p, `ExportOptions.plist must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("does not fabricate an export-compliance code", () => {
    const info = readFileSync(join(APP, "Info.plist"), "utf8");
    expect(info, "the truthful declaration must stay")
      .toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<true\/>/);
    // A placeholder here could be mistaken for a real Apple approval.
    expect(info, "no invented compliance code may sit in the shipping plist")
      .not.toContain("ITSEncryptionExportComplianceCode");
  });
});

describe("no signing material is committed", () => {
  it("carries no certificates, keys or provisioning profiles", () => {
    const bad: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (["node_modules", ".git", "dist", "build", ".build", "test-results",
               "artifacts"].includes(e.name)) continue;
          walk(r);
        } else if (/\.(p12|mobileprovision|cer|certSigningRequest|pem|key)$/i.test(e.name)) {
          bad.push(r);
        }
      }
    };
    walk("");
    expect(bad, `signing material must never be committed: ${bad.join(", ")}`).toEqual([]);
  });

  it("commits no developer team id in the project", () => {
    // DEVELOPMENT_TEAM is supplied at archive time. An empty string is the
    // committed value; anything else is somebody's account identity in git.
    for (const m of pbx.matchAll(/DEVELOPMENT_TEAM = ([^;]*);/g)) {
      expect(m[1].trim(), "DEVELOPMENT_TEAM must stay empty in source control")
        .toBe('""');
    }
  });
});
