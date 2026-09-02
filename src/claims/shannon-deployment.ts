/* ============================================================================
 * Deployment assurance — the single derived evaluator, never a stored verdict
 * ----------------------------------------------------------------------------
 * TruePad's message cipher is a literal one-time-pad XOR, authenticated by
 * one-time Wegman–Carter. Those are facts about the COMBINER. Whether a
 * PARTICULAR DEPLOYMENT can still support Shannon's information-theoretic
 * confidentiality — a fresh, uniform, secret, one-time pad, delivered privately,
 * with state discipline — is a different question, and it is the one this module
 * answers, conservatively, from FACTS TruePad has actually recorded.
 *
 * This is the ONE authority. The CLI, the Browser Edition, the docs guards, and
 * any future native client assemble the same `DeploymentFacts` from their own
 * durable stores/platforms and call `assessDeployment`. No edition invents its
 * own eligibility rule.
 *
 * TruePad records facts and bounded operator declarations and DERIVES every
 * classification from them. It never stores a self-certifying verdict — there is
 * no `shannonEligible`, `itCapable`, `trueRandom`, `verifiedRandom`,
 * `perfectSecrecy`, `shannonSecure`, `informationTheoretic`, `maximumSecurity`,
 * or `goldStandard` flag in any store, and none may be added. Software cannot
 * establish the physical facts such a flag would assert. See
 * docs/SHANNON-DEPLOYMENT.md and docs/MAXIMUM-ASSURANCE.md.
 * ========================================================================= */

/* ---- immutable provenance axes (recorded durably; travel with the pad) ----- */

/** How the pad was created. Frozen at creation, never raised afterward. */
export type CreationClass =
  | "browser-generated" // a Browser Edition pad (software CSPRNG source)
  | "cli-gen" // plain `truepad2 gen` — NOT the physical ceremony
  | "cli-ceremony" // `truepad2 ceremony create` — the physical-ceremony path
  | "imported" // arrived from elsewhere; how it was made is not ours to know
  | "unknown"; // no provenance record (a legacy store)

/** How the pad MATERIAL was sourced — premise B/C. */
export type SourceClass = "software-csprng" | "external-declared" | "unknown";

/** How the pad was DELIVERED to its intended holder — premise E. */
export type DeliveryClass =
  | "local-only" // generated here; not yet distributed by TruePad
  | "physical-private-operator-asserted" // couriered privately; an operator premise
  | "sealed-tps2" // delivered by sealed .tps2 — computational, end to end
  | "raw-import-unknown" // imported from a file; delivery not establishable
  | "unknown";

/** The ceremony's operator-premise state. Established at the ceremony boundary;
 *  it may be WITHDRAWN (a downgrade), never re-accepted to cross a boundary. */
export type CeremonyPremises = "accepted" | "absent" | "withdrawn" | "unknown";

/* ---- live facts (read from the store/platform at evaluation time) ---------- */

/** Where the LIVE pad state is authoritatively held. */
export type StorageAuthority = "native" | "browser-opfs" | "unknown";

/** The rollback/reuse authority. A witness is about state discipline, never
 *  entropy or delivery. Ordinary browser storage and a browser-local witness
 *  are one rollback domain, not an independent authority. */
export type RollbackWitness =
  | "none"
  | "separate-state-file"
  | "browser-local-witness"
  | "platform-monotonic"
  | "unknown";

export interface DeploymentFacts {
  creation: CreationClass;
  source: SourceClass;
  delivery: DeliveryClass;
  /** A sealed (.tps2) ancestor anywhere in this copy's lineage — PERMANENT once
   *  true; `"unknown"` only when a provenance record could not be read. */
  sealedAncestor: boolean | "unknown";
  ceremonyPremises: CeremonyPremises;
  storage: StorageAuthority;
  rollbackWitness: RollbackWitness;
}

export type Assessment = "conditionally-eligible" | "not-eligible" | "insufficient-evidence";

export interface DeploymentAssessment {
  assessment: Assessment;
  /** A short factual reason for a NOT ELIGIBLE / INSUFFICIENT result; null when
   *  CONDITIONALLY ELIGIBLE (whose qualifier is CONDITIONAL_CAVEAT). */
  knownReason: string | null;
}

const notEligible = (knownReason: string): DeploymentAssessment => ({ assessment: "not-eligible", knownReason });
const insufficient = (knownReason: string): DeploymentAssessment => ({ assessment: "insufficient-evidence", knownReason });

/**
 * Classify a deployment from recorded facts. Pure, total, and deliberately
 * conservative. Ordering is load-bearing (§7/§9):
 *
 *   1. A KNOWN contradictory path is NOT ELIGIBLE and can never be promoted —
 *      a software CSPRNG source, a sealed/computational-delivery ancestor,
 *      ordinary browser storage as the live authority, a withdrawn premise, or
 *      plain-gen creation (not the ceremony).
 *   2. The ONE strongest path — a CLI/native ceremony pad, external-declared
 *      source, private-handoff delivery accepted at the ceremony boundary, no
 *      sealed ancestor, ceremony premises accepted, a native live authority,
 *      and an independent rollback authority — is CONDITIONALLY ELIGIBLE.
 *   3. Everything else is INSUFFICIENT EVIDENCE: the strong premises are not all
 *      recorded, and absence of evidence is never treated as an ideal ceremony.
 */
export function assessDeployment(f: DeploymentFacts): DeploymentAssessment {
  // 1 — known contradictions (checked first; any one is disqualifying).
  if (f.source === "software-csprng") {
    return notEligible("the source material was generated by a software CSPRNG");
  }
  if (f.delivery === "sealed-tps2" || f.sealedAncestor === true) {
    return notEligible("the pad was delivered by sealed .tps2 — computational delivery, end to end");
  }
  if (f.storage === "browser-opfs") {
    return notEligible(
      "the live pad state is held in ordinary browser storage, which is one rollback domain with no independent witness"
    );
  }
  if (f.ceremonyPremises === "withdrawn") {
    return notEligible("an operator withdrew a required ceremony premise");
  }
  if (f.creation === "cli-gen") {
    return notEligible("the pad was generated by plain gen, not the physical ceremony");
  }

  // 2 — the single strongest path. Every condition must hold.
  const strongest =
    f.creation === "cli-ceremony" &&
    f.source === "external-declared" &&
    f.delivery === "physical-private-operator-asserted" &&
    f.sealedAncestor === false &&
    f.ceremonyPremises === "accepted" &&
    f.storage === "native" &&
    (f.rollbackWitness === "platform-monotonic" || f.rollbackWitness === "separate-state-file");
  if (strongest) {
    return { assessment: "conditionally-eligible", knownReason: null };
  }

  // 3 — the strong premises are not all established.
  return insufficient(
    "the maximum-assurance premises are not all recorded — the physical-ceremony creation, the private-handoff " +
      "acceptance, an independent rollback authority, or the source/delivery provenance is unknown"
  );
}

/* ---- display vocabulary --------------------------------------------------- */

export const ASSESSMENT_LABEL: Record<Assessment, string> = {
  "conditionally-eligible": "CONDITIONALLY ELIGIBLE",
  "not-eligible": "NOT ELIGIBLE",
  "insufficient-evidence": "INSUFFICIENT EVIDENCE"
};

export const CREATION_LABEL: Record<CreationClass, string> = {
  "browser-generated": "Browser Edition (software generator)",
  "cli-gen": "CLI plain gen",
  "cli-ceremony": "CLI physical ceremony",
  imported: "imported",
  unknown: "unknown"
};

export const SOURCE_LABEL: Record<SourceClass, string> = {
  "external-declared": "external, operator-declared",
  "software-csprng": "software random generator",
  unknown: "unknown"
};

export const DELIVERY_LABEL: Record<DeliveryClass, string> = {
  "local-only": "generated locally (not yet distributed)",
  "physical-private-operator-asserted": "physical private handoff (operator premise)",
  "sealed-tps2": "sealed online (computational)",
  "raw-import-unknown": "imported (unknown)",
  unknown: "unknown"
};

/** The premises TruePad did NOT prove — shown wherever CONDITIONALLY ELIGIBLE is
 *  displayed (§40), so the label can never be screenshot alone as "secure". */
export const UNPROVEN_PREMISES: readonly string[] = [
  "at least one source was genuinely uniform and secret",
  "the source was independent of the other sources and of the messages",
  "no extra copies, backups, or cloud-synced snapshots exist",
  "the courier handoff was actually private",
  "no stale external clone can cause reuse",
  "the pad material was physically erased on retirement"
];

export const CONDITIONAL_CAVEAT =
  "TruePad has recorded no known disqualifying path. It has not proved physical randomness, source independence, " +
  "the absence of copies, private courier behaviour, the absence of a restore, or physical erasure.";
