/* ============================================================================
 * TruePad pad meter core
 * ----------------------------------------------------------------------------
 * Pure state computation for the exhibit's signature element: the racing
 * bars (pad remaining vs. message length) and the entropy ledger. No DOM —
 * the UI renders whatever this returns.
 * ========================================================================= */

import type { PadSnapshot } from "./pad";

export type MeterStatus = "ready" | "low" | "exhausted";

// The lock message. This exact copy is the thing the exhibit is remembered
// by — the UI and the e2e suite both assert against this constant.
export const EXHAUSTED_MESSAGE =
  "Pad exhausted. A one-time pad cannot borrow, wrap, or reuse. " +
  "Generate more randomness — and physically deliver it — before you can send this.";

export const LEDGER_MOTTO = "never spend a bit twice";

// "low" warns when a message would use at least this fraction of what is
// left — the sender should be thinking about the next pad delivery.
export const LOW_PAD_FRACTION = 0.8;

export type EntropyLedger = {
  generatedBits: number;
  spentBits: number;
  remainingBits: number;
  motto: typeof LEDGER_MOTTO;
};

export type MeterState = {
  status: MeterStatus;
  canEncrypt: boolean;
  messageLength: number;
  remainingSymbols: number;
  // How many symbols short the pad is (0 when the message fits).
  deficitSymbols: number;
  // What would remain after sending this message (never negative).
  afterSendRemaining: number;
  // Lock copy when exhausted, null otherwise.
  message: string | null;
  ledger: EntropyLedger;
};

export function entropyLedger(snapshot: PadSnapshot): EntropyLedger {
  return {
    generatedBits: snapshot.generatedBits,
    spentBits: snapshot.spentBits,
    remainingBits: snapshot.remainingBits,
    motto: LEDGER_MOTTO
  };
}

export function meterState(snapshot: PadSnapshot, messageLength: number): MeterState {
  if (!Number.isInteger(messageLength) || messageLength < 0) {
    throw new Error("messageLength must be a non-negative integer");
  }
  const remainingSymbols = snapshot.remaining;
  const exhausted = messageLength > remainingSymbols;
  const low =
    !exhausted && messageLength > 0 && messageLength >= LOW_PAD_FRACTION * remainingSymbols;
  return {
    status: exhausted ? "exhausted" : low ? "low" : "ready",
    canEncrypt: !exhausted,
    messageLength,
    remainingSymbols,
    deficitSymbols: exhausted ? messageLength - remainingSymbols : 0,
    afterSendRemaining: exhausted ? remainingSymbols : remainingSymbols - messageLength,
    message: exhausted ? EXHAUSTED_MESSAGE : null,
    ledger: entropyLedger(snapshot)
  };
}
