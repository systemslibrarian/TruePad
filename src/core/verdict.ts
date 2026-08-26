/* ============================================================================
 * TruePad Shannon verdict core
 * ----------------------------------------------------------------------------
 * One grader, two exhibits, and — since Lane 1 — two lines per verdict.
 *
 * COMBINER. gradeShannon() checks the three conditions of Shannon's
 * perfect-secrecy theorem against either a TruePad pad or a DeckBook-style
 * shuffled deck:
 *
 *   1. key-at-least-message — the key must carry at least as much entropy
 *      as the message (one full-entropy symbol per plaintext symbol).
 *   2. independent-uniform  — every key symbol must be an independent
 *      uniform draw.
 *   3. used-once            — every key symbol is used exactly once, ever.
 *
 * Given those three, the combiner (add-mod-26 or XOR, one fresh symbol per
 * plaintext symbol) is unconditionally secure: the ciphertext is
 * independent of the plaintext. That is a theorem about the structure and
 * does not depend on where the symbols came from.
 *
 * SOURCE. Where the symbols came from is graded separately, because the
 * theorem's premise — "independent uniform draws" — is exactly what a
 * software source cannot deliver unconditionally:
 *
 *   csprng    crypto.getRandomValues() is a deterministic random bit
 *             generator. Its output is bounded by its state entropy, so a
 *             pad of n symbols carries at most ~256 bits of entropy however
 *             large n × bitsPerSymbol is. Condition 2 then holds
 *             COMPUTATIONALLY — against an adversary who cannot distinguish
 *             the DRBG from true randomness — not information-theoretically.
 *   external  the operator supplied the material and asserts where it came
 *             from. This code cannot test physical origin and does not try.
 *
 * A pad that passes all three conditions with a computational source is the
 * honest common case, and the exhibit says so rather than rounding it up to
 * "information-theoretically secure".
 *
 * A deck fails condition 1 on entropy arithmetic — log2(52!) ≈ 225.6 bits
 * available vs. 52 × log2(26) ≈ 244.4 bits needed for 52 letters — and
 * fails condition 2 because its keystream is one permutation sampled
 * without replacement and folded mod 26, not independent draws. Its source
 * is not graded: the combiner fails before provenance matters.
 * ========================================================================= */

import { LETTER_BITS, Pad, type PadSource } from "./pad.ts";

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

// Order-of-magnitude bound on what a platform DRBG's state can hold. Stated
// as a bound in copy, never as a measurement: this code has no way to read
// the generator's actual state size.
export const DRBG_STATE_BITS_BOUND = 256;

export type ConditionId = "key-at-least-message" | "independent-uniform" | "used-once";

export type ConditionResult = {
  id: ConditionId;
  title: string;
  pass: boolean;
  detail: string;
};

// The combiner line: unconditional given the three conditions.
export type CombinerVerdict = {
  pass: boolean;
  title: string;
  detail: string;
};

export type SourceGrade = "computational" | "declared-external" | "not-graded";

// The source line. `grade` is what tests and the UI branch on; the title is
// the sentence the exhibit prints and is deliberately blunt about what the
// tool did and did not verify.
export type SourceVerdict = {
  grade: SourceGrade;
  source: PadSource | null;
  title: string;
  detail: string;
};

export type ShannonReport = {
  subject: "pad" | "deck";
  conditions: [ConditionResult, ConditionResult, ConditionResult];
  // True when the COMBINER passes all three conditions. It says nothing
  // about the source — read `source` for that.
  isTrueOtp: boolean;
  combiner: CombinerVerdict;
  source: SourceVerdict;
  availableBits: number;
  requiredBits: number;
};

export type GradeInput =
  | { kind: "pad"; pad: Pad; messageLength: number }
  | { kind: "deck"; messageLength: number; timesUsed?: number };

const fmt = (bits: number): string => bits.toFixed(1);

function combinerVerdict(conditions: ConditionResult[]): CombinerVerdict {
  const pass = conditions.every((condition) => condition.pass);
  return {
    pass,
    title: pass
      ? "Combiner: unconditional — given the three conditions, the ciphertext is independent of the plaintext"
      : "Combiner: not a one-time pad — a Shannon condition fails",
    detail: pass
      ? "One fresh symbol per plaintext symbol, added mod 26 or XORed, used once. This is a theorem about " +
        "the structure and holds however the symbols were produced — which is exactly why the source is graded separately."
      : "Perfect secrecy needs all three conditions. Whichever failed above is the reason, and no choice of " +
        "source can repair it."
  };
}

export function sourceVerdict(source: PadSource): SourceVerdict {
  if (source === "csprng") {
    return {
      grade: "computational",
      source,
      title: "Source: computational — bounded by the platform DRBG state",
      detail:
        "Symbols came from crypto.getRandomValues(), a deterministic random bit generator. A pad of n symbols " +
        `carries at most the generator's state entropy (on the order of ${DRBG_STATE_BITS_BOUND} bits), not ` +
        "n × bits per symbol. Condition 2 holds against an adversary who cannot tell the generator from true " +
        "randomness — a computational assumption, not an information-theoretic guarantee."
    };
  }
  return {
    grade: "declared-external",
    source,
    title: "Source: declared external — provenance asserted by the operator, NOT verified by this tool",
    detail:
      "The operator supplied this pad material and asserts where it came from. Whether it carries the entropy " +
      "claimed is that assertion, not a finding: this code cannot test physical origin and does not try. It " +
      "only checked length and range and, in letter mode, reduced by rejection."
  };
}

const DECK_SOURCE: SourceVerdict = {
  grade: "not-graded",
  source: null,
  title: "Source: not graded — the combiner fails before provenance matters",
  detail:
    "A hand shuffle may well be a physical source. It does not help: conditions 1 and 2 fail on the " +
    "structure of a permutation folded mod 26, and no source repairs a broken combiner."
};

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
        ? `${pad.remaining} pad symbols ≈ ${fmt(availableBits)} bits of pad material remain; this message needs ` +
          `${messageLength} symbols ≈ ${fmt(requiredBits)} bits. One fresh symbol per plaintext symbol.`
        : `Only ${pad.remaining} pad symbols ≈ ${fmt(availableBits)} bits of pad material remain, but this ` +
          `message needs ${messageLength} symbols ≈ ${fmt(requiredBits)} bits. Encryption refuses to run.`
    },
    {
      id: "independent-uniform",
      title: "Every key symbol is an independent uniform draw",
      pass: true,
      detail:
        "The combiner takes one draw per symbol, range-reduced by rejection sampling — no deck, no permutation, " +
        "no mod-26 folding — so no symbol constrains any other. Whether the draws themselves are truly " +
        "independent is the SOURCE line's question, not this one's."
    },
    {
      id: "used-once",
      title: "Every key symbol is used exactly once",
      pass: true,
      detail:
        "Consumed offsets are deleted from the pad in memory, not flagged, and the high-water mark refuses any " +
        "envelope at or below it. Within one process no API can return a burned symbol."
    }
  ];

  return {
    subject: "pad",
    conditions,
    isTrueOtp: conditions.every((condition) => condition.pass),
    combiner: combinerVerdict(conditions),
    source: sourceVerdict(pad.source),
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
    combiner: combinerVerdict(conditions),
    source: DECK_SOURCE,
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
