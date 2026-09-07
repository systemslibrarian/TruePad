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
 *
 * APPEARANCE COMES FROM Theme.swift AND NOWHERE ELSE. These screens were rebuilt
 * out of the shared vocabulary — ChoiceRow, Slab, Details, Callout, Rule — and no
 * colour or font size is named here. NOTHING THEY SAY CHANGED: every string, every
 * accessibility label and every verbatim claim is the one that was here before,
 * including the ones that are deliberately long. Wording is never shortened to fit
 * a layout; the layout wraps instead.
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
            VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    SectionTitle("Name")
                    TextField("What is this pad for?", text: $model.label)
                        .truePadField()
                        .accessibilityLabel("A name for this pad. It stays on this device.")
                }

                // SIZE IS THE ONLY DECISION THE NORMAL PATH ASKS FOR. The raw
                // byte and record counts still exist and still reach the engine
                // unchanged — they are two fields further down, under Advanced,
                // instead of the first thing on the screen.
                //
                // A RADIO, WHICH IS WHAT IT ALWAYS WAS. It was a row that showed a
                // tick in the system accent once chosen, so the unchosen rows gave
                // no sign they were choices at all. `ChoiceRow` shows all three
                // states at once, the way the Android screen does. The spoken
                // label and the `.isSelected` trait are unchanged.
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    SectionTitle("Size")
                    ForEach(PadSize.allCases, id: \.self) { size in
                        ChoiceRow(title: size.title,
                                  selected: model.selectedSize == size,
                                  spoken: "\(size.title). \(size.blurb) \(size.capacityLine)",
                                  detail: {
                                      VStack(alignment: .leading, spacing: 2) {
                                          FaintText(size.blurb)
                                          FaintText(size.capacityLine)
                                      }
                                  }) { model.select(size) }
                    }
                    if model.selectedSize == nil {
                        FaintText("Custom size, set under Advanced.")
                    }
                }

                // The plain fact leads. The classification it implies is one
                // disclosure away — present, unsoftened, and no longer the first
                // thing a new operator reads.
                if model.source == .device {
                    Rule()
                    VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                        BodyText(SourceClaimText.deviceHeadline)
                        FaintText(SourceClaimText.deviceSupporting)
                        securityDetails
                    }
                }

                Rule()

                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    PrimaryButton("Create pad") { model.create() }
                        .disabled(!model.canCreate)
                        .accessibilityHint(model.blockingReason
                            ?? "Creates the pad on this device.")
                    // WHY THE BUTTON IS DEAD, WHERE THE BUTTON IS.
                    //
                    // Both readiness sentences were rendered where the field that
                    // caused them lives — inside `Details("Advanced")`, which opens
                    // CLOSED and is BELOW this button. So: open Advanced, tick
                    // "Hide exact message lengths", type 20480 (valid for Medium),
                    // collapse Advanced, then tap "Small" in the always-visible Size
                    // list. The ceiling drops to 16,384, `canCreate` goes false, and
                    // "Create pad" is permanently dead with nothing on the visible
                    // screen saying why — the toggle, the field and the explanation
                    // are all behind the collapsed disclosure. A VoiceOver user got
                    // a disabled button whose only hint described what it would do.
                    //
                    // Android renders the same sentence outside its own Advanced
                    // section, immediately under Create, for exactly this reason.
                    // The sentences are unchanged and still appear beside their
                    // fields as well; this adds the one that is currently blocking.
                    if let why = model.blockingReason {
                        Callout(tone: .warn, title: "Create is not available yet") {
                            BodyText(why)
                        }
                    }
                    FaintText(VerbatimText.sourceVerdict)
                }

                advanced
            }
            .truePadScreen()
            // ON THE VIEW ROOT, not on the Button — the same lesson the Open
            // screen already learned. Attached inside a Form Section it simply
            // never presents.
            //
            // THIS WAS MISSING ENTIRELY. "Choose a file…" set `choosingFile` and
            // nothing observed it, so the external-material path was inert: no
            // picker, `chosenFileBytes` never set, and `canCreate` therefore
            // permanently false. The only route to the strongest deployment
            // classification was a dead end, and the physical suite could not see
            // it because that suite deliberately avoids the file picker.
            .fileImporter(isPresented: $model.choosingFile,
                          allowedContentTypes: [.data],
                          allowsMultipleSelection: false) { result in
                switch result {
                case .success(let urls):
                    guard let url = urls.first else { return }
                    // A picked file lives outside the sandbox until it is opened
                    // under a security scope. Read once, hand the bytes to the
                    // model, and let the scope go — no second copy is written
                    // anywhere for the interface's convenience.
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let data = try? Data(contentsOf: url)
                    model.acceptPickedFile(name: url.lastPathComponent,
                                           bytes: data.map { [UInt8]($0) })
                case .failure:
                    // Cancelling is not a refusal and must not look like one.
                    break
                }
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
        Details("Security details") {
            FaintText(SourceClaimText.deviceDetail)
            // The one line here that is a CLASSIFICATION rather than a
            // description keeps its extra weight.
            Text(SourceClaimText.notEligibleMeaning)
                .font(TruePadFont.faint.weight(.medium))
                .foregroundStyle(TruePadPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            FaintText(SourceClaimText.notEligibleReason)
            FaintText(SourceClaimText.notEligibleDoesNotMean)
        }
        .accessibilityHint("Explains how this pad's randomness is classified.")
    }

    /// LEVEL THREE. The expert source ceremony and the raw capacity fields.
    /// Nothing here is new and nothing here is weakened — it is the same ceremony
    /// with the same refusals, moved out of the normal path's way.
    @ViewBuilder private var advanced: some View {
        Details("Advanced") {
            SectionTitle("Randomness")
            // TWO RADIOS RATHER THAN AN INLINE `Picker`. The spoken labels are the
            // Picker's own strings, unchanged — the physical suite reaches this by
            // `app.buttons["Use external random material"]`, and more to the point
            // they are the words the operator was already reading.
            ChoiceBinding(title: "Generate for me",
                          selection: $model.source,
                          tag: CreatePadModel.Source.device,
                          spoken: "Generate for me")
            ChoiceBinding(title: "Use external random material",
                          selection: $model.source,
                          tag: CreatePadModel.Source.file,
                          spoken: "Use external random material")

            if model.source == .file {
                FaintText(SourceClaimText.externalShort)
                SecondaryButton(model.chosenFileName ?? "Choose a file…") { model.choosingFile = true }
                if let picked = model.chosenFileBytes {
                    KeyValueRow("This file", value: "\(picked.count) bytes")
                }
                // THE OPERATOR'S DECLARATION, asked for rather than assumed.
                TextField("Where did these bytes come from?", text: $model.declaredOrigin)
                    .truePadField()
                    .accessibilityLabel("Where these bytes came from. Your own note.")
                // SAY WHY CREATE IS DISABLED, in the same words the model uses
                // to decide it.
                if let why = model.readiness.explanation {
                    FaintText(why)
                }
                FaintText(Self.fileSourceNote)
            }

            // THE STEPPERS STAY SYSTEM CONTROLS. There is no product equivalent of
            // a stepper, and rebuilding one would cost the accessibility behaviour
            // Apple already ships — increment/decrement actions VoiceOver knows how
            // to drive. They take the brass tint from the root like every other
            // system control.
            Stepper("Message bytes: \(model.encryptionBytes)",
                    value: $model.encryptionBytes, in: 256...4_194_304, step: 256)
                .foregroundStyle(TruePadPalette.ink)
                .accessibilityLabel("Total bytes of message material: \(model.encryptionBytes).")
            Stepper("Messages: \(model.authRecords)",
                    value: $model.authRecords, in: 4...4096, step: 4)
                .foregroundStyle(TruePadPalette.ink)
                .accessibilityLabel("Number of messages this pad can carry: \(model.authRecords).")
            KeyValueRow("Material needed",
                        value: "\(model.requiredSourceBytes) bytes",
                        spoken: "Each source must supply \(model.requiredSourceBytes) bytes.")

            Rule()

            // LENGTH PRIVACY. Off by default, and under Advanced for the same
            // reason the raw capacity fields are: the daily flow does not need it,
            // and it costs pad. The Android edition carries the identical control
            // and the identical sentence about what it does and does not hide.
            SectionTitle("Message packaging")
            Toggle("Hide exact message lengths", isOn: $model.fixedLength)
                .font(TruePadFont.body)
                .foregroundStyle(TruePadPalette.ink)
                .accessibilityHint("Pads every message to the same size, so its exact length is "
                                   + "not visible.")
            FaintText(FixedRecordIntake.costAndLimit)

            if model.fixedLength {
                TextField("Message size (bytes)", text: $model.fixedSizeText)
                    .keyboardType(.numberPad)
                    .truePadField()
                    .accessibilityLabel("Message size in bytes. Every message will use exactly "
                                        + "this much of the pad.")
                // SAY WHY CREATE IS DISABLED, in the same words the model used to
                // decide it — the rule this screen already follows for the
                // external-source path.
                if let why = model.recordReadiness.explanation {
                    FaintText(why)
                }
            }
        }
    }
}

// MARK: - the sealed-transfer ceremony

/// The RECIPIENT's side: publish a one-time request, then wait.
public struct ReceiveRequestView: View {
    @ObservedObject public var model: ReceiveRequestModel
    @State private var sharing = false

    public init(model: ReceiveRequestModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            ScreenTitle("Receive a pad")

            if let request = model.request {
                SectionTitle("Show this to the sender")
                if let qr = model.qr { QrCodeView(payload: qr) }
                Text(request.tpr2Text)
                    .font(TruePadFont.machine)
                    .foregroundStyle(TruePadPalette.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Your receive code, as text you can copy.")

                // EXPLICIT CONTROLS FOR PUBLIC MATERIAL. The receive code is a
                // one-time public request; handing it to the sender is the whole
                // point of this screen, and leaving that to text selection made
                // the ordinary path harder without making anything safer.
                if let material = model.code {
                    VStack(alignment: .leading, spacing: TruePadMetrics.buttonGroupSpacing) {
                        PrimaryButton("Copy code") { PublicTransportPasteboard.copy(material) }
                        SecondaryButton("Share code") { sharing = true }
                    }
                    FaintText(VerbatimText.qrCarriesOnlyPublicData)
                }

                Rule()

                SectionTitle("Compare these 12 words")
                WordGrid(model.requestWords, expecting: CeremonyPhrase.requestWordCount)
                FaintText(VerbatimText.wordComparisonIsADeclaration)

                Rule()

                FaintText("This code expires \(request.expiresAt).")
                // CANCELLING IS IRREVERSIBLE, so it wears the quiet danger
                // treatment rather than iOS's `.destructive` red.
                QuietDangerButton("Cancel this code") { model.cancel() }
                FaintText("The key behind this request works exactly once. Cancelling it is "
                          + "permanent, and so is using it.")
            } else {
                // WHAT BECAME OF THE LAST ONE. Every state here is terminal, and
                // none of them offers a way back — the only recovery is a new
                // request, which is the button directly below. Saying so matters
                // most after a REJECTION, which is a decision the operator made
                // deliberately and should see acknowledged.
                if let outcome = model.outcome,
                   let headline = ReceiveRequestOutcomeText.headline(outcome) {
                    // A CALLOUT, because that is what this is: something happened,
                    // it is terminal, and the operator has to see it before they
                    // start again. The word "Note:" carries the tone without
                    // relying on colour.
                    Callout(tone: .neutral, title: headline) {
                        if let detail = ReceiveRequestOutcomeText.detail(outcome) {
                            FaintText(detail)
                        }
                        QuietButton("Dismiss") { model.acknowledgeOutcome() }
                    }
                    .accessibilityElement(children: .contain)
                }
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    PrimaryButton("Create a receive code") { model.create() }
                    FaintText("This makes a one-time key on this device and shows the sender a "
                              + "public request. The key never leaves.")
                }
            }

            // THE RECEIVER HALF OF THE CEREMONY. `OpenSealedView` existed and was
            // tested, and nothing in the app ever presented it — so a pad sealed to
            // this device's own request could not be opened. Found by the
            // two-device physical run.
            Rule()

            VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                SectionTitle("When the sealed file arrives")
                NavigationLink {
                    OpenSealedView(model: OpenSealedModel(engine: model.engine))
                } label: {
                    Slab("Open a sealed pad", .secondary)
                }
                FaintText("Choose the file the sender gave you. Nothing is saved until you have "
                          + "compared the eight words with them.")
            }
        }
        .truePadScreen()
        .sheet(isPresented: $sharing) {
            if let text = model.code?.text { ShareSheet(items: [text]) }
        }
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
            // "Problem:" is part of the rendered text. This replaced a warning
            // drawn in the system orange with a glyph beside it — colour and an
            // icon doing work that no word backed up.
            Callout(tone: .danger,
                    title: "These words cannot be displayed, so this transfer cannot be "
                           + "confirmed on this device.")
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
                    // A MINIMUM WIDTH, NOT A FIXED ONE.
                    //
                    // This was `frame(width: 28)` — fine while the ordinals were
                    // SF Pro with tabular figures, and not fine once they became a
                    // full monospaced face, in which the period takes a whole cell
                    // instead of a narrow one. "12." grew about 20%, and the column
                    // began wrapping the period onto its own line one Dynamic Type
                    // notch earlier than before — at a size reachable from Display
                    // & Brightness without turning on accessibility sizes at all.
                    //
                    // The numbers are how an operator keeps their place while
                    // reading twelve words aloud to the other party, so they may
                    // not wrap. `fixedSize` lets the column take the width it needs
                    // and `minWidth` keeps the words aligned when it does not.
                    Text("\(position + 1).")
                        .font(TruePadFont.machine)
                        .foregroundStyle(TruePadPalette.muted)
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(minWidth: 28, alignment: .trailing)
                    Text(word)
                        .font(TruePadFont.machineWord)
                        .foregroundStyle(TruePadPalette.ink)
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
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            if model.review == nil {
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    SectionTitle("The recipient's request")
                    TextField("Paste it here", text: $model.pastedRequest, axis: .vertical)
                        .lineLimit(2...6)
                        .accessibilityIdentifier("request-input")
                        .font(TruePadFont.machine)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .truePadField()
                    VStack(alignment: .leading, spacing: TruePadMetrics.buttonGroupSpacing) {
                        SecondaryButton("Scan it instead…") { scanning = true }
                        PrimaryButton("Review this request") { model.review(model.pastedRequest) }
                            .disabled(model.pastedRequest.isEmpty)
                    }
                }
            }

            if model.review != nil {
                Rule()

                // SAID BEFORE THE TWELVE WORDS, not after them.
                //
                // This lived inside `if model.confirmed`, so the operator learned
                // the seal could not happen only after reading twelve words aloud
                // to the other person and writing a durable confirmation record —
                // the exact human cost the check exists to avoid. It needs only
                // the reviewed request, which is what is on screen here.
                if model.isSealedToAnotherRequest {
                    Callout(tone: .warn, title: "This pad cannot be sealed to this code") {
                        BodyText("This pad has already been sealed to a DIFFERENT receive code, "
                                 + "so it cannot be sealed to this one — a pad can only leave "
                                 + "once. Generate a new pad for this receive code.")
                        FaintText("There is nothing to compare: TruePad will refuse before it "
                                  + "seals, so do not read the words below to the other person.")
                    }
                }

                SectionTitle("Compare these twelve words with the recipient")
                WordGrid(model.requestWords, expecting: CeremonyPhrase.requestWordCount)
                FaintText(VerbatimText.wordComparisonIsADeclaration)

                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    PrimaryButton("All twelve words matched") { model.confirm() }
                        .disabled(model.confirmed || !model.requestWordsComplete
                                  || model.isSealedToAnotherRequest)
                    FaintText("Say this only if you compared them over a channel you already "
                              + "trust — a phone call you placed, or in person. TruePad records "
                              + "that you said so; it cannot check it.")
                }
                if model.confirmed {
                    Rule()
                    VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                        PrimaryButton(model.isReshare ? "Get the sealed file again"
                                                      : "Seal this pad and send it") {
                            model.seal()
                        }
                        .disabled(model.isSealedToAnotherRequest)
                        if model.isReshare {
                            // NOTHING IS ENCAPSULATED HERE. The engine returns the
                            // bytes it already committed for this request. Saying
                            // "this pad can only leave once" at this point would
                            // imply a second send is about to happen — the one
                            // thing that cannot occur.
                            //
                            // "THIS REQUEST" IS NOW A CHECKED CLAIM. `isReshare`
                            // compares the durable marker's requestHash against the
                            // request on screen, by the same comparison sptSeal
                            // makes; it used to ask only whether the pad had ever
                            // been sealed, to anything.
                            FaintText("This pad was already sealed to this request. TruePad will "
                                      + "hand back the SAME sealed file it made then — nothing is "
                                      + "encrypted again and no second copy is created.")
                        } else {
                            FaintText("A sealed transfer sends the WHOLE pad, and this pad can only "
                                      + "leave once. Its delivery is protected by post-quantum "
                                      + "cryptography, not by the one-time pad — so the pad will "
                                      + "read NOT ELIGIBLE at both ends, permanently.")
                        }
                    }
                }
            }

            if let sealed = model.sealed {
                Rule()

                SectionTitle("Compare these 8 words")
                WordGrid(model.confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)

                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    // ONE REQUEST, ONE PAD, ONE COMMITTED PACKAGE. Coming back to
                    // a pad that was already sealed returns the SAME bytes — the
                    // engine re-reads the committed package rather than sealing
                    // again. Saying so matters: an operator who could not tell the
                    // difference might reasonably think a second handoff was being
                    // created, which is exactly what must never happen.
                    if sealed.reshared {
                        SectionTitle("Already sealed")
                    }
                    PrimaryButton(sealed.reshared ? "Hand over the same sealed file…"
                                                  : "Hand over the sealed file…") { model.share() }
                    if sealed.reshared {
                        FaintText("This is the same sealed file you made before, not a new one. "
                                  + "Sealing happened once, and the eight words above are the ones "
                                  + "from that transfer.\n\n"
                                  + VerbatimText.shareSheetIsACarrier)
                    } else {
                        FaintText(VerbatimText.shareSheetIsACarrier)
                    }
                }
            }
        }
        .truePadScreen()
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
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            // THE OUTCOME, STATED. `commit()` set `saved` and cleared `session`,
            // and nothing read `saved` — so a successful import re-rendered the
            // opening "Choose the sealed file…" prompt, which is exactly what a
            // commit that never happened looks like. The operator had just
            // accepted a whole pad and was shown no sign of it.
            if model.saved {
                Callout(tone: .good, title: "Pad saved") {
                    BodyText("The pad is on this device and is ready to use. You will find it in "
                             + "your list of pads.")
                    FaintText("That receive code is finished. It cannot accept another pad.")
                }
            }

            if model.session == nil && !model.saved {
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    PrimaryButton("Choose the sealed file…") { model.choosingFile = true }
                    FaintText("Nothing is saved until you have compared the eight words. Opening "
                              + "the file does not commit anything.")
                }
            }

            if model.session != nil {
                SectionTitle("Check these eight words against the sender")
                WordGrid(model.confirmationWords, expecting: CeremonyPhrase.confirmationWordCount)
                FaintText(VerbatimText.wordComparisonIsADeclaration)

                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    PrimaryButton("The eight words matched — save this pad") { model.commit() }
                        .disabled(!model.confirmationWordsComplete)
                    FaintText("Saving uses up this receive request. If saving fails after that "
                              + "point the transfer is lost and the request cannot be reused — ask "
                              + "for a new pad rather than retrying. That is deliberate: a request "
                              + "that could be reused is a key that could be used twice.")
                }

                Rule()

                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    QuietDangerButton("These words do NOT match — reject") { model.reject() }
                    FaintText("Rejecting cancels the request permanently. Nothing is saved.")
                }
            }
        }
        .truePadScreen()
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
