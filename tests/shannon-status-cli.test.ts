/* ============================================================================
 * truepad2 status — the DEPLOYMENT ASSESSMENT section
 * ----------------------------------------------------------------------------
 * status assembles a pad's recorded provenance and live facts and hands them to
 * the single evaluator, printing the derived assessment to stderr — without
 * touching the stdout machine line (whose shape is a contract) and without ever
 * writing a stored verdict.
 *
 * The load-bearing distinction (§3/§26): a plain `truepad2 gen` store is NOT
 * ELIGIBLE ("plain gen, not the physical ceremony"); only a `ceremony create`
 * pad whose private handoff has been accepted, with an independent rollback
 * witness, reaches CONDITIONALLY ELIGIBLE — and even then the physical premises
 * TruePad did not prove are printed beside it. gen never masquerades as ceremony.
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

// Provision a full ceremony pair onto media mA/mB with a separate-state-file
// witness. Returns the medium-A directory (a peer copy carrying cli-ceremony
// provenance, delivery still local-only until it is accepted).
function ceremonyMediumA(): string {
  const s1 = join(dir, "cs1.bin");
  const s2 = join(dir, "cs2.bin");
  writeFileSync(s1, randomBytes(2 * (8192 + 32 * 4)));
  writeFileSync(s2, randomBytes(2 * (8192 + 32 * 4)));
  const w = join(dir, "cw.json");
  expect(run("witness", "init", w).code).toBe(0);
  const mA = join(dir, "mA");
  const r = run(
    "ceremony", "create", join(dir, "ws"),
    "--medium-a", mA, "--medium-b", join(dir, "mB"),
    "--source", s1, "--source", s2,
    "--record-bytes", "4096", "--encryption-bytes", "8192", "--auth-records", "4",
    "--witness-class", "separate-state-file", "--witness-path", w,
    "--assert-offline", "--assert-distinct-physics", "--assert-tmpfs-workspace", "--assert-no-persistent-copy"
  );
  expect(r.code, r.stderr).toBe(0);
  return mA;
}

describe("status shows a derived DEPLOYMENT ASSESSMENT section", () => {
  it("(§3) a plain gen store is NOT ELIGIBLE — gen is not the physical ceremony", () => {
    gen("p", 16, 2);
    const st = run("status", join(dir, "p"));
    expect(st.code).toBe(0);
    const e = st.stderr;
    expect(e).toContain("DEPLOYMENT ASSESSMENT");
    expect(e).toMatch(/literal one-time-pad XOR .+ YES/);
    expect(e).toMatch(/one-time Wegman-Carter .+ YES/);
    expect(e).toMatch(/creation path .+ CLI plain gen/);
    expect(e).toContain("NOT ELIGIBLE");
    expect(e).not.toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toMatch(/Why not stronger:.*plain gen/);
  });

  it("(F) a ceremony pad whose handoff has been accepted is CONDITIONALLY ELIGIBLE, with the physical premises left unproven", () => {
    const mA = ceremonyMediumA();
    // Before acceptance: the ceremony exists but the private handoff is not recorded.
    expect(run("status", mA).stderr).toContain("INSUFFICIENT EVIDENCE");

    expect(
      run("ceremony", "accept", mA, "--as", "A", "--assert-private-handoff", "--assert-no-extra-copy").code
    ).toBe(0);

    const e = run("status", mA).stderr;
    expect(e).toMatch(/creation path .+ CLI physical ceremony/);
    expect(e).toMatch(/delivery .+ physical private handoff \(operator premise\)/);
    expect(e).toMatch(/live storage authority .+ NATIVE/);
    expect(e).toMatch(/witness class .+ SEPARATE-STATE-FILE/);
    expect(e).toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toMatch(/has not proved physical randomness/);
    // §40 — the label never appears without the unproven physical premises beside it.
    expect(e).toMatch(/did NOT prove these physical premises/);
    expect(e).toMatch(/courier handoff was actually private/);
    expect(e).toMatch(/physically erased on retirement/);
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
