import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";
import { directionStatus, padHealthPercent, padStatusWord } from "../src/browser/ui/format";

/* ============================================================================
 * WHAT "MESSAGES YOU CAN STILL SEND" PROMISES, AND WHETHER IT KEEPS IT
 * ----------------------------------------------------------------------------
 * FORMAT-V2 §16: on a FIXED store every send spends exactly F encryption bytes
 * and one authentication record, however short the message — `burn` builds a
 * full F-byte frame and `c` is always F. So on a fixed store the number of
 * messages left is bounded by BOTH budgets:
 *
 *     maxRemainingSends = min(remainingRecords, floor(remainingBytes / F))
 *
 * Every engine reported `remainingRecords` alone. On a variable store that is a
 * true upper bound — a send can be one byte — so that half was always honest.
 * On a fixed store it overstated, often by an order of magnitude: a Small pad
 * (E = 16,384 per direction, N = 64) fixed at F = 4096 can send FOUR messages
 * and then reported SIXTY, and the pad-level status word stayed "Ready" for a
 * pad that could never send again.
 *
 * The number is presentational — `burn`'s own `encryption-exhausted` refusal is
 * what actually protects the pad, and it always did. But an operator plans
 * around this figure, and a pad that says it has sixty messages left when it has
 * none is a pad they will rely on and then not be able to use.
 *
 * THESE TESTS DO NOT RESTATE THE FORMULA. The formula is in the engine; a test
 * that recomputes it beside the engine agrees with itself no matter what either
 * one says. Instead the central test BURNS UNTIL THE ENGINE REFUSES and checks
 * that the count it managed is exactly the count the meter promised. That is the
 * claim the operator actually reads, checked against the only authority for it.
 * ========================================================================= */

let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}

function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) {
    const reason = (res as { reason?: string }).reason ?? "";
    throw new Error(`expected ok:${op} but got ${res.kind} ${reason}: ${res.message}`);
  }
  return res as Extract<EngineOk, { op: K }>;
}

function source(encryptionBytes: number, authRecords: number): Uint8Array {
  // CHUNKED: getRandomValues refuses more than 65,536 bytes at a time, and the
  // shipped presets need far more than that.
  const out = new Uint8Array(2 * (encryptionBytes + 32 * authRecords));
  for (let i = 0; i < out.length; i += 65_536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, out.length)));
  }
  return out;
}

async function gen(
  vfs: Vfs,
  o: { encryptionBytes: number; authRecords: number; recordBytes?: number }
): Promise<string> {
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label: "meter",
      sources: [
        {
          name: "drbg.bin",
          declaredOrigin: "test DRBG material, operator-asserted",
          bytes: source(o.encryptionBytes, o.authRecords)
        }
      ],
      encryptionBytes: o.encryptionBytes,
      authRecords: o.authRecords,
      witnessClass: "browser-none",
      recordBytes: o.recordBytes
    }),
    "gen"
  );
  return res.pair.pairId;
}

async function meters(vfs: Vfs, pairId: string) {
  return asOk(await send(vfs, { op: "status", pairId }), "status").pair.meters["A->B"];
}

/** Burn one-byte messages until the engine refuses, and report how many landed. */
async function sendsUntilRefused(
  vfs: Vfs,
  pairId: string,
  as: "A" | "B" = "A"
): Promise<{ count: number; reason: string }> {
  for (let count = 0; count < 10_000; count += 1) {
    const res = await send(vfs, { op: "burn", pairId, as, plaintext: new Uint8Array([0x41]) });
    if (!res.ok) return { count, reason: (res as { reason?: string }).reason ?? "" };
  }
  throw new Error("the engine never refused; the budget under test is not small enough to exhaust");
}

describe("a fixed store's message count is bounded by the encryption budget, not the record total", () => {
  it("promises exactly the number of sends the engine will actually allow", async () => {
    // THE LOAD-BEARING TEST. F = 256 and E = 2048 give eight affordable sends
    // against one hundred records, so the two budgets disagree by 92 and the
    // reported figure cannot be right by coincidence.
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 2048, authRecords: 100, recordBytes: 256 });

    const promised = (await meters(vfs, pairId)).maxRemainingSends;
    expect(promised).toBe(8);

    const { count, reason } = await sendsUntilRefused(vfs, pairId);
    // The meter kept its word: the operator got exactly what it said they would.
    expect(count).toBe(promised);
    // And it is the ENCRYPTION budget that stopped them, with 92 records unused.
    expect(reason).toBe("encryption-exhausted");
    const after = await meters(vfs, pairId);
    expect(after.authentication.remainingRecords).toBe(92);
    expect(after.maxRemainingSends).toBe(0);
  });

  it("counts a 256-byte record's consumption, whatever the message length is", async () => {
    // The user-visible promise: two DIFFERENT plaintext lengths under the same
    // fixed F each cost exactly one message. A fixed record's whole point is
    // that a short message and a long one are indistinguishable, and they must
    // therefore be indistinguishable in the budget too.
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 2048, authRecords: 100, recordBytes: 256 });
    expect((await meters(vfs, pairId)).maxRemainingSends).toBe(8);

    const oneByte = asOk(
      await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) }),
      "burn"
    );
    // A one-byte message spends the WHOLE record, and the engine says so.
    expect(oneByte.consumed).toEqual({ encryptionBytes: 256, authRecords: 1 });
    expect((await meters(vfs, pairId)).maxRemainingSends).toBe(7);

    // 252 bytes is F − 4, the largest plaintext this record can hold.
    const full = asOk(
      await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(252) }),
      "burn"
    );
    expect(full.consumed).toEqual({ encryptionBytes: 256, authRecords: 1 });
    expect((await meters(vfs, pairId)).maxRemainingSends).toBe(6);
  });

  it("does not offer one more message at the boundary where the bytes run out first", async () => {
    // 2048 / 768 = 2 remainder 512. After two sends 512 bytes remain — more than
    // nothing, and not enough for a record. The old figure counted the 98 records
    // that survive; the pad cannot spend one of them.
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 2048, authRecords: 100, recordBytes: 768 });
    expect((await meters(vfs, pairId)).maxRemainingSends).toBe(2);

    asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) }), "burn");
    asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) }), "burn");

    const after = await meters(vfs, pairId);
    expect(after.encryption.remainingBytes).toBe(512);
    expect(after.authentication.remainingRecords).toBe(98);
    expect(after.maxRemainingSends).toBe(0);

    const refused = await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) });
    expect(refused.ok).toBe(false);
    expect((refused as { reason?: string }).reason).toBe("encryption-exhausted");
  });

  it("reproduces the Small-pad case the review found, from the shipped presets", async () => {
    // E = 16,384 per direction and N = 64 are the Small preset; F = 4096 is
    // accepted by every create screen. Four sends, and the old figure said 64.
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 16_384, authRecords: 64, recordBytes: 4096 });
    const m = await meters(vfs, pairId);
    expect(m.maxRemainingSends).toBe(4);
    expect(m.authentication.remainingRecords).toBe(64);
    expect((await sendsUntilRefused(vfs, pairId)).count).toBe(4);
  });

  it("says ENCRYPTION binds when the bytes afford fewer messages than the records", async () => {
    const vfs = new MemoryVfs();
    const bytesBound = await gen(vfs, { encryptionBytes: 2048, authRecords: 100, recordBytes: 256 });
    expect((await meters(vfs, bytesBound)).limitedBy).toBe("ENCRYPTION");

    // And AUTHENTICATION when the records are the scarcer half: 4096 bytes
    // affords 16 records of 256, but only 4 exist.
    const authBound = await gen(vfs, { encryptionBytes: 4096, authRecords: 4, recordBytes: 256 });
    const m = await meters(vfs, authBound);
    expect(m.limitedBy).toBe("AUTHENTICATION");
    expect(m.maxRemainingSends).toBe(4);
  });
});

describe("the capacity bar agrees with the badge beside it", () => {
  it("does not show a half-full bar for a pad that cannot send", async () => {
    // THE TWO USED TO DISAGREE IN THE SAME CARD. The status word became F-aware
    // when maxRemainingSends did; the bar kept dividing raw bytes, so a Small pad
    // fixed at F = 4096 read "Exhausted" beside a half-full bar at tone "ok".
    const vfs = new MemoryVfs();
    // 16,384 / 3072 = 5 records with 1024 bytes left over — bytes that survive
    // every send and can never pay for one. F = 4096 divides the budget exactly
    // and would leave nothing, which is the easy case; this is the real one.
    const pairId = await gen(vfs, { encryptionBytes: 16_384, authRecords: 64, recordBytes: 3072 });
    const full = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(padHealthPercent(full)).toBe(100);

    // BOTH HALVES, so the pad-level word is reached as well as the direction's.
    await sendsUntilRefused(vfs, pairId, "A");
    await sendsUntilRefused(vfs, pairId, "B");
    const spent = asOk(await send(vfs, { op: "status", pairId }), "status").pair;

    // Bytes survive — and not one of them can be spent.
    expect(spent.meters["A->B"].encryption.remainingBytes).toBe(1024);
    expect(spent.meters["A->B"].maxRemainingSends).toBe(0);
    expect(padStatusWord(spent).label).toBe("Exhausted");
    expect(padHealthPercent(spent), "the bar promises capacity the badge denies").toBe(0);
    expect(directionStatus(spent.meters["A->B"]).label).toBe("Exhausted");
  });

  it("is FULL on a fresh fixed pad whose records are the binding budget", async () => {
    // THE REGRESSION THE FIRST VERSION OF THIS REPAIR SHIPPED. The numerator was
    // maxRemainingSends, which already carries both budgets; the denominator was
    // the byte budget alone. Whenever records bind — which is the shipped default,
    // Medium at the offered F = 256 — the fraction was deflated and the bar drew
    // half-empty beside "Ready" on a pad nobody had used.
    // 4096/256 = 16 sends affordable by bytes against 8 records, so RECORDS bind —
    // the same shape as the shipped Medium preset (E = 262,144, N = 512) at the
    // offered F = 256, which affords 1024 by bytes and has 512 records.
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 4096, authRecords: 8, recordBytes: 256 });
    const fresh = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(fresh.meters["A->B"].maxRemainingSends).toBe(8);
    expect(padHealthPercent(fresh), "a brand-new pad does not read as part spent").toBe(100);
    expect(padStatusWord(fresh).label).toBe("Ready");

    // And it falls as messages are actually spent, rather than sitting at 100.
    asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) }), "burn");
    asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1) }), "burn");
    const spentTwo = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(spentTwo.meters["A->B"].maxRemainingSends).toBe(6);
    expect(directionStatus(spentTwo.meters["A->B"]).label).toBe("Ready");
    expect(padHealthPercent(spentTwo)).toBe(75);
  });

  it("still measures bytes on a variable store, where bytes are what runs out", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 2048, authRecords: 64 });
    expect(padHealthPercent(asOk(await send(vfs, { op: "status", pairId }), "status").pair)).toBe(100);
    // 1024 bytes of a 2048-byte budget, and records to spare: half left.
    asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: new Uint8Array(1024) }), "burn");
    const half = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(half.meters["A->B"].encryption.remainingBytes).toBe(1024);
    expect(directionStatus(half.meters["A->B"]).label).toBe("Ready");
  });
});

describe("a variable store's message count is unchanged", () => {
  it("still reports the record total, which is a true maximum when a send can be one byte", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, { encryptionBytes: 2048, authRecords: 6 });
    const before = await meters(vfs, pairId);
    expect(before.record).toEqual({ kind: "variable" });
    expect(before.maxRemainingSends).toBe(6);
    expect(before.maxRemainingSends).toBe(before.authentication.remainingRecords);

    // Six one-byte messages fit, and the engine agrees: records are the bound.
    const { count, reason } = await sendsUntilRefused(vfs, pairId);
    expect(count).toBe(6);
    expect(reason).toBe("auth-exhausted");
  });

  it("keeps both LIMITED BY verdicts exactly where they were", async () => {
    // The frozen §13 display rule for a variable store, unchanged: AUTHENTICATION
    // binds when even maximum-size sends cannot spend the bytes first.
    const vfs = new MemoryVfs();
    const authBound = await gen(vfs, { encryptionBytes: 16, authRecords: 1 });
    expect((await meters(vfs, authBound)).limitedBy).toBe("AUTHENTICATION");
    const encBound = await gen(vfs, { encryptionBytes: 16, authRecords: 2 });
    expect((await meters(vfs, encBound)).limitedBy).toBe("ENCRYPTION");
  });
});

/* ---- the CLI's own copy of the same engine ------------------------------- */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

describe("the CLI reports the same bounded figure", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "truepad2-fixed-capacity-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
    const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
    return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
  }

  it("bounds a fixed store by its encryption budget and leaves a variable one alone", () => {
    const src = join(dir, "s.bin");
    writeFileSync(src, randomBytes(2 * (2048 + 32 * 100)));

    const fixed = join(dir, "fixed");
    expect(
      run("gen", fixed, "--source", src, "--encryption-bytes", "2048", "--auth-records", "100",
          "--record-bytes", "256").code
    ).toBe(0);
    const fixedMeters = JSON.parse(run("status", fixed).stdout)["A->B"];
    expect(fixedMeters.record).toEqual({ kind: "fixed", bytes: 256 });
    expect(fixedMeters.authentication.remainingRecords).toBe(100);
    expect(fixedMeters.maxRemainingSends).toBe(8);
    expect(fixedMeters.limitedBy).toBe("ENCRYPTION");

    const variable = join(dir, "variable");
    expect(
      run("gen", variable, "--source", src, "--encryption-bytes", "2048", "--auth-records", "100").code
    ).toBe(0);
    const variableMeters = JSON.parse(run("status", variable).stdout)["A->B"];
    expect(variableMeters.record).toEqual({ kind: "variable" });
    expect(variableMeters.maxRemainingSends).toBe(100);
  });
});
