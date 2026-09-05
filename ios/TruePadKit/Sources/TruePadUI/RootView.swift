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
        .sheet(isPresented: $pads.creating) {
            CreatePadView(model: CreatePadModel(engine: engine))
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
                Label("Pad material normally comes from you. If you let this device "
                      + "generate it, the pad reads NOT ELIGIBLE — permanently.",
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
