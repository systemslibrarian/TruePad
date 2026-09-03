package dev.systemslibrarian.truepad.app

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE QR CARRIES THE EXACT RECEIVE CODE, AND NOTHING IS LOST.
 *
 * The app draws the receive code with ZXing's low-level Encoder (Qr.kt) and reads
 * it back with ZXing's decoder (QrScan.kt). This exercises the SAME encode path
 * and a faithful decode path — module matrix -> pixels -> luminance -> decode —
 * in a plain JVM test, so the QR round-trip is gated on every build, not only on
 * a device with a camera.
 *
 * The QR-specific risk is capacity and fidelity: a full 1652-character receive
 * code is a dense version-34 byte-mode symbol, and it must decode back to exactly
 * the string that went in. Whether that string is a VALID receive request is a
 * different concern, already covered by the SPT suite — a scanned code goes
 * through the very same strict parser a pasted one does.
 */
class QrRoundTripTest {

    /** Encode `text` to a QR the way Qr.kt does, then decode it the way QrScan.kt
     *  does (via a pixel buffer and HybridBinarizer), and return the decoded text. */
    private fun encodeThenDecode(text: String): String {
        val hints = mapOf<EncodeHintType, Any>(EncodeHintType.CHARACTER_SET to "ISO-8859-1")
        val qr = Encoder.encode(text, ErrorCorrectionLevel.M, hints)
        val matrix = qr.matrix ?: error("no matrix")
        val scale = 4
        val quiet = 4
        val mw = matrix.width
        val mh = matrix.height
        val w = (mw + quiet * 2) * scale
        val h = (mh + quiet * 2) * scale
        val white = 0xFFFFFFFF.toInt()
        val black = 0xFF000000.toInt()
        val pixels = IntArray(w * h) { white }
        for (y in 0 until mh) {
            for (x in 0 until mw) {
                if (matrix.get(x, y).toInt() == 1) {
                    for (dy in 0 until scale) {
                        for (dx in 0 until scale) {
                            val px = (x + quiet) * scale + dx
                            val py = (y + quiet) * scale + dy
                            pixels[py * w + px] = black
                        }
                    }
                }
            }
        }
        val source = RGBLuminanceSource(w, h, pixels)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
        }
        return reader.decode(bitmap).text
    }

    /** A receive code is "TPR2:" + unpadded base64url; a full one is 1652 chars. */
    private fun syntheticReceiveCode(bodyChars: Int): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val body = StringBuilder(bodyChars)
        for (i in 0 until bodyChars) body.append(alphabet[(i * 7 + 13) % alphabet.length])
        return "TPR2:" + body
    }

    @Test
    fun aFullSizeReceiveCodeSurvivesTheQrRoundTrip() {
        val code = syntheticReceiveCode(1647) // 5 ("TPR2:") + 1647 = 1652 chars
        assertEquals(1652, code.length)
        assertEquals("the 1652-char receive code must decode back byte-for-byte", code, encodeThenDecode(code))
    }

    @Test
    fun theSymbolForAFullReceiveCodeIsAModestVersion() {
        // Sanity that a full receive code fits one symbol at EC level M (it lands
        // around version 34 = 153 modules; assert it is within the valid 1..40
        // range so a capacity regression is caught).
        val hints = mapOf<EncodeHintType, Any>(EncodeHintType.CHARACTER_SET to "ISO-8859-1")
        val qr = Encoder.encode(syntheticReceiveCode(1647), ErrorCorrectionLevel.M, hints)
        val version = qr.version.versionNumber
        assertTrue("version must be a real QR version, was $version", version in 1..40)
    }

    @Test
    fun shorterCodesAlsoRoundTrip() {
        for (n in listOf(8, 64, 400)) {
            val code = syntheticReceiveCode(n)
            assertEquals(code, encodeThenDecode(code))
        }
    }
}
