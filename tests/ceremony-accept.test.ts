/* ============================================================================
 * truepad2 ceremony accept — the one-way private-handoff acceptance (§17)
 * ----------------------------------------------------------------------------
 * `ceremony create` records that a pair was made by the physical ceremony, but
 * cannot record that the private courier handoff happened — that is a fact only
 * the operator holds, after the media reach their peers. `ceremony accept` is
 * that one-way boundary: on a ceremony pad, the operator asserts the handoff was
 * private and no extra copy exists, and TruePad records delivery = physical
 * private handoff (operator premise). It NEVER observes the courier.
 *
 * These tests pin: it refuses a non-ceremony store, an unreadable-provenance
 * store, and a missing assertion (nothing changes); it writes durable provenance
 * before it reports; it is ONE-WAY (a second accept refuses, delivery unchanged);
 * and its pad-book record says plainly that TruePad recorded an operator
 * assertion and did not observe the courier.
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

// L = 2·(E + 32·N). E=64, N=4 ⇒ 384 bytes; F=48 is a valid fixed record here.
const E = 64;
const N = 4;
const REQUIRED = 2 * (E + 32 * N);
const ALL_ASSERTIONS = ["--assert-offline", "--assert-distinct-physics", "--assert-tmpfs-workspace", "--assert-no-persistent-copy"];

let dir: string;
let mediumA: string;
let mediumB: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-accept-"));
  mediumA = join(dir, "medium-a");
  mediumB = join(dir, "medium-b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

function twoSources(): [string, string] {
  const s1 = join(dir, "s1.bin");
  const s2 = join(dir, "s2.bin");
  const a = new Uint8Array(REQUIRED + 16);
  const b = new Uint8Array(REQUIRED + 16);
  for (let i = 0; i < a.length; i += 1) {
    a[i] = i % 256;
    b[i] = (i * 7 + 3) % 256;
  }
  writeFileSync(s1, a);
  writeFileSync(s2, b);
  return [s1, s2];
}

// Provision a ceremony pair onto both media. Returns nothing; medium A/B now
// carry cli-ceremony provenance with delivery still local-only.
function ceremonyCreate(): void {
  const [s1, s2] = twoSources();
  const r = run(
    "ceremony", "create", join(dir, "ws"),
    "--medium-a", mediumA, "--medium-b", mediumB,
    "--source", s1, "--source", s2,
    "--record-bytes", "48", "--encryption-bytes", String(E), "--auth-records", String(N),
    ...ALL_ASSERTIONS
  );
  expect(r.code, r.stderr).toBe(0);
}

function genStore(at: string): void {
  const s = join(dir, "g.bin");
  writeFileSync(s, new Uint8Array(REQUIRED + 16).fill(0x5c));
  expect(run("gen", at, "--source", s, "--encryption-bytes", String(E), "--auth-records", String(N)).code).toBe(0);
}

const provenanceOf = (medium: string) =>
  JSON.parse(readFileSync(join(medium, "provenance.json"), "utf8")) as { creation: string; delivery: string };

const accept = (medium: string, ...extra: string[]) =>
  run("ceremony", "accept", medium, "--as", "A", "--assert-private-handoff", "--assert-no-extra-copy", ...extra);

describe("ceremony accept records the operator's private-handoff assertion", () => {
  it("on a ceremony pad: exit 0, delivery becomes physical-private, and the record disclaims observing the courier", () => {
    ceremonyCreate();
    expect(provenanceOf(mediumA).delivery).toBe("local-only");

    const r = accept(mediumA);
    expect(r.code, r.stderr).toBe(0);
    // Durable provenance changed to the one-way physical-private delivery.
    expect(provenanceOf(mediumA)).toMatchObject({
      creation: "cli-ceremony",
      delivery: "physical-private-operator-asserted"
    });
    // The pad-book record states plainly that this is an operator assertion and
    // that TruePad did not observe the courier.
    expect(r.stderr).toContain("CEREMONY HANDOFF ACCEPTED");
    expect(r.stderr).toMatch(/did NOT observe the courier/i);
    expect(r.stderr).toContain("--assert-private-handoff");
    expect(r.stderr).toContain("--assert-no-extra-copy");
    expect(r.stderr).toMatch(/one-way/i);
    // The machine line names the new delivery.
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ delivery: "physical-private-operator-asserted" });
  });

  it("is ONE-WAY: a second accept refuses and the delivery does not change", () => {
    ceremonyCreate();
    expect(accept(mediumA).code).toBe(0);
    const before = provenanceOf(mediumA).delivery;

    const second = accept(mediumA);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("refused: ceremony-incomplete");
    expect(second.stderr).toMatch(/already accepted/i);
    expect(provenanceOf(mediumA).delivery).toBe(before);
  });
});

describe("ceremony accept refuses anything but a complete ceremony handoff (nothing changes)", () => {
  it("refuses a plain-gen store — gen is not the physical ceremony (§26)", () => {
    const g = join(dir, "g");
    genStore(g);
    const before = readFileSync(join(g, "provenance.json"), "utf8");
    const r = accept(g);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refused: ceremony-incomplete");
    expect(r.stderr).toMatch(/not created by the physical ceremony/i);
    // Untouched.
    expect(readFileSync(join(g, "provenance.json"), "utf8")).toBe(before);
  });

  it("refuses a store with no provenance at all", () => {
    // A bare directory with no provenance.json.
    const r = accept(dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refused: ceremony-incomplete");
    expect(r.stderr).toMatch(/no readable ceremony provenance/i);
  });

  it("refuses when an operator assertion is missing, and names the missing one", () => {
    ceremonyCreate();
    const r = run("ceremony", "accept", mediumA, "--as", "A", "--assert-private-handoff");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refused: ceremony-incomplete");
    expect(r.stderr).toContain("--assert-no-extra-copy");
    expect(r.stderr).toMatch(/cannot verify/i);
    // Delivery unchanged.
    expect(provenanceOf(mediumA).delivery).toBe("local-only");
  });

  it("refuses without a valid --as role", () => {
    ceremonyCreate();
    const r = run("ceremony", "accept", mediumA, "--assert-private-handoff", "--assert-no-extra-copy");
    // Usage error (missing/invalid --as): exit 1, nothing changed.
    expect(r.code).toBe(1);
    expect(provenanceOf(mediumA).delivery).toBe("local-only");
  });
});
