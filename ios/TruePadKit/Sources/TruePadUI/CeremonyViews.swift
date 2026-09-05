#if os(iOS)
import SwiftUI
import UniformTypeIdentifiers
import TruePadCore
import TruePadStorage

/* ============================================================================
 * Creating a pad, and the sealed-transfer ceremony.
 *
 * These two screens are where the operator makes the decisions that TruePad
 * cannot make for them, so both are written to say what is being decided rather
 * than to move the flow along:
 *
 *   - CREATE says where pad material comes from, and refuses to pretend the
 *     device CSPRNG is ceremony-grade. It is offered, because a pad made that way
 *     is still a working pad, and it is labelled with the verdict it will
 *     actually carry — NOT ELIGIBLE — before the operator commits to it.
 *   - The CEREMONY says what comparing the words does and does not establish. The
 *     app records only that the operator said they matched. It cannot check that
 *     they did, and it does not imply otherwise.
 * ========================================================================= */

// MARK: - creating a pad

public struct CreatePadView: View {
    @ObservedObject public var model: CreatePadModel
    @Environment(\.dismiss) private var dismiss

    public init(model: CreatePadModel) { self.model = model }

    static let fileSourceNote =
        "The file you choose IS the pad. TruePad cannot check where it came from — it records "
        + "what you declare, and a declaration is not evidence."

    public var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("What is this pad for?", text: $model.label)
                        .accessibilityLabel("A name for this pad. It stays on this device.")
                }

                // SIZE IS THE ONLY DECISION THE NORMAL PATH ASKS FOR. The raw
                // byte and record counts still exist and still reach the engine
                // unchanged — they are two fields further down, under Advanced,
                // instead of the first thing on the screen.
                Section {
                    ForEach(PadSize.allCases, id: \.self) { size in
                        Button { model.select(size) } label: {
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(size.title)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.primary)
                                    Text(size.blurb)
                                        .font(.footnote).foregroundStyle(.secondary)
                                    Text(size.capacityLine)
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 12)
                                if model.selectedSize == size {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                        .accessibilityHidden(true)
                                }
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(size.title). \(size.blurb) \(size.capacityLine)")
                        .accessibilityAddTraits(model.selectedSize == size ? [.isButton, .isSelected] : .isButton)
                    }
                } header: {
                    Text("Size")
                } footer: {
                    if model.selectedSize == nil {
                        Text("Custom size, set under Advanced.")
                    }
                }

                // The plain fact leads. The classification it implies is one
                // disclosure away — present, unsoftened, and no longer the first
                // thing a new operator reads.
                if model.source == .device {
                    Section {
                        Label(SourceClaimText.deviceHeadline, systemImage: "lock.shield")
                            .accessibilityLabel(SourceClaimText.deviceHeadline)
                        Text(SourceClaimText.deviceSupporting)
                            .font(.footnote).foregroundStyle(.secondary)
                        securityDetails
                    }
                }

                Section {
                    Button("Create pad") { model.create() }
                        .disabled(!model.canCreate)
                        .accessibilityHint("Creates the pad on this device.")
                } footer: {
                    Text(VerbatimText.sourceVerdict)
                }

                advanced
            }
            .navigationTitle("New pad")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            // The two-parameter onChange is iOS 17; the package floor is iOS 16,
            // and the floor is a product decision rather than a compile fix.
            .onChange(of: model.created) { created in if created { dismiss() } }
            .alert("TruePad refused", isPresented: $model.showingRefusal) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.refusalMessage ?? "")
            }
        }
    }

    /// LEVEL TWO. What the device generator is, and what the evaluator will say
    /// about it — the same claims the Browser Edition makes, in the same words,
    /// one tap down instead of shouted before the operator has chosen anything.
    @ViewBuilder private var securityDetails: some View {
        DisclosureGroup("Security details") {
            VStack(alignment: .leading, spacing: 10) {
                Text(SourceClaimText.deviceDetail)
                Text(SourceClaimText.notEligibleMeaning)
                    .font(.footnote.weight(.medium))
                Text(SourceClaimText.notEligibleReason)
                Text(SourceClaimText.notEligibleDoesNotMean)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.vertical, 2)
        }
        .accessibilityHint("Explains how this pad's randomness is classified.")
    }

    /// LEVEL THREE. The expert source ceremony and the raw capacity fields.
    /// Nothing here is new and nothing here is weakened — it is the same ceremony
    /// with the same refusals, moved out of the normal path's way.
    @ViewBuilder private var advanced: some View {
        Section {
            DisclosureGroup("Advanced") {
                Picker("Randomness", selection: $model.source) {
                    Text("Generate for me").tag(CreatePadModel.Source.device)
                    Text("Use external random material").tag(CreatePadModel.Source.file)
                }
                .pickerStyle(.inline)

                if model.source == .file {
                    Text(SourceClaimText.externalShort)
                        .font(.footnote).foregroundStyle(.secondary)
                    Button(model.chosenFileName ?? "Choose a file…") { model.choosingFile = true }
                    Text(Self.fileSourceNote)
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Stepper("Message bytes: \(model.encryptionBytes)",
                        value: $model.encryptionBytes, in: 256...4_194_304, step: 256)
                    .accessibilityLabel("Total bytes of message material: \(model.encryptionBytes).")
                Stepper("Messages: \(model.authRecords)",
                        value: $model.authRecords, in: 4...4096, step: 4)
                    .accessibilityLabel("Number of messages this pad can carry: \(model.authRecords).")
                LabeledContent("Material needed", value: "\(model.requiredSourceBytes) bytes")
                    .accessibilityLabel("Each source must supply \(model.requiredSourceBytes) bytes.")
            }
        }
    }
}

// MARK: - the sealed-transfer ceremony

/// The RECIPIENT's side: publish a one-time request, then wait.
public struct ReceiveRequestView: View {
    @ObservedObject public var model: ReceiveRequestModel

    public init(model: ReceiveRequestModel) { self.model = model }

    public var body: some View {
        Form {
            if let request = model.request {
                Section("Show this to the sender") {
                    if let qr = model.qr { QrCodeView(payload: qr) }
                    Text(request.tpr2Text)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .accessibilityLabel("Your receive code, as text you can copy.")
                }
                Section("Compare these 12 words") {
                    WordGrid(model.requestWords, expecting: CeremonyPhrase.requestWordCount)
                    Text(VerbatimText.wordComparisonIsADeclaration)
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Text("This code expires \(request.expiresAt).")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Cancel this code", role: .destructive) { model.cancel() }
                } footer: {
                    Text("The key behind this request works exactly once. Cancelling it is "
                         + "permanent, and so is using it.")
                }
            } else {
                // WHAT BECAME OF THE LAST ONE. Every state here is terminal, and
                // none of them offers a way back — the only recovery is a new
                // request, which is the button directly below. Saying so matters
                // most after a REJECTION, which is a decision the operator made
                // deliberately and should see acknowledged.
                if let outcome = model.outcome,
                   let headline = ReceiveRequestOutcomeText.headline(outcome) {
                    Section {
                        Text(headline).font(.headline)
                        if let detail = ReceiveRequestOutcomeText.detail(outcome) {
                            Text(detail).font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("Dismiss") { model.acknowledgeOutcome() }
                    }
                    .accessibilityElement(children: .contain)
                }
                Section {
                    Button("Create a receive code") { model.create() }
                } footer: {
                    Text("This makes a one-time key on this device and shows the sender a public "
                         + "request. The key never leaves.")
                }
            }

            // THE RECEIVER HALF OF THE CEREMONY. `OpenSealedView` existed and was
            // tested, and nothing in the app ever presented it — so a pad sealed to
            // this device's own request could not be opened. Found by the
            // two-device physical run.
            Section {
                NavigationLink("Open a sealed pad") {
                    OpenSealedView(model: OpenSealedModel(engine: model.engine))
                }
            } header: {
                Text("When the sealed file arrives")
            } footer: {
                Text("Choose the file the sender gave you. Nothing is saved until you have "
                     + "compared the eight words with them.")
            }
        }
        .navigationTitle("Receive a pad")
        // RE-READ ON EVERY APPEARANCE, including on the way back from opening a
        // sealed pad. Without this the screen kept advertising the request that
        // open had just consumed, with a Cancel button that could only throw.
        .onAppear { model.refresh() }
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}

/// The twelve or eight comparison words, laid out so they can be READ ALOUD in
/// order without losing your place.
struct WordGrid: View {
    /// ALREADY RENDERED. The view takes words, not indices, so the wordlist stays
    /// in the SPT module and TruePadUI does not link it — the UI has no business
    /// reaching the KEM, and that separation is asserted by test.
    let rendered: [String]
    /// How many words this step MUST show. A phrase of the wrong length is not a
    /// shorter phrase; it is a broken ceremony.
    let expected: Int

    init(_ rendered: [String], expecting expected: Int) {
        self.rendered = rendered
        self.expected = expected
    }

    var body: some View {
        if !CeremonyPhrase.isComplete(rendered, expecting: expected) {
            // AN INCOMPLETE PHRASE IS NOT SHOWN AT ALL, and says so.
            //
            // The first version rendered whatever it was given, so a wordlist
            // that failed to load produced an EMPTY list — and the operator was
            // still offered "All twelve words matched". Confirming a comparison
            // that was never displayed is the worst outcome this screen can
            // produce, and it was reachable.
            Label("These words cannot be displayed, so this transfer cannot be "
                  + "confirmed on this device.", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .font(.callout)
                .accessibilityLabel("The comparison words cannot be displayed. This transfer "
                                    + "cannot be confirmed on this device.")
        } else {
            grid
        }
    }

    private var grid: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(rendered.enumerated()), id: \.offset) { position, word in
                HStack(alignment: .firstTextBaseline) {
                    Text("\(position + 1).")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 28, alignment: .trailing)
                    Text(word).font(.body.monospaced())
                }
                // Numbered in the label too: "word four is anchor" is checkable
                // aloud in a way that a bare list of twelve words is not.
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Word \(position + 1): \(word)")
            }
        }
    }
}

/// The SENDER's side: review a request, declare the words matched, seal.
public struct SealView: View {
    @ObservedObject public var model: SealModel
    @State private var scanning = false

    public init(model: SealModel) { self.model = model }

    public var body: some View {
        Form {
            if model.review == nil {
                Section("The recipient's request") {
                    TextField("Paste it here", text: $model.pastedRequest, axis: .vertical)
                        .lineLimit(2...6)
                        .font(.footnote.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Scan it instead…") { scanning = true }
                    Button("Review this request") { model.review(model.pastedRequest) }
                        .disabled(model.pastedRequest.isEmpty)
                }
            }

            if let review = model.review {
                Section("Compare these twelve words with the recipient") {
                    WordGrid(model.requestWords, expecting: CeremonyPhrase.requestWordCount)
                    Text(VerbatimText.wordComparisonIsADeclaration)
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("All twelve words matched") { model.confirm() }
                        .disabled(model.confirmed || !model.requestWordsComplete)
                } footer: {
                    Text("Say this only if you compared them over a channel you already trust — a "
                         + "phone call you placed, or in person. TruePad records that you said so; "
                         + "it cannot check it.")
                }
                if model.confirmed {
                    Section {
                        Button("Seal this pad and send it") { model.seal() }
                    } footer: {
                        Text("A sealed transfer sends the WHOLE pad, and this pad can only leave "
                             + "once. Its delivery is protected by post-quantum cryptography, not "
                             + "by the one-time pad — so the pad will read NOT ELIGIBLE at both "
                             + "ends, permanently.")
                    }
                }
            }

            if let sealed = model.sealed {
                Section("Compare these 8 words") {
                    WordGrid(model.confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)
                }
                Section {
                    Button(sealed.reshared ? "Hand over the same sealed file…"
                                           : "Hand over the sealed file…") { model.share() }
                } header: {
                    // ONE REQUEST, ONE PAD, ONE COMMITTED PACKAGE. Coming back to
                    // a pad that was already sealed returns the SAME bytes — the
                    // engine re-reads the committed package rather than sealing
                    // again. Saying so matters: an operator who could not tell the
                    // difference might reasonably think a second handoff was being
                    // created, which is exactly what must never happen.
                    if sealed.reshared {
                        Text("Already sealed")
                    }
                } footer: {
                    if sealed.reshared {
                        Text("This is the same sealed file you made before, not a new one. "
                             + "Sealing happened once, and the eight words above are the ones "
                             + "from that transfer.\n\n"
                             + VerbatimText.shareSheetIsACarrier)
                    } else {
                        Text(VerbatimText.shareSheetIsACarrier)
                    }
                }
            }
        }
        .navigationTitle("Send a pad")
        .sheet(isPresented: $scanning) {
            ScannerView { scanned in
                model.pastedRequest = scanned
                scanning = false
                model.review(scanned)
            }
        }
        .sheet(item: $model.fileToShare,
               onDismiss: { model.discardSharedFile() }) { file in ShareSheet(items: [file.url]) }
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}

/// The RECIPIENT's side of opening what arrived.
public struct OpenSealedView: View {
    @ObservedObject public var model: OpenSealedModel

    public init(model: OpenSealedModel) { self.model = model }

    public var body: some View {
        Form {
            if model.session == nil {
                Section {
                    Button("Choose the sealed file…") { model.choosingFile = true }
                } footer: {
                    Text("Nothing is saved until you have compared the eight words. Opening the "
                         + "file does not commit anything.")
                }
            }

            if let session = model.session {
                Section("Check these eight words against the sender") {
                    WordGrid(model.confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)
                    Text(VerbatimText.wordComparisonIsADeclaration)
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("The eight words matched — save this pad") { model.commit() }
                        .disabled(!model.confirmationWordsComplete)
                } footer: {
                    Text("Saving uses up this receive request. If saving fails after that point "
                         + "the transfer is lost and the request cannot be reused — ask for a new "
                         + "pad rather than retrying. That is deliberate: a request that could be "
                         + "reused is a key that could be used twice.")
                }
                Section {
                    Button("These words do NOT match — reject", role: .destructive) {
                        model.reject()
                    }
                } footer: {
                    Text("Rejecting cancels the request permanently. Nothing is saved.")
                }
            }
        }
        // ON THE VIEW ROOT, not on the Button. Attached to a Button inside a
        // Form's Section it simply never presented — the screen stayed put and
        // the receiver could not choose a file at all.
        .fileImporter(isPresented: $model.choosingFile,
                      allowedContentTypes: [.data],
                      allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                // A picked file lives outside the sandbox until it is opened
                // under a security scope.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) {
                    model.open(packageBytes: [UInt8](data))
                } else {
                    model.refuse(SptRefusalText.unreadableFile)
                }
            case .failure:
                // Cancelling is not a refusal and must not look like one.
                break
            }
        }
        .navigationTitle("Open a sealed pad")
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}
#endif
