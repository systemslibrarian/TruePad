/* ============================================================================
 * Deployment assessment — the derivation, and what it refuses to say
 * ----------------------------------------------------------------------------
 * The single evaluator maps recorded FACTS to a classification, and never
 * launders an unknown, a software source, a computational delivery, a browser
 * store, a plain-gen creation, or a degraded rollback witness into a stronger
 * claim. These tests pin the table, the ORDERING (a known disqualifier
 * dominates, checked before the strongest conjunction), the one strongest path
 * (which now requires a LIVE, healthy platform-monotonic rollback authority),
 * the §40 unproven-premises list, and the vocabulary.
 * ========================================================================= */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessDeployment,
  ASSESSMENT_LABEL,
  CONDITIONAL_CAVEAT,
  UNPROVEN_PREMISES,
  type DeploymentFacts,
  type WitnessHealth
} from "../src/claims/shannon-deployment.ts";

// The ONE facts tuple the evaluator ranks CONDITIONALLY ELIGIBLE: a native
// ceremony pad, external-declared source, private handoff accepted, no sealed
// ancestor, premises accepted, AND a LIVE, healthy platform-monotonic rollback
// authority. Every ordering test starts here and mutates ONE axis.
const STRONGEST: DeploymentFacts = {
  creation: "cli-ceremony",
  source: "external-declared",
  delivery: "physical-private-operator-asserted",
  sealedAncestor: false,
  ceremonyPremises: "accepted",
  storage: "native",
  rollback: { kind: "platform-monotonic", health: "healthy" },
  assuranceAuthority: "handoff-accepted"
};

const withFacts = (patch: Partial<DeploymentFacts>): DeploymentFacts => ({ ...STRONGEST, ...patch });

describe("the deployment evaluator maps facts, and never promotes the unknown", () => {
  it("the one strongest path is CONDITIONALLY ELIGIBLE, and carries no proof reason", () => {
    const r = assessDeployment(STRONGEST);
    expect(r.assessment).toBe("conditionally-eligible");
    expect(r.knownReason).toBeNull();
  });

  it("a software CSPRNG source is NOT ELIGIBLE, and that reason dominates everything", () => {
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

  it("a withdrawn ceremony premise is NOT ELIGIBLE — a permanent one-way downgrade", () => {
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
    const r = assessDeployment(withFacts({ delivery: "local-only" }));
    expect(r.assessment).toBe("insufficient-evidence");
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

describe("the strongest verdict requires a LIVE platform-monotonic rollback authority (§2/§3)", () => {
  it("a healthy SEPARATE-STATE-FILE witness is INSUFFICIENT — strong, but not the maximum-assurance authority", () => {
    const r = assessDeployment(withFacts({ rollback: { kind: "separate-state-file", health: "healthy" } }));
    expect(r.assessment).toBe("insufficient-evidence");
    expect(r.knownReason).toMatch(/platform-monotonic/);
    expect(r.knownReason).toMatch(/separate state file/i);
  });

  it("a platform-monotonic witness that is UNREACHABLE is INSUFFICIENT — availability, not confirmed", () => {
    const r = assessDeployment(withFacts({ rollback: { kind: "platform-monotonic", health: "unreachable" } }));
    expect(r.assessment).toBe("insufficient-evidence");
    expect(r.knownReason).toMatch(/unreachable/);
  });

  it("a platform-monotonic witness that is UNSUPPORTED is INSUFFICIENT", () => {
    const r = assessDeployment(withFacts({ rollback: { kind: "platform-monotonic", health: "unsupported" } }));
    expect(r.assessment).toBe("insufficient-evidence");
    expect(r.knownReason).toMatch(/unsupported/);
  });

  it("NO rollback authority (none/unknown) is INSUFFICIENT on an otherwise-maximal pad", () => {
    expect(assessDeployment(withFacts({ rollback: { kind: "none" } })).assessment).toBe("insufficient-evidence");
    expect(assessDeployment(withFacts({ rollback: { kind: "unknown" } })).assessment).toBe("insufficient-evidence");
  });

  it("a REGRESSED or INCONSISTENT configured witness is NOT ELIGIBLE — a positive rollback/corruption signal", () => {
    for (const kind of ["separate-state-file", "platform-monotonic"] as const) {
      const regressed = assessDeployment(withFacts({ rollback: { kind, health: "regressed" } }));
      expect(regressed.assessment).toBe("not-eligible");
      expect(regressed.knownReason).toMatch(/restored|rolled-back|behind/i);
      const inconsistent = assessDeployment(withFacts({ rollback: { kind, health: "inconsistent" } }));
      expect(inconsistent.assessment).toBe("not-eligible");
      expect(inconsistent.knownReason).toMatch(/inconsistent/i);
    }
  });

  it("a regressed witness disqualifies even when it is the ONLY problem (the classification falls, not a warning)", () => {
    // Every other axis is maximal; the live health alone drops it to NOT ELIGIBLE.
    const healths: WitnessHealth[] = ["regressed", "inconsistent"];
    for (const health of healths) {
      expect(assessDeployment(withFacts({ rollback: { kind: "platform-monotonic", health } })).assessment).toBe(
        "not-eligible"
      );
    }
  });
});

describe("the strongest verdict requires the INDEPENDENT platform ceremony authority (§2, Attack A/B)", () => {
  it("a maximal pad whose platform authority does not attest handoff-accepted is INSUFFICIENT, not gold", () => {
    // Every provenance axis is maximal and the TPM rollback is healthy — but the
    // independent authority has not attested the accepted handoff. Editable
    // provenance alone can NEVER mint the ceremony story.
    for (const a of ["ordinary", "unavailable", "ceremony-created"] as const) {
      const r = assessDeployment(withFacts({ assuranceAuthority: a }));
      expect(r.assessment, a).toBe("insufficient-evidence");
      expect(r.knownReason, a).toMatch(/platform/i);
    }
  });

  it("a platform-attested TERMINAL withdrawal is NOT ELIGIBLE, whatever provenance says (Attack B)", () => {
    // Even with an otherwise-maximal (forged-looking) provenance story, the
    // platform authority's terminal withdrawal dominates.
    const r = assessDeployment(withFacts({ assuranceAuthority: "withdrawn" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/withdraw/i);
  });

  it("an inconsistent (stale/substituted) platform authority is NOT ELIGIBLE", () => {
    const r = assessDeployment(withFacts({ assuranceAuthority: "inconsistent" }));
    expect(r.assessment).toBe("not-eligible");
    expect(r.knownReason).toMatch(/inconsistent/i);
  });

  it("handoff-accepted is the ONLY assurance value that reaches gold", () => {
    for (const a of ["unavailable", "ordinary", "ceremony-created", "withdrawn", "inconsistent"] as const) {
      expect(assessDeployment(withFacts({ assuranceAuthority: a })).assessment).not.toBe("conditionally-eligible");
    }
    expect(assessDeployment(withFacts({ assuranceAuthority: "handoff-accepted" })).assessment).toBe("conditionally-eligible");
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
  const FORBIDDEN_FLAG =
    /\btrueRandom\b|\binformationTheoretic\b|\bverifiedRandom\b|\bphysicallyRandom\b|\bitCapable\b|\bperfectSecrecy\b|\bshannonSecure\b|\bcertifiedEntropy\b|\bmaximumSecurity\b|\bgoldStandard\b/;

  it("defines no trueRandom / informationTheoretic / itCapable / shannonSecure / goldStandard identifier", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(FORBIDDEN_FLAG);
  });

  it("claims no proof of physical randomness anywhere in its strings", () => {
    for (const bad of [/truly random/i, /perfect secrecy achieved/i, /information-theoretic security confirmed/i, /proven random/i]) {
      expect(SRC).not.toMatch(bad);
    }
  });
});
