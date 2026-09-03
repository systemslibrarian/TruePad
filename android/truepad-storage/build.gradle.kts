import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// truepad-storage — the durable FORMAT-V2 store and the §12 transaction engine
// (verbs), over a small filesystem abstraction. Pure Kotlin/JVM: the durable
// write layer (FileChannel.force + ATOMIC_MOVE + FileChannel.lock) is plain
// java.nio and runs IDENTICALLY on Android/ART, so the security state machine is
// exercised by fast JVM tests here and reused unchanged on-device. Depends only
// on truepad-core.
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
    // The SPT crypto + durable protocol (X-Wing via Bouncy Castle). The frozen
    // OTP crypto/verbs in this module are untouched; only the added SPT
    // orchestration (SptEngine.kt) composes this module's store with the SPT
    // layer, exactly as the browser's spt-verbs sits beside its store.
    api(project(":truepad-spt"))
    testImplementation(libs.junit)
}

tasks.test {
    useJUnit()
    maxHeapSize = "1g"
    testLogging { events("passed", "failed", "skipped") }
}
