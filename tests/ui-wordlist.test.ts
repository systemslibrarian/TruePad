import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { COMPARISON_WORDS, wordsFromIndices, WORDLIST_SIZE } from "../src/browser/ui/wordlist/index";

/* ============================================================================
 * The comparison wordlist
 * ----------------------------------------------------------------------------
 * INDEX POSITION IS THE PROTOCOL MAPPING. The engine hands the UI eleven-bit
 * indices; this list turns them into what two people say aloud. Sorting it,
 * regenerating it in another order, or swapping in "an equivalent list" changes
 * which words get compared — and two conforming TruePad builds would then
 * disagree about a fingerprint while both looked perfectly correct, which is
 * the exact symptom of an active attack.
 *
 * So the vendored bytes are pinned by hash, and the generated array is
 * re-derived from those bytes on every run rather than trusted.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const DIR = join(ROOT, "src", "browser", "ui", "wordlist");
const RAW = readFileSync(join(DIR, "english.txt"));

/** SHA-256 of the exact vendored file. Upstream: bitcoin/bips
 *  bip-0039/english.txt, git blob 942040ed50f7205cafc465496229128ba4f78e75. */
const PINNED_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

describe("the vendored file", () => {
  it("still hashes to the pinned SHA-256", () => {
    expect(createHash("sha256").update(RAW).digest("hex")).toBe(PINNED_SHA256);
  });

  it("records its provenance and licence", () => {
    const doc = readFileSync(join(DIR, "PROVENANCE.md"), "utf8");
    expect(doc).toContain("bitcoin/bips");
    expect(doc).toContain("bip-0039/english.txt");
    expect(doc).toContain("942040ed50f7205cafc465496229128ba4f78e75");
    expect(doc).toContain(PINNED_SHA256);
    // Not merely "the string MIT appears somewhere": the notice must actually
    // be reproduced in-tree, and it must say what the licence covers rather
    // than asserting a settled answer the upstream document does not give.
    expect(doc).toMatch(/\bMIT\b/);
    expect(doc, "the upstream licence notice must be preserved verbatim").toContain("Copyright (c)");
    expect(doc, "the notice must be reproduced, not just cited").toMatch(/Permission is hereby granted, free of charge/);
    // And says what it is not.
    expect(doc).toMatch(/not\*{0,2} a BIP-39 mnemonic facility/i);
  });

  it("has unique four-character prefixes, as §6.4 requires", () => {
    // Two people comparing aloud only need the first four letters to agree.
    // The spec makes that a property of the list; nothing pinned it before.
    const words = RAW.toString("utf8").split("\n").slice(0, -1);
    const prefixes = words.map((w) => w.slice(0, 4));
    expect(new Set(prefixes).size, "every 4-character prefix must be unique").toBe(words.length);
  });

  it("is exactly 2048 well-formed entries", () => {
    const lines = RAW.toString("utf8").split("\n");
    expect(lines[lines.length - 1]).toBe(""); // one trailing newline, nothing after it
    const words = lines.slice(0, -1);
    expect(words.length).toBe(2048);
    expect(new Set(words).size).toBe(2048);
    for (const w of words) {
      expect(w, `"${w}" must be lowercase ASCII with no padding`).toMatch(/^[a-z]+$/);
      expect(w.trim()).toBe(w);
      expect(w.length).toBeGreaterThan(0);
    }
  });
});

describe("the generated array", () => {
  it("equals the vendored file, line for line and in order", () => {
    const words = RAW.toString("utf8").split("\n").slice(0, -1);
    expect(COMPARISON_WORDS.length).toBe(words.length);
    for (let i = 0; i < words.length; i += 1) {
      expect(COMPARISON_WORDS[i], `index ${i}`).toBe(words[i]);
    }
  });

  it("has the anchors the protocol depends on", () => {
    expect(WORDLIST_SIZE).toBe(2048);
    expect(COMPARISON_WORDS.length).toBe(2048);
    expect(COMPARISON_WORDS[0]).toBe("abandon");
    expect(COMPARISON_WORDS[1]).toBe("ability");
    expect(COMPARISON_WORDS[2047]).toBe("zoo");
  });

  it("is NOT sorted into some other order along the way", () => {
    // The BIP-39 list happens to be alphabetical, so "it is sorted" is not the
    // check. The check is that it is the SAME sequence as the file, which the
    // test above does — this one guards the opposite mistake: a build step that
    // "helpfully" re-sorted or deduplicated would change indices silently.
    const roundTrip = [...COMPARISON_WORDS].join("\n") + "\n";
    expect(createHash("sha256").update(roundTrip).digest("hex")).toBe(PINNED_SHA256);
  });
});

describe("wordsFromIndices", () => {
  it("maps indices to their exact words", () => {
    expect(wordsFromIndices([0, 1, 2047])).toEqual(["abandon", "ability", "zoo"]);
  });

  it("refuses an index that is not a valid 11-bit position", () => {
    for (const bad of [-1, 2048, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wordsFromIndices([bad]), `index ${String(bad)}`).toThrow(RangeError);
    }
  });

  it("preserves order and length", () => {
    const indices = [5, 5, 4, 3, 2, 1, 0, 9];
    const words = wordsFromIndices(indices);
    expect(words.length).toBe(indices.length);
    expect(words[0]).toBe(words[1]);
    expect(words[6]).toBe("abandon");
  });
});

/* ---- the frozen vectors, all the way to words ----------------------------- */

describe("protocol indices render to these exact words", () => {
  /* One tested chain: the engine's frozen index vectors → the vendored list's
   * order → what a person reads aloud. If any link moved, this changes. */

  it("VECTOR B's twelve request indices", () => {
    const indices = [660, 566, 1367, 776, 1217, 1943, 1467, 1358, 1509, 1182, 1312, 1508];
    expect(wordsFromIndices(indices)).toEqual([
      "family",
      "egg",
      "priority",
      "genre",
      "oblige",
      "very",
      "resist",
      "prefer",
      "royal",
      "need",
      "piano",
      "route"
    ]);
  });

  it("VECTOR C's eight confirmation indices", () => {
    const indices = [744, 368, 430, 1865, 945, 152, 1534, 1656];
    expect(wordsFromIndices(indices)).toEqual([
      "fringe",
      "come",
      "cupboard",
      "truck",
      "involve",
      "basic",
      "save",
      "someone"
    ]);
  });
});
