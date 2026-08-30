import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyAnchor,
  initPlatformWitness,
  platformAdvance,
  platformPreflight,
  validatePlatformState,
  type PlatformConfig
} from "../src/cli/v2/platform-witness";
import { PROVIDER_ID, UINT64_MAX, parseCounterBytes, parseNvIndex, parseNvPublic, type NvPublic, type TpmProvider, type TpmResult } from "../src/cli/v2/tpm";

/* ============================================================================
 * platform-monotonic witness — the TPM-anchored authority (FORMAT-V2.md §15)
 * ----------------------------------------------------------------------------
 * The residual separate-state-file cannot close: restore an old pair AND its
 * old witness together and every check passes, because the two agree and there
 * is no external truth to disagree with them. A TPM NV counter is that external
 * truth — it does not live in any backup, so it cannot be restored with them.
 *
 *   NORMAL:    F.anchor == T
 *   PREPARED:  F.anchor == T + 1     (a commit interrupted before the TPM)
 *   ELSE:      fail closed
 *
 * These specs drive the state machine through a FAKE provider, which models
 * readPublic/readCounter/increment deterministically so every crash boundary
 * can be pinned without a device. The fake is a TEST construct and is never
 * selectable from a pair header: a header names a PROVIDER ID and only
 * "tpm2-nv-counter-v1" resolves.
 *
 * NOT PROVEN HERE: that real hardware behaves this way. No physical TPM and no
 * swtpm was available on the development host; see the phase report.
 * ========================================================================= */

const PAIR_A = "a".repeat(32);
const PAIR_B = "b".repeat(32);
const NV = "0x01500016";
const NAME = "000b" + "cd".repeat(16);

type Entry = { encryptionNextOffset: number; authenticationNextSequence: number; attemptsReserved: number };
const flat = (n: number): Entry => ({ encryptionNextOffset: n, authenticationNextSequence: n, attemptsReserved: n });

// A deterministic TPM. Every failure mode the crash matrix needs is a switch,
// so no test depends on timing or on a device.
class FakeTpm implements TpmProvider {
  readonly id = PROVIDER_ID;
  // TCG state machine, modelled rather than approximated. A freshly DEFINED
  // counter has TPMA_NV_WRITTEN CLEAR: it has NO value, and a read returns
  // TPM_RC_NV_UNINITIALIZED. Its FIRST increment initializes it — to the TPM's
  // largest-ever NV counter value, NOT to zero — and sets WRITTEN.
  //
  // The previous fake let an unwritten counter be read as 0, which made a real
  // defect invisible: initialization read before its first increment and
  // therefore failed against every freshly provisioned counter. The fake now
  // pins the TPM's behaviour, not the behaviour that was convenient.
  written: boolean;
  counter: bigint;
  largestEver: bigint;
  name: string;
  isCounter = true;
  isOrderly = false;
  sizeBytes = 8;
  present = true;
  toolsAvailable = true;
  incrementThenFail = false;
  incrementFails = false;
  readFails = false;
  increments = 0;

  constructor(opts: { written?: boolean; counter?: bigint; largestEver?: bigint; name?: string } = {}) {
    this.written = opts.written ?? true;
    this.counter = opts.counter ?? 0n;
    this.largestEver = opts.largestEver ?? 40n;
    this.name = opts.name ?? NAME;
  }
  available(): TpmResult<null> {
    return this.toolsAvailable ? { ok: true, value: null } : { ok: false, message: "tpm2-tools not installed" };
  }
  // The TPM Name is computed over the PUBLIC AREA, which includes the
  // attributes — so it CHANGES when the first increment sets WRITTEN. Real
  // swtpm does this; the original fake did not, and binding to the pre-write
  // Name broke every operation after initialization.
  nameFor(written: boolean): string {
    return written ? this.name : this.name.replace(/^000b../, "000baa");
  }
  readPublic(): TpmResult<NvPublic> {
    if (!this.present) return { ok: false, message: "no NV index" };
    const flags = [
      "authread",
      "authwrite",
      this.isCounter ? "nt=0x1" : "nt=0x0",
      ...(this.isOrderly ? ["orderly"] : []),
      ...(this.written ? ["written"] : [])
    ].join("|");
    return {
      ok: true,
      value: {
        name: this.nameFor(this.written),
        isCounter: this.isCounter,
        isOrderly: this.isOrderly,
        isWritten: this.written,
        sizeBytes: this.sizeBytes,
        attributesFriendly: flags
      }
    };
  }
  readCounter(): TpmResult<bigint> {
    if (!this.present) return { ok: false, message: "no NV index" };
    if (this.readFails) return { ok: false, message: "TPM unreachable" };
    if (!this.written) {
      return { ok: false, message: "tpm:error(2.0): TPM_RC_NV_UNINITIALIZED" };
    }
    return { ok: true, value: this.counter };
  }
  increment(): TpmResult<null> {
    if (!this.present) return { ok: false, message: "no NV index" };
    if (this.incrementFails) return { ok: false, message: "TPM unreachable" };
    this.increments += 1;
    if (!this.written) {
      // First increment initializes to the largest value any counter on this
      // TPM has ever had, which is why a fresh counter need not start at zero.
      this.written = true;
      this.counter = this.largestEver + 1n;
    } else {
      this.counter += 1n;
    }
    if (this.incrementThenFail) return { ok: false, message: "command reported failure after the TPM moved" };
    return { ok: true, value: null };
  }
}

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-platform-"));
  statePath = join(dir, "platform-witness.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readState = () => JSON.parse(readFileSync(statePath, "utf8"));

function initialised(tpm: FakeTpm): PlatformConfig {
  const result = initPlatformWitness(statePath, NV, tpm);
  if (!result.ok) throw new Error(result.message);
  return result.value.config;
}

/* ==========================================================================
 * Index validation: what may be adopted at all.
 * ======================================================================== */

describe("TPM NV index requirements", () => {
  it("adopts a valid non-orderly 8-octet COUNTER, proving increment access", () => {
    const tpm = new FakeTpm({ counter: 41n });
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Init consumes exactly ONE counter value, and no pad material.
    expect(tpm.increments).toBe(1);
    expect(result.value.anchor).toBe("42");
    const state = readState();
    expect(state).toMatchObject({
      formatVersion: 1,
      provider: PROVIDER_ID,
      nvIndex: NV,
      nvName: NAME,
      anchor: "42",
      witness: {}
    });
    expect(state.authorityId).toMatch(/^[0-9a-f]{32}$/);
    if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses an ORDERLY counter — deferred NV persistence can lose increments", () => {
    const tpm = new FakeTpm({ counter: 1n });
    tpm.isOrderly = true;
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/TPMA_NV_ORDERLY/);
    expect(tpm.increments).toBe(0); // refused before touching the hardware
  });

  it("refuses an ordinary (non-counter) index — holding an integer is not being monotonic", () => {
    const tpm = new FakeTpm({ counter: 1n });
    tpm.isCounter = false;
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a TPM NV COUNTER/);
  });

  it("refuses a wrong-size index", () => {
    const tpm = new FakeTpm({ counter: 1n });
    tpm.sizeBytes = 32;
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/must be exactly 8/);
  });

  it("refuses when the tools or the index are absent", () => {
    const noTools = new FakeTpm({ counter: 1n });
    noTools.toolsAvailable = false;
    expect(initPlatformWitness(statePath, NV, noTools).ok).toBe(false);
    const noIndex = new FakeTpm({ counter: 1n });
    noIndex.present = false;
    expect(initPlatformWitness(statePath, NV, noIndex).ok).toBe(false);
  });

  it("refuses a counter whose value does not move by exactly one — the byte-order check", () => {
    // Init reads, increments, reads. If the 8 octets are not the big-endian
    // uint64 this build parses, the difference will not be one, and the
    // authority is refused rather than anchored to a value it cannot interpret.
    const tpm = new FakeTpm({ counter: 10n });
    const realIncrement = tpm.increment.bind(tpm);
    tpm.increment = () => {
      const r = realIncrement();
      tpm.counter += 7n; // as if the value were being read wrongly
      return r;
    };
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a difference of one|big-endian/);
  });

  it("a FRESHLY DEFINED (unwritten) counter initializes — the read-first bug", () => {
    // A newly defined TPM_NT_COUNTER has TPMA_NV_WRITTEN CLEAR, no value, and
    // TPM2_NV_Read returns TPM_RC_NV_UNINITIALIZED. Reading before the first
    // increment therefore failed against EVERY freshly provisioned counter —
    // the feature was unusable on first real use. Init must initialize it.
    const tpm = new FakeTpm({ written: false, largestEver: 40n });
    expect(tpm.readCounter().ok).toBe(false); // nothing to read yet

    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two values: one to initialize the counter, one to confirm the increment
    // and the byte order. No pad material exists yet.
    expect(tpm.increments).toBe(2);
    expect(tpm.written).toBe(true);
    // A fresh counter starts at the TPM's largest-ever NV counter value, NOT
    // at zero, and the anchor simply records whatever it actually reads.
    expect(result.value.anchor).toBe("42");
    expect(BigInt(readState().anchor)).toBe(tpm.counter);
  });

  it("binds to the SETTLED Name — the Name changes when the first write sets WRITTEN", () => {
    // Only a real TPM revealed this: the Name covers the public area, and the
    // public area includes TPMA_NV_WRITTEN, so a fresh counter's Name before
    // its first increment is NOT the Name it keeps afterwards. Binding to the
    // pre-write Name made every subsequent operation fail its identity check.
    const tpm = new FakeTpm({ written: false });
    const preWriteName = tpm.readPublic();
    expect(preWriteName.ok && preWriteName.value.name).not.toBe(NAME);

    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bound to the settled (written) Name...
    expect(result.value.config.nvName).toBe(NAME);
    expect(readState().nvName).toBe(NAME);
    // ...so ordinary operation works, which is the whole point.
    expect(platformPreflight(result.value.config, PAIR_A, "A->B", tpm).ok).toBe(true);
  });

  it("an ALREADY-WRITTEN counter costs one value, and never has to start at zero", () => {
    const tpm = new FakeTpm({ written: true, counter: 9_000_000_000_000n });
    const result = initPlatformWitness(statePath, NV, tpm);
    expect(result.ok).toBe(true);
    expect(tpm.increments).toBe(1);
    if (result.ok) expect(result.value.anchor).toBe("9000000000001");
  });

  it("repeat init consumes ZERO counter values and rewrites nothing", () => {
    // "Idempotent" must be true, not decorative: TPM counter values are finite,
    // and spending one silently on a no-op is a lie about the cost.
    const tpm = new FakeTpm({ written: false });
    const first = initPlatformWitness(statePath, NV, tpm);
    expect(first.ok).toBe(true);
    const bytesBefore = readFileSync(statePath, "utf8");
    const counterBefore = tpm.counter;
    const incrementsBefore = tpm.increments;

    const again = initPlatformWitness(statePath, NV, tpm);
    expect(again.ok).toBe(true);
    if (again.ok && first.ok) {
      expect(again.value.created).toBe(false);
      expect(again.value.config.authorityId).toBe(first.value.config.authorityId);
      expect(again.value.anchor).toBe(first.value.anchor);
    }
    expect(tpm.increments).toBe(incrementsBefore); // ZERO consumed
    expect(tpm.counter).toBe(counterBefore);
    expect(readFileSync(statePath, "utf8")).toBe(bytesBefore); // byte-identical
  });

  it("re-init refuses when the anchor and the TPM are not in a valid relation", () => {
    const tpm = new FakeTpm({ written: true, counter: 500n });
    initialised(tpm);
    const state = readState();
    // Behind: a restored state file. Init does not repair it.
    writeFileSync(statePath, JSON.stringify({ ...state, anchor: "3" }));
    const behind = initPlatformWitness(statePath, NV, tpm);
    expect(behind.ok).toBe(false);
    if (!behind.ok) expect(behind.message).toMatch(/not in a valid relation|BEHIND/);

    // Prepared: init does NOT complete an interrupted commit; the operational
    // path does, under the protocol that knows the output was withheld.
    writeFileSync(statePath, JSON.stringify({ ...state, anchor: (tpm.counter + 1n).toString() }));
    const prepared = initPlatformWitness(statePath, NV, tpm);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toMatch(/PREPARED commit/);
    expect(tpm.increments).toBe(1); // still only the original init's
  });

  it("never overwrites a live authority, and is idempotent on an equivalent one", () => {
    const tpm = new FakeTpm({ counter: 0n });
    const config = initialised(tpm);
    // A second init against the same authority is a no-op success.
    const again = initPlatformWitness(statePath, NV, tpm);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.config.authorityId).toBe(config.authorityId);

    // Once it records a pair, init refuses.
    const advanced = platformAdvance(config, PAIR_A, "A->B", flat(3), null, tpm);
    expect(advanced.ok).toBe(true);
    const third = initPlatformWitness(statePath, NV, tpm);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.message).toMatch(/live platform witness recording/);
  });
});

/* ==========================================================================
 * The NV Name binding.
 * ======================================================================== */

describe("NV Name binding", () => {
  it("same handle, same Name is accepted; a DIFFERENT Name fails closed and is never auto-rebound", () => {
    const tpm = new FakeTpm({ counter: 5n });
    const config = initialised(tpm);
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(true);

    // The index was deleted and re-created: same number, different identity.
    tpm.name = "000b" + "ef".repeat(16);
    const after = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.message).toMatch(/no longer has the Name TruePad bound to/);
      expect(after.message).toMatch(/not auto-rebound/);
    }
  });

  it("a deleted index fails closed", () => {
    const tpm = new FakeTpm({ counter: 5n });
    const config = initialised(tpm);
    tpm.present = false;
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(false);
  });

  it("ORDERLY appearing later fails closed", () => {
    const tpm = new FakeTpm({ counter: 5n });
    const config = initialised(tpm);
    tpm.isOrderly = true;
    const result = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/ORDERLY/);
  });
});

/* ==========================================================================
 * The anchor relation.
 * ======================================================================== */

describe("anchor relation", () => {
  it("F == T is normal; F == T + 1 is the recoverable prepared state", () => {
    expect(classifyAnchor(7n, 7n)).toEqual({ ok: true, value: { kind: "normal", anchor: 7n } });
    expect(classifyAnchor(8n, 7n)).toEqual({ ok: true, value: { kind: "prepared", anchor: 8n } });
  });

  it("F < T fails closed — the state file is behind the hardware", () => {
    const result = classifyAnchor(3n, 9n);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/BEHIND its TPM anchor/);
      expect(result.message).toMatch(/never lowered/);
    }
  });

  it("F > T + 1 fails closed — corrupt or a foreign authority", () => {
    const result = classifyAnchor(12n, 9n);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/AHEAD of its TPM anchor by more than one/);
  });
});

/* ==========================================================================
 * §25 — THE CENTRAL ACCEPTANCE TEST: the restore attack.
 * ======================================================================== */

describe("the restore attack separate-state-file cannot close", () => {
  it("old pair + old state file restored together is REFUSED before anything is consumed", () => {
    const tpm = new FakeTpm({ counter: 100n });
    const config = initialised(tpm);

    // 1-2. advance the pair and the witness a few times.
    for (const n of [1, 2, 3]) {
      const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
      expect(pre.ok).toBe(true);
      if (!pre.ok) return;
      expect(platformAdvance(config, PAIR_A, "A->B", flat(n * 10), pre.value.snapshot, tpm).ok).toBe(true);
    }
    const liveState = readFileSync(statePath, "utf8");
    const liveCounter = tpm.counter;
    expect(JSON.parse(liveState).witness[`${PAIR_A}/A->B`]).toEqual(flat(30));

    // 3. an OLD backup of the state file, taken when the pair was at 10.
    const oldBackup = JSON.stringify({
      ...JSON.parse(liveState),
      anchor: (liveCounter - 2n).toString(),
      witness: { [`${PAIR_A}/A->B`]: flat(10) }
    });

    // 4. restore BOTH the pair and its witness. 5. the TPM is untouched — it
    //    is not in any backup, which is the entire point.
    writeFileSync(statePath, oldBackup);

    const attacked = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(attacked.ok).toBe(false);
    if (!attacked.ok) {
      expect(attacked.message).toMatch(/BEHIND its TPM anchor/);
      expect(attacked.message).toMatch(/rollback this class exists to detect/);
    }
    // Nothing consumed: no increment, and the restored file is untouched.
    expect(tpm.counter).toBe(liveCounter);
    expect(readFileSync(statePath, "utf8")).toBe(oldBackup);

    // ...and it stays refused. There is no path that repairs itself into use.
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(false);
    expect(platformPreflight(config, PAIR_B, "A->B", tpm).ok).toBe(false);
  });

  it("a substituted state file of the right shape but another authority is refused", () => {
    const tpm = new FakeTpm({ counter: 50n });
    const config = initialised(tpm);
    const state = readState();
    // Same counter value, same NV index, different authorityId.
    writeFileSync(statePath, JSON.stringify({ ...state, authorityId: "f".repeat(32) }));
    const result = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/belongs to authority/);
  });
});

/* ==========================================================================
 * §24 — the crash matrix.
 * ======================================================================== */

describe("crash matrix", () => {
  it("(C) state prepared at T+1, crash before the TPM increment → next preflight completes exactly one", () => {
    const tpm = new FakeTpm({ counter: 10n });
    const config = initialised(tpm); // T = 11
    const settled = tpm.counter;
    // Simulate the crash: the state file is durable at T+1, hardware untouched.
    writeFileSync(statePath, JSON.stringify({ ...readState(), anchor: (settled + 1n).toString(), witness: { [`${PAIR_A}/A->B`]: flat(4) } }));
    const before = tpm.increments;

    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    expect(tpm.increments).toBe(before + 1); // EXACTLY one
    expect(tpm.counter).toBe(settled + 1n);
    // ...and the recovered witness state is the prepared one, intact.
    if (pre.ok) expect(pre.value.entry).toEqual(flat(4));

    // Repeating preflight does NOT increment again — recovery is not a treadmill.
    const after = tpm.increments;
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(true);
    expect(tpm.increments).toBe(after);
  });

  it("(D/F) the increment lands but the command reports failure → next preflight sees F == T and proceeds", () => {
    const tpm = new FakeTpm({ counter: 20n });
    const config = initialised(tpm);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;

    tpm.incrementThenFail = true;
    const advanced = platformAdvance(config, PAIR_A, "A->B", flat(7), pre.value.snapshot, tpm);
    expect(advanced.ok).toBe(false); // output withheld
    tpm.incrementThenFail = false;

    // The hardware DID move, and the state file was prepared to match, so the
    // authority is already settled: F == T. The next operation just proceeds.
    expect(BigInt(readState().anchor)).toBe(tpm.counter);
    const next = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.value.entry).toEqual(flat(7));
  });

  it("(G) TPM unavailable after a prepared state → fail closed until it returns, then complete", () => {
    const tpm = new FakeTpm({ counter: 30n });
    const config = initialised(tpm);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;

    tpm.incrementFails = true;
    const advanced = platformAdvance(config, PAIR_A, "A->B", flat(9), pre.value.snapshot, tpm);
    expect(advanced.ok).toBe(false);
    if (!advanced.ok) expect(advanced.message).toMatch(/prepared durably but the TPM increment failed/);

    // Still prepared, and refused while the TPM is away.
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(false);

    // The authority returns: the interrupted commit completes.
    tpm.incrementFails = false;
    const recovered = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.value.entry).toEqual(flat(9));
    expect(BigInt(readState().anchor)).toBe(tpm.counter);
  });

  it("(B) a corrupt state file is refused and never repaired by guesswork", () => {
    const tpm = new FakeTpm({ counter: 40n });
    const config = initialised(tpm);
    for (const corrupt of ["", "{ not json", JSON.stringify({ formatVersion: 1 })]) {
      writeFileSync(statePath, corrupt);
      const result = platformPreflight(config, PAIR_A, "A->B", tpm);
      expect(result.ok).toBe(false);
      expect(readFileSync(statePath, "utf8")).toBe(corrupt); // untouched
    }
  });

  it("(H/I) an anchor behind by one, and ahead by two, both fail closed", () => {
    const tpm = new FakeTpm({ counter: 60n });
    const config = initialised(tpm);
    const base = readState();

    writeFileSync(statePath, JSON.stringify({ ...base, anchor: (tpm.counter - 1n).toString() }));
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(false);

    writeFileSync(statePath, JSON.stringify({ ...base, anchor: (tpm.counter + 2n).toString() }));
    expect(platformPreflight(config, PAIR_A, "A->B", tpm).ok).toBe(false);
    // No increment was attempted in either case.
    expect(tpm.increments).toBe(1); // only init's
  });
});

/* ==========================================================================
 * §26 — multi-pair concurrency over one authority.
 * ======================================================================== */

describe("multi-pair over one TPM authority", () => {
  it("two pairs and both directions stay monotone; the anchor moves once per advance", () => {
    const tpm = new FakeTpm({ counter: 0n });
    const config = initialised(tpm);
    const keys: [string, "A->B" | "B->A"][] = [
      [PAIR_A, "A->B"],
      [PAIR_A, "B->A"],
      [PAIR_B, "A->B"],
      [PAIR_B, "B->A"]
    ];
    let expectedAnchor = tpm.counter;
    for (let round = 1; round <= 3; round += 1) {
      for (const [pairId, direction] of keys) {
        const pre = platformPreflight(config, pairId, direction, tpm);
        expect(pre.ok).toBe(true);
        if (!pre.ok) return;
        expect(platformAdvance(config, pairId, direction, flat(round * 5), pre.value.snapshot, tpm).ok).toBe(true);
        expectedAnchor += 1n; // exactly one TPM increment per witness advance
        expect(tpm.counter).toBe(expectedAnchor);
        expect(BigInt(readState().anchor)).toBe(expectedAnchor);
      }
      // Nothing disappeared, nothing decreased.
      const witness = readState().witness;
      expect(Object.keys(witness).sort()).toEqual(keys.map(([p, d]) => `${p}/${d}`).sort());
      for (const [pairId, direction] of keys) {
        expect(witness[`${pairId}/${direction}`]).toEqual(flat(round * 5));
      }
    }
  });

  it("a stale snapshot from before another pair's advance still passes; a regression does not", () => {
    const tpm = new FakeTpm({ counter: 0n });
    const config = initialised(tpm);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;

    // Another pair advances in between — legitimate forward progress.
    const preB = platformPreflight(config, PAIR_B, "A->B", tpm);
    expect(preB.ok).toBe(true);
    if (!preB.ok) return;
    expect(platformAdvance(config, PAIR_B, "A->B", flat(9), preB.value.snapshot, tpm).ok).toBe(true);

    // A's older snapshot must still be accepted.
    expect(platformAdvance(config, PAIR_A, "A->B", flat(4), pre.value.snapshot, tpm).ok).toBe(true);
    expect(readState().witness).toEqual({
      [`${PAIR_A}/A->B`]: flat(4),
      [`${PAIR_B}/A->B`]: flat(9)
    });

    // But a witness map that went backwards under a live snapshot is refused.
    const pre2 = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre2.ok).toBe(true);
    if (!pre2.ok) return;
    const state = readState();
    writeFileSync(statePath, JSON.stringify({ ...state, witness: { ...state.witness, [`${PAIR_B}/A->B`]: flat(1) } }));
    const refused = platformAdvance(config, PAIR_A, "A->B", flat(5), pre2.value.snapshot, tpm);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/regressed between this operation's preflight/);
  });

  it("attemptsReserved alone can never regress", () => {
    const tpm = new FakeTpm({ counter: 0n });
    const config = initialised(tpm);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    if (!pre.ok) return;
    expect(platformAdvance(config, PAIR_A, "A->B", { encryptionNextOffset: 5, authenticationNextSequence: 5, attemptsReserved: 9 }, pre.value.snapshot, tpm).ok).toBe(true);

    const pre2 = platformPreflight(config, PAIR_A, "A->B", tpm);
    if (!pre2.ok) return;
    // A lower attemptsReserved is absorbed by the elementwise max, never written.
    expect(platformAdvance(config, PAIR_A, "A->B", { encryptionNextOffset: 6, authenticationNextSequence: 6, attemptsReserved: 2 }, pre2.value.snapshot, tpm).ok).toBe(true);
    expect(readState().witness[`${PAIR_A}/A->B`].attemptsReserved).toBe(9);
  });
});

/* ==========================================================================
 * §20 — counter parsing boundaries, and overflow.
 * ======================================================================== */

describe("counter parsing and overflow", () => {
  it("parses the documented 8-octet big-endian uint64 across the boundaries", () => {
    const be = (v: bigint): Buffer => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(v);
      return b;
    };
    for (const value of [0n, 1n, 255n, 256n, 1n << 32n, 1n << 53n, UINT64_MAX - 1n, UINT64_MAX]) {
      const parsed = parseCounterBytes(be(value));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(value);
    }
    // 2^53 and beyond stay exact — the anchor is BigInt end to end, never Number.
    const big = parseCounterBytes(be((1n << 53n) + 1n));
    expect(big.ok && big.value === (1n << 53n) + 1n).toBe(true);
  });

  it("refuses a short or long read rather than padding it into a plausible number", () => {
    expect(parseCounterBytes(Buffer.alloc(7)).ok).toBe(false);
    expect(parseCounterBytes(Buffer.alloc(9)).ok).toBe(false);
    expect(parseCounterBytes(Buffer.alloc(0)).ok).toBe(false);
  });

  it("refuses to advance past the uint64 maximum BEFORE attempting the increment", () => {
    const tpm = new FakeTpm({ counter: UINT64_MAX - 1n });
    const config = initialised(tpm); // consumes one: now at UINT64_MAX
    expect(tpm.counter).toBe(UINT64_MAX);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    const before = tpm.increments;
    const result = platformAdvance(config, PAIR_A, "A->B", flat(1), pre.value.snapshot, tpm);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/uint64 maximum/);
    expect(tpm.increments).toBe(before); // never attempted
  });
});

/* ==========================================================================
 * §19 — command safety, and the fake provider's production reachability.
 * ======================================================================== */

describe("provider safety", () => {
  it("the NV index grammar rejects anything that could reach argv as an option or command", () => {
    for (const hostile of [
      "0x01500016; rm -rf /",
      "0x01500016 --auth secret",
      "--help",
      "-C",
      "$(id)",
      "`id`",
      "0x01500016\nrm -rf /",
      "",
      "0xZZZZZZZZ",
      "1500016"
    ]) {
      expect(parseNvIndex(hostile).ok, `${JSON.stringify(hostile)} must be refused`).toBe(false);
    }
    // In range and canonicalised — the exact bytes handed to tpm2-tools are ours.
    const ok = parseNvIndex("0x1500016");
    expect(ok.ok && ok.index).toBe("0x01500016");
    // Outside the NV handle range.
    expect(parseNvIndex("0x00000001").ok).toBe(false);
    expect(parseNvIndex("0x02000000").ok).toBe(false);
  });

  it("a pair header can never name the fake provider", () => {
    // The header carries a provider ID, and only the real one resolves. This
    // is the guard that keeps a test double out of production config.
    const state = {
      formatVersion: 1,
      provider: "fake",
      authorityId: "a".repeat(32),
      nvIndex: NV,
      nvName: NAME,
      anchor: "1",
      witness: {}
    };
    const validated = validatePlatformState(state);
    expect("why" in validated).toBe(true);
    if ("why" in validated) expect(validated.why).toMatch(/provider must be "tpm2-nv-counter-v1"/);
  });

  it("parses a realistic tpm2_nvreadpublic block, and refuses one missing its identity", () => {
    const yaml = [
      "0x1500016:",
      "  name: 000bcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      "  hash algorithm:",
      "    friendly: sha256",
      "    value: 0xB",
      "  attributes:",
      "    friendly: authread|authwrite|written|nt=0x1",
      "    value: 0x42060008",
      "  size: 8",
      ""
    ].join("\n");
    const parsed = parseNvPublic(yaml, "0x01500016");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.isCounter).toBe(true);
      expect(parsed.value.isOrderly).toBe(false);
      expect(parsed.value.sizeBytes).toBe(8);
      expect(parsed.value.name).toBe("000bcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd");
    }
    expect(parsed.ok && parsed.value.isWritten).toBe(true);
    // An orderly counter, and an ordinary index, are both recognised.
    expect(parseNvPublic(yaml.replace("nt=0x1", "orderly|nt=0x1"), "0x01500016")).toMatchObject({ ok: true, value: { isOrderly: true } });
    expect(parseNvPublic(yaml.replace("nt=0x1", "nt=0x0"), "0x01500016")).toMatchObject({ ok: true, value: { isCounter: false } });
    // tpm2-tools documents BOTH renderings of the index type: numeric `nt=0x1`
    // and the friendly word `counter`. Both must parse, and neither may be
    // guessed at from anything else.
    expect(parseNvPublic(yaml.replace("nt=0x1", "counter"), "0x01500016")).toMatchObject({ ok: true, value: { isCounter: true } });
    expect(parseNvPublic(yaml.replace("nt=0x1", "nt=1"), "0x01500016")).toMatchObject({ ok: true, value: { isCounter: true } });
    expect(parseNvPublic(yaml.replace("nt=0x1", "ordinary"), "0x01500016")).toMatchObject({ ok: true, value: { isCounter: false } });
    expect(parseNvPublic(yaml.replace("nt=0x1", "bits"), "0x01500016")).toMatchObject({ ok: true, value: { isCounter: false } });
    // WRITTEN is read from the public area, never inferred from a read working.
    expect(parseNvPublic(yaml.replace("|written", ""), "0x01500016")).toMatchObject({ ok: true, value: { isWritten: false } });
    // No name → refused rather than bound to an index with no identity.
    expect(parseNvPublic(yaml.replace(/^  name:.*$/m, ""), "0x01500016").ok).toBe(false);
    // A different index entirely → not found.
    expect(parseNvPublic(yaml, "0x01500017").ok).toBe(false);
  });
});

/* ==========================================================================
 * §17 — the attempt reservation is anchored BEFORE the tag is evaluated.
 * ======================================================================== */

describe("open: the attempt budget reaches the authority before verification", () => {
  // This is the load-bearing ordering, and it is a property of the VERB, not of
  // any provider: witnessAdvance routes by class, so pinning the order in
  // truepad2.ts proves it for platform-monotonic exactly as for
  // separate-state-file. A source-level pin is the honest way to assert it
  // without a TPM on this host — and it fails if anyone ever "optimises" the
  // two platform increments of an open down to one by moving verification up.
  const SOURCE = readFileSync(resolve(__dirname, "..", "src", "cli", "v2", "truepad2.ts"), "utf8");

  it("reserveAttempt → witnessAdvance → tag verification, in that order", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const reserve = code.indexOf("reserveAttempt(halfDir, sequence)");
    const advance = code.indexOf("witnessAdvance(store, witnessSnapshot, {", reserve);
    const verify = code.indexOf("wcTag(key, mask, fields)", advance);
    expect(reserve).toBeGreaterThan(-1);
    expect(advance).toBeGreaterThan(reserve);
    expect(verify).toBeGreaterThan(advance);
    // ...and the tag comparison itself comes after the advance too.
    expect(code.indexOf("tagsEqual(expected, envelope.tag)")).toBeGreaterThan(advance);
  });

  it("a successful open advances the witness twice — the two boundaries are not batched", () => {
    // Reservation (before verification) and the post-success high-water are
    // separate security boundaries; each costs one TPM increment, deliberately.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const openStart = code.indexOf("function open(");
    const openEnd = code.indexOf("\nfunction ", openStart + 1);
    const body = code.slice(openStart, openEnd === -1 ? undefined : openEnd);
    const advances = body.split("witnessAdvance(store, witnessSnapshot, {").length - 1;
    expect(advances).toBe(2);
  });
});

/* ==========================================================================
 * §16 — an advance failure after the store commit never downgrades the class.
 * ======================================================================== */

describe("advance failure after a durable store commit", () => {
  it("never fabricates an anchor and never falls back to a weaker class", () => {
    const tpm = new FakeTpm({ counter: 70n });
    const config = initialised(tpm);
    const pre = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;

    tpm.present = false; // the authority vanishes mid-operation
    const result = platformAdvance(config, PAIR_A, "A->B", flat(3), pre.value.snapshot, tpm);
    expect(result.ok).toBe(false);
    // The state file was NOT advanced, and no anchor was invented.
    expect(readState().witness).toEqual({});
    expect(readState().anchor).toBe("71");

    // And the class is still platform-monotonic — no silent downgrade.
    tpm.present = true;
    const back = platformPreflight(config, PAIR_A, "A->B", tpm);
    expect(back.ok).toBe(true);
  });
});
