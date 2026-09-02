/* ============================================================================
 * Withdrawal authority — the irreversible, pair-bound downgrade record (§5)
 * ----------------------------------------------------------------------------
 * `withdrawal.json` is a SEPARATE durable authority the evaluator consults
 * independently of `provenance.json`. When it names a pair, that pair's ceremony
 * premise is forced to `withdrawn` — NOT ELIGIBLE — so restoring an older,
 * stronger `provenance.json` cannot raise the classification.
 *
 * These tests pin the reader's strictness (fail closed on any malformation) and
 * the pair binding: a withdrawal recorded for a different pair does not apply.
 * ========================================================================= */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWithdrawn, readWithdrawal, WITHDRAWAL_FILE, withdrawalRecord, writeWithdrawal } from "../src/cli/v2/withdrawal";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-withdrawal-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAIR = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const AT = "2026-09-02T00:00:00.000Z";
const writeRaw = (text: string): void => writeFileSync(join(dir, WITHDRAWAL_FILE), text);

describe("round-trip and pair binding", () => {
  it("writes and reads back a withdrawal record", () => {
    writeWithdrawal(dir, withdrawalRecord(PAIR, AT, "operator withdrew"));
    expect(readWithdrawal(dir)).toEqual({
      withdrawalVersion: 1,
      pairId: PAIR,
      withdrawnAt: AT,
      reason: "operator withdrew"
    });
  });

  it("isWithdrawn is true only for the exact pair it names", () => {
    writeWithdrawal(dir, withdrawalRecord(PAIR, AT, "gone"));
    expect(isWithdrawn(dir, PAIR)).toBe(true);
    expect(isWithdrawn(dir, OTHER)).toBe(false); // a withdrawal for another pair does not apply
  });

  it("no withdrawal file means not withdrawn", () => {
    expect(readWithdrawal(dir)).toBeNull();
    expect(isWithdrawn(dir, PAIR)).toBe(false);
  });
});

describe("the reader is strict and fails closed", () => {
  const base = withdrawalRecord(PAIR, AT, "r");

  it("rejects a torn / unparsable file", () => {
    writeRaw('{"withdrawalVersion":1,"pairId":"012');
    expect(readWithdrawal(dir)).toBeNull();
    expect(isWithdrawn(dir, PAIR)).toBe(false);
  });

  it("rejects an extra or missing key", () => {
    writeRaw(JSON.stringify({ ...base, extra: 1 }));
    expect(readWithdrawal(dir)).toBeNull();
    const { reason, ...missing } = base;
    void reason;
    writeRaw(JSON.stringify(missing));
    expect(readWithdrawal(dir)).toBeNull();
  });

  it("rejects a wrong version or a bad pairId shape", () => {
    writeRaw(JSON.stringify({ ...base, withdrawalVersion: 2 }));
    expect(readWithdrawal(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, pairId: "not-hex" }));
    expect(readWithdrawal(dir)).toBeNull();
  });

  it("rejects a wrong type on a field", () => {
    writeRaw(JSON.stringify({ ...base, withdrawnAt: 1 }));
    expect(readWithdrawal(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, reason: 1 }));
    expect(readWithdrawal(dir)).toBeNull();
  });
});
