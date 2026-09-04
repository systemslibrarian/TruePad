import TruePadClaims
import TruePadCore

/* ============================================================================
 * HONEST iOS DEPLOYMENT-FACT ASSEMBLY.
 *
 * The pure evaluator (TruePadClaims.assessDeployment) is the ONE authority; this
 * file maps an iOS pad's REALITY onto the frozen `DeploymentFacts` axes and calls
 * it. It never invents a classification and it can never manufacture the facts
 * that would raise one:
 *
 *   - storage is `native` — the store is app-container native files, not OPFS.
 *   - assuranceAuthority is ALWAYS `unavailable`. An iPhone has no TPM-anchored
 *     platform authority and no operator-pinned root of trust, so it cannot
 *     ATTEST a ceremony. This is the fact that keeps an iOS pad out of
 *     CONDITIONALLY ELIGIBLE forever, and it is derived from the platform, not
 *     hard-coded as a verdict.
 *   - rollback is `separate-state-file` (the ios-local-witness — real, and on a
 *     Keychain backing genuinely out of the container's failure domain, but still
 *     restorable) or `none`; NEVER `platform-monotonic`. THE SECURE ENCLAVE IS
 *     NOT A MONOTONIC COUNTER, and the Keychain witness changes the FAILURE
 *     DOMAIN, not the assurance class.
 *
 * Provenance may DOWNGRADE but is never laundered upward: the strongest an iOS
 * pad ever reaches is INSUFFICIENT EVIDENCE. A software-CSPRNG source is a hard
 * NOT ELIGIBLE.
 *
 * THE AXES ARE ASSEMBLED THE SAME WAY ANDROID ASSEMBLES THEM, deliberately.
 * Fact assembly is edition-specific by design — each platform reads its own store
 * — but where the two platforms have the same fact available, they must classify
 * it identically or the shared corpus would be proving nothing.
 * ========================================================================= */

/// The released wire name for the platform-CSPRNG source, recorded in head.json.
///
/// A FROZEN WIRE VALUE, identical in the Browser and Android Editions — not an
/// app constant. A pad made by ANY edition's device generator carries this name,
/// so matching it here classifies the source honestly across editions.
public let deviceSourceNameWire = "device-random"

/// Map the live witness comparison to the evaluator's health vocabulary.
///
/// A LOCAL witness that reads `n/a` cannot confirm its own health, so it is
/// `unreachable` — the requirement is NOT CONFIRMED — never silently healthy.
func healthOf(_ state: WitnessState) -> WitnessHealth {
    switch state {
    case .aligned, .ahead: return .healthy
    case .regressed: return .regressed
    case .inconsistent: return .inconsistent
    case .na: return .unreachable
    }
}

/// Assemble the honest `DeploymentFacts` for one direction of an iOS pad.
///
/// - Parameters:
///   - sourceDeclarations: this direction's `head.sourceDeclarations`.
///   - origin: the pair's recorded provenance (pair.json), never inferred.
///   - witnessKind: the live witness kind (pair.json), never the frozen head.
///   - witnessState: the live witness comparison for this direction.
///   - sealedAncestor: true iff this pad's material crossed the computational
///     X-Wing channel — it ARRIVED by sealed transfer, or it was SENT by one. A
///     PERMANENT fact that forces NOT ELIGIBLE and can never be laundered away by
///     re-import, QR, or wording.
public func deploymentFactsFor(sourceDeclarations: [SourceDeclaration],
                               origin: PairOrigin,
                               witnessKind: WitnessKind,
                               witnessState: WitnessState,
                               sealedAncestor: Bool) -> DeploymentFacts {
    // Source premise B/C, derived from HOW the pad was actually made: every
    // source is the platform CSPRNG -> software-csprng (a hard disqualifier); at
    // least one operator-supplied external source -> external-declared
    // (unverified, but not software-only); no declarations at all (a bare
    // copied-in store) -> unknown.
    let source: SourceClass
    if sourceDeclarations.isEmpty {
        source = .unknown
    } else if sourceDeclarations.allSatisfy({ $0.name == deviceSourceNameWire }) {
        source = .softwareCsprng
    } else {
        source = .externalDeclared
    }

    // Creation / delivery / sealed-ancestor / ceremony premises, from provenance.
    // iOS NEVER claims cli-gen, cli-ceremony, or browser-generated: it is a native
    // client with no physical-ceremony authority, so a generated-here pad's
    // creation class is simply `unknown` to this evaluator (the source axis
    // carries the real disqualification), and it never claims a private-handoff
    // ceremony premise.
    let creation: CreationClass
    let delivery: DeliveryClass
    let originSealed: SealedAncestor
    let premises: CeremonyPremises
    switch origin {
    case .generatedHere:
        creation = .unknown
        delivery = .localOnly
        originSealed = .no
        premises = .absent
    case .imported:
        creation = .imported
        delivery = .rawImportUnknown
        originSealed = .unknown
        premises = .unknown
    case .unknown:
        creation = .unknown
        delivery = .unknown
        originSealed = .unknown
        premises = .unknown
    }

    // A durable sealed-delivery marker is a HARD, permanent fact: a pad whose
    // material crossed the X-Wing channel is computationally delivered and NOT
    // ELIGIBLE, and that can never be laundered upward. When present it forces
    // sealedAncestor YES and the delivery class to sealed-tps2, both of which the
    // evaluator treats as disqualifying.
    let sealed: SealedAncestor = sealedAncestor ? .yes : originSealed
    let effectiveDelivery: DeliveryClass = sealedAncestor ? .sealedTps2 : delivery

    // Rollback authority — the LIVE fact. The ios-local-witness is a genuine
    // separate-state-file, and on the Keychain backing it survives a container
    // wipe; but it is still restorable, and Apple states Keychain survival across
    // app deletion is an implementation detail not to be relied upon. It is
    // exactly the `separate-state-file` class the evaluator treats as
    // real-but-insufficient. Neither kind is ever `platform-monotonic`.
    let rollback: RollbackAuthority
    switch witnessKind {
    case .none: rollback = .none
    case .local: rollback = .separateStateFile(health: healthOf(witnessState))
    }

    return DeploymentFacts(
        creation: creation,
        source: source,
        delivery: effectiveDelivery,
        sealedAncestor: sealed,
        ceremonyPremises: premises,
        storage: .native,
        rollback: rollback,
        assuranceAuthority: .unavailable)
}

// A one-step `assessIosDeployment` convenience is deliberately ABSENT, for the
// reason Android records in its own file: any helper that can be called WITHOUT
// the `sealedAncestor` argument will eventually be called that way, silently
// dropping the sealed-transfer disqualifier and reporting a dishonest verdict.
// The one production path — Engine.directionMeters — calls deploymentFactsFor and
// assessDeployment directly and threads the real fact.
