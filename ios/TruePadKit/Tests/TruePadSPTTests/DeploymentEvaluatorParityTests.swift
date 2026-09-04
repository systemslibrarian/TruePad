import Foundation
import TruePadClaims
import XCTest

/// THE EVALUATOR MUST AGREE ACROSS EDITIONS.
///
/// `test-vectors/deployment-evaluator-v3.json` is generated from the canonical
/// TypeScript evaluator (`src/claims/shannon-deployment.ts`) and is the same file
/// the Android `DeploymentCorpusTest` and the TypeScript corpus test are held to.
/// iOS now answers to it too, from the same bytes, without regenerating anything.
///
/// Fact ASSEMBLY is edition-specific by design — each platform reads its own store
/// — but the evaluator is not. Given identical facts, every edition must return an
/// identical verdict, and this is where that is enforced for iOS.
final class DeploymentEvaluatorParityTests: XCTestCase {
    struct Corpus: Decodable {
        let source: String
        let count: Int
        let cases: [Case]
    }

    struct Case: Decodable {
        let name: String
        let facts: Facts
        let expected: String
    }

    struct Facts: Decodable {
        let creation: String
        let source: String
        let delivery: String
        let sealedAncestor: SealedAncestorWire
        let ceremonyPremises: String
        let storage: String
        let rollback: Rollback
        let assuranceAuthority: String
    }

    /// The wire carries `true`, `false`, or the string `"unknown"`.
    enum SealedAncestorWire: Decodable {
        case bool(Bool)
        case unknown

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .bool(b); return }
            let s = try c.decode(String.self)
            guard s == "unknown" else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "sealedAncestor \(s)")
            }
            self = .unknown
        }

        var value: SealedAncestor {
            switch self {
            case .bool(true): return .yes
            case .bool(false): return .no
            case .unknown: return .unknown
            }
        }
    }

    struct Rollback: Decodable {
        let kind: String
        let health: String?
    }

    func corpus() throws -> Corpus {
        let url = XWingKATTests.repoRoot
            .appendingPathComponent("test-vectors/deployment-evaluator-v3.json")
        return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    }

    func facts(_ f: Facts) throws -> DeploymentFacts {
        let rollback: RollbackAuthority
        switch f.rollback.kind {
        case "none": rollback = .none
        case "unknown": rollback = .unknown
        case "browser-local": rollback = .browserLocal
        case "separate-state-file":
            rollback = .separateStateFile(health: try XCTUnwrap(WitnessHealth(rawValue: try XCTUnwrap(f.rollback.health))))
        case "platform-monotonic":
            rollback = .platformMonotonic(health: try XCTUnwrap(WitnessHealth(rawValue: try XCTUnwrap(f.rollback.health))))
        default:
            throw XCTSkip("unknown rollback kind \(f.rollback.kind)")
        }
        return DeploymentFacts(
            creation: try XCTUnwrap(CreationClass(rawValue: f.creation)),
            source: try XCTUnwrap(SourceClass(rawValue: f.source)),
            delivery: try XCTUnwrap(DeliveryClass(rawValue: f.delivery)),
            sealedAncestor: f.sealedAncestor.value,
            ceremonyPremises: try XCTUnwrap(CeremonyPremises(rawValue: f.ceremonyPremises)),
            storage: try XCTUnwrap(StorageAuthority(rawValue: f.storage)),
            rollback: rollback,
            assuranceAuthority: try XCTUnwrap(AssuranceAuthority(rawValue: f.assuranceAuthority)))
    }

    /// Every one of the committed cases, verdict for verdict.
    func testEveryCorpusCaseMatchesTheCanonicalEvaluator() throws {
        let c = try corpus()
        XCTAssertEqual(c.cases.count, c.count, "the corpus count must match its cases")
        XCTAssertGreaterThanOrEqual(c.cases.count, 56, "the corpus should not have shrunk")
        XCTAssertTrue(c.source.contains("shannon-deployment"),
                      "this must still be the canonical evaluator's output")

        var seen = Set<String>()
        for k in c.cases {
            let got = assessDeployment(try facts(k.facts))
            XCTAssertEqual(got.assessment.rawValue, k.expected,
                           "[\(k.name)] verdict differs from the canonical evaluator")
            seen.insert(k.expected)
            // A CONDITIONALLY ELIGIBLE verdict carries no reason; every other
            // verdict must name one, because an unexplained refusal is unusable.
            if k.expected == "conditionally-eligible" {
                XCTAssertNil(got.knownReason, "[\(k.name)] the strongest verdict carries no reason")
            } else {
                XCTAssertNotNil(got.knownReason, "[\(k.name)] a non-eligible verdict must say why")
                XCTAssertFalse((got.knownReason ?? "").isEmpty)
            }
        }
        XCTAssertEqual(seen.count, 3, "the corpus should exercise all three verdicts, got \(seen)")
    }

    // MARK: - the rules that must hold whatever the corpus contains

    /// Sealed `.tps2` ancestry PERMANENTLY disqualifies information-theoretic
    /// delivery — for any other combination of facts, including the otherwise
    /// strongest one.
    func testSealedAncestryIsPermanentlyDisqualifying() {
        var strongest = DeploymentFacts(
            creation: .cliCeremony, source: .externalDeclared,
            delivery: .physicalPrivateOperatorAsserted, sealedAncestor: .no,
            ceremonyPremises: .accepted, storage: .native,
            rollback: .platformMonotonic(health: .healthy),
            assuranceAuthority: .handoffAccepted)
        XCTAssertEqual(assessDeployment(strongest).assessment, .conditionallyEligible,
                       "control: this is the one strongest path")

        strongest.sealedAncestor = .yes
        XCTAssertEqual(assessDeployment(strongest).assessment, .notEligible,
                       "a sealed ancestor must disqualify even the strongest pad")

        strongest.sealedAncestor = .no
        strongest.delivery = .sealedTps2
        XCTAssertEqual(assessDeployment(strongest).assessment, .notEligible,
                       "sealed .tps2 delivery must disqualify")
    }

    /// UNKNOWN IS NEVER UPGRADED. An unknown import cannot become eligible by
    /// having everything else look good.
    func testUnknownIsNeverUpgraded() {
        let unknownImport = DeploymentFacts(
            creation: .imported, source: .unknown, delivery: .rawImportUnknown,
            sealedAncestor: .unknown, ceremonyPremises: .unknown, storage: .native,
            rollback: .platformMonotonic(health: .healthy),
            assuranceAuthority: .handoffAccepted)
        XCTAssertEqual(assessDeployment(unknownImport).assessment, .insufficientEvidence,
                       "an unknown import is never promoted, however healthy the platform is")
    }

    /// THE iOS CEILING, asserted rather than assumed. iOS cannot reach
    /// CONDITIONALLY ELIGIBLE — and not by a special case in the evaluator, but
    /// because its facts cannot satisfy the one strongest path. The Keychain
    /// witness changes the failure domain, not the assurance class.
    func testIosCannotReachConditionallyEligible() {
        // The most favourable facts an iOS pad could ever assemble: native
        // storage, and even the strongest witness health iOS could claim.
        for rollback: RollbackAuthority in [
            .none, .unknown,
            .separateStateFile(health: .healthy),
            .separateStateFile(health: .unreachable),
        ] {
            for source: SourceClass in [.externalDeclared, .unknown] {
                for creation: CreationClass in [.unknown, .imported] {
                    let ios = DeploymentFacts(
                        creation: creation, source: source,
                        delivery: .localOnly, sealedAncestor: .no,
                        ceremonyPremises: .absent, storage: .native,
                        rollback: rollback,
                        // iOS has no platform ceremony authority.
                        assuranceAuthority: .unavailable)
                    XCTAssertNotEqual(
                        assessDeployment(ios).assessment, .conditionallyEligible,
                        "iOS must never reach CONDITIONALLY ELIGIBLE "
                        + "(creation=\(creation) source=\(source) rollback=\(rollback))")
                }
            }
        }
    }

    /// A software CSPRNG source is a hard disqualifier, checked FIRST, so it wins
    /// over everything else.
    func testSoftwareCsprngIsAHardDisqualifier() {
        let f = DeploymentFacts(
            creation: .cliCeremony, source: .softwareCsprng,
            delivery: .physicalPrivateOperatorAsserted, sealedAncestor: .no,
            ceremonyPremises: .accepted, storage: .native,
            rollback: .platformMonotonic(health: .healthy),
            assuranceAuthority: .handoffAccepted)
        let got = assessDeployment(f)
        XCTAssertEqual(got.assessment, .notEligible)
        XCTAssertEqual(got.knownReason, "the source material was generated by a software CSPRNG",
                       "the FIRST contradiction is the one reported")
    }

    /// A regressed or inconsistent witness is disqualifying, not merely unproven.
    func testARegressedWitnessIsDisqualifying() {
        for health in [WitnessHealth.regressed, .inconsistent] {
            for kind in [RollbackAuthority.separateStateFile(health: health),
                         .platformMonotonic(health: health)] {
                let f = DeploymentFacts(
                    creation: .cliCeremony, source: .externalDeclared,
                    delivery: .physicalPrivateOperatorAsserted, sealedAncestor: .no,
                    ceremonyPremises: .accepted, storage: .native,
                    rollback: kind, assuranceAuthority: .handoffAccepted)
                XCTAssertEqual(assessDeployment(f).assessment, .notEligible,
                               "\(kind) with health \(health) must disqualify")
            }
        }
    }

    /// There is no stored verdict anywhere: the evaluator is a pure function of
    /// its facts, so the same facts always give the same answer and nothing is
    /// cached between calls.
    func testTheEvaluatorIsPureAndStoresNothing() {
        let f = DeploymentFacts(
            creation: .imported, source: .unknown, delivery: .rawImportUnknown,
            sealedAncestor: .no, ceremonyPremises: .absent, storage: .native,
            rollback: .none, assuranceAuthority: .unavailable)
        let first = assessDeployment(f)
        for _ in 0..<100 {
            XCTAssertEqual(assessDeployment(f), first, "the evaluator must be pure")
        }
    }
}
