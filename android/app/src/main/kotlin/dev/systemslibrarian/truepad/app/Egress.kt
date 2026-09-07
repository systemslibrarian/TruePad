package dev.systemslibrarian.truepad.app

/**
 * WHAT MAY LEAVE TRUEPAD, AND BY WHICH ROUTE.
 *
 * Android had no classification: `copySensitiveText` took a label and a string,
 * so the Open screen's "Copy" on the DECRYPTED MESSAGE and the Send screen's
 * "Copy" on a public encrypted envelope were the same call with different
 * arguments. Nothing in the type system could tell the two apart, and the
 * app's own `CLIPBOARD_WARNING` conceded that the sensitive-clip mark "does not
 * stop another app from reading the clipboard".
 *
 * The clipboard is the sharper of the two routes: readable by any app with
 * focus, kept in a platform history, and synced across a person's devices. The
 * share sheet hands bytes to an app the operator picked, which is a different
 * and acceptable risk — for material that is public by design.
 *
 * This is the iOS `EgressPolicy` (TruePadUI/Presentation.swift), ported so all
 * three editions state one rule. It is an APPLICATION EGRESS POLICY and nothing
 * more: it does not stop a screenshot, an accessibility service, a debugger, the
 * operating system reading process memory, or a person copying the words out by
 * hand. It stops TruePad from OFFERING to do it.
 */
enum class Egress {
    /** A public receive request or encrypted envelope — TPR2, TP2, canonical
     *  JSON. Copy and share are what it is FOR. */
    PUBLIC_TEXT,

    /** A courier bundle or sealed transfer package: written to a location the
     *  operator picks, never to the clipboard and never to the share sheet. */
    PAD_FILE,

    /**
     * THE DECRYPTED MESSAGE ITSELF. Displayed, and nothing else.
     *
     * It is already on screen and readable; a Copy or a Share adds a SECOND,
     * durable-or-synced copy of the one thing the pad exists to protect.
     */
    PLAINTEXT_MESSAGE,
}

object EgressPolicy {
    /** Only public transport reaches the system clipboard. */
    fun mayCopyToClipboard(egress: Egress): Boolean = egress == Egress.PUBLIC_TEXT

    /** Only public transport is drawn as a QR — a QR is a clipboard you can
     *  photograph. */
    fun mayRenderAsQr(egress: Egress): Boolean = egress == Egress.PUBLIC_TEXT

    /** Only public transport goes to the share sheet. A pad file goes to the
     *  system file picker instead, and the decrypted message goes nowhere. */
    fun mayShareAsText(egress: Egress): Boolean = egress == Egress.PUBLIC_TEXT

    /**
     * Whether this material may become a FILE the operator chooses a location for.
     *
     * Stated so the three editions answer the same questions rather than two of
     * them: the Browser has `mayShareAsFile` and Android had only
     * `mayShareAsText`, so a cross-edition test comparing "the rule" was really
     * comparing two different rules. Android has no received-file case because it
     * has no file-receive feature; if one is ever added, this is where it lands.
     */
    fun mayShareAsFile(egress: Egress): Boolean = egress != Egress.PLAINTEXT_MESSAGE
}

/**
 * Raised when a screen asks for a route this classification forbids.
 *
 * A PROGRAMMING ERROR, NOT AN OPERATOR ERROR, and therefore loud. Every call
 * site passes a constant, so this cannot depend on runtime data: it fires when
 * someone wires plaintext into a sink, which is the thing being prevented.
 */
class EgressRefused(val egress: Egress, route: String) :
    IllegalArgumentException("$egress may not be $route: TruePad does not offer that route for this material")
