/* ============================================================================
 * Rendering protocol indices as comparison words
 * ----------------------------------------------------------------------------
 * The engine returns INDICES — twelve for a receive request (§6.3), eight for a
 * transfer confirmation (§8.2). This module turns an index into a word, and
 * that is the entire extent of the UI's involvement in the fingerprint.
 *
 * The UI recomputes NOTHING. It does not hash a request, derive a confirmation
 * value, or touch the KEM; if it did, a bug here could make the words agree
 * while the underlying values did not, which is precisely the failure the
 * comparison exists to catch. One lookup table, no arithmetic.
 *
 * Not mnemonics. See PROVENANCE.md and the banner in words.ts.
 * ========================================================================= */

import { COMPARISON_WORDS } from "./words.ts";

export { COMPARISON_WORDS };

export const WORDLIST_SIZE = 2048;

/** Map protocol indices to their words.
 *
 *  Every index is checked: a non-integer or an out-of-range value is a bug in
 *  the caller, and rendering `undefined` beside the number "7" would give two
 *  people something to compare that means nothing. */
export function wordsFromIndices(indices: readonly number[]): string[] {
  return indices.map((index, at) => {
    if (!Number.isInteger(index) || index < 0 || index >= WORDLIST_SIZE) {
      throw new RangeError(`comparison index ${at} is out of range: ${String(index)}`);
    }
    return COMPARISON_WORDS[index];
  });
}
