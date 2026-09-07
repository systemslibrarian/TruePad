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

/// IS THIS CANONICAL PUBLIC TRANSPORT MATERIAL?
///
/// Extracted so that the two things TruePad does with public material — draw it
/// as a QR and put it on the pasteboard — ask the SAME question. They differ only
/// in that a QR additionally has a size ceiling; canonicality is not a property
/// that may have two implementations, because the second one is the one that
/// eventually says yes to something the first would refuse.
enum PublicTransportCanon {
    /// Decoded and re-encoded, and it must come back identical. A view cannot
    /// hand this a string it assembled itself, or a truncated one.
    static func isCanonicalReceiveRequest(_ text: String) -> Bool {
        text.hasPrefix(SptConstantsBridge.tpr2Prefix)
            && SptConstantsBridge.isCanonicalReceiveRequest(text)
    }

    static func isCanonicalEnvelope(_ text: String) -> Bool {
        guard text.hasPrefix(CompactEnvelope.prefix),
              case .ok(let decoded) = CompactEnvelope.decode(text),
              (try? CompactEnvelope.encode(decoded)) == text else { return false }
        return true
    }

    /// The §6.2 JSON spelling of the same envelope, decoded and re-emitted and
    /// required to come back identical.
    static func isCanonicalJson(_ text: String) -> Bool {
        guard case .ok(let decoded) = EnvelopeCodec.decode(text),
              (try? EnvelopeCodec.encode(decoded)) == text else { return false }
        return true
    }
}

/// THE ONLY THING THAT MAY BE COPIED.
///
/// A value of this type is public transport material that has been RE-VALIDATED:
/// a canonical `TPR2:` receive request, a canonical `TP2:` compact envelope, or
/// that same envelope in its canonical §6.2 JSON spelling — each decoded and
/// re-encoded to itself. (The third was omitted here while `canonicalJson` and
/// the Send screen's "Copy JSON" both existed, so the doc a reviewer reads to
/// confirm what the clipboard boundary admits understated it by one kind.)
/// It cannot be constructed from an arbitrary
/// string, which is the whole point — the pasteboard boundary takes this type and
/// not a `String`, so a view physically cannot hand it plaintext, pad material,
/// a `.tps2` package, a key, or anything it assembled.
///
/// WHY THIS IS NOT `QrPayload`. A QR additionally has a size ceiling, and a long
/// envelope that cannot be drawn as a code is still perfectly copyable. Gating
/// copy on the QR type would refuse to copy exactly the messages most in need of
/// copying.
public struct PublicTransport: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case receiveRequest
        case envelope
        /// The SAME envelope, in its canonical §6.2 JSON spelling. Public for the
        /// same reason the compact form is — it is an already-encrypted message —
        /// and offered because the Browser edition has always let an operator take
        /// the technical form when a channel mangles the compact one.
        case canonicalJson
    }

    public let kind: Kind
    public let text: String

    private init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }

    public static func receiveRequest(_ text: String) -> Result<PublicTransport, QrRefusal> {
        guard text.hasPrefix(SptConstantsBridge.tpr2Prefix) else { return .failure(.notAKnownPayload) }
        guard PublicTransportCanon.isCanonicalReceiveRequest(text) else { return .failure(.notCanonical) }
        return .success(PublicTransport(kind: .receiveRequest, text: text))
    }

    public static func envelope(_ text: String) -> Result<PublicTransport, QrRefusal> {
        guard text.hasPrefix(CompactEnvelope.prefix) else { return .failure(.notAKnownPayload) }
        guard PublicTransportCanon.isCanonicalEnvelope(text) else { return .failure(.notCanonical) }
        return .success(PublicTransport(kind: .envelope, text: text))
    }

    /// The canonical JSON spelling. RE-VALIDATED the same way: decoded and
    /// re-emitted, and required to be identical — so a view cannot hand this a
    /// string it assembled, and nothing that is not an envelope gets through.
    public static func canonicalJson(_ text: String) -> Result<PublicTransport, QrRefusal> {
        guard text.hasPrefix("{") else { return .failure(.notAKnownPayload) }
        guard PublicTransportCanon.isCanonicalJson(text) else { return .failure(.notCanonical) }
        return .success(PublicTransport(kind: .canonicalJson, text: text))
    }

    /// The function a view calls when it holds a string it believes is public.
    public static func from(_ text: String) -> Result<PublicTransport, QrRefusal> {
        if text.hasPrefix(SptConstantsBridge.tpr2Prefix) { return receiveRequest(text) }
        if text.hasPrefix(CompactEnvelope.prefix) { return envelope(text) }
        if text.hasPrefix("{") { return canonicalJson(text) }
        return .failure(.notAKnownPayload)
    }

    /// The egress class this material belongs to, so the policy that already
    /// exists is the policy that governs it rather than a second opinion.
    public var egress: Egress { .publicText }
}

public enum QrPayloadBuilder {
    /// The capacity ceiling of a version-40 QR at the error-correction level this
    /// app draws, which is a property of the FORMAT — not a measured claim about
    /// what a camera reads at arm's length. Nothing here has been tested against
    /// real optics; that is the physical-device QR gate, and this constant is not
    /// evidence for it.
    ///
    /// A payload past this is refused rather than split: TruePad has NO
    /// multi-frame or animated QR, because a pad that arrives in pieces is a pad
    /// whose pieces can be mixed.
    public static let maxQrCharacters = 2953

    /// Build a QR payload from a receive-request text, RE-VALIDATING it.
    ///
    /// The text is decoded and re-encoded and must come back identical. A view
    /// cannot hand this a string it assembled itself, or a truncated one, and
    /// have it rendered.
    public static func receiveRequest(_ text: String) -> Result<QrPayload, QrRefusal> {
        guard text.hasPrefix(SptConstantsBridge.tpr2Prefix) else { return .failure(.notAKnownPayload) }
        guard text.count <= maxQrCharacters else { return .failure(.tooLong) }
        guard PublicTransportCanon.isCanonicalReceiveRequest(text) else { return .failure(.notCanonical) }
        return .success(.receiveRequest(text))
    }

    /// Build a QR payload from a compact envelope, RE-VALIDATING it the same way.
    public static func envelope(_ text: String) -> Result<QrPayload, QrRefusal> {
        guard text.hasPrefix(CompactEnvelope.prefix) else { return .failure(.notAKnownPayload) }
        guard text.count <= maxQrCharacters else { return .failure(.tooLong) }
        guard PublicTransportCanon.isCanonicalEnvelope(text) else { return .failure(.notCanonical) }
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

// MARK: - the comparison ceremony's phrase lengths

/// The two ceremony phrase lengths, and the rule that a phrase must be COMPLETE
/// before the step it belongs to is actionable.
///
/// These were briefly declared inside the iOS-only view file, which meant the
/// rule that stops an operator confirming words they cannot see was unreachable
/// from `swift test` on macOS — a safety gate with no test. They live here now,
/// where this file's whole purpose is that its decisions are testable without a
/// device.
/// WHETHER THE SCREEN MUST BE COVERED, as a decision rather than a SwiftUI
/// detail — so it is testable by `swift test`, which cannot run a view.
///
/// iOS RENDERS THE APP TO DISK WHEN IT LEAVES THE FOREGROUND. The image goes to
/// `Library/SplashBoard/Snapshots/` inside the container, so whatever was on
/// screen is written out as a picture: the app-switcher card, and a file that
/// outlives a force-quit. That was observed on a real handset — the directory
/// exists and is written on every background transition.
///
/// TruePad displays decrypted plaintext (the Open screen) and a message being
/// composed (the Send screen). Those are precisely what the one-time pad exists
/// to protect, and a snapshot of them is a copy the store's protection class
/// never covers, in a directory the app does not own.
public enum AppVisibility {
    case active
    case inactive
    case background
}

public enum ScreenPrivacy {
    /// THE `.inactive` CASE IS THE WHOLE POINT. iOS takes the snapshot during the
    /// transition, while the scene is INACTIVE — not after it reaches
    /// `.background`. Covering only at `.background` is the standard version of
    /// this bug: it looks correct, the app-switcher card looks blank in casual
    /// testing, and the snapshot on disk still has the plaintext in it.
    ///
    /// `.inactive` also covers the cases that are not backgrounding at all — the
    /// control centre pulled down, a call banner, the app-switcher opened and
    /// dismissed — where the screen is visible to someone who is not holding an
    /// unlocked phone.
    public static func shouldObscure(_ visibility: AppVisibility) -> Bool {
        visibility != .active
    }
}

public enum CeremonyPhrase {
    /// Twelve request words and eight confirmation words. These come from the
    /// 11-bit index counts the protocol fixes; they are not layout choices.
    public static let requestWordCount = 12
    public static let confirmationWordCount = 8

    /// Is this phrase displayable IN FULL?
    ///
    /// Length-exact, not merely non-empty. Eleven words is not a shorter phrase;
    /// it is a different one, and it is precisely the case where two people read
    /// past each other without either noticing.
    public static func isComplete(_ words: [String], expecting expected: Int) -> Bool {
        words.count == expected && !words.contains(where: { $0.isEmpty })
    }
}

// MARK: - the verdict is DERIVED, and its words are not softened

/// One direction's live meters, flattened for display. Built from a
/// `DirectionMeters` the engine just computed — never from anything persisted.
/// WHAT A ROW IN THE PAD LIST SAYS.
///
/// The list used to put the deployment evaluator's verdict in EVERY row — every
/// device-generated pad read "NOT ELIGIBLE" next to its name, forever, in the
/// one place the operator looks to pick a pad. That is a classification, not a
/// status, and at a glance it reads as "broken".
///
/// A row has to answer four things and nothing more: what is this pad called, can
/// I use it, roughly how much is left, and is it gone. The classification, the
/// exact counters and the witness state all still exist — one screen in, under
/// Security details, where they can be read rather than glanced at.
public enum PadRowState: Equatable, Sendable {
    /// Destroyed. Must remain unmistakable and must never be offered as usable.
    case destroyed
    /// The rollback witness for this pad does not agree with the store — the
    /// signal that a copy may have been restored from a backup, which is the
    /// reuse this whole design exists to catch. The most serious state a pad that
    /// still exists can be in.
    case rollbackSuspected
    /// The failure brake has tripped (§8.4): the pair reached its failure
    /// threshold. PAIR-WIDE and it blocks BOTH sending and opening — `burn` and
    /// `open` each call `requireNotFrozen`, which refuses if EITHER half has
    /// tripped. Reversible: clear-freeze resumes, and it burns nothing.
    case paused
    /// Usable, with the number of messages still sendable in the thinner half.
    case ready(sends: Int)

    /// ORDER MATTERS AND IS DELIBERATE. Destroyed outranks everything: a pad that
    /// is gone must never be drawn as merely paused or merely low. A suspected
    /// rollback outranks a pause, because one is a reuse risk and the other is a
    /// brake the operator can release.
    public static func of(destroyed: Bool,
                          rollbackSuspected: Bool = false,
                          frozen: Bool,
                          remainingSends: Int) -> PadRowState {
        if destroyed { return .destroyed }
        if rollbackSuspected { return .rollbackSuspected }
        if frozen { return .paused }
        return .ready(sends: max(0, remainingSends))
    }

    /// The single line under the pad's name.
    public var line: String {
        switch self {
        case .destroyed: return "Destroyed — permanently unusable"
        case .rollbackSuspected: return "Needs attention — rollback suspected"
        // NOT "cannot send". The freeze stops opening too, and saying only
        // "cannot send" would leave an operator wondering why a message they
        // received will not open either.
        case .paused: return "Paused — cannot send or open"
        case .ready(let sends):
            return sends == 1 ? "1 message left" : "\(sends) messages left"
        }
    }

    /// Whether this row should be styled as a problem. False for `ready`, however
    /// small the number — running low is not an error.
    public var isProblem: Bool {
        switch self {
        case .destroyed, .rollbackSuspected, .paused: return true
        case .ready: return false
        }
    }

    /// What VoiceOver reads for the whole row.
    public func spoken(label: String) -> String {
        switch self {
        case .destroyed:
            return "\(label). Destroyed, and permanently unusable."
        case .rollbackSuspected:
            return "\(label). Needs attention: this pad's rollback witness does not agree with "
                 + "its stored state, which can mean a copy was restored."
        case .paused:
            return "\(label). Paused: this pad cannot send or open messages until the freeze is "
                 + "cleared."
        case .ready(let sends):
            return "\(label). You can send \(sends) more \(sends == 1 ? "message" : "messages")."
        }
    }
}

public struct MeterRow: Sendable, Equatable {
    public let direction: String
    public let encryptionUsed: Int
    public let encryptionCapacity: Int
    public let recordsUsed: Int
    public let recordsCapacity: Int
    public let maxRemainingSends: Int
    public let limitedBy: String
    /// HOW THIS DIRECTION PACKAGES A MESSAGE, already in the operator's words.
    /// Shown beside the message count because the count DEPENDS on it — see
    /// `FixedRecordIntake.recordModeLabel`.
    public let recordMode: String
    public let frozen: Bool
    public let witness: String
    public let verdict: String
    public let whyNotStronger: String?

    /// The direction in the operator's words — which REQUIRES knowing which half
    /// this device owns. "A->B" is the wire's name and means nothing to someone
    /// who has not read the protocol, but translating it without the role would
    /// be worse than leaving it: for party B, A->B is the half they RECEIVE on.
    /// Getting that backwards would tell the operator the wrong number is their
    /// sending budget.
    ///
    /// With no derived role there is nothing honest to say, so it says the
    /// direction plainly and leaves the interpretation alone.
    public func plainDirection(role: Party?) -> String {
        guard let role else { return direction == "A->B" ? "A to B" : "B to A" }
        let sends = (role == .a && direction == "A->B") || (role == .b && direction == "B->A")
        return sends ? "Messages you send" : "Messages you receive"
    }

    /// The headline number for this direction, without the counters.
    ///
    /// DELIBERATELY SAYS NOTHING ABOUT THE FREEZE. The freeze is PAIR-WIDE —
    /// `requireNotFrozen` refuses if either half has tripped, and it blocks
    /// opening as well as sending — so reporting it on one direction's row would
    /// say something both too narrow and too specific. The pad's own state line
    /// carries it, once, correctly.
    public var remainingLine: String {
        maxRemainingSends == 1 ? "1 message left" : "\(maxRemainingSends) messages left"
    }

    public init(_ m: DirectionMeters) {
        direction = m.direction.rawValue
        encryptionUsed = m.nextOffset
        encryptionCapacity = m.capacity
        recordsUsed = m.nextSequence
        recordsCapacity = m.capacityRecords
        maxRemainingSends = m.maxRemainingSends
        limitedBy = m.limitedBy
        recordMode = FixedRecordIntake.recordModeLabel(m.record)
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
/// THE THREE SIZES A NORMAL OPERATOR CHOOSES BETWEEN.
///
/// These are the Browser Edition's presets, value for value
/// (`src/browser/ui/create-pair.ts`), because a person who used TruePad in a
/// browser and then on a phone must not be offered a different set of pads. They
/// are duplicated rather than shared only because the two editions share no build.
///
/// `records` is the HARD CEILING on messages in one direction — the number of
/// one-time authentication records — so "up to N messages each way" is a
/// statement of the cap and not a rounded promise. `bytes` is the encryption
/// material per direction.
///
/// WHAT THIS DOES NOT DO: it does not change what the engine is handed. A preset
/// is two integers the operator did not have to type; `gen` receives exactly the
/// same arguments it received when those integers came from a stepper.
public enum PadSize: String, CaseIterable, Hashable, Sendable {
    case small, medium, large

    public var title: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        }
    }

    /// What the size is FOR, in the operator's terms rather than the protocol's.
    public var blurb: String {
        switch self {
        case .small: return "Occasional messages."
        case .medium: return "Regular conversation."
        case .large: return "Messages and files."
        }
    }

    public var bytes: Int {
        switch self {
        case .small: return 16_384
        case .medium: return 262_144
        case .large: return 4_194_304
        }
    }

    public var records: Int {
        switch self {
        case .small: return 64
        case .medium: return 512
        case .large: return 4096
        }
    }

    /// The cap, said plainly. Read aloud by VoiceOver as part of the row.
    public var capacityLine: String { "Up to \(records) messages each way." }

    /// The Browser opens on Medium, so this does too.
    public static let `default`: PadSize = .medium

    /// The preset whose numbers these are, or nil if the operator has typed
    /// something of their own. Used to keep the size rows and the advanced fields
    /// showing the same truth.
    public static func matching(bytes: Int, records: Int) -> PadSize? {
        allCases.first { $0.bytes == bytes && $0.records == records }
    }
}

/// WHAT THE DEVICE GENERATOR IS, AND WHAT IT IS NOT.
///
/// The normal path uses the platform CSPRNG, and that is a strong practical
/// cryptographic source. It is NOT an information-theoretic one, and TruePad's
/// deployment evaluator says so by returning NOT ELIGIBLE.
///
/// Those are two different statements and the interface used to collapse them.
/// The create screen led with an orange "This pad will read NOT ELIGIBLE" before
/// the operator had chosen anything, which reads as "this pad is broken" — it is
/// not what the sentence means, and it is the first thing a new operator saw.
///
/// The fix is ORDER AND PROMINENCE, not content. Every claim below is the same
/// claim the Browser Edition makes; none of it is softened, and the evaluator's
/// returned value is untouched. What changed is that the plain fact leads and the
/// classification is one disclosure away instead of shouted first.
public enum SourceClaimText {
    /// The one-line, calm, true statement for the normal path.
    public static let deviceHeadline = "Generated securely on this iPhone"

    /// The supporting sentence, still on the surface.
    public static let deviceSupporting =
        "Uses your iPhone's cryptographic random generator. Recommended for normal use."

    /// The label the technical screens use for this source class.
    public static let deviceSourceLabel = "Device-generated"

    /// The full claim, one disclosure down. This is the Browser's DEVICE_DETAIL,
    /// with the platform call named for this edition.
    public static let deviceDetail =
        "Generated by your iPhone's cryptographic random generator "
        + "(SecRandomCopyBytes) — a cryptographically secure platform generator, or CSPRNG. Its "
        + "security rests on computational and platform assumptions. TruePad does not call this "
        + "physically proven randomness, and does not promote it to an unconditional "
        + "information-theoretic source claim."

    /// What the evaluator's NOT ELIGIBLE verdict means, said next to it.
    ///
    /// The canonical value is NOT renamed — tests and the evaluator depend on it.
    /// This is the sentence that goes beside it so the operator reads a
    /// classification rather than an alarm.
    public static let notEligibleMeaning =
        "Not eligible for TruePad's strongest information-theoretic deployment classification."

    public static let notEligibleReason =
        "This pad was generated by the iPhone's cryptographic random generator rather than from "
        + "operator-supplied physical random material. That classification is PERMANENT for this "
        + "pad: no later step can raise it."

    /// And, just as importantly, what it does NOT mean. Every line here is a
    /// property that remains fully in force.
    public static let notEligibleDoesNotMean =
        "It does not mean encryption is off, that reuse protection is weakened, that the "
        + "one-time-pad construction changed, that the pad is malformed, or that TruePad thinks "
        + "this device's generator is weak. The pad encrypts and authenticates exactly as any "
        + "other pad does."

    /// The expert path's one-line summary, matching the Browser's EXTERNAL_SHORT.
    public static let externalShort = "Supply random material whose origin you control."
}

/// WHAT THE RECEIVE SCREEN SAYS ABOUT A REQUEST THAT IS OVER.
///
/// Every one of these states is TERMINAL in the engine, and the interface's job
/// is to say which one happened and offer the only recovery there is — making a
/// new request. None of them offers a way back: a request that has been consumed,
/// cancelled, rejected or expired is finished, and an interface that implied
/// otherwise would be inviting the operator to reuse a one-time key.
public enum ReceiveRequestOutcomeText {
    /// The headline for a finished request, or nil while it is still live.
    public static func headline(_ status: ReceiveRequestStatus) -> String? {
        switch status {
        case .pending:    return nil
        // NOT "Pad received". `consumed` means the one-time key was SPENT, which
        // the engine does BEFORE importing — its own comment reads "CONSUME.
        // After this returns valid, any failure below is LOSS." So a request can
        // be consumed with no pad saved, and a headline asserting a pad arrived
        // would tell the operator they hold something they do not.
        case .consumed:   return "Receive code used"
        case .cancelled:  return "Receive code cancelled"
        case .rejected:   return "Transfer rejected"
        case .expired:    return "Receive code expired"
        case .absent:     return nil
        case .unreadable: return "Receive code unreadable"
        }
    }

    /// What it means, and what the operator can do next.
    public static func detail(_ status: ReceiveRequestStatus) -> String? {
        switch status {
        case .pending, .absent:
            return nil
        case .consumed:
            return "This receive code has been used and cannot receive another pad. If the pad "
                 + "did not appear in your list, it was lost in transfer — the code is spent "
                 + "either way, and the sender must start again with a new one. Create a new "
                 + "code if you are still expecting a pad."
        case .cancelled:
            return "You cancelled this receive code. It cannot be used again. Create a new one "
                 + "to receive a pad."
        case .rejected:
            return "The confirmation words did not match, so the transfer was refused and this "
                 + "receive code was closed. That is the right outcome for a mismatch. Create a "
                 + "new one and start again with the sender."
        case .expired:
            return "This receive code timed out and can no longer receive a pad. Create a new one."
        case .unreadable:
            return "This receive code cannot be read as any valid state, so TruePad will not "
                 + "treat it as usable. Create a new one."
        }
    }
}

/// WHAT TO DO WITH A FILE THE OPERATOR PICKED AS PAD MATERIAL.
///
/// Kept out of the view and out of the iOS-only model so it can actually be
/// tested: `CeremonyModels.swift` and `CeremonyViews.swift` are `#if os(iOS)`, so
/// `swift test` on a Mac never compiles them. The defect this exists to prevent
/// lived in exactly that blind spot — `CreatePadView` offered "Choose a file…",
/// set `choosingFile = true`, and no `.fileImporter` anywhere observed that flag,
/// so the whole external-material path was inert and no host test could see it.
///
/// The rules here are the EXISTING rules, written down rather than changed:
///
///   - A file that cannot be read is a refusal. Nothing is created, and the
///     operator is told, rather than left with a button that silently does
///     nothing.
///   - A file that reads is ACCEPTED AS SUPPLIED. TruePad does not inspect it,
///     score it, or form any view about whether it is random — it cannot, and
///     saying otherwise would be the one claim this project must never make.
///   - Whether it is BIG ENOUGH is a SEPARATE question from whether the file
///     read, and `decide` deliberately still does not answer it: a short file is
///     accepted as a file and refused as a pad. Saying "could not be read" about
///     a file that read fine would send the operator hunting a problem that does
///     not exist.
///   - Cancelling is not a refusal and must never be presented as one.
///
/// WHERE THE LENGTH RULE LIVES, since it moved. It is now `readiness(have:need:
/// declaration:)`, below, and `CreatePadModel.canCreate` defers to it rather than
/// comparing lengths itself. This comment used to say the opposite — that length
/// "stays with `canCreate`, which already compares the supplied length against
/// the partition's required source length" — which was true when written and
/// became false when the screen gained an explanation for WHY creation was
/// blocked. Two places deciding one thing is how a disabled button ends up under
/// text saying everything is ready, so there is now one decision and both the
/// button and the explanation read it.
///
/// There is NO fallback to the device generator. An operator who asked for their
/// own material and whose file failed gets a refusal, not a quietly
/// device-generated pad that reads NOT ELIGIBLE for a reason they never chose.
public enum ExternalSourceIntake {
    public enum Outcome: Equatable, Sendable {
        /// Take these bytes as the pad material, under the operator's declaration.
        case accept(name: String, byteCount: Int)
        /// The file could not be read. Nothing changes.
        case refuse(String)
        /// The picker closed without a choice. Nothing changes, and nothing is said.
        case cancelled
    }

    /// `bytes` is nil when the file could not be read at all.
    public static func decide(name: String, bytes: Int?) -> Outcome {
        guard let bytes else { return .refuse(unreadableFile) }
        // A zero-byte file is readable and useless; it is not a read FAILURE, and
        // `canCreate` will refuse it on length like any other short file. Saying
        // "could not be read" about a file that read fine would be untrue.
        return .accept(name: name, byteCount: bytes)
    }

    public static let unreadableFile =
        "That file could not be read. Nothing was used and no pad was created — "
        + "choose the file again."

    /// WHY CREATE IS NOT AVAILABLE YET, in the operator's terms.
    ///
    /// This exists because "the button is grey" is not a reason. A readable file
    /// that is simply too short looked, from the operator's seat, exactly like a
    /// broken picker: the file had been chosen, the name was on screen, and
    /// nothing said what was wrong. The obvious repairs are all forbidden — a pad
    /// may not be made by stretching, repeating, padding or deriving material —
    /// so the only honest response is to SAY SO and let the operator choose a
    /// bigger file or a smaller pad.
    public enum Readiness: Equatable, Sendable {
        case needsFile
        case tooShort(have: Int, need: Int)
        case needsDeclaration
        case ready

        /// Nil when ready; otherwise what to show under the picker.
        public var explanation: String? {
            switch self {
            case .ready: return nil
            case .needsFile:
                return "Choose the file holding your random material."
            case .needsDeclaration:
                return "Say where these bytes came from. TruePad records your note with the "
                    + "pad and cannot check it — it is your statement, not a measurement."
            case .tooShort(let have, let need):
                return "That file is \(have) bytes and this pad needs \(need). TruePad will "
                    + "not stretch, repeat, pad or derive material to make a file fit, because "
                    + "material invented to fill a gap is not random and the pad would not be "
                    + "one-time. Choose a larger file, or a smaller pad size."
            }
        }
    }

    /// The single authority on whether an external-source pad may be created.
    ///
    /// `have` is nil when no file has been chosen. `declaration` is the operator's
    /// own note, untrimmed — trimming happens here so the view and the model
    /// cannot disagree about whether spaces count as an answer.
    public static func readiness(have: Int?, need: Int, declaration: String) -> Readiness {
        guard let have else { return .needsFile }
        if have < need { return .tooShort(have: have, need: need) }
        guard !declaration.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .needsDeclaration
        }
        return .ready
    }
}

public enum VerbatimText {
    /// WHAT TRUEPAD SAYS ABOUT THE DECRYPTED MESSAGE STAYING PUT.
    ///
    /// Deliberately modest. It says what TruePad DOES — it does not offer a copy
    /// or a save for the decrypted message — and claims nothing about what the
    /// device, the operating system or another person can do. A screenshot, an
    /// accessibility service, a debugger attached to the process, and someone
    /// reading the words aloud are all untouched by it. It is an application
    /// egress policy, not a data-loss-prevention claim.
    ///
    /// Word for word the Browser's `PLAINTEXT_STAYS_HERE` (ui/egress-copy.ts) and
    /// Android's `Claims.PLAINTEXT_STAYS_HERE`, so one rule reads the same on all
    /// three editions. iOS already ENFORCED this; it had never said it.
    public static let plaintextStaysHere =
        "This message stays in TruePad \u{2014} there is no copy or save for it. "
        + "You can read it here."

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
    /// THE DECRYPTED MESSAGE ITSELF. Never copied, never a QR, never a file.
    ///
    /// This case was missing, and its absence was the gap. The Open screen
    /// rendered plaintext with `.textSelection(.enabled)`, which routes it to the
    /// GENERAL pasteboard — Universal-Clipboard-eligible, so the one thing the
    /// pad exists to protect could leave the handset for any Mac or iPad on the
    /// same Apple ID. `LeakageAuditTests` bans the `UIPasteboard` symbol in
    /// shipping source, and a declarative SwiftUI modifier walked straight around
    /// that ban without the symbol ever appearing.
    case plaintext
}

/// THE SCRATCH FILE A HANDOFF LEAVES BEHIND.
///
/// Handing a pad over writes the WHOLE pad — or a sealed package containing it —
/// to a file so the share sheet has something to hand to another app. Nothing
/// ever deleted it. The bytes sat in the container's `tmp/` under a fixed name,
/// and they outlived `destroy`: the destruction verb zero-overwrites `secret.bin`
/// and unlinks the half directories inside the store, and this file is not in the
/// store. The engine believed the material was gone while a complete copy of it
/// was still on the device.
///
/// `ShareableFile`'s own comment claimed the file "is removed afterwards", which
/// was the intent and was not the code — so this is the intent, implemented.
///
/// WHAT REMOVAL IS AND IS NOT. This unlinks. It is not erasure, and nothing here
/// may be read as erasure: the same limitation the destruction text states
/// applies exactly as much to a scratch file as to a pad. What it buys is that
/// the copy stops being reachable and stops outliving the pad it came from.
public enum HandoffScratch {
    /// The only two names anything is ever written under, from `EgressPolicy`.
    /// Kept as a list rather than derived, so a sweep still finds a file whose
    /// naming rule later changes underneath it.
    public static let fileNames = ["pad.tpair", "transfer.tps2"]

    /// Remove every known scratch file in `directory`. Returns how many were
    /// actually removed, so a caller can tell "nothing was there" from "the
    /// remove failed" — the launch sweep exists precisely because a crash during
    /// the share sheet leaves one behind, and a sweep that silently did nothing
    /// would be indistinguishable from a sweep that worked.
    @discardableResult
    public static func sweep(_ directory: URL,
                             using fm: FileManager = .default) -> Int {
        var removed = 0
        for name in fileNames {
            let url = directory.appendingPathComponent(name)
            guard fm.fileExists(atPath: url.path) else { continue }
            if (try? fm.removeItem(at: url)) != nil { removed += 1 }
        }
        return removed
    }
}

/// OWNS THE LIFETIME OF ONE HANDOFF SCRATCH FILE.
///
/// This exists as a separate, host-testable type because the first version of the
/// cleanup was a NO-OP and every test was green.
///
/// The models are `#if os(iOS)`, so `swift test` cannot reach them at all — the
/// cleanup lived somewhere CI structurally could not execute. And the bug itself
/// was invisible by inspection: `discardSharedFile()` read `fileToShare`, the same
/// property the `.sheet(item:)` presentation is bound to, and **SwiftUI clears an
/// `item:` binding BEFORE it calls `onDismiss`**. By the time the cleanup ran the
/// binding was nil, the `if let` failed, nothing was removed, and a complete copy
/// of the pad stayed in `tmp/` for the rest of the session.
///
/// So the rule this type enforces is: the thing to delete is remembered
/// INDEPENDENTLY of anything the view layer is allowed to clear.
public final class HandoffScratchFile {
    private var tracked: URL?

    public init() {}

    /// Remember a scratch file that has just been written.
    public func track(_ url: URL) { tracked = url }

    public var isTracking: Bool { tracked != nil }

    /// Remove whatever was tracked, and forget it. Returns whether a file was
    /// actually removed — false both when nothing was tracked and when the
    /// removal failed, which the caller must not confuse with proof of deletion.
    ///
    /// Removal is UNLINKING, not erasure. See `VerbatimText.destructionLimitation`.
    @discardableResult
    public func discard(using fm: FileManager = .default) -> Bool {
        guard let url = tracked else { return false }
        tracked = nil
        return (try? fm.removeItem(at: url)) != nil
    }
}

/// WHICH HALF OF THE PAIR THIS DEVICE OWNS.
///
/// THE DEFECT THIS CLOSES. The Browser Edition pins the operator's role per pair
/// at acquisition (creator -> A, importer -> B) and the CLI refuses to guess at
/// all: `--as A or --as B is required: it names YOUR role, and picks which half
/// of the pair is used`. Both mobile editions dropped that guard. iOS carried two
/// INDEPENDENT defaults — `SendModel.role = .a` and `OpenModel.role = .b` — so a
/// device that IMPORTED a pad opened correctly at its default (masking the
/// problem entirely) and then SENT on party A's half.
///
/// Two devices holding one pair therefore both burned `A->B`, at the same
/// offsets, against the same one-time authentication record. Each store's own
/// counters advanced monotonically, each witness agreed, and no engine on either
/// side could see it: the reuse is ACROSS two copies, not within one store. Two
/// plaintexts under the same pad bytes is the failure the whole product exists to
/// prevent, and it happened on the ordinary no-error path with no adversary.
///
/// THE RULE. One role per pair, derived from how the pad was acquired — never a
/// free-floating default, and never a different answer for sending than for
/// opening. `unknown` returns nil and the interface REFUSES; it does not delegate.
/// (This once said "the operator is asked, exactly as the CLI asks", and both
/// mobile editions did ask, with a picker. The CLI's `--as` is a different thing:
/// it is stated per invocation by someone driving the engine directly, not a
/// control offered beside a prompt that says a pick would be a guess. A picker in
/// the interface is a SECOND role authority beside the origin — see
/// `src/browser/ui/role.ts`, which declined to add one for exactly this reason.)
/// Refusing to proceed is LOSS, which this project accepts; guessing is REUSE,
/// which it does not.
public enum PartyRole {
    public static func derive(from origin: PairOrigin) -> Party? {
        switch origin {
        case .generatedHere: return .a
        case .imported:      return .b
        // NOT `.a`. An unreadable or absent origin is exactly the case where a
        // guess is most likely to be wrong, because it is the case where the
        // provenance evidence was lost.
        case .unknown:       return nil
        }
    }

    /// What to tell an operator whose pad cannot say which half is theirs.
    /// WHAT TO SAY WHEN THE ROLE CANNOT BE DERIVED.
    ///
    /// TWO DEFECTS WERE FIXED HERE AT ONCE, and they compounded each other.
    ///
    /// It said "Choose the role you were given when this pad was created."
    /// **There is no control on iOS that chooses a role** — the only `role:`
    /// arguments in this module are SwiftUI `ButtonRole`s — so the instruction
    /// named a screen that does not exist, exactly as the Browser's version of
    /// this message once did.
    ///
    /// And it told the operator to CHOOSE, one sentence after telling them
    /// TruePad will not guess. The role is derived from a recorded fact —
    /// generated here means A, imported means B, anything else refuses — so
    /// inviting a choice would have made the operator the guesser instead. The
    /// standing rule is that an unknown origin REFUSES; it does not delegate.
    ///
    /// Every route named below is a real, visible affordance in this app, spelled
    /// as the operator sees it, and `RolePromptTests` holds each against the UI
    /// source.
    public static let unknownOriginPrompt =
        "TruePad cannot tell which half of this pair is yours, so it will not "
        + "guess, and it will not send or open with this pad until it can. "
        + "TruePad records which half is yours when a pad is created here, or "
        + "when it arrives here through a receive code; a pad that got here some "
        + "other way carries no such record, and there is nothing for you to set "
        + "by hand \u{2014} a role you picked would be a guess wearing a different "
        + "name. Acquire the pad again: \u{201C}Create a pad\u{201D} on the Pads "
        + "screen, or \u{201C}Create a receive code\u{201D} on the Inbox tab "
        + "and have the other person send it to you. Guessing does not corrupt "
        + "the pad, but it spends material the other person is spending too, "
        + "which is the one thing TruePad will not do on your behalf."
}

/// WHICH QR ERROR-CORRECTION LEVEL A PAYLOAD SHOULD USE.
///
/// FOUND ON A HANDSET, in two stages, during the two-device ceremony.
///
/// First, `QrCodeView.render` hardcoded level `"H"`, whose byte-mode capacity is
/// 1273 bytes. A TPR2 receive request is ~1652. CoreImage on the device produced
/// NO image, the Receive screen fell back to "This code could not be drawn", and
/// the sender had nothing to scan. (It did not reproduce on a Mac: macOS
/// CoreImage renders an over-capacity payload anyway, so a host test of the
/// renderer would have said the code was fine.)
///
/// Then, picking the STRONGEST level that fits produced a code the Android camera
/// still could not read — because that choice maximises redundancy and therefore
/// MODULE COUNT. At Q a 1652-byte request needs the largest symbol there is, 177
/// modules across; at L the same bytes fit in 149. On a fixed-width screen that
/// is the difference between roughly 2.0 and 2.4 points per module, and a phone
/// camera reading another phone's screen is resolution-limited, not
/// damage-limited.
///
/// THE RULE, therefore: for a code that will be read off a screen at close range
/// in reasonable light, FEWER MODULES beats MORE REDUNDANCY. Small payloads keep
/// the strongest level, because a small payload is a small symbol either way and
/// the redundancy is free.
public enum QrCorrection {
    /// Byte-mode capacity at QR version 40 — the largest symbol — per level,
    /// strongest first. These are the QR specification's numbers.
    public static let capacities: [(level: String, bytes: Int)] =
        [("H", 1273), ("Q", 1663), ("M", 2331), ("L", 2953)]

    /// Above this, redundancy is traded away for larger modules. 1273 is H's
    /// capacity: at or below it the strongest level costs nothing, and above it
    /// every level that still fits needs a near-maximal symbol.
    public static let denseThreshold = 1273

    /// The level to draw `byteCount` with, or nil if nothing can carry it.
    public static func level(forByteCount byteCount: Int) -> String? {
        guard byteCount <= 2953 else { return nil }
        // A payload that fits the strongest level gets it.
        if byteCount <= denseThreshold { return "H" }
        // Otherwise the lowest redundancy, because that is the smallest symbol
        // and therefore the largest modules for a camera to resolve.
        return "L"
    }

    /// The STRONGEST level that could carry `byteCount`. Kept because it is the
    /// honest answer to a different question — what the spec allows — and the
    /// renderer falls back through these when a level will not draw.
    public static func strongestLevel(forByteCount byteCount: Int) -> String? {
        capacities.first { byteCount <= $0.bytes }?.level
    }
}

/// RESOLVE A PAIR'S ROLE BY ASKING THE STORE.
///
/// WHY THIS EXISTS, stated honestly. The send and open models used to be handed a
/// role by their parent, computed in `reload()` on appear, while
/// `NavigationLink { SendView(model: sendModel()) }` builds its destination
/// eagerly. That ORDERING DEPENDENCY was real and is removed here.
///
/// It was NOT an observed defect. During the two-device ceremony a bad
/// accessibility query made it look as though an imported pad was failing to
/// derive its role; on the device the role was in fact derived correctly, and the
/// operator was never asked. The query was wrong, not the code.
///
/// The change is kept because a model owning its own fact is right regardless: it
/// makes the answer independent of when a parent view happened to load, and it is
/// testable on the host, which the models themselves are not.
public enum PartyRoleResolver {
    public static func resolve(engine: Engine, pairId: String) -> Party? {
        (try? engine.status(pairId)).flatMap { PartyRole.derive(from: $0.origin) }
    }
}

/// WHAT A PAD MAY STILL DO ONCE IT HAS BEEN HANDED OVER.
///
/// Two different questions were being answered by one flag, and collapsing them
/// stranded pads. Sealing COMMITS a package to disk, and `sptSeal` called again
/// with the SAME receive request returns those committed bytes verbatim —
/// `reshared: true`, no new cryptography, no fresh confirmation. But the pad
/// screen hid the sealed-transfer button the moment the handoff marker said
/// `.sealed`, so an operator who sealed and then dismissed the sheet before
/// saving the file had no route back to it. The package existed and the only
/// affordance that could reach it was gone.
///
/// The two questions, kept apart:
///
///   - MAY THE RAW PAD LEAVE AS A FILE? Once a pad has been handed over by any
///     route, no. Two copies in circulation is the reuse this app exists to
///     prevent, and that answer never becomes yes again.
///   - MAY THE ALREADY-SEALED PACKAGE BE HANDED OVER AGAIN? Yes, and only for a
///     pad whose handoff is `.sealed`. It is the same bytes, already committed,
///     already confirmed. Re-offering them creates no second copy — the copy was
///     created when the seal was committed. Sealing to a DIFFERENT request is
///     refused by the engine, not by this policy.
///
/// An imported pad is never passed on by either route.
public enum HandoffPolicy {
    /// Whether the raw pad may still be written to a file the operator chooses.
    public static func mayExportRawPad(handedOver: Bool, imported: Bool) -> Bool {
        !handedOver && !imported
    }

    /// Whether the committed sealed package may be offered again.
    /// TRUE ONLY for a pad that was sealed — never for one handed over
    /// physically, never for one whose spent-state cannot be read, and never for
    /// an imported copy.
    public static func mayResharedSealedPackage(sealed: Bool, imported: Bool) -> Bool {
        sealed && !imported
    }
}

public enum EgressPolicy {
    /// Pad material NEVER reaches the clipboard, and neither does plaintext.
    public static func mayCopyToClipboard(_ egress: Egress) -> Bool { egress == .publicText }
    public static func mayRenderAsQr(_ egress: Egress) -> Bool { egress == .publicText }
    /// Everything but the decrypted message may be handed to another app as a
    /// file. Plaintext may not: the operator asked TruePad to reveal it, not to
    /// hand it onward.
    public static func mayShareAsFile(_ egress: Egress) -> Bool { egress != .plaintext }

    /// The file name a courier bundle or sealed package is offered under.
    /// Deliberately carries no label, no date and no pairId: a file name is
    /// metadata that survives in places the file's contents do not.
    public static func fileName(for egress: Egress, sealed: Bool) -> String {
        sealed ? "transfer.tps2" : "pad.tpair"
    }
}

// MARK: - fixed-length records

/// WHETHER A FIXED RECORD SIZE IS USABLE, and if not, why not in the operator's
/// terms.
///
/// A fixed record pads every message to the same ciphertext length, so the exact
/// length of what was written stops being visible on the wire (§16). The cost is
/// real and is stated on screen rather than discovered later: a short message
/// spends the whole record.
///
/// THE CEILING IS THE LOWER OF TWO LIMITS, and getting that wrong was not
/// hypothetical. The Android edition validated against the pad's encryption
/// capacity ALONE — `parsedF.toLong() <= size.encryptionBytes` — while its engine
/// refuses anything above `MAX_CIPHERTEXT_BYTES`. On the Large preset those are
/// 4,194,304 and 1,048,576, so the screen accepted a value the engine then
/// rejected, and the message it printed to explain the range quoted the wrong
/// number. Reported from a handset. Every edition now takes the MINIMUM of the
/// two — Android in `FixedRecordIntake.ceiling`, the Browser in `create-pair.ts`,
/// which had the same shape — and `tests/fixed-record-parity.test.ts` holds the
/// three against each other. Written in the past tense deliberately: it was in
/// the present while the defect was live, and leaving it there would have made
/// this file describe a sibling edition as broken after it was fixed.
///
/// NOTHING IS ROUNDED. A value that is not a multiple of 16 is refused and named;
/// it is not quietly nudged to one that works. An operator who typed 100 and got
/// a 112-byte record would have been told something false about their own pad.
public enum FixedRecordIntake {
    /// The offered starting point. Large enough that ordinary messages fit
    /// without spending absurd amounts of pad, and a multiple of 16.
    public static let defaultBytes = 256
    /// §16's floor. Below this a record cannot hold its own length prefix plus
    /// anything worth sending.
    public static let minimumBytes = 32
    /// §16's granularity.
    public static let multipleOf = 16

    /// The largest fixed record this pad can actually use.
    public static func ceiling(encryptionCapacity: Int,
                               engineLimit: Int = WcOneTime.maxCiphertextBytes) -> Int {
        min(encryptionCapacity, engineLimit)
    }

    public enum Readiness: Equatable, Sendable {
        /// The operator has not asked for fixed lengths, so there is nothing to check.
        case notFixed
        case notANumber
        case tooSmall(have: Int, need: Int)
        case tooLarge(have: Int, limit: Int)
        case notAMultiple(have: Int, of: Int)
        case ready(bytes: Int)

        /// The one place that decides whether creation may proceed.
        public var isReady: Bool {
            switch self {
            case .notFixed, .ready: return true
            default: return false
            }
        }

        /// Nil when there is nothing to say. Never a bare "invalid".
        public var explanation: String? {
            switch self {
            case .notFixed, .ready:
                return nil
            case .notANumber:
                return "Type the message size in bytes."
            case .tooSmall(let have, let need):
                return "\(have) bytes is too small. The smallest message size is \(need) bytes."
            case .tooLarge(let have, let limit):
                return "\(have) bytes is larger than this pad can carry. The largest message size "
                    + "for this pad is \(limit) bytes."
            case .notAMultiple(let have, let of):
                return "\(have) is not a multiple of \(of). Message sizes go up in steps of \(of) "
                    + "bytes, and TruePad will not round your number for you."
            }
        }
    }

    /// ORDERED SO THE FIRST THING WRONG IS THE THING REPORTED. Reporting "not a
    /// multiple of 16" about a number that is also far too large sends the
    /// operator to fix the wrong half of it.
    public static func readiness(fixed: Bool,
                                 typed: String,
                                 encryptionCapacity: Int,
                                 engineLimit: Int = WcOneTime.maxCiphertextBytes) -> Readiness {
        guard fixed else { return .notFixed }
        let trimmed = typed.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let value = Int(trimmed), value >= 0 else { return .notANumber }
        if value < minimumBytes { return .tooSmall(have: value, need: minimumBytes) }
        let limit = ceiling(encryptionCapacity: encryptionCapacity, engineLimit: engineLimit)
        if value > limit { return .tooLarge(have: value, limit: limit) }
        if value % multipleOf != 0 { return .notAMultiple(have: value, of: multipleOf) }
        return .ready(bytes: value)
    }

    /// WHAT A FIXED RECORD DOES AND DOES NOT HIDE.
    ///
    /// Carried over from the Android edition WORD FOR WORD, because the claim is
    /// the part that must not drift between editions. It names the property the
    /// format actually provides — one length for every message — and then names
    /// the two things still visible, rather than implying the carrier hides
    /// everything about the traffic.
    /// HOW A DIRECTION PACKAGES A MESSAGE, in the operator's terms.
    ///
    /// Shown beside the message count because the count DEPENDS on it: a fixed
    /// store spends a whole record per send, so its "Messages you can still send"
    /// is bounded by the encryption budget rather than by the record total, and
    /// without this row the smaller number has no visible explanation. Same words
    /// as the Browser's `recordModeLabel` (src/browser/ui/format.ts) and the
    /// Android twin.
    public static func recordModeLabel(_ record: RecordSpec) -> String {
        switch record {
        case .fixed(let bytes): return "Fixed · \(bytes) B per record"
        case .variable: return "Variable length"
        }
    }

    public static let costAndLimit =
        "Every message uses the same size, so its exact length is hidden. The cost: each message "
        + "spends the full size from the pad, even a short one. The number of messages and their "
        + "timing are still visible."
}
