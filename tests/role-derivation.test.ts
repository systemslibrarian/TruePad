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
import { roleFromOrigin, sendDirection, receiveDirection, UNKNOWN_ORIGIN_PROMPT } from "../src/browser/ui/role.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DASHBOARD = readFileSync(join(ROOT, "src/browser/ui/dashboard.ts"), "utf8");
/** Source with `//` comments stripped, so a comment ABOUT a defect is not mistaken for it. */
const dashboardCode = DASHBOARD.split("\n").map((l) => {
  const i = l.indexOf("//");
  return i === -1 ? l : l.slice(0, i);
}).join("\n");

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

describe("an unresolved role is shown as unknown, never as Alice", () => {
  // The send path already refuses, and that is the safety property. This is the
  // separate defect beside it: the pad screen used `resolveRole(...) ?? "A"`, so
  // it announced "You are: Alice" for a pad whose half TruePad declines to
  // determine — and picked A->B as the direction whose remaining-sends figure to
  // show, making the headline number the wrong half's budget.

  it("does not default the role for display", () => {
    expect(dashboardCode).not.toMatch(/resolveRole\([^)]*\)\s*\?\?\s*"[AB]"/);
  });

  it("guards the send meter on a resolved role", () => {
    expect(dashboardCode).toContain("role === null ? null : pair.meters[sendDirection(role)]");
  });

  it("says unknown in both places it used to assert a half", () => {
    expect(DASHBOARD).toContain("Unknown — TruePad cannot tell which half is yours");
    expect(DASHBOARD).toContain("Unknown — TruePad will not guess");
  });

  it("read the file it thinks it read", () => {
    // POSITIVE CONTROL, and only that: it asserts the source was located and is
    // substantial, so the three absences above mean something.
    expect(dashboardCode.length).toBeGreaterThan(2000);
    expect(dashboardCode).toContain("resolveRole");
    expect(dashboardCode).toContain("sendDirection");
  });
});

describe("the unknown-origin refusal describes a recovery that exists", () => {
  it("no longer sends the operator to a control that was never built", () => {
    // `writeRole` is called only at acquisition — create, import, receive. There
    // is no pad-screen role control, and the prompt used to name one.
    expect(UNKNOWN_ORIGIN_PROMPT).not.toMatch(/set it on the pad screen/i);
  });

  it("explains WHEN the record is written, which is what makes the recovery make sense", () => {
    // The two acquisition moments, not the exact sentence that describes them.
    // This assertion used to pin the literal phrases "created here" and
    // "received here"; rewording the prompt to name the real controls broke it
    // while making the prompt strictly better, which is a guard holding prose
    // still rather than holding a property.
    //
    // Which CONTROLS are named is checked verbatim against the UI source in the
    // block below — that is the part worth pinning exactly.
    const p = UNKNOWN_ORIGIN_PROMPT.toLowerCase();
    expect(p).toMatch(/created here/);
    expect(p).toMatch(/receive/);
    expect(p).toMatch(/no such record/);
  });

  it("still refuses rather than offering a guess", () => {
    const p = UNKNOWN_ORIGIN_PROMPT.toLowerCase();
    expect(p).toContain("will not guess");
    expect(p).toContain("spends material the other person");
    // It must not invite the operator to pick a half.
    expect(p).not.toMatch(/choose (a|the) (half|role|party)/);
  });
});

describe("the unknown-origin refusal directs the operator at controls that exist", () => {
  const UI = ["home.ts", "create-pair.ts", "dashboard.ts", "context.ts"]
    .map((f) => readFileSync(join(ROOT, "src/browser/ui", f), "utf8")).join("\n");

  it("quotes only labels that appear verbatim in the Browser UI", () => {
    // Every phrase the refusal puts in quotation marks is an instruction to go
    // and tap something. If the string is not in the UI source, that control does
    // not exist under that name and the instruction is a dead end.
    const quoted = [...UNKNOWN_ORIGIN_PROMPT.matchAll(/\u201C([^\u201D]+)\u201D/g)]
      .map((m) => m[1]);
    expect(quoted.length, "the refusal names no controls at all").toBeGreaterThanOrEqual(3);
    for (const label of quoted) {
      expect(UI.includes(`"${label}"`),
             `the refusal tells the operator to use "${label}", which appears nowhere `
             + `in the Browser UI source`).toBe(true);
    }
  });

  it("reads real UI files", () => {
    // POSITIVE CONTROL: the concatenation above is not empty and is the real UI.
    expect(UI.length).toBeGreaterThan(5000);
    expect(UI).toContain('"Add a shared pad"');
  });

  it("still refuses rather than naming a role", () => {
    expect(UNKNOWN_ORIGIN_PROMPT).toMatch(/will not guess/);
    expect(UNKNOWN_ORIGIN_PROMPT).not.toMatch(/\byou are (A|B)\b/i);
  });
});
