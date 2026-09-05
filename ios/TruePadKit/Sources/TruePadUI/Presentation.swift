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
    /// Durable state says this pad cannot send right now — a rollback witness
    /// that does not agree with the store. This is the "action needed" case, and
    /// it is the one row state that is genuinely a warning.
    case frozen
    /// Usable, with the number of messages still sendable in the thinner half.
    case ready(sends: Int)

    public static func of(destroyed: Bool, frozen: Bool, remainingSends: Int) -> PadRowState {
        // ORDER MATTERS AND IS DELIBERATE. Destroyed outranks everything: a pad
        // that is gone must never be rendered as merely frozen or merely low.
        if destroyed { return .destroyed }
        if frozen { return .frozen }
        return .ready(sends: max(0, remainingSends))
    }

    /// The single line under the pad's name.
    public var line: String {
        switch self {
        case .destroyed: return "Destroyed — permanently unusable"
        case .frozen: return "Needs attention — cannot send"
        case .ready(let sends):
            return sends == 1 ? "1 message left" : "\(sends) messages left"
        }
    }

    /// Whether this row should be styled as a problem. False for `ready`, however
    /// small the number — running low is not an error.
    public var isProblem: Bool {
        switch self {
        case .destroyed, .frozen: return true
        case .ready: return false
        }
    }

    /// What VoiceOver reads for the whole row.
    public func spoken(label: String) -> String {
        switch self {
        case .destroyed: return "\(label). Destroyed, and permanently unusable."
        case .frozen: return "\(label). Needs attention: this pad cannot send."
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

    /// The headline number for the summary row, without the counters.
    public var remainingLine: String {
        if frozen { return "Cannot send — needs attention" }
        return maxRemainingSends == 1 ? "1 message left" : "\(maxRemainingSends) messages left"
    }

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
        + "operator-supplied physical random material."

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
        case .consumed:   return "Pad received"
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
            return "This receive code has done its job and cannot receive another pad. "
                 + "Create a new one if you are expecting a second pad."
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
/// opening. `unknown` returns nil: the operator is asked, exactly as the CLI asks.
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
    public static let unknownOriginPrompt =
        "TruePad cannot tell which half of this pair is yours, so it will not "
        + "guess. Choose the role you were given when this pad was created. "
        + "Choosing wrong does not corrupt the pad, but it spends material the "
        + "other person is also spending."
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
