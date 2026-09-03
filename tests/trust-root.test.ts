/* ============================================================================
 * Root of trust — a pair cannot select its own platform authority (CLI level)
 * ----------------------------------------------------------------------------
 * The residual after the 3.0 authority closure: an attacker bounded to
 * pair-directory writes could point head.json at a DIFFERENT, internally-valid
 * external TPM authority (their own), pre-loaded with the victim pairId, and
 * reach gold. The fix pins the installation's trusted authority OUTSIDE the pair
 * directory; every platform operation resolves the pair's CLAIMED authority
 * against the pin and uses the PINNED state (never head.json's).
 *
 * These CLI tests exercise the security REJECTIONS, which are decided by a pure
 * public-identity comparison and so need no TPM: a pair naming any authority but
 * the pinned one is NOT ELIGIBLE (status) and refused (burn); an unpinned
 * installation is INSUFFICIENT and refuses platform burns. (The positive gold
 * path needs a live TPM and is covered by FakeTpm unit tests + swtpm interop.)
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");
const NAME_X = "000b" + "cd".repeat(16);
const NAME_Y = "000b" + "ab".repeat(16);
const AUTH_X = "0123456789abcdef0123456789abcdef";
const AUTH_Y = "ffffffffffffffffffffffffffffffff";

let dir: string;
let store: string;
let trust: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-troot-"));
  store = join(dir, "g");
  trust = join(dir, "trust.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Every run carries the per-test trust-store path via the environment.
function run(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], {
    encoding: "utf8",
    env: { ...process.env, TRUEPAD_TRUST_STORE: trust }
  });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

// A gen pair whose head.json is rewritten to CLAIM a platform authority, and
// whose provenance is forged into a full ceremony story.
function pairClaiming(cfg: { authorityId: string; nvIndex: string; nvName: string; statePath: string }): void {
  const src = join(dir, "s.bin");
  writeFileSync(src, new Uint8Array(2 * (64 + 32 * 4)).fill(0x5c));
  expect(run("gen", store, "--source", src, "--encryption-bytes", "64", "--auth-records", "4").code).toBe(0);
  const pid = (JSON.parse(readFileSync(join(store, "a-to-b", "head.json"), "utf8")) as { pairId: string }).pairId;
  for (const d of ["a-to-b", "b-to-a"]) {
    const hp = join(store, d, "head.json");
    const h = JSON.parse(readFileSync(hp, "utf8"));
    h.rollback = { witnessClass: "platform-monotonic", config: { provider: "tpm2-nv-counter-v1", ...cfg } };
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
}
function pinAuthority(id: { authorityId: string; nvIndex: string; nvName: string; statePath: string }): void {
  writeFileSync(trust, JSON.stringify({ trustVersion: 1, provider: "tpm2-nv-counter-v1", ...id }));
}
const dep = (): string => run("status", store).stderr.match(/Deployment assessment \(derived\)\s*\n\s*([A-Z ]+)/)?.[1]?.trim() ?? "";

describe("a pair naming an authority other than the pinned one is NOT ELIGIBLE and refuses to burn", () => {
  it("(substitution) pinned=Y, pair claims X ⇒ NOT ELIGIBLE (UNTRUSTED), burn refused", () => {
    pinAuthority({ authorityId: AUTH_Y, nvIndex: "0x01500099", nvName: NAME_Y, statePath: "/opt/truepad/trusted.json" });
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: join(dir, "attacker.json") });
    const e = run("status", store).stderr;
    expect(e).toContain("NOT ELIGIBLE");
    expect(e).not.toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toMatch(/ceremony assurance .+ UNTRUSTED/);
    const b = run("burn", store, "--as", "A", "hi");
    expect(b.code).toBe(2);
    expect(b.stderr).toMatch(/may not choose the trust root/i);
  });

  it("(foreign authority with victim pairId) redirecting every field to authority X, pinned=Y ⇒ still UNTRUSTED", () => {
    // Even if the attacker's external authority (X) genuinely attests the victim
    // pairId, X is not the pinned authority Y — so it is rejected outright.
    pinAuthority({ authorityId: AUTH_Y, nvIndex: "0x01500099", nvName: NAME_Y, statePath: "/opt/truepad/trusted.json" });
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: "/tmp/attacker-real-tpm-state.json" });
    expect(dep()).toBe("NOT ELIGIBLE");
  });
});

describe("an unpinned or malformed-pin installation never treats a platform pair as gold", () => {
  it("(no pin) ⇒ INSUFFICIENT, and platform burn refuses (no TOFU from the pair)", () => {
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: "/tmp/x.json" });
    const e = run("status", store).stderr;
    expect(e).toContain("INSUFFICIENT EVIDENCE");
    expect(e).not.toContain("CONDITIONALLY ELIGIBLE");
    expect(e).toMatch(/ceremony assurance .+ unavailable/);
    const b = run("burn", store, "--as", "A", "hi");
    expect(b.code).toBe(2);
    expect(b.stderr).toMatch(/no trusted platform authority is pinned/i);
  });

  it("(malformed pin) is treated as no pin ⇒ INSUFFICIENT, never gold", () => {
    writeFileSync(trust, "{ not json");
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: "/tmp/x.json" });
    expect(dep()).toBe("INSUFFICIENT EVIDENCE");
  });

  it("(no TOFU) status does not create a trust pin from an untrusted pair", () => {
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: "/tmp/x.json" });
    run("status", store);
    // The trust file was never written by opening/statusing a pair.
    expect(() => readFileSync(trust, "utf8")).toThrow();
  });
});

describe("an in-pair or redirected state file is never consulted — the pin's location is", () => {
  it("pinned=X, pair claims X but redirects statePath to an in-pair forged authority ⇒ never gold (reads the pin's state)", () => {
    // The pin names X's real external state; the pair points head.statePath at a
    // forged in-pair file. Resolution ignores head's path and reads the pin's —
    // which (no TPM here) is unavailable ⇒ INSUFFICIENT, never CONDITIONALLY.
    pinAuthority({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: "/opt/truepad/real-x-state.json" });
    pairClaiming({ authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, statePath: join(store, "evil.json") });
    // craft the in-pair forged authority (which must NEVER be read)
    writeFileSync(
      join(store, "evil.json"),
      JSON.stringify({ formatVersion: 1, provider: "tpm2-nv-counter-v1", authorityId: AUTH_X, nvIndex: "0x01500016", nvName: NAME_X, anchor: "42", witness: {}, assurance: {} })
    );
    expect(dep()).not.toBe("CONDITIONALLY ELIGIBLE");
  });
});
