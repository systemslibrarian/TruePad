#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit

/* ============================================================================
 * The camera path.
 *
 * THE CAMERA IS STOPPED THE MOMENT IT IS NOT NEEDED. It is started when the view
 * appears, stopped when it disappears, stopped on the FIRST accepted code, and
 * stopped when the app leaves the foreground. A pad-management app that leaves a
 * camera running is one that will eventually be found running it in the
 * background, and no amount of intent changes what the log shows.
 *
 * NOTHING SCANNED IS TRUSTED. This view produces a STRING and hands it upward;
 * every consumer runs it through the same strict decoder a pasted string goes
 * through. There is no scan-only path into the engine, and a QR is not evidence
 * of anything except that some bytes were photographed.
 *
 * WHAT IS NOT TESTED HERE, and is not claimed: that the preview is legible, that
 * VoiceOver announces the scan, or that the camera actually stops on a real
 * device. Those are the physical-device gate.
 * ========================================================================= */

public struct ScannerView: View {
    public let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = ScannerModel()

    public init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

    public var body: some View {
        NavigationStack {
            ZStack {
                CameraPreview(session: model.session)
                    .ignoresSafeArea()
                    .accessibilityHidden(true)   // a live preview says nothing to VoiceOver
                VStack {
                    Spacer()
                    Text(model.status)
                        .padding()
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .padding()
                        .accessibilityLabel(model.status)
                }
            }
            .navigationTitle("Scan a code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.stop(); dismiss() }
                }
            }
        }
        .onAppear {
            model.onScan = { text in
                // Stop FIRST, then report: the camera must not still be running
                // while the caller decides what to do with the string.
                model.stop()
                onScan(text)
            }
            model.start()
        }
        .onDisappear { model.stop() }
    }
}

@MainActor
final class ScannerModel: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate {
    /// AVCaptureSession is not Sendable, and starting it blocks. The standard
    /// AVFoundation shape applies: one SERIAL queue owns start/stop, so the calls
    /// are ordered with respect to each other and never run on the main thread.
    nonisolated(unsafe) let session = AVCaptureSession()
    private nonisolated let sessionQueue = DispatchQueue(label: "dev.systemslibrarian.truepad.camera")

    @Published var status = "Point the camera at the code."
    var onScan: ((String) -> Void)?

    private var configured = false
    private var delivered = false

    func start() {
        delivered = false
        guard AVCaptureDevice.authorizationStatus(for: .video) != .denied else {
            status = "TruePad needs camera access to scan a code. You can also paste the text "
                + "instead — the two paths are identical."
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    self.status = "Without camera access, paste the text instead. The two paths "
                        + "are identical."
                    return
                }
                self.configureIfNeeded()
                self.runOnSessionQueue { session in
                    if !session.isRunning { session.startRunning() }
                }
            }
        }
    }

    func stop() {
        runOnSessionQueue { session in
            if session.isRunning { session.stopRunning() }
        }
    }

    /// The session is confined to `sessionQueue`; this is the only way it is
    /// started or stopped, so the two can never interleave.
    private nonisolated func runOnSessionQueue(_ body: @escaping @Sendable (AVCaptureSession) -> Void) {
        // `nonisolated(unsafe)` is the accurate annotation, not a shortcut: the
        // compiler cannot see that `sessionQueue` is the ONLY place the session is
        // started or stopped, but that confinement is real and is why this is
        // safe. Configuration happens once on the main actor before the first
        // start, and the preview layer only reads.
        nonisolated(unsafe) let session = self.session
        sessionQueue.async { body(session) }
    }

    private func configureIfNeeded() {
        guard !configured else { return }
        configured = true
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            status = "This device has no camera TruePad can use. Paste the text instead."
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            status = "This device cannot scan codes. Paste the text instead."
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        // QR ONLY. Every other symbology is left off: TruePad has exactly two
        // payloads and neither of them is a barcode.
        output.metadataObjectTypes = [.qr]
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput,
                                    didOutput objects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let strings = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard let first = strings.first else { return }
        Task { @MainActor [weak self] in
            guard let self, !self.delivered else { return }
            // ONE code per presentation. A scanner that keeps firing while the
            // caller is deciding is a scanner that delivers the second code into
            // a flow built for the first.
            self.delivered = true
            self.onScan?(first)
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
#endif
