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

/** The LIVE health of a configured rollback authority, obtained at evaluation
 *  time under the pair lock — never merely the configured class. A configured
 *  witness is not an available witness.
 *
 *  - `healthy`      reachable, identity-verified, consistent, and NOT behind the
 *                   store's high-water (the store is at or ahead of the witness).
 *  - `unreachable`  the authority could not be read (an availability failure —
 *                   not proof of rollback, but the requirement is not confirmed).
 *  - `regressed`    the store sits BELOW the witness: the restored/rolled-back
 *                   signature (a positive rollback signal).
 *  - `inconsistent` the witness disagrees with itself or its anchor (corruption
 *                   or a foreign authority).
 *  - `unsupported`  the class is specified but not implemented in this build. */
export type WitnessHealth = "healthy" | "unreachable" | "regressed" | "inconsistent" | "unsupported";

/** The rollback/reuse authority, as a LIVE fact. A witness is about state
 *  discipline, never entropy or delivery. Ordinary browser storage (`browser-
 *  local`) is one rollback domain, not an independent authority, and can never
 *  satisfy the maximum-assurance rollback requirement. Only a live, healthy
 *  `platform-monotonic` authority does. */
export type RollbackAuthority =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "browser-local" }
  | { kind: "separate-state-file"; health: WitnessHealth }
  | { kind: "platform-monotonic"; health: WitnessHealth };

/** The LIVE ceremony-assurance the independent platform authority attests for
 *  THIS pair — the strong-making fact that pair-directory JSON cannot forge
 *  (TruePad 3.0, §2-§7). It lives in the TPM-anchored platform state, outside the
 *  pair directory, and each level is reached only by a real ceremony operation
 *  that consumes a TPM increment.
 *
 *  - `unavailable`      no platform authority (no TPM witness, or unreachable):
 *                       the maximum-assurance ceremony facts cannot be attested.
 *  - `ordinary`         the authority attests NO ceremony for this pair (a plain
 *                       gen pair, or a pair whose provenance merely CLAIMS a
 *                       ceremony the authority never recorded).
 *  - `ceremony-created` the physical ceremony created this pair (handoff pending).
 *  - `handoff-accepted` the private handoff was accepted — the load-bearing fact.
 *  - `withdrawn`        a terminal, platform-attested downgrade (never reversible
 *                       by deleting or editing a pair-directory sidecar).
 *  - `inconsistent`     the authority's state is stale/substituted/corrupt. */
export type AssuranceAuthority =
  | "unavailable" // no platform authority, or none pinned/reachable — cannot attest
  | "untrusted-authority" // the pair names an authority that is NOT this installation's pinned trusted one
  | "ordinary"
  | "ceremony-created"
  | "handoff-accepted"
  | "withdrawn"
  | "inconsistent";

export interface DeploymentFacts {
  creation: CreationClass;
  source: SourceClass;
  delivery: DeliveryClass;
  /** A sealed (.tps2) ancestor anywhere in this copy's lineage — PERMANENT once
   *  true; `"unknown"` only when a provenance record could not be read. */
  sealedAncestor: boolean | "unknown";
  ceremonyPremises: CeremonyPremises;
  storage: StorageAuthority;
  /** The LIVE rollback authority — its class AND current health, both obtained
   *  under the pair lock. A configured-but-degraded witness never satisfies the
   *  strongest requirement, and a regressed/inconsistent one is disqualifying. */
  rollback: RollbackAuthority;
  /** The LIVE ceremony-assurance the independent platform authority attests for
   *  this pair — the strong ceremony facts that editable pair-directory JSON
   *  cannot mint. Only `handoff-accepted` satisfies the maximum-assurance
   *  ceremony requirement; `withdrawn`/`inconsistent` are disqualifying. */
  assuranceAuthority: AssuranceAuthority;
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
    return notEligible("an operator withdrew a required ceremony premise, and that downgrade is permanent");
  }
  if (f.creation === "cli-gen") {
    return notEligible("the pad was generated by plain gen, not the physical ceremony");
  }
  // A CONFIGURED rollback authority that shows a POSITIVE rollback/corruption
  // signal is disqualifying, not merely unproven: the store sits below its
  // witness (the restored-store signature), or the witness disagrees with
  // itself. This is the live-health fact falling, not a warning beside a label.
  if (f.rollback.kind === "separate-state-file" || f.rollback.kind === "platform-monotonic") {
    if (f.rollback.health === "regressed") {
      return notEligible("the rollback witness shows this store is behind it — the restored/rolled-back-store signature");
    }
    if (f.rollback.health === "inconsistent") {
      return notEligible("the rollback witness is in an inconsistent state (corruption, or a foreign authority)");
    }
  }
  // The independent platform ceremony-assurance authority (§2-§7). A terminal
  // withdrawal it attests is permanent and cannot be undone by editing or
  // deleting a pair-directory sidecar; an inconsistent (stale/substituted)
  // authority fails closed.
  if (f.assuranceAuthority === "untrusted-authority") {
    return notEligible(
      "this pair names a platform authority that is NOT this installation's pinned trusted authority — a pair may " +
        "reference an authority but may not choose the trust root"
    );
  }
  if (f.assuranceAuthority === "withdrawn") {
    return notEligible(
      "the platform authority attests a TERMINAL withdrawal of this pair's ceremony premises — a permanent downgrade"
    );
  }
  if (f.assuranceAuthority === "inconsistent") {
    return notEligible("the platform ceremony-assurance authority is inconsistent (stale, substituted, or corrupt)");
  }

  // 2 — the single strongest path. Every condition must hold. The rollback
  //     component requires a LIVE, healthy platform-monotonic authority (§3), and
  //     the ceremony facts must be attested by the INDEPENDENT platform authority
  //     as `handoff-accepted` (§2) — editable provenance.json alone is NOT
  //     sufficient to mint the ceremony/handoff story.
  const maximalExceptRollback =
    f.creation === "cli-ceremony" &&
    f.source === "external-declared" &&
    f.delivery === "physical-private-operator-asserted" &&
    f.sealedAncestor === false &&
    f.ceremonyPremises === "accepted" &&
    f.storage === "native";
  if (
    maximalExceptRollback &&
    f.rollback.kind === "platform-monotonic" &&
    f.rollback.health === "healthy" &&
    f.assuranceAuthority === "handoff-accepted"
  ) {
    return { assessment: "conditionally-eligible", knownReason: null };
  }

  // 3 — INSUFFICIENT EVIDENCE. When a pad is maximal in every way EXCEPT the
  //     rollback authority, name exactly what remains, so the operator learns
  //     that rollback protection may be present but is not the required kind.
  if (maximalExceptRollback) {
    if (f.rollback.kind === "separate-state-file" && f.rollback.health === "healthy") {
      return insufficient(
        "this pad is rollback-protected by a separate state file, but the maximum-assurance profile requires a live, " +
          "reachable, consistent platform-monotonic (TPM) rollback authority; a separate state file can be restored " +
          "together with the pair"
      );
    }
    if (f.rollback.kind === "platform-monotonic" && f.rollback.health === "unreachable") {
      return insufficient(
        "the platform-monotonic rollback authority is currently unreachable, so the maximum-assurance rollback " +
          "requirement is not confirmed"
      );
    }
    if (f.rollback.kind === "platform-monotonic" && f.rollback.health === "unsupported") {
      return insufficient(
        "the platform-monotonic rollback authority is unsupported in this build, so the maximum-assurance rollback " +
          "requirement is not confirmed"
      );
    }
    // The rollback authority IS a live healthy platform-monotonic witness, so
    // the only thing left is the independent ceremony attestation. The provenance
    // may CLAIM a ceremony, but the platform authority is what makes it
    // load-bearing (§2): editable provenance.json alone cannot mint it.
    if (f.rollback.kind === "platform-monotonic" && f.rollback.health === "healthy") {
      if (f.assuranceAuthority === "unavailable") {
        return insufficient(
          "the platform ceremony-assurance authority does not attest a completed ceremony for this pair (it reads " +
            "unavailable); a provenance.json that merely claims a ceremony is not sufficient"
        );
      }
      return insufficient(
        `the platform authority has not attested an accepted private handoff for this pair (ceremony assurance: ` +
          `${f.assuranceAuthority}); a provenance.json that merely claims one is not sufficient`
      );
    }
    return insufficient(
      "this pad has no independent live platform-monotonic rollback authority, which the maximum-assurance profile " +
        "requires"
    );
  }
  return insufficient(
    "the maximum-assurance premises are not all recorded — the physical-ceremony creation, the private-handoff " +
      "acceptance, or the source/delivery provenance is unknown or not yet established"
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

/** A human line for the LIVE rollback authority — its class and, for a
 *  configured witness, its current health. Only `platform-monotonic (live)`
 *  satisfies the maximum-assurance rollback requirement; every other line is a
 *  detail field explaining why the strongest label is out of reach. */
export function rollbackAuthorityLabel(r: RollbackAuthority): string {
  switch (r.kind) {
    case "none":
      return "NONE (no independent rollback authority)";
    case "unknown":
      return "unknown";
    case "browser-local":
      return "browser-local (one rollback domain, not independent)";
    case "separate-state-file":
      return `separate-state-file (${r.health}) — rollback-protected, but not the maximum-assurance authority`;
    case "platform-monotonic":
      return r.health === "healthy"
        ? "platform-monotonic (live, healthy) — maximum-assurance authority"
        : `platform-monotonic (${r.health}) — not currently satisfying the maximum-assurance requirement`;
  }
}

/** A human line for the independent platform ceremony-assurance authority. Only
 *  `handoff-accepted` (attested by the TPM-anchored authority) satisfies the
 *  maximum-assurance ceremony requirement. */
export const ASSURANCE_AUTHORITY_LABEL: Record<AssuranceAuthority, string> = {
  unavailable: "unavailable (no platform ceremony authority, or none pinned/reachable)",
  "untrusted-authority": "UNTRUSTED (the pair names an authority that is not this installation's pinned one)",
  ordinary: "ordinary (no ceremony attested by the platform authority)",
  "ceremony-created": "ceremony-created (platform-attested; handoff pending)",
  "handoff-accepted": "handoff-accepted (platform-attested)",
  withdrawn: "WITHDRAWN (platform-attested terminal downgrade)",
  inconsistent: "inconsistent (stale/substituted/corrupt platform authority)"
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
