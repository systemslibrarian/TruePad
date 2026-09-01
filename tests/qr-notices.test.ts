/* ============================================================================
 * QR dependencies are pinned, licensed, and truthfully notified
 * ----------------------------------------------------------------------------
 * The QR feature adds two production dependencies. This pins them: exact
 * versions, and a third-party notice that names each one, its license, and
 * (for the MIT library) reproduces the notice rather than merely citing it —
 * the same standard the vendored wordlist is held to. TruePad's own license
 * stays AGPL-3.0-only.
 * ========================================================================= */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NOTICES = readFileSync(join(ROOT, "docs", "THIRD-PARTY-NOTICES.md"), "utf8");

describe("QR dependencies are pinned exactly", () => {
  it("qrcode-generator and jsqr are exact-pinned production dependencies", () => {
    expect(PKG.dependencies["qrcode-generator"]).toBe("2.0.4");
    expect(PKG.dependencies["jsqr"]).toBe("1.4.0");
    // Exact pins, no range prefixes.
    expect(PKG.dependencies["qrcode-generator"]).not.toMatch(/[\^~><=*]/);
    expect(PKG.dependencies["jsqr"]).not.toMatch(/[\^~><=*]/);
  });

  it("the project itself stays AGPL-3.0-only", () => {
    expect(PKG.license).toBe("AGPL-3.0-only");
  });

  it("the production dependency set added only the two QR libraries", () => {
    expect(Object.keys(PKG.dependencies).sort()).toEqual(["@noble/post-quantum", "jsqr", "qrcode-generator"]);
  });
});

describe("the third-party notice is truthful and complete", () => {
  it("names qrcode-generator with its version, MIT license, and reproduces the notice", () => {
    expect(NOTICES).toContain("qrcode-generator");
    expect(NOTICES).toContain("2.0.4");
    expect(NOTICES).toMatch(/\bMIT\b/);
    expect(NOTICES).toContain("Copyright (c) 2009 Kazuhiko Arase");
    // Reproduced, not merely cited.
    expect(NOTICES).toContain("Permission is hereby granted, free of charge");
    expect(NOTICES).toContain("https://github.com/kazuhikoarase/qrcode-generator");
  });

  it("names jsQR with its version, Apache-2.0 license, and source", () => {
    expect(NOTICES).toMatch(/jsQR|jsqr/);
    expect(NOTICES).toContain("1.4.0");
    expect(NOTICES).toContain("Apache-2.0");
    expect(NOTICES).toContain("http://www.apache.org/licenses/LICENSE-2.0");
    expect(NOTICES).toContain("https://github.com/cozmo/jsQR");
  });

  it("states the no-runtime-network property both libraries satisfy", () => {
    expect(NOTICES).toMatch(/no network/i);
  });
});

describe("the QR source reaches no network and no QR service", () => {
  it("has no fetch/XHR/WebSocket, no eval, and no remote QR endpoint", () => {
    const dir = join(ROOT, "src/browser/ui/qr");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      // Strip comments so prose about "no network" is not mistaken for a call.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, `${file} must not fetch`).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
      expect(code, `${file} must not eval`).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      expect(code, `${file} must not contact a QR service`).not.toMatch(
        /chart\.googleapis|api\.qrserver|qrcode\.tec-it|goqr\.me|https?:\/\/[^"']*qr/i
      );
    }
  });
});
