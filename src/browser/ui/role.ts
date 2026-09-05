/* ============================================================================
 * TruePad 2 Browser Edition — the operator's role for a pair
 * ----------------------------------------------------------------------------
 * A device holds BOTH directions of a pair. Which party the local operator
 * acts as decides the direction a send burns and an open consumes. That choice
 * is a UI convenience only — never a secret — so it is remembered per pair in
 * localStorage, defaulting to Alice. burn/open still pass `as` explicitly; the
 * engine derives the direction.
 * ========================================================================= */

import type { PadDirection } from "../../core/pad.ts";

import type { PairOrigin } from "../engine/protocol.ts";

const ROLE_KEY = (pairId: string) => `truepad2:role:${pairId}`;

/**
 * WHICH HALF OF THE PAIR THIS DEVICE OWNS, derived from how the pad was acquired.
 *
 * THE DEFECT THIS CLOSES. `readRole` used to fall back to `"A"` whenever the
 * stored value was missing or `localStorage` threw — a private window, blocked
 * storage, or site data cleared while the OPFS pad store survived. A party-B
 * operator in any of those states then SENT on party A's half, so two devices
 * holding one pair burned the same offsets against the same one-time
 * authentication record. Each store's counters advanced monotonically on its own
 * copy and no engine could see it: the reuse is ACROSS copies, not within a
 * store.
 *
 * The pad's own origin is the durable answer — it travels with the pad instead of
 * with the browser profile — so it is preferred over anything stored locally.
 */
export function roleFromOrigin(origin: PairOrigin): "A" | "B" | null {
  if (origin === "generated-here") return "A";
  if (origin === "imported") return "B";
  // NOT "A". An unknown origin is exactly the case where a guess is most likely
  // to be wrong, because it is the case where the provenance evidence was lost.
  return null;
}

/** The locally stored role, or null. NEVER a default. */
export function readStoredRole(pairId: string): "A" | "B" | null {
  try {
    const v = localStorage.getItem(ROLE_KEY(pairId));
    if (v === "A" || v === "B") return v;
  } catch {
    /* storage may be unavailable (private mode, blocked) */
  }
  return null;
}

/**
 * The role to use for a pad. Origin first, local storage only as a tiebreak for
 * a pad whose origin is unknown, and null when neither can say — at which point
 * the caller must ask rather than proceed. Refusing is LOSS, which this project
 * accepts; guessing is REUSE, which it does not.
 */
export function resolveRole(pairId: string, origin: PairOrigin): "A" | "B" | null {
  return roleFromOrigin(origin) ?? readStoredRole(pairId);
}

export const UNKNOWN_ORIGIN_PROMPT =
  "TruePad cannot tell which half of this pair is yours, so it will not guess. " +
  "Set it on the pad screen using the role you were given when this pad was " +
  "created. Choosing wrong does not corrupt the pad, but it spends material the " +
  "other person is also spending.";

export function writeRole(pairId: string, role: "A" | "B"): void {
  try {
    localStorage.setItem(ROLE_KEY(pairId), role);
  } catch {
    /* best-effort convenience only */
  }
}

// Alice (A) sends on A->B; Bob (B) sends on B->A.
export const sendDirection = (role: "A" | "B"): PadDirection => (role === "A" ? "A->B" : "B->A");

// Alice (A) receives on B->A; Bob (B) receives on A->B.
export const receiveDirection = (role: "A" | "B"): PadDirection => (role === "A" ? "B->A" : "A->B");
