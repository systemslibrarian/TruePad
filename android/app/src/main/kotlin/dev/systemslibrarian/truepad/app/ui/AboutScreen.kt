package dev.systemslibrarian.truepad.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.systemslibrarian.truepad.app.Claims
import dev.systemslibrarian.truepad.storage.DESTROY_LIMITATION
import dev.systemslibrarian.truepad.storage.GEN_VERDICT

/**
 * WHAT THIS APP IS, AND — AT LEAST AS IMPORTANTLY — WHAT IT IS NOT.
 *
 * The iPhone edition has had this destination since it shipped and this one did
 * not, so an Android operator could read TruePad's claims boundary only in the
 * documentation. A claim that only the docs make is a claim the person holding
 * the phone never sees.
 *
 * Every sentence here is one the rest of the codebase already commits to. The
 * two §-verbatim ones — destruction and the source verdict — are referenced from
 * the storage module rather than copied, so there is exactly one place each can
 * be wrong.
 */
@Composable
fun AboutScreen() {
    ScreenTitle("About TruePad", Modifier.testTag("title-about"))

    SectionTitle("What protects what")
    Body(Claims.CLAIM_DELIVERY)
    Body(Claims.CLAIM_ENCRYPTION)
    Body(Claims.CLAIM_AUTHENTICATION)

    Rule()

    SectionTitle("What TruePad does not do")
    Body(Claims.NO_SERVER)
    Body(Claims.NO_TELEMETRY)
    // THE SCOPE, BESIDE THE CLAIM. Without it the sentence above is contradicted
    // by the first line of `adb logcat` during a scan. See Claims.LOG_SCOPE.
    Faint(Claims.LOG_SCOPE)
    Body(Claims.PADS_ARE_DEVICE_GENERATED)

    Rule()

    SectionTitle("Destruction")
    Faint(DESTROY_LIMITATION)

    Rule()

    SectionTitle("Source material")
    Faint(GEN_VERDICT)

    Rule()

    SectionTitle("Codes and files")
    Faint(Claims.QR_CARRIES_ONLY_PUBLIC_DATA)
    Faint(Claims.SHARE_IS_A_CARRIER)

    Rule()

    SectionTitle("This device")
    Faint(Claims.BACKUP_NOTE)
    Faint(Claims.CLIPBOARD_WARNING)
}
