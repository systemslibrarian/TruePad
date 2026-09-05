package dev.systemslibrarian.truepad.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import android.util.Size
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import java.util.concurrent.TimeUnit
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
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
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.UiState
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/*
 * SCAN a receive-code QR.
 *
 * CameraX supplies the preview and the frames; ML KIT decodes them IN PROCESS,
 * against a model that ships inside the APK. (ZXing still ENCODES every code this
 * app draws — see Qr.kt — it simply could not read one back off a screen.)
 * Nothing leaves the device — the manifest deletes INTERNET, so there is no
 * permission for it to leave by, and ScannerOfflineTest proves on a handset that
 * the process cannot open a socket at all — and the frames are never stored: each
 * ImageProxy is analysed and closed.
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
// ImageProxy.getImage is opt-in in CameraX: the underlying android.media.Image is
// owned by the analyzer and is only valid until ImageProxy.close(), so CameraX
// makes callers say out loud that they accept that contract. This code does — the
// image is handed to ML Kit and the proxy is closed in the completion listener,
// after the decode has finished with it, never before.
//
// The opt-in is declared rather than suppressed. Lint runs with warningsAsErrors,
// and this fired the moment `check` was run after the ML Kit swap.
@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
private fun QrCameraPreview(modifier: Modifier, onScanned: (String) -> Unit) {
    val context = localContext()
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    val fired = remember { AtomicBoolean(false) }
    // Set the instant this composition is disposed. It guards the provider-ready
    // callback (which resolves asynchronously and, on the process's first-ever
    // ProcessCameraProvider init, can land AFTER onDispose) and the scan callback,
    // so the camera is never bound behind a screen that already left and a frame
    // decoded after dispose never drives navigation.
    val disposed = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }

    AndroidView(factory = { previewView }, modifier = modifier)

    androidx.compose.runtime.DisposableEffect(Unit) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        // ML KIT, NOT ZXING.
        //
        // ZXing could not read a receive code off another phone's screen during
        // the two-device ceremony — not at 640x480, not at 1920x1440, not with
        // continuous centre autofocus, not with a global-histogram binarizer or a
        // centre crop, and not with the code shown full screen at full
        // brightness on white. An independent decoder read the very same rendered
        // code instantly, so the symbol was always valid; ZXing simply could not
        // resolve 139 modules off a lit display.
        //
        // The BUNDLED model ships inside the APK as assets/mlkit_barcode_models/
        // *.tflite: nothing is fetched at runtime.
        //
        // That is NOT the same as arriving without a network cost, and an earlier
        // version of this comment claimed it was. ML Kit brings the Play Services
        // client stack AND Google's datatransport stack, and it is datatransport
        // that declares the permissions — transport-backend-cct declares INTERNET
        // and ACCESS_NETWORK_STATE — so the release APK was built asking for both,
        // in an app whose About screen says it has no transport of its own. The
        // same stack is the telemetry uploader the manifest also deletes. The manifest now removes them explicitly; ScannerOfflineTest
        // proves on a handset that the socket is genuinely refused and that this
        // decoder still reads a production-density symbol anyway.
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
        providerFuture.addListener({
            val ready = providerFuture.get()
            provider = ready
            // The composition may have been disposed while this first-init future
            // was still resolving — in which case onDispose already ran with
            // `provider` still null, so its unbindAll() was a no-op. Binding now
            // would open the camera behind whatever screen replaced this one, with
            // nothing left to unbind it. Bind ONLY if still live; else release now.
            if (disposed.get()) {
                ready.unbindAll()
                return@addListener
            }
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            // ASK FOR A HIGH-RESOLUTION ANALYSIS STREAM.
            //
            // CameraX defaults ImageAnalysis to 640x480. A TruePad receive request
            // is ~1652 bytes, which even at the lowest error-correction level is a
            // 149-module QR. Filling a 480-pixel frame that is about 3 pixels per
            // module — right at ZXing's limit — and in practice the code never
            // fills the whole frame, so it is fewer. Found on real hardware: an
            // iPhone displaying a correctly-rendered request full screen, at full
            // brightness, could not be read by this scanner at any distance.
            //
            // 1920x1080 gives roughly 7 pixels per module at the same framing,
            // which is comfortably inside what a hybrid binarizer can resolve.
            // FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER so a device that cannot
            // provide exactly this still gets the best it has rather than the
            // 640x480 default.
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1920, 1080),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                            ),
                        )
                        .build(),
                )
                .build()
            analysis.setAnalyzer(executor) { image ->
                val media = image.image
                if (media == null) {
                    image.close()
                } else {
                    val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
                    scanner.process(input)
                        .addOnSuccessListener { codes ->
                            val text = codes.firstNotNullOfOrNull { it.rawValue }
                            // Fire once, and never after the scan screen has left.
                            // The post lands on the main thread, where onDispose
                            // also runs, so the final !disposed check there is the
                            // authoritative one.
                            if (text != null && !disposed.get() && fired.compareAndSet(false, true)) {
                                previewView.post { if (!disposed.get()) onScanned(text) }
                            }
                        }
                        .addOnCompleteListener { image.close() }
                }
            }
            ready.unbindAll()
            val camera = ready.bindToLifecycle(
                lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis,
            )

            // DRIVE AUTOFOCUS AT THE CENTRE, REPEATEDLY.
            //
            // A receive-code QR is read from another phone's screen at 15-25 cm.
            // That is close enough that a continuous-autofocus camera left to its
            // own devices often settles on the wrong plane and stays there — the
            // frame looks fine to a person and is too soft for a binarizer at 139
            // modules. Found on real hardware: an iPhone showing a correctly
            // rendered, full-screen, full-brightness request could not be read at
            // any distance, while an independent decoder read the same code from
            // a rendered image immediately.
            //
            // The auto-cancel duration is what makes this continuous: each action
            // expires and the next one re-triggers a fresh hunt, so bringing the
            // phone closer re-focuses instead of holding a stale lock.
            val focusPoint = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f)
            val focus = FocusMeteringAction.Builder(focusPoint, FocusMeteringAction.FLAG_AF)
                .setAutoCancelDuration(2, TimeUnit.SECONDS)
                .build()
            val refocus = object : Runnable {
                override fun run() {
                    if (disposed.get()) return
                    runCatching { camera.cameraControl.startFocusAndMetering(focus) }
                    previewView.postDelayed(this, 2_000)
                }
            }
            previewView.post(refocus)
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            disposed.set(true)
            provider?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }
}


