#if os(iOS)
import Combine
import Foundation
import SwiftUI
import TruePadClaims
import TruePadCore
import TruePadStorage

/* ============================================================================
 * The view models.
 *
 * These hold UI state and call the engine. They deliberately hold NO security
 * logic of their own — what may be shown, copied, or rendered as a QR is decided
 * in Presentation.swift, which is tested — so a model can be wrong about a
 * spinner but not about whether pad material reaches the clipboard.
 *
 * REFUSALS ARE SHOWN, NOT SWALLOWED. Every engine refusal carries a reason and a
 * sentence written for an operator; these models surface that sentence verbatim
 * rather than replacing it with "something went wrong". A refusal the operator
 * cannot read is a refusal they will work around.
 * ========================================================================= */

/// Turn any engine error into the sentence the operator should read.
///
/// A typed refusal already says what happened and what was NOT touched. Anything
/// else is an error rather than a refusal, and is reported as one — never dressed
/// up as a refusal the operator could retry.
public func operatorMessage(for error: Error) -> String {
    if let refused = error as? EngineRefused { return refused.message }
    if let engineError = error as? EngineError {
        switch engineError {
        case .recordFrameInvalid(let message): return message
        }
    }
    // Deliberately not `\(error)` for an unknown case: a raw error can carry a
    // path or an internal detail that is not the operator's business.
    return "TruePad could not complete that, and stopped rather than guess. Nothing was changed "
        + "by the part that failed."
}

@MainActor
public final class PadListModel: ObservableObject {
    public struct Row: Identifiable, Equatable {
        public let pairId: String
        public let label: String
        public let destroyed: Bool
        public let shortSummary: String?
        public let accessibilityLabel: String
        public var id: String { pairId }
    }

    @Published public private(set) var rows: [Row] = []
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?
    @Published public var creating = false

    private let engine: Engine

    public init(engine: Engine) { self.engine = engine }

    public func reload() {
        do {
            rows = try engine.listSummaries().map { entry in
                guard !entry.destroyed, let summary = entry.summary else {
                    return Row(pairId: entry.pairId, label: entry.label, destroyed: true,
                               shortSummary: nil,
                               accessibilityLabel: "\(entry.label). Destroyed, and permanently "
                                                   + "unusable.")
                }
                let sends = summary.meters.values.map { $0.maxRemainingSends }.min() ?? 0
                let verdict = summary.meters[.aToB].map { MeterRow($0).verdict } ?? ""
                return Row(pairId: entry.pairId, label: entry.label, destroyed: false,
                           shortSummary: "\(sends) more \(sends == 1 ? "message" : "messages") · \(verdict)",
                           accessibilityLabel: "\(entry.label). You can send \(sends) more "
                                               + "\(sends == 1 ? "message" : "messages"). "
                                               + "Deployment assessment: \(verdict).")
            }
        } catch {
            refuse(error)
        }
    }

    public func startCreating() { creating = true }

    public func detail(for pairId: String) -> PadDetailModel {
        PadDetailModel(engine: engine, pairId: pairId)
    }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}

/// A file the operator is about to hand to something else.
///
/// It exists on disk only for as long as the share sheet needs it: the presenting
/// view removes it on dismiss, and the app sweeps for a leftover at launch in
/// case the process died while the sheet was up. Removal is UNLINKING, not
/// erasure — see `VerbatimText.destructionLimitation`, which applies to this file
/// exactly as it applies to a pad.
public struct ShareableFile: Identifiable, Equatable {
    public let url: URL
    public var id: URL { url }
}

@MainActor
public final class PadDetailModel: ObservableObject {
    @Published public private(set) var label: String = ""
    @Published public private(set) var meters: [MeterRow] = []
    /// Which half of the pair this device owns, derived — nil when the pad's
    /// origin is unknown, in which case the operator is asked rather than guessed
    /// at.
    @Published public private(set) var derivedRole: Party?
    @Published public private(set) var mayHandOff = true
    @Published public private(set) var handOffRefusal: String?
    @Published public var fileToShare: ShareableFile?
    /// Holds the scratch file's lifetime OUTSIDE the presentation binding, because
    /// SwiftUI clears an `item:` binding before calling `onDismiss`. The rule and
    /// its tests live in `HandoffScratchFile`, which CI can actually reach.
    private let scratch = HandoffScratchFile()

    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    public init(engine: Engine, pairId: String) {
        self.engine = engine
        self.pairId = pairId
    }

    public func reload() {
        do {
            let summary = try engine.status(pairId)
            label = summary.label
            meters = [PadDirection.aToB, .bToA].compactMap { summary.meters[$0] }.map(MeterRow.init)
            // Whether this pad may still leave is the ENGINE's answer, asked
            // without mutating anything: a pad that already left must not be
            // offered a button that will only refuse.
            switch engine.handoffState(pairId: pairId) {
            case .absent:
                // ONE ROLE PER PAIR, derived from how this pad was acquired.
                // See `PartyRole` for what defaulting instead cost.
                derivedRole = PartyRole.derive(from: summary.origin)
                mayHandOff = summary.origin != .imported
                handOffRefusal = summary.origin == .imported
                    ? "This pad arrived from someone else, so TruePad will not pass it on. Two "
                      + "people holding the same pad would each use the same material."
                    : nil
            case .physical(let at):
                mayHandOff = false
                handOffRefusal = "This pad was already handed over on \(at)."
            case .sealed:
                mayHandOff = false
                handOffRefusal = "This pad was already sent by sealed transfer."
            case .unreadableSpent(let message):
                mayHandOff = false
                handOffRefusal = message
            }
        } catch {
            refuse(error)
        }
    }

    public func exportPad() {
        do {
            let result = try engine.exportPair(pairId: pairId)
            // The bundle is a FILE and only a file: never the clipboard, never a
            // QR. The policy is asserted here rather than assumed by the view.
            guard EgressPolicy.mayShareAsFile(.fileOnly) else { return }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(EgressPolicy.fileName(for: .fileOnly, sealed: false))
            try Data(result.container).write(to: url, options: [.atomic, .completeFileProtection])
            scratch.track(url)
            fileToShare = ShareableFile(url: url)
            reload()
        } catch {
            refuse(error)
        }
    }

    /// Called when the share sheet goes away, however it goes away — handed off,
    /// cancelled, or swiped down. The file is written BEFORE the sheet appears,
    /// so cancelling still leaves a complete copy of the pad on disk unless this
    /// runs.
    ///
    /// Reads `scratchToRemove`, NOT `fileToShare`: by the time SwiftUI calls
    /// `onDismiss` the item binding is already nil. See the field's comment.
    public func discardSharedFile() {
        scratch.discard()
        fileToShare = nil
    }

    public func beginSealedTransfer() { /* presented by the ceremony flow */ }

    public func sendModel() -> SendModel {
        SendModel(engine: engine, pairId: pairId, role: derivedRole)
    }
    public func openModel() -> OpenModel {
        OpenModel(engine: engine, pairId: pairId, role: derivedRole)
    }
    public func destroyModel() -> DestroyModel { DestroyModel(engine: engine, pairId: pairId) }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}

@MainActor
public final class SendModel: ObservableObject {
    @Published public var plaintext = ""
    /// NOT a default. nil means the pad could not say which half is ours, and
    /// the operator must choose before anything is burned.
    @Published public var role: Party?
    /// True when the pad itself supplied the role, so the picker is shown only
    /// when there is a real question to answer.
    public let roleWasDerived: Bool
    @Published public private(set) var envelopeText: String?
    @Published public private(set) var qr: QrPayload?
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    public init(engine: Engine, pairId: String, role: Party?) {
        self.engine = engine
        self.pairId = pairId
        self.role = role
        self.roleWasDerived = role != nil
    }

    /// Sending needs BOTH a message and a known role. A pad whose origin is
    /// unknown cannot be sent on until the operator says which half is theirs.
    public var canSend: Bool { !plaintext.isEmpty && role != nil }

    public func send() {
        // FAIL CLOSED ON AN UNKNOWN ROLE. Burning on a guess is how two devices
        // spend the same one-time material; refusing is only loss.
        guard let role else {
            refusalMessage = PartyRole.unknownOriginPrompt
            showingRefusal = true
            return
        }
        do {
            let result = try engine.burn(pairId: pairId, role: role,
                                         plaintext: Array(plaintext.utf8))
            envelopeText = result.envelope
            // An envelope is PUBLIC, so it may be shown as a QR — but only after
            // the builder has re-validated it. If the compact spelling is too
            // large for a QR, the message is still sendable as text; it simply
            // is not offered as a code.
            if case .ok(let e) = EnvelopeCodec.decode(result.envelope),
               let compact = try? CompactEnvelope.encode(e),
               case .success(let payload) = QrPayloadBuilder.envelope(compact) {
                qr = payload
            } else {
                qr = nil
            }
            plaintext = ""
        } catch {
            refusalMessage = operatorMessage(for: error)
            showingRefusal = true
        }
    }
}

@MainActor
public final class OpenModel: ObservableObject {
    @Published public var envelopeText = ""
    @Published public var role: Party?
    public let roleWasDerived: Bool
    @Published public private(set) var plaintext: String?
    @Published public private(set) var skippedNote: String?
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    public init(engine: Engine, pairId: String, role: Party?) {
        self.engine = engine
        self.pairId = pairId
        self.role = role
        self.roleWasDerived = role != nil
    }

    public var canOpen: Bool { !envelopeText.isEmpty && role != nil }

    public func open() {
        guard let role else {
            refusalMessage = PartyRole.unknownOriginPrompt
            showingRefusal = true
            return
        }
        do {
            // Either spelling, one door: the engine takes canonical JSON or the
            // TP2 compact form, and refuses a malformed compact input AS compact.
            let result = try engine.open(pairId: pairId, role: role, envelopeText: envelopeText)
            plaintext = String(decoding: result.plaintext, as: UTF8.self)
            skippedNote = result.skippedRecords > 0
                ? "\(result.skippedRecords) earlier \(result.skippedRecords == 1 ? "record was" : "records were") "
                  + "skipped and their pad material is destroyed unused."
                : nil
            envelopeText = ""
        } catch {
            plaintext = nil
            refusalMessage = operatorMessage(for: error)
            showingRefusal = true
        }
    }
}

@MainActor
public final class DestroyModel: ObservableObject {
    @Published public var typed = ""
    @Published public private(set) var pairIsUnreadable = false
    @Published public private(set) var destroyed = false
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    public init(engine: Engine, pairId: String) {
        self.engine = engine
        self.pairId = pairId
        // A pad too corrupt to name needs the literal token instead, and the
        // prompt has to say so. Asking the engine costs nothing and mutates
        // nothing.
        pairIsUnreadable = (try? engine.status(pairId)) == nil
    }

    public func destroy() {
        do {
            _ = try engine.destroy(pairId: pairId, confirm: typed)
            destroyed = true
        } catch {
            refusalMessage = operatorMessage(for: error)
            showingRefusal = true
        }
        typed = ""
    }
}
#endif
