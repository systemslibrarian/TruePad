package dev.systemslibrarian.truepad.app

import android.content.Context
import java.io.File

/*
 * Pads the operator asked TruePad to forget — PRESENTATION ONLY.
 *
 * Two different things are called "removing a pad", and confusing them would be
 * a security bug. This file is the second one.
 *
 *   1. The INTERNAL tombstone. destroyed.json is what makes a destruction
 *      durable and the pair permanently unusable. It is never deleted, never
 *      cleared, and NOTHING in this file can reach it. Every consuming verb
 *      still refuses `pair-destroyed`, and the old pad file is still refused on
 *      import — hidden or not.
 *
 *   2. The USER-FACING record. Whether TruePad still shows you a dead pad is a
 *      product question, not a security one. Once you remove it you should never
 *      see it again: no list, no archive, no count, no name.
 *
 * Removal is one-way by design: there is no unremove, no manage screen and no
 * undo. A user who asked TruePad to forget a pad should not find it again later.
 * The engine's memory is a separate thing and it is permanent.
 *
 * This is the Android twin of the Browser Edition's removed.ts, which keeps the
 * same preference in localStorage. It holds pairIds — public metadata, never
 * secret material — in one app-private file, deliberately NOT in the frozen v2
 * store and deliberately not in SharedPreferences or DataStore, so there is
 * exactly one storage technology in this app and one place to audit.
 *
 * Losing this file is a cosmetic regression (a dead pad reappears as removed),
 * never a security one.
 */
class HiddenPads(private val file: File) {

    constructor(context: Context) : this(File(context.filesDir, "hidden-pads.txt"))

    /** One pairId per line. Anything that is not a pairId is ignored. */
    fun all(): Set<String> = try {
        if (!file.isFile) {
            emptySet()
        } else {
            file.readLines().map { it.trim() }.filter { HEX_32.matches(it) }.toSet()
        }
    } catch (_: Exception) {
        // Unreadable preference: nothing is hidden. Failing OPEN is correct
        // here and only here — the cost is showing a dead pad the operator
        // wanted gone, and the alternative (hiding everything) would make live
        // pads vanish, which is a far worse failure for a product about not
        // losing access to your own pads.
        emptySet()
    }

    fun hide(pairId: String) {
        if (!HEX_32.matches(pairId)) return
        val next = all() + pairId
        try {
            file.parentFile?.mkdirs()
            file.writeText(next.joinToString("\n", postfix = "\n"))
        } catch (_: Exception) {
            /* best-effort display preference only */
        }
    }

    fun isHidden(pairId: String): Boolean = pairId in all()

    private companion object {
        val HEX_32 = Regex("^[0-9a-f]{32}$")
    }
}
