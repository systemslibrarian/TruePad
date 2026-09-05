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
 * ========================================================================= */

// MARK: - the list

public struct PadListView: View {
    @ObservedObject public var model: PadListModel

    public init(model: PadListModel) { self.model = model }

    public var body: some View {
        NavigationStack {
            List {
                if model.rows.isEmpty {
                    // Deliberately not `ContentUnavailableView`, which is iOS 17.
                    // The package floor is iOS 16, and raising a deployment target
                    // to reach a nicer empty state is a product decision rather
                    // than a compile fix.
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No pads yet").font(.headline)
                        Text("A pad is created from material you supply — or, if you choose, "
                             + "from this device's random generator, which is weaker and is "
                             + "labelled as such.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                ForEach(model.rows) { row in
                    NavigationLink(value: row.pairId) {
                        PadRowView(row: row)
                    }
                    .disabled(row.destroyed)
                }
            }
            .navigationTitle("Pads")
            .navigationDestination(for: String.self) { pairId in
                PadDetailView(model: model.detail(for: pairId))
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { model.startCreating() } label: {
                        Label("Create a pad", systemImage: "plus")
                    }
                }
            }
            .refreshable { model.reload() }
            .alert("TruePad refused", isPresented: $model.showingRefusal) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.refusalMessage ?? "")
            }
        }
        .onAppear { model.reload() }
    }
}

struct PadRowView: View {
    let row: PadListModel.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.label).font(.headline)
            if row.destroyed {
                Text("Destroyed — permanently unusable")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let summary = row.shortSummary {
                Text(summary).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        // The row's meaning, not its numbers.
        .accessibilityLabel(row.accessibilityLabel)
    }
}

// MARK: - one pad

public struct PadDetailView: View {
    @ObservedObject public var model: PadDetailModel

    public init(model: PadDetailModel) { self.model = model }

    public var body: some View {
        List {
            ForEach(model.meters, id: \.direction) { row in
                Section(row.direction) { MeterSection(row: row) }
            }

            Section("Sending and opening") {
                NavigationLink("Write a message") { SendView(model: model.sendModel()) }
                NavigationLink("Open a message") { OpenView(model: model.openModel()) }
            }

            Section("Handing this pad over") {
                if model.mayHandOff {
                    Button("Save the pad to a file…") { model.exportPad() }
                    Button("Send it by sealed transfer…") { model.beginSealedTransfer() }
                } else {
                    Text(model.handOffRefusal ?? "This pad has already been handed over.")
                        .foregroundStyle(.secondary)
                }
                Text(VerbatimText.shareSheetIsACarrier)
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Section {
                NavigationLink("Destroy this pad…") { DestroyView(model: model.destroyModel()) }
                    .foregroundStyle(.red)
            } footer: {
                // VERBATIM. Never paraphrased.
                Text(VerbatimText.destructionLimitation)
            }
        }
        .navigationTitle(model.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $model.fileToShare) { file in
            ShareSheet(items: [file.url])
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
        LabeledContent("Messages you can still send", value: "\(row.maxRemainingSends)")
            .accessibilityLabel("You can still send \(row.maxRemainingSends) "
                                + "\(row.maxRemainingSends == 1 ? "message" : "messages") "
                                + "in this direction.")

        LabeledContent("Pad material left",
                       value: "\(row.encryptionCapacity - row.encryptionUsed) of "
                              + "\(row.encryptionCapacity) bytes")
            .accessibilityLabel("\(row.encryptionCapacity - row.encryptionUsed) bytes of pad "
                                + "material remain, out of \(row.encryptionCapacity).")

        LabeledContent("Records left",
                       value: "\(row.recordsCapacity - row.recordsUsed) of \(row.recordsCapacity)")
            .accessibilityLabel("\(row.recordsCapacity - row.recordsUsed) authentication records "
                                + "remain, out of \(row.recordsCapacity). Each message uses one.")

        LabeledContent("Runs out first", value: row.limitedBy.capitalized)
            .accessibilityLabel("Whichever runs out first: \(row.limitedBy.lowercased()).")

        if row.frozen {
            Label("Frozen after repeated verification failures", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityLabel("This pad is frozen after repeated verification failures. "
                                    + "Nothing was consumed. You can clear the freeze to resume.")
        }

        VStack(alignment: .leading, spacing: 4) {
            // DERIVED on every render, from live facts. Never stored.
            Text(row.verdict).font(.headline)
            if let why = row.whyNotStronger {
                Text(why).font(.footnote).foregroundStyle(.secondary)
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
        Form {
            Section {
                // The prompt NEVER contains the value it asks for.
                Text(DestroyPrompt.text(forUnreadablePair: model.pairIsUnreadable))
                TextField("Confirmation", text: $model.typed)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Type the pad's identifier to confirm destruction. "
                                        + "TruePad will not show it to you here.")
            }
            Section {
                Button("Destroy this pad", role: .destructive) { model.destroy() }
                    .disabled(model.typed.isEmpty)
            } footer: {
                Text(VerbatimText.destructionLimitation)
            }
        }
        .navigationTitle("Destroy")
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}
#endif
