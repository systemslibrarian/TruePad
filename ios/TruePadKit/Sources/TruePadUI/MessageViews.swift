#if os(iOS)
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import TruePadCore
import TruePadStorage
#if canImport(UIKit)
import UIKit
#endif

/* ============================================================================
 * Writing a message, opening one, and the two carriers: a QR code and the share
 * sheet.
 *
 * A QR here renders a `QrPayload` and NOTHING else. The type cannot be
 * constructed from arbitrary text — `QrPayloadBuilder` decodes and re-encodes
 * first — so "what may be in a QR" is answered once, in a tested file, and a view
 * physically cannot ask this to render a pad.
 * ========================================================================= */


/// Hoisted out of the view bodies. The type-checker cannot solve a long string
/// concatenation inside a deeply nested SwiftUI builder in reasonable time, and
/// it says so rather than compiling slowly — this file already carries one such
/// hoist for the same reason.
private func roleAnnouncement(_ role: Party?, verb: String) -> String {
    let who = role == .a ? "A" : "B"
    return "You are party \(who) for this pad. TruePad derived that from how the pad was "
        + "created, so it is not a choice to make here. It decides which half of the pair "
        + "\(verb) uses."
}

public struct SendView: View {
    @ObservedObject public var model: SendModel

    public init(model: SendModel) { self.model = model }

    public var body: some View {
        Form {
            Section("Message") {
                // AUTOCORRECTION AND AUTOCAPITALISATION OFF, on the one field in
                // the app that holds the plaintext the pad exists to protect.
                //
                // iOS keeps a keyboard lexicon at /private/var/mobile/Library/
                // Keyboard/ — outside the sandbox, outside the store's protection
                // class, outside the container's backup exclusion, and beyond
                // `destroy`. Every other text field here already sets these
                // traits; this one did not, and it is the one that matters most.
                //
                // WHAT THIS DOES NOT CLAIM. Apple documents these as input-
                // correctness traits, not as the switch that excludes text from
                // learning. TruePad can say the traits are set. It CANNOT say
                // nothing was learned — that is a statement about iOS internals
                // this project cannot observe, and claiming it would be exactly
                // the over-reach the governing rules forbid.
                TextField("Write your message", text: $model.plaintext, axis: .vertical)
                    .lineLimit(3...10)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("The message to send. It is encrypted with pad material "
                                        + "that is then destroyed.")
                // THE PICKER IS SHOWN ONLY WHEN THE PAD CANNOT SAY.
                //
                // It used to be offered always, defaulted to A, and independently
                // of the Open screen's picker — so an importing device opened
                // correctly at ITS default and then sent on party A's half. Two
                // devices holding one pair both burned A->B. See `PartyRole`.
                if model.roleWasDerived {
                    LabeledContent("Sending as", value: model.role == .a ? "A" : "B")
                        .accessibilityLabel(roleAnnouncement(model.role, verb: "sending"))
                } else {
                    Text(PartyRole.unknownOriginPrompt)
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Send as", selection: $model.role) {
                        Text("A").tag(Optional(Party.a))
                        Text("B").tag(Optional(Party.b))
                    }
                    .pickerStyle(.segmented)
                }
            }
            Section {
                Button("Encrypt and consume the pad") { model.send() }
                    .disabled(!model.canSend)
            } footer: {
                Text("The pad material this uses is destroyed as the message is written. It cannot "
                     + "be recovered, and it will never be used again.")
            }

            if let envelope = model.envelopeText {
                Section("Give this to the other person") {
                    if let qr = model.qr {
                        QrCodeView(payload: qr)
                    }
                    Text(envelope)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .accessibilityLabel("The encrypted message, as text you can copy.")
                }
            }
        }
        .navigationTitle("Write a message")
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}

public struct OpenView: View {
    @ObservedObject public var model: OpenModel
    @State private var scanning = false

    public init(model: OpenModel) { self.model = model }

    public var body: some View {
        Form {
            Section("The message you received") {
                TextField("Paste it here", text: $model.envelopeText, axis: .vertical)
                    .lineLimit(3...10)
                    .font(.footnote.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Scan a code instead…") { scanning = true }
                if model.roleWasDerived {
                    LabeledContent("Opening as", value: model.role == .a ? "A" : "B")
                        .accessibilityLabel(roleAnnouncement(model.role, verb: "opening"))
                } else {
                    Text(PartyRole.unknownOriginPrompt)
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Open as", selection: $model.role) {
                        Text("A").tag(Optional(Party.a))
                        Text("B").tag(Optional(Party.b))
                    }
                    .pickerStyle(.segmented)
                }
            }
            Section {
                Button("Open") { model.open() }
                    .disabled(!model.canOpen)
            } footer: {
                Text("A message that does not verify costs one verification attempt and consumes "
                     + "no pad material. That is the price of a bounded forgery guarantee.")
            }

            if let plaintext = model.plaintext {
                Section("Message") {
                    // NO `.textSelection(.enabled)` HERE, deliberately.
                    //
                    // Selection routes text to the GENERAL pasteboard, which is
                    // Universal-Clipboard-eligible: the decrypted message would
                    // become copyable to any Mac or iPad on the same Apple ID.
                    // `EgressPolicy.mayCopyToClipboard(.plaintext)` is false, and
                    // this is that policy actually applied rather than merely
                    // declared — it was dead code no view called.
                    //
                    // The envelope on the Send screen KEEPS selection: it is
                    // `.publicText`, and copying it is the whole workflow.
                    Text(plaintext)
                        .accessibilityLabel("The opened message: \(plaintext)")
                    if let note = model.skippedNote {
                        Text(note).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Open a message")
        .sheet(isPresented: $scanning) {
            ScannerView { scanned in
                model.envelopeText = scanned
                scanning = false
            }
        }
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}

// MARK: - the QR carrier

/// Renders a `QrPayload`, and only a `QrPayload`.
///
/// This view cannot be handed arbitrary text: the type it takes can only be
/// produced by `QrPayloadBuilder`, which decodes and re-encodes first. That is
/// the whole design — "what may be in a QR" is decided once, in a tested file,
/// rather than at every call site.
public struct QrCodeView: View {
    public let payload: QrPayload
    @State private var enlarged = false

    public init(payload: QrPayload) { self.payload = payload }

    public var body: some View {
        VStack(spacing: 12) {
            #if canImport(UIKit)
            if let rendered = Self.renderModules(payload.text) {
                let image = rendered.image
                // TAP TO ENLARGE. The inline code is NOT the scan path.
                //
                // Found on two real handsets: a receive request is ~1652 bytes,
                // which is 149 modules across even at the lowest redundancy. At
                // 320 points that is about 2 points per module, and an Android
                // camera reading an iPhone screen could not resolve it. The code
                // rendered perfectly and still could not be scanned.
                //
                // What fixes it is physical size and contrast, not the encoder:
                // fill the screen's shortest side, on white, at an integer size
                // so module edges stay crisp, and raise the backlight while it is
                // up. The payload is public TPR2, so nothing is exposed by
                // showing it large.
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 320)
                    .accessibilityLabel("A QR code. " + VerbatimText.qrCarriesOnlyPublicData)
                    .accessibilityHint("Opens the code full screen so the other phone can scan it.")
                    .onTapGesture { enlarged = true }
                Button("Show it full screen to be scanned") { enlarged = true }
                    .font(.callout)
            } else {
                Text("This code could not be drawn. Use the text instead.")
                    .foregroundStyle(.secondary)
            }
            #endif
            Text(VerbatimText.qrCarriesOnlyPublicData)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        #if canImport(UIKit)
        .fullScreenCover(isPresented: $enlarged) {
            if let r = Self.renderModules(payload.text) {
                FullScreenQrView(image: r.image, modules: r.modules)
            }
        }
        #endif
    }

    #if canImport(UIKit)
    /// CoreImage, on-device, with no network and no third-party generator. The
    /// highest error correction the payload allows, because these are read off a
    /// screen at an angle in bad light.
    /// The symbol at ONE PIXEL PER MODULE, with its module count.
    ///
    /// Deliberately NOT pre-scaled. A QR is a grid, and the decoder is looking
    /// for that grid: if the image is scaled by a non-integer factor — 1390 pixels
    /// shown across 1170 — then with nearest-neighbour some modules land on 8
    /// pixels and their neighbours on 9, the grid stops being uniform, and the
    /// finder patterns stop measuring what they are supposed to measure. Handing
    /// back 1:1 lets the view choose a WHOLE-NUMBER pixels-per-module.
    static func renderModules(_ text: String) -> (image: UIImage, modules: Int)? {
        let data = Data(text.utf8)
        // Readability-first: see QrCorrection. A dense code the other phone
        // cannot read is not a working ceremony, however much redundancy it has.
        let chosen = QrCorrection.level(forByteCount: data.count) ?? "L"
        let levels = [chosen] + QrCorrection.capacities.map(\.level).filter { $0 != chosen }
        for level in levels {
            let filter = CIFilter.qrCodeGenerator()
            filter.message = data
            filter.correctionLevel = level
            guard let output = filter.outputImage else { continue }
            let context = CIContext()
            guard let cg = context.createCGImage(output, from: output.extent) else { continue }
            return (UIImage(cgImage: cg), cg.width)
        }
        return nil
    }

    static func render(_ text: String) -> UIImage? { renderModules(text)?.image }

    #endif
}

/// THE SCAN PATH. A QR read off one phone's screen by another phone's camera is
/// resolution-limited, so this exists to make the modules as physically large and
/// as high-contrast as the display allows:
///
///   · sized to the screen's SHORTEST side, floored to a whole point so module
///     edges do not land on fractional pixels and blur;
///   · pure white behind it, ignoring the safe area, because the quiet zone and
///     the contrast ratio are what the decoder actually keys on;
///   · `.interpolation(.none)`, so scaling does not smooth the modules;
///   · the backlight raised to full while it is shown, and RESTORED afterwards.
///
/// The payload is public TPR2 — a one-time request key — so showing it large
/// exposes nothing. That is not true of everything in this app, which is why this
/// view is only ever handed a `QrPayload`, a type that only exists after the
/// payload has been re-validated as public.
struct FullScreenQrView: View {
    let image: UIImage
    let modules: Int
    @Environment(\.dismiss) private var dismiss
    @State private var previousBrightness: CGFloat = UIScreen.main.brightness

    /// The empirical floor below which a phone camera reads nothing off a screen.
    /// Reported from a production app that solved this same problem: around 4.5
    /// physical pixels per module decodes nothing, and comfortable reading starts
    /// near 5.7.
    static let usablePixelsPerModule: CGFloat = 5.7

    var body: some View {
        GeometryReader { geo in
            let scale = UIScreen.main.scale
            // WHOLE PIXELS PER MODULE. Flooring is the point: a fractional scale
            // makes neighbouring modules differ in width, and the grid the
            // decoder is looking for stops being a grid.
            let availablePx = floor(min(geo.size.width, geo.size.height) * scale)
            let pxPerModule = max(1, floor(availablePx / CGFloat(modules)))
            let sidePt = (pxPerModule * CGFloat(modules)) / scale
            ZStack {
                // White beyond the safe area: the quiet zone is part of the
                // symbol, and the contrast ratio is what the binarizer keys on.
                Color.white.ignoresSafeArea()
                VStack(spacing: 14) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: sidePt, height: sidePt)
                        .accessibilityLabel("A QR code, full screen. "
                                            + VerbatimText.qrCarriesOnlyPublicData)
                    Text(pxPerModule >= Self.usablePixelsPerModule
                         ? "Hold the other phone's camera in front of this. Tap to close."
                         : "This screen is small for a code this size. Hold the other "
                           + "phone close and steady. Tap to close.")
                        .font(.footnote)
                        .foregroundStyle(.black.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
        }
        .ignoresSafeArea()
        .onAppear {
            previousBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 1.0
        }
        // RESTORED, not left at full.
        .onDisappear { UIScreen.main.brightness = previousBrightness }
    }
}

// MARK: - the share-sheet carrier

#if canImport(UIKit)
/// A CARRIER, not a transport. TruePad hands bytes to whatever the operator
/// picks and cannot tell them what happens next — which is said on screen, not
/// only here.
public struct ShareSheet: UIViewControllerRepresentable {
    public let items: [Any]

    public init(items: [Any]) { self.items = items }

    public func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // The pad bundle must never reach the pasteboard, so the copy action is
        // removed rather than merely discouraged. The policy is the same one
        // EgressPolicy states and PresentationTests asserts.
        controller.excludedActivityTypes = [.copyToPasteboard]
        return controller
    }

    public func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
#endif
