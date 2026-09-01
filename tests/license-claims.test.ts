import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * Licensing
 * ----------------------------------------------------------------------------
 * TruePad is licensed AGPL-3.0-only for the current release line; earlier
 * revisions were distributed under MIT and those grants are not revocable.
 * These guards pin the meaning: the project's own license surfaces must all
 * say AGPL-3.0-only, while third-party notices (the vendored BIP-39 wordlist,
 * MIT dependencies) keep their own terms. Nothing here bans the word "MIT" —
 * a dependency table that says MIT is telling the truth. What is banned is
 * TruePad describing ITSELF as MIT licensed.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LICENSE = readFileSync(join(ROOT, "LICENSE"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const LEARN = readFileSync(join(ROOT, "learn.html"), "utf8");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const LOCK = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

describe("the project license is AGPL-3.0-only, stated where it binds", () => {
  it("LICENSE is the canonical GNU AGPL v3 text, not a paraphrase", () => {
    expect(LICENSE).toMatch(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s*\n\s*Version 3, 19 November 2007/);
    // Load-bearing passages of the real text; a summary would not carry them.
    expect(LICENSE).toContain("Remote Network Interaction; Use with the GNU General Public License");
    expect(LICENSE).toMatch(
      /your modified version must prominently offer all users\s+interacting with it remotely/
    );
    expect(LICENSE).toContain("Copyright (C) 2007 Free Software Foundation, Inc.");
    expect(LICENSE, "changing the license text is forbidden by the license itself").toContain(
      "but changing it is not allowed"
    );
  });

  it("package metadata carries the exact SPDX identifier", () => {
    expect(PKG.license).toBe("AGPL-3.0-only");
    expect(LOCK.packages[""].license, "the lockfile root entry must match package.json").toBe(
      "AGPL-3.0-only"
    );
  });

  it("README has a License section that says what changed and what did not", () => {
    const section = README.slice(README.indexOf("## License"));
    expect(section.length, "README must have a License section").toBeGreaterThan(10);
    expect(section).toMatch(/GNU Affero General Public License v3\.0 only/);
    expect(section).toContain("AGPL-3.0-only");
    expect(section, "must link the license text").toMatch(/\[LICENSE\]\(LICENSE\)/);
    // The transition must not claim retroactive revocation of MIT grants.
    expect(section).toMatch(/does not and cannot revoke/);
    // Third-party terms survive the relicensing.
    expect(section).toMatch(/Third-party components[\s\S]*their own licenses/);
  });

  it("the Learn footer no longer describes TruePad as MIT", () => {
    expect(LEARN).toContain("AGPL-3.0-only licensed");
    expect(LEARN).not.toMatch(/TruePad · MIT licensed/);
  });

  it("the CHANGELOG records the transition without rewriting history", () => {
    const entry = CHANGELOG.slice(CHANGELOG.indexOf("### Licensing"));
    expect(entry.length, "CHANGELOG must carry a Licensing entry").toBeGreaterThan(10);
    expect(entry).toMatch(/from MIT to GNU AGPL v3 only/);
    expect(entry).toMatch(/Previously distributed revisions remain/);
  });

  it("no project surface still claims TruePad itself is MIT licensed", () => {
    // The claim shape, not the bare word: dependency tables and the vendored
    // wordlist notice legitimately say MIT and must keep saying it.
    for (const [name, text] of [
      ["README.md", README],
      ["learn.html", LEARN],
      ["CHANGELOG.md", CHANGELOG],
    ] as const) {
      expect(text, `${name} must not call TruePad MIT licensed`).not.toMatch(
        /TruePad (is|remains|·) (licensed under (the )?MIT|MIT licensed)/i
      );
    }
    expect(README).not.toMatch(/^MIT licensed\.$/m);
  });

  it("the third-party notices the project depends on are still intact", () => {
    const provenance = readFileSync(
      join(ROOT, "src/browser/ui/wordlist/PROVENANCE.md"),
      "utf8"
    );
    expect(provenance, "the BIP-39 MIT notice must survive relicensing").toContain(
      "Permission is hereby granted, free of charge"
    );
    expect(provenance).toContain("Copyright (c) 2013 Marek Palatinus");
  });
});
