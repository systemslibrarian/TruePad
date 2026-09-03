/* ============================================================================
 * The cross-language SPT interop corpus — the Browser/CLI side.
 * ----------------------------------------------------------------------------
 * android/vectors/spt-interop.json is generated from THIS implementation
 * (scripts/gen-spt-interop.ts). These tests prove the committed corpus is still
 * exactly what the released seal produces (no stale corpus can survive a change)
 * and that this implementation OPENS every package in it — the Browser/CLI half
 * of the interop matrix the Kotlin SptInteropTest checks from the other side.
 * ========================================================================= */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/hex.ts";
import { openPayloadV1, sealPayloadV1 } from "../src/spt/crypto-v1.ts";

interface Case {
  label: string;
  eseedHex: string;
  requestBodyHex: string;
  decapSeedHex: string;
  payloadHex: string;
  packageHex: string;
  confirmValueHex: string;
  confirmationIndices: number[];
}

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../android/vectors/spt-interop.json"), "utf8")
) as { cases: Case[] };

const hx = (s: string) => hexToBytes(s)!;

describe("SPT interop corpus (Browser/CLI side)", () => {
  it("is non-trivial", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of corpus.cases) {
    it(`${c.label}: the committed package is exactly what a fresh seal produces`, async () => {
      const sealed = await sealPayloadV1(hx(c.requestBodyHex), hx(c.payloadHex), {
        eseedForVectorsOnly: hx(c.eseedHex)
      });
      expect(bytesToHex(sealed.packageBytes)).toBe(c.packageHex);
      expect(bytesToHex(sealed.confirmValue)).toBe(c.confirmValueHex);
    });

    it(`${c.label}: this implementation opens the package and recovers the payload`, async () => {
      const opened = await openPayloadV1(hx(c.packageHex), hx(c.requestBodyHex), hx(c.decapSeedHex));
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(bytesToHex(opened.result.payload)).toBe(c.payloadHex);
        expect(opened.result.confirmationIndices).toEqual(c.confirmationIndices);
      }
    });
  }
});
