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
    @Published public var source: Source = .file
    @Published public var encryptionBytes = 4096
    @Published public var authRecords = 64
    @Published public var chosenFileName: String?
    @Published public var chosenFileBytes: [UInt8]?
    @Published public var choosingFile = false
    @Published public private(set) var created = false
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine

    public init(engine: Engine) { self.engine = engine }

    public var requiredSourceBytes: Int {
        (try? Partition.requiredSourceLength(capacity: encryptionBytes,
                                             capacityRecords: authRecords)) ?? 0
    }

    public var canCreate: Bool {
        guard !label.isEmpty else { return false }
        switch source {
        case .device: return true
        case .file: return (chosenFileBytes?.count ?? 0) >= requiredSourceBytes
        }
    }

    public func create() {
        do {
            let sources: [SourceInput]
            switch source {
            case .file:
                guard let bytes = chosenFileBytes else { return }
                sources = [SourceInput(name: chosenFileName ?? "source.bin",
                                       declaredOrigin: "declared by operator at gen; "
                                           + "not verified by this tool",
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
            _ = try engine.gen(label: label, sources: sources,
                               encryptionBytes: encryptionBytes, authRecords: authRecords)
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
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine

    public init(engine: Engine) { self.engine = engine }

    public func create() {
        do {
            let result = try engine.sptCreateReceiveRequest()
            request = result
            requestWords = CeremonyWords.render(result.requestIndices) ?? []
            // Re-validated before it can be drawn. A request that will not
            // round-trip is not shown as a code at all.
            if case .success(let payload) = QrPayloadBuilder.receiveRequest(result.tpr2Text) {
                qr = payload
            } else {
                qr = nil
            }
        } catch {
            refuse(error)
        }
    }

    public func cancel() {
        guard let request else { return }
        do {
            _ = try engine.sptCancelReceiveRequest(requestIdHex: request.requestIdHex)
            self.request = nil
            qr = nil
            requestWords = []
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
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

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

    public func confirm() {
        guard let review else { return }
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

    public func share() {
        guard let sealed else { return }
        do {
            // FILE ONLY. A sealed package is pad material under a computational
            // wrapper; it never reaches the clipboard and is never a QR.
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(EgressPolicy.fileName(for: .fileOnly, sealed: true))
            try Data(sealed.packageBytes).write(to: url,
                                                options: [.atomic, .completeFileProtection])
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

@MainActor
public final class OpenSealedModel: ObservableObject {
    @Published public var choosingFile = false
    @Published public private(set) var session: SptOpenResult?
    @Published public private(set) var confirmationWords: [String] = []
    @Published public private(set) var saved = false
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    var label: String

    public init(engine: Engine, label: String = "received pad") {
        self.engine = engine
        self.label = label
    }

    /// Open the package into a TRANSIENT session. Nothing durable happens here,
    /// and nothing is consumed — the operator can still walk away.
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
