import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* ============================================================================
 * tamper2 — the Phase-2 payoff, against the real binary.
 *
 * v1's tamper suite demonstrates the attack: edit an envelope field and the
 * receiver decrypts garbage — or, for a forged startOffset, burns pad at an
 * attacker-chosen window. This suite asserts v2's answer, invariant by
 * invariant (FORMAT-V2.md §12.3, §13, ledger N8/N9):
 *
 *   - every one of the eight envelope fields is covered: tampering any of
 *     them is refused with exit 2 BEFORE any burn — the receiving store's
 *     high-waters do not move and not one byte of secret.bin changes;
 *   - structural and window refusals cost NO durable write: journal.log is
 *     byte-identical before and after;
 *   - a tamper that reaches verification costs exactly the stated price —
 *     one attempt reservation and one failure record in journal.log, with
 *     the attempt line landing BEFORE the auth-fail line (the reservation
 *     precedes the verification), and never an open line;
 *   - after every refusal the intact envelope still opens: a failed
 *     verification burns neither namespace;
 *   - attempt counters are durable across process invocations (every run
 *     here is its own process), so verifyAttemptLimit failures leave the
 *     sequence permanently contested through any restart, and clearing a
 *     freeze never resets them.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

const E = 64; // encryption capacity per direction, bytes
const N = 8; // auth records per direction
const PLAINTEXT = "hello"; // 5 bytes: sequence 0, offsets [0, 5)

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-tamper-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

type Scene = {
  a: string;
  b: string;
  intact: string; // the genuine envelope line, as burn emitted it
  envelope: Record<string, unknown>;
  recv: string; // B's receiving direction store: <b>/a-to-b
};

// gen once, courier-copy to B, burn one record in A's copy. The tampering
// then happens to the envelope in transit; B's copy is the receiving store.
function scene(...genExtra: string[]): Scene {
  const a = join(dir, "a");
  const b = join(dir, "b");
  const source = join(dir, "source.bin");
  writeFileSync(source, randomBytes(2 * (E + 32 * N)));
  const gen = run("gen", a, "--source", source, "--encryption-bytes", String(E), "--auth-records", String(N), ...genExtra);
  expect(gen.code).toBe(0);
  cpSync(a, b, { recursive: true });
  const burn = run("burn", a, "--as", "A", PLAINTEXT);
  expect(burn.code).toBe(0);
  const intact = burn.stdout.trim();
  return { a, b, intact, envelope: JSON.parse(intact), recv: join(b, "a-to-b") };
}

function tampered(s: Scene, edits: Record<string, unknown>): string {
  return JSON.stringify({ ...s.envelope, ...edits });
}

function flipHex(hex: string, index = 0): string {
  return hex.slice(0, index) + (hex[index] === "0" ? "1" : "0") + hex.slice(index + 1);
}

function journalRecords(recv: string): Record<string, unknown>[] {
  return readFileSync(join(recv, "journal.log"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function highWaters(recv: string): { nextOffset: number; nextSequence: number } {
  const head = JSON.parse(readFileSync(join(recv, "head.json"), "utf8"));
  return { nextOffset: head.encryption.nextOffset, nextSequence: head.authentication.nextSequence };
}

// A tamper that reaches verification: exit 2, auth-failed; the journal gains
// exactly one attempt line and one auth-fail line for the reserved sequence,
// in that order, and no open line; the high-waters do not move; not one byte
// of secret.bin changes. That is §14.1's stated durable cost, and nothing else.
function expectAuthFailed(s: Scene, envelopeLine: string, reservedSequence: number): void {
  const journalBefore = journalRecords(s.recv);
  const watersBefore = highWaters(s.recv);
  const secretBefore = readFileSync(join(s.recv, "secret.bin"));

  const result = run("open", s.b, "--as", "B", envelopeLine);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe(""); // no plaintext, not even a fragment
  expect(result.stderr).toContain("refused: auth-failed");
  expect(result.stderr).toContain("No pad material was consumed");

  const journalAfter = journalRecords(s.recv);
  expect(journalAfter.length).toBe(journalBefore.length + 2);
  expect(journalAfter[journalAfter.length - 2]).toMatchObject({ op: "attempt", sequence: reservedSequence });
  expect(journalAfter[journalAfter.length - 1]).toMatchObject({ op: "auth-fail", sequence: reservedSequence });
  expect(journalAfter.some((record) => record.op === "open")).toBe(false);
  expect(highWaters(s.recv)).toEqual(watersBefore);
  expect(readFileSync(join(s.recv, "secret.bin")).equals(secretBefore)).toBe(true);
}

// A tamper refused structurally or by the window: exit 2 with the named type,
// and NO durable write of any kind — journal.log, head.json, and secret.bin
// are byte-identical before and after.
function expectFreeRefusal(s: Scene, envelopeLine: string, type: string): void {
  const journalBefore = readFileSync(join(s.recv, "journal.log"), "utf8");
  const headBefore = readFileSync(join(s.recv, "head.json"), "utf8");
  const secretBefore = readFileSync(join(s.recv, "secret.bin"));

  const result = run("open", s.b, "--as", "B", envelopeLine);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`refused: ${type}`);

  expect(readFileSync(join(s.recv, "journal.log"), "utf8")).toBe(journalBefore);
  expect(readFileSync(join(s.recv, "head.json"), "utf8")).toBe(headBefore);
  expect(readFileSync(join(s.recv, "secret.bin")).equals(secretBefore)).toBe(true);
}

// The payoff line of every case: after the refusal, the genuine envelope
// still opens. A refused forgery burned neither namespace.
function expectIntactOpens(s: Scene): void {
  const result = run("open", s.b, "--as", "B", s.intact);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(PLAINTEXT);
}

describe("every envelope field: tampering is refused before any burn", { timeout: 120_000 }, () => {
  it("formatVersion: forged to 1 is malformed-envelope — structural, no durable write", () => {
    const s = scene();
    expectFreeRefusal(s, tampered(s, { formatVersion: 1 }), "malformed-envelope");
    expectIntactOpens(s);
  });

  it("pairId: a different pair's id is wrong-pair — structural, no durable write", () => {
    const s = scene();
    expectFreeRefusal(s, tampered(s, { pairId: flipHex(s.envelope.pairId as string) }), "wrong-pair");
    expectIntactOpens(s);
  });

  it("direction: flipped to the reverse channel is wrong-direction — structural, no durable write", () => {
    const s = scene();
    expectFreeRefusal(s, tampered(s, { direction: "B->A" }), "wrong-direction");
    expectIntactOpens(s);
  });

  it("sequence: shifted inside the window, the tag no longer verifies — auth-failed, reserved on the forged sequence", () => {
    const s = scene();
    // Sequence 1 is inside the lookahead window, so this survives O1 and dies
    // at O4: the tag was computed over sequence 0, and record 1's K/R refuse it.
    expectAuthFailed(s, tampered(s, { sequence: 1 }), 1);
    // Sequence 0 spent nothing; the genuine record still opens.
    expectIntactOpens(s);
  });

  it("startOffset: THE v1 burn attack is auth-failed, with the original window still live", () => {
    const s = scene();
    // In v1 this exact edit made the receiver decrypt — and burn — at the
    // attacker's chosen offset. In v2 startOffset is under the tag: shifting
    // it by one byte fails verification before any material moves.
    expectAuthFailed(s, tampered(s, { startOffset: 1 }), 0);
    // The proof the window is untouched: the intact envelope decrypts at its
    // ORIGINAL startOffset, which only works if bytes [0, 5) are still live.
    expectIntactOpens(s);
  });

  it("ciphertextLength: a bare length edit is malformed; a consistent truncation reaches verification and is auth-failed", () => {
    const s = scene();
    const declared = s.envelope.ciphertextLength as number;
    const hex = s.envelope.ciphertext as string;
    // Declared length alone: the §6.2 cross-check refuses it structurally.
    expectFreeRefusal(s, tampered(s, { ciphertextLength: declared - 1 }), "malformed-envelope");
    // Length and hex truncated together: structurally clean, but the tag was
    // computed over the full ciphertext — auth-failed, one attempt spent.
    expectAuthFailed(s, tampered(s, { ciphertextLength: declared - 1, ciphertext: hex.slice(0, -2) }), 0);
    expectIntactOpens(s);
  });

  it("ciphertext: one flipped byte is auth-failed — no garbage plaintext is ever released", () => {
    const s = scene();
    expectAuthFailed(s, tampered(s, { ciphertext: flipHex(s.envelope.ciphertext as string) }), 0);
    expectIntactOpens(s);
  });

  it("tag: one flipped hex digit is auth-failed", () => {
    const s = scene();
    expectAuthFailed(s, tampered(s, { tag: flipHex(s.envelope.tag as string) }), 0);
    expectIntactOpens(s);
  });
});

describe("structural and window refusals cost no durable write at all", { timeout: 120_000 }, () => {
  it("a forged out-of-window sequence appends no journal line", () => {
    const s = scene("--max-auth-lookahead", "4");
    // Window is [0, 4): sequence 4 exists in the store (N = 8) but is beyond
    // the finite lookahead — refused at O1, before the reservation.
    expectFreeRefusal(s, tampered(s, { sequence: 4 }), "sequence-out-of-window");
    expectIntactOpens(s);
  });

  it("an oversize declared length appends no journal line", () => {
    const s = scene();
    // Oversize fires on the DECLARED length, before the hex cross-check and
    // long before any secret is touched.
    expectFreeRefusal(s, tampered(s, { ciphertextLength: 1048577 }), "oversize-ciphertext");
    expectIntactOpens(s);
  });
});

describe("the reservation, the attempt limit, and the freeze", { timeout: 120_000 }, () => {
  it("the reservation precedes verification: the attempt line is in the journal after every auth-failed refusal", () => {
    const s = scene();
    expectAuthFailed(s, tampered(s, { tag: flipHex(s.envelope.tag as string) }), 0);
    // grep journal.log: the attempt reservation for sequence 0 exists, and it
    // was appended BEFORE the failure record — a crash between the two could
    // only lose an attempt, never grant one.
    const raw = readFileSync(join(s.recv, "journal.log"), "utf8");
    expect(raw).toMatch(/"op":"attempt","sequence":0/);
    const records = journalRecords(s.recv);
    const attemptIndex = records.findIndex((record) => record.op === "attempt");
    const failIndex = records.findIndex((record) => record.op === "auth-fail");
    expect(attemptIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeGreaterThan(attemptIndex);
  });

  it("verifyAttemptLimit failures leave the sequence permanently contested — across fresh process invocations", () => {
    const s = scene("--verify-attempt-limit", "2");
    const forged = tampered(s, { tag: flipHex(s.envelope.tag as string) });

    // Every run here is its own spawned process: the counters that add up to
    // "contested" survive each exit purely because they are durable on disk.
    const first = run("open", s.b, "--as", "B", forged);
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("refused: auth-failed");
    expect(first.stderr).toContain("1 verification attempt left");
    const second = run("open", s.b, "--as", "B", forged);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("refused: auth-failed");

    // Third process: contested, and contested applies to the INTACT envelope
    // too — the sequence is never verifiable again under its K/R.
    const third = run("open", s.b, "--as", "B", forged);
    expect(third.code).toBe(2);
    expect(third.stderr).toContain("refused: sequence-contested");
    const genuine = run("open", s.b, "--as", "B", s.intact);
    expect(genuine.code).toBe(2);
    expect(genuine.stderr).toContain("permanently contested");

    // The contested refusal is a free state check: still exactly the two
    // reservations from the two failures, none from the refusals after.
    const attempts = journalRecords(s.recv).filter((record) => record.op === "attempt");
    expect(attempts.length).toBe(2);
  });

  it("the freeze is pair-wide and reversible; clearing it never resets attempt counters", () => {
    const s = scene("--verify-attempt-limit", "2", "--freeze-threshold", "2");
    const forged = tampered(s, { tag: flipHex(s.envelope.tag as string) });
    expect(run("open", s.b, "--as", "B", forged).code).toBe(2);
    expect(run("open", s.b, "--as", "B", forged).code).toBe(2);

    // failureCount reached the threshold: the whole pair pauses — opening,
    // and sending on the OTHER direction too.
    const frozenOpen = run("open", s.b, "--as", "B", s.intact);
    expect(frozenOpen.code).toBe(2);
    expect(frozenOpen.stderr).toContain("refused: frozen");
    const frozenBurn = run("burn", s.b, "--as", "B", "reply");
    expect(frozenBurn.code).toBe(2);
    expect(frozenBurn.stderr).toContain("refused: frozen");
    const status = run("status", s.b);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)["A->B"].verification.frozen).toBe(true);

    // The freeze is the reversible operator brake — but clearing it does not
    // hand the attacker fresh attempts: the sequence stays contested.
    const clear = run("clear-freeze", s.b);
    expect(clear.code).toBe(0);
    expect(JSON.parse(clear.stdout)).toEqual({ cleared: 1 });
    expect(clear.stderr).toContain("Attempt counters are NOT");
    const stillContested = run("open", s.b, "--as", "B", s.intact);
    expect(stillContested.code).toBe(2);
    expect(stillContested.stderr).toContain("refused: sequence-contested");
  });
});

/* ============================================================================
 * The reservation is not a failure-path artifact (ledger N9). Reserve-only-
 * on-failure reproduces every journal shape the refusal tests above check;
 * what distinguishes reserve-BEFORE-verify is the attempt line a SUCCESSFUL
 * open leaves behind. And the header defaults (§1.1) are what nearly every
 * real store runs; a mis-wired default would disable a brake silently.
 * ========================================================================= */

describe("reservation before verification, on the success path too (N9)", () => {
  it("a successful open journals its attempt line, before the open line", () => {
    const s = scene();
    const result = run("open", s.b, "--as", "B", s.intact);
    expect(result.code).toBe(0);
    const records = journalRecords(s.recv);
    const attemptIndex = records.findIndex((r) => r.op === "attempt" && r.sequence === 0);
    const openIndex = records.findIndex((r) => r.op === "open" && r.sequence === 0);
    expect(attemptIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(attemptIndex);
  });
});

describe("gen freezes the documented defaults into the header (§1.1)", () => {
  it("a default gen writes verifyAttemptLimit 8, maxAuthLookahead 64, freeze threshold 32", () => {
    const s = scene(); // no knob flags
    const head = JSON.parse(readFileSync(join(s.recv, "head.json"), "utf8"));
    expect(head.authentication.verifyAttemptLimit).toBe(8);
    expect(head.authentication.maxAuthLookahead).toBe(64);
    expect(head.verification.failurePolicy).toEqual({ kind: "freeze", threshold: 32 });
  });
});
