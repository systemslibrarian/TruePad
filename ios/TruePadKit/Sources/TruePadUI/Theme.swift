#if os(iOS)
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/* ============================================================================
 * THE PRODUCT'S APPEARANCE, IN ONE PLACE.
 *
 * Before this file the iPhone app drew itself out of stock SwiftUI: `Form` and
 * `List` supplied their own backgrounds and separators, `.secondary` supplied its
 * own grey, and every plain `Button` rendered in the system accent. The result was
 * a correct app that did not look like TruePad — the operator's words were that it
 * read as a test harness next to the Android one.
 *
 * WHY A TOKEN LAYER RATHER THAN A SWEEP OF COLOURS. A palette scattered through
 * thirty call sites is a palette that drifts: the next screen picks whichever
 * neighbouring literal was copied, and nothing catches it. Everything visual is
 * named here once, and `ThemeTokenTests` holds the view files to it.
 *
 * THE PALETTE IS NOT NEW AND IS NOT AN IOS DECISION. It is the shipped product's,
 * carried over from `android/…/ui/Theme.kt`, which took it from the PWA manifest.
 * The three editions are meant to read as one product, so the Android file is the
 * authority and this one follows it. If they ever disagree, Android is right.
 *
 * DARK ONLY, AND THAT IS NOT NEW EITHER. `TruePadRootView` already forced
 * `.preferredColorScheme(.dark)` at the root, so the light "paper" half of the
 * Android scheme has never been reachable on iOS. This file does not change that;
 * it only stops the dark half being the system's dark rather than TruePad's.
 *
 * TWO SURFACES ARE DELIBERATELY LIGHT AND ARE NOT THEMED — the inline QR card and
 * the full-screen scan view. A camera reads those, and the quiet zone and contrast
 * ratio are what a decoder keys on. They are allow-listed BY NAME in
 * `ThemeTokenTests` so that a future pass which "finishes the theming" has to
 * argue with a test rather than quietly cost the ceremony its scan reliability.
 *
 * WHAT THIS FILE DOES NOT TOUCH: no wording, no claim, no refusal, no engine call,
 * no accessibility label. Every string a screen reader speaks is the string it
 * spoke before. The disclosure triangles added here are `accessibilityHidden`,
 * because "▸ Advanced" is not a thing anyone needs read aloud.
 * ========================================================================= */

// MARK: - palette

/// The seven colours the product is made of, plus the two ink colours that sit on
/// top of the filled ones. Nothing outside this file names a colour.
public enum TruePadPalette {
    /// The page. A warm near-black, NOT the system's neutral one.
    public static let ground = Color(hex: 0x11_10_0C)
    /// Body and headings.
    public static let ink = Color(hex: 0xF3_EF_E4)
    /// Supporting text: captions, units, the second line of a row.
    public static let muted = Color(hex: 0x9E_98_87)
    /// A surface lifted off the page — a callout's fill, a field's interior.
    public static let raised = Color(hex: 0x1D_1B_15)
    /// Hairlines and the outline of an outlined control.
    public static let line = Color(hex: 0x3A_36_2C)
    /// The one accent. Every actionable thing in the app is this colour.
    public static let accent = Color(hex: 0xD8_B2_5A)
    /// Destructive and refused.
    public static let danger = Color(hex: 0xE0_70_5E)
    /// On a filled accent slab.
    public static let onAccent = ground
    /// On a filled danger slab. Kept even though nothing currently fills with
    /// danger — the Android scheme defines it, and the two files stay aligned.
    public static let onDanger = Color(hex: 0x2A_0F_0A)
}

// MARK: - metrics

/// Spacing, sizing and radii. Matched to the Android screens so the two editions
/// have the same rhythm rather than merely the same colours.
public enum TruePadMetrics {
    /// The horizontal inset of a screen's content.
    public static let screenPadding: CGFloat = 20
    /// Between two blocks of a screen.
    public static let blockSpacing: CGFloat = 16
    /// Between a control and the caption that qualifies it.
    public static let tightSpacing: CGFloat = 6
    /// Between two slabs that belong to the same decision. Android groups its
    /// buttons at 10dp inside a column that otherwise runs at 16dp, and the
    /// difference is what makes a pair read as a pair.
    public static let buttonGroupSpacing: CGFloat = 10
    /// Corner radius of buttons, fields and callouts.
    public static let corner: CGFloat = 10
    /// Android enforces 48dp on every button in `Components.kt`. Apple's floor is
    /// 44pt; taking the larger of the two satisfies both and keeps the slabs the
    /// same height as the Android screenshots.
    public static let minTouchTarget: CGFloat = 48
    /// A rule, and the border of an outlined control.
    public static let hairline: CGFloat = 1
}

// MARK: - typography

/// The type scale, expressed in iOS TEXT STYLES rather than in points.
///
/// The Android scale is fixed sp values; the equivalent on iOS is not a fixed
/// point size but the text style whose default size matches, because that is what
/// keeps Dynamic Type working. A screen title is `.title` (28pt) rather than a
/// hard-coded 30, and it grows when the operator makes text bigger. Nothing in
/// this app may be clipped at a large size — the warnings are the text most worth
/// reading and the first to be lost.
public enum TruePadFont {
    /// 30sp semibold on Android → `.title`, semibold.
    public static let screenTitle = Font.system(.title, design: .default).weight(.semibold)
    /// 22sp semibold → `.title3`, semibold.
    public static let subheading = Font.system(.title3, design: .default).weight(.semibold)
    /// 17sp semibold → `.headline` (which is 17 semibold).
    public static let sectionTitle = Font.system(.headline, design: .default)
    /// 17sp → `.body`.
    public static let body = Font.system(.body, design: .default)
    /// 15sp → `.subheadline`.
    public static let muted = Font.system(.subheadline, design: .default)
    /// 13sp → `.footnote`.
    public static let faint = Font.system(.footnote, design: .default)
    /// 16sp semibold → `.callout`, semibold.
    public static let buttonLabel = Font.system(.callout, design: .default).weight(.semibold)
    /// The one genuinely machine-readable thing on screen: an envelope, a request.
    public static let machine = Font.system(.footnote, design: .monospaced)
    /// A ceremony comparison word. Body-sized rather than footnote-sized, because
    /// it is READ ALOUD to another person and is the thing standing behind a
    /// sealed transfer.
    public static let machineWord = Font.system(.body, design: .monospaced)
}

// MARK: - text

/// A screen's title. Carries the heading trait, so VoiceOver's rotor can reach it.
public struct ScreenTitle: View {
    private let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .font(TruePadFont.screenTitle)
            .foregroundStyle(TruePadPalette.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The heading of a block within a screen.
public struct SectionTitle: View {
    private let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .font(TruePadFont.sectionTitle)
            .foregroundStyle(TruePadPalette.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Ordinary prose.
public struct BodyText: View {
    private let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .font(TruePadFont.body)
            .foregroundStyle(TruePadPalette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Supporting prose — a caption under the control it qualifies.
public struct MutedText: View {
    private let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .font(TruePadFont.muted)
            .foregroundStyle(TruePadPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The smallest print in the app — and, as on Android, still never clipped.
public struct FaintText: View {
    private let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .font(TruePadFont.faint)
            .foregroundStyle(TruePadPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - callout

/// The tone of a callout. The WORD is what makes the tone readable without
/// colour; the colour is the redundant half, not the carrier.
public enum CalloutTone {
    case neutral, warn, danger, good

    var accent: Color {
        switch self {
        case .neutral: return TruePadPalette.muted
        case .warn, .good: return TruePadPalette.accent
        case .danger: return TruePadPalette.danger
        }
    }

    /// Identical to `Components.kt`. A person who cannot tell the two warm
    /// colours apart still reads which one this is.
    var word: String {
        switch self {
        case .neutral: return "Note"
        case .warn: return "Important"
        case .danger: return "Problem"
        case .good: return "Done"
        }
    }
}

/// A bordered block that says something happened, or that something is true and
/// must not be missed.
public struct Callout<Content: View>: View {
    private let tone: CalloutTone
    private let title: String
    private let content: Content

    public init(tone: CalloutTone, title: String, @ViewBuilder content: () -> Content) {
        self.tone = tone
        self.title = title
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
            Text("\(tone.word): \(title)")
                .font(TruePadFont.sectionTitle)
                .foregroundStyle(tone.accent)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(TruePadPalette.raised,
                    in: RoundedRectangle(cornerRadius: TruePadMetrics.corner, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TruePadMetrics.corner, style: .continuous)
                .stroke(tone.accent, lineWidth: TruePadMetrics.hairline)
        )
    }
}

public extension Callout where Content == EmptyView {
    init(tone: CalloutTone, title: String) {
        self.init(tone: tone, title: title) { EmptyView() }
    }
}

// MARK: - buttons

/// Which of the three slabs a control wears.
///
/// There are exactly three, and which one a control gets is a statement about the
/// action rather than about the screen's composition: filled for the thing the
/// operator came to do, outlined for a real alternative, and quiet text for the
/// one action that cannot be undone.
public enum SlabKind {
    case primary, secondary, quietDanger
}

/// The APPEARANCE of a button, with no button attached.
///
/// Split out so a `NavigationLink` can wear the same skin as a `Button`. Several
/// of the actions on the pad screen are pushes rather than calls — "Write a
/// message" navigates — and before this they rendered as bare system-accent text
/// beside slab-shaped siblings that did exactly the same kind of thing.
public struct Slab: View {
    private let title: String
    private let kind: SlabKind
    private let busy: Bool
    @Environment(\.isEnabled) private var isEnabled

    public init(_ title: String, _ kind: SlabKind, busy: Bool = false) {
        self.title = title
        self.kind = kind
        self.busy = busy
    }

    private var dim: Double { isEnabled ? 1 : 0.4 }

    public var body: some View {
        HStack(spacing: 10) {
            if busy {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(TruePadPalette.onAccent)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(TruePadFont.buttonLabel)
                .multilineTextAlignment(kind == .quietDanger ? .leading : .center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity,
               minHeight: TruePadMetrics.minTouchTarget,
               alignment: kind == .quietDanger ? .leading : .center)
        .padding(.horizontal, kind == .quietDanger ? 0 : 12)
        .padding(.vertical, 10)
        .modifier(SlabSkin(kind: kind, dim: dim))
        .contentShape(Rectangle())
    }
}

/// The fill, the outline and the ink of each slab kind.
private struct SlabSkin: ViewModifier {
    let kind: SlabKind
    let dim: Double

    func body(content: Content) -> some View {
        switch kind {
        case .primary:
            // DISABLED IS A DIM INK SLAB, NOT DIMMED BRASS.
            //
            // The first attempt dimmed the brass and put dimmed ground ink on it,
            // with a comment claiming that was what the Android screenshots showed.
            // That was wrong on both counts. It produced dark-brown text on a dark
            // olive slab — barely legible, and the worst possible treatment for the
            // control that says "not yet" on the two screens where the operator is
            // most likely to be stuck. And Android does not do it: Material 3 draws
            // a disabled filled button as `onSurface` at 12% with its label at 38%,
            // which is the pale slab visible on the Android send screen.
            //
            // So this is that, in the product's ink. It keeps the shape and loses
            // the colour, which is the correct signal: the button is still there
            // and is not currently an action.
            content
                .foregroundStyle(dim == 1
                                 ? TruePadPalette.onAccent
                                 : TruePadPalette.ink.opacity(0.38))
                .background(dim == 1
                            ? TruePadPalette.accent
                            : TruePadPalette.ink.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: TruePadMetrics.corner,
                                                 style: .continuous))
        case .secondary:
            content
                .foregroundStyle(TruePadPalette.accent.opacity(dim))
                .overlay(
                    RoundedRectangle(cornerRadius: TruePadMetrics.corner, style: .continuous)
                        .stroke(TruePadPalette.line, lineWidth: TruePadMetrics.hairline)
                )
        case .quietDanger:
            content.foregroundStyle(TruePadPalette.danger.opacity(dim))
        }
    }
}

/// The filled slab. At most one per screen: it is what the operator came to do.
public struct PrimaryButton: View {
    private let title: String
    private let busy: Bool
    private let action: () -> Void

    public init(_ title: String, busy: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.busy = busy
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Slab(title, .primary, busy: busy) }
            .buttonStyle(.plain)
            .disabled(busy)
    }
}

/// The outlined slab: a real action, not the main one.
public struct SecondaryButton: View {
    private let title: String
    private let action: () -> Void

    public init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Slab(title, .secondary) }
            .buttonStyle(.plain)
    }
}

/// THE ONE IRREVERSIBLE ACTION IS THE QUIETEST THING ON THE SCREEN.
///
/// The released dashboard's rule, carried over from `Components.kt` unchanged: a
/// destroy is a text button, never a red slab. A red slab invites the tap; this
/// makes the operator go and find it.
public struct QuietDangerButton: View {
    private let title: String
    private let action: () -> Void

    public init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Slab(title, .quietDanger) }
            .buttonStyle(.plain)
    }
}

/// An inline textual action — "Dismiss", "Scan it instead…". Reads as a link
/// rather than a slab, and still meets the touch target.
public struct QuietButton: View {
    private let title: String
    private let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    public init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Text(title)
                .font(TruePadFont.buttonLabel)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: TruePadMetrics.minTouchTarget,
                       alignment: .leading)
                .foregroundStyle(TruePadPalette.accent.opacity(isEnabled ? 1 : 0.4))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - rows

/// A label and its value, read by a screen reader as one thing.
public struct KeyValueRow: View {
    private let label: String
    private let value: String
    private let spoken: String?

    public init(_ label: String, value: String, spoken: String? = nil) {
        self.label = label
        self.value = value
        self.spoken = spoken
    }

    private var labelText: some View {
        Text(label)
            .font(TruePadFont.muted)
            .foregroundStyle(TruePadPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var valueText: some View {
        Text(value)
            .font(TruePadFont.muted)
            .foregroundStyle(TruePadPalette.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    public var body: some View {
        // SIDE BY SIDE IF IT FITS, STACKED IF IT DOES NOT.
        //
        // The Android row splits the width evenly and lets both halves wrap. That
        // reads fine on the handset it was designed against and badly on an iPhone
        // 12, where "Messages you send" and "512 messages left" BOTH broke onto two
        // lines and interleaved — found on the device, invisible on a wider
        // simulator. These are the numbers an operator reads to decide whether they
        // can still send, so a ragged row is not a cosmetic problem.
        //
        // `ViewThatFits` picks the first layout that does not need to compress, so
        // the row stays on one line wherever it can and stacks — label above value,
        // both left-aligned — when the text or the type size grows past that. It
        // never truncates, which is the rule that matters most here.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                labelText
                Spacer(minLength: 12)
                valueText.multilineTextAlignment(.trailing)
            }
            VStack(alignment: .leading, spacing: 2) {
                labelText.frame(maxWidth: .infinity, alignment: .leading)
                valueText.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken ?? "\(label): \(value)")
    }
}

/// A single-choice row — the Android radio, which is what the create screen's size
/// and randomness pickers are.
public struct ChoiceRow<Detail: View>: View {
    private let title: String
    private let selected: Bool
    private let spoken: String
    private let detail: Detail
    private let action: () -> Void

    public init(title: String,
                selected: Bool,
                spoken: String,
                @ViewBuilder detail: () -> Detail,
                action: @escaping () -> Void) {
        self.title = title
        self.selected = selected
        self.spoken = spoken
        self.detail = detail()
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                // The ring is decoration: `.isSelected` is what VoiceOver reads,
                // and the row is never distinguished by colour alone.
                ZStack {
                    Circle()
                        .stroke(selected ? TruePadPalette.accent : TruePadPalette.muted,
                                lineWidth: TruePadMetrics.hairline + 1)
                        .frame(width: 22, height: 22)
                    if selected {
                        Circle()
                            .fill(TruePadPalette.accent)
                            .frame(width: 11, height: 11)
                    }
                }
                .padding(.top, 2)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(TruePadFont.body)
                        .foregroundStyle(TruePadPalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    detail
                }
            }
            .frame(maxWidth: .infinity, minHeight: TruePadMetrics.minTouchTarget,
                   alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

public extension ChoiceRow where Detail == EmptyView {
    init(title: String, selected: Bool, spoken: String, action: @escaping () -> Void) {
        self.init(title: title, selected: selected, spoken: spoken,
                  detail: { EmptyView() }, action: action)
    }
}

/// A radio row BOUND to a selection, rather than one that calls back.
///
/// This exists for a specific reason, and it is not stylistic. `CreatePadView`
/// chooses the pad's randomness source, and `ExternalSourceIntakeTests` forbids
/// ANY assignment of that source back to the device generator anywhere in the
/// models or the views — because an assignment is exactly what a silent
/// substitution of material the operator did not choose would look like. Writing
/// `model.source = .device` inside a tap handler trips that guard, and the guard
/// is right to be tripped: it cannot tell an operator's tap from a reset.
///
/// The `Picker` this replaced never had that problem, because it wrote through
/// `$model.source`. This restores that shape: the only assignment is the generic
/// `selection = tag` below, which cannot name a particular source at all.
public struct ChoiceBinding<Value: Equatable>: View {
    private let title: String
    @Binding private var selection: Value
    private let tag: Value
    private let spoken: String

    public init(title: String, selection: Binding<Value>, tag: Value, spoken: String) {
        self.title = title
        self._selection = selection
        self.tag = tag
        self.spoken = spoken
    }

    public var body: some View {
        ChoiceRow(title: title, selected: selection == tag, spoken: spoken) {
            selection = tag
        }
    }
}

// MARK: - disclosure

/// A collapsible block. Level-three material — exact counters, the engine's
/// reason — lives behind one of these and never above it.
///
/// The triangle is drawn rather than supplied by `DisclosureGroup`, whose chevron
/// is a system-accent glyph that cannot be retinted independently, and it is
/// `accessibilityHidden` so the button's label stays exactly the summary. That is
/// not only tidier for VoiceOver — the physical suite queries
/// `app.buttons["Advanced"]`, and a label of "▸  Advanced" would not match.
public struct Details<Content: View>: View {
    private let summary: String
    private let content: Content
    @State private var open = false

    public init(_ summary: String, @ViewBuilder content: () -> Content) {
        self.summary = summary
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 8) {
                    Text(open ? "▾" : "▸")
                        .font(TruePadFont.muted)
                        .foregroundStyle(TruePadPalette.accent)
                        .accessibilityHidden(true)
                    Text(summary)
                        .font(TruePadFont.muted)
                        .foregroundStyle(TruePadPalette.accent)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: TruePadMetrics.minTouchTarget,
                       alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityAddTraits(.isButton)
            // THE STATE MUST BE SPOKEN, because the only thing that shows it is a
            // glyph this deliberately hides.
            //
            // `DisclosureGroup` published expanded/collapsed for free; replacing it
            // with a Button dropped that, and a review caught it. A VoiceOver user
            // heard the identical "Security details, button" before and after
            // tapping, on the three toggles that hide the NOT ELIGIBLE explanation,
            // the per-direction counters and verdict, and the external-material
            // ceremony — so a tap that revealed all of it sounded like a tap that
            // did nothing.
            //
            // It goes in the VALUE, not the label, because the label is the control
            // 's name and the physical suite matches it exactly
            // (`app.buttons["Advanced"]`). Name and value are different fields for
            // exactly this reason.
            .accessibilityValue(open ? "expanded" : "collapsed")

            if open {
                VStack(alignment: .leading, spacing: TruePadMetrics.tightSpacing) {
                    content
                }
                .padding(.leading, 12)
                .padding(.bottom, 8)
            }
        }
    }
}

// MARK: - rules and fields

/// A hairline.
public struct Rule: View {
    public init() {}
    public var body: some View {
        Rectangle()
            .fill(TruePadPalette.line)
            .frame(height: TruePadMetrics.hairline)
            .accessibilityHidden(true)
    }
}

/// The outline every text field and text editor wears.
public struct FieldChrome: ViewModifier {
    public func body(content: Content) -> some View {
        content
            .padding(12)
            .foregroundStyle(TruePadPalette.ink)
            .background(TruePadPalette.ground)
            .overlay(
                RoundedRectangle(cornerRadius: TruePadMetrics.corner, style: .continuous)
                    .stroke(TruePadPalette.line, lineWidth: TruePadMetrics.hairline)
            )
    }
}

public extension View {
    /// Applies the product's field outline.
    func truePadField() -> some View { modifier(FieldChrome()) }

    /// The standard screen: the product's ground, a scroll that never traps the
    /// content, and the same inset and rhythm the Android screens use.
    ///
    /// A SCROLL, NOT A `Form`. `Form` supplies its own grouped background, its own
    /// separators and its own row insets, none of which can be fully replaced —
    /// and its rows are lazy, so anything below the fold is absent from the
    /// element tree until it is scrolled to. This is the one change that makes the
    /// screen read as TruePad rather than as Settings.
    func truePadScreen() -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TruePadMetrics.blockSpacing) {
                self
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, TruePadMetrics.screenPadding)
            // 28, not 16. The Android host column is
            // `padding(horizontal = 20.dp, vertical = 28.dp)`, and the deeper top
            // inset is what stops the first line sitting against the navigation bar.
            .padding(.vertical, 28)
            // ROOM TO SCROLL CLEAR OF THE TAB BAR. The bar floats over the content
            // rather than sitting beside it, so without this the final block of a
            // screen — which on several screens is a warning — can never be brought
            // fully into view. Android appends the same kind of tail spacer.
            .padding(.bottom, 40)
        }
        .background(TruePadPalette.ground.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
    }
}

// MARK: - chrome

/// Navigation bars, tab bars and the tint every remaining system control inherits.
///
/// The bars are configured through UIKit's appearance objects rather than through
/// `.toolbarBackground`, which on the iOS 16 floor does not reach a `TabView`'s bar
/// at all. Doing it once here is also what keeps this out of the individual views.
public struct TruePadChrome: ViewModifier {
    public func body(content: Content) -> some View {
        content
            // The catch-all. Anything still drawn by the system — a segmented
            // control, a text cursor, an alert's buttons, the selected tab —
            // takes this instead of the system accent, which is the Apple blue
            // the operator objected to.
            .tint(TruePadPalette.accent)
            .onAppear(perform: Self.applyBarAppearance)
    }

    /// APPLIED ONCE, AS EARLY AS POSSIBLE.
    ///
    /// `UINavigationBar.appearance()` only reaches bars created AFTER it is set, so
    /// doing this in `onAppear` is a race with the first screen's own bar. Calling
    /// it from `TruePadRootView.init` as well means the proxies are in place before
    /// any bar exists; the `onAppear` call is kept as the belt to that braces.
    private static var applied = false
    public static func applyOnce() {
        guard !applied else { return }
        applied = true
        applyBarAppearance()
    }

    static func applyBarAppearance() {
        #if canImport(UIKit)
        let ground = UIColor(TruePadPalette.ground)
        let ink = UIColor(TruePadPalette.ink)
        let muted = UIColor(TruePadPalette.muted)
        let accent = UIColor(TruePadPalette.accent)

        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = ground
        nav.shadowColor = UIColor(TruePadPalette.line)
        nav.titleTextAttributes = [.foregroundColor: ink]
        nav.largeTitleTextAttributes = [.foregroundColor: ink]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
        UINavigationBar.appearance().tintColor = accent

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = ground
        tab.shadowColor = UIColor(TruePadPalette.line)
        for item in [tab.stackedLayoutAppearance,
                     tab.inlineLayoutAppearance,
                     tab.compactInlineLayoutAppearance] {
            item.normal.iconColor = muted
            item.normal.titleTextAttributes = [.foregroundColor: muted]
            item.selected.iconColor = accent
            item.selected.titleTextAttributes = [.foregroundColor: accent]
        }
        UITabBar.appearance().standardAppearance = tab
        if #available(iOS 15.0, *) { UITabBar.appearance().scrollEdgeAppearance = tab }

        // TWO CONTROLS `.tint` DOES NOT REACH.
        //
        // A segmented control paints its selected segment from
        // `selectedSegmentTintColor`, not from the environment tint, and a text
        // field's caret comes from its own `tintColor`. Both were still arriving
        // in Apple blue on screens that were otherwise brass — the role picker on
        // Send and Open being the visible one. These are appearance proxies rather
        // than per-view settings for the same reason the bars are: so no screen has
        // to remember.
        let segmented = UISegmentedControl.appearance()
        segmented.selectedSegmentTintColor = accent
        segmented.setTitleTextAttributes([.foregroundColor: ink], for: .normal)
        segmented.setTitleTextAttributes([.foregroundColor: ground], for: .selected)

        UITextField.appearance().tintColor = accent
        UITextView.appearance().tintColor = accent
        #endif
    }
}

public extension View {
    /// Applied ONCE, at the root. See `TruePadChrome`.
    func truePadChrome() -> some View { modifier(TruePadChrome()) }
}

// MARK: - hex

extension Color {
    /// The palette is written as the same 0xRRGGBB literals the Android file uses,
    /// so the two can be compared by eye and by test.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
#endif
