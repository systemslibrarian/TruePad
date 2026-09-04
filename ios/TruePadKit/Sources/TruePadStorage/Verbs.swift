import Foundation
import TruePadClaims
import TruePadCore

/* ============================================================================
 * The §12 transaction engine — the Swift twin of src/browser/engine/verbs.ts and
 * of Android's Verbs.kt.
 *
 * Every verb runs under the pair's exclusive lock, holds the frozen gate order,
 * and obeys the two orderings that define TruePad's safety:
 *
 *   BURN-BEFORE-OUTPUT  the header and journal advance durably (S2) before the
 *                       envelope exists outside the call (S3).
 *   PERSIST-BEFORE-USE  an open reserves its verification attempt durably (O3)
 *                       before the tag is checked (O4), and retires both
 *                       namespaces durably (O5) before the plaintext is
 *                       released (O6).
 *
 * If a durable write fails at any of those points, the operation throws and its
 * OUTPUT IS WITHHELD. That is the whole design:
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * This engine is pure Swift over the Fs abstraction. It runs unchanged on macOS
 * (fast tests, fault injection) and on iOS over the same DarwinFs, so the
 * security state machine that ships is the one the tests exercise.
 *
 * WHAT THIS FILE DOES NOT YET CONTAIN. The Sealed Pad Transfer verbs are not
 * here. `open` accepts the canonical §6.2 JSON envelope, which is what every
 * edition's `burn` emits; the TP2 compact transport is a QR-carriage concern and
 * is not implemented on iOS yet. Neither gap is papered over: there is no stub
 * that silently succeeds.
 * ========================================================================= */

// MARK: - paths and roles

public func storeDir(_ pairId: String, _ direction: PadDirection) -> String {
    "\(pairId)/\(directionSubdirectory[direction] ?? direction.rawValue)"
}

func filePath(_ prefix: String, _ name: String) -> String { "\(prefix)/\(name)" }

// `Party` is TruePadCore's, re-exported here so callers of the engine do not have
// to import the kernel for one two-case enum. It was briefly DECLARED again in
// this file, which made the name ambiguous for anything importing both modules --
// a compile error rather than a silent divergence, but a duplicate all the same.
public typealias Party = TruePadCore.Party

enum Op { case burn, open }

func directionFor(_ role: Party, _ op: Op) -> PadDirection {
    switch op {
    case .burn: return role == .a ? .aToB : .bToA
    case .open: return role == .a ? .bToA : .aToB
    }
}

/// The verbatim §7 verdict — scoped, never promoted to a stronger claim.
public let genVerdict =
    "Uniform if at least one declared source was uniform and independent of the others."

let bundleFiles: [String] = [
    "\(directionSubdirectory[.aToB]!)/\(headFile)",
    "\(directionSubdirectory[.aToB]!)/\(secretFile)",
    "\(directionSubdirectory[.aToB]!)/\(journalFile)",
    "\(directionSubdirectory[.bToA]!)/\(headFile)",
    "\(directionSubdirectory[.bToA]!)/\(secretFile)",
    "\(directionSubdirectory[.bToA]!)/\(journalFile)",
]

// MARK: - non-secret results

public struct SourceInput: Sendable {
    public let name: String
    public let declaredOrigin: String
    public let bytes: [UInt8]

    public init(name: String, declaredOrigin: String, bytes: [UInt8]) {
        self.name = name
        self.declaredOrigin = declaredOrigin
        self.bytes = bytes
    }
}

public struct DirectionMeters: Sendable, Equatable {
    public let direction: PadDirection
    public let capacity: Int
    public let nextOffset: Int
    public let remainingBytes: Int
    public let capacityRecords: Int
    public let nextSequence: Int
    public let remainingRecords: Int
    public let contestedLive: Int
    public let record: RecordSpec
    public let failureCount: Int
    public let frozen: Bool
    public let maxRemainingSends: Int
    public let limitedBy: String
    public let witnessKind: WitnessKind
    public let witnessState: WitnessState
    /// The DERIVED deployment classification for this direction, and the source
    /// class it was built from. NOT a stored verdict: recomputed from live facts
    /// on every summary, never persisted. Always INSUFFICIENT or NOT ELIGIBLE on
    /// iOS — an iOS pad is never CONDITIONALLY ELIGIBLE.
    public let deployment: DeploymentAssessment
    public let sourceClass: SourceClass
}

public struct PairSummary: Sendable, Equatable {
    public let pairId: String
    public let label: String
    public let createdAt: String
    public let destroyed: Bool
    public let origin: PairOrigin
    public let meters: [PadDirection: DirectionMeters]
}

/// One row of the pad list. A DESTROYED pair still has a row — its tombstone is
/// permanent and every verb refuses it — but it has NO meters, because there is
/// no live store left to meter. Optional rather than zero-filled: a pad with no
/// material left and a pad that no longer exists are different facts, and
/// fabricating zeros for the second would let the UI render it as the first.
public struct PairListEntry: Sendable, Equatable {
    public let pairId: String
    public let label: String
    public let createdAt: String
    public let destroyed: Bool
    public let summary: PairSummary?
}

public struct GenResult: Sendable { public let pair: PairSummary; public let verdict: String; public let requiredSourceLength: Int }
public struct BurnResult: Sendable { public let envelope: String; public let encryptionBytes: Int; public let authRecords: Int; public let meters: PairSummary }
public struct OpenResult: Sendable { public let plaintext: [UInt8]; public let skippedBytes: Int; public let skippedRecords: Int; public let meters: PairSummary }
public struct DestroyResult: Sendable { public let alreadyDestroyed: Bool; public let limitation: String }
public struct ExportResult: Sendable { public let container: [UInt8]; public let fileCount: Int }

// MARK: - the engine

/// - Parameters:
///   - fs: the pad store — the pair directories and their FORMAT-V2 files.
///   - witnessFs: where the rollback witness journal lives. It DEFAULTS to `fs`,
///     which is honest but weak: a witness in the same tree as the store is
///     restored alongside it and then knows nothing (the §15.2 caveat). A witness
///     only detects a rollback if it is in a DIFFERENT failure domain from the
///     thing being rolled back, which is what `KeychainWitnessFs` is for. What
///     that does NOT survive is app deletion — and that is loss, not reuse, which
///     is the trade this product always makes.
///   - clock: injectable so tests are deterministic; production passes the real one.
///   - pairIdSource: 16 random bytes for a new pairId. This is the ONLY place the
///     engine draws randomness, and a pairId is public metadata — never pad
///     material. Pad material comes exclusively from the operator's declared
///     sources (§7); the engine never manufactures a pad byte.
///
/// SEALED ANCESTRY IS READ, NOT INJECTED. Both halves of the fact now come from
/// durable markers this engine can see: the RECEIVER side from the SPT layer's
/// consumed.json markers (`sptPairArrivedSealed`), the SENDER side from the pad's
/// own handoff marker. There is no constructor parameter for it, deliberately —
/// anything that can be supplied can be supplied wrongly, and this fact only ever
/// disqualifies.
public final class Engine: @unchecked Sendable {
    let fs: Fs
    let witnessFs: Fs
    let clock: () -> Date
    let pairIdSource: () -> [UInt8]

    public init(fs: Fs,
                witnessFs: Fs? = nil,
                clock: @escaping () -> Date = { Date() },
                pairIdSource: @escaping () -> [UInt8] = { randomBytes(16) }) {
        self.fs = fs
        self.witnessFs = witnessFs ?? fs
        self.clock = clock
        self.pairIdSource = pairIdSource
    }

    func now() -> String { isoNow(clock()) }

    // MARK: - pair gates

    func requireNotDestroyed(_ pairId: String) throws {
        if fs.exists(tombstonePath(pairId)) {
            throw EngineRefused(
                reason: "pair-destroyed",
                message: "\(pairId) carries a durable \(tombstoneFile): destruction of this pair was "
                    + "initiated (§17), so it is permanently unusable. Its secret material may be "
                    + "partially overwritten or already absent, and there is no path back to an "
                    + "active state. Nothing was touched.")
        }
    }

    func requireImportComplete(_ pairId: String) throws {
        if fs.exists(importMarkerPath(pairId)) {
            throw EngineRefused(
                reason: "import-incomplete",
                message: "\(pairId) has an unfinished courier import (\(importMarkerFile) is "
                    + "present): the import did not commit, so the pair is not active. Re-run the "
                    + "import of the same bundle to complete it. Nothing was touched.")
        }
    }

    func refuseIfV1(_ pairId: String) throws {
        for d in [PadDirection.aToB, .bToA] where fs.exists(filePath(storeDir(pairId, d), v1PadFile)) {
            throw EngineRefused(
                reason: "v1-store",
                message: "\(storeDir(pairId, d)) holds a v1 store (\(v1PadFile)). v2 tooling refuses "
                    + "every v1 store and no conversion exists (§9). Generate a fresh v2 pair for v2.")
        }
    }

    func requirePair(_ pairId: String) throws {
        try refuseIfV1(pairId)
        let abHead = fs.exists(filePath(storeDir(pairId, .aToB), headFile))
        let baHead = fs.exists(filePath(storeDir(pairId, .bToA), headFile))
        if !abHead && !baHead {
            throw EngineRefused(
                reason: "no-store",
                message: "\(pairId) holds no v2 pad pair (no a-to-b/ or b-to-a/ \(headFile)); run gen first.")
        }
        if !abHead || !baHead {
            let missing = directionSubdirectory[!abHead ? .aToB : .bToA]!
            throw EngineRefused(
                reason: "half-pair",
                message: "\(pairId) is a half-pair: \(missing)/ is missing. gen did not complete. "
                    + "Do not use the surviving half.")
        }
    }

    func loadHalf(_ pairId: String, _ direction: PadDirection) throws -> LoadedStore {
        switch loadStore(fs: fs, prefix: storeDir(pairId, direction)) {
        case .ok(let store): return store
        case .refused(let reason, let message): throw EngineRefused(reason: reason, message: message)
        }
    }

    /// Hold the gates in the FROZEN ORDER: the tombstone (§17) is checked before
    /// anything else, then v1/wholeness, then both halves load. Both halves are
    /// loaded even for single-direction verbs because the freeze is pair-wide.
    func loadPair(_ pairId: String) throws -> [PadDirection: LoadedStore] {
        try requireNotDestroyed(pairId)
        try requireImportComplete(pairId)
        try requirePair(pairId)
        return [.aToB: try loadHalf(pairId, .aToB), .bToA: try loadHalf(pairId, .bToA)]
    }

    func frozenHalf(_ s: LoadedStore) -> Bool {
        s.effective.failureCount - s.effective.clearedAtFailureCount >= s.head.failureThreshold
    }

    func requireNotFrozen(_ pair: [PadDirection: LoadedStore]) throws {
        let frozen = [PadDirection.aToB, .bToA].filter { frozenHalf(pair[$0]!) }
        guard frozen.isEmpty else {
            throw EngineRefused(
                reason: "frozen",
                message: "The pair is frozen: \(frozen.map { $0.rawValue }.joined(separator: " and ")) "
                    + "reached the failure threshold. The freeze is the reversible operator brake "
                    + "(§8.4): it burns nothing and resets nothing. Run clear-freeze to resume. "
                    + "Nothing was burned.")
        }
    }

    func highWaters(_ s: LoadedStore) -> StoreHighWaters {
        StoreHighWaters(nextOffset: s.effective.nextOffset,
                        nextSequence: s.effective.nextSequence,
                        attemptsReserved: s.effective.attemptsReserved)
    }

    /// §15.3 PREFLIGHT for one direction's store, returning the witness so the
    /// caller can advance it AFTER the durable commit. The witness KIND comes from
    /// the iOS-only pair.json, never the frozen head.
    func witnessPreflight(_ store: LoadedStore, _ kind: WitnessKind) throws -> Witness {
        let witness = witnessFor(fs: witnessFs, kind: kind)
        if case .refused(let reason, let message) =
            witness.preflight(pairId: store.head.pairId, direction: store.head.direction,
                              store: highWaters(store)) {
            throw EngineRefused(reason: reason, message: message)
        }
        return witness
    }

    func witnessKindFor(_ pairId: String) throws -> WitnessKind {
        try readPairMeta(fs: fs, pairId: pairId).witness
    }

    /// True if this pad was SENT by sealed transfer, read from its durable
    /// handoff marker.
    ///
    /// FAILS CLOSED, and this direction is deliberate. The sender's retained copy
    /// of a pad whose whole material was sealed and sent has, by that act, had
    /// that material cross the computational X-Wing channel — it is only
    /// computationally confidential, exactly as the receiver's copy is. A
    /// torn/tampered marker must NOT let the verdict flip back to a stronger one:
    /// an honesty evaluator may only ever UNDER-claim. So `unreadableSpent` counts
    /// as sent-sealed too, consistent with the handoff module, where a
    /// present-but-torn marker is already "spent, not absent". A PHYSICAL handoff
    /// is deliberately NOT this.
    func sentSealed(_ pairId: String) -> Bool {
        switch readHandoffState(fs: fs, pairId: pairId) {
        case .sealed, .unreadableSpent: return true
        case .physical, .absent: return false
        }
    }

    // MARK: - meters & summaries

    func directionMeters(_ store: LoadedStore, kind: WitnessKind,
                         origin: PairOrigin, sealedAncestor: Bool) -> DirectionMeters {
        let h = store.head
        let e = store.effective
        let remainingBytes = h.capacity - e.nextOffset
        let remainingRecords = h.capacityRecords - e.nextSequence
        var contestedLive = 0
        for (sequence, count) in e.attempts
        where sequence >= e.nextSequence && count >= h.verifyAttemptLimit {
            contestedLive += 1
        }
        let ceilRecordsForBytes =
            (remainingBytes + WcOneTime.maxCiphertextBytes - 1) / WcOneTime.maxCiphertextBytes
        let limitedBy = remainingRecords <= ceilRecordsForBytes ? "AUTHENTICATION" : "ENCRYPTION"
        let state = witnessFor(fs: witnessFs, kind: kind)
            .report(pairId: h.pairId, direction: h.direction, store: highWaters(store))
        // Derive — never store — this direction's deployment classification from
        // the live facts assembled under this same lock. The evaluator is
        // TruePadClaims.assessDeployment, the ONE authority; the iOS facts can
        // never reach the strongest verdict.
        let facts = deploymentFactsFor(sourceDeclarations: h.sourceDeclarations, origin: origin,
                                       witnessKind: kind, witnessState: state,
                                       sealedAncestor: sealedAncestor)
        return DirectionMeters(
            direction: h.direction, capacity: h.capacity, nextOffset: e.nextOffset,
            remainingBytes: remainingBytes, capacityRecords: h.capacityRecords,
            nextSequence: e.nextSequence, remainingRecords: remainingRecords,
            contestedLive: contestedLive, record: h.record, failureCount: e.failureCount,
            frozen: frozenHalf(store), maxRemainingSends: remainingRecords, limitedBy: limitedBy,
            witnessKind: kind, witnessState: state,
            deployment: assessDeployment(facts), sourceClass: facts.source)
    }

    /// A live pair's non-secret summary. `loadPair` enforces the gates, so a pair
    /// reaching here is not destroyed — `destroyed: false` always holds.
    func buildSummary(_ pairId: String) throws -> PairSummary {
        let pair = try loadPair(pairId)
        let meta = try readPairMeta(fs: fs, pairId: pairId)
        // The sealed-ancestry fact, read once under this lock. Computational
        // delivery means NOT ELIGIBLE, permanently, for BOTH ends of a sealed
        // transfer and for both directions of the pad.
        let sealedAncestor = sptPairArrivedSealed(pairId) || sentSealed(pairId)
        return PairSummary(
            pairId: pairId, label: meta.label, createdAt: meta.createdAt, destroyed: false,
            origin: meta.origin,
            meters: [
                .aToB: directionMeters(pair[.aToB]!, kind: meta.witness, origin: meta.origin,
                                       sealedAncestor: sealedAncestor),
                .bToA: directionMeters(pair[.bToA]!, kind: meta.witness, origin: meta.origin,
                                       sealedAncestor: sealedAncestor),
            ])
    }

    // MARK: - gen (multi-source generation, §7)

    public func gen(label: String, sources: [SourceInput],
                    encryptionBytes: Int, authRecords: Int,
                    recordBytes: Int? = nil,
                    witnessKind: WitnessKind = .local,
                    verifyAttemptLimit: Int = WcOneTime.verifyAttemptLimitDefault,
                    maxAuthLookahead: Int = WcOneTime.maxAuthLookaheadDefault,
                    freezeThreshold: Int = WcOneTime.freezeThresholdDefault) throws -> GenResult {
        func requirePositive(_ v: Int, _ name: String) throws {
            guard v > 0 else {
                throw EngineRefused(reason: "invalid-argument",
                                    message: "\(name) must be a positive integer; found \(v).")
            }
        }
        try requirePositive(encryptionBytes, "encryptionBytes")
        try requirePositive(authRecords, "authRecords")
        try requirePositive(verifyAttemptLimit, "verifyAttemptLimit")
        try requirePositive(maxAuthLookahead, "maxAuthLookahead")
        try requirePositive(freezeThreshold, "freezeThreshold")

        let record: RecordSpec
        if let recordBytes {
            guard recordBytes >= 32, recordBytes <= WcOneTime.maxCiphertextBytes,
                  recordBytes % 16 == 0 else {
                throw EngineRefused(
                    reason: "invalid-argument",
                    message: "recordBytes must be a multiple of 16 with 32 <= F <= "
                        + "\(WcOneTime.maxCiphertextBytes) (§16); found \(recordBytes).")
            }
            record = .fixed(bytes: recordBytes)
        } else {
            record = .variable
        }
        guard !sources.isEmpty else {
            throw EngineRefused(reason: "invalid-argument",
                                message: "gen needs at least one source of declared-uniform material.")
        }

        let required = try Partition.requiredSourceLength(capacity: encryptionBytes,
                                                          capacityRecords: authRecords)
        let short = sources.filter { $0.bytes.count < required }
        guard short.isEmpty else {
            throw EngineRefused(
                reason: "source-too-short",
                message: "every declared source must supply the complete \(required) bytes "
                    + "(2·(E + 32·N) for E=\(encryptionBytes), N=\(authRecords)); too short: "
                    + "\(short.map { $0.name }.joined(separator: ", ")). Nothing was written.")
        }

        // NO content-dependent deduplication, and NO inspection of the combined
        // bytes by value. If at least one declared source is uniform and
        // independent of the others, the XOR is exactly uniform over the FULL
        // space — every combined value, all-zeros included, is a legitimate draw.
        // Refusing a source because its bytes equal another's would condition the
        // accepted distribution, so it is not done.
        let declarations = sources.map {
            SourceDeclaration(
                name: $0.name,
                declaredOrigin: $0.declaredOrigin.isEmpty
                    ? "declared by operator at gen; not verified by this tool"
                    : $0.declaredOrigin,
                lengthBytes: $0.bytes.count)
        }

        var combined = try Partition.combineSources(sources.map { $0.bytes }, length: required)
        let slices: Partition.PairSlices
        do {
            slices = try Partition.partition(combined, capacity: encryptionBytes,
                                             capacityRecords: authRecords)
        } catch {
            // partition() returns COPIES, never views of `combined` (§7), so the
            // combined buffer is dead the moment it returns — or throws.
            // In-memory hygiene only; no erasure claim.
            zero(&combined)
            throw error
        }
        zero(&combined)

        let pairIdBytes = pairIdSource()
        guard pairIdBytes.count == 16 else {
            throw EngineRefused(reason: "internal-pairid",
                                message: "a pairId is exactly 16 bytes; got \(pairIdBytes.count).")
        }
        let pairId = Hex.encode(pairIdBytes)

        func headFor(_ direction: PadDirection) -> HeadV2 {
            HeadV2(pairId: pairId, direction: direction, sourceDeclarations: declarations,
                   capacity: encryptionBytes, nextOffset: 0,
                   capacityRecords: authRecords, nextSequence: 0,
                   verifyAttemptLimit: verifyAttemptLimit, maxAuthLookahead: maxAuthLookahead,
                   record: record, failureThreshold: freezeThreshold,
                   failureCount: 0, clearedAtFailureCount: 0, perSequenceAttempts: [:])
        }
        // Copies, so the slices can be zeroed alongside them. Partition already
        // returns copies rather than views of `combined` (§7).
        var abEnc = slices.abEncryption, abAuth = slices.abAuthentication
        var baEnc = slices.baEncryption, baAuth = slices.baAuthentication
        var secretAB = abEnc + abAuth
        var secretBA = baEnc + baAuth
        let createdAt = now()

        defer {
            // AFTER the provisioning has settled — never before it, so nothing is
            // zeroed while initStore still needs the bytes. In-memory hygiene
            // only; no erasure claim.
            zero(&secretAB); zero(&secretBA)
            zero(&abEnc); zero(&abAuth); zero(&baEnc); zero(&baAuth)
        }
        try fs.withLock(pairId) {
            // §12.4: per half, secret.bin is durable before head.json and the init line.
            try initStore(fs: fs, prefix: storeDir(pairId, .aToB), head: headFor(.aToB),
                          secret: secretAB, at: createdAt)
            try initStore(fs: fs, prefix: storeDir(pairId, .bToA), head: headFor(.bToA),
                          secret: secretBA, at: createdAt)
            // Provision the iOS-local witness (the explicit event), THEN commit the
            // pair with pair.json LAST: a crash before pair.json leaves a fresh
            // store with no committed witness (ios-none, nothing advanced yet)
            // rather than a provisioned-but-unusable one.
            try witnessFor(fs: witnessFs, kind: witnessKind).bootstrap(pairId: pairId, initial: nil)
            try writePairMeta(fs: fs, meta: PairMeta(pairId: pairId, label: label,
                                                     createdAt: createdAt, witness: witnessKind,
                                                     origin: .generatedHere))
        }
        return GenResult(pair: try buildSummary(pairId), verdict: genVerdict,
                         requiredSourceLength: required)
    }

    // MARK: - status & list

    /// This pad's handoff state, for a caller deciding whether to OFFER a
    /// hand-over at all.
    ///
    /// Exposed so the UI does not have to reach into `fs`: a view that can touch
    /// the filesystem is a view that will eventually read a store file directly.
    /// Non-mutating, and it answers the same question `exportPair` will answer
    /// authoritatively under the lock — this only spares the operator a button
    /// that could only refuse.
    public func handoffState(pairId: String) -> HandoffState {
        readHandoffState(fs: fs, pairId: pairId)
    }

    public func status(_ pairId: String) throws -> PairSummary {
        try fs.withLock(pairId) { try buildSummary(pairId) }
    }

    /// The pad list.
    ///
    /// A pair that cannot be summarised at all — mid-write, corrupt, half-built —
    /// is SKIPPED rather than surfaced as a broken row, matching the release. It
    /// is still on disk and every verb still refuses it; it simply is not
    /// something to put in a list.
    public func listSummaries() throws -> [PairListEntry] {
        try listPairs().compactMap { pairId in
            do {
                if fs.exists(tombstonePath(pairId)) {
                    let meta = try readPairMeta(fs: fs, pairId: pairId)
                    return PairListEntry(pairId: pairId, label: meta.label,
                                         createdAt: meta.createdAt, destroyed: true, summary: nil)
                }
                let summary = try status(pairId)
                return PairListEntry(pairId: pairId, label: summary.label,
                                     createdAt: summary.createdAt, destroyed: false,
                                     summary: summary)
            } catch {
                return nil
            }
        }
    }

    public func listPairs() throws -> [String] {
        // A pair directory is named by its pairId, so anything that is not one is
        // not a pair — the staging root, a witness log from an older layout, or
        // whatever else shares the root. Matching the NAME is what the released
        // list-pairs does, and it is stricter than enumerating known non-pair
        // names one at a time.
        try fs.list("").filter { name in
            isHex32(name) && (
                fs.exists(filePath(storeDir(name, .aToB), headFile)) ||
                fs.exists(filePath(storeDir(name, .bToA), headFile)) ||
                fs.exists(tombstonePath(name)))
        }.sorted()
    }

    // MARK: - burn (SEND, §12.2)

    public func burn(pairId: String, role: Party, plaintext: [UInt8]) throws -> BurnResult {
        try fs.withLock(pairId) {
            let pair = try loadPair(pairId)
            let kind = try witnessKindFor(pairId)
            // S0 — checks, all free.
            try requireNotFrozen(pair)
            let direction = directionFor(role, .burn)
            let store = pair[direction]!
            let head = store.head
            let effective = store.effective
            let prefix = storeDir(pairId, direction)
            let witness = try witnessPreflight(store, kind)

            var payload: [UInt8]
            switch head.record {
            case .fixed(let bytes):
                let cap = Frame.capacity(recordBytes: bytes)
                guard plaintext.count <= cap else {
                    throw EngineRefused(
                        reason: "record-size-mismatch",
                        message: "this store fixes every record at \(bytes) ciphertext bytes, so a "
                            + "message holds at most \(cap) bytes (F − 4); this one is "
                            + "\(plaintext.count). Nothing was burned.")
                }
                payload = try Frame.build(plaintext: plaintext, recordBytes: bytes)
            case .variable:
                payload = plaintext
            }
            let c = payload.count
            guard c <= WcOneTime.maxCiphertextBytes else {
                throw EngineRefused(
                    reason: "oversize-ciphertext",
                    message: "this message is \(c) bytes; MAX_CIPHERTEXT_BYTES is "
                        + "\(WcOneTime.maxCiphertextBytes). Split it into multiple records. "
                        + "Nothing was burned.")
            }
            guard effective.nextSequence < head.capacityRecords else {
                throw EngineRefused(
                    reason: "auth-exhausted",
                    message: "authentication records are exhausted (\(head.capacityRecords) of "
                        + "\(head.capacityRecords) used). Auth exhaustion permanently kills sending "
                        + "on this direction. Nothing was burned.")
            }
            guard effective.nextOffset + c <= head.capacity else {
                throw EngineRefused(
                    reason: "encryption-exhausted",
                    message: "this message needs \(c) encryption bytes but only "
                        + "\(head.capacity - effective.nextOffset) remain. A one-time pad cannot "
                        + "borrow, wrap, or reuse. Nothing was burned.")
            }

            // S1 — staged in memory. Nothing on disk changes.
            let sequence = effective.nextSequence
            let startOffset = effective.nextOffset
            var (key, mask) = try readAuthRecord(fs: fs, prefix: prefix, head: head, sequence: sequence)
            var pad = try readEncryption(fs: fs, prefix: prefix, head: head,
                                         offset: startOffset, length: c)
            var ciphertext = [UInt8](repeating: 0, count: c)
            for i in 0..<c { ciphertext[i] = payload[i] ^ pad[i] }
            guard let pairIdBytes = Hex.decode(head.pairId), pairIdBytes.count == 16 else {
                throw EngineRefused(
                    reason: "corrupt-head",
                    message: "pairId in \(headFile) is not 32 lowercase hex characters: \(head.pairId)")
            }
            let tag = try WcOneTime.tag(key: key, mask: mask, fields: WcOneTime.CanonicalFields(
                pairId: pairIdBytes, direction: direction, sequence: sequence,
                startOffset: startOffset, ciphertext: ciphertext))
            let envelope = EnvelopeV2(pairId: head.pairId, direction: direction, sequence: sequence,
                                      startOffset: startOffset, ciphertextLength: c,
                                      ciphertext: ciphertext, tag: tag)

            // S2 — durable commit of BOTH namespaces. secret.bin is untouched (§1.2).
            var newHead = head
            newHead.nextOffset = startOffset + c
            newHead.nextSequence = sequence + 1
            var line = "{\"op\":\"send\",\"sequence\":\(sequence),\"startOffset\":\(startOffset)"
            line += ",\"consumed\":\(c),\"nextOffset\":\(startOffset + c)"
            line += ",\"nextSequence\":\(sequence + 1),\"at\":"
            appendJsonString(&line, now()); line += "}"
            try commitAdvance(fs: fs, prefix: prefix, newHead: newHead, journalLine: line)

            // §15.3 advance — after the durable commit, before the emit. burn
            // reserves no verification attempt, so attemptsReserved is unchanged.
            try witness.advance(pairId: pairId, direction: direction,
                                counters: WitnessCounters(
                                    encryptionNextOffset: startOffset + c,
                                    authenticationNextSequence: sequence + 1,
                                    attemptsReserved: effective.attemptsReserved))

            // S3 — only now does the envelope exist outside this call.
            let wire = try EnvelopeCodec.encode(envelope)
            // In-memory hygiene only; no erasure claim.
            zero(&payload); zero(&pad); zero(&key); zero(&mask)

            return BurnResult(envelope: wire, encryptionBytes: c, authRecords: 1,
                              meters: try buildSummary(pairId))
        }
    }

    // MARK: - open (OPEN, §12.3)

    public func open(pairId: String, role: Party, envelopeText: String) throws -> OpenResult {
        try fs.withLock(pairId) {
            let pair = try loadPair(pairId)
            let kind = try witnessKindFor(pairId)
            let direction = directionFor(role, .open)
            let store = pair[direction]!
            let head = store.head
            let effective = store.effective
            let prefix = storeDir(pairId, direction)

            // O0 — structural, free, before any secret is touched.
            // EITHER SPELLING, with no mode selector: canonical §6.2 JSON, or the
            // TP2 compact transport, which decodes to an EnvelopeV2 and then goes
            // through exactly this pipeline. A malformed TP2 input is refused AS
            // COMPACT and never re-tried as JSON.
            let envelope: EnvelopeV2
            switch CompactEnvelope.decodeTransport(envelopeText) {
            case .refused(let reason, let message):
                throw EngineRefused(reason: reason.rawValue, message: message)
            case .ok(let e):
                envelope = e
            }
            guard envelope.pairId == head.pairId else {
                throw EngineRefused(
                    reason: "wrong-pair",
                    message: "this envelope is addressed to pair \(envelope.pairId), but this pair "
                        + "is \(head.pairId). Nothing was burned.")
            }
            guard envelope.direction == direction else {
                throw EngineRefused(
                    reason: "wrong-direction",
                    message: "this envelope carries \(envelope.direction.rawValue) traffic; as "
                        + "\(role == .a ? "A" : "B") you open \(direction.rawValue). Nothing was burned.")
            }
            let sequence = envelope.sequence
            let startOffset = envelope.startOffset
            let c = envelope.ciphertextLength

            if case .fixed(let bytes) = head.record, c != bytes {
                throw EngineRefused(
                    reason: "record-size-mismatch",
                    message: "this store fixes every record at \(bytes) ciphertext bytes, but this "
                        + "envelope declares ciphertextLength \(c). It cannot be one of this "
                        + "store's records. Nothing was burned.")
            }

            // O1 — window, free.
            guard sequence >= effective.nextSequence else {
                throw EngineRefused(
                    reason: "sequence-retired",
                    message: "sequence \(sequence) is below this store's auth high-water "
                        + "\(effective.nextSequence): a replayed, late, or already-opened record. "
                        + "Its authentication material is retired in this copy, never again "
                        + "usable. Nothing was burned.")
            }
            guard sequence < head.capacityRecords else {
                throw EngineRefused(
                    reason: "sequence-malformed",
                    message: "sequence \(sequence) does not exist in this store (capacityRecords "
                        + "\(head.capacityRecords)): malformed. Nothing was burned.")
            }
            guard sequence < effective.nextSequence + head.maxAuthLookahead else {
                throw EngineRefused(
                    reason: "sequence-out-of-window",
                    message: "sequence \(sequence) is beyond the finite lookahead window "
                        + "[\(effective.nextSequence), \(effective.nextSequence + head.maxAuthLookahead)). "
                        + "More than \(head.maxAuthLookahead) consecutive lost records need explicit "
                        + "operator recovery (retire); the channel does not heal silently. "
                        + "Nothing was burned.")
            }
            guard startOffset >= effective.nextOffset else {
                throw EngineRefused(
                    reason: "offset-retired",
                    message: "startOffset \(startOffset) is below this store's encryption high-water "
                        + "\(effective.nextOffset): a legitimate sender's offsets never run behind "
                        + "an accepting receiver. Nothing was burned.")
            }
            guard startOffset + c <= head.capacity else {
                throw EngineRefused(
                    reason: "encryption-exhausted",
                    message: "this record's window [\(startOffset), \(startOffset + c)) runs past "
                        + "the encryption capacity \(head.capacity). Nothing was burned.")
            }

            // O2 — state gates, free.
            try requireNotFrozen(pair)
            let witness = try witnessPreflight(store, kind)
            let attempts = effective.attempts[sequence] ?? 0
            guard attempts < head.verifyAttemptLimit else {
                throw EngineRefused(
                    reason: "sequence-contested",
                    message: "sequence \(sequence) has used all \(head.verifyAttemptLimit) "
                        + "verification attempts and is permanently contested: never verifiable "
                        + "again under its key and mask. Recovery is an explicit operator retire. "
                        + "Nothing was burned.")
            }

            // O3 — the reservation. Durable BEFORE any verification.
            try reserveAttempt(fs: fs, prefix: prefix, sequence: sequence, at: now())
            let attemptsNow = attempts + 1

            // §15.3 advance with the new attempt total, still BEFORE the
            // verification — so a later restore that rolls the attempt budget back
            // is refused witness-regressed at preflight.
            try witness.advance(pairId: pairId, direction: direction,
                                counters: WitnessCounters(
                                    encryptionNextOffset: effective.nextOffset,
                                    authenticationNextSequence: effective.nextSequence,
                                    attemptsReserved: effective.attemptsReserved + 1))

            // O4 — verify over canonical bytes.
            var (key, mask) = try readAuthRecord(fs: fs, prefix: prefix, head: head, sequence: sequence)
            guard let pairIdBytes = Hex.decode(head.pairId), pairIdBytes.count == 16 else {
                throw EngineRefused(
                    reason: "corrupt-head",
                    message: "pairId in \(headFile) is not 32 lowercase hex characters: \(head.pairId)")
            }
            let expected = try WcOneTime.tag(key: key, mask: mask, fields: WcOneTime.CanonicalFields(
                pairId: pairIdBytes, direction: direction, sequence: sequence,
                startOffset: startOffset, ciphertext: envelope.ciphertext))
            guard WcOneTime.tagsEqual(expected, envelope.tag) else {
                // FAIL: burn neither namespace; persist the failure durably, THEN refuse.
                _ = try persistAuthFail(fs: fs, prefix: prefix, head: head,
                                        sequence: sequence, at: now())
                zero(&key); zero(&mask)
                let remaining = head.verifyAttemptLimit - attemptsNow
                throw EngineRefused(
                    reason: "auth-failed",
                    message: "the tag does not verify: a tampered, corrupted, or forged record. No "
                        + "pad material was consumed. Sequence \(sequence) has \(remaining) "
                        + "verification attempt\(remaining == 1 ? "" : "s") left before it is "
                        + "permanently contested. This refusal cost one durable attempt "
                        + "reservation — the stated availability price of a finite forgery bound "
                        + "(§8.4).")
            }

            // PASS: plaintext in memory, then O5.
            var pad = try readEncryption(fs: fs, prefix: prefix, head: head,
                                         offset: startOffset, length: c)
            var plaintext = [UInt8](repeating: 0, count: c)
            for i in 0..<c { plaintext[i] = envelope.ciphertext[i] ^ pad[i] }
            let skippedBytes = startOffset - effective.nextOffset
            let skippedRecords = sequence - effective.nextSequence

            // O5 — durably retire every position <= N in BOTH namespaces, including
            // the skipped material, which is destroyed unused.
            var newHead = head
            newHead.nextOffset = startOffset + c
            newHead.nextSequence = sequence + 1
            newHead.perSequenceAttempts = head.perSequenceAttempts.filter {
                (Int($0.key) ?? -1) > sequence
            }
            var line = "{\"op\":\"open\",\"sequence\":\(sequence),\"startOffset\":\(startOffset)"
            line += ",\"consumed\":\(c),\"skipped\":\(skippedBytes)"
            line += ",\"nextOffset\":\(startOffset + c),\"nextSequence\":\(sequence + 1),\"at\":"
            appendJsonString(&line, now()); line += "}"
            try commitAdvance(fs: fs, prefix: prefix, newHead: newHead, journalLine: line)

            // §15.3 advance — after the durable commit (O5), before the release (O6).
            try witness.advance(pairId: pairId, direction: direction,
                                counters: WitnessCounters(
                                    encryptionNextOffset: startOffset + c,
                                    authenticationNextSequence: sequence + 1,
                                    attemptsReserved: effective.attemptsReserved + 1))

            // §16.2: on a fixed store the decrypted bytes are the frame; the length
            // prefix selects the released plaintext. A prefix past F − 4 cannot come
            // from a conforming sender — but if it occurs the material is already
            // retired (O5), so this is an ERROR (nothing released), not a refusal.
            var released = plaintext
            if case .fixed(let bytes) = head.record {
                guard let parsed = Frame.parse(plaintext) else {
                    zero(&pad); zero(&key); zero(&mask); zero(&plaintext)
                    throw EngineError.recordFrameInvalid(
                        "record-frame-invalid: the decrypted frame's length prefix exceeds this "
                        + "store's \(Frame.capacity(recordBytes: bytes))-byte capacity (F − 4 for "
                        + "F=\(bytes)). The record's pad material is already retired (O5) and is "
                        + "LOST; no plaintext was released (§16.2, the same loss row as a crash "
                        + "after O5).")
                }
                released = parsed
            }
            zero(&pad); zero(&key); zero(&mask)

            // O6 — only now is the plaintext released, byte-exact.
            return OpenResult(plaintext: released, skippedBytes: skippedBytes,
                              skippedRecords: skippedRecords, meters: try buildSummary(pairId))
        }
    }

    // MARK: - retire (§8.5 operator recovery)

    public func retire(pairId: String, direction: PadDirection, throughSequence: Int,
                       throughOffset: Int? = nil, reason: String? = nil) throws -> PairSummary {
        try fs.withLock(pairId) {
            guard throughSequence >= 0 else {
                throw EngineRefused(reason: "invalid-argument",
                                    message: "throughSequence must be a non-negative integer.")
            }
            let pair = try loadPair(pairId)
            let kind = try witnessKindFor(pairId)
            let store = pair[direction]!
            let head = store.head
            let effective = store.effective
            let prefix = storeDir(pairId, direction)
            let witness = try witnessPreflight(store, kind)

            guard throughSequence < head.capacityRecords else {
                throw EngineRefused(
                    reason: "sequence-malformed",
                    message: "throughSequence \(throughSequence) does not exist (capacityRecords "
                        + "\(head.capacityRecords)).")
            }
            guard throughSequence >= effective.nextSequence else {
                throw EngineRefused(
                    reason: "sequence-retired",
                    message: "sequences through \(throughSequence) are already retired (auth "
                        + "high-water \(effective.nextSequence)). Nothing to do; nothing was burned.")
            }
            let newNextSequence = throughSequence + 1
            var newNextOffset = effective.nextOffset
            if let throughOffset {
                guard throughOffset >= 0 else {
                    throw EngineRefused(reason: "invalid-argument",
                                        message: "throughOffset must be a non-negative integer.")
                }
                guard throughOffset < head.capacity else {
                    throw EngineRefused(
                        reason: "encryption-exhausted",
                        message: "throughOffset \(throughOffset) runs past capacity \(head.capacity).")
                }
                guard throughOffset + 1 >= effective.nextOffset else {
                    throw EngineRefused(
                        reason: "offset-retired",
                        message: "offsets through \(throughOffset) are already retired (high-water "
                            + "\(effective.nextOffset)).")
                }
                newNextOffset = throughOffset + 1
            }

            var newHead = head
            newHead.nextOffset = newNextOffset
            newHead.nextSequence = newNextSequence
            newHead.perSequenceAttempts = head.perSequenceAttempts.filter {
                (Int($0.key) ?? -1) >= newNextSequence
            }
            var line = "{\"op\":\"retire\",\"toSequence\":\(newNextSequence)"
            line += ",\"toOffset\":\(newNextOffset),\"reason\":"
            appendJsonString(&line, reason ?? "operator retire")
            line += ",\"at\":"; appendJsonString(&line, now()); line += "}"
            try commitAdvance(fs: fs, prefix: prefix, newHead: newHead, journalLine: line)
            try witness.advance(pairId: pairId, direction: direction,
                                counters: WitnessCounters(
                                    encryptionNextOffset: newNextOffset,
                                    authenticationNextSequence: newNextSequence,
                                    attemptsReserved: effective.attemptsReserved))
            return try buildSummary(pairId)
        }
    }

    // MARK: - clear-freeze (§8.4)

    public func clearFreeze(pairId: String) throws -> Int {
        try fs.withLock(pairId) {
            let pair = try loadPair(pairId)
            var cleared = 0
            for direction in [PadDirection.aToB, .bToA] {
                let store = pair[direction]!
                guard frozenHalf(store) else { continue }
                var newHead = store.head
                newHead.failureCount = store.effective.failureCount
                newHead.clearedAtFailureCount = store.effective.failureCount
                var line = "{\"op\":\"clear-freeze\",\"atFailureCount\":"
                line += "\(store.effective.failureCount),\"at\":"
                appendJsonString(&line, now()); line += "}"
                try commitAdvance(fs: fs, prefix: storeDir(pairId, direction),
                                  newHead: newHead, journalLine: line)
                cleared += 1
            }
            return cleared
        }
    }

    // MARK: - destroy (§17 destruction)

    struct HalfSummary { let pairId: String?; let nextOffset: Int?; let nextSequence: Int? }

    func readHalfSummary(_ pairId: String, _ direction: PadDirection) -> HalfSummary {
        if case .ok(let store) = loadStore(fs: fs, prefix: storeDir(pairId, direction)) {
            return HalfSummary(pairId: store.head.pairId,
                               nextOffset: store.effective.nextOffset,
                               nextSequence: store.effective.nextSequence)
        }
        // Too corrupt to load: try to salvage the pairId and counters by hand, so
        // the operator can still confirm the destruction by pairId.
        guard let bytes = (try? fs.readFile(filePath(storeDir(pairId, direction), headFile))) ?? nil,
              let text = String(bytes: bytes, encoding: .utf8),
              let parsed = try? parseStrictJson(text), let members = parsed.memberMap else {
            return HalfSummary(pairId: nil, nextOffset: nil, nextSequence: nil)
        }
        var id: String?
        if case .string(let s)? = members["pairId"], isHex32(s) { id = s }
        func count(_ container: String, _ field: String) -> Int? {
            guard case .object? = members[container],
                  let inner = members[container]?.memberMap,
                  case .number(let raw)? = inner[field],
                  let v = Int(raw), v >= 0 else { return nil }
            return v
        }
        return HalfSummary(pairId: id,
                           nextOffset: count("encryption", "nextOffset"),
                           nextSequence: count("authentication", "nextSequence"))
    }

    func halfHasFiles(_ pairId: String, _ direction: PadDirection) -> Bool {
        let prefix = storeDir(pairId, direction)
        return fs.exists(filePath(prefix, headFile))
            || fs.exists(filePath(prefix, secretFile))
            || fs.exists(filePath(prefix, journalFile))
    }

    /// §17.2 step 3: best-effort zero-overwrite of one half's secret.bin. It proves
    /// NOTHING about the medium and claims no erasure — the file is removed anyway.
    func overwriteSecretZeros(_ pairId: String, _ direction: PadDirection) {
        let path = filePath(storeDir(pairId, direction), secretFile)
        guard let size = (try? fs.size(path)) ?? nil, size > 0 else { return }
        try? fs.writeRange(path, offset: 0, data: [UInt8](repeating: 0, count: size))
    }

    public func destroy(pairId: String, confirm: String, reason: String? = nil) throws -> DestroyResult {
        try fs.withLock(pairId) {
            let priorTombstone = readTombstone(fs: fs, pairId: pairId)
            // A v1 store is refused — unless this is already a tombstoned pair
            // being finished (a leftover pad.json must not misroute a
            // destroy-resume to v1).
            if !priorTombstone.exists { try refuseIfV1(pairId) }

            let abSum = readHalfSummary(pairId, .aToB)
            let baSum = readHalfSummary(pairId, .bToA)
            let resolvedPairId = abSum.pairId ?? baSum.pairId ?? priorTombstone.pairId

            // §17.1 confirmation: `confirm` MUST equal the pairId where a head
            // yields one; a pair too corrupt to yield one needs the literal token.
            // The pairId is deliberately NOT echoed — the operator confirms by
            // knowing it.
            let requiredToken = resolvedPairId ?? unreadablePairToken
            guard confirm == requiredToken else {
                throw EngineRefused(
                    reason: "destroy-unconfirmed",
                    message: resolvedPairId == nil
                        ? "this pair is too corrupt to confirm by pairId — no half's \(headFile) "
                          + "nor the tombstone yields one — so destroy requires confirm "
                          + "\"\(unreadablePairToken)\". Nothing was touched."
                        : "confirm must equal the pair's pairId to destroy it. It is NOT echoed "
                          + "here — read it from the pad book, a half's \(headFile), or "
                          + "\(tombstoneFile) and pass it verbatim. Nothing was touched.")
            }

            // Already fully torn down: idempotent — report and change nothing.
            if priorTombstone.exists && !halfHasFiles(pairId, .aToB) && !halfHasFiles(pairId, .bToA) {
                return DestroyResult(alreadyDestroyed: true, limitation: destroyLimitation)
            }

            // §17.2 order is normative. 2 — the tombstone (durable, and it survives
            // the destruction). On a RESUME (a well-formed tombstone exists) it is
            // PRESERVED, not rewritten — its destroyedAt is the historical truth.
            if !priorTombstone.wellFormed {
                func hw(_ s: HalfSummary) -> HighWaters? {
                    guard let o = s.nextOffset, let q = s.nextSequence else { return nil }
                    return HighWaters(nextOffset: o, nextSequence: q)
                }
                try writeTombstone(fs: fs, pairId: pairId, resolvedPairId: resolvedPairId,
                                   destroyedAt: now(), reason: reason ?? "operator destroy",
                                   ab: hw(abSum), ba: hw(baSum))
            }

            // 3 & 4 — per half: best-effort zero-overwrite of secret.bin, then
            // unlink the three files and the half directory.
            for direction in [PadDirection.aToB, .bToA] {
                overwriteSecretZeros(pairId, direction)
                let prefix = storeDir(pairId, direction)
                for name in [secretFile, headFile, journalFile] {
                    try? fs.remove(filePath(prefix, name))
                }
                try? fs.remove(prefix)
            }
            return DestroyResult(alreadyDestroyed: false, limitation: destroyLimitation)
        }
    }

    // MARK: - export-pair / import-pair (the courier bundle)

    /*
     * Export is a HANDOFF, and a pad gets ONE.
     *
     * PROVENANCE. An `imported` pad may NEVER be exported onward. Alice hands the
     * pad to Bob; Bob imports it; Bob saves the pad file and gives it to Charlie.
     * Bob and Charlie would then hold independently consumable copies of the same
     * directional material and the same one-time authentication keys. Software CAN
     * tell this case apart from a first handoff, so it does.
     *
     * HANDOFF STATE, then, and MARKER-LAST. The container is built in memory and
     * NOT released until the marker has been written: bytes that left without a
     * record would be a handoff nothing knows about.
     */

    /// The EXACT six-file courier container, read from the LIVE store.
    ///
    /// It mutates NO handoff state, and carries exactly the six FORMAT-V2 files —
    /// never pair.json, never the handoff record, never provenance, never witness
    /// data. Those are this installation's record of its own acts, not the pad.
    func buildLiveCourierContainer(_ pairId: String) throws -> [UInt8] {
        let files: [CourierFile] = try bundleFiles.map { rel in
            guard let bytes = try fs.readFile("\(pairId)/\(rel)") else {
                throw EngineRefused(
                    reason: "corrupt-store",
                    message: "\(rel) is missing; the pair is not whole. Nothing was exported.")
            }
            return CourierFile(path: rel, bytes: bytes)
        }
        return packContainer(pairId: pairId, files: files)
    }

    public func exportPair(pairId: String) throws -> ExportResult {
        try fs.withLock(pairId) {
            try requireNotDestroyed(pairId)
            try requireImportComplete(pairId)
            try requirePair(pairId)

            let meta = try readPairMeta(fs: fs, pairId: pairId)
            guard meta.origin != .imported else {
                throw EngineRefused(
                    reason: "imported-pair-cannot-export",
                    message: "This pad arrived from someone else, so TruePad will not save another "
                        + "copy of it to pass on. Two people holding the same pad would each use "
                        + "the same material, which is the one failure this product exists to "
                        + "prevent. Generate a new pad to share with someone new.")
            }

            switch readHandoffState(fs: fs, pairId: pairId) {
            case .unreadableSpent(let message):
                throw EngineRefused(reason: refuseUnreadable, message: message)
            case .sealed:
                throw EngineRefused(
                    reason: refuseAlreadySealed,
                    message: "This pad has already been sent by sealed transfer, so it will not "
                        + "also be saved as a file to pass on. Generate a new pad for any further "
                        + "transfer.")
            case .physical, .absent:
                break
            }

            let container = try buildLiveCourierContainer(pairId)

            // MARKER LAST, and BEFORE the container is released. A first export
            // records the handoff; a re-export under an existing physical marker
            // leaves it alone, so the recorded time stays the time of the FIRST
            // handoff.
            if case .absent = readHandoffState(fs: fs, pairId: pairId) {
                try commitPhysicalHandoff(fs: fs, pairId: pairId, at: now())
            }
            return ExportResult(container: container, fileCount: bundleFiles.count)
        }
    }

    /// Exactly the expected FORMAT-V2 files — no unknown, no duplicate, none missing.
    func validateBundleFileSet(_ files: [CourierFile]) -> String? {
        var seen = Set<String>()
        for f in files {
            guard bundleFiles.contains(f.path) else {
                return "bundle path \"\(f.path)\" is not one of this store's files."
            }
            guard seen.insert(f.path).inserted else {
                return "bundle path \"\(f.path)\" appears more than once."
            }
        }
        let missing = bundleFiles.filter { !seen.contains($0) }
        guard missing.isEmpty else {
            return "bundle is missing store file(s): \(missing.joined(separator: ", "))."
        }
        return nil
    }

    func removeStoreFiles(_ root: String) {
        for rel in bundleFiles { try? fs.remove("\(root)/\(rel)") }
        try? fs.remove("\(root)/\(directionSubdirectory[.aToB]!)")
        try? fs.remove("\(root)/\(directionSubdirectory[.bToA]!)")
    }

    /// Discard any INCOMPLETE import of this pairId — never a committed pair, which
    /// the caller checks first. Idempotent.
    ///
    /// THE WITNESS JOURNAL IS DELIBERATELY NOT REMOVED, and this is a considered
    /// divergence from the Browser Edition rather than an omission.
    ///
    /// The browser removes it here, and there that is harmless: its witness lives
    /// in the SAME OPFS domain as the store, so nothing can wipe the store and
    /// leave the witness. On iOS the witness is deliberately in ANOTHER failure
    /// domain — that is the entire purpose of KeychainWitnessFs — so the sequence
    ///
    ///     delete the app (container gone, Keychain item may survive)
    ///       -> reinstall
    ///       -> import an OLDER bundle of the same pad
    ///
    /// would delete the one piece of evidence engineered to outlive the container,
    /// re-bootstrap at the rewound counters, and let already-spent material be
    /// used again. That is REUSE, which this product may never permit.
    ///
    /// Keeping the journal costs nothing and cannot block a legitimate retry: it
    /// is append-only and reconciliation takes the MAXIMUM, so re-importing the
    /// same bundle bootstraps to the same high-waters and reads `aligned`, while
    /// re-importing an OLDER one reads `witness-regressed` — which is the correct
    /// answer. LOSS IS ACCEPTABLE; REUSE IS NOT.
    func discardIncompleteImport(_ pairId: String) {
        removeStoreFiles(pairId)
        try? fs.remove(pairMetaPath(pairId))
        try? fs.remove(importMarkerPath(pairId))
        try? fs.remove(pairId)
        removeStoreFiles(stagingDir(pairId))
        try? fs.remove(stagingDir(pairId))
    }

    /// A COMMITTED (active) pair with this id: a head.json is present AND the pair
    /// is not mid-import. A pair still carrying the import marker is not committed,
    /// so a retry may clean and redo it.
    func committedPairExists(_ pairId: String) -> Bool {
        if fs.exists(importMarkerPath(pairId)) { return false }
        return fs.exists(filePath(storeDir(pairId, .aToB), headFile))
            || fs.exists(filePath(storeDir(pairId, .bToA), headFile))
    }

    /// The FREE pre-consume importability gate. Non-mutating: it only reads state,
    /// so a doomed import is refused BEFORE any one-time material is spent —
    /// turning what would otherwise be a LOSS into a free retry. `importPair`
    /// re-checks both facts authoritatively under the pad lock.
    public func requireImportable(_ pairId: String) throws {
        try requireNotDestroyed(pairId)
        guard !committedPairExists(pairId) else {
            throw EngineRefused(
                reason: "pair-exists",
                message: "a pair with id \(pairId) already exists here; importing would overwrite "
                    + "it. Nothing was imported.")
        }
    }

    public func importPair(label: String, container: [UInt8],
                           witnessKind: WitnessKind = .local) throws -> PairSummary {
        let pairId: String
        let unpackedFiles: [CourierFile]
        switch unpackContainer(container) {
        case .bad(let message):
            throw EngineRefused(reason: "malformed-bundle", message: "\(message) Nothing was imported.")
        case .ok(let id, let files):
            pairId = id
            unpackedFiles = files
        }
        guard isHex32(pairId) else {
            throw EngineRefused(
                reason: "malformed-bundle",
                message: "bundle pairId must be exactly 32 lowercase hex characters (found "
                    + "\"\(pairId)\"). Nothing was imported.")
        }

        return try fs.withLock(pairId) {
            try requireNotDestroyed(pairId)
            guard !committedPairExists(pairId) else {
                throw EngineRefused(
                    reason: "pair-exists",
                    message: "a pair with id \(pairId) already exists here; importing would "
                        + "overwrite it. Nothing was imported.")
            }
            // A prior interrupted or failed import of this same pairId leaves no
            // active pair, only removable partial/staging files: clear them so a
            // retry is never blocked by a ghost, and so bootstrap starts clean.
            discardIncompleteImport(pairId)

            // §6 STAGE + VALIDATE. The WHOLE bundle is validated in
            // importing/<pairId>/ — file set, both headers, journals, secret sizes,
            // reconciliation, pairId and direction agreement — before ANY of it is
            // made active.
            if let problem = validateBundleFileSet(unpackedFiles) {
                throw EngineRefused(reason: "malformed-bundle",
                                    message: "\(problem) Nothing was imported.")
            }
            for f in unpackedFiles {
                try fs.writeFileAtomic("\(stagingDir(pairId))/\(f.path)", f.bytes)
            }

            let ab: LoadedStore
            let ba: LoadedStore
            do {
                func loadStaged(_ d: PadDirection) throws -> LoadedStore {
                    switch loadStore(fs: fs,
                                     prefix: "\(stagingDir(pairId))/\(directionSubdirectory[d]!)") {
                    case .ok(let store): return store
                    case .refused(let reason, let message):
                        throw EngineRefused(
                            reason: reason,
                            message: "imported \(d.rawValue) store: \(message)")
                    }
                }
                ab = try loadStaged(.aToB)
                ba = try loadStaged(.bToA)
                guard ab.head.pairId == pairId, ba.head.pairId == pairId else {
                    throw EngineRefused(
                        reason: "malformed-bundle",
                        message: "the bundle's \(headFile) pairId disagrees with the container "
                            + "pairId \(pairId). Nothing was imported.")
                }
                guard ab.head.direction == .aToB, ba.head.direction == .bToA else {
                    throw EngineRefused(
                        reason: "malformed-bundle",
                        message: "the bundle's two halves are not a matched A->B / B->A pair. "
                            + "Nothing was imported.")
                }
            } catch {
                removeStoreFiles(stagingDir(pairId))
                try? fs.remove(stagingDir(pairId))
                throw error
            }

            // §6 COMMIT. Mark the pair provisioning FIRST (so a crash mid-copy
            // leaves an inactive, retryable pair — never a partial active one),
            // copy the validated files in, bootstrap the witness to the IMPORTED
            // high-waters (only after the FORMAT-V2 state is validated), write
            // pair.json (the commit), then clear the marker and the staging.
            var marker = "{\"pairId\":"
            appendJsonString(&marker, pairId)
            marker.append(",\"at\":"); appendJsonString(&marker, now()); marker.append("}")
            try fs.writeFileAtomic(importMarkerPath(pairId), Array(marker.utf8))
            for f in unpackedFiles { try fs.writeFileAtomic("\(pairId)/\(f.path)", f.bytes) }
            if witnessKind == .local {
                try witnessFor(fs: witnessFs, kind: .local).bootstrap(
                    pairId: pairId,
                    initial: [
                        .aToB: WitnessCounters(encryptionNextOffset: ab.effective.nextOffset,
                                               authenticationNextSequence: ab.effective.nextSequence,
                                               attemptsReserved: ab.effective.attemptsReserved),
                        .bToA: WitnessCounters(encryptionNextOffset: ba.effective.nextOffset,
                                               authenticationNextSequence: ba.effective.nextSequence,
                                               attemptsReserved: ba.effective.attemptsReserved),
                    ])
            }
            // `origin` is a FIELD of the pair.json the commit already writes, before
            // importing.json is removed. There is NO ordering in which an imported
            // pair becomes active carrying "generated-here", and no ordering in
            // which a crash upgrades a pad's provenance.
            try writePairMeta(fs: fs, meta: PairMeta(pairId: pairId, label: label,
                                                     createdAt: now(), witness: witnessKind,
                                                     origin: .imported))
            try fs.remove(importMarkerPath(pairId))   // COMMIT: the pair is now active
            removeStoreFiles(stagingDir(pairId))
            try? fs.remove(stagingDir(pairId))

            return try buildSummary(pairId)
        }
    }
}

// MARK: - errors that are NOT refusals

/// A refusal means "nothing was touched". These do not: the pad material is
/// already durably retired when they are thrown, so they are ERRORS and must
/// never be presented as a refusal the operator can retry.
public enum EngineError: Error, Equatable {
    case recordFrameInvalid(String)
}

// MARK: - helpers

/// In-memory hygiene only. This is NOT an erasure claim: the compiler may keep
/// copies, and the allocator, the page cache and the flash translation layer all
/// keep whatever they keep. It costs nothing and narrows the window.
func zero(_ bytes: inout [UInt8]) {
    for i in bytes.indices { bytes[i] = 0 }
}

/// The ONLY randomness the engine draws, and only ever for a pairId — public
/// metadata, never pad material.
public func randomBytes(_ count: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: count)
    let status = out.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    precondition(status == errSecSuccess, "the system CSPRNG failed (\(status))")
    return out
}
