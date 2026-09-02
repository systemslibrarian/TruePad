/* ============================================================================
 * platformHealth — the READ-ONLY live-witness probe for the deployment evaluator
 * ----------------------------------------------------------------------------
 * The strongest verdict depends on CURRENT live platform-monotonic health, not
 * merely the configured class (§2/§3). `platformHealth` answers that without
 * mutating: it never increments the TPM and never settles a prepared commit.
 * These tests (deterministic FakeTpm, no device) pin the mapping —
 *   healthy · unreachable · regressed · inconsistent —
 * and prove the probe performs ZERO TPM increments.
 * ========================================================================= */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initPlatformWitness, platformHealth, type PlatformConfig } from "../src/cli/v2/platform-witness";
import { PROVIDER_ID, type NvPublic, type TpmProvider, type TpmResult } from "../src/cli/v2/tpm";

const NV = "0x01500016";
const NAME = "000b" + "cd".repeat(16);
const PAIR = "0123456789abcdef0123456789abcdef";

// A deterministic, read-only-friendly TPM. Increments are counted so tests can
// prove the health probe never mutates.
class FakeTpm implements TpmProvider {
  readonly id = PROVIDER_ID;
  written = true;
  counter: bigint;
  largestEver = 40n;
  name: string;
  isCounter = true;
  isOrderly = false;
  sizeBytes = 8;
  present = true;
  toolsAvailable = true;
  readFails = false;
  increments = 0;
  constructor(opts: { counter?: bigint; name?: string } = {}) {
    this.counter = opts.counter ?? 42n;
    this.name = opts.name ?? NAME;
  }
  available(): TpmResult<null> {
    return this.toolsAvailable ? { ok: true, value: null } : { ok: false, message: "tpm2-tools not installed" };
  }
  readPublic(): TpmResult<NvPublic> {
    if (!this.present) return { ok: false, message: "no NV index" };
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
    if (!this.present) return { ok: false, message: "no NV index" };
    if (this.readFails) return { ok: false, message: "TPM unreachable" };
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-plat-health-"));
  statePath = join(dir, "platform-witness.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Init a witness; its config points at statePath. init consumes one increment
// (counter 41 -> 42, anchor "42"). Returns a fresh FakeTpm at that settled state.
function initialised(): { config: PlatformConfig; tpm: FakeTpm } {
  const initTpm = new FakeTpm({ counter: 41n });
  const result = initPlatformWitness(statePath, NV, initTpm);
  if (!result.ok) throw new Error(result.message);
  // A fresh reader TPM at the SETTLED counter (42), same Name/authority.
  return { config: result.value.config, tpm: new FakeTpm({ counter: 42n }) };
}

// Inject a witness entry for (PAIR, direction) at the given high-water, keeping
// the anchor consistent with the settled TPM counter.
function injectEntry(highWater: number, direction = "A->B"): void {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.witness[`${PAIR}/${direction}`] = {
    encryptionNextOffset: highWater,
    authenticationNextSequence: highWater,
    attemptsReserved: highWater
  };
  writeFileSync(statePath, JSON.stringify(state));
}

const store = (n: number) => ({ nextOffset: n, nextSequence: n, attemptsReserved: n });

describe("platformHealth maps live facts, and never mutates", () => {
  it("a fresh witness (no entry for this pair) is HEALTHY, and the probe increments nothing", () => {
    const { config, tpm } = initialised();
    expect(platformHealth(config, PAIR, "A->B", store(0), tpm)).toBe("healthy");
    expect(tpm.increments).toBe(0);
  });

  it("a store at or ahead of its witnessed high-water is HEALTHY", () => {
    const { config, tpm } = initialised();
    injectEntry(100);
    expect(platformHealth(config, PAIR, "A->B", store(100), tpm)).toBe("healthy");
    expect(platformHealth(config, PAIR, "A->B", store(250), tpm)).toBe("healthy");
    expect(tpm.increments).toBe(0);
  });

  it("a store BELOW its witnessed high-water is REGRESSED (restored store)", () => {
    const { config, tpm } = initialised();
    injectEntry(100);
    expect(platformHealth(config, PAIR, "A->B", store(50), tpm)).toBe("regressed");
    expect(tpm.increments).toBe(0);
  });

  it("an unavailable TPM or an unreadable counter is UNREACHABLE (availability, not confirmed)", () => {
    const { config } = initialised();
    const down = new FakeTpm({ counter: 42n });
    down.toolsAvailable = false;
    expect(platformHealth(config, PAIR, "A->B", store(0), down)).toBe("unreachable");

    const readDown = new FakeTpm({ counter: 42n });
    readDown.readFails = true;
    expect(platformHealth(config, PAIR, "A->B", store(0), readDown)).toBe("unreachable");
  });

  it("a substituted authority (different Name) is INCONSISTENT", () => {
    const { config } = initialised();
    const foreign = new FakeTpm({ counter: 42n, name: "000b" + "ee".repeat(16) });
    expect(platformHealth(config, PAIR, "A->B", store(0), foreign)).toBe("inconsistent");
  });

  it("a non-counter index is INCONSISTENT — holding an integer is not being monotonic", () => {
    const { config } = initialised();
    const notCounter = new FakeTpm({ counter: 42n });
    notCounter.isCounter = false;
    expect(platformHealth(config, PAIR, "A->B", store(0), notCounter)).toBe("inconsistent");
  });

  it("a state file BEHIND the TPM anchor (restored/replaced witness) is INCONSISTENT", () => {
    const { config } = initialised();
    // TPM has moved ahead of the state file's anchor (a restored state file).
    const ahead = new FakeTpm({ counter: 99n });
    expect(platformHealth(config, PAIR, "A->B", store(0), ahead)).toBe("inconsistent");
  });
});
