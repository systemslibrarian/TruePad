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

/**
 * Sentences, after UNWRAPPING hard-wrapped prose.
 *
 * The first version split structural blocks per LINE, so a claim wrapped across
 * four lines of a blockquote became four fragments and no fragment carried the
 * whole phrase. A mutation proved it: "> TruePad is the most\n> secure way to
 * send a message: the only end-to-end encrypted messaging\n> app that gives you
 * perfect\n> secrecy." passed every FORBIDDEN pattern. Continuation lines are
 * now joined to the line they continue before anything is split.
 */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const opener = /^\s*(?:[-*+]\s|#{1,6}\s|\||>\s?)/;
      const lines = block.split(/\n/);
      const units: string[] = [];
      for (const line of lines) {
        const bare = line.replace(/^\s*>\s?/, "");
        const startsUnit = opener.test(line) && !/^\s*>\s?/.test(line);
        if (units.length === 0 || startsUnit || /^\s*(?:[-*+]\s|#{1,6}\s|\|)/.test(bare)) {
          units.push(bare);
        } else {
          units[units.length - 1] += " " + bare;   // a wrapped continuation
        }
      }
      return units.flatMap((u) => u.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/));
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A negation that GOVERNS the forbidden phrase.
 *
 * The first version asked only whether a negation appeared anywhere in the same
 * sentence, and included a bare `\bno\b` — which matches "no ads", "no accounts",
 * "no telemetry", this project's actual selling points. A mutation proved it:
 * "TruePad is the most secure private messenger there is, with no accounts."
 * passed with four forbidden phrases in it. The negation must now appear in the
 * window immediately BEFORE the phrase it excuses, and noun-negations like
 * "no ads" no longer count.
 */
const GOVERNING_NEGATION =
  /\b(not|never|nor|neither|without|refus\w+|avoids?|cannot|can't|doesn't|isn't|aren't|rather than|instead of|no claim|does not|is not|are not|must not)\b/i;

/** Does a negation govern `bad`'s match inside `sentence`? */
function isDisclaimed(sentence: string, bad: RegExp): boolean {
  const re = new RegExp(bad.source, bad.flags.includes("g") ? bad.flags : bad.flags + "g");
  for (const m of sentence.matchAll(re)) {
    const before = sentence.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
    if (!GOVERNING_NEGATION.test(before)) return false;   // this occurrence is bare
  }
  return true;
}

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
            isDisclaimed(s, bad),
            `${rel} asserts ${String(bad)} without a negation governing it: "${s.slice(0, 180)}"`,
          ).toBe(true);
        }
      }
    });
  }

  it("keeps the guard honest about truthful negations", () => {
    // The exact disclaimer this project insists on must remain legal to write.
    const ok = "TruePad does NOT guarantee perfect secrecy as a product claim.";
    const bad = "TruePad guarantees perfect secrecy.";
    const sell = "There are no ads, no accounts and no telemetry.";
    const hits = (t: string) => FORBIDDEN.filter((f) => f.test(t));
    expect(hits(ok).length, "the disclaimer must still match a forbidden phrase")
      .toBeGreaterThan(0);
    expect(hits(ok).every((f) => isDisclaimed(ok, f)), "…and be excused").toBe(true);
    expect(hits(bad).some((f) => !isDisclaimed(bad, f)), "a bare assertion is NOT excused")
      .toBe(true);
    // The regression that made this whole check hollow: a noun-negation must not
    // launder a claim sitting beside it.
    const laundered = "TruePad is the most secure private messenger there is, with no accounts.";
    expect(hits(laundered).some((f) => !isDisclaimed(laundered, f)),
      '"no accounts" must not excuse "most secure" / "private messenger"').toBe(true);
    // AND it must be anchored to reality: this test used to open no file at all,
    // so it passed while every surface said "unbreakable, military-grade".
    for (const rel of SURFACES) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text.length, `${rel} must actually be read`).toBeGreaterThan(200);
    }
  });
});

describe("the listing positions TruePad as what it is", () => {
  const meta = readFileSync(join(ROOT, "docs/APP-STORE-METADATA.md"), "utf8");
  // The positioning checks used to read ONLY the metadata file, while the
  // FORBIDDEN sweep covered four surfaces. The worksheet is the file whose cells
  // are pasted into App Store Connect, so a messenger positioning added there
  // reached Apple without failing anything.
  const commercial = SURFACES.map((rel) => readFileSync(join(ROOT, rel), "utf8")).join("\n");

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
    // "sealed|X-Wing|computational" was satisfied by the word "sealed" alone,
    // while the assertion message promised the computational boundary was named.
    // Requiring "computational" ANYWHERE was still too weak: the disclaimer
    // sentence ("the pad ... is not computational") kept the token alive while
    // the delivery claim itself was softened to "strong cryptography".
    // The qualifier has to travel WITH the sealed delivery.
    const sealedSentence = sentences(meta).find((t) => /\bsealed deliver/i.test(t));
    expect(sealedSentence, "the listing must describe the sealed DELIVERY").toBeDefined();
    expect(sealedSentence as string,
      "the sealed delivery must be named COMPUTATIONAL where it is described — "
      + "the pad is not computational, and merging the two is the one thing this "
      + "listing must never do")
      .toMatch(/computational/i);
  });

  it("names no TPM capability in the phone listing", () => {
    // The maximum-assurance architecture is a native CLI path. An App Store
    // listing mentioning TPM would imply the phone has it.
    expect(meta, "TPM must not appear in the store listing").not.toMatch(/\bTPM\b/);
    expect(commercial, "…nor on any other surface that reaches Apple")
      .not.toMatch(/\bTPM\b/);
  });
});
