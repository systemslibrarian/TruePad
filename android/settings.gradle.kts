pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "truepad-android"

// The module tree, in the order it is being built up.
//
//   truepad-core     the byte-exact protocol port — pure Kotlin/JVM, no Android
//                    SDK, so it builds and tests on any JVM (CI runs it
//                    emulator-free).
//   truepad-storage  the durable Store Format v2 engine and the §12 transaction
//                    verbs over a filesystem abstraction. Also pure Kotlin/JVM:
//                    the durable write layer is plain java.nio and runs
//                    IDENTICALLY on Android/ART, so the security state machine
//                    is exercised by fast JVM tests and reused unchanged on
//                    device. See docs/ANDROID-SECURITY.md.
//   app              the native application: Compose UI plus the Android
//                    filesystem/lifecycle bindings.
//
// A module is included only once its directory exists. An earlier version
// included ":app" unconditionally and pruned it afterwards, which Gradle 8.14
// deprecates ("Configuring project ':app' without an existing directory") and
// Gradle 9.0 turns into a hard error. Listing the intended modules here and
// filtering keeps the roadmap visible without configuring a project that is not
// there.
//   truepad-spt      the Sealed Pad Transfer crypto + protocol port — pure
//                    Kotlin/JVM, isolated from the OTP kernel (truepad-core),
//                    depends on Bouncy Castle for X-Wing/ML-KEM-768. Kept
//                    SEPARATE so the frozen authenticated-OTP path stays
//                    untouched (Decision 19). Byte-checked against the released
//                    SPT wire on any JVM.
listOf("truepad-core", "truepad-storage", "truepad-spt", "app")
    .filter { file("$rootDir/$it/build.gradle.kts").isFile }
    .forEach { include(":$it") }
