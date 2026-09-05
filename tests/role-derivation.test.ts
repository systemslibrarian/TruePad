/* ============================================================================
 * WHICH HALF OF THE PAIR THIS DEVICE OWNS.
 * ----------------------------------------------------------------------------
 * THE REUSE DEFECT THIS CLOSES. `readRole` fell back to `"A"` whenever the stored
 * value was missing or `localStorage` threw — a private window, blocked storage,
 * or site data cleared while the OPFS pad store survived. A party-B operator in
 * any of those states then SENT on party A's half.
 *
 * Two devices holding one pair therefore burned the same offsets against the same
 * one-time authentication record. No engine could catch it: each store's counters
 * advance monotonically on its own copy, so the reuse is ACROSS copies, not
 * within a store. That is why this guard lives above the engine and is tested
 * here rather than in the verbs.
 *
 * The same defect existed in both mobile editions and is closed the same way:
 * derive from the pad's own origin, and refuse to guess when it cannot say.
 * ========================================================================= */

import { describe, expect, it } from "vitest";
import { roleFromOrigin, sendDirection, receiveDirection } from "../src/browser/ui/role.ts";

describe("the operator's role is derived from how the pad was acquired", () => {
  it("creator is A, importer is B", () => {
    expect(roleFromOrigin("generated-here")).toBe("A");
    expect(roleFromOrigin("imported")).toBe("B");
  });

  it("an unknown origin refuses to guess rather than defaulting to A", () => {
    // Returning "A" here is exactly the old defect, and it would reinstate it for
    // the pads MOST likely to be wrong — the ones whose provenance was lost.
    // Refusing costs LOSS, which this project accepts. Guessing costs REUSE.
    expect(roleFromOrigin("unknown")).toBeNull();
  });

  it("the two halves of one pair are never the same party", () => {
    expect(roleFromOrigin("generated-here")).not.toBe(roleFromOrigin("imported"));
  });

  it("and they therefore send on opposite directions", () => {
    const creator = roleFromOrigin("generated-here")!;
    const importer = roleFromOrigin("imported")!;
    expect(sendDirection(creator)).toBe("A->B");
    expect(sendDirection(importer)).toBe("B->A");
    expect(sendDirection(creator)).not.toBe(sendDirection(importer));
    // Each opens what the other sends.
    expect(receiveDirection(importer)).toBe(sendDirection(creator));
    expect(receiveDirection(creator)).toBe(sendDirection(importer));
  });
});
