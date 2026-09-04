import Foundation
import TruePadClaims
import TruePadCore
import TruePadStorage

/* ============================================================================
 * THE PRESENTATION LAYER'S SECURITY-CARRYING DECISIONS.
 *
 * SwiftUI views are hard to test and impossible to test on CI without a device,
 * so everything in the UI that can be WRONG IN A WAY THAT MATTERS lives here
 * instead, in plain Swift with no SwiftUI import, and is tested.
 *
 * What "matters" means, concretely — the four things a view could get wrong that
 * would not be a cosmetic bug:
 *
 *   1. Putting the wrong bytes in a QR code. A QR carries a PUBLIC receive
 *      request or a PUBLIC envelope. Never pad material, never a .tps2, never a
 *      private key, never plaintext, never internal state.
 *   2. Showing a verdict that was stored rather than derived, so it outlives the
 *      facts that produced it.
 *   3. Softening a limitation the operator is entitled to read verbatim.
 *   4. Echoing a destroy confirmation the operator is supposed to already know.
 *
 * The views are then thin enough that what remains untested by CI is layout and
 * VoiceOver behaviour, which is exactly what the physical-device gate is for and
 * is NOT claimed here.
 * ========================================================================= */

// MARK: - what may go in a QR code

/// The ONLY two things TruePad ever renders as a QR code.
///
/// Both are PUBLIC by construction: a receive request is a one-time public
/// encapsulation key, and an envelope is ciphertext plus a tag whose
/// confidentiality rests on the pad, not on the carrier.
public enum QrPayload: Sendable, Equatable {
    /// A canonical `TPR2:` receive request, exactly as the codec emits it.
    case receiveRequest(String)
    /// A canonical `TP2:` compact envelope, exactly as the codec emits it.
    case envelope(String)

    public var text: String {
        switch self {
        case .receiveRequest(let t), .envelope(let t): return t
        }
    }
}

public enum QrRefusal: String, Error, Sendable, Equatable {
    case notAKnownPayload
    case notCanonical
    case tooLong
}

public enum QrPayloadBuilder {
    /// The largest QR a phone camera reliably reads at arm's length. A payload
    /// past this is refused rather than split: TruePad has NO multi-frame or
    /// animated QR, because a pad that arrives in pieces is a pad whose pieces
    /// can be mixed.
    public static let maxQrCharacters = 2953

    /// Build a QR payload from a receive-request text, RE-VALIDATING it.
    ///
    /// The text is decoded and re-encoded and must come back identical. A view
    /// cannot hand this a string it assembled itself, or a truncated one, and
    /// have it rendered.
    public static func receiveRequest(_ text: String) -> Result<QrPayload, QrRefusal> {
        guard text.hasPrefix(SptConstantsBridge.tpr2Prefix) else { return .failure(.notAKnownPayload) }
        guard text.count <= maxQrCharacters else { return .failure(.tooLong) }
        guard SptConstantsBridge.isCanonicalReceiveRequest(text) else { return .failure(.notCanonical) }
        return .success(.receiveRequest(text))
    }

    /// Build a QR payload from a compact envelope, RE-VALIDATING it the same way.
    public static func envelope(_ text: String) -> Result<QrPayload, QrRefusal> {
        guard text.hasPrefix(CompactEnvelope.prefix) else { return .failure(.notAKnownPayload) }
        guard text.count <= maxQrCharacters else { return .failure(.tooLong) }
        guard case .ok(let decoded) = CompactEnvelope.decode(text),
              (try? CompactEnvelope.encode(decoded)) == text else {
            return .failure(.notCanonical)
        }
        return .success(.envelope(text))
    }

    /// Anything that is not one of the two known public payloads.
    ///
    /// This is the function the view calls when it is about to render an
    /// arbitrary string, and it exists so that "can this be a QR?" has ONE
    /// answer in ONE place rather than a prefix check scattered across screens.
    public static func from(_ text: String) -> Result<QrPayload, QrRefusal> {
        if text.hasPrefix(SptConstantsBridge.tpr2Prefix) { return receiveRequest(text) }
        if text.hasPrefix(CompactEnvelope.prefix) { return envelope(text) }
        return .failure(.notAKnownPayload)
    }
}

/// A tiny seam so this module does not import TruePadSPT just to know a prefix
/// and re-parse a request. The UI has no business reaching the KEM.
public enum SptConstantsBridge {
    public static let tpr2Prefix = "TPR2:"

    /// Set once at launch by the composition root, which DOES link the SPT layer.
    /// Left nil in tests that do not need it, and then a receive-request QR is
    /// refused rather than rendered unvalidated.
    nonisolated(unsafe) public static var isCanonicalReceiveRequest: (String) -> Bool = { _ in false }
}

// MARK: - the verdict is DERIVED, and its words are not softened

/// One direction's live meters, flattened for display. Built from a
/// `DirectionMeters` the engine just computed — never from anything persisted.
public struct MeterRow: Sendable, Equatable {
    public let direction: String
    public let encryptionUsed: Int
    public let encryptionCapacity: Int
    public let recordsUsed: Int
    public let recordsCapacity: Int
    public let maxRemainingSends: Int
    public let limitedBy: String
    public let frozen: Bool
    public let witness: String
    public let verdict: String
    public let whyNotStronger: String?

    public init(_ m: DirectionMeters) {
        direction = m.direction.rawValue
        encryptionUsed = m.nextOffset
        encryptionCapacity = m.capacity
        recordsUsed = m.nextSequence
        recordsCapacity = m.capacityRecords
        maxRemainingSends = m.maxRemainingSends
        limitedBy = m.limitedBy
        frozen = m.frozen
        witness = m.witnessState.rawValue
        // DERIVED, every time this row is built. There is no cached verdict and
        // nothing here reads one from disk.
        verdict = assessmentLabel[m.deployment.assessment] ?? "INSUFFICIENT EVIDENCE"
        whyNotStronger = m.deployment.knownReason
    }
}

/// The sentences the operator is entitled to read UNALTERED.
///
/// A UI that paraphrases these is a UI that has quietly made a different claim.
/// They are asserted verbatim by test against the engine's own constants.
public enum VerbatimText {
    /// The §17 destruction limitation.
    public static var destructionLimitation: String { destroyLimitation }

    /// The §7 source verdict — scoped, never promoted.
    public static var sourceVerdict: String { genVerdict }

    /// What a QR code is, and is not. Shown next to every QR TruePad renders.
    public static let qrCarriesOnlyPublicData =
        "This code carries only public data — a one-time request key, or an already-encrypted "
        + "message. It never contains pad material, and photographing it does not reveal anything "
        + "the pad protects."

    /// The share sheet is a CARRIER. TruePad has no transport of its own.
    public static let shareSheetIsACarrier =
        "TruePad hands this file to whatever you choose — AirDrop, Files, a messaging app. It has "
        + "no server, no account, and no transport of its own, and it cannot tell you what happens "
        + "to the file afterwards."

    /// What comparing the words does and does not establish.
    public static let wordComparisonIsADeclaration =
        "Reading these words aloud over a channel you already trust is what ties this transfer to "
        + "the person you mean. TruePad records only that you said they matched; it cannot check "
        + "that you did."
}

// MARK: - destroy: the operator confirms by KNOWING

public enum DestroyPrompt {
    /// The confirmation prompt, which must NEVER contain the pairId.
    ///
    /// The operator confirms a destruction by already knowing which pad they mean
    /// — from the pad book, a head.json, or the tombstone. A prompt that shows
    /// the value it is asking for is not a confirmation, it is a copy exercise.
    public static func text(forUnreadablePair unreadable: Bool) -> String {
        unreadable
            ? "This pad is too damaged to identify. To destroy it anyway, type "
              + "\"\(unreadablePairToken)\"."
            : "Destroying a pad is permanent. Type the pad's identifier to confirm. TruePad will "
              + "not show it to you here."
    }

    /// True if this prompt would leak the value it is asking for.
    public static func leaks(_ prompt: String, pairId: String) -> Bool {
        prompt.localizedCaseInsensitiveContains(pairId)
    }
}

// MARK: - what may leave the app, and how

/// How a set of bytes is allowed to leave the device.
///
/// The distinction is not cosmetic: the CLIPBOARD is readable by other apps and
/// is synced across devices by Handoff, so pad material must never reach it. The
/// share sheet hands bytes to an app the operator picked, which is a different
/// (and acceptable) risk they are choosing.
public enum Egress: Sendable, Equatable {
    /// A courier bundle or sealed package: share sheet or Files only.
    case fileOnly
    /// A public request or envelope: may also be copied or shown as a QR.
    case publicText
}

public enum EgressPolicy {
    /// Pad material NEVER reaches the clipboard.
    public static func mayCopyToClipboard(_ egress: Egress) -> Bool { egress == .publicText }
    public static func mayRenderAsQr(_ egress: Egress) -> Bool { egress == .publicText }
    public static func mayShareAsFile(_ egress: Egress) -> Bool { true }

    /// The file name a courier bundle or sealed package is offered under.
    /// Deliberately carries no label, no date and no pairId: a file name is
    /// metadata that survives in places the file's contents do not.
    public static func fileName(for egress: Egress, sealed: Bool) -> String {
        sealed ? "transfer.tps2" : "pad.tpair"
    }
}
