import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_MESSAGE,
  LEDGER_MOTTO,
  entropyLedger,
  meterState
} from "../src/meter";
import { LETTER_BITS, Pad } from "../src/pad";

describe("meterState", () => {
  it("is ready when the message fits comfortably", () => {
    const pad = Pad.generate(1000, "letters");
    const state = meterState(pad.snapshot(), 100);
    expect(state.status).toBe("ready");
    expect(state.canEncrypt).toBe(true);
    expect(state.deficitSymbols).toBe(0);
    expect(state.afterSendRemaining).toBe(900);
    expect(state.message).toBeNull();
  });

  it("warns low when the message would eat most of the pad", () => {
    const pad = Pad.generate(100, "letters");
    const state = meterState(pad.snapshot(), 85);
    expect(state.status).toBe("low");
    expect(state.canEncrypt).toBe(true);
  });

  it("allows a message that exactly drains the pad — equality is not exhaustion", () => {
    const pad = Pad.generate(50, "letters");
    const state = meterState(pad.snapshot(), 50);
    expect(state.status).toBe("low");
    expect(state.canEncrypt).toBe(true);
    expect(state.afterSendRemaining).toBe(0);
  });

  it("locks with the exhibit's exact copy when the message exceeds the pad", () => {
    const pad = Pad.generate(50, "letters");
    pad.consume(30);
    const state = meterState(pad.snapshot(), 21);
    expect(state.status).toBe("exhausted");
    expect(state.canEncrypt).toBe(false);
    expect(state.deficitSymbols).toBe(1);
    expect(state.afterSendRemaining).toBe(20);
    expect(state.message).toBe(EXHAUSTED_MESSAGE);
    expect(EXHAUSTED_MESSAGE).toContain("cannot borrow, wrap, or reuse");
    expect(EXHAUSTED_MESSAGE).toContain("physically deliver");
  });

  it("is ready at message length zero even on an empty pad", () => {
    const pad = Pad.generate(5, "letters");
    pad.consume(5);
    const state = meterState(pad.snapshot(), 0);
    expect(state.status).toBe("ready");
    expect(state.canEncrypt).toBe(true);
  });

  it("rejects a negative or fractional message length", () => {
    const snapshot = Pad.generate(10, "letters").snapshot();
    expect(() => meterState(snapshot, -1)).toThrow();
    expect(() => meterState(snapshot, 2.5)).toThrow();
  });
});

describe("entropy ledger", () => {
  it("mirrors the pad's bit accounting and carries the motto", () => {
    const pad = Pad.generate(200, "letters");
    pad.consume(60);
    const ledger = entropyLedger(pad.snapshot());
    expect(ledger.generatedBits).toBeCloseTo(200 * LETTER_BITS, 6);
    expect(ledger.spentBits).toBeCloseTo(60 * LETTER_BITS, 6);
    expect(ledger.remainingBits).toBeCloseTo(140 * LETTER_BITS, 6);
    expect(ledger.motto).toBe(LEDGER_MOTTO);
    expect(LEDGER_MOTTO).toBe("never spend a bit twice");
  });

  it("never lets spent bits shrink: the ledger only ticks one way", () => {
    const pad = Pad.generate(30, "bytes");
    let previousSpent = -1;
    for (let i = 0; i < 6; i += 1) {
      pad.consume(5);
      const ledger = entropyLedger(pad.snapshot());
      expect(ledger.spentBits).toBeGreaterThan(previousSpent);
      previousSpent = ledger.spentBits;
    }
    expect(entropyLedger(pad.snapshot()).remainingBits).toBe(0);
  });
});
