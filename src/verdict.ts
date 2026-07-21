/* ============================================================================
 * TruePad Shannon verdict core
 * ----------------------------------------------------------------------------
 * One grader, two exhibits. gradeShannon() checks the three conditions of
 * Shannon's perfect-secrecy theorem against either a TruePad pad or a
 * DeckBook-style shuffled deck:
 *
 *   1. key-at-least-message — the key must carry at least as much entropy
 *      as the message (one full-entropy symbol per plaintext symbol).
 *   2. independent-uniform  — every key symbol must be an independent
 *      uniform draw.
 *   3. used-once            — every key symbol is used exactly once, ever.
 *
 * A true pad passes all three by construction. A deck fails condition 1 on
 * entropy arithmetic — log2(52!) ≈ 225.6 bits available vs. 52 × log2(26) ≈
 * 244.4 bits needed for 52 letters — and fails condition 2 because its
 * keystream is one permutation sampled without replacement and folded mod
 * 26, not independent draws. That is the whole difference between the two
 * exhibits, stated as arithmetic.
 * ========================================================================= */

import { LETTER_BITS, Pad } from "./pad";

export const DECK_CARDS = 52;
export const DECK_LETTER_CAPACITY = 52;

// log2(52!) — total entropy of a uniformly shuffled deck. Computed, not
// hard-coded, so the number in the exhibit is the number in the math.
export const DECK_ENTROPY_BITS = (() => {
  let bits = 0;
  for (let k = 2; k <= DECK_CARDS; k += 1) {
    bits += Math.log2(k);
  }
  return bits;
})(); // ≈ 225.581

export type ConditionId = "key-at-least-message" | "independent-uniform" | "used-once";

export type ConditionResult = {
  id: ConditionId;
  title: string;
  pass: boolean;
  detail: string;
};

export type ShannonReport = {
  subject: "pad" | "deck";
  conditions: [ConditionResult, ConditionResult, ConditionResult];
  isTrueOtp: boolean;
  availableBits: number;
  requiredBits: number;
};

export type GradeInput =
  | { kind: "pad"; pad: Pad; messageLength: number }
  | { kind: "deck"; messageLength: number; timesUsed?: number };

const fmt = (bits: number): string => bits.toFixed(1);

function gradePad(pad: Pad, messageLength: number): ShannonReport {
  const requiredBits = messageLength * pad.bitsPerSymbol;
  const availableBits = pad.remainingBits;
  const enoughKey = pad.remaining >= messageLength;

  const conditions: [ConditionResult, ConditionResult, ConditionResult] = [
    {
      id: "key-at-least-message",
      title: "Key is at least as long as the message",
      pass: enoughKey,
      detail: enoughKey
        ? `${pad.remaining} pad symbols ≈ ${fmt(availableBits)} bits remain; this message needs ` +
          `${messageLength} symbols ≈ ${fmt(requiredBits)} bits. One fresh symbol per plaintext symbol.`
        : `Only ${pad.remaining} pad symbols ≈ ${fmt(availableBits)} bits remain, but this message ` +
          `needs ${messageLength} symbols ≈ ${fmt(requiredBits)} bits. Encryption refuses to run.`
    },
    {
      id: "independent-uniform",
      title: "Every key symbol is an independent uniform draw",
      pass: true,
      detail:
        "Each pad symbol is a fresh draw from crypto.getRandomValues() with rejection sampling — " +
        "no deck, no permutation, no mod-26 folding. Knowing any symbol says nothing about any other."
    },
    {
      id: "used-once",
      title: "Every key symbol is used exactly once",
      pass: true,
      detail:
        "Consumed offsets are deleted from the pad, not flagged. No API can return a burned " +
        "symbol, so reuse is impossible rather than merely forbidden."
    }
  ];

  return {
    subject: "pad",
    conditions,
    isTrueOtp: conditions.every((condition) => condition.pass),
    availableBits,
    requiredBits
  };
}

function gradeDeck(messageLength: number, timesUsed: number): ShannonReport {
  const requiredBits = messageLength * LETTER_BITS;
  const availableBits = DECK_ENTROPY_BITS;
  const enoughKey = availableBits >= requiredBits;
  const usedOnce = timesUsed <= 1;

  const conditions: [ConditionResult, ConditionResult, ConditionResult] = [
    {
      id: "key-at-least-message",
      title: "Key is at least as long as the message",
      pass: enoughKey,
      detail: enoughKey
        ? `A shuffled deck holds log2(52!) ≈ ${fmt(DECK_ENTROPY_BITS)} bits; ${messageLength} letters ` +
          `need ${messageLength} × log2(26) ≈ ${fmt(requiredBits)} bits. The arithmetic squeaks by — ` +
          "but see condition 2: the deck still cannot deliver those bits as independent symbols."
        : `A shuffled deck holds log2(52!) ≈ ${fmt(DECK_ENTROPY_BITS)} bits of entropy in total, but ` +
          `${messageLength} letters need ${messageLength} × log2(26) ≈ ${fmt(requiredBits)} bits. ` +
          "The deck cannot supply one full-entropy symbol per letter — it only looks like a one-time pad."
    },
    {
      id: "independent-uniform",
      title: "Every key symbol is an independent uniform draw",
      pass: false,
      detail:
        "Deck keystream symbols come from ONE permutation, dealt without replacement — every card " +
        "seen constrains every card still to come — and each 0–51 value is folded mod 26. " +
        "That is 52 dependent symbols sharing 225.6 bits, not 52 independent draws."
    },
    {
      id: "used-once",
      title: "Every key symbol is used exactly once",
      pass: usedOnce,
      detail: usedOnce
        ? "This deck order has encrypted at most one message. Reusing it would let crib-dragging " +
          "cancel the keystream and read plaintext."
        : `This deck order encrypted ${timesUsed} messages. The keystream cancels in the ciphertext ` +
          "difference — crib-dragging now recovers plaintext."
    }
  ];

  return {
    subject: "deck",
    conditions,
    isTrueOtp: conditions.every((condition) => condition.pass),
    availableBits,
    requiredBits
  };
}

export function gradeShannon(input: GradeInput): ShannonReport {
  if (input.kind === "pad") {
    return gradePad(input.pad, input.messageLength);
  }
  return gradeDeck(input.messageLength, input.timesUsed ?? 1);
}
