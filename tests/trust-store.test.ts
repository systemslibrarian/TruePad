/* ============================================================================
 * Host trust store + authority resolution — the pinned root of trust
 * ----------------------------------------------------------------------------
 * A pair must not choose its own root of trust. The trust store pins the ONE
 * platform authority the installation trusts; `resolvePlatformAuthority` compares
 * a pair's CLAIMED authority against the pin and returns a trusted config built
 * FROM THE PIN (so the read location is the pinned one, never head.json's).
 * These tests pin the store's strict fail-closed reader and the resolution table.
 * ========================================================================= */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTrustPin, removeTrustPin, writeTrustPin, type TrustPin } from "../src/cli/v2/trust-store";
import { resolvePlatformAuthority, type PlatformConfig } from "../src/cli/v2/platform-witness";

const NAME = "000b" + "cd".repeat(16);
const PIN: TrustPin = {
  trustVersion: 1,
  provider: "tpm2-nv-counter-v1",
  authorityId: "0123456789abcdef0123456789abcdef",
  nvIndex: "0x01500016",
  nvName: NAME,
  statePath: "/opt/truepad/trusted-authority.json"
};
const claimed = (over: Partial<PlatformConfig> = {}): PlatformConfig => ({
  provider: PIN.provider,
  statePath: "/somewhere/pair-named-state.json", // head.json's location — must be IGNORED
  nvIndex: PIN.nvIndex,
  nvName: PIN.nvName,
  authorityId: PIN.authorityId,
  ...over
});

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-trust-"));
  store = join(dir, "trust.json");
  process.env.TRUEPAD_TRUST_STORE = store;
});
afterEach(() => {
  delete process.env.TRUEPAD_TRUST_STORE;
  rmSync(dir, { recursive: true, force: true });
});
const writeRaw = (text: string): void => writeFileSync(store, text);

describe("the trust store is strict and fails closed", () => {
  it("round-trips a pin", () => {
    writeTrustPin(PIN);
    expect(readTrustPin()).toEqual(PIN);
  });

  it("a missing pin reads null (unpinned)", () => {
    expect(readTrustPin()).toBeNull();
  });

  it("rejects a torn / extra-key / wrong-version / bad-identity pin", () => {
    writeRaw('{"trustVersion":1,"provider":"tpm2');
    expect(readTrustPin()).toBeNull();
    writeRaw(JSON.stringify({ ...PIN, extra: 1 }));
    expect(readTrustPin()).toBeNull();
    writeRaw(JSON.stringify({ ...PIN, trustVersion: 2 }));
    expect(readTrustPin()).toBeNull();
    writeRaw(JSON.stringify({ ...PIN, provider: "something-else" }));
    expect(readTrustPin()).toBeNull();
    writeRaw(JSON.stringify({ ...PIN, authorityId: "not-hex" }));
    expect(readTrustPin()).toBeNull();
    writeRaw(JSON.stringify({ ...PIN, statePath: "relative/path.json" }));
    expect(readTrustPin()).toBeNull();
  });

  it("removeTrustPin unpins", () => {
    writeTrustPin(PIN);
    expect(readTrustPin()).not.toBeNull();
    removeTrustPin();
    expect(readTrustPin()).toBeNull();
  });
});

describe("resolvePlatformAuthority — a pair cannot choose the trust root", () => {
  it("no pin ⇒ unpinned", () => {
    expect(resolvePlatformAuthority(claimed()).trust).toBe("unpinned");
  });

  it("a pair naming the pinned authority ⇒ trusted, and the config uses the PIN's statePath (not head's)", () => {
    writeTrustPin(PIN);
    const res = resolvePlatformAuthority(claimed());
    expect(res.trust).toBe("trusted");
    if (res.trust === "trusted") {
      expect(res.config.statePath).toBe(PIN.statePath); // NOT the pair's "/somewhere/..." path
      expect(res.config.authorityId).toBe(PIN.authorityId);
    }
  });

  it("a pair naming ANY other authority ⇒ mismatched (authorityId, nvIndex, nvName, provider each)", () => {
    writeTrustPin(PIN);
    expect(resolvePlatformAuthority(claimed({ authorityId: "ffffffffffffffffffffffffffffffff" })).trust).toBe("mismatched");
    expect(resolvePlatformAuthority(claimed({ nvIndex: "0x01500099" })).trust).toBe("mismatched");
    expect(resolvePlatformAuthority(claimed({ nvName: "000b" + "ab".repeat(16) })).trust).toBe("mismatched");
  });

  it("redirecting ONLY the statePath does not help — resolution ignores it and uses the pin's", () => {
    writeTrustPin(PIN);
    const res = resolvePlatformAuthority(claimed({ statePath: "/tmp/attacker-controlled.json" }));
    expect(res.trust).toBe("trusted");
    if (res.trust === "trusted") expect(res.config.statePath).toBe(PIN.statePath);
  });
});
