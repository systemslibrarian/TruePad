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

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  JSON.parse(readFileSync(join(medium, "provenance.json"), "utf8")) as { creation: string; delivery: string; pairId: string };
const readPairId = (medium: string): string =>
  (JSON.parse(readFileSync(join(medium, "a-to-b", "head.json"), "utf8")) as { pairId: string }).pairId;

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

  it("(§4) two concurrent accepts are serialized: exactly one transition wins", async () => {
    ceremonyCreate();
    // Launch two accepts on the same medium at once. The pair lock serializes
    // them: exactly one commits the delivery change (exit 0); the other refuses,
    // either because it could not take the lock or because — running after the
    // first committed — it observes an already-accepted delivery.
    const runAsync = (): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolveP) => {
        const child = spawn(
          process.execPath,
          [LAUNCHER, "ceremony", "accept", mediumA, "--as", "A", "--assert-private-handoff", "--assert-no-extra-copy"],
          { encoding: "utf8" } as never
        );
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (code: number | null) => resolveP({ code, stderr }));
      });
    const [a, b] = await Promise.all([runAsync(), runAsync()]);
    const winners = [a, b].filter((r) => r.code === 0);
    const losers = [a, b].filter((r) => r.code !== 0);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].stderr).toMatch(/locked|already accepted/i);
    // The durable delivery reflects exactly one committed transition.
    expect(provenanceOf(mediumA).delivery).toBe("physical-private-operator-asserted");
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

  it("refuses a ceremony pair whose provenance has been removed (no readable provenance)", () => {
    ceremonyCreate();
    rmSync(join(mediumA, "provenance.json"));
    const r = accept(mediumA);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refused: ceremony-incomplete");
    expect(r.stderr).toMatch(/no readable ceremony provenance/i);
  });

  it("refuses a directory that is not a whole pair (only a valid-looking provenance.json)", () => {
    // §4-D: withPair requires a structurally complete pair BEFORE any provenance
    // mutation; a lone provenance file next to no store is not acceptable.
    ceremonyCreate();
    const fake = join(dir, "fake");
    mkdirSync(fake, { recursive: true });
    cpSync(join(mediumA, "provenance.json"), join(fake, "provenance.json"));
    const r = accept(fake);
    expect(r.code).toBe(2);
    // A no-store / half-pair refusal from the pair authority, not a delivery change.
    expect(r.stderr).toMatch(/no v2 pad pair|half-pair/i);
  });

  it("refuses a pair whose provenance is bound to a DIFFERENT pair (§1 transplant)", () => {
    // Build two ceremony pairs; transplant pair A's provenance onto pair B.
    ceremonyCreate(); // mediumA / mediumB is pair 1
    const other = join(dir, "other");
    const otherB = join(dir, "otherB");
    const s1 = join(dir, "o1.bin");
    const s2 = join(dir, "o2.bin");
    const a = new Uint8Array(REQUIRED + 16);
    const b = new Uint8Array(REQUIRED + 16);
    for (let i = 0; i < a.length; i += 1) {
      a[i] = (i * 3 + 1) % 256;
      b[i] = (i * 5 + 2) % 256;
    }
    writeFileSync(s1, a);
    writeFileSync(s2, b);
    expect(
      run("ceremony", "create", join(dir, "ws2"), "--medium-a", other, "--medium-b", otherB,
        "--source", s1, "--source", s2, "--record-bytes", "48", "--encryption-bytes", String(E),
        "--auth-records", String(N), ...ALL_ASSERTIONS).code
    ).toBe(0);
    // Transplant pair 1's provenance onto pair 2's medium.
    cpSync(join(mediumA, "provenance.json"), join(other, "provenance.json"));
    const r = accept(other);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/bound to pair .+ not to this pair/i);
    // And the transplanted provenance did not raise pair 2's status.
    expect(run("status", other).stderr).toContain("INSUFFICIENT EVIDENCE");
  });

  it("refuses a withdrawn pair (§5) — a permanent downgrade cannot re-accept", () => {
    ceremonyCreate();
    expect(run("ceremony", "withdraw", mediumA, "--as", "A", "--reason", "test").code).toBe(0);
    const r = accept(mediumA);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/withdrawn/i);
    expect(provenanceOf(mediumA).delivery).toBe("local-only");
  });

  it("refuses a destroyed pair (§4) — the tombstone is checked before any provenance mutation", () => {
    ceremonyCreate();
    expect(run("destroy", mediumA, "--confirm", readPairId(mediumA)).code).toBe(0);
    const r = accept(mediumA);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/destroyed/i);
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
