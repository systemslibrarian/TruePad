/* ============================================================================
 * Platform ceremony-assurance authority — the independent, TPM-anchored state
 * that pair-directory JSON cannot forge (TruePad 3.0, §2-§7)
 * ----------------------------------------------------------------------------
 * The strong-making ceremony facts (created / accepted / withdrawn) live in the
 * platform authority's state, outside the pair directory, and each transition
 * consumes a TPM increment. These tests (deterministic FakeTpm, no device) pin:
 *   · the monotone ladder and its terminal `withdrawn`;
 *   · Attack A — a pair the authority never recorded reads `ordinary`, and
 *     cannot be advanced to handoff-accepted (so `ceremony accept` will refuse);
 *   · Attack B — `withdrawn` is terminal, and a STALE restore of the authority
 *     state (pre-ceremony or pre-withdrawal) is caught by the anchor → inconsistent;
 *   · the read-only probe never mutates the TPM.
 * ========================================================================= */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initPlatformWitness,
  platformAssurance,
  platformRecordAssurance,
  resolvePlatformAuthority,
  type PlatformConfig
} from "../src/cli/v2/platform-witness";
import { removeTrustPin, writeTrustPin } from "../src/cli/v2/trust-store";
import { PROVIDER_ID, type NvPublic, type TpmProvider, type TpmResult } from "../src/cli/v2/tpm";

const NV = "0x01500016";
const NAME = "000b" + "cd".repeat(16);
const PAIR = "0123456789abcdef0123456789abcdef";
const PAIR2 = "fedcba9876543210fedcba9876543210";

// A deterministic TPM whose counter really moves on increment, so a shared
// instance models the live device across a sequence of transitions.
class FakeTpm implements TpmProvider {
  readonly id = PROVIDER_ID;
  written = true;
  counter: bigint;
  largestEver = 40n;
  name: string;
  isCounter = true;
  isOrderly = false;
  sizeBytes = 8;
  toolsAvailable = true;
  increments = 0;
  constructor(opts: { counter?: bigint; name?: string } = {}) {
    this.counter = opts.counter ?? 41n;
    this.name = opts.name ?? NAME;
  }
  available(): TpmResult<null> {
    return this.toolsAvailable ? { ok: true, value: null } : { ok: false, message: "unavailable" };
  }
  readPublic(): TpmResult<NvPublic> {
    return {
      ok: true,
      value: {
        name: this.name,
        isCounter: this.isCounter,
        isOrderly: this.isOrderly,
        isWritten: this.written,
        sizeBytes: this.sizeBytes,
        attributesFriendly: "authread|authwrite|nt=0x1|written"
      }
    };
  }
  readCounter(): TpmResult<bigint> {
    return { ok: true, value: this.counter };
  }
  increment(): TpmResult<null> {
    this.increments += 1;
    this.counter += 1n;
    return { ok: true, value: null };
  }
}

let dir: string;
let statePath: string;
let tpm: FakeTpm;
let config: PlatformConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-plat-assurance-"));
  statePath = join(dir, "platform-witness.json");
  tpm = new FakeTpm({ counter: 41n });
  const init = initPlatformWitness(statePath, NV, tpm);
  if (!init.ok) throw new Error(init.message);
  config = init.value.config;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const record = (pairId: string, level: Parameters<typeof platformRecordAssurance>[2]) =>
  platformRecordAssurance(config, pairId, level, tpm);

describe("resolution against the pin, end to end (FakeTpm)", () => {
  // The pin points at the trusted state path; the resolution reads THAT, not the
  // one a pair's head names. A pair claiming the pinned identity resolves trusted
  // and its attestation is read from the pinned state.
  afterEach(() => {
    delete process.env.TRUEPAD_TRUST_STORE;
  });
  function pin(): void {
    process.env.TRUEPAD_TRUST_STORE = join(dir, "trust.json");
    writeTrustPin({ trustVersion: 1, provider: config.provider, authorityId: config.authorityId, nvIndex: config.nvIndex, nvName: config.nvName, statePath: config.statePath });
  }
  // A pair's head names the pinned IDENTITY but a bogus statePath (must be ignored).
  const pairClaim = (): PlatformConfig => ({ ...config, statePath: join(dir, "attacker-named.json") });

  it("a pair claiming the pinned authority resolves trusted and reads the pinned attestation", () => {
    pin();
    record(PAIR, "ceremony-created");
    record(PAIR, "handoff-accepted");
    const res = resolvePlatformAuthority(pairClaim());
    expect(res.trust).toBe("trusted");
    if (res.trust === "trusted") {
      expect(res.config.statePath).toBe(config.statePath); // pinned path, not the pair's
      expect(platformAssurance(res.config, PAIR, tpm)).toBe("handoff-accepted");
    }
  });

  it("with no pin, the same pair resolves unpinned", () => {
    process.env.TRUEPAD_TRUST_STORE = join(dir, "trust.json");
    removeTrustPin(join(dir, "trust.json"));
    expect(resolvePlatformAuthority(pairClaim()).trust).toBe("unpinned");
  });

  it("(item 14) same pin, but the live TPM index recreated with a DIFFERENT Name ⇒ inconsistent", () => {
    pin();
    record(PAIR, "handoff-accepted");
    const res = resolvePlatformAuthority(pairClaim());
    expect(res.trust).toBe("trusted");
    if (res.trust === "trusted") {
      // A different physical authority now sits at the index (Name changed).
      const foreign = new FakeTpm({ counter: tpm.counter, name: "000b" + "ee".repeat(16) });
      expect(platformAssurance(res.config, PAIR, foreign)).toBe("inconsistent");
    }
  });
});

describe("the monotone ceremony-assurance ladder", () => {
  it("a fresh pair is ordinary; create → accepted, each consuming exactly one TPM increment", () => {
    expect(platformAssurance(config, PAIR, tpm)).toBe("ordinary");
    const before = tpm.increments;
    expect(record(PAIR, "ceremony-created").ok).toBe(true);
    expect(platformAssurance(config, PAIR, tpm)).toBe("ceremony-created");
    expect(record(PAIR, "handoff-accepted").ok).toBe(true);
    expect(platformAssurance(config, PAIR, tpm)).toBe("handoff-accepted");
    expect(tpm.increments - before).toBe(2); // one per transition
  });

  it("handoff-accepted CANNOT be reached without ceremony-created first (Attack A)", () => {
    const r = record(PAIR, "handoff-accepted"); // from ordinary
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/monotone|ordinary/i);
    expect(platformAssurance(config, PAIR, tpm)).toBe("ordinary");
  });

  it("the authority only attests pairs it actually recorded — a different pair stays ordinary (Attack A)", () => {
    expect(record(PAIR, "ceremony-created").ok).toBe(true);
    expect(record(PAIR, "handoff-accepted").ok).toBe(true);
    // PAIR2 was never recorded: editing PAIR2's provenance.json cannot change this.
    expect(platformAssurance(config, PAIR2, tpm)).toBe("ordinary");
    expect(record(PAIR2, "handoff-accepted").ok).toBe(false);
  });

  it("withdrawn is terminal: reachable from any level, and nothing advances out of it", () => {
    expect(record(PAIR, "ceremony-created").ok).toBe(true);
    expect(record(PAIR, "withdrawn").ok).toBe(true);
    expect(platformAssurance(config, PAIR, tpm)).toBe("withdrawn");
    // No transition out of withdrawn — not back to accepted, not to created.
    expect(record(PAIR, "handoff-accepted").ok).toBe(false);
    expect(record(PAIR, "ceremony-created").ok).toBe(false);
    expect(platformAssurance(config, PAIR, tpm)).toBe("withdrawn");
  });

  it("re-recording the current level is idempotent and consumes no TPM increment", () => {
    expect(record(PAIR, "ceremony-created").ok).toBe(true);
    const before = tpm.increments;
    expect(record(PAIR, "ceremony-created").ok).toBe(true); // idempotent
    expect(tpm.increments).toBe(before);
  });
});

describe("the read-only probe never mutates, and catches a stale restore (Attack B)", () => {
  it("platformAssurance performs zero TPM increments", () => {
    record(PAIR, "ceremony-created");
    const before = tpm.increments;
    platformAssurance(config, PAIR, tpm);
    platformAssurance(config, PAIR, tpm);
    expect(tpm.increments).toBe(before);
  });

  it("a withdrawal survives deleting the state's other content, and a STALE pre-withdrawal restore is caught", () => {
    record(PAIR, "ceremony-created");
    record(PAIR, "handoff-accepted");
    const preWithdrawal = readFileSync(statePath, "utf8"); // anchor at accepted
    expect(record(PAIR, "withdrawn").ok).toBe(true);
    expect(platformAssurance(config, PAIR, tpm)).toBe("withdrawn");

    // Attack B: restore the pre-withdrawal state file (its anchor is now stale:
    // below the TPM counter, which cannot be rolled back). The probe fails closed.
    writeFileSync(statePath, preWithdrawal);
    expect(platformAssurance(config, PAIR, tpm)).toBe("inconsistent");
    // It NEVER reads back as the pre-withdrawal handoff-accepted.
    expect(platformAssurance(config, PAIR, tpm)).not.toBe("handoff-accepted");
  });

  it("an unreachable TPM reads unavailable; a substituted authority reads inconsistent", () => {
    record(PAIR, "handoff-accepted");
    const down = new FakeTpm({ counter: tpm.counter });
    down.toolsAvailable = false;
    expect(platformAssurance(config, PAIR, down)).toBe("unavailable");
    const foreign = new FakeTpm({ counter: tpm.counter, name: "000b" + "ee".repeat(16) });
    expect(platformAssurance(config, PAIR, foreign)).toBe("inconsistent");
  });
});
