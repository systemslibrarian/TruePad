/* ============================================================================
 * truepad2 status — MESSAGE LENGTH PRIVACY, and its independence from Shannon
 * ----------------------------------------------------------------------------
 * A fixed record size is metadata hardening: it hides the exact plaintext
 * length of each message, while record count and timing stay visible. It is a
 * SEPARATE axis from the Shannon deployment assessment — a variable record does
 * not make the deployment "not eligible", and a fixed record does not make it
 * "eligible".
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-fixed-status-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}
function source(bytes: number): string {
  const p = join(dir, `s-${bytes}-${Math.floor(bytes / 7)}.bin`);
  writeFileSync(p, randomBytes(bytes));
  return p;
}

describe("MESSAGE LENGTH PRIVACY section", () => {
  it("a FIXED store names the record size, max plaintext, and what stays visible", () => {
    const pair = join(dir, "pf");
    expect(
      run("gen", pair, "--source", source(20000), "--encryption-bytes", "8192", "--auth-records", "2", "--record-bytes", "4096").code
    ).toBe(0);
    const e = run("status", pair).stderr;
    expect(e).toContain("MESSAGE LENGTH PRIVACY");
    expect(e).toMatch(/record policy .+ FIXED/);
    expect(e).toMatch(/record size .+ 4096 bytes/);
    expect(e).toMatch(/max plaintext per record .+ 4092 bytes/);
    expect(e).toMatch(/exact plaintext length .+ hidden inside the OTP-encrypted frame/);
    expect(e).toMatch(/record count .+ visible/);
    expect(e).toMatch(/timing .+ visible/);
    // The overclaim correction: it must NOT say timing/record-count are hidden.
    expect(e).not.toMatch(/timing .+ hidden/i);
    expect(e).toMatch(/not what makes the\s+one-time-pad theorem apply/);
  });

  it("a VARIABLE store says the exact plaintext length is exposed", () => {
    const pair = join(dir, "pv");
    expect(run("gen", pair, "--source", source(400), "--encryption-bytes", "32", "--auth-records", "2").code).toBe(0);
    const e = run("status", pair).stderr;
    expect(e).toMatch(/record policy .+ VARIABLE/);
    expect(e).toMatch(/exact plaintext length .+ exposed by ciphertext length/);
    expect(e).toMatch(/record count .+ visible/);
  });

  it("(§10) the Browser fixed-length copy is corrected — no 'length reveals nothing' overclaim", () => {
    const src = readFileSync(resolve(ROOT, "src/browser/ui/create-pair.ts"), "utf8");
    // The old overclaim must be gone.
    expect(src).not.toMatch(/length reveals nothing/i);
    // Fixed is offered as the stronger length-privacy option, states the cost,
    // and admits timing / message count stay visible.
    expect(src).toMatch(/stronger length privacy/i);
    expect(src).toMatch(/hiding its exact length/i);
    expect(src).toMatch(/spends the full record size of pad/i);
    expect(src).toMatch(/Timing and the number of messages are still visible/i);
  });

  it("(§11) record policy does NOT change the deployment assessment", () => {
    // A fixed and a variable store are BOTH plain-gen pads, so both are NOT
    // ELIGIBLE (gen is not the physical ceremony, §3/§26). The point of §11 is
    // that the record policy — a length-privacy axis — does not move the
    // deployment assessment either way. Fixed does not upgrade it; variable does
    // not downgrade it. They must land on the SAME verdict.
    const pf = join(dir, "pf2");
    const pv = join(dir, "pv2");
    expect(
      run("gen", pf, "--source", source(20000), "--encryption-bytes", "8192", "--auth-records", "2", "--record-bytes", "4096").code
    ).toBe(0);
    expect(run("gen", pv, "--source", source(400), "--encryption-bytes", "32", "--auth-records", "2").code).toBe(0);
    for (const pair of [pf, pv]) {
      const e = run("status", pair).stderr;
      expect(e, `${pair} deployment`).toContain("DEPLOYMENT ASSESSMENT");
      // Identical deployment verdict regardless of record policy.
      expect(e, `${pair} verdict`).toContain("NOT ELIGIBLE");
      expect(e, `${pair} not laundered`).not.toMatch(/CONDITIONALLY ELIGIBLE/);
      // And the reason is the creation path (gen), never the record policy.
      expect(e, `${pair} reason`).toMatch(/Why not stronger:.*plain gen/);
    }
  });
});
