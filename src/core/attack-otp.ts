/* ============================================================================
 * TruePad attack core — crib dragging
 * ----------------------------------------------------------------------------
 * Pure functions only. This module is the proof panel's engine: the SAME
 * crib-drag machinery is pointed at two targets and behaves completely
 * differently.
 *
 *   1. A single ciphertext made with a true one-time pad. For every
 *      alignment of the crib there is exactly one key fragment that would
 *      make the crib fit — and because OTP key symbols are independent and
 *      uniform, every one of those fragments is exactly as likely as every
 *      other. All candidates are consistent, all candidates tie. The attack
 *      terminates having learned nothing.
 *
 *   2. Two ciphertexts that reused one keystream (DeckBook's sin when a deck
 *      encrypts twice). Then c1 - c2 = p1 - p2 (mod 26): the key drops out
 *      entirely. Dragging a crib (a guess at a fragment of p1) across the
 *      difference implies, at each alignment, a fragment of p2 — and where
 *      the guess is right, that fragment is readable English. englishScore
 *      surfaces it.
 * ========================================================================= */

import { lettersToNumbers, normalizeAZ, numbersToLetters } from "./cipher-otp";

export type CribCandidate = {
  position: number;
  // For the single-OTP attack: the implied KEY fragment (uniform noise).
  // For the reused-key attack: the implied OTHER-PLAINTEXT fragment.
  fragment: string;
  score: number;
  consistent: boolean;
};

// Relative English letter frequencies, A..Z.
const LETTER_FREQ = [
  0.082, 0.015, 0.028, 0.043, 0.127, 0.022, 0.02, 0.061, 0.07, 0.0015, 0.0077, 0.04, 0.024,
  0.067, 0.075, 0.019, 0.00095, 0.06, 0.063, 0.091, 0.028, 0.0098, 0.024, 0.0015, 0.02, 0.00074
];

const COMMON_BIGRAMS = new Set([
  "TH", "HE", "IN", "ER", "AN", "RE", "ND", "AT", "ON", "NT",
  "HA", "ES", "ST", "EN", "ED", "TO", "IT", "OU", "EA", "HI"
]);

// A reused-key candidate whose fragment scores at or above this per-letter
// threshold is treated as leaked plaintext. English text lands around +1;
// uniform noise lands around -1.
export const LEAK_THRESHOLD = 0.25;

// Per-letter log2 likelihood ratio of `fragment` against uniform letters,
// plus a small bonus per common bigram. Positive ≈ English-like, negative ≈
// noise. Pure and deterministic so the proof panel and tests agree.
export function englishScore(fragment: string): number {
  const nums = lettersToNumbers(normalizeAZ(fragment));
  if (nums.length === 0) {
    return 0;
  }
  let score = 0;
  for (const value of nums) {
    score += Math.log2(LETTER_FREQ[value] * 26);
  }
  let bigramBonus = 0;
  const text = numbersToLetters(nums);
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (COMMON_BIGRAMS.has(text.slice(i, i + 2))) {
      bigramBonus += 0.75;
    }
  }
  return (score + bigramBonus) / nums.length;
}

// DeckBook-style additive stream cipher, kept here so the exhibit can build
// its reused-key victim ciphertexts: cipher[i] = (plain[i] + key[i]) mod 26.
export function encryptWithKeystream(plaintext: string, keystream: number[]): string {
  const nums = lettersToNumbers(normalizeAZ(plaintext));
  if (nums.length > keystream.length) {
    throw new Error("keystream shorter than plaintext");
  }
  return numbersToLetters(nums.map((value, index) => (value + keystream[index]) % 26));
}

// Attack a single true-OTP ciphertext. Every alignment yields the one key
// fragment (cipher - crib mod 26) that would make the crib fit there. All of
// them are consistent, and under a uniform key all of them are equally
// probable, so every candidate carries the same score: zero information.
export function dragCribSingleOtp(ciphertext: string, crib: string): CribCandidate[] {
  const cipherNums = lettersToNumbers(normalizeAZ(ciphertext));
  const cribNums = lettersToNumbers(normalizeAZ(crib));
  const candidates: CribCandidate[] = [];
  for (let position = 0; position + cribNums.length <= cipherNums.length; position += 1) {
    const impliedKey = cribNums.map((value, index) => (cipherNums[position + index] - value + 26) % 26);
    candidates.push({
      position,
      fragment: numbersToLetters(impliedKey),
      score: 0,
      consistent: true
    });
  }
  return candidates;
}

// Attack two ciphertexts that shared one keystream. The keystream cancels in
// the difference, so each alignment of the crib against p1 implies a
// fragment of p2: p2[i] = crib[i] - (c1[i] - c2[i]) mod 26. Real English
// pops out only where the crib is correctly placed.
export function dragCribReusedKey(c1: string, c2: string, crib: string): CribCandidate[] {
  const aNums = lettersToNumbers(normalizeAZ(c1));
  const bNums = lettersToNumbers(normalizeAZ(c2));
  const cribNums = lettersToNumbers(normalizeAZ(crib));
  const length = Math.min(aNums.length, bNums.length);
  const candidates: CribCandidate[] = [];
  for (let position = 0; position + cribNums.length <= length; position += 1) {
    const implied = cribNums.map(
      (value, index) => (value - (aNums[position + index] - bNums[position + index]) + 52) % 26
    );
    const fragment = numbersToLetters(implied);
    candidates.push({
      position,
      fragment,
      score: englishScore(fragment),
      consistent: true
    });
  }
  return candidates;
}

export function bestCandidate(candidates: CribCandidate[]): CribCandidate | undefined {
  return candidates.reduce<CribCandidate | undefined>(
    (best, candidate) => (best === undefined || candidate.score > best.score ? candidate : best),
    undefined
  );
}

export type AttackComparison = {
  otp: {
    candidates: CribCandidate[];
    leaked: false;
    explanation: string;
  };
  reused: {
    candidates: CribCandidate[];
    best: CribCandidate | undefined;
    leaked: boolean;
    explanation: string;
  };
};

// The shared comparator: one crib, the same drag, both targets. This is the
// side-by-side the proof panel renders.
export function compareAttacks(input: {
  otpCiphertext: string;
  reusedCiphertexts: [string, string];
  crib: string;
}): AttackComparison {
  const otpCandidates = dragCribSingleOtp(input.otpCiphertext, input.crib);
  const reusedCandidates = dragCribReusedKey(
    input.reusedCiphertexts[0],
    input.reusedCiphertexts[1],
    input.crib
  );
  const best = bestCandidate(reusedCandidates);
  const leaked = best !== undefined && best.score >= LEAK_THRESHOLD;
  return {
    otp: {
      candidates: otpCandidates,
      leaked: false,
      explanation:
        "Every alignment is consistent with some key, and under a uniform one-time pad " +
        "every implied key fragment is equally likely. No candidate outranks any other — " +
        "the attack learns nothing."
    },
    reused: {
      candidates: reusedCandidates,
      best,
      leaked,
      explanation: leaked
        ? "The shared keystream cancels out of the ciphertext difference, so a correct crib " +
          "placement exposes readable plaintext from the OTHER message. Key reuse leaks."
        : "No alignment of this crib produced English-like text. Try a longer or likelier crib."
    }
  };
}
