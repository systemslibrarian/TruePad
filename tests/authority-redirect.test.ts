/* ============================================================================
 * Authority-redirect closure — head.json cannot name an in-pair authority
 * ----------------------------------------------------------------------------
 * `head.json` is an ordinary, unauthenticated pair-directory file. A skeptical
 * review found that an attacker bounded to pair-directory writes could forge a
 * whole platform-witness state file INSIDE the pair directory (with the readable
 * current TPM anchor and a fabricated `handoff-accepted` assurance map) and
 * redirect `head.json`'s `rollback.config.statePath` at it — laundering a
 * plain-gen pair to CONDITIONALLY ELIGIBLE.
 *
 * The closure: the independent authority is, by definition, EXTERNAL to the pair
 * directory (an attacker bounded to pair-directory writes cannot create an
 * external one). A witness/authority state file whose path resolves inside the
 * pair directory is rejected everywhere it is consumed — the deployment
 * assessment reads it as `inconsistent` (NOT ELIGIBLE), and burn/open/retire
 * refuse it (`witness-unsupported`). These tests reproduce the exact attack and
 * pin both closures. No TPM is needed: the containment check short-circuits
 * before any TPM call.
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");
const NAME = "000b" + "cd".repeat(16);
const NV = "0x01500016";
const AID = "0123456789abcdef0123456789abcdef";

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-redirect-"));
  store = join(dir, "g");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

// A plain-gen pair, then the full same-pair authority-redirect attack applied
// with pair-directory writes only. `authorityStatePath` is where the forged
// state file is placed and where head.json is pointed.
function forgeRedirect(authorityStatePath: string): string {
  const src = join(dir, "s.bin");
  writeFileSync(src, new Uint8Array(2 * (64 + 32 * 4)).fill(0x5c));
  expect(run("gen", store, "--source", src, "--encryption-bytes", "64", "--auth-records", "4").code).toBe(0);
  const pid = (JSON.parse(readFileSync(join(store, "a-to-b", "head.json"), "utf8")) as { pairId: string }).pairId;

  writeFileSync(
    authorityStatePath,
    JSON.stringify({
      formatVersion: 1,
      provider: "tpm2-nv-counter-v1",
      authorityId: AID,
      nvIndex: NV,
      nvName: NAME,
      anchor: "42",
      witness: {},
      assurance: { [pid]: { level: "handoff-accepted" } }
    })
  );
  for (const d of ["a-to-b", "b-to-a"]) {
    const hp = join(store, d, "head.json");
    const h = JSON.parse(readFileSync(hp, "utf8"));
    h.rollback = {
      witnessClass: "platform-monotonic",
      config: { provider: "tpm2-nv-counter-v1", statePath: authorityStatePath, nvIndex: NV, nvName: NAME, authorityId: AID }
    };
    writeFileSync(hp, JSON.stringify(h));
  }
  writeFileSync(
    join(store, "provenance.json"),
    JSON.stringify({
      provenanceVersion: 1,
      pairId: pid,
      creation: "cli-ceremony",
      source: "external-declared",
      delivery: "physical-private-operator-asserted",
      sealedAncestor: false,
      ceremonyPremises: "accepted",
      createdAt: "2026-09-02T00:00:00.000Z"
    })
  );
  return pid;
}

describe("a forged authority INSIDE the pair directory cannot launder a pair to gold", () => {
  it("status reads it as inconsistent → NOT ELIGIBLE, never CONDITIONALLY ELIGIBLE", () => {
    forgeRedirect(join(store, "evil.json")); // authority placed inside the pair dir
    const e = run("status", store).stderr;
    expect(e).not.toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toContain("NOT ELIGIBLE");
    expect(e).toMatch(/rollback authority .+ platform-monotonic \(inconsistent\)/);
    expect(e).toMatch(/ceremony assurance .+ inconsistent/);
  });

  it("burn refuses an in-pair-directory rollback authority (so the redirect cannot escape rollback protection)", () => {
    forgeRedirect(join(store, "evil.json"));
    const r = run("burn", store, "--as", "A", "hi");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refused: witness-unsupported");
    expect(r.stderr).toMatch(/inside the pair directory/i);
  });

  it("a nested in-pair path (under a subdirectory) is also rejected", () => {
    forgeRedirect(join(store, "a-to-b", "evil.json"));
    expect(run("status", store).stderr).toContain("NOT ELIGIBLE");
    expect(run("burn", store, "--as", "A", "hi").stderr).toMatch(/inside the pair directory/i);
  });
});
