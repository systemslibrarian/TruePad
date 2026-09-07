#if os(iOS)
import Combine
import Foundation
import SwiftUI
import TruePadCore
import TruePadStorage

/* ============================================================================
 * The models behind pad creation and the sealed-transfer ceremony.
 *
 * THE WORDS ARE RENDERED BY AN INJECTED CLOSURE, not by reaching into the SPT
 * module. The wordlist lives with the protocol that defines the index mapping;
 * the UI is handed the resulting strings. That keeps TruePadUI off the KEM — a
 * separation the posture tests assert — and it means a build whose wordlist
 * failed to load renders NOTHING rather than a plausible wrong phrase.
 * ========================================================================= */

/// Renders 11-bit indices to comparison words, or nil if it cannot render ALL of
/// them. Wired at launch by the composition root, which links the SPT module.
public typealias WordRenderer = ([Int]) -> [String]?

/// The default REFUSES. A build that forgot to wire the renderer must show no
/// words at all: a ceremony where one side reads eleven words and the other
/// twelve is worse than one that cannot start.
public enum CeremonyWords {
    nonisolated(unsafe) public static var render: WordRenderer = { _ in nil }
}

// MARK: - creating a pad

@MainActor
public final class CreatePadModel: ObservableObject {
    public enum Source: Hashable { case file, device }

    @Published public var label = ""
    // THE NORMAL PATH IS THE DEFAULT PATH. This used to open on `.file`, so the
    // first thing a new operator met was the expert ceremony — choose a file,
    // declare its origin — before they could make an ordinary pad at all. The
    // external ceremony is unchanged and still reachable; it is no longer the
    // thing standing in the doorway.
    @Published public var source: Source = .device
    // Opens on the same preset the Browser opens on, so the two editions offer
    // the same pad. These stay the single source of truth: a preset row sets
    // them, the advanced steppers set them, and `gen` is handed these two
    // integers either way.
    @Published public var encryptionBytes = PadSize.default.bytes
    @Published public var authRecords = PadSize.default.records
    /// THE OPERATOR'S OWN NOTE ABOUT WHERE THE BYTES CAME FROM.
    ///
    /// It used to be hardcoded here — every iOS external pad recorded the same
    /// sentence, written by the app rather than the operator. The Browser Edition
    /// asks ("Where did these bytes come from?") and records the answer, so iOS
    /// was giving a WEAKER provenance record while the manifest read as though a
    /// declaration had been made. A declaration nobody made is not a declaration.
    ///
    /// It remains a DECLARATION and never evidence: TruePad cannot check it, and
    /// nothing downstream treats it as proof.
    @Published public var declaredOrigin = ""

    /// The pad this sheet just made. Nil until it succeeds.
    @Published public private(set) var createdPairId: String?

    /// LENGTH PRIVACY, off by default. The daily flow never sees it; it lives
    /// under Advanced, like the raw capacity fields and for the same reason.
    ///
    /// (This comment was attached to `createdPairId` above, which is a pad id and
    /// has nothing to do with length privacy or with Advanced. Two doc comments
    /// had been merged onto one property, so the property that HAS an explanation
    /// carried none.)
    @Published public var fixedLength = false
    /// HELD AS TEXT, not as an Int. A number field that parses as it is typed
    /// cannot tell "not finished typing" from "not a number", and a value the
    /// operator is halfway through entering must not be silently replaced by
    /// whatever it currently parses to. The text is the operator's; the decision
    /// about it is `recordReadiness`.
    @Published public var fixedSizeText = String(FixedRecordIntake.defaultBytes)
    @Published public var chosenFileName: String?
    @Published public var chosenFileBytes: [UInt8]?
    @Published public var choosingFile = false
    @Published public private(set) var created = false
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine

    public init(engine: Engine) { self.engine = engine }

    /// Which preset the current numbers ARE, or nil once the operator has typed
    /// something of their own. Derived rather than stored, so the size rows and
    /// the advanced fields cannot disagree about what the pad will be.
    public var selectedSize: PadSize? {
        PadSize.matching(bytes: encryptionBytes, records: authRecords)
    }

    /// Choose a size. This is the whole of what a preset does: it writes the two
    /// numbers the operator would otherwise have typed.
    public func select(_ size: PadSize) {
        encryptionBytes = size.bytes
        authRecords = size.records
    }

    /// Take the result of the document picker.
    ///
    /// The decision lives in `ExternalSourceIntake` so it is reachable by a host
    /// test; this only applies it. Nothing here inspects the material or forms
    /// any view about its randomness, and nothing falls back to the device
    /// generator — an operator who asked for their own material and whose file
    /// failed gets a refusal, not a silently device-generated pad.
    public func acceptPickedFile(name: String, bytes: [UInt8]?) {
        switch ExternalSourceIntake.decide(name: name, bytes: bytes?.count) {
        case .accept:
            chosenFileName = name
            chosenFileBytes = bytes
        case .refuse(let message):
            chosenFileName = nil
            chosenFileBytes = nil
            refusalMessage = message
            showingRefusal = true
        case .cancelled:
            break
        }
    }

    /// Why the pad cannot be created yet — or `.ready`.
    public var readiness: ExternalSourceIntake.Readiness {
        ExternalSourceIntake.readiness(have: chosenFileBytes?.count,
                                       need: requiredSourceBytes,
                                       declaration: declaredOrigin)
    }

    public var requiredSourceBytes: Int {
        (try? Partition.requiredSourceLength(capacity: encryptionBytes,
                                             capacityRecords: authRecords)) ?? 0
    }

    /// Why "Create pad" is disabled, in the same words the fields use — or nil
    /// when it is not.
    ///
    /// SAME AUTHORITY, ONE PLACE. Derived in the order `canCreate` decides, so the
    /// button and its explanation cannot disagree; the failure mode of writing
    /// them separately is a disabled button under text saying everything is fine.
    /// This exists because both explanations lived beside their FIELDS, inside a
    /// disclosure that opens closed and sits below the button — so the reason was
    /// off-screen exactly when it mattered.
    public var blockingReason: String? {
        if label.isEmpty { return "Give the pad a name." }
        if let why = recordReadiness.explanation { return why }
        if source == .file, let why = readiness.explanation { return why }
        return nil
    }

    public var canCreate: Bool {
        guard !label.isEmpty else { return false }
        // THE RECORD SIZE GATES CREATION TOO, and it gates it for BOTH sources.
        // It is checked before the source because an unusable record size is
        // unusable however the material was obtained.
        guard recordReadiness.isReady else { return false }
        switch source {
        case .device: return true
        // ONE AUTHORITY, shared with the screen that explains itself. If the
        // button's condition and the explanation's condition were written
        // separately they would eventually disagree, and the failure mode is a
        // disabled button under text saying everything is fine.
        case .file: return readiness == .ready
        }
    }

    /// Whether the typed record size can be used, and if not, why not. The screen
    /// shows this and `canCreate` obeys it — one authority, as above.
    public var recordReadiness: FixedRecordIntake.Readiness {
        FixedRecordIntake.readiness(fixed: fixedLength,
                                    typed: fixedSizeText,
                                    encryptionCapacity: encryptionBytes)
    }

    /// What the engine is handed. Nil means variable-length, which is the
    /// default and is what omitting the argument has always meant.
    public var recordBytes: Int? {
        if case .ready(let bytes) = recordReadiness { return bytes }
        return nil
    }

    public func create() {
        do {
            let sources: [SourceInput]
            switch source {
            case .file:
                guard let bytes = chosenFileBytes else { return }
                // The operator's words, recorded verbatim. Trimmed only of
                // surrounding whitespace; nothing is substituted if it is short,
                // because the point is that it is THEIRS.
                sources = [SourceInput(name: chosenFileName ?? "source.bin",
                                       declaredOrigin: declaredOrigin
                                           .trimmingCharacters(in: .whitespacesAndNewlines),
                                       bytes: bytes)]
            case .device:
                // THE WIRE NAME MATTERS. `device-random` is the frozen value the
                // evaluator matches to classify the source as software-CSPRNG,
                // and that classification is a HARD disqualifier. Naming it
                // anything else would produce a pad that reads better than it is.
                sources = [SourceInput(name: deviceSourceNameWire,
                                       declaredOrigin: "this device's random generator",
                                       bytes: randomBytes(requiredSourceBytes))]
            }
            let result = try engine.gen(label: label, sources: sources,
                                        encryptionBytes: encryptionBytes, authRecords: authRecords,
                                        recordBytes: recordBytes)
            // WHICH pad was made, so the screen behind this sheet can offer the
            // next step on it rather than leaving the operator to find it.
            createdPairId = result.pair.pairId
            created = true
        } catch {
            refusalMessage = operatorMessage(for: error)
            showingRefusal = true
        }
    }
}

// MARK: - the recipient publishes a request

@MainActor
public final class ReceiveRequestModel: ObservableObject {
    @Published public private(set) var request: SptCreateResult?
    @Published public private(set) var qr: QrPayload?
    @Published public private(set) var requestWords: [String] = []
    /// The validated public `TPR2:` request, for copy and share.
    @Published public private(set) var code: PublicTransport?
    /// What became of the LAST request, once it is over. Nil while one is live.
    @Published public private(set) var outcome: ReceiveRequestStatus?
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    /// Whether the full phrase is displayable. A ceremony step is actionable only
    /// when the operator can actually SEE what they are being asked to compare.
    public var requestWordsComplete: Bool {
        CeremonyPhrase.isComplete(requestWords, expecting: CeremonyPhrase.requestWordCount)
    }

    let engine: Engine

    public init(engine: Engine) {
        self.engine = engine
        restore()
    }

    /// Pick up a request that survived a restart.
    ///
    /// WITHOUT THIS the tab held the published request in memory only, so a
    /// force-quit stranded a LIVE one-time key: it stayed pending on disk with no
    /// way to cancel it, no way to REJECT it after a failed word comparison, and
    /// no way to show the twelve words again. Losing reject is the part that
    /// matters — rejecting is how a comparison that does not match is meant to
    /// end, and the operator was left with no way to do it.
    ///
    /// Only fills an EMPTY slot, so a reload can never displace a request the
    /// operator is currently looking at.
    public func restore() {
        guard request == nil else { return }
        guard let restored = try? engine.sptRestorePendingReceiveRequest() else { return }
        adopt(restored)
    }

    /// RE-READ THE DURABLE STATE. Called whenever the Receive screen appears.
    ///
    /// The screen used to hold whatever it was last handed. Once opening a sealed
    /// pad became reachable, that meant a request the operator had just CONSUMED
    /// by importing a pad went on being displayed as live — its QR, its twelve
    /// words, and a "Cancel this request" button that could only throw, because
    /// the engine refuses to cancel a consumed request. The screen stayed in that
    /// state until the app was relaunched, and `restore()` could not replace it
    /// because it only fills an empty slot.
    ///
    /// Nothing here is a guess: it asks the store about the exact request being
    /// held, and only then offers whatever is genuinely pending instead.
    public func refresh() {
        if let held = request {
            let status = engine.sptReceiveRequestStatus(requestIdHex: held.requestIdHex)
            if status.isTerminal {
                // SAY WHICH ENDING IT WAS. Silently dropping the request left the
                // operator looking at a "Create a receive code" button with no
                // account of what happened to the last one — and after a REJECTION
                // that silence is the worst version, because rejecting is a
                // decision the operator deliberately made.
                outcome = status
                request = nil
                qr = nil
                requestWords = []
            }
        }
        restore()
        // A live request supersedes any notice about the previous one.
        if request != nil { outcome = nil }
    }

    /// Dismiss the notice about the finished request.
    public func acknowledgeOutcome() { outcome = nil }

    public func create() {
        do {
            // THE NOTICE BELONGS TO THE REQUEST IT DESCRIBES. Without this, an
            // operator who rejected a transfer, made a fresh request and then
            // cancelled it would be shown "Transfer rejected" as the account of
            // the request they had just cancelled — the previous request's
            // ending, attached to a different request.
            outcome = nil
            adopt(try engine.sptCreateReceiveRequest())
        } catch {
            refuse(error)
        }
    }

    /// One place where a request becomes what the screen shows, so a restored
    /// request and a freshly created one cannot diverge in how they are rendered
    /// or validated.
    private func adopt(_ result: SptCreateResult) {
        request = result
        requestWords = CeremonyWords.render(result.requestIndices) ?? []
        // RE-VALIDATED ONCE, then used for every egress. The same canonical
        // string is what is shown, copied, shared and drawn — a screen cannot
        // copy one spelling while displaying another, because there is only one.
        if case .success(let material) = PublicTransport.receiveRequest(result.tpr2Text) {
            code = material
        } else {
            code = nil
        }
        // A request that will not round-trip is not shown as a code at all, and
        // a request too long for a QR is still perfectly copyable.
        if case .success(let payload) = QrPayloadBuilder.receiveRequest(result.tpr2Text) {
            qr = payload
        } else {
            qr = nil
        }
    }

    public func cancel() {
        guard let request else { return }
        do {
            _ = try engine.sptCancelReceiveRequest(requestIdHex: request.requestIdHex)
            // Record THIS ending, so the screen reports the cancellation the
            // operator just performed rather than whatever happened last time.
            outcome = .cancelled
            self.request = nil
            qr = nil
            code = nil
            requestWords = []
            // If the missing restore let the operator publish more than one,
            // surface the next rather than stranding it until a relaunch.
            restore()
        } catch {
            refuse(error)
        }
    }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}

// MARK: - the sender reviews, confirms, seals

@MainActor
public final class SealModel: ObservableObject {
    @Published public var pastedRequest = ""
    @Published public private(set) var review: SptReviewResult?
    @Published public private(set) var requestWords: [String] = []
    @Published public private(set) var confirmed = false
    @Published public private(set) var sealed: SptSealResult?
    @Published public private(set) var confirmationWords: [String] = []
    @Published public var fileToShare: ShareableFile?
    /// Holds the scratch file's lifetime OUTSIDE the presentation binding, because
    /// SwiftUI clears an `item:` binding before calling `onDismiss`. The rule and
    /// its tests live in `HandoffScratchFile`, which CI can actually reach.
    private let scratch = HandoffScratchFile()

    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    public var requestWordsComplete: Bool {
        CeremonyPhrase.isComplete(requestWords, expecting: CeremonyPhrase.requestWordCount)
    }
    public var confirmationWordsComplete: Bool {
        CeremonyPhrase.isComplete(confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)
    }

    let engine: Engine
    let pairId: String

    public init(engine: Engine, pairId: String) {
        self.engine = engine
        self.pairId = pairId
    }

    public func review(_ text: String) {
        do {
            let result = try engine.sptReviewRequest(text)
            review = result
            requestWords = CeremonyWords.render(result.requestIndices) ?? []
            confirmed = false
        } catch {
            refuse(error)
        }
    }

    /// Whether the package already committed for this pad was sealed to THIS
    /// receive request, asked of the engine — which compares the durable marker's
    /// `requestHash` by exactly the comparison `sptSeal` is about to make.
    ///
    /// Matters because the wording differs: a first seal sends the whole pad and
    /// can happen only once, while coming back to the SAME request hands over the
    /// SAME committed package and encapsulates nothing. Telling an operator
    /// mid-re-share that "this pad can only leave once" implies a second send is
    /// about to happen, which is precisely what cannot occur.
    ///
    /// THIS USED TO ASK A DIFFERENT QUESTION FROM THE ONE IT ANSWERED. It read
    /// the pad-level handoff state, whose type carries only a timestamp and
    /// cannot carry request identity at all, and on that answer the screen
    /// asserted "This pad was already sealed to this request" — about every
    /// request, including a different one the engine was going to refuse.
    public var isReshare: Bool {
        guard let review else { return false }
        return engine.sptSealedToRequest(pairId: pairId, requestHashHex: review.requestHashHex)
    }

    /// Sealed already, but to a DIFFERENT receive request — so `sptSeal` will
    /// refuse this one.
    ///
    /// NAMED RATHER THAN LEFT TO THE FALLBACK. Without it this case fell into the
    /// first-seal branch, which promises "A sealed transfer sends the WHOLE pad"
    /// to an operator whose next tap can only produce a refusal, after they have
    /// already compared twelve words with the other person.
    public var isSealedToAnotherRequest: Bool {
        guard review != nil, !isReshare else { return false }
        // THE SAME PARSER `isReshare` USES, and the one `sptSeal` obeys. This
        // asked `Engine.handoffState` — TruePadStorage's reader — so one screen
        // was drawing a conclusion from two different parses of one file.
        return engine.sptHasSealedHandoff(pairId: pairId)
    }

    public func confirm() {
        guard let review else { return }
        // Belt and braces with the disabled button: an operator must not be able
        // to declare a match for a phrase this device could not display.
        guard requestWordsComplete else {
            refusalMessage = "TruePad cannot display the twelve comparison words on this device, "
                + "so it will not record that you compared them."
            showingRefusal = true
            return
        }
        do {
            // A DECLARATION that the operator said the words matched. It is not
            // evidence that they compared anything, and nothing downstream treats
            // it as such.
            _ = try engine.sptConfirmRequest(canonicalBody: review.canonicalBody)
            confirmed = true
        } catch {
            refuse(error)
        }
    }

    public func seal() {
        guard let review else { return }
        do {
            let result = try engine.sptSeal(requestHashHex: review.requestHashHex, pairId: pairId)
            sealed = result
            confirmationWords = CeremonyWords.render(result.confirmationIndices) ?? []
        } catch {
            refuse(error)
        }
    }

    /// Same contract as `PadDetailModel.discardSharedFile()`: a sealed package is
    /// pad material under a computational wrapper, and cancelling the share sheet
    /// must not leave it on disk.
    ///
    /// Reads `scratchToRemove`, NOT `fileToShare` — SwiftUI has already cleared
    /// the item binding by the time `onDismiss` runs.
    public func discardSharedFile() {
        scratch.discard()
        fileToShare = nil
    }

    public func share() {
        guard let sealed else { return }
        do {
            // FILE ONLY. A sealed package is pad material under a computational
            // wrapper; it never reaches the clipboard and is never a QR.
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(EgressPolicy.fileName(for: .fileOnly, sealed: true))
            try Data(sealed.packageBytes).write(to: url,
                                                options: [.atomic, .completeFileProtection])
            scratch.track(url)
            fileToShare = ShareableFile(url: url)
        } catch {
            refuse(error)
        }
    }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}

// MARK: - the recipient opens what arrived

/// Refusal text for the few failures that are not engine refusals.
public enum SptRefusalText {
    public static let unreadableFile =
        "That file could not be read. Nothing was used, and the receive request is "
        + "untouched — choose the file again."
}

@MainActor
public final class OpenSealedModel: ObservableObject {
    @Published public var choosingFile = false
    @Published public private(set) var session: SptOpenResult?
    @Published public private(set) var confirmationWords: [String] = []
    @Published public private(set) var saved = false
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    public var confirmationWordsComplete: Bool {
        CeremonyPhrase.isComplete(confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)
    }

    let engine: Engine
    var label: String

    public init(engine: Engine, label: String = "received pad") {
        self.engine = engine
        self.label = label
    }

    /// Open the package into a TRANSIENT session. Nothing durable happens here,
    /// and nothing is consumed — the operator can still walk away.
    /// Refuse with a plain message, for failures that never reached the engine.
    public func refuse(_ message: String) {
        refusalMessage = message
        showingRefusal = true
    }

    public func open(packageBytes: [UInt8]) {
        do {
            let result = try engine.sptOpen(packageBytes: packageBytes)
            session = result
            confirmationWords = CeremonyWords.render(result.confirmationIndices) ?? []
        } catch {
            refuse(error)
        }
    }

    public func commit() {
        guard let session else { return }
        guard confirmationWordsComplete else {
            refusalMessage = "TruePad cannot display the eight confirmation words on this device, "
                + "so it will not save a pad on the strength of a comparison you could not make. "
                + "Rejecting this transfer is still available."
            showingRefusal = true
            return
        }
        do {
            _ = try engine.sptCommitReceive(session: session, label: label)
            saved = true
            self.session = nil
            confirmationWords = []
        } catch {
            refuse(error)
        }
    }

    /// The words did NOT match. Cancel the request permanently and save nothing.
    public func reject() {
        guard let session else { return }
        do {
            _ = try engine.sptRejectReceiveRequest(requestIdHex: session.requestIdHex)
            self.session = nil
            confirmationWords = []
        } catch {
            refuse(error)
        }
    }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}
#endif
