package dev.systemslibrarian.truepad.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.UiState
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/*
 * SCAN a receive-code QR.
 *
 * CameraX supplies the preview and the frames; ZXing decodes them IN PROCESS.
 * Nothing leaves the device — there is no INTERNET permission for it to leave
 * by — and the frames are never stored: each ImageProxy is analysed and closed.
 * The camera is bound to this composition and unbound the instant the scan screen
 * leaves (the DisposableEffect below), so it is never held open behind another
 * screen.
 *
 * A decoded string is NOT trusted: it is handed to the same strict TPR2 parser a
 * pasted code goes through (via reviewFromScan -> sptReviewRequest). A QR that is
 * not a canonical receive code is refused there, exactly like a bad paste — the
 * camera is just another way to enter the same text.
 */

@Composable
fun QrScanScreen(state: UiState, vm: PadViewModel) {
    val context = localContext()
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var asked by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        asked = true
    }

    BackLink("Send securely") { vm.back() }
    ScreenTitle("Scan QR code", Modifier.testTag("title-scan"))
    BannerArea(state, vm)

    when {
        granted -> {
            QrCameraPreview(
                modifier = Modifier.fillMaxWidth().aspectRatio(1f).testTag("qr-camera"),
                onScanned = { text -> vm.reviewFromScan(text) },
            )
            Body("Point the camera at the other person's receive-code QR.")
            SecondaryButton("Enter the code by hand instead", Modifier.testTag("btn-scan-manual")) { vm.back() }
        }
        asked -> {
            // Asked and declined. Offer the manual path, and a second try.
            Callout(Tone.Warn, "Camera not available") {
                Body("TruePad needs the camera to scan a QR code. You can allow it, or paste the receive code by hand instead.")
            }
            PrimaryButton("Allow camera", Modifier.testTag("btn-allow-camera")) {
                permission.launch(Manifest.permission.CAMERA)
            }
            SecondaryButton("Enter the code by hand instead", Modifier.testTag("btn-scan-manual")) { vm.back() }
        }
        else -> {
            Body("To scan a QR code, TruePad needs to use the camera. It reads the code on your device and nothing else — there is no network for it to leave by.")
            PrimaryButton("Allow camera", Modifier.testTag("btn-allow-camera")) {
                permission.launch(Manifest.permission.CAMERA)
            }
            SecondaryButton("Enter the code by hand instead", Modifier.testTag("btn-scan-manual")) { vm.back() }
        }
    }
}

/**
 * A bound camera preview that calls [onScanned] exactly once, with the text of
 * the first QR it decodes. The camera provider is unbound and the analysis
 * executor shut down on dispose.
 */
@Composable
private fun QrCameraPreview(modifier: Modifier, onScanned: (String) -> Unit) {
    val context = localContext()
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    val fired = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }

    AndroidView(factory = { previewView }, modifier = modifier)

    androidx.compose.runtime.DisposableEffect(Unit) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        val reader = MultiFormatReader().apply {
            setHints(
                mapOf(
                    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                    DecodeHintType.TRY_HARDER to true,
                ),
            )
        }
        providerFuture.addListener({
            provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { image ->
                decodeFrame(reader, image)?.let { text ->
                    if (fired.compareAndSet(false, true)) {
                        previewView.post { onScanned(text) }
                    }
                }
                image.close()
            }
            provider?.unbindAll()
            provider?.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            provider?.unbindAll()
            executor.shutdown()
        }
    }
}

/** Decode one camera frame's luminance to a QR string, or null if none. */
private fun decodeFrame(reader: MultiFormatReader, image: ImageProxy): String? {
    return try {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)
        val source = PlanarYUVLuminanceSource(
            data, plane.rowStride, image.height, 0, 0, image.width, image.height, false,
        )
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: Exception) {
        // No QR in this frame (NotFoundException), or an unreadable frame. Neither
        // is an error — the next frame is analysed. Nothing is logged.
        null
    } finally {
        reader.reset()
    }
}
