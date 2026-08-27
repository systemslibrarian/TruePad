import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BANNER2, USAGE2 } from "../src/cli/v2/truepad2";

/* ============================================================================
 * Ledger wiring (Phase 2 → FORMAT-V2.md §14.2). The spec phrases its claims
 * as testable sentences on purpose, and promises (L2) that Phase 2 wires
 * the N-claims into the claims-test pattern this repo already runs on its
 * README. This suite is that hook: the spec's load-bearing sentences held
 * verbatim, and the N-claims that a test can check mechanically — N1 (no
 * secret outside secret.bin), N3 (no --no-auth/--legacy/--force), N14 (no
 * digest-shaped keys) — checked against the real binary and the real files.
 * The register guard from tests/claims.test.ts is applied to the v2 banner.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");
const DOC = readFileSync(join(ROOT, "docs", "FORMAT-V2.md"), "utf8");
// The spec hard-wraps its prose; sentences are asserted verbatim modulo the
// wrap: every whitespace run collapses to one space, nothing else changes.
const FLAT = DOC.replace(/\s+/g, " ");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-claims-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function genPair(pair: string, e: number, n: number): { code: number; stdout: string; stderr: string } {
  const source = join(dir, `source-${e}-${n}.bin`);
  writeFileSync(source, randomBytes(2 * (e + 32 * n)));
  return run("gen", pair, "--source", source, "--encryption-bytes", String(e), "--auth-records", String(n));
}

describe("FORMAT-V2.md still carries the load-bearing sentences, verbatim", () => {
  it("§5.2: the exact epsilon expression", () => {
    expect(DOC).toContain("65540 · 2^-128");
    expect(FLAT).toContain("ε = 65540 · 2^-128");
  });

  it("§7: the verdict line, period included", () => {
    expect(FLAT).toContain("Uniform if at least one declared source was uniform and independent of the others.");
  });

  it("§9.4: the residual is still headed OPEN", () => {
    expect(DOC).toMatch(/^###.*OPEN V1 RESIDUAL/m);
  });

  it("§9.4: the whole-directory-restore operator assumption stays stated", () => {
    expect(FLAT).toContain("restored as all three files together or not at all");
  });
});

// N3: "The strings --no-auth, --legacy, --force are not accepted by any v2
// verb." Tested the way an operator would type them — as bare flags, no
// invented value — in the positions an operator would put them.
const FORBIDDEN = ["--no-auth", "--legacy", "--force"] as const;

describe("N3 — the forbidden flags do not exist", { timeout: 120_000 }, () => {
  it("an open carrying any of them does not succeed, and the envelope survives to prove the check is not vacuous", () => {
    const a = join(dir, "a");
    expect(genPair(a, 16, 2).code).toBe(0);
    // Courier copies, all taken BEFORE the burn: the burn self-retires the
    // record in a's own copy, so only a pre-burn copy can open it.
    const control = join(dir, "control");
    cpSync(a, control, { recursive: true });
    const peerCopies = new Map<string, string>();
    for (const flag of FORBIDDEN) {
      const copy = join(dir, `peer${flag}`);
      cpSync(a, copy, { recursive: true });
      peerCopies.set(flag, copy);
    }
    const burn = run("burn", a, "--as", "A", "hello");
    expect(burn.code).toBe(0);
    const intact = burn.stdout.trim();

    // Control first: without a forbidden flag this envelope opens cleanly, so
    // a failure below is the flag's doing, not a broken fixture.
    const opened = run("open", control, "--as", "B", intact);
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe("hello");

    for (const flag of FORBIDDEN) {
      const copy = peerCopies.get(flag) as string;
      const flagged = run("open", copy, "--as", "B", flag, intact);
      expect(flagged.code).not.toBe(0);
      expect(flagged.stdout).toBe(""); // no plaintext escaped
      // The store is untouched by the refused run: the same envelope still
      // opens without the flag — nothing was half-accepted.
      const after = run("open", copy, "--as", "B", intact);
      expect(after.code).toBe(0);
      expect(after.stdout.trim()).toBe("hello");
    }
  });

  it("they fail in other argv positions too — trailing, and ahead of the verb — via the denylist itself", () => {
    const a = join(dir, "a");
    expect(genPair(a, 16, 1).code).toBe(0);
    for (const flag of FORBIDDEN) {
      const trailing = run("status", a, flag);
      expect(trailing.code).not.toBe(0);
      expect(trailing.stderr).toContain("no such flag exists in v2");
      const leading = run(flag, "status", a);
      expect(leading.code).not.toBe(0);
      expect(leading.stderr).toContain("no such flag exists in v2");
      // The = spelling is the same flag, not a different one.
      const equals = run("status", a, `${flag}=yes`);
      expect(equals.code).not.toBe(0);
      expect(equals.stderr).toContain("no such flag exists in v2");
    }
  });

  it("a fabricated value does not smuggle them past the denylist", () => {
    const a = join(dir, "a-with-value");
    expect(genPair(a, 16, 1).code).toBe(0);
    for (const flag of FORBIDDEN) {
      const flagged = run("status", a, flag, "x");
      expect(flagged.code).not.toBe(0);
      expect(flagged.stderr).toContain("no such flag exists in v2");
      expect(flagged.stdout).toBe("");
    }
  });

  it("the help surface does not advertise them", () => {
    for (const flag of FORBIDDEN) {
      expect(USAGE2).not.toContain(flag);
      expect(BANNER2).not.toContain(flag);
    }
  });

  it("no v2 CLI source wires them into flag handling", () => {
    // Prose that NAMES their absence is fine; a handler is not. Match the
    // flag-handling idioms: flags.get/has("...") and single(args, "...").
    const v2Dir = join(ROOT, "src", "cli", "v2");
    const files = readdirSync(v2Dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(v2Dir, file), "utf8");
      for (const name of ["no-auth", "legacy", "force"]) {
        expect(text).not.toMatch(new RegExp(`flags\\.(?:get|has)\\(\\s*["']${name}`));
        expect(text).not.toMatch(new RegExp(`single\\(\\s*\\w+\\s*,\\s*["']${name}`));
      }
    }
  });
});

describe("N1 — no secret outside secret.bin", { timeout: 120_000 }, () => {
  it("after a gen, no K, R, or encryption byte run appears in head.json or manifest.json", () => {
    const a = join(dir, "a");
    const e = 16;
    const n = 4;
    expect(genPair(a, e, n).code).toBe(0);
    const haystack =
      readFileSync(join(a, "a-to-b", "head.json"), "utf8") +
      readFileSync(join(a, "b-to-a", "head.json"), "utf8") +
      readFileSync(join(a, "manifest.json"), "utf8");
    for (const half of ["a-to-b", "b-to-a"]) {
      const secret = readFileSync(join(a, half, "secret.bin"));
      expect(secret.length).toBe(e + 32 * n);
      const needles = [Buffer.from(secret.subarray(0, e)).toString("hex")]; // the encryption slice
      for (let sequence = 0; sequence < n; sequence += 1) {
        const base = e + 32 * sequence;
        needles.push(Buffer.from(secret.subarray(base, base + 16)).toString("hex")); // K_s
        needles.push(Buffer.from(secret.subarray(base + 16, base + 32)).toString("hex")); // R_s
      }
      for (const needle of needles) {
        expect(needle).toMatch(/^[0-9a-f]{32}$/); // the needle is real, not empty
        expect(haystack).not.toContain(needle);
      }
    }
  });
});

describe("N14 — nothing digest-shaped in head.json or manifest.json", { timeout: 120_000 }, () => {
  function collectKeys(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, out);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        out.push(key);
        collectKeys(inner, out);
      }
    }
    return out;
  }

  it("no key in any header or manifest is named hash, checksum, or fingerprint", () => {
    const a = join(dir, "a");
    expect(genPair(a, 16, 2).code).toBe(0);
    const keys = [
      ...collectKeys(JSON.parse(readFileSync(join(a, "a-to-b", "head.json"), "utf8"))),
      ...collectKeys(JSON.parse(readFileSync(join(a, "b-to-a", "head.json"), "utf8"))),
      ...collectKeys(JSON.parse(readFileSync(join(a, "manifest.json"), "utf8")))
    ];
    expect(keys.length).toBeGreaterThan(20); // the walk really saw the files
    expect(keys.filter((key) => /hash|checksum|fingerprint/i.test(key))).toEqual([]);
  });
});

describe("the v2 banner keeps the register", () => {
  // The Lane 1–4 retractions, from tests/claims.test.ts: none may reappear
  // in the sentence every truepad2 run prints first.
  const RETRACTED: [RegExp, string][] = [
    [/information[- ]theoretically secure/i, "F1: the claim is conditional, per §5 and §7"],
    [/reuse is impossible,? (?:not|rather than) merely forbidden/i, "F2: only true within one process"],
    [/no api can return a burned value\s*[—-]/i, "F2: needs its scope qualifier"],
    [/decrypt messages in the order they were sent/i, "F3: the envelope carries its offset; the receiver seeks"],
    [/the e2e suite both assert/i, "F5: described a suite that did not exist"]
  ];

  it("BANNER2 matches no retracted phrase and stays inside its stated conditions", () => {
    for (const [pattern, why] of RETRACTED) {
      expect(BANNER2, why).not.toMatch(pattern);
    }
    const flatBanner = BANNER2.replace(/\s+/g, " ");
    expect(flatBanner).toContain("FORMAT-V2.md");
    expect(flatBanner).toContain("conditional on");
    expect(flatBanner).toContain("not a recommendation to use one-time pads for real traffic");
  });

  it("the banner is actually emitted by every run, not just exported", () => {
    // The constant above is only the register guard's subject if the binary
    // prints it. Even a usage error prints the banner first.
    const result = run("no-such-verb");
    expect(result.stderr.replace(/\s+/g, " ")).toContain(
      "not a recommendation to use one-time pads for real traffic"
    );
  });
});
