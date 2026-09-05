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
                    LabeledContent("Sending as",
                                   value: model.role == .a ? "A" : "B")
                        .accessibilityLabel("You are party "
                                            + (model.role == .a ? "A" : "B")
                                            + " for this pad. TruePad derived that from how the "
                                            + "pad was created, so it is not a choice to make here.")
                } else {
                    Text(PartyRole.unknownOriginPrompt)
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Send as", selection: $model.role) {
                        Text("A").tag(Party?.some(.a))
                        Text("B").tag(Party?.some(.b))
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
                    LabeledContent("Opening as",
                                   value: model.role == .a ? "A" : "B")
                        .accessibilityLabel("You are party "
                                            + (model.role == .a ? "A" : "B")
                                            + " for this pad, derived from how the pad was created.")
                } else {
                    Text(PartyRole.unknownOriginPrompt)
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker("Open as", selection: $model.role) {
                        Text("A").tag(Party?.some(.a))
                        Text("B").tag(Party?.some(.b))
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

    public init(payload: QrPayload) { self.payload = payload }

    public var body: some View {
        VStack(spacing: 12) {
            #if canImport(UIKit)
            if let image = Self.render(payload.text) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 320)
                    .accessibilityLabel("A QR code. " + VerbatimText.qrCarriesOnlyPublicData)
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
    }

    #if canImport(UIKit)
    /// CoreImage, on-device, with no network and no third-party generator. The
    /// highest error correction the payload allows, because these are read off a
    /// screen at an angle in bad light.
    static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "H"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
    #endif
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
