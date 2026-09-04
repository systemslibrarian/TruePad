/* ============================================================================
 * The deployment / assurance evaluator — Swift twin of
 * src/claims/shannon-deployment.ts.
 * ----------------------------------------------------------------------------
 * This module answers ONE question: given recorded facts about a pad, can this
 * deployment still support the Shannon confidentiality premises? It is pure,
 * total, and deliberately conservative.
 *
 * THE EVALUATOR IS SHARED; THE FACT ASSEMBLY IS NOT. Every edition reads its own
 * platform to build `DeploymentFacts` — the CLI reads provenance.json, the Browser
 * reads the pad's origin, Android and iOS read their own stores. But given the
 * SAME facts, every edition must return the SAME verdict, and that is what the
 * committed `deployment-evaluator-v3` corpus enforces across languages.
 *
 * Two rules this file must never break:
 *
 *   1. NO STORED VERDICT. The assessment is derived on every read from live
 *      facts. Persisting it would make a verdict outlive the facts that produced
 *      it, and a stale "eligible" is exactly the claim TruePad must never make.
 *      There is no `perfectSecrecy` or `shannonSecure` field anywhere.
 *   2. NO PLATFORM-SPECIFIC PROMOTION. iOS cannot reach CONDITIONALLY ELIGIBLE,
 *      and not because of a special case here — because its facts cannot satisfy
 *      the one strongest path: its storage is native but its assurance authority
 *      is `unavailable` and its rollback authority is not `platform-monotonic`.
 *      The Keychain witness changes the failure domain, not the assurance class.
 *      The Secure Enclave is not a TPM.
 * ========================================================================= */

// ---- immutable provenance axes ---------------------------------------------

/// How the pad was created. Frozen at creation, never raised afterward.
public enum CreationClass: String, Sendable, Equatable, CaseIterable {
    case browserGenerated = "browser-generated"
    case cliGen = "cli-gen"
    case cliCeremony = "cli-ceremony"
    case imported = "imported"
    case unknown = "unknown"
}

/// How the pad MATERIAL was sourced — premise B/C.
public enum SourceClass: String, Sendable, Equatable, CaseIterable {
    case softwareCsprng = "software-csprng"
    case externalDeclared = "external-declared"
    case unknown = "unknown"
}

/// How the pad was DELIVERED to its intended holder — premise E.
public enum DeliveryClass: String, Sendable, Equatable, CaseIterable {
    case localOnly = "local-only"
    case physicalPrivateOperatorAsserted = "physical-private-operator-asserted"
    case sealedTps2 = "sealed-tps2"
    case rawImportUnknown = "raw-import-unknown"
    case unknown = "unknown"
}

public enum CeremonyPremises: String, Sendable, Equatable, CaseIterable {
    case accepted, absent, withdrawn, unknown
}

// ---- live facts -------------------------------------------------------------

public enum StorageAuthority: String, Sendable, Equatable, CaseIterable {
    case native
    case browserOpfs = "browser-opfs"
    case unknown
}

public enum WitnessHealth: String, Sendable, Equatable, CaseIterable {
    case healthy, unreachable, regressed, inconsistent, unsupported
}

/// The rollback/reuse authority as a LIVE fact — its class AND current health.
/// A configured witness is not an available witness.
public enum RollbackAuthority: Sendable, Equatable {
    case none
    case unknown
    case browserLocal
    case separateStateFile(health: WitnessHealth)
    case platformMonotonic(health: WitnessHealth)

    var health: WitnessHealth? {
        switch self {
        case .separateStateFile(let h), .platformMonotonic(let h): return h
        default: return nil
        }
    }
}

public enum AssuranceAuthority: String, Sendable, Equatable, CaseIterable {
    case unavailable
    case untrustedAuthority = "untrusted-authority"
    case ordinary
    case ceremonyCreated = "ceremony-created"
    case handoffAccepted = "handoff-accepted"
    case withdrawn
    case inconsistent
}

/// A sealed ancestor anywhere in this copy's lineage — PERMANENT once true.
/// `.unknown` only when a provenance record could not be read.
public enum SealedAncestor: Sendable, Equatable {
    case yes, no, unknown
}

public struct DeploymentFacts: Sendable, Equatable {
    public var creation: CreationClass
    public var source: SourceClass
    public var delivery: DeliveryClass
    public var sealedAncestor: SealedAncestor
    public var ceremonyPremises: CeremonyPremises
    public var storage: StorageAuthority
    public var rollback: RollbackAuthority
    public var assuranceAuthority: AssuranceAuthority

    public init(creation: CreationClass, source: SourceClass, delivery: DeliveryClass,
                sealedAncestor: SealedAncestor, ceremonyPremises: CeremonyPremises,
                storage: StorageAuthority, rollback: RollbackAuthority,
                assuranceAuthority: AssuranceAuthority) {
        self.creation = creation
        self.source = source
        self.delivery = delivery
        self.sealedAncestor = sealedAncestor
        self.ceremonyPremises = ceremonyPremises
        self.storage = storage
        self.rollback = rollback
        self.assuranceAuthority = assuranceAuthority
    }
}

public enum Assessment: String, Sendable, Equatable {
    case conditionallyEligible = "conditionally-eligible"
    case notEligible = "not-eligible"
    case insufficientEvidence = "insufficient-evidence"
}

public struct DeploymentAssessment: Sendable, Equatable {
    public let assessment: Assessment
    /// A short factual reason for NOT ELIGIBLE / INSUFFICIENT; nil when
    /// CONDITIONALLY ELIGIBLE.
    public let knownReason: String?
}

private func notEligible(_ reason: String) -> DeploymentAssessment {
    DeploymentAssessment(assessment: .notEligible, knownReason: reason)
}

private func insufficient(_ reason: String) -> DeploymentAssessment {
    DeploymentAssessment(assessment: .insufficientEvidence, knownReason: reason)
}

/// Classify a deployment from recorded facts. ORDERING IS LOAD-BEARING:
///
///   1. A KNOWN contradictory path is NOT ELIGIBLE and can never be promoted.
///   2. The ONE strongest path is CONDITIONALLY ELIGIBLE.
///   3. Everything else is INSUFFICIENT EVIDENCE — absence of evidence is never
///      treated as an ideal ceremony.
public func assessDeployment(_ f: DeploymentFacts) -> DeploymentAssessment {
    // 1 — known contradictions, any one disqualifying.
    if f.source == .softwareCsprng {
        return notEligible("the source material was generated by a software CSPRNG")
    }
    if f.delivery == .sealedTps2 || f.sealedAncestor == .yes {
        return notEligible("the pad was delivered by sealed .tps2 — computational delivery, end to end")
    }
    if f.storage == .browserOpfs {
        return notEligible("the live pad state is held in ordinary browser storage, which is one "
                           + "rollback domain with no independent witness")
    }
    if f.ceremonyPremises == .withdrawn {
        return notEligible("an operator withdrew a required ceremony premise, and that downgrade is permanent")
    }
    if f.creation == .cliGen {
        return notEligible("the pad was generated by plain gen, not the physical ceremony")
    }
    // A CONFIGURED authority showing a POSITIVE rollback/corruption signal is
    // disqualifying, not merely unproven.
    switch f.rollback {
    case .separateStateFile(let health), .platformMonotonic(let health):
        if health == .regressed {
            return notEligible("the rollback witness shows this store is behind it — the "
                               + "restored/rolled-back-store signature")
        }
        if health == .inconsistent {
            return notEligible("the rollback witness is in an inconsistent state (corruption, or a "
                               + "foreign authority)")
        }
    default:
        break
    }
    if f.assuranceAuthority == .untrustedAuthority {
        return notEligible("this pair names a platform authority that is NOT this installation's "
                           + "pinned trusted authority — a pair may reference an authority but may "
                           + "not choose the trust root")
    }
    if f.assuranceAuthority == .withdrawn {
        return notEligible("the platform authority attests a TERMINAL withdrawal of this pair's "
                           + "ceremony premises — a permanent downgrade")
    }
    if f.assuranceAuthority == .inconsistent {
        return notEligible("the platform ceremony-assurance authority is inconsistent (stale, "
                           + "substituted, or corrupt)")
    }

    // 2 — the single strongest path. Every condition must hold.
    let maximalExceptRollback =
        f.creation == .cliCeremony &&
        f.source == .externalDeclared &&
        f.delivery == .physicalPrivateOperatorAsserted &&
        f.sealedAncestor == .no &&
        f.ceremonyPremises == .accepted &&
        f.storage == .native

    if maximalExceptRollback,
       case .platformMonotonic(let health) = f.rollback, health == .healthy,
       f.assuranceAuthority == .handoffAccepted {
        return DeploymentAssessment(assessment: .conditionallyEligible, knownReason: nil)
    }

    // 3 — INSUFFICIENT EVIDENCE, naming exactly what remains.
    if maximalExceptRollback {
        if case .separateStateFile(let health) = f.rollback, health == .healthy {
            return insufficient("this pad is rollback-protected by a separate state file, but the "
                                + "maximum-assurance profile requires a live, reachable, consistent "
                                + "platform-monotonic (TPM) rollback authority; a separate state file "
                                + "can be restored together with the pair")
        }
        if case .platformMonotonic(let health) = f.rollback, health == .unreachable {
            return insufficient("the platform-monotonic rollback authority is currently unreachable, "
                                + "so the maximum-assurance rollback requirement is not confirmed")
        }
        if case .platformMonotonic(let health) = f.rollback, health == .unsupported {
            return insufficient("the platform-monotonic rollback authority is unsupported in this "
                                + "build, so the maximum-assurance rollback requirement is not confirmed")
        }
        if case .platformMonotonic(let health) = f.rollback, health == .healthy {
            if f.assuranceAuthority == .unavailable {
                return insufficient("the platform ceremony-assurance authority does not attest a "
                                    + "completed ceremony for this pair (it reads unavailable); a "
                                    + "provenance.json that merely claims a ceremony is not sufficient")
            }
            return insufficient("the platform authority has not attested an accepted private handoff "
                                + "for this pair (ceremony assurance: "
                                + "\(f.assuranceAuthority.rawValue)); a provenance.json that merely "
                                + "claims one is not sufficient")
        }
        return insufficient("this pad has no independent live platform-monotonic rollback authority, "
                            + "which the maximum-assurance profile requires")
    }
    return insufficient("the maximum-assurance premises are not all recorded — the physical-ceremony "
                        + "creation, the private-handoff acceptance, or the source/delivery provenance "
                        + "is unknown or not yet established")
}

// ---- display vocabulary -----------------------------------------------------

public let assessmentLabel: [Assessment: String] = [
    .conditionallyEligible: "CONDITIONALLY ELIGIBLE",
    .notEligible: "NOT ELIGIBLE",
    .insufficientEvidence: "INSUFFICIENT EVIDENCE",
]
