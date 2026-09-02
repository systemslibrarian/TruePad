/* ============================================================================
 * Shannon deployment assessment — the derivation, and what it refuses to say
 * ----------------------------------------------------------------------------
 * The classifier maps recorded FACTS to eligibility, and never launders an
 * unknown or a computational path into a stronger claim. These tests pin the
 * table, the ordering (a known disqualifier dominates), and the vocabulary
 * (ELIGIBLE, never SECURE; no persisted-verdict identifier; no overclaim word).
 * ========================================================================= */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessShannonDeployment,
  ASSESSMENT_LABEL,
  CONDITIONAL_CAVEAT,
  type DeliveryClass,
  type SourceClass
} from "../src/claims/shannon-deployment.ts";

const assess = (sourceClass: SourceClass, deliveryClass: DeliveryClass) =>
  assessShannonDeployment({ sourceClass, deliveryClass });

describe("the deployment classifier maps facts, and never promotes the unknown", () => {
  it("a software CSPRNG source is NOT ELIGIBLE, whatever the delivery", () => {
    for (const d of ["local-generation", "private-handoff-operator-asserted", "sealed-online", "raw-import-unknown", "unknown"] as DeliveryClass[]) {
      const r = assess("software-csprng", d);
      expect(r.assessment).toBe("not-eligible");
      expect(r.knownReason).toMatch(/CSPRNG/);
    }
  });

  it("sealed online delivery is NOT ELIGIBLE, whatever the source", () => {
    for (const s of ["external-declared", "unknown"] as SourceClass[]) {
      const r = assess(s, "sealed-online");
      expect(r.assessment).toBe("not-eligible");
      expect(r.knownReason).toMatch(/computational/);
    }
  });

  it("an unknown source or delivery is INSUFFICIENT EVIDENCE, never eligible", () => {
    expect(assess("unknown", "local-generation").assessment).toBe("insufficient-evidence");
    expect(assess("external-declared", "raw-import-unknown").assessment).toBe("insufficient-evidence");
    expect(assess("external-declared", "unknown").assessment).toBe("insufficient-evidence");
  });

  it("only an external-declared source with a non-computational, known delivery is CONDITIONALLY ELIGIBLE", () => {
    expect(assess("external-declared", "private-handoff-operator-asserted").assessment).toBe("conditionally-eligible");
    expect(assess("external-declared", "local-generation").assessment).toBe("conditionally-eligible");
    // ...and even then it carries no reason claiming a proof.
    expect(assess("external-declared", "local-generation").knownReason).toBeUndefined();
  });

  it("the labels say ELIGIBLE, never SECURE / TRUE OTP / PERFECT SECRECY", () => {
    const all = Object.values(ASSESSMENT_LABEL).join(" ");
    expect(ASSESSMENT_LABEL["conditionally-eligible"]).toBe("CONDITIONALLY ELIGIBLE");
    expect(ASSESSMENT_LABEL["not-eligible"]).toBe("NOT ELIGIBLE");
    expect(ASSESSMENT_LABEL["insufficient-evidence"]).toBe("INSUFFICIENT EVIDENCE");
    expect(all).not.toMatch(/\bSECURE\b|TRUE OTP|PERFECT SECRECY/i);
  });

  it("the conditional caveat lists the physical facts TruePad did NOT prove", () => {
    for (const needle of [/physical randomness/i, /independence/i, /copies/i, /courier/i, /restore/i, /erasure/i]) {
      expect(CONDITIONAL_CAVEAT).toMatch(needle);
    }
    expect(CONDITIONAL_CAVEAT).not.toMatch(/\bproves\b|\bverified\b|\bcertified\b/);
  });
});

describe("the module stores no self-certifying verdict", () => {
  const SRC = readFileSync(resolve(__dirname, "..", "src/claims/shannon-deployment.ts"), "utf8");
  // The banned persisted-verdict identifiers, in every spelling this project bans.
  const FORBIDDEN_FLAG = /\btrueRandom\b|\binformationTheoretic\b|\bverifiedRandom\b|\bphysicallyRandom\b|\bitCapable\b|\bperfectSecrecy\b|\bshannonSecure\b|\bcertifiedEntropy\b/;

  it("defines no trueRandom / informationTheoretic / itCapable / shannonSecure identifier", () => {
    // Strip comments: prose may mention the words to forbid them.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(FORBIDDEN_FLAG);
  });

  it("claims no proof of physical randomness anywhere in its strings", () => {
    for (const bad of [/truly random/i, /perfect secrecy achieved/i, /information-theoretic security confirmed/i, /proven random/i]) {
      expect(SRC).not.toMatch(bad);
    }
  });
});
