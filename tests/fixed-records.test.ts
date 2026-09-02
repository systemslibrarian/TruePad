import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFrame, frameCapacity, parseFrame } from "../src/core/frame2";
import { bytesToHex, hexToBytes } from "../src/core/hex";
import { wcTag } from "../src/core/wc-one-time";
import { loadStore2, readAuthRecord, readEncryption } from "../src/cli/v2/store2";
import { encodeEnvelope2 } from "../src/core/envelope2";

/* ============================================================================
 * truepad2 fixed-size records end to end (FORMAT-V2.md §16; ledger N19–N20).
 * The real binary via the launcher, the courier model of truepad2-cli.test.ts
 * (gen once, cp -R to each peer, A burns a-to-b, B opens it), tiny budgets.
 *
 * The point of a fixed store: every ciphertext on the wire is exactly F bytes,
 * so the channel observes record count and timing but never message length.
 * Its price, stated: every send spends F encryption bytes and one auth record
 * however short the message. Plaintext capacity per record is F − 4 (the u32
 * length prefix moves inside the encrypted-and-authenticated frame, §16.1).
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

let dir: string;
let sourceCount = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-fixed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

// Raw-buffer variant for byte-exact release assertions: a utf8 spawn would
// mangle a plaintext with bytes outside the ASCII range.
function runBytes(...argv: string[]): { code: number; stdout: Buffer; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv]);
  return { code: child.status ?? -1, stdout: child.stdout ?? Buffer.alloc(0), stderr: (child.stderr ?? Buffer.alloc(0)).toString("utf8") };
}

function sourceFile(bytes: number): string {
  sourceCount += 1;
  const path = join(dir, `source-${sourceCount}.bin`);
  writeFileSync(path, randomBytes(bytes));
  return path;
}

// gen a store with the given record policy. `f` undefined → variable (no flag).
function genStore(pair: string, e: number, n: number, f?: number): { code: number; stdout: string; stderr: string } {
  const source = sourceFile(2 * (e + 32 * n));
  const extra = f === undefined ? [] : ["--record-bytes", String(f)];
  return run("gen", pair, "--source", source, "--encryption-bytes", String(e), "--auth-records", String(n), ...extra);
}

const F = 64; // multiple of 16, 32 <= F <= 1 MiB; capacity F − 4 = 60.

describe("frame2 codec (FORMAT-V2.md §16.1)", () => {
  it("frameCapacity is F − 4", () => {
    expect(frameCapacity(64)).toBe(60);
    expect(frameCapacity(32)).toBe(28);
  });

  it("round-trips arbitrary bytes, empty, and exactly F − 4", () => {
    for (const plaintext of [new Uint8Array(0), new Uint8Array([1, 2, 3]), randomBytes(frameCapacity(F))]) {
      const frame = buildFrame(new Uint8Array(plaintext), F);
      expect(frame.length).toBe(F); // always exactly F bytes on the wire
      const parsed = parseFrame(frame);
      expect(parsed).not.toBeNull();
      expect([...(parsed as Uint8Array)]).toEqual([...plaintext]);
    }
  });

  it("buildFrame throws when the plaintext exceeds F − 4", () => {
    expect(() => buildFrame(new Uint8Array(frameCapacity(F) + 1), F)).toThrow();
  });

  it("parseFrame returns null when the length prefix exceeds F − 4 (the record-frame-invalid signature)", () => {
    const frame = new Uint8Array(F); // capacity 60
    new DataView(frame.buffer).setUint32(0, frameCapacity(F) + 1, true); // 61 > 60
    expect(parseFrame(frame)).toBeNull();
  });
});

describe("fixed-size records end to end", { timeout: 120_000 }, () => {
  it("gen --record-bytes writes recordPolicy.record fixed; a default gen writes variable", () => {
    const fixed = join(dir, "fixed");
    expect(genStore(fixed, 256, 4, F).code).toBe(0);
    const headFixed = JSON.parse(readFileSync(join(fixed, "a-to-b", "head.json"), "utf8"));
    expect(headFixed.recordPolicy.record).toEqual({ kind: "fixed", bytes: F });

    const variable = join(dir, "variable");
    expect(genStore(variable, 64, 2).code).toBe(0);
    const headVar = JSON.parse(readFileSync(join(variable, "a-to-b", "head.json"), "utf8"));
    expect(headVar.recordPolicy.record).toEqual({ kind: "variable" });
  });

  it("round trip: short, empty, and exactly F − 4 bytes; every envelope's ciphertextLength is F", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genStore(a, 256, 4, F).code).toBe(0);
    cpSync(a, b, { recursive: true });

    const capacity = frameCapacity(F); // 60
    const exact = "z".repeat(capacity); // exactly F − 4 ASCII bytes
    for (const message of ["hi", "", exact]) {
      const burn = run("burn", a, "--as", "A", message);
      expect(burn.code).toBe(0);
      const envelope = JSON.parse(burn.stdout.trim());
      // N19: the wire ciphertextLength is F, never the message length.
      expect(envelope.ciphertextLength).toBe(F);

      const opened = run("open", b, "--as", "B", burn.stdout.trim());
      expect(opened.code).toBe(0);
      expect(opened.stdout).toBe(message);
    }
  });

  it("binary plaintext is released byte-exact through the frame", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genStore(a, 64, 1, F).code).toBe(0);
    cpSync(a, b, { recursive: true });

    const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0x00, 0xc3, 0x28, 0x0a, 0xf0]);
    const input = join(dir, "payload.bin");
    writeFileSync(input, payload);
    const burn = run("burn", a, "--as", "A", "--in", input);
    expect(burn.code).toBe(0);
    expect(JSON.parse(burn.stdout.trim()).ciphertextLength).toBe(F);

    const opened = runBytes("open", b, "--as", "B", burn.stdout.trim());
    expect(opened.code).toBe(0);
    expect(Buffer.compare(opened.stdout, payload)).toBe(0);
  });

  it("a plaintext longer than F − 4 is refused record-size-mismatch, free (nothing consumed)", () => {
    const a = join(dir, "a");
    expect(genStore(a, 64, 1, F).code).toBe(0);

    const tooBig = join(dir, "toobig.bin");
    writeFileSync(tooBig, randomBytes(frameCapacity(F) + 1)); // 61 > 60
    const journalBefore = readFileSync(join(a, "a-to-b", "journal.log"));
    const burn = run("burn", a, "--as", "A", "--in", tooBig);
    expect(burn.code).toBe(2);
    expect(burn.stderr).toContain("refused: record-size-mismatch");
    expect(burn.stdout).toBe("");
    // Free: no envelope, and the journal is byte-identical (nothing staged).
    expect(readFileSync(join(a, "a-to-b", "journal.log")).equals(journalBefore)).toBe(true);
  });

  it("open of a ciphertextLength ≠ F envelope is refused record-size-mismatch before the window checks (journal identical)", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genStore(a, 128, 2, F).code).toBe(0);
    cpSync(a, b, { recursive: true });

    // A real F-byte envelope, then the same envelope re-sized on the wire: same
    // pair and direction, so O0's wrong-pair/wrong-direction pass and the
    // fixed-size check is what refuses — before any window check or reservation.
    const real = JSON.parse(run("burn", a, "--as", "A", "hello").stdout.trim());
    const bad = JSON.stringify({ ...real, ciphertextLength: 32, ciphertext: "ab".repeat(32) });

    const journalBefore = readFileSync(join(b, "a-to-b", "journal.log"));
    const opened = run("open", b, "--as", "B", bad);
    expect(opened.code).toBe(2);
    expect(opened.stderr).toContain("refused: record-size-mismatch");
    expect(opened.stdout).toBe("");
    // Before the window checks and before any reservation: journal byte-identical.
    expect(readFileSync(join(b, "a-to-b", "journal.log")).equals(journalBefore)).toBe(true);
  });

  it("a pre-Phase-5 header (no recordPolicy.record) loads as variable and burn/open still work", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genStore(a, 64, 2).code).toBe(0); // fresh, variable, high-water 0

    // Hand-craft the pre-Phase-5 shape by deleting the field on the FRESH store
    // (high-water still 0, so the journal-mark rule is untouched) and rewriting
    // head.json compactly, exactly as store2 writes it.
    for (const direction of ["a-to-b", "b-to-a"]) {
      const headPath = join(a, direction, "head.json");
      const head = JSON.parse(readFileSync(headPath, "utf8"));
      delete head.recordPolicy.record;
      writeFileSync(headPath, JSON.stringify(head));
    }
    cpSync(a, b, { recursive: true });

    const burn = run("burn", a, "--as", "A", "legacy header");
    expect(burn.code).toBe(0);
    // A variable store sizes the ciphertext to the message (13 bytes), not F.
    expect(JSON.parse(burn.stdout.trim()).ciphertextLength).toBe(13);
    const opened = run("open", b, "--as", "B", burn.stdout.trim());
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe("legacy header");
  });

  it("pad spend: one 1-byte send on a fixed store advances encryption.nextOffset by exactly F", () => {
    const a = join(dir, "a");
    expect(genStore(a, 64, 1, F).code).toBe(0);
    expect(run("burn", a, "--as", "A", "x").code).toBe(0); // 1-byte message

    const status = JSON.parse(run("status", a).stdout);
    // The stated price: F encryption bytes spent regardless of message size.
    expect(status["A->B"].encryption.nextOffset).toBe(F);
    expect(status["A->B"].record).toEqual({ kind: "fixed", bytes: F });
  });

  it("a valid-tag frame whose length prefix exceeds F−4 is record-frame-invalid (exit 1) AFTER commit — material retired, nothing released (§16.2)", () => {
    // The one §16.2 path the unit test cannot reach: a frame that verifies but
    // decodes to an over-capacity length. Forge it with the store's OWN key,
    // mask, and pad — a conforming sender could never emit it, but the receiver
    // must fail closed (exit 1), having already retired the material.
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genStore(a, 256, 4, F).code).toBe(0);
    cpSync(a, b, { recursive: true });

    const halfDir = join(b, "a-to-b");
    const loaded = loadStore2(halfDir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const head = loaded.head;
    const sequence = 0;
    const startOffset = 0;

    // A frame of exactly F bytes whose u32-LE length prefix is F−3 (> F−4).
    const badFrame = new Uint8Array(F);
    const badLen = frameCapacity(F) + 1; // F - 3
    badFrame[0] = badLen & 0xff;
    badFrame[1] = (badLen >> 8) & 0xff;
    expect(parseFrame(badFrame)).toBeNull(); // sanity: this is the invalid case

    const pad = readEncryption(halfDir, head, startOffset, F);
    const ciphertext = new Uint8Array(F);
    for (let i = 0; i < F; i += 1) ciphertext[i] = badFrame[i] ^ pad[i];

    const { key, mask } = readAuthRecord(halfDir, head, sequence);
    const tag = wcTag(key, mask, {
      pairId: hexToBytes(head.pairId)!,
      direction: "A->B",
      sequence,
      startOffset,
      ciphertext
    });
    const envelope = encodeEnvelope2({
      pairId: head.pairId,
      direction: "A->B",
      sequence,
      startOffset,
      ciphertextLength: F,
      ciphertext,
      tag
    });

    const before = JSON.parse(run("status", b).stdout)["A->B"].authentication.nextSequence;
    const opened = run("open", b, "--as", "B", envelope);
    expect(opened.code).toBe(1); // an error, not a typed refusal
    expect(opened.stderr).toContain("record-frame-invalid");
    expect(opened.stdout).toBe(""); // nothing released
    // The tag verified, so O5 committed: the material is retired and lost.
    const after = JSON.parse(run("status", b).stdout)["A->B"].authentication.nextSequence;
    expect(after).toBe(before + 1);
  });
});

describe("fixed records: length privacy and the exact consumption price", () => {
  const BIG = 4096; // capacity 4092, big enough to hold a 2000-byte message

  it("(§17) a 1-byte and a 2000-byte message produce identical ciphertext length — plaintext length does not determine it", () => {
    // Two fresh, otherwise-equivalent stores at the same sequence/offset, so the
    // WHOLE serialized envelope is comparable, not only the ciphertext field.
    const one = join(dir, "one");
    const two = join(dir, "two");
    expect(genStore(one, 65536, 8, BIG).code).toBe(0);
    expect(genStore(two, 65536, 8, BIG).code).toBe(0);

    const shortMsg = join(dir, "short.bin");
    const longMsg = join(dir, "long.bin");
    writeFileSync(shortMsg, randomBytes(1));
    writeFileSync(longMsg, randomBytes(2000));

    const burnShort = run("burn", one, "--as", "A", "--in", shortMsg);
    const burnLong = run("burn", two, "--as", "A", "--in", longMsg);
    expect(burnShort.code).toBe(0);
    expect(burnLong.code).toBe(0);

    const envShort = JSON.parse(burnShort.stdout.trim());
    const envLong = JSON.parse(burnLong.stdout.trim());
    // The ciphertext portion is F for both — the plaintext length is invisible.
    expect(envShort.ciphertextLength).toBe(BIG);
    expect(envLong.ciphertextLength).toBe(BIG);
    // Both are the first send on a fresh store (sequence 0, offset 0), so the
    // full serialized envelope length is identical too: no field varies with
    // plaintext length. (Across DIFFERENT sequences/offsets the outer envelope
    // could differ by the DECIMAL WIDTH of the sequence/offset integers — a
    // function of how many records preceded it, never of the plaintext length.)
    expect(envShort.sequence).toBe(0);
    expect(envLong.sequence).toBe(0);
    expect(burnShort.stdout.trim().length).toBe(burnLong.stdout.trim().length);
  });

  it("one fixed send consumes exactly one auth record and exactly F encryption bytes", () => {
    const a = join(dir, "a");
    expect(genStore(a, 512, 4, F).code).toBe(0);
    const before = JSON.parse(run("status", a).stdout)["A->B"];
    expect(run("burn", a, "--as", "A", "hello").code).toBe(0);
    const after = JSON.parse(run("status", a).stdout)["A->B"];
    expect(after.authentication.nextSequence).toBe(before.authentication.nextSequence + 1); // one auth record
    expect(after.encryption.nextOffset).toBe(before.encryption.nextOffset + F); // F encryption bytes
  });

  it("a fixed store stays fixed at the same F across reload (loadStore2 and a second status)", () => {
    const a = join(dir, "a");
    expect(genStore(a, 512, 4, F).code).toBe(0);
    const loaded = loadStore2(join(a, "a-to-b"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.head.recordPolicy.record).toEqual({ kind: "fixed", bytes: F });
    // A burn, then a reload: still fixed at the same F, never silently variable.
    expect(run("burn", a, "--as", "A", "x").code).toBe(0);
    expect(JSON.parse(run("status", a).stdout)["A->B"].record).toEqual({ kind: "fixed", bytes: F });
  });
});
