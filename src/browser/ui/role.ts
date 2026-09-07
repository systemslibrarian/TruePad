/* ============================================================================
 * TruePad 2 Browser Edition — the operator's role for a pair
 * ----------------------------------------------------------------------------
 * A device holds BOTH directions of a pair. Which party the local operator acts
 * as decides the direction a send burns and an open consumes, so it is NOT a UI
 * convenience and it does NOT default.
 *
 * THIS HEADER USED TO SAY IT DID — "a UI convenience only ... defaulting to
 * Alice" — which is the exact behaviour the cross-copy reuse fix removed. Two
 * copies of one pair that each defaulted to Alice would both spend the A->B half
 * while each local store looked perfectly monotonic.
 *
 * The role is DERIVED FROM ORIGIN: generated-here is A, imported is B. Only when
 * the origin cannot say does the stored per-pair choice apply, and when there is
 * no stored choice either, `resolveRole` returns null and the send screen REFUSES
 * rather than guessing (see `UNKNOWN_ORIGIN_PROMPT`). burn/open still pass `as`
 * explicitly; the engine derives the direction.
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

// WHAT THE OPERATOR CAN ACTUALLY DO, which is what this used to get wrong.
//
// It said "Set it on the pad screen using the role you were given" — and there is
// no such control. `writeRole` is called at ACQUISITION only: creating a pad
// records A, importing or receiving one records B. Nothing offers to set it
// afterwards, so an operator following that sentence went looking for a screen
// that does not exist and had no way forward.
//
// The honest recovery is to acquire the pad again by a route that records which
// half is yours. Deliberately NOT offering a free choice here: a pad whose origin
// cannot say is exactly the case where a guess spends the other person's
// material, and adding a picker would create a second role authority beside the
// origin — which is the architecture the cross-copy reuse fix exists to prevent.
/**
 * WHAT TO SAY WHEN THE ROLE CANNOT BE DERIVED.
 *
 * EVERY ROUTE NAMED HERE IS A REAL, VISIBLE CONTROL, spelled exactly as the
 * operator sees it. An earlier version pointed at a control on the pad screen
 * that does not exist; the version after that named "Create", "Add a shared pad"
 * and "Receive", of which only the middle one was verbatim. Directions to a
 * button nobody can find are worse than no directions — the operator concludes
 * the app is broken, and the one action TruePad is trying to prevent starts to
 * look like the only way forward.
 *
 * `role-derivation.test.ts` holds each quoted label against the UI source.
 */
export const UNKNOWN_ORIGIN_PROMPT =
  "TruePad cannot tell which half of this pair is yours, so it will not guess, and " +
  "it will not send or open with this pad until it can. TruePad records which half " +
  "is yours when a pad is created here, or when it arrives here through one of the " +
  "receive routes; a pad that got here some other way carries no such record. " +
  "Acquire it again from the home screen — \u201CCreate a pad\u201D, or " +
  "\u201CAdd a shared pad\u201D and then either \u201CI have a pad file\u201D or " +
  "\u201CReceive securely online\u201D — and the record is written. Guessing does " +
  "not corrupt the pad, but it spends material the other person is spending too, " +
  "which is the one thing TruePad will not do on your behalf.";

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
