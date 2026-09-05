import SwiftUI
import TruePadSPT
import TruePadStorage
import TruePadUI

/* ============================================================================
 * THE APP SHELL. It is deliberately the thinnest thing in the repository.
 *
 * It does exactly three things, and none of them is security logic of its own:
 *
 *   1. Decides WHERE the two failure domains live — the store in the app
 *      container, the rollback witness in the data-protection Keychain.
 *   2. Wires the two closures that TruePadUI cannot wire itself without linking
 *      the SPT module. Both DEFAULT TO REFUSING, so a shell that forgot this
 *      shows no comparison words and renders no request QR, rather than showing
 *      plausible wrong ones.
 *   3. Shows `TruePadRootView`.
 *
 * There is no engine logic here, no crypto, no second state machine, and no
 * duplicated verb. Anything that looks like a decision has been made and tested
 * in the kit; if something belongs here it is because it is a PLATFORM fact the
 * kit deliberately does not know.
 * ========================================================================= */

@main
struct TruePadApplication: App {
    /// Built once. `Engine` holds no UI state and every verb takes its own lock,
    /// so one instance is the whole app's access to durable state.
    @State private var composed: Composition = Composition.build()

    init() {
        // WIRED BEFORE ANY VIEW EXISTS. Doing this in `init` rather than in an
        // `onAppear` means there is no window in which a screen could render an
        // unvalidated QR or an incomplete phrase because the wiring had not run.
        //
        // Note the actual order: `composed` is a property initialiser, so
        // Composition.build() runs BEFORE this line. That is fine — building the
        // engine does not touch either closure — but it is worth stating, because
        // "wired first" would otherwise read as "wired before everything".
        Composition.wire()
    }

    var body: some Scene {
        WindowGroup {
            switch composed {
            case .ready(let engine):
                TruePadRootView(engine: engine)
            case .failed(let message):
                StorageUnavailableView(message: message)
            }
        }
    }
}

/// The result of composing the app's storage.
///
/// FAILING CLOSED IS A REAL OUTCOME. If the container cannot be created, the app
/// shows what happened and offers nothing else. It does not fall back to a
/// different directory, an in-memory store, or an unwitnessed configuration —
/// each of which would be a working app that had quietly stopped protecting
/// against reuse.
enum Composition {
    case ready(Engine)
    case failed(String)

    /// The store lives in Application Support: app-private, and NOT user-visible
    /// in Files. Documents is deliberately avoided — it is browsable and
    /// shareable, and pad material has no business somewhere a file picker can
    /// reach it.
    static func storeRoot() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory,
                                               in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        return base.appendingPathComponent("TruePad", isDirectory: true)
    }

    static func build() -> Composition {
        do {
            // The Data Protection class is chosen EXPLICITLY. `.completeUnlessOpen`
            // is the kit's default and is the right trade — a verb already in
            // flight must still be able to write while the device is locked, and
            // `.complete` would fail those writes outright — but inheriting a
            // security default silently is how it later changes without anyone
            // deciding to change it.
            let store = try DarwinFs(root: try storeRoot(),
                                     fileProtection: .completeUnlessOpen)
            // THE WITNESS IS PUT IN A DIFFERENT STORE FROM THE PAD, which is the
            // point of it: the store is in the app container, the witness is in
            // the data-protection Keychain.
            //
            // WHAT THAT DOES AND DOES NOT ESTABLISH. It establishes that they are
            // not the same file in the same directory, so an operation that
            // rewrites the container does not by construction rewrite the
            // witness. It does NOT establish that the witness survives a wipe or
            // a restore: that depends on Apple's Keychain behaviour, which this
            // code relies on and cannot verify, and which Apple documents as an
            // implementation detail not to be depended upon. An earlier version
            // of this comment asserted the survival outright, which is more than
            // docs/IOS-SECURITY.md §5 claims and more than anything here shows.
            let witness = KeychainWitnessFs(backend: SystemKeychainBackend())
            return .ready(Engine(fs: store, witnessFs: witness))
        } catch {
            // The raw error carries the container PATH. That is not secret, but it
            // is not the operator's problem either, and an error screen is exactly
            // where a path ends up in a screenshot sent to someone else.
            return .failed("TruePad could not open its private storage, so it will not start. "
                           + "It does not fall back to a different location: a pad store in an "
                           + "unexpected place is a pad store whose reuse protections may not "
                           + "apply.")
        }
    }

    /// The two closures TruePadUI deliberately cannot supply for itself.
    static func wire() {
        // The comparison wordlist lives with the protocol that defines the
        // 11-bit index mapping. Rendering returns nil unless EVERY index is in
        // range, so a partial phrase can never reach a ceremony screen.
        CeremonyWords.render = { ComparisonWords.render($0) }

        // A receive-request QR is only drawn after the text decodes and
        // re-encodes to itself. The UI owns "may this be a QR"; the SPT codec
        // owns "is this a canonical request"; this joins them.
        // The predicate itself lives in the CODEC, not here. Writing it out in the
        // composition root meant the shipping copy and the tested copy were two
        // different pieces of code that happened to agree.
        SptConstantsBridge.isCanonicalReceiveRequest = ReceiveRequestCodec.isCanonicalText
    }
}

/// Shown only when storage could not be opened. It says what happened and does
/// not offer a way around it.
struct StorageUnavailableView: View {
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "externaldrive.badge.xmark")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("TruePad cannot start").font(.headline)
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding(32)
        .accessibilityElement(children: .combine)
    }
}
