/* ============================================================================
 * Deployment assessment — the derivation, and what it refuses to say
 * ----------------------------------------------------------------------------
 * The single evaluator maps recorded FACTS to a classification, and never
 * launders an unknown, a software source, a computational delivery, a browser
 * store, or a plain-gen creation into a stronger claim. These tests pin the
 * table, the ORDERING (a known disqualifier dominates, and is checked before the
 * strongest conjunction), the one strongest path, the §40 unproven-premises
 * list, and the vocabulary (ELIGIBLE, never SECURE; no persisted-verdict
 * identifier; no overclaim word).
 * ========================================================================= */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessDeployment,
  ASSESSMENT_LABEL,
  CONDITIONAL_CAVEAT,
  UNPROVEN_PREMISES,
  type DeploymentFacts
} from "../src/claims/shannon-deployment.ts";

// The ONE facts tuple the evaluator ranks CONDITIONALLY ELIGIBLE: a native
// ceremony pad, external-declared source, private handoff accepted, no sealed
// ancestor, premises accepted, an independent rollback witness. Every test that
// probes the ordering starts here and mutates ONE axis.
const STRONGEST: DeploymentFacts = {
  creation: "cli-ceremony",
  source: "external-declared",
  delivery: "physical-private-operator-asserted",
  sealedAncestor: false,
  ceremonyPremises: "accepted",
  storage: "native",
  rollbackWitness: "platform-monotonic"
};

const withFacts = (patch: Partial<DeploymentFacts>): DeploymentFacts => ({ ...STRONGEST, ...patch });

describe("the deployment evaluator maps facts, and never promotes the unknown", () => {
  it("the one strongest path is CONDITIONALLY ELIGIBLE, and carries no proof reason", () => {
    const r = assessDeployment(STRONGEST);
    expect(r.assessment).toBe("conditionally-eligible");
    expect(r.knownReason).toBeNull();
  });

  it("a separate-state-file witness also reaches CONDITIONALLY ELIGIBLE", () => {
    expect(assessDeployment(withFacts({ rollbackWitness: "separate-state-file" })).assessment).toBe(
      "conditionally-eligible"
    );
  });

  it("a software CSPRNG source is NOT ELIGIBLE, and that reason dominates everything", () => {
    // Even holding every other axis at its strongest, a software source disqualifies.
    const r = assessDeployment(withFacts({ source: "software-csprng" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/CSPRNG/);
  });

  it("a sealed .tps2 delivery or a sealed ancestor is NOT ELIGIBLE — computational, end to end", () => {
    expect(assessDeployment(withFacts({ delivery: "sealed-tps2" })).assessment).toBe("not-eligible");
    const anc = assessDeployment(withFacts({ sealedAncestor: true }));
    expect(anc.assessment).toBe("not-eligible");
    expect(anc.knownReason).toMatch(/computational/);
  });

  it("ordinary browser storage as the live authority is NOT ELIGIBLE, whatever else is recorded", () => {
    const r = assessDeployment(withFacts({ storage: "browser-opfs" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/browser storage/);
  });

  it("a withdrawn ceremony premise is NOT ELIGIBLE — a one-way downgrade", () => {
    const r = assessDeployment(withFacts({ ceremonyPremises: "withdrawn" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/withdrew/);
  });

  it("plain-gen creation is NOT ELIGIBLE — gen is not the physical ceremony (§3/§26)", () => {
    const r = assessDeployment(withFacts({ creation: "cli-gen" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/plain gen/);
  });

  it("a ceremony pad whose handoff is not yet accepted is INSUFFICIENT, not eligible", () => {
    // delivery still local-only, premises accepted: the ceremony exists but the
    // private-handoff acceptance (ceremony accept) has not happened.
    const r = assessDeployment(withFacts({ delivery: "local-only" }));
    expect(r.assessment).toBe("insufficient-evidence");
  });

  it("a missing rollback witness is INSUFFICIENT — no independent rollback authority", () => {
    expect(assessDeployment(withFacts({ rollbackWitness: "none" })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ rollbackWitness: "unknown" })).assessment).toBe("insufficient-evidence");
  });

  it("unknown provenance axes are INSUFFICIENT EVIDENCE, never reconstructed into an ideal ceremony", () => {
    expect(assessDeployment(withFacts({ creation: "unknown" })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ source: "unknown" })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ delivery: "unknown" })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ ceremonyPremises: "unknown" })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ sealedAncestor: "unknown" })).assessment).toBe("insufficient-evidence");
  });

  it("an imported pad, however delivered short of proof, is never CONDITIONALLY ELIGIBLE", () => {
    for (const delivery of ["raw-import-unknown", "local-only", "unknown"] as DeploymentFacts["delivery"][]) {
      expect(assessDeployment(withFacts({ creation: "imported", delivery })).assessment).not.toBe(
        "conditionally-eligible"
      );
    }
  });
});

describe("the strongest label always travels with its unproven premises (§40)", () => {
  it("names the six physical premises TruePad did not prove", () => {
    expect(UNPROVEN_PREMISES.length).toBeGreaterThanOrEqual(6);
    const joined = UNPROVEN_PREMISES.join(" ");
    for (const needle of [/uniform/i, /independen/i, /copies|backups/i, /courier|handoff/i, /reuse|clone/i, /erased|erasure/i]) {
      expect(joined).toMatch(needle);
    }
  });

  it("the conditional caveat lists the physical facts TruePad did NOT prove", () => {
    for (const needle of [/physical randomness/i, /independence/i, /copies/i, /courier/i, /restore/i, /erasure/i]) {
      expect(CONDITIONAL_CAVEAT).toMatch(needle);
    }
    expect(CONDITIONAL_CAVEAT).not.toMatch(/\bproves\b|\bverified\b|\bcertified\b/);
  });
});

describe("the vocabulary says ELIGIBLE, never SECURE / TRUE OTP / PERFECT SECRECY", () => {
  it("uses conditional, honest labels", () => {
    const all = Object.values(ASSESSMENT_LABEL).join(" ");
    expect(ASSESSMENT_LABEL["conditionally-eligible"]).toBe("CONDITIONALLY ELIGIBLE");
    expect(ASSESSMENT_LABEL["not-eligible"]).toBe("NOT ELIGIBLE");
    expect(ASSESSMENT_LABEL["insufficient-evidence"]).toBe("INSUFFICIENT EVIDENCE");
    expect(all).not.toMatch(/\bSECURE\b|TRUE OTP|PERFECT SECRECY/i);
  });
});

describe("the module stores no self-certifying verdict", () => {
  const SRC = readFileSync(resolve(__dirname, "..", "src/claims/shannon-deployment.ts"), "utf8");
  // The banned persisted-verdict identifiers, in every spelling this project bans.
  const FORBIDDEN_FLAG =
    /\btrueRandom\b|\binformationTheoretic\b|\bverifiedRandom\b|\bphysicallyRandom\b|\bitCapable\b|\bperfectSecrecy\b|\bshannonSecure\b|\bcertifiedEntropy\b|\bmaximumSecurity\b|\bgoldStandard\b/;

  it("defines no trueRandom / informationTheoretic / itCapable / shannonSecure / goldStandard identifier", () => {
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
