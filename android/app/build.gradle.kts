// TruePad Android — the application module.
//
// This module is the PLATFORM BINDING and the UI, and nothing else. Every
// security decision — what is consumed, in what order, what is refused — lives
// in :truepad-storage and :truepad-core, which are pure Kotlin/JVM and are
// tested without an emulator. Nothing here re-implements a state machine; the
// engine's result is authoritative and the UI renders it.
//
// See docs/ANDROID-SECURITY.md for what this module claims and what it does not.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "dev.systemslibrarian.truepad.app"

    // AGP 8.7.3 supports compileSdk up to 35. Its default build-tools (34.0.0)
    // is not part of this toolchain, so the installed 35.0.0 is named
    // explicitly rather than left to a default that would fail on a clean setup.
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        // The application ID follows the Kotlin namespace the engine modules
        // already established (dev.systemslibrarian.truepad.*), so the app and
        // its libraries share one identity rather than inventing a second.
        applicationId = "dev.systemslibrarian.truepad"
        // API 26 is the floor the ENGINE sets, not a marketing choice: the store
        // uses java.nio.file.Files, ATOMIC_MOVE, PosixFilePermissions and
        // java.time, all of which are API 26. Going lower would mean core
        // library desugaring for the exact code paths that make a write durable,
        // which is not a thing to take on lightly for reach.
        minSdk = 26
        targetSdk = 35
        // Monotonic: the phase-2 preview was versionCode 1. This is the 3.0
        // development build; the versionName is not a release (there is no
        // v3.0.0 tag), it is the same 3.0.0-dev.0 the web/CLI package carries.
        versionCode = 2
        versionName = "3.0.0-dev.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // No native code, no split configs, no locale stripping: nothing here
        // needs them, and each is a knob that can go wrong quietly.
        vectorDrawables.useSupportLibrary = false
    }

    buildTypes {
        debug {
            // The debug build is what the instrumentation suite runs against.
            // It must NOT differ from release in any security-relevant way, so
            // the manifest, the backup rules and FLAG_SECURE are identical.
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
        // Explicitly OFF. BuildConfig is not needed, and a generated constant
        // is a tempting place to hide a flag that changes security behaviour
        // between build types.
        buildConfig = false
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }

    lint {
        abortOnError = true
        // Security and correctness findings fail the build. This is the point of
        // running lint at all: a warning nobody reads is not a gate.
        warningsAsErrors = true
        checkDependencies = true
        // Suppressions are declared here, in the open, with a reason — never
        // scattered as inline annotations that a reviewer has to hunt for.
        disable += setOf(
            // The engine modules are deliberately plain Kotlin/JVM and use
            // java.nio/java.time directly. minSdk 26 makes every one of those
            // APIs available; the check cannot see that through the module
            // boundary and reports them against this app's manifest.
            "NewApi",

            // "A newer version exists" is not a finding, it is a subscription.
            // This project pins its toolchain deliberately — AGP 8.7.3, Kotlin
            // 2.0.21, the Compose BOM that pairs with them — and upgrading a
            // cryptographic or storage-adjacent dependency is a decision with
            // its own review, not something a build should nag into happening.
            // Currency is tracked as an explicit task in
            // docs/ANDROID-SECURITY.md §10, where it can be reasoned about.
            "GradleDependency",
            "AndroidGradlePluginVersion",

            // targetSdk 35 IS the newest AGP 8.7.3 supports. Raising it means
            // raising AGP, which is the pinned-toolchain decision above.
            "OldTargetApi",

            // The launcher icon's mipmap-anydpi-v26 qualifier reads as redundant
            // at minSdk 26, but removing it makes AAPT2 fail to resolve
            // mipmap/ic_launcher at all. Verified by trying it.
            "ObsoleteSdkInt",
        )
        warning += setOf(
            // Informational only: this app ships one locale's copy today.
            "MissingTranslation",
        )
        sarifReport = true
        textReport = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

/*
 * THE RELEASE MANIFEST GATE.
 *
 * ManifestHardeningTest asserts the exported surface on a DEVICE, which means it
 * asserts the DEBUG manifest — and the debug manifest legitimately carries Compose
 * tooling activities that never ship. That leaves the shipping manifest, the one
 * that actually matters, unchecked by a test that runs on a device.
 *
 * This task closes that hole: it parses the MERGED RELEASE manifest — after every
 * library has merged its own components in — and fails the build if anything is
 * exported besides the launcher activity, if any permission appears, or if
 * backup is ever turned back on. A dependency that quietly adds an exported
 * receiver breaks the build instead of shipping.
 */
val verifyReleaseManifest = tasks.register("verifyReleaseManifest") {
    group = "verification"
    description = "Fails if the merged RELEASE manifest exports anything but the launcher, or asks for a permission."
    val manifest = layout.buildDirectory.file("intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml")
    inputs.file(manifest).withPropertyName("mergedReleaseManifest")
    outputs.upToDateWhen { false }
    doLast {
        val file = manifest.get().asFile
        require(file.isFile) { "merged release manifest not found at $file" }
        val xml = javax.xml.parsers.DocumentBuilderFactory.newInstance()
            .also { it.isNamespaceAware = true }
            .newDocumentBuilder().parse(file)
        val ns = "http://schemas.android.com/apk/res/android"
        fun attr(n: org.w3c.dom.Node, name: String): String? =
            n.attributes?.getNamedItemNS(ns, name)?.nodeValue

        val problems = mutableListOf<String>()

        // Nothing exported but the launcher.
        for (tag in listOf("activity", "activity-alias", "service", "receiver", "provider")) {
            val nodes = xml.getElementsByTagName(tag)
            for (i in 0 until nodes.length) {
                val node = nodes.item(i)
                val name = attr(node, "name") ?: "<unnamed>"
                if (attr(node, "exported") == "true" && name != "dev.systemslibrarian.truepad.app.MainActivity") {
                    problems += "exported $tag: $name"
                }
            }
        }

        // Only two permissions may appear: CAMERA (to scan a receive-code QR),
        // and the signature-level self-permission androidx.core defines to keep
        // its own dynamic receivers un-exported. Anything else — above all
        // INTERNET — fails the build.
        val allowedPermissions = setOf(
            "android.permission.CAMERA",
            "dev.systemslibrarian.truepad.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
        )
        val uses = xml.getElementsByTagName("uses-permission")
        for (i in 0 until uses.length) {
            val name = attr(uses.item(i), "name") ?: continue
            if (name !in allowedPermissions) {
                problems += "uses-permission: $name"
            }
        }

        // Backup stays off, and cleartext stays off.
        val app = xml.getElementsByTagName("application").item(0)
        if (attr(app, "allowBackup") != "false") problems += "allowBackup is not false"
        if (attr(app, "usesCleartextTraffic") != "false") problems += "usesCleartextTraffic is not false"

        if (problems.isNotEmpty()) {
            throw GradleException("release manifest hardening failed:\n  " + problems.joinToString("\n  "))
        }
        logger.lifecycle("release manifest: one exported component, only CAMERA, no INTERNET, backup off")
    }
}

afterEvaluate {
    verifyReleaseManifest.configure { dependsOn("processReleaseManifest") }
    tasks.named("check") { dependsOn(verifyReleaseManifest) }
}

dependencies {
    // THE ENGINE. Everything security-bearing comes from here.
    implementation(project(":truepad-storage"))

    // TPR2 QR — encode the PUBLIC receive code to a symbol, decode a scanned
    // frame back to text (ZXing core, pure Java, no network, no Play Services),
    // with CameraX for the preview and frame analysis. Reached only by the
    // sealed-transfer screens; the strict TPR2 parser validates every scan.
    implementation(libs.zxing.core)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.kotlinx.coroutines.android)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)

    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)

    testImplementation(libs.junit)

    androidTestImplementation(composeBom)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.ui.test.junit4)
}
