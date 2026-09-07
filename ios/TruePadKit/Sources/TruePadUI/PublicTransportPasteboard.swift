#if os(iOS)
import UIKit

/* ============================================================================
 * THE ONE PLACE IN TRUEPAD THAT TOUCHES THE PASTEBOARD.
 *
 * WHAT THIS AMENDS. `LeakageAuditTests.testNoShippingSourceTouchesThePasteboard`
 * banned the `UIPasteboard` symbol from every shipping source, with no exception.
 * That ban was right about the risk and wrong about the shape of the answer: the
 * clipboard is readable by other apps and syncs across devices, so pad material
 * and plaintext must never reach it — but a public `TP2:` ciphertext and a public
 * `TPR2:` receive request are exactly the two things an operator has to move to
 * another app, and leaving them to text selection made the ordinary path worse
 * without making anything safer.
 *
 * So the ban is now narrower and STRONGER: exactly one audited boundary may
 * reference `UIPasteboard`, and the test names this file. Any other reference
 * still fails.
 *
 * WHY IT TAKES A TYPE AND NOT A STRING. `PublicTransport` cannot be constructed
 * from arbitrary text — it decodes and re-encodes the payload and requires the
 * result to be identical. A screen therefore CANNOT hand this function plaintext,
 * pad material, a `.tps2` package, a key, or a string it assembled: there is no
 * overload that would accept one. The prohibition is carried by the type system
 * rather than by everybody remembering.
 *
 * WHAT IS STILL FORBIDDEN, and is enforced elsewhere: the decrypted message has
 * no copy affordance at all, and `EgressPolicy.mayCopyToClipboard(.plaintext)` is
 * false. Nothing here changes that, and nothing here should ever grow an overload
 * that could.
 *
 * WHAT THIS DOES NOT CLAIM. Once material is on the pasteboard it has left
 * TruePad's control — other apps can read it and the system may sync it. That is
 * acceptable for material that is already public and is not acceptable for
 * anything else, which is precisely the line this type draws.
 * ========================================================================= */

public enum PublicTransportPasteboard {
    /// Copy public transport material, and nothing else.
    ///
    /// The value's `text` is written verbatim — the same characters the screen is
    /// displaying. Nothing is re-encoded, re-wrapped or annotated on the way out:
    /// what the operator sees is what the other person receives.
    public static func copy(_ material: PublicTransport) {
        UIPasteboard.general.string = material.text
    }
}
#endif
