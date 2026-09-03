package dev.systemslibrarian.truepad.app.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/*
 * TPR2 receive code -> QR symbol.
 *
 * The ONLY thing this ever encodes is a canonical receive code (it refuses
 * anything that is not a "TPR2:" string), and a receive code is PUBLIC — a
 * recipient key and a request id. A sealed package or any secret can never reach
 * here. Byte mode (base64url uses lowercase and -/_, which QR alphanumeric mode
 * cannot carry) at error-correction level M, matching the Browser Edition's
 * released receive-code symbol; for the current 1652-character request that is a
 * version-34 (153x153) symbol.
 *
 * ZXing's low-level Encoder gives the raw module matrix; it is rendered one pixel
 * per module with a four-module quiet zone, then scaled up crisply (nearest-
 * neighbour) by the Image. It is drawn black-on-white regardless of app theme so
 * a scanner reads it in dark mode too.
 */

private const val QUIET_MODULES = 4

private fun tprQrBitmap(text: String): Bitmap {
    // ISO-8859-1 keeps the ASCII base64url bytes one-to-one and selects byte mode.
    val hints = mapOf<EncodeHintType, Any>(EncodeHintType.CHARACTER_SET to "ISO-8859-1")
    val qr = Encoder.encode(text, ErrorCorrectionLevel.M, hints)
    val matrix = qr.matrix ?: error("QR encoder returned no matrix")
    val mw = matrix.width
    val mh = matrix.height
    val w = mw + QUIET_MODULES * 2
    val h = mh + QUIET_MODULES * 2
    val black = 0xFF000000.toInt()
    val white = 0xFFFFFFFF.toInt()
    val pixels = IntArray(w * h) { white }
    for (y in 0 until mh) {
        for (x in 0 until mw) {
            if (matrix.get(x, y).toInt() == 1) {
                pixels[(y + QUIET_MODULES) * w + (x + QUIET_MODULES)] = black
            }
        }
    }
    return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { setPixels(pixels, 0, w, 0, 0, w, h) }
}

/** Render a canonical receive code as a QR. Renders nothing for a non-receive
 *  code (defensive — only the app's own generated code is ever passed in). */
@Composable
fun TprQrCode(text: String, modifier: Modifier = Modifier) {
    if (!text.startsWith("TPR2:")) return
    val bitmap = remember(text) { runCatching { tprQrBitmap(text).asImageBitmap() }.getOrNull() }
    if (bitmap == null) {
        Faint("Could not draw the QR code. Use the code text above instead.")
        return
    }
    Image(
        bitmap = bitmap,
        contentDescription = "The receive code as a QR code.",
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .background(Color.White)
            .padding(8.dp)
            .testTag("receive-code-qr"),
        contentScale = ContentScale.Fit,
        filterQuality = FilterQuality.None,
    )
}
