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

// Pure-Kotlin/JVM libraries — the byte-exact protocol port and the durable
// store/transaction engine over a filesystem abstraction. No Android SDK, so
// they build and test on any JVM (CI runs these emulator-free).
include(":truepad-core")
include(":truepad-storage")
// The native Android application: Compose UI + the Android filesystem/lifecycle
// bindings that wire the pure-Kotlin engine to the platform.
include(":app")
// Modules are added to the tree as they are created during the build-up; a
// project directory that does not yet exist is pruned so partial trees build.
rootProject.children.toList().forEach { p ->
    if (!p.projectDir.resolve("build.gradle.kts").exists()) {
        // Not yet scaffolded — drop it from this configuration.
        rootProject.children.remove(p)
    }
}
