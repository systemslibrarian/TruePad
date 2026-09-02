/* ============================================================================
 * truepad2 status — the DEPLOYMENT CLAIMS section
 * ----------------------------------------------------------------------------
 * status derives a Shannon deployment assessment from recorded facts and prints
 * it to stderr, without touching the stdout machine line (whose shape is a
 * contract) and without ever writing a stored verdict. A CLI store carries
 * operator-declared external sources and is delivered by a courier the tool
 * cannot observe, so it is CONDITIONALLY ELIGIBLE — never "verified true random".
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-shannon-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function gen(pair: string, e: number, n: number, ...extra: string[]): void {
  const src = join(dir, `src-${pair.replace(/\W/g, "_")}.bin`);
  writeFileSync(src, randomBytes(2 * (e + 32 * n)));
  const r = run("gen", join(dir, pair), "--source", src, "--encryption-bytes", String(e), "--auth-records", String(n), ...extra);
  expect(r.code, r.stderr).toBe(0);
}

describe("status shows a derived DEPLOYMENT CLAIMS section", () => {
  it("(F) a CLI external-source store is CONDITIONALLY ELIGIBLE, with the physical premises left unproven", () => {
    // Two sources so the section can report the count.
    const s1 = join(dir, "s1.bin");
    const s2 = join(dir, "s2.bin");
    writeFileSync(s1, randomBytes(2 * (16 + 32 * 2)));
    writeFileSync(s2, randomBytes(2 * (16 + 32 * 2)));
    expect(run("gen", join(dir, "p"), "--source", s1, "--source", s2, "--encryption-bytes", "16", "--auth-records", "2").code).toBe(0);

    const st = run("status", join(dir, "p"));
    expect(st.code).toBe(0);
    const e = st.stderr;
    expect(e).toContain("DEPLOYMENT CLAIMS");
    expect(e).toMatch(/literal one-time-pad XOR .+ YES/);
    expect(e).toMatch(/one-time Wegman-Carter .+ YES/);
    expect(e).toMatch(/theorem scope .+ conditional on fresh one-time auth material/);
    expect(e).toMatch(/external source declarations .+ 2/);
    expect(e).toMatch(/physical uniformity proven by TruePad .+ NO/);
    expect(e).toMatch(/source independence proven by TruePad .+ NO/);
    expect(e).toMatch(/sealed computational delivery used .+ NO/);
    expect(e).toMatch(/private handoff .+ OPERATOR PREMISE/);
    expect(e).toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toMatch(/has not proved physical randomness/);
  });

  it("does not add any field to the stdout machine line, and stores no verdict", () => {
    gen("p", 16, 2);
    const st = run("status", join(dir, "p"));
    // The machine JSON is stdout-only and must carry no deployment/verdict field.
    const machine = JSON.parse(st.stdout);
    expect(JSON.stringify(machine)).not.toMatch(/shannon|assessment|eligible|deployment|trueRandom|informationTheoretic|itCapable/i);
    // No self-certifying words anywhere in the output.
    for (const bad of [/truly random/i, /verified true/i, /perfect secrecy/i, /information-theoretic security confirmed/i, /certified/i]) {
      expect(st.stderr + st.stdout).not.toMatch(bad);
    }
  });

  it("(G) names witness class NONE truthfully when there is no witness", () => {
    gen("p", 16, 2);
    expect(run("status", join(dir, "p")).stderr).toMatch(/witness class .+ NONE/);
  });

  it("(H) names the SEPARATE-STATE-FILE witness class when one is configured", () => {
    const wpath = join(dir, "witness.json");
    expect(run("witness", "init", wpath).code).toBe(0);
    const s = join(dir, "s.bin");
    writeFileSync(s, randomBytes(2 * (16 + 32 * 2)));
    expect(
      run("gen", join(dir, "p"), "--source", s, "--encryption-bytes", "16", "--auth-records", "2",
        "--witness-class", "separate-state-file", "--witness-path", wpath).code
    ).toBe(0);
    expect(run("status", join(dir, "p")).stderr).toMatch(/witness class .+ SEPARATE-STATE-FILE/);
  });
});
