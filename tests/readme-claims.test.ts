import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * README claim guards — accessibility must not become overclaim
 * ----------------------------------------------------------------------------
 * The README now explains the system in plain English, which is exactly the
 * kind of edit that quietly upgrades a claim: a hedge reads like clutter until
 * you remember it was the only true part of the sentence.
 *
 * So each load-bearing statement is pinned, and — more importantly — each
 * strong statement is required to have its QUALIFICATION NEARBY. A sentence
 * like "quantum computing does not change that theorem" is true and is allowed
 * to be there; it is not allowed to stand alone.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
// Blockquote markers and markdown emphasis are layout, not content: strip them
// so a sentence reads the same whether or not it happens to be quoted or bold.
const FLAT = README.replace(/^\s*>\s?/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ");

// A forbidden phrase is only a problem when ASSERTED. A sentence that exists to
// forbid it is the discipline working, so the scan is sentence-scoped.
const NEGATION = /\bnever\b|\bnot\b|\bno\b|\bcannot\b|\bwithout\b|\bconditional\b|\bonly if\b|\bunless\b/i;

function assertedIn(text: string, patterns: RegExp[]): string[] {
  const offending: string[] = [];
  for (const sentence of text.replace(/^\s*>\s?/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
    if (patterns.some((p) => p.test(sentence)) && !NEGATION.test(sentence)) {
      offending.push(sentence.trim());
    }
  }
  return offending;
}

// The window a strong claim's qualification must appear within.
function nearby(needle: string, qualification: RegExp, window = 1200): boolean {
  const at = FLAT.indexOf(needle);
  if (at === -1) return false;
  return qualification.test(FLAT.slice(Math.max(0, at - window), at + window));
}

describe("the three layers are explained, and named exactly", () => {
  it("states the OTP equation and its variables", () => {
    expect(README).toContain("C = P XOR K");
    expect(FLAT).toMatch(/P = plaintext/);
    expect(FLAT).toMatch(/K = unused one-time secret material/);
    expect(FLAT).toMatch(/C = ciphertext/);
    // ...and that it rests on no computational hardness assumption.
    expect(FLAT).toMatch(/does not depend on factoring, discrete logarithms/);
  });

  it("keeps every limb of the confidentiality premise", () => {
    for (const limb of [
      "uniformly random",
      "secret from the adversary",
      "independent of the messages it protects",
      "at least as long as the",
      "never reused"
    ]) {
      expect(FLAT, `the premise must keep "${limb}"`).toContain(limb);
    }
    expect(FLAT).toMatch(/information-theoretic/);
  });

  it("names Wegman-Carter and the 128-bit tag, with the EXACT bound not a vague word", () => {
    expect(FLAT).toMatch(/Wegman–Carter|Wegman-Carter/);
    expect(FLAT).toMatch(/128-bit/);
    // The project's exact bound survives the plain-English rewrite.
    expect(README).toContain("65540 · 2^-128");
    // The bound is stated as a number. tests/readme2.test.ts additionally
    // forbids the adjective this replaces, anywhere in the file — that older
    // guard is stricter, and this one does not soften it.
    expect(FLAT).toMatch(/bound with a number attached/);
  });

  it("says the machinery is what keeps the hypotheses true", () => {
    expect(FLAT).toContain("The XOR is the simple part");
    expect(FLAT).toMatch(/keeps the word "one-time" true|keep the word .one-time. true/);
    // ...and that not every deployment gets every layer.
    expect(FLAT).toMatch(/Not every deployment gets every layer/);
  });
});

describe("the source distinction survives", () => {
  it("calls the device path a platform CSPRNG with computational assumptions", () => {
    expect(FLAT).toContain("crypto.getRandomValues()");
    expect(FLAT).toMatch(/cryptographically secure platform random generator \(CSPRNG\)/);
    expect(FLAT).toMatch(/platform and computational\s+assumptions|platform and computational assumptions/);
    expect(FLAT).toMatch(/does not call this physically proven randomness/);
  });

  it("states the XOR combiner theorem exactly, with no conditioning step", () => {
    expect(FLAT).toMatch(/If at least one combined source is actually uniform and independent of the others/);
    expect(FLAT).toMatch(/No hash\. No KDF\. No extractor\. No whitening\./);
  });

  it("keeps the load-bearing sentence, and the rest of the premise", () => {
    expect(FLAT).toContain("TruePad cannot determine whether a supplied file is truly random.");
    expect(FLAT).toMatch(/remain secret\s*from the adversary|remain secret from the adversary/);
    expect(FLAT).toMatch(/independent of the messages it protects/);
    expect(FLAT).toMatch(/used only once/);
  });
});

describe("the quantum section carries its assumptions", () => {
  it("explains why OTP is unaffected, in the right terms", () => {
    expect(FLAT).toMatch(/not\s+"post-quantum cryptography"/);
    expect(FLAT).toMatch(/Shor's algorithm does not attack/);
    expect(FLAT).toMatch(/Grover's does not turn an information-theoretic/);
    expect(FLAT).toMatch(/Quantum computing does not change that theorem/);
  });

  it("the strong sentence NEVER travels without its qualification", () => {
    // This is the guard that matters: the claim may exist, but the CSPRNG
    // caveat and the conditionality must be within reach of it.
    expect(nearby("Quantum computing does not change that theorem", /platform CSPRNG/)).toBe(true);
    expect(nearby("Quantum computing does not change that theorem", /conditional/i)).toBe(true);
    expect(nearby("quantum-resistant by construction", /information-theoretic rather than\s*computational/)).toBe(true);
    expect(nearby("quantum-resistant by construction", /never travels without/)).toBe(true);
  });

  it("never asserts the standalone overclaims", () => {
    const FORBIDDEN = [
      /\bunconditionally secure\b/i,
      /\bquantum[- ]proof\b/i,
      /perfect secrecy achieved/i,
      /\bmilitary[- ]grade\b/i,
      /\bunbreakable\b/i
    ];
    expect(assertedIn(README, FORBIDDEN)).toEqual([]);
    // And authentication is not swept into the confidentiality claim.
    expect(FLAT).toMatch(/Authentication is a\s*separate/);
  });
});

describe("the worked example and the transport claim", () => {
  it("shows the real envelope and its frozen compact form", () => {
    expect(README).toContain('"pairId":"ed5825e73edd8beb9962abfed3826985"');
    expect(README).toContain("TP2:AQLtWCXnPt2L65liq_7TgmmFAAEEBRq4uKEwpDVMhWtcf7qTs9SflcVfhg");
    for (const field of ["pairId", "direction", "sequence", "startOffset", "ciphertextLength", "ciphertext", "tag"]) {
      expect(FLAT, `the walkthrough must explain ${field}`).toContain(`\`${field}\``);
    }
  });

  it("describes compact transport as the SAME envelope, not a cryptographic change", () => {
    expect(FLAT).toContain("two representations of the same");
    expect(FLAT).toMatch(/changes transport size, not the\s*cryptography/);
    // It must not be described as compression or as a security property.
    expect(assertedIn(README, [/compress(es|ed|ion)? the (message|ciphertext|plaintext)/i])).toEqual([]);
  });
});

describe("pad distribution", () => {
  it("draws the distinction most OTP explanations skip", () => {
    expect(FLAT).toMatch(/Ciphertext may travel publicly\. The pad file may not\./);
    expect(FLAT).toMatch(/read the messages it protects and\s*forge authenticated messages/);
    expect(FLAT).toMatch(/Physical handoff on removable media/);
  });

  it("names the channels that do NOT preserve the claim, and why that is different", () => {
    for (const channel of ["Email", "Dropbox", "Google Drive", "OneDrive", "encrypted\nmessengers"]) {
      expect(README.replace(/\s+/g, " "), `must name ${channel}`).toContain(channel.replace(/\s+/g, " "));
    }
    expect(FLAT).toMatch(/different\s*guarantee, not a weaker version of the same one/);
  });
});
