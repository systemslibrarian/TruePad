package dev.systemslibrarian.truepad.app

/**
 * WHAT MAY STILL LEAVE, AND BY WHICH ROUTE.
 *
 * Two questions that look like one and are not, which is why they are named
 * separately here:
 *
 *   · mayExportRawPad — whether the RAW pad may still be written to a file. False
 *     the moment the pad has been handed over by any route, and false for an
 *     imported copy. This is the one that prevents a second usable copy.
 *
 *   · mayReshareSealedPackage — whether the ALREADY-COMMITTED sealed package may
 *     be offered again. Sealing writes that package to disk; collapsing the two
 *     questions into one flag hid it from the operator who dismissed the sheet
 *     before saving the file, and stranded the pad. It is the same bytes, already
 *     committed, already confirmed, so re-offering them creates no second copy —
 *     the copy was created when the seal was committed. Sealing to a DIFFERENT
 *     request is refused by the engine, not by this policy.
 *
 * An imported pad is never passed on by either route.
 *
 * PORTED FROM iOS WORD FOR WORD (`HandoffPolicy` in TruePadUI/Presentation.swift),
 * because the rule is the part that must not drift between editions.
 */
object HandoffPolicy {
    /** Whether the raw pad may still be written to a file the operator chooses. */
    fun mayExportRawPad(handedOver: Boolean, imported: Boolean): Boolean = !handedOver && !imported

    /**
     * Whether the committed sealed package may be offered again. TRUE ONLY for a
     * pad that was sealed — never for one handed over physically, never for one
     * whose spent-state cannot be read, and never for an imported copy.
     */
    fun mayReshareSealedPackage(sealed: Boolean, imported: Boolean): Boolean = sealed && !imported
}
