import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// truepad-spt — the Sealed Pad Transfer crypto + protocol port, pure Kotlin/JVM.
//
// Kept SEPARATE from truepad-core (the frozen authenticated-OTP kernel) so the
// OTP/message wire stays untouched (Decision 19). This module owns X-Wing
// (suite 0x0001 = ML-KEM-768 + X25519, via Bouncy Castle's low-level API), the
// HKDF-SHA-256 schedule with the derived/re-checked GCM nonce, AES-256-GCM, the
// TPR2/TPS2 wire formats, and the SPT protocol state machine — all byte-exact to
// the released Browser/CLI implementation and verified against the shared SPT
// vectors on any JVM.
//
// Bouncy Castle is used through its low-level `org.bouncycastle.pqc.crypto.*` /
// `org.bouncycastle.crypto.*` API — NOT registered as a JCA provider — so it
// never clashes with Android's bundled org.bouncycastle (Decision 1).
plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":truepad-core"))
    implementation(libs.bouncycastle.bcprov)
    testImplementation(libs.junit)
}

tasks.test {
    useJUnit()
    testLogging { events("passed", "failed", "skipped") }
}
