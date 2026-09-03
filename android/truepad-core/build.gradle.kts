import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// truepad-core — the byte-exact TruePad 2 protocol, pure Kotlin on the JVM.
// NO Android dependency: this is the frozen crypto/wire kernel, reused verbatim
// by the storage engine and the app, and verified against the shared frozen
// vectors on any JVM (see src/test). Targets JVM 17 bytecode (Android-consumable)
// using the running JDK, so no toolchain provisioning is needed.
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
    testImplementation(libs.junit)
}

tasks.test {
    useJUnit()
    testLogging { events("passed", "failed", "skipped") }
}
