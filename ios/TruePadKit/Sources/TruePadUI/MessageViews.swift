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
                TextField("Write your message", text: $model.plaintext, axis: .vertical)
                    .lineLimit(3...10)
                    .accessibilityLabel("The message to send. It is encrypted with pad material "
                                        + "that is then destroyed.")
                Picker("Send as", selection: $model.role) {
                    Text("A").tag(Party.a)
                    Text("B").tag(Party.b)
                }
                .pickerStyle(.segmented)
            }
            Section {
                Button("Encrypt and consume the pad") { model.send() }
                    .disabled(model.plaintext.isEmpty)
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
                Picker("Open as", selection: $model.role) {
                    Text("A").tag(Party.a)
                    Text("B").tag(Party.b)
                }
                .pickerStyle(.segmented)
            }
            Section {
                Button("Open") { model.open() }
                    .disabled(model.envelopeText.isEmpty)
            } footer: {
                Text("A message that does not verify costs one verification attempt and consumes "
                     + "no pad material. That is the price of a bounded forgery guarantee.")
            }

            if let plaintext = model.plaintext {
                Section("Message") {
                    Text(plaintext)
                        .textSelection(.enabled)
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
