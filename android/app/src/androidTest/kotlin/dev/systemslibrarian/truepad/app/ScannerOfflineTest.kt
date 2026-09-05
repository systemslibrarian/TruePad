package dev.systemslibrarian.truepad.app

import android.content.pm.PackageManager
import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.systemslibrarian.truepad.app.ui.tprQrBitmap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * THE SCANNER WORKS WITH THE NETWORK TAKEN AWAY.
 *
 * ML Kit replaced ZXing because ZXing could not resolve a 139-module code off
 * another phone's screen on real hardware. The cost of that swap is that ML Kit
 * arrives with the Google Play Services client stack attached, and
 * its datatransport stack declares INTERNET and ACCESS_NETWORK_STATE in its own
 * manifests (transport-backend-cct declares both, transport-runtime the second) — which landed both in the shipping APK by manifest merge, silently,
 * for an app whose About screen says it has no transport of its own. The
 * manifest now deletes them with tools:node="remove".
 *
 * Deleting a permission is easy to get wrong in a way that still looks right, so
 * this file does not take the manifest's word for it. It establishes three
 * things ON THE DEVICE, in order, and the middle one is the one that makes the
 * other two mean anything:
 *
 *   1. The installed package does not request INTERNET.
 *   2. THE POSITIVE CONTROL: this process genuinely cannot open a socket. Without
 *      it, test 3 would pass just as happily on a build that still had INTERNET,
 *      and would be evidence of nothing.
 *   3. ML Kit decodes a production-density TPR2 symbol anyway — so the model is
 *      the .tflite asset inside the APK, not something fetched on first use.
 *
 * What it does NOT claim: that ML Kit contains no network code, that Play
 * Services on this handset is inert, or anything about optical capture. It is
 * about one question — does the decoder need the network — and the answer is no.
 */
@RunWith(AndroidJUnit4::class)
class ScannerOfflineTest {

    private fun ctx() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun theInstalledPackageDoesNotRequestInternet() {
        val pm = ctx().packageManager
        val requested = pm.getPackageInfo(ctx().packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.toList() ?: emptyList()

        assertFalse(
            "INTERNET is in the installed manifest: $requested",
            requested.contains(android.Manifest.permission.INTERNET),
        )
        assertFalse(
            "ACCESS_NETWORK_STATE is in the installed manifest: $requested",
            requested.contains(android.Manifest.permission.ACCESS_NETWORK_STATE),
        )
    }

    /**
     * POSITIVE CONTROL. A process without INTERNET cannot create a TCP socket at
     * all: the kernel refuses socket(2) because the app's UID is not in the inet
     * group. This must FAIL, and it must fail FOR THAT REASON — a timeout would
     * mean the socket was created and merely could not reach anywhere, which is
     * a different and much weaker fact.
     *
     * Both errno spellings are accepted because the device decides which one it
     * reports: this handset (Android 16) answers EPERM where the documented
     * behaviour is EACCES. Widening it to "denied" and not to "failed somehow"
     * is the point — a timeout still fails this test.
     *
     * The address is a documentation-range literal that is never routed, so
     * nothing here depends on where this test is run or on anything answering.
     */
    @Test
    fun thisProcessCannotOpenASocket() {
        val failure = runCatching {
            Socket().use { it.connect(InetSocketAddress("192.0.2.1", 443), 1500) }
        }.exceptionOrNull()

        assertTrue("a socket was opened, so the INTERNET strip did not take effect", failure != null)
        val text = (failure!!.message ?: "") + " " + (failure.cause?.message ?: "")
        assertTrue(
            "socket failed for the wrong reason (expected permission denied): $failure",
            text.contains("EACCES", ignoreCase = true) ||
                text.contains("EPERM", ignoreCase = true) ||
                text.contains("Permission denied", ignoreCase = true) ||
                text.contains("Operation not permitted", ignoreCase = true),
        )
    }

    /**
     * THE MODEL IS AN ASSET IN THIS APK, pinned by name.
     *
     * Without this, the decode test below proves only that decoding worked — it
     * would pass just as happily on the Play-Services variant of the dependency,
     * which fetches its model on first use. One coordinate change in
     * libs.versions.toml is the whole difference between the two, and nothing
     * else in the suite would notice.
     */
    @Test
    fun theBarcodeModelShipsInsideThisApk() {
        val models = ctx().assets.list("mlkit_barcode_models")?.toList() ?: emptyList()
        assertTrue(
            "the bundled ML Kit model assets are missing — this is the downloading variant: $models",
            models.any { it.endsWith(".tflite") },
        )
    }

    /**
     * NO TELEMETRY UPLOADER IS INSTALLED.
     *
     * ML Kit merges in Google's datatransport stack — a CCT/Clearcut backend, a
     * JobScheduler service and an AlarmManager receiver, with Firelog enabled —
     * into an app that tells the operator it has no analytics and no crash
     * reporting. The manifest deletes those three components. This asserts the
     * deletion took, against the INSTALLED package rather than the source.
     */
    @Test
    fun noTelemetryUploaderComponentIsInstalled() {
        val pm = ctx().packageManager
        val info = pm.getPackageInfo(
            ctx().packageName,
            PackageManager.GET_SERVICES or PackageManager.GET_RECEIVERS,
        )
        val components = (info.services?.map { it.name } ?: emptyList()) +
            (info.receivers?.map { it.name } ?: emptyList())
        val transport = components.filter { it.startsWith("com.google.android.datatransport") }
        assertTrue("a datatransport component survived the merge: $transport", transport.isEmpty())
    }

    /**
     * The payload is a synthetic receive code of the EXACT production shape —
     * "TPR2:" plus 1647 base64url characters, 1652 total. Density is what this
     * test is about, and a QR symbol's density is fixed by length and charset,
     * not by which key bytes are inside; using a synthetic one keeps the test
     * from needing an engine, a witness and a pad just to draw a square.
     *
     * It is rendered by the app's OWN encoder and scaled by a whole number of
     * pixels per module, which is how the app draws it — non-integer scaling is
     * what made an earlier build unreadable.
     */
    @Test
    fun mlKitDecodesAProductionDensitySymbolWithNoNetwork() {
        val body = buildString {
            val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            for (i in 0 until 1647) append(alphabet[(i * 31 + 7) % alphabet.length])
        }
        val text = "TPR2:$body"
        assertEquals(1652, text.length)

        val small = tprQrBitmap(text)
        // 8 whole pixels per module, mirroring the on-screen render.
        val scale = 8
        val big = Bitmap.createScaledBitmap(small, small.width * scale, small.height * scale, false)

        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )

        var decoded: String? = null
        var error: Throwable? = null
        val done = CountDownLatch(1)
        scanner.process(InputImage.fromBitmap(big, 0))
            .addOnSuccessListener { codes -> decoded = codes.firstNotNullOfOrNull { it.rawValue }; done.countDown() }
            .addOnFailureListener { e -> error = e; done.countDown() }

        assertTrue("ML Kit did not answer within 30s", done.await(30, TimeUnit.SECONDS))
        assertTrue("ML Kit reported a failure: $error", error == null)
        assertEquals(
            "the bundled model decoded the symbol to different text",
            text,
            decoded,
        )
    }
}
