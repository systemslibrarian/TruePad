import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * The release state
 * ----------------------------------------------------------------------------
 * TruePad's version lives in SIX places across three editions and two package
 * managers, and nothing in any single build can see the other five. A release
 * that stamps npm and forgets the Xcode project ships an iOS binary describing
 * itself as development software; a release that stamps everything and leaves the
 * prose saying "3.0 is not tagged" ships a front door contradicting its own tag.
 * Both are the same defect — release metadata that disagrees with the release —
 * and this file is what fails when it happens.
 *
 * WHY THE NUMBERS ARE WRITTEN OUT RATHER THAN DERIVED. Every expectation here is
 * a LITERAL. Reading package.json and asserting that the Xcode project agrees
 * with it would pass just as happily on a tree where both had slid back to
 * 3.0.0-dev.0 together, which is exactly the drift this guards. The expectation
 * has to come from the release decision, not from the tree, so raising it is a
 * deliberate edit a reviewer sees in the diff.
 *
 * DIRECTION. These assertions fail on a REGRESSION toward pre-release language,
 * not merely on absence: each one that bans a phrase is paired with one that
 * requires the released phrasing, so deleting the sentence does not satisfy it.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

/** The release this ceremony made. Raising these is the deliberate edit. */
const VERSION = "3.0.0";
const ANDROID_VERSION_CODE = 3;
const IOS_BUILD = 2;
/** The previous formal release, which must remain history and must not move. */
const PREVIOUS = "2.0.0";

describe("every edition states the same released version", () => {
  it("npm: package.json and the lockfile root both read 3.0.0", () => {
    const pkg = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    expect(pkg.version, "package.json").toBe(VERSION);
    expect(lock.version, "package-lock.json root").toBe(VERSION);
    expect(lock.packages[""].version, "the lockfile's own root package entry").toBe(VERSION);
    expect(lock.packages[""].name).toBe(pkg.name);
    // The lockfile carries dependency versions too, and this must never have
    // rewritten one of those: the dependency set is unchanged by a release.
    expect(lock.lockfileVersion).toBe(3);
  });

  it("Android: versionName 3.0.0 at a monotonic versionCode 3", () => {
    const gradle = read("android/app/build.gradle.kts");
    const name = gradle.match(/^\s*versionName\s*=\s*"([^"]+)"/m);
    const code = gradle.match(/^\s*versionCode\s*=\s*(\d+)/m);
    // POSITIVE CONTROL: both declarations were actually located. A regex that
    // stopped matching would otherwise make every assertion below vacuous.
    expect(name, "versionName is no longer where this guard looks").not.toBeNull();
    expect(code, "versionCode is no longer where this guard looks").not.toBeNull();
    expect(name![1]).toBe(VERSION);
    expect(Number(code![1])).toBe(ANDROID_VERSION_CODE);
    // The application ID is the app's identity, not a version, and the stale
    // clone suffix must never come back: two packages on one handset is how the
    // 3.0 development line ended up with two independent pad stores.
    expect(gradle).toMatch(/applicationId\s*=\s*"dev\.systemslibrarian\.truepad"/);
    expect(gradle, "the .b clone suffix must not be reintroduced")
      .not.toMatch(/applicationIdSuffix\s*=\s*"\.b"/);
  });

  it("iOS: MARKETING_VERSION 3.0.0 in every configuration that declares one", () => {
    const pbx = read("ios/TruePadApp/TruePadApp.xcodeproj/project.pbxproj");
    const marketing = [...pbx.matchAll(/MARKETING_VERSION\s*=\s*"?([^";]+)"?;/g)].map((m) => m[1]);
    const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION\s*=\s*"?([^";]+)"?;/g)].map((m) => m[1]);
    // POSITIVE CONTROL. The project declares the pair in four configurations —
    // the app's Debug and Release and the UI-test target's Debug and Release.
    // Asserting "every one found agrees" over an empty list finds nothing wrong
    // with a project that declares nothing at all.
    expect(marketing.length, "MARKETING_VERSION declarations").toBe(4);
    expect(builds.length, "CURRENT_PROJECT_VERSION declarations").toBe(4);
    for (const v of marketing) expect(v).toBe(VERSION);
    for (const b of builds) expect(Number(b)).toBe(IOS_BUILD);
    // DEVELOPMENT_TEAM is supplied on the command line for local signing and
    // must not be committed; a release is exactly when one gets left behind.
    for (const m of pbx.matchAll(/DEVELOPMENT_TEAM\s*=\s*"?([^";]*)"?;/g)) {
      expect(m[1], "a signing team must not be committed to source control").toBe("");
    }
  });

  it("citation metadata reports the released version and claims nothing it has not got", () => {
    const cff = read("CITATION.cff");
    expect(cff).toMatch(new RegExp(`^version: "${VERSION.replace(/\./g, "\\.")}"$`, "m"));
    expect(cff, "a release date belongs on a released citation")
      .toMatch(/^date-released: "\d{4}-\d{2}-\d{2}"$/m);
    expect(cff, "3.0 must not still be described as development software")
      .not.toMatch(/3\.0 is DEVELOPMENT software|3\.0\.0-dev/);
    expect(cff, "3.0.0 must be named the latest formal release")
      .toMatch(/3\.0\.0 is the latest FORMAL release/i);
    // A release does not mint a DOI, a journal, a peer review or an audit.
    expect(cff).not.toMatch(/^doi:/m);
    expect(cff).toMatch(/No DOI, journal, conference, peer review, or external audit is claimed/);
  });

  it("the iOS SBOM describes the released version, not the one it was generated under", () => {
    // gen-sbom.sh reads package.json, so a release that forgets to regenerate
    // ships a supply-chain document naming a version that was never released.
    const sbom = JSON.parse(read("ios/sbom.json"));
    // metadata.component IS one of TruePad's version statements and was missed by
    // the first version of this guard, which read `components` alone — a mutation
    // that staled only the metadata component passed cleanly.
    const own = [sbom.metadata?.component, ...sbom.components]
      .filter((c: { name?: string } | undefined): c is { name: string; version: string } =>
        !!c?.name && /truepad/i.test(c.name));
    expect(own.length, "the SBOM must describe TruePad's own modules").toBeGreaterThanOrEqual(6);
    for (const c of own) expect(c.version, `${c.name} in ios/sbom.json`).toBe(VERSION);
  });
});

describe("no current document still describes 3.0 as unreleased", () => {
  /* HISTORICAL RECORDS ARE EXEMPT, BY NAME AND ONLY BY NAME. An audit snapshot
   * that says what was true when it was written is evidence and must not be
   * rewritten into today's tense — but the exemption is a short, explicit list,
   * so a current document cannot join it by accident. Each exempt file must
   * still carry its own supersession marker, which is asserted below rather than
   * assumed. */
  const HISTORICAL = new Set([
    "docs/ANDROID-3.0-DELTA-AUDIT.md",
    "docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md",
    "CHANGELOG.md",
  ]);

  /** Every tracked, release-facing markdown document. */
  function docs(): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (["node_modules", ".git", "dist", "build", "test-results", "artifacts",
               "vendor", "assets"].includes(e.name)) continue;
          walk(r);
        } else if (e.name.endsWith(".md")) out.push(r);
      }
    };
    walk("");
    return out;
  }

  it("finds the documents it claims to police", () => {
    // POSITIVE CONTROL. A walk that silently returned nothing would make the
    // sweep below pass by having no documents to read.
    const all = docs();
    expect(all.length, "release-facing markdown documents").toBeGreaterThan(20);
    for (const required of ["README.md", "SECURITY.md", "docs/REVIEWER-START-HERE.md",
                            "docs/TRUEPAD-3-SPEC.md", "docs/IOS-SECURITY.md",
                            "docs/RELEASE-CHECKLIST-3.0.md"]) {
      expect(all, `${required} must be in the swept set`).toContain(required);
    }
    for (const h of HISTORICAL) {
      expect(all, `${h} is exempted but not present`).toContain(h);
    }
  });

  it("carries no pre-release version stamp outside a named historical record", () => {
    const offenders: string[] = [];
    for (const rel of docs()) {
      if (HISTORICAL.has(rel)) continue;
      const text = read(rel);
      for (const m of text.matchAll(/3\.0\.0-dev(?:\.\d+)?/g)) {
        // A sentence that says the stamp USED to read that way is a correction,
        // not a stale claim, and is what an honest release note looks like.
        const around = text.slice(Math.max(0, m.index! - 220), m.index! + 120);
        if (/earlier revision|used to|was the development state|once (?:said|read)|from `?3\.0\.0-dev/i.test(around)) continue;
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `these documents still carry a pre-release version stamp`).toEqual([]);
  });

  it("does not still say 3.0 is untagged, unreleased, or development", () => {
    const banned = [
      /3\.0 is not (?:released|tagged)/i,
      /3\.0 is not tagged, released, or published/i,
      /carries \*\*TruePad 3\.0 development\*\*/i,
      /latest FORMAL release remains\s*\n?2\.0\.0/i,
      // "no 3.0 tag" in any of the shapes the tree actually used before the
      // release: three documents said it three different ways.
      /no 3\.0\s*\n?tag/i,
      /[Nn]either (?:is|platform is) released/,
      /3\.0-dev (?:app|application)/i,
      // A human accessibility pass is NON-BLOCKING by owner decision; a document
      // calling it a release gate contradicts the canonical checklist, and that
      // contradiction is what made this line worth guarding.
      /human (?:VoiceOver|TalkBack) pass is a release gate/i,
    ];
    const offenders: string[] = [];
    for (const rel of docs()) {
      if (HISTORICAL.has(rel)) continue;
      const text = read(rel);
      for (const bad of banned) if (bad.test(text)) offenders.push(`${rel}: ${String(bad)}`);
    }
    expect(offenders, "these documents still describe 3.0 as unreleased").toEqual([]);
  });

  it("keeps every exempt historical record marked as history", () => {
    // The exemption above is only honest while the exempt file SAYS it is a past
    // record. A historical document that quietly stops saying so becomes a
    // current document making a stale claim, with a guard excusing it.
    expect(read("docs/ANDROID-3.0-DELTA-AUDIT.md"))
      .toMatch(/SUPERSEDED IN PART — READ THIS FIRST/);
    expect(read("docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md"))
      .toMatch(/2\.0\.0|audit/i);
    // The CHANGELOG is exempt because its older entries describe older releases.
    // Its NEWEST entry must be the released one, which front-door-claims pins.
    expect(read("CHANGELOG.md")).toMatch(/^## v3\.0\.0 — \d{4}-\d{2}-\d{2}$/m);
  });
});

describe("the previous release stays exactly where it is", () => {
  it("2.0.0 remains recorded as the first formal release", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## v${PREVIOUS.replace(/\./g, "\\.")} — \\d{4}-\\d{2}-\\d{2}$`, "m")
    );
    expect(read("CHANGELOG.md")).toMatch(/v2\.0\.0 is TruePad's first formally tagged release/i);
    expect(read("README.md")).toMatch(/TruePad 2\.0\.0 is the project's first formally tagged release/i);
  });

  it("invents no release that never happened", () => {
    for (const rel of ["README.md", "CHANGELOG.md", "SECURITY.md", "CITATION.cff"]) {
      expect(read(rel), `${rel} invents a v1.0.0`).not.toMatch(/v1\.0\.0/);
      expect(read(rel), `${rel} invents a release after 3.0.0`).not.toMatch(/v3\.0\.[1-9]|v3\.[1-9]\.\d/);
    }
  });
});

describe("the release claims nothing the project did not do", () => {
  const UNEARNED: [RegExp, string][] = [
    [/human TalkBack/i, "TalkBack"],
    [/human VoiceOver/i, "VoiceOver"],
    [/[Pp]hysical TPM/i, "physical TPM"],
    [/[Ii]ndependent human security review/i, "independent review"],
  ];

  it("still records all four unperformed gates as unperformed", () => {
    const checklist = read("docs/RELEASE-CHECKLIST-3.0.md");
    for (const [pattern, label] of UNEARNED) {
      expect(checklist, `${label} must still be named in the checklist`).toMatch(pattern);
    }
    // NOT TESTED / NOT VALIDATED / NOT PERFORMED must survive the release edit.
    expect(checklist).toMatch(/NOT TESTED — NON-BLOCKING/);
    expect(checklist).toMatch(/NOT VALIDATED — NON-BLOCKING/);
    expect(checklist).toMatch(/NOT PERFORMED/);
    // ...and none of them may have been flipped to done.
    expect(checklist, "TalkBack must not be marked complete")
      .not.toMatch(/Human TalkBack[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\*\*DONE/);
    expect(checklist, "VoiceOver must not be marked complete")
      .not.toMatch(/Human VoiceOver[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\*\*DONE/);
  });

  it("keeps the automation qualification travelling with the two-device ceremony", () => {
    // The word comparisons were read by automation. Every place that cites the
    // ceremony must keep saying so; a release is when that qualification is most
    // tempting to drop.
    const checklist = read("docs/RELEASE-CHECKLIST-3.0.md");
    expect(checklist).toMatch(/AUTOMATION, not spoken|automated comparison, not spoken/i);
    expect(read("CHANGELOG.md")).toMatch(/by AUTOMATION, not spoken aloud by two people/);
  });

  it("makes no App Store or signed-distribution claim it cannot support", () => {
    for (const rel of ["README.md", "docs/IOS-SECURITY.md", "ios/README.md", "CHANGELOG.md"]) {
      const text = read(rel);
      for (const m of text.matchAll(/App Store/g)) {
        const sentence = text.slice(Math.max(0, m.index! - 160), m.index! + 160);
        expect(/\b(no|not|never|without)\b/i.test(sentence),
          `${rel} mentions the App Store without denying one exists: ${sentence.slice(0, 160)}`)
          .toBe(true);
      }
    }
  });
});
