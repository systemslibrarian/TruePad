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
        public let state: PadRowState
        public var destroyed: Bool { state == .destroyed }
        public var id: String { pairId }
    }

    @Published public private(set) var rows: [Row] = []
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?
    @Published public var creating = false
    /// The navigation path, held here so the post-creation prompt can push the
    /// pad it is talking about.
    @Published public var path: [String] = []
    /// The pad just created, so the list can offer the obvious next step on it.
    /// Nil once the operator has acted on the prompt or put it away.
    @Published public private(set) var justCreated: String?

    public func noteCreated(_ pairId: String) { justCreated = pairId }
    public func dismissCreated() { justCreated = nil }

    /// Open the pad the prompt is about. Clears the prompt: it has been acted on.
    ///
    /// RE-CHECKED AT THE MOMENT OF ACTION, not only when the list last reloaded.
    /// This wrote the remembered id straight into the navigation path, which is
    /// the one route into a pad that bypasses the `.disabled(row.destroyed)`
    /// guard the list puts on its own rows.
    public func openJustCreated() {
        guard let id = justCreated, stillOfferable(id) else { justCreated = nil; return }
        justCreated = nil
        path = [id]
    }

    /// Whether the post-creation prompt still has anything true to offer: the pad
    /// exists, is not destroyed, and has not already been handed over.
    ///
    /// Nothing is remembered from creation time. The handoff half is asked of the
    /// engine here and now; the destroyed half reads `rows`, which `reload()` has
    /// just built from `listSummaries()` — so it is as fresh as the list the
    /// operator is looking at, and not fresher. That is the right scope for a
    /// prompt rendered from that same list, and it is stated rather than implied.
    private func stillOfferable(_ pairId: String) -> Bool {
        guard let row = rows.first(where: { $0.pairId == pairId }), !row.destroyed else { return false }
        switch engine.handoffState(pairId: pairId) {
        case .absent:
            return true
        case .physical, .sealed, .unreadableSpent:
            return false
        }
    }

    private let engine: Engine

    public init(engine: Engine) { self.engine = engine }

    public func reload() {
        do {
            rows = try engine.listSummaries().map { entry in
                guard !entry.destroyed, let summary = entry.summary else {
                    return Row(pairId: entry.pairId, label: entry.label, state: .destroyed)
                }
                let sends = summary.meters.values.map { $0.maxRemainingSends }.min() ?? 0
                // A direction that cannot send is the one thing on this screen
                // that genuinely needs the operator's attention.
                let frozen = summary.meters.values.contains { $0.frozen }
                // A WITNESS THAT DOES NOT AGREE IS THE ROLLBACK SIGNAL. Removing
                // the deployment verdict from the row also removed the only hint
                // this state ever had here, so it is surfaced directly rather
                // than left to a screen the operator has to open.
                let rollback = summary.meters.values.contains { $0.witnessState == .regressed }
                // NO VERDICT HERE. The deployment classification is a property of
                // the pad, not its status, and putting it in every row made every
                // device-generated pad look broken at a glance. It is on the pad's
                // own screen, under Security details, unchanged.
                return Row(pairId: entry.pairId, label: entry.label,
                           state: .of(destroyed: false, rollbackSuspected: rollback,
                                      frozen: frozen, remainingSends: sends))
            }
            // THE PROMPT IS ABOUT A PAD, AND IT MUST NOT OUTLIVE THAT PAD.
            // `justCreated` was a remembered id cleared only by the two buttons on
            // the prompt itself, so destroying the pad left "Pad created — Share
            // this pad" sitting directly above the row the list had just correctly
            // disabled as destroyed. Handing the pad over left it there too,
            // offering a second handoff for a pad that had already had its one.
            if let id = justCreated, !stillOfferable(id) { justCreated = nil }
        } catch {
            // A LIST THAT COULD NOT BE READ CANNOT VOUCH FOR THE PROMPT EITHER.
            justCreated = nil
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
    /// FAIL-CLOSED. This was `true`, the only fail-open flag of the three, and
    /// `reload()`'s one throwing statement — `engine.status` — sits BEFORE every
    /// assignment to it. A pad whose handoff state was never successfully read
    /// therefore offered both handoff routes under the caption "A pad can be
    /// given only once", which is an affirmative offer made from no evidence.
    /// Unknown is not permission.
    @Published public private(set) var mayHandOff = false
    /// Whether the ALREADY-COMMITTED sealed package may be offered again. Distinct
    /// from `mayHandOff`, which governs whether the RAW pad may leave as a file —
    /// see `HandoffPolicy` for why collapsing the two stranded pads.
    @Published public private(set) var mayReshareSealed = false
    @Published public private(set) var handOffRefusal: String?
    @Published public var fileToShare: ShareableFile?
    /// Drives the sealed-transfer ceremony sheet.
    @Published public var sealing = false
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
            let imported = summary.origin == .imported
            // ONE ROLE PER PAIR, derived from how this pad was ACQUIRED — which
            // does not depend on whether it has since been handed over. This was
            // assigned inside the `.absent` branch only, so a pad that had been
            // sealed or handed over physically reported no role at all. That was
            // harmless while nothing read it; it stopped being harmless when the
            // direction labels started asking which half this device owns, and a
            // handed-over pad would have fallen back to "A to B".
            //
            // See `PartyRole` for what defaulting instead of deriving cost.
            derivedRole = PartyRole.derive(from: summary.origin)
            switch engine.handoffState(pairId: pairId) {
            case .absent:
                mayHandOff = HandoffPolicy.mayExportRawPad(handedOver: false, imported: imported)
                mayReshareSealed = false
                handOffRefusal = imported
                    ? "This pad arrived from someone else, so TruePad will not pass it on. Two "
                      + "people holding the same pad would each use the same material."
                    : nil
            case .physical(let at):
                mayHandOff = false
                mayReshareSealed = false
                handOffRefusal = "This pad was already handed over on \(at)."
            case .sealed:
                mayHandOff = false
                // THE COMMITTED PACKAGE STAYS REACHABLE. Sealing writes the
                // package to disk; hiding this button was what stranded a pad
                // whose operator dismissed the sheet before saving the file.
                mayReshareSealed = HandoffPolicy.mayResharedSealedPackage(sealed: true, imported: imported)
                handOffRefusal = "This pad was already sent by sealed transfer."
            case .unreadableSpent(let message):
                mayHandOff = false
                mayReshareSealed = false
                handOffRefusal = message
            }
        } catch {
            // FAIL CLOSED ON THE WAY OUT TOO. `catch` used to reset nothing, so a
            // reload that threw after an earlier successful one left all three
            // handoff flags describing a state that had just stopped being
            // readable — including, for a destroyed pad, an offer to hand it over.
            // The refusal alert is shown over the screen; the screen underneath
            // must not still be advertising the act the refusal just blocked.
            mayHandOff = false
            mayReshareSealed = false
            handOffRefusal = Self.handoffStateUnknown
            refuse(error)
        }
    }

    /// WHAT IS SAID WHEN THE STATE COULD NOT BE READ. Not "already handed over" —
    /// that is a claim about a fact TruePad does not have. It says only what it
    /// knows and what it will therefore not do.
    static let handoffStateUnknown =
        "TruePad could not read this pad's handoff state, so it will not offer to hand it over. "
        + "Nothing about the pad has been changed."

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

    /// Presents the sealed-transfer ceremony.
    ///
    /// This used to be an EMPTY FUNCTION BODY wired to the "Send it by sealed
    /// transfer…" button, so the button did nothing and `SealView` — complete and
    /// tested — was never presented by anything. The receiver half was unreachable
    /// too. Found by the two-device physical ceremony, which could not proceed
    /// past the Android seal because the iPhone had no way to open the package.
    public func beginSealedTransfer() { sealing = true }

    public func sealModel() -> SealModel { SealModel(engine: engine, pairId: pairId) }

    public func sendModel() -> SendModel { SendModel(engine: engine, pairId: pairId) }
    public func openModel() -> OpenModel { OpenModel(engine: engine, pairId: pairId) }
    public func destroyModel() -> DestroyModel { DestroyModel(engine: engine, pairId: pairId) }

    func refuse(_ error: Error) {
        refusalMessage = operatorMessage(for: error)
        showingRefusal = true
    }
}

@MainActor
public final class SendModel: ObservableObject {
    @Published public var plaintext = ""
    /// NOT a default, and NOT settable from outside. nil means the pad could not
    /// say which half is ours, and nothing may be burned on it.
    ///
    /// This was `public var`, publicly writable from any module that imports
    /// TruePadUI, and its comment said the operator chooses. The picker that let
    /// them is gone — a pick is a guess, and a guess spends the other person's
    /// material — so the mutable surface goes with it. There is exactly one
    /// writer: the initialiser, from the pad's own origin. See `PartyRole`.
    @Published public private(set) var role: Party?
    /// True when the pad itself supplied the role, so the picker is shown only
    /// when there is a real question to answer.
    public let roleWasDerived: Bool
    @Published public private(set) var envelopeText: String?
    @Published public private(set) var qr: QrPayload?
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    /// DERIVES ITS OWN ROLE from the pad, rather than being handed one.
    ///
    /// It used to take the role from `PadDetailModel.derivedRole`, which is set by
    /// `reload()` on appear — but `NavigationLink { SendView(model: sendModel()) }`
    /// builds its destination EAGERLY, so this ran before the parent had loaded
    /// anything and every pad looked unknown-origin. The physical ceremony caught
    /// it: a pad imported by sealed transfer, whose origin really is `imported`,
    /// still asked the operator which half was theirs.
    ///
    /// Reading the pad here makes the answer independent of view evaluation order.
    public init(engine: Engine, pairId: String, role: Party? = nil) {
        self.engine = engine
        self.pairId = pairId
        let resolved = role ?? PartyRoleResolver.resolve(engine: engine, pairId: pairId)
        self.role = resolved
        self.roleWasDerived = resolved != nil
    }

    /// The compact `TP2:` spelling of the message just written — the form the
    /// operator is shown, copies and shares. Nil only if it failed to round-trip,
    /// in which case the canonical JSON is still displayed and still works.
    @Published public private(set) var compact: PublicTransport?

    /// The canonical JSON spelling, VALIDATED ONCE and then published — the same
    /// rule `compact` and `qr` already followed.
    ///
    /// The Technical form disclosure used to call `PublicTransport.canonicalJson`
    /// from inside the view body. `Details` builds its content eagerly, so that
    /// ran on EVERY body evaluation whether the disclosure was open or not, and
    /// `$model.plaintext` is bound to the compose field — so it ran on every
    /// keystroke. Each run is a strict JSON decode, a scan that materialises the
    /// whole envelope as unicode scalars, a full hex decode of the ciphertext, a
    /// re-encode and a whole-string comparison, on the main thread. After one send
    /// near the engine ceiling that is roughly two megabytes of work per character
    /// typed, and the screen stops keeping up. Nothing about the validation
    /// changes: it is the same call, run once, at the same place the other two
    /// spellings are made.
    @Published public private(set) var canonicalJson: PublicTransport?

    /// Sending needs BOTH a message and a known role. A pad whose origin cannot be
    /// determined is not sendable at all — TruePad refuses rather than asking,
    /// because a role the operator picked would be a guess, and a guess spends the
    /// other person's material. See `PartyRole`.
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

            // THE COMPACT SPELLING IS THE ONE THE OPERATOR IS GIVEN.
            //
            // It was already computed here and then thrown away after feeding the
            // QR, while the screen showed the canonical JSON — so the iPhone
            // handed people several hundred characters of JSON where the Browser
            // and the wire both prefer `TP2:`. Both spellings decode to the SAME
            // envelope through the same validated path; this changes which one is
            // put in front of a human, and nothing about what is authenticated.
            //
            // RE-VALIDATED, not merely re-spelled: `PublicTransport.envelope`
            // decodes and re-encodes and requires the result to be identical, so
            // what is displayed, copied, shared and drawn as a QR is the same
            // canonical string, and a view cannot substitute its own.
            if case .ok(let e) = EnvelopeCodec.decode(result.envelope),
               let encoded = try? CompactEnvelope.encode(e),
               case .success(let material) = PublicTransport.envelope(encoded) {
                compact = material
                // A QR additionally has a size ceiling. A message too long to be
                // drawn is still perfectly copyable, so the two are decided
                // separately.
                if case .success(let payload) = QrPayloadBuilder.envelope(material.text) {
                    qr = payload
                } else {
                    qr = nil
                }
            } else {
                // A compact spelling that does not round-trip is not offered at
                // all. The canonical JSON remains, and remains sendable.
                compact = nil
                qr = nil
            }
            // RE-VALIDATED ONCE, then used for every egress — the rule the two
            // spellings above already follow, and the one the Technical form's
            // copy control used to break by validating inside the view body.
            if case .success(let json) = PublicTransport.canonicalJson(result.envelope) {
                canonicalJson = json
            } else {
                canonicalJson = nil
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
    /// Derived, never chosen — the same rule and the same single writer as
    /// `SendModel.role`. Opening at a guessed role is what MASKED the cross-copy
    /// reuse: the importing device opened correctly at its default, so nothing
    /// looked wrong until it sent.
    @Published public private(set) var role: Party?
    public let roleWasDerived: Bool
    @Published public private(set) var plaintext: String?
    @Published public private(set) var skippedNote: String?
    @Published public var showingRefusal = false
    @Published public var refusalMessage: String?

    let engine: Engine
    let pairId: String

    /// Same as `SendModel`: derives its own role so the answer does not depend on
    /// when the parent view happened to reload.
    public init(engine: Engine, pairId: String, role: Party? = nil) {
        self.engine = engine
        self.pairId = pairId
        let resolved = role ?? PartyRoleResolver.resolve(engine: engine, pairId: pairId)
        self.role = resolved
        self.roleWasDerived = resolved != nil
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
