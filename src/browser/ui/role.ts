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

const ROLE_KEY = (pairId: string) => `truepad2:role:${pairId}`;

export function readRole(pairId: string): "A" | "B" {
  try {
    const v = localStorage.getItem(ROLE_KEY(pairId));
    if (v === "A" || v === "B") return v;
  } catch {
    /* storage may be unavailable (private mode, blocked) — use the default */
  }
  return "A";
}

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
