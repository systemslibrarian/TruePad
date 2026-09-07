#if os(iOS)
import SwiftUI
import TruePadClaims
import TruePadCore
import TruePadStorage

/* ============================================================================
 * The pad list and one pad's detail.
 *
 * These views are DELIBERATELY THIN. Every decision that could be wrong in a way
 * that matters lives in Presentation.swift, which has no UI import and is tested;
 * what is left here is layout, labels, and calling the engine. That split is what
 * lets CI say something meaningful about a layer it cannot run.
 *
 * ACCESSIBILITY IS NOT DECORATION HERE. A meter that VoiceOver reads as
 * "59, 64, 7, 8" tells a blind operator nothing about whether they can still send
 * a message. Every number that carries a decision is given a label that says what
 * it MEANS. Whether that actually reads well is a human gate (docs/IOS-SECURITY.md),
 * and nothing in this file is evidence that it does.
 *
 * APPEARANCE COMES FROM Theme.swift AND NOWHERE ELSE. No colour, font size or
 * corner radius is named in this file. The screens were rebuilt out of the shared
 * vocabulary — Slab, SectionTitle, KeyValueRow, Details, Rule — so that the iPhone
 * and the Android handset read as one product. Nothing about what is SAID changed:
 * every string, every accessibility label and every verbatim claim is the one that
 * was here before.
 * ========================================================================= */

// MARK: - the list

public struct PadListView: View {
    @ObservedObject public var model: PadListModel

    public init(model: PadListModel) { self.model = model }

    public var body: some View {
        NavigationStack(path: $model.path) {
            List {
                ScreenTitle("Pads")
                    .plainRow()

                // THE NEXT STEP, NAMED AND OFFERED, on the screen the create sheet
                // returns to. A pad nobody else has is a pad that cannot be used,
                // and until this the operator was left to work out what to do next.
                if model.justCreated != nil {
                    Callout(tone: .good, title: "Pad created") {
                        BodyText("The other person needs a copy of this pad before you can "
                                 + "message each other.")
                        FaintText("To share it securely, ask them to open TruePad and create a "
                                  + "receive code. Have them send that code to you, then paste or "
                                  + "scan it here.")
                        PrimaryButton("Share this pad") { model.openJustCreated() }
                        // CREATING A PAD MUST NOT FORCE AN IMMEDIATE HANDOFF.
                        SecondaryButton("Not now") { model.dismissCreated() }
                    }
                    .plainRow()
                }

                // THE PRIMARY ACTION IS ON THE SCREEN, NOT IN THE TOOLBAR.
                //
                // It used to be a `+` toolbar item. That is a perfectly ordinary
                // iOS placement, but it made the first screen of the app a mostly
                // empty list with a small glyph in the corner, where the Android
                // edition opens on a brass slab that says what to do. Moving it
                // into the content is the single biggest reason the two now read
                // as the same product.
                //
                // EXACTLY ONE CONTROL CARRIES THIS LABEL. The physical suite does
                // `app.buttons["Create a pad"]`, and a query matching two elements
                // raises rather than picking one — so the toolbar item was removed
                // rather than kept alongside this.
                PrimaryButton("Create a pad") { model.startCreating() }
                    .accessibilityHint("Creates a new pad on this device.")
                    .plainRow()

                if model.rows.isEmpty {
                    // Deliberately not `ContentUnavailableView`, which is iOS 17.
                    // The package floor is iOS 16, and raising a deployment target
                    // to reach a nicer empty state is a product decision rather
                    // than a compile fix.
                    VStack(alignment: .leading, spacing: 8) {
                        SectionTitle("No pads yet")
                        // Says what to DO. The previous copy opened on the expert
                        // path and then called the ordinary one "weaker", which is
                        // the same misleading emphasis the create screen had.
                        MutedText("A pad is shared between you and one other person. Create one here, "
                                  + "or receive one from someone else on the Inbox tab.")
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                    .plainRow()
                }
                if !model.rows.isEmpty {
                    // The Android edition leads with the actions and puts the pads
                    // under a heading; this is the same shape.
                    SectionTitle("Your pads")
                        .plainRow()
                }
                ForEach(model.rows) { row in
                    NavigationLink(value: row.pairId) {
                        PadRowView(row: row)
                    }
                    .disabled(row.destroyed)
                    .plainRow()
                }
            }
            // THE LIST'S OWN CHROME IS REMOVED, NOT RECOLOURED.
            //
            // `List` supplies a grouped background, inset cards and separators of
            // its own, and those are what made this screen read as Settings. What
            // it is kept FOR is `.refreshable`: pull-to-refresh is a `List`
            // affordance, and swapping to a `ScrollView` to gain a flat background
            // would have silently dropped it.
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(TruePadPalette.ground.ignoresSafeArea())
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
            .navigationDestination(for: String.self) { pairId in
                PadDetailView(model: model.detail(for: pairId))
            }
            .refreshable { model.reload() }
            // ON THE LIST, NOT ON THE NAVIGATION STACK. Popping back from a pad's
            // detail does not re-run the stack's onAppear, so the list could keep
            // showing a snapshot taken before a destroy — a pad that is gone still
            // reading as usable is the wrong direction for this screen to be
            // wrong in.
            .onAppear { model.reload() }
            .alert("TruePad refused", isPresented: $model.showingRefusal) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.refusalMessage ?? "")
            }
        }
    }
}

struct PadRowView: View {
    let row: PadListModel.Row

    var body: some View {
        HStack(spacing: 12) {
            // A destroyed or frozen pad is marked, so the state is visible before
            // the text is read. Colour is never the only carrier — the line below
            // says it in words, and VoiceOver reads the words.
            if row.state.isProblem {
                Image(systemName: row.state == .destroyed ? "trash.slash" : "exclamationmark.triangle")
                    .foregroundStyle(row.state == .destroyed
                                     ? TruePadPalette.muted : TruePadPalette.accent)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(row.label)
                    .font(TruePadFont.sectionTitle)
                    .foregroundStyle(row.destroyed ? TruePadPalette.muted : TruePadPalette.ink)
                Text(row.state.line)
                    .font(TruePadFont.muted)
                    .foregroundStyle(TruePadPalette.muted)
            }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        // The row's meaning, not its numbers.
        .accessibilityLabel(row.state.spoken(label: row.label))
    }
}

/// A list row with the system's insets, fill and separator taken off, so what is
/// left is the product's own spacing.
private extension View {
    func plainRow() -> some View {
        self
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 6,
                                      leading: TruePadMetrics.screenPadding,
                                      bottom: 6,
                                      trailing: TruePadMetrics.screenPadding))
    }
}

// MARK: - one pad

public struct PadDetailView: View {
    @ObservedObject public var model: PadDetailModel

    public init(model: PadDetailModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            // WHAT THE OPERATOR CAME HERE TO DO, FIRST. This screen used to open
            // on two sections of direction meters — offsets, record counts,
            // witness state and the deployment verdict — before it offered a way
            // to write a message. Every one of those numbers is still here, one
            // disclosure down, where it can be read rather than waded through.
            //
            // THESE TWO ARE PUSHES, AND THEY NOW LOOK LIKE THE ACTIONS THEY ARE.
            // As bare `NavigationLink` text they rendered in the system accent
            // beside slab-shaped siblings that did the same kind of thing; wearing
            // `Slab` costs nothing semantically — a NavigationLink is still a
            // button, and its accessibility label is still its title.
            VStack(alignment: .leading, spacing: TruePadMetrics.buttonGroupSpacing) {
                NavigationLink { SendView(model: model.sendModel()) } label: {
                    Slab("Write a message", .primary)
                }
                NavigationLink { OpenView(model: model.openModel()) } label: {
                    Slab("Open a message", .secondary)
                }
            }

            Rule()

            // The headline number, in the operator's terms.
            SectionTitle("How much is left")
            ForEach(model.meters, id: \.direction) { row in
                KeyValueRow(row.plainDirection(role: model.derivedRole),
                            value: row.remainingLine)
            }

            Rule()

            SectionTitle("Share this pad")
            if model.mayHandOff {
                // THE SECURE ROUTE LEADS. Both routes are still here; what changed
                // is which one an operator meets first. Two equal-weight outlined
                // buttons made "save a copy of the pad to a file" look like the
                // ordinary way to give someone a pad, and it is not.
                MutedText("The other person needs a copy of this pad before you can message "
                          + "each other.")
                PrimaryButton("Send securely to a receive code") { model.beginSealedTransfer() }
                FaintText("Ask the other person to open TruePad and create a receive code. Have "
                          + "them send that code to you, then paste or scan it here.")
                SecondaryButton("Save the pad to a file…") { model.exportPad() }
                FaintText("You can also hand it over as a file in person. A pad can be given only "
                          + "once, whichever way you choose.")
            } else {
                // THE FALLBACK IS NOT A CLAIM ABOUT THE PAD. It used to read "This
                // pad has already been handed over" — which, now that the flag
                // fails closed, is exactly what a pad whose state could not be
                // read would have said about itself. `handOffRefusal` is set on
                // every branch including the error one; this covers only the
                // impossible case, and it says nothing it cannot support.
                MutedText(model.handOffRefusal ?? PadDetailModel.handoffStateUnknown)
                // THE SEALED PACKAGE IS STILL REACHABLE. Sealing commits the
                // package to disk and `sptSeal` returns those exact bytes for
                // the same receive request. Without this the operator who
                // dismissed the sheet before saving the file had no way back
                // to it, and the pad was stranded — the raw pad stays blocked
                // either way, which is the part that matters for reuse.
                if model.mayReshareSealed {
                    SecondaryButton("Hand over the same sealed file…") { model.beginSealedTransfer() }
                }
            }
            FaintText(VerbatimText.shareSheetIsACarrier)

            Rule()

            // EVERYTHING TECHNICAL, ORGANISED RATHER THAN REMOVED. Source class,
            // delivery, storage, rollback authority, the evaluator's verdict and
            // the exact counters all still appear, verbatim, one tap down.
            Details("Security details") {
                if let role = model.derivedRole {
                    KeyValueRow("This device is party",
                                value: role == .a ? "A" : "B",
                                spoken: "This device is party \(role == .a ? "A" : "B") for this pad.")
                }
                // NAMED PER DIRECTION. Each meter used to sit in its own
                // `Section(row.direction)`; collapsing them into one
                // disclosure without a heading ran both halves' offsets,
                // record counts and verdicts together as one undifferentiated
                // list, so a reader could not tell which number belonged to
                // which direction. The heading carries BOTH the plain name
                // and the wire name, because this is the screen where the
                // wire name is the useful one.
                ForEach(model.meters, id: \.direction) { row in
                    Text("\(row.plainDirection(role: model.derivedRole)) (\(row.direction))")
                        .font(TruePadFont.faint.weight(.semibold))
                        .foregroundStyle(TruePadPalette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    MeterSection(row: row)
                }
            }
            .accessibilityHint("Exact counters and this pad's deployment assessment.")

            Rule()

            NavigationLink { DestroyView(model: model.destroyModel()) } label: {
                Slab("Destroy this pad…", .quietDanger)
            }
            .accessibilityHint("Permanently destroys this pad.")
            // VERBATIM. Never paraphrased.
            FaintText(VerbatimText.destructionLimitation)
        }
        .truePadScreen()
        .navigationTitle(model.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $model.fileToShare, onDismiss: { model.discardSharedFile() }) { file in
            ShareSheet(items: [file.url])
        }
        // THE SENDER HALF OF THE CEREMONY. `SealView` existed, was tested, and was
        // presented by nothing at all until the physical two-device run found it.
        .sheet(isPresented: $model.sealing, onDismiss: { model.reload() }) {
            NavigationStack { SealView(model: model.sealModel()) }
        }
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
        .onAppear { model.reload() }
    }
}

struct MeterSection: View {
    let row: MeterRow

    var body: some View {
        KeyValueRow("Messages you can still send",
                    value: "\(row.maxRemainingSends)",
                    spoken: "You can still send \(row.maxRemainingSends) "
                            + "\(row.maxRemainingSends == 1 ? "message" : "messages") "
                            + "in this direction.")

        KeyValueRow("Pad material left",
                    value: "\(row.encryptionCapacity - row.encryptionUsed) of "
                           + "\(row.encryptionCapacity) bytes",
                    spoken: "\(row.encryptionCapacity - row.encryptionUsed) bytes of pad "
                            + "material remain, out of \(row.encryptionCapacity).")

        KeyValueRow("Message packaging",
                    value: row.recordMode,
                    spoken: "Message packaging: \(row.recordMode).")

        KeyValueRow("Authentication records left",
                    value: "\(row.recordsCapacity - row.recordsUsed) of \(row.recordsCapacity)",
                    spoken: "\(row.recordsCapacity - row.recordsUsed) authentication records "
                            + "remain, out of \(row.recordsCapacity). Each message uses one.")

        KeyValueRow("Runs out first",
                    value: row.limitedBy.capitalized,
                    spoken: "Whichever runs out first: \(row.limitedBy.lowercased()).")

        if row.frozen {
            // A CALLOUT, WHICH CARRIES ITS OWN WORD. "Important:" is part of the
            // rendered text, so the state survives a reader who cannot tell brass
            // from ink — the same rule `Components.kt` states for the Android side.
            // It replaces a `Label` in the system orange, which was colour doing
            // work that no word backed up.
            Callout(tone: .warn, title: "Frozen after repeated verification failures")
                .accessibilityLabel("This pad is frozen after repeated verification failures. "
                                    + "Nothing was consumed. You can clear the freeze to resume.")
        }

        VStack(alignment: .leading, spacing: 4) {
            // DERIVED on every render, from live facts. Never stored.
            SectionTitle(row.verdict)
            if let why = row.whyNotStronger {
                FaintText(why)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Deployment assessment: \(row.verdict)."
                            + (row.whyNotStronger.map { " Why not stronger: \($0)" } ?? ""))
    }
}

// MARK: - destroy

public struct DestroyView: View {
    @ObservedObject public var model: DestroyModel

    public init(model: DestroyModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
            // The prompt NEVER contains the value it asks for.
            BodyText(DestroyPrompt.text(forUnreadablePair: model.pairIsUnreadable))
            TextField("Confirmation", text: $model.typed)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .truePadField()
                .accessibilityLabel("Type the pad's identifier to confirm destruction. "
                                    + "TruePad will not show it to you here.")

            // STILL THE QUIETEST CONTROL ON THE SCREEN. It was a `.destructive`
            // system button, which iOS draws in its own red; this is the product's
            // danger colour and the same quiet-text treatment the Android edition
            // gives the one irreversible action. The `role:` is gone with it —
            // nothing but the colour came from it here, and the confirmation is
            // the typed identifier, not a red tint.
            QuietDangerButton("Destroy this pad") { model.destroy() }
                .disabled(model.typed.isEmpty)
            FaintText(VerbatimText.destructionLimitation)
        }
        .truePadScreen()
        .navigationTitle("Destroy")
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}
#endif
