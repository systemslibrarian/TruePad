package dev.systemslibrarian.truepad.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.systemslibrarian.truepad.app.ui.TruePadTheme
import dev.systemslibrarian.truepad.app.ui.TruePadRoot

/**
 * The only exported component in the app, and the only one there will be.
 *
 * It accepts no data: the manifest gives it MAIN/LAUNCHER and nothing else, so
 * there is no action, extra, or URI another application can hand it. Everything
 * that comes in from outside arrives because the operator opened the system
 * picker and chose it.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        applySecureFlag()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            TruePadTheme {
                val vm: PadViewModel = viewModel()
                val state by vm.state.collectAsState()
                TruePadRoot(state = state, vm = vm)
            }
        }
    }

    /**
     * FLAG_SECURE, on the WHOLE window, for the whole app.
     *
     * The scope is deliberate rather than lazy. Almost every screen here can
     * hold something worth not leaking: an opened message is plaintext, a
     * composed message is plaintext before it is sent, the created-pad screen
     * names a pairId, and the pad list shows who you talk to. Choosing a subset
     * would mean maintaining a list of "safe" screens forever and being wrong
     * the first time one gains a field. One window flag, set before the first
     * frame, is the version that cannot drift.
     *
     * Set BEFORE super.onCreate so it is in force for the very first frame and
     * for the Recents thumbnail the system captures on the way out.
     *
     * WHAT IT DOES: asks the system to exclude this window from screenshots,
     * screen recording, and the recent-apps preview, and blocks non-secure
     * displays.
     *
     * WHAT IT DOES NOT DO: it is a request to the system, honoured by the system.
     * It is not a defence against a rooted or compromised device, an accessibility
     * service the user has granted capture rights to, a screen-reading malware
     * with those rights, or a camera pointed at the screen. TruePad says so on
     * the screen rather than implying more (Claims.SCREEN_CAPTURE_NOTE).
     */
    private fun applySecureFlag() {
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    /**
     * NOTHING is written to the saved-instance bundle.
     *
     * onSaveInstanceState is persisted by the system, may be written to disk,
     * and survives into places this app does not control. A composed message,
     * an opened plaintext, or an emitted envelope must never travel that way.
     * Compose's rememberSaveable is avoided for the same reason wherever the
     * value could be sensitive; state that matters is reloaded from the engine.
     */
    override fun onSaveInstanceState(outState: Bundle, outPersistentState: PersistableBundle) {
        super.onSaveInstanceState(Bundle(), PersistableBundle())
    }
}

/* ---- clipboard ------------------------------------------------------------- */

/**
 * Copy text to the clipboard, on explicit operator action only.
 *
 * The clipboard is a CROSS-APPLICATION surface. Any app with focus can read it,
 * and on older releases many could read it in the background. TruePad therefore
 * never copies anything on its own: nothing is placed here except by a button
 * the operator pressed, and pad material, keys, masks, tags and witness state
 * are never candidates at all — only a message the operator is already looking
 * at.
 *
 * EXTRA_IS_SENSITIVE (API 33+) asks the system not to render a preview of the
 * copied text in the clipboard confirmation UI, which is what would otherwise
 * put a decrypted message on screen a second time, outside FLAG_SECURE. It is a
 * request, not a control: it does not stop another application from reading the
 * clipboard, and Claims.CLIPBOARD_WARNING says exactly that.
 */
fun Context.copySensitiveText(label: String, text: String) {
    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    val clip = ClipData.newPlainText(label, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = android.os.PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    clipboard.setPrimaryClip(clip)
}

/**
 * Hand an encrypted message to the share sheet as TEXT.
 *
 * Text, deliberately, and not a file: sharing a file would need a content
 * provider, and this app has none. An envelope is wire-public — it is what
 * travels over the untrusted channel by design — so the share sheet is the
 * right destination for it. A PAD, which is secret, is never shared this way;
 * it goes only to a location the operator picked in the system file picker.
 */
fun Context.shareEncryptedMessage(text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
        // No EXTRA_SUBJECT: a subject line is another place a person could
        // accidentally put something about the message's contents.
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/**
 * Hand a receive code to the share sheet as TEXT.
 *
 * A TPR2 receive code is PUBLIC by design — it is only a recipient key and a
 * request id, and it is what the sender must be given to seal a pad. So it is
 * safe on the same open channels an envelope is, and like an envelope it travels
 * as text (this app has no content provider). No EXTRA_IS_SENSITIVE: nothing
 * here is secret, and marking it so would be a false claim.
 */
fun Context.shareReceiveCode(text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
