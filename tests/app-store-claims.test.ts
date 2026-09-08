import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * THE COMMERCIAL SURFACE IS A CLAIMS SURFACE
 * ----------------------------------------------------------------------------
 * A store listing is read by more people than any document in this repository,
 * and it is read by people deciding whether to trust the thing. The subtitle and
 * the keyword list are the highest-risk fields on it: they are short, they are
 * written last, and they are where "secure messenger" gets typed by reflex.
 *
 * TruePad's claims discipline does not stop at the repository boundary, so the
 * same rule applies here: never assert what the implementation has not earned.
 *
 * CONTEXTUAL, NOT A WORD BLACKLIST. This project earns credibility partly by
 * NAMING the things it refuses to claim — "TruePad does NOT guarantee perfect
 * secrecy" must stay sayable. So a forbidden phrase fails only when it is
 * ASSERTED; the same phrase inside a negation is exactly what should be there.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const SURFACES = [
  "docs/APP-STORE-METADATA.md",
  "docs/APP-REVIEW-NOTES.md",
  "docs/APP-STORE-CONNECT-WORKSHEET.md",
  "PRIVACY.md",
];

/** Same shape the front-door guard uses: paragraphs, with list/heading/table rows split per line. */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const structural = /^\s*(?:[-*+]\s|#{1,6}\s|\||>)/;
      const units = structural.test(block) ? block.split(/\n/) : [block];
      return units.flatMap((u) => u.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/));
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

const NEGATION =
  /\b(not|never|no|nor|neither|without|refus\w+|avoid\w*|does not|cannot|is not|are not|rather than|instead of|do NOT|must not)\b/i;

/** Asserted anywhere on a commercial surface, these would be unearned. */
const FORBIDDEN: RegExp[] = [
  /\bunbreakable\b/i,
  /\bperfect secrecy\b/i,
  /\bguaranteed (secrecy|privacy|security)\b/i,
  /\bmilitary[- ]grade\b/i,
  /\bquantum[- ](proof|safe)\b/i,
  /\banonymous\b/i,
  /\buntraceable\b/i,
  /\bimpossible to (intercept|break|crack)\b/i,
  /\bmost secure\b/i,
  /\bsecure messenger\b/i,
  /\bprivate messenger\b/i,
  /\bsurveillance[- ]proof\b/i,
  /\bNSA[- ]proof\b/i,
  /\bend[- ]to[- ]end encrypted messaging app\b/i,
];

describe("the App Store surfaces make no claim TruePad has not earned", () => {
  it("finds the surfaces it polices", () => {
    // POSITIVE CONTROL: a broken read would make every assertion below vacuous.
    for (const rel of SURFACES) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text.length, `${rel} is empty or unreadable`).toBeGreaterThan(500);
    }
  });

  for (const rel of SURFACES) {
    it(`asserts nothing unearned in ${rel}`, () => {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const bad of FORBIDDEN) {
        for (const s of sentences(text)) {
          if (!bad.test(s)) continue;
          expect(
            NEGATION.test(s),
            `${rel} asserts ${String(bad)} without disclaiming it: "${s.slice(0, 180)}"`,
          ).toBe(true);
        }
      }
    });
  }

  it("keeps the guard honest about truthful negations", () => {
    // The exact disclaimer this project insists on must remain legal to write.
    const ok = "TruePad does NOT guarantee perfect secrecy as a product claim.";
    const bad = "TruePad guarantees perfect secrecy.";
    const hits = (s: string) => FORBIDDEN.some((f) => f.test(s));
    expect(hits(ok), "the disclaimer must still match a forbidden phrase").toBe(true);
    expect(NEGATION.test(ok), "…and must be excused by its negation").toBe(true);
    expect(hits(bad) && !NEGATION.test(bad), "the bare assertion must NOT be excused").toBe(true);
  });
});

describe("the listing positions TruePad as what it is", () => {
  const meta = readFileSync(join(ROOT, "docs/APP-STORE-METADATA.md"), "utf8");

  it("leads with the educational/utility framing, not a messenger", () => {
    expect(meta).toMatch(/EDUCATIONAL CRYPTOGRAPHIC \/ SECURITY UTILITY/i);
    expect(meta, "it must say outright that it is not a messenger alternative")
      .toMatch(/not positioned as a messenger|not as a Signal alternative/i);
  });

  it("keeps the three-claim split visible in the description", () => {
    // Private handoff / sealed online delivery / ordinary messages are different
    // guarantees, and collapsing them is the single most consequential thing a
    // store description could get wrong.
    expect(meta, "the governing rule").toMatch(/LOSS IS ACCEPTABLE\. REUSE IS NOT\./);
    expect(meta, "the perfect-secrecy disclaimer").toMatch(/does not guarantee perfect secrecy/i);
    expect(meta, "sealed delivery must be named as computational")
      .toMatch(/sealed|X-Wing|computational/i);
  });

  it("names no TPM capability in the phone listing", () => {
    // The maximum-assurance architecture is a native CLI path. An App Store
    // listing mentioning TPM would imply the phone has it.
    expect(meta, "TPM must not appear in the store listing").not.toMatch(/\bTPM\b/);
  });
});
