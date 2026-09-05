#if os(iOS)
import SwiftUI
import TruePadStorage

/* ============================================================================
 * The root of the application.
 *
 * The app target's job is to build ONE `Engine` and show this. Everything below
 * is already tested, so the shell has nothing to get wrong except composition —
 * which is the point of putting the root here rather than in the app.
 *
 * TWO CLOSURES MUST BE WIRED before the ceremony works, and both DEFAULT TO
 * REFUSING (`CeremonyWords.render` returns nil, `SptConstantsBridge` returns
 * false). That is deliberate: an unwired build shows no words and renders no
 * request QR, rather than showing plausible wrong ones. `TruePadRootView` cannot
 * wire them itself, because doing so would make TruePadUI link the SPT module.
 * ========================================================================= */

public struct TruePadRootView: View {
    @StateObject private var pads: PadListModel
    @StateObject private var receive: ReceiveRequestModel
    // THE COVER LIVES HERE, not in the app target. A shell that forgot to apply
    // it would be a shell that leaks plaintext to disk, and "every shell must
    // remember" is not a property — it is a hope. Putting it at the root means
    // every consumer of TruePadRootView gets it by construction.
    @Environment(\.scenePhase) private var scenePhase
    private let engine: Engine

    public init(engine: Engine) {
        self.engine = engine
        _pads = StateObject(wrappedValue: PadListModel(engine: engine))
        _receive = StateObject(wrappedValue: ReceiveRequestModel(engine: engine))
    }

    public var body: some View {
        TabView {
            PadListView(model: pads)
                .tabItem { Label("Pads", systemImage: "square.stack.3d.up") }

            NavigationStack {
                ReceiveRequestView(model: receive)
            }
            .tabItem { Label("Receive", systemImage: "tray.and.arrow.down") }

            NavigationStack {
                AboutView()
            }
            .tabItem { Label("About", systemImage: "info.circle") }
        }
        // RELOAD WHEN THE SHEET CLOSES. Creating a pad dismisses the sheet, and
        // nothing re-read the store: `PadListView`'s onAppear does not fire again
        // because the list never went away, it was merely covered. The pad
        // existed on disk and was absent from the screen until the app was
        // force-quit or the list pulled to refresh. Found on a handset — every
        // test that created a pad then looked for it failed here.
        .sheet(isPresented: $pads.creating, onDismiss: { pads.reload() }) {
            // The cover is applied to the sheet's content TOO. An overlay on the
            // TabView does not extend over a presented sheet, so without this the
            // one screen that is modally on top would be the one screen still
            // captured.
            CreatePadView(model: CreatePadModel(engine: engine))
                .modifier(PrivacyCoverModifier(visibility: visibility))
        }
        .modifier(PrivacyCoverModifier(visibility: visibility))
        // DARK, DELIBERATELY AND EVERYWHERE.
        //
        // Asked for directly by the operator, who found the iPhone app read as a
        // test harness next to the Android one. It is applied at the ROOT so
        // sheets and pushed screens inherit it — a half-dark app is worse than a
        // light one — and it works by selecting the system's dark palette rather
        // than by hard-coding colours, so every contrast ratio remains the one
        // Apple tuned and Dynamic Type is untouched.
        //
        // TWO SURFACES DELIBERATELY STAY LIGHT, and they are the ones a camera has
        // to read: the inline QR sits on its own white card with padding, and the
        // full-screen scan view is pure white with the backlight raised. A dark
        // QR surface would be a visual preference paid for in scan reliability,
        // which the two-device run showed there is no room for.
        .preferredColorScheme(.dark)
    }

    /// SwiftUI's `ScenePhase` mapped to the decision type in Presentation.swift,
    /// which is where it can be tested. `@unknown default` is treated as NOT
    /// active: a phase this build does not recognise is exactly when to cover the
    /// screen rather than to guess.
    private var visibility: AppVisibility {
        switch scenePhase {
        case .active: return .active
        case .inactive: return .inactive
        case .background: return .background
        @unknown default: return .inactive
        }
    }
}

/// An opaque cover, shown whenever the scene is not active.
///
/// WHAT IT IS FOR: the image iOS writes to disk when the app leaves the
/// foreground is a render of the view hierarchy, so covering the hierarchy is
/// what changes the file. It is not cosmetic, and it is not about the
/// app-switcher card looking tidy.
///
/// WHAT IT DOES NOT DO: it does not remove snapshots iOS has ALREADY written,
/// and it does not protect against a screenshot the operator takes deliberately
/// while the app is active. Neither is in scope for a cover, and saying so is
/// better than implying the screen is now private in general.
struct PrivacyCoverModifier: ViewModifier {
    let visibility: AppVisibility

    func body(content: Content) -> some View {
        content.overlay {
            if ScreenPrivacy.shouldObscure(visibility) {
                ZStack {
                    // OPAQUE, and drawn beyond the safe area: a translucent or
                    // inset cover still renders the content underneath into the
                    // snapshot.
                    Rectangle()
                        .fill(Color(.systemBackground))
                        .ignoresSafeArea()
                    VStack(spacing: 10) {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text("TruePad").font(.headline)
                    }
                }
                .transition(.identity)
                .accessibilityHidden(true)
            }
        }
    }
}

/// What this app is, and — at least as importantly — what it is not.
///
/// Every sentence here is one the rest of the codebase already commits to. The
/// screen exists so an operator can read the boundary without reading the
/// documentation, because a claim only the docs make is a claim the person
/// holding the phone never sees.
struct AboutView: View {
    var body: some View {
        List {
            Section("What protects what") {
                Text("Post-quantum cryptography protects pad DELIVERY.")
                Text("The one-time pad encrypts messages.")
                Text("Wegman–Carter authenticates messages.")
            }
            .font(.callout)

            Section("What TruePad does not do") {
                Label("No server, no account, no transport of its own",
                      systemImage: "network.slash")
                // "No logging" means nothing is emitted to the system log or to
                // any third party. Each pad DOES keep an on-disk journal.log —
                // that is the durable consumption record, and conflating the two
                // would read as "nothing is written down".
                Label("No analytics, no crash reporting, nothing written to the system log",
                      systemImage: "eye.slash")
                // NOT "it never invents pad material". The Create screen offers
                // generating from this device's CSPRNG, and saying otherwise here
                // would be contradicted by the app's own second screen.
                // ACCURATE ABOUT THE DEFAULT, which changed. This used to say pad
                // material "normally comes from you", and that stopped being true
                // when the create screen began defaulting to the device
                // generator. Both halves are still stated; only which one is
                // normal has been corrected.
                Label("Pads are normally generated by this device. That is a strong practical "
                      + "source, and it reads NOT ELIGIBLE for the strongest deployment "
                      + "classification — permanently. Supplying your own physical random "
                      + "material is the path to that classification.",
                      systemImage: "dice")
            }
            .font(.callout)

            Section("Destruction") {
                Text(VerbatimText.destructionLimitation)
                    .font(.footnote)
            }

            Section("Source material") {
                Text(VerbatimText.sourceVerdict)
                    .font(.footnote)
            }

            Section("Codes and files") {
                Text(VerbatimText.qrCarriesOnlyPublicData).font(.footnote)
                Text(VerbatimText.shareSheetIsACarrier).font(.footnote)
            }
        }
        .navigationTitle("About TruePad")
    }
}
#endif
