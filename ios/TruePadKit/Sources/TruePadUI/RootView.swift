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
        // BEFORE ANY BAR EXISTS. See TruePadChrome.applyOnce.
        TruePadChrome.applyOnce()
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
            // "INBOX", NOT "RECEIVE". The destination is the place inbound things
            // arrive — a receive code you publish, a sealed pad someone sends
            // back — and naming it for the verb made it read as a single action.
            // The screen inside still says "Receive a pad", "Create a receive
            // code" and "Open a sealed pad": those are the actions, and they are
            // unchanged. The Android edition carries the same three labels.
            .tabItem { Label("Inbox", systemImage: "tray.and.arrow.down") }

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
            // OWNED BY SWIFTUI, NOT BUILT HERE. See CreatePadSheet.
            CreatePadSheet(engine: engine) { pads.noteCreated($0) }
                .modifier(PrivacyCoverModifier(visibility: visibility))
        }
        .modifier(PrivacyCoverModifier(visibility: visibility))
        // DARK, DELIBERATELY AND EVERYWHERE.
        //
        // Asked for directly by the operator, who found the iPhone app read as a
        // test harness next to the Android one. It is applied at the ROOT so
        // sheets and pushed screens inherit it — a half-dark app is worse than a
        // light one.
        //
        // THE COLOURS ARE NOW TRUEPAD'S, NOT THE SYSTEM'S. This used to say the
        // app selected the system's dark palette rather than hard-coding colours,
        // "so every contrast ratio remains the one Apple tuned". That stopped
        // being true when Theme.swift landed: the palette is the product's, taken
        // from the Android edition, and its contrast is the product's
        // responsibility rather than Apple's. `.preferredColorScheme(.dark)` is
        // still set, because the system still draws alerts, keyboards and the
        // share sheet and those must not arrive white.
        //
        // DYNAMIC TYPE IS UNTOUCHED: the type scale is expressed in text styles,
        // not points. See TruePadFont.
        //
        // TWO SURFACES DELIBERATELY STAY LIGHT, and they are the ones a camera has
        // to read: the inline QR sits on its own white card with padding, and the
        // full-screen scan view is pure white with the backlight raised. A dark
        // QR surface would be a visual preference paid for in scan reliability,
        // which the two-device run showed there is no room for.
        .preferredColorScheme(.dark)
        // ONE CALL, AT THE ROOT. Bars, and the tint every remaining system-drawn
        // control inherits. See TruePadChrome.
        .truePadChrome()
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

/// THE CREATE SHEET'S MODEL, OWNED FOR THE LIFETIME OF THE PRESENTATION.
///
/// This view exists for one reason: `CreatePadModel` must survive body
/// re-evaluation, and it did not.
///
/// It used to be built inline in the sheet's content closure —
/// `CreatePadView(model: CreatePadModel(engine: engine))` — while `CreatePadView`
/// holds it as `@ObservedObject`, which owns nothing. `TruePadRootView.body`
/// reads `@Environment(\.scenePhase)` to drive the privacy cover, so EVERY
/// background/foreground transition re-evaluated the body, re-ran that closure,
/// and handed the view a brand-new model. The asymmetry was visible in the same
/// file: `pads` and `receive` are `@StateObject`; only this one was not.
///
/// WHY THAT BECAME A SECURITY PROBLEM RATHER THAN AN ANNOYANCE. While the model
/// held only a label and a size, a reset lost typing. Once the external-material
/// picker worked, the discarded state included `chosenFileBytes` — and the fresh
/// model comes back with `source == .device`. An operator who chose their own
/// material, backgrounded the app to fetch the file from Files, and returned
/// would be looking at "Generated securely on this iPhone" with their selection
/// silently gone. Creating then would produce a device-CSPRNG pad, permanently
/// NOT ELIGIBLE, that they believed was built from their own material.
///
/// TruePad must never silently substitute the device generator for material the
/// operator supplied. `@StateObject` is what makes that structural: SwiftUI
/// allocates the model once for this presentation and hands the same instance
/// back on every rebuild. A new presentation gets a new sheet identity and
/// therefore a fresh model, which is correct — starting a new pad starts clean.
struct CreatePadSheet: View {
    @StateObject private var model: CreatePadModel
    /// Told which pad was made, so the screen behind can offer the next step.
    private let onCreated: (String) -> Void

    init(engine: Engine, onCreated: @escaping (String) -> Void) {
        // The autoclosure runs ONCE, on first appearance. That is the whole point:
        // passing an already-built instance would put ownership back where it was.
        _model = StateObject(wrappedValue: CreatePadModel(engine: engine))
        self.onCreated = onCreated
    }

    var body: some View {
        CreatePadView(model: model)
            // The two-parameter onChange is iOS 17; the package floor is iOS 16.
            .onChange(of: model.createdPairId) { id in
                if let id { onCreated(id) }
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
                        .fill(TruePadPalette.ground)
                        .ignoresSafeArea()
                    VStack(spacing: 10) {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 40))
                            .foregroundStyle(TruePadPalette.muted)
                        Text("TruePad")
                            .font(TruePadFont.sectionTitle)
                            .foregroundStyle(TruePadPalette.ink)
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
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            ScreenTitle("About TruePad")

            SectionTitle("What protects what")
            // THE CLAIMS BOUNDARY, IN THREE SENTENCES. Never compressed, never
            // reordered, and never softened to fit a layout.
            VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                BodyText("Post-quantum cryptography protects pad DELIVERY.")
                BodyText("The one-time pad encrypts messages.")
                BodyText("Wegman–Carter authenticates messages.")
            }

            Rule()

            SectionTitle("What TruePad does not do")
            // NO ICONS. The Android edition's vocabulary has none, and a glyph
            // beside a claim is decoration that a screen reader either repeats or
            // drops. The words are the whole content.
            VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
                BodyText("No server, no account, no transport of its own")
                // "No logging" means nothing is emitted to the system log or to
                // any third party. Each pad DOES keep an on-disk journal.log —
                // that is the durable consumption record, and conflating the two
                // would read as "nothing is written down".
                BodyText("No analytics, no crash reporting, nothing written to the system log")
                // THE SCOPE OF THAT SENTENCE, said on screen rather than left to
                // the comment above it. TruePad's own source emits nothing — the
                // leakage audit enforces that — but TruePad's own source is not
                // the whole of what runs in its process: scanning a receive code
                // drives the platform camera libraries, which write their own
                // ordinary diagnostic lines. Anyone checking this claim with
                // Console open sees them, and a flat "nothing written to the
                // system log" is contradicted by the first line they read. What
                // is true is that none of it is about them. Word for word the
                // Android edition's `Claims.LOG_SCOPE`.
                FaintText("TruePad itself writes nothing to the system log. The camera and "
                          + "barcode libraries it uses to scan a code write their own ordinary "
                          + "diagnostic lines there; none of it carries your pads, your "
                          + "messages, or anything about them.")
                // NOT "it never invents pad material". The Create screen offers
                // generating from this device's CSPRNG, and saying otherwise here
                // would be contradicted by the app's own second screen.
                // ACCURATE ABOUT THE DEFAULT, which changed. This used to say pad
                // material "normally comes from you", and that stopped being true
                // when the create screen began defaulting to the device
                // generator. Both halves are still stated; only which one is
                // normal has been corrected.
                BodyText("Pads are normally generated by this device. That is a strong practical "
                         + "source, and it reads NOT ELIGIBLE for the strongest deployment "
                         + "classification — permanently. Supplying your own physical random "
                         + "material is the path to that classification.")
            }

            Rule()

            SectionTitle("Destruction")
            FaintText(VerbatimText.destructionLimitation)

            Rule()

            SectionTitle("Source material")
            FaintText(VerbatimText.sourceVerdict)

            Rule()

            SectionTitle("Codes and files")
            FaintText(VerbatimText.qrCarriesOnlyPublicData)
            FaintText(VerbatimText.shareSheetIsACarrier)
        }
        .truePadScreen()
        // NO NAVIGATION-BAR TITLE ON A ROOT TAB.
        //
        // Two reasons, and the second is the one that forced it. The Android
        // screens carry their title in the CONTENT, under the back link, and a
        // large iOS title is the closest native equivalent — so a content
        // `ScreenTitle` is the parity-correct place for it either way.
        //
        // And the large title did not render. On a themed bar it reserved its
        // full height and drew no text at all, leaving roughly 285 points of
        // empty band above every root screen. Rather than fight a bar whose
        // behaviour differs between the iOS 18 handset and the iOS 26
        // simulator, the title moved to where it was going anyway and the bar
        // is hidden. Pushed screens keep their bars, their inline titles and
        // their back buttons, so swipe-back is untouched.
        .toolbar(.hidden, for: .navigationBar)
    }
}
#endif
