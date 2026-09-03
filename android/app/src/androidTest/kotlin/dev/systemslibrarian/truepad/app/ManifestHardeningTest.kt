package dev.systemslibrarian.truepad.app

import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE ATTACK SURFACE, asserted against the APK that was actually built.
 *
 * A manifest is easy to harden once and easy to loosen by accident: a library
 * merges in a provider, someone adds an intent-filter for convenience, a
 * dependency drags in INTERNET. None of that shows up in a behavioural test, so
 * this reads the INSTALLED package — after manifest merging, which is the only
 * version that matters — and fails if the surface grew.
 */
@RunWith(AndroidJUnit4::class)
class ManifestHardeningTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val pkg = context.packageName

    @Suppress("DEPRECATION") // the int-flag overloads are what work across API 26..35
    private fun info(flags: Int) = context.packageManager.getPackageInfo(pkg, flags)

    @Test
    fun theApplicationIdIsTheOneTheEngineModulesEstablished() {
        assertEquals("dev.systemslibrarian.truepad", pkg)
    }

    /**
     * NO permission that grants a capability. androidx.core defines one
     * SIGNATURE-level permission named after the application id, used to keep
     * dynamically-registered receivers un-exported — it grants nothing to anyone
     * and is itself a hardening measure. Everything else must be absent, and
     * INTERNET is called out by name because it is the one that would turn a
     * local-only app into something that can talk.
     */
    @Test
    fun theAppRequestsNoCapabilityGrantingPermission() {
        val requested = info(PackageManager.GET_PERMISSIONS).requestedPermissions?.toList() ?: emptyList()
        // CAMERA is allowed — and only CAMERA — because scanning a receive-code
        // QR needs it. It grants no network and no storage; the frames are
        // decoded in-process and discarded. The self-permission androidx.core
        // adds is a hardening measure, not a capability.
        val allowed = setOf(
            android.Manifest.permission.CAMERA,
            "$pkg.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
        )
        val unexpected = requested.filterNot { it in allowed }
        assertTrue("unexpected permissions in the merged manifest: $unexpected", unexpected.isEmpty())

        assertFalse("INTERNET must never be requested", requested.contains(android.Manifest.permission.INTERNET))
        assertFalse(requested.contains(android.Manifest.permission.ACCESS_NETWORK_STATE))
        assertFalse(requested.contains(android.Manifest.permission.READ_EXTERNAL_STORAGE))
        assertFalse(requested.contains(android.Manifest.permission.WRITE_EXTERNAL_STORAGE))

        // And the runtime agrees: the package genuinely cannot open a socket.
        assertEquals(
            "the platform must not have granted INTERNET",
            PackageManager.PERMISSION_DENIED,
            context.packageManager.checkPermission(android.Manifest.permission.INTERNET, pkg),
        )
    }

    /**
     * EXACTLY ONE exported component: the launcher activity, which must be
     * exported to appear in the launcher. Anything else exported is a door
     * another application can knock on.
     */
    @Test
    fun onlyTheLauncherActivityIsExported() {
        val activities = info(PackageManager.GET_ACTIVITIES).activities?.toList() ?: emptyList()
        val exported = activities.filter { it.exported }.map { it.name }.toSet()

        // Instrumentation necessarily runs against the DEBUG build, and the
        // debug build carries Compose's own tooling activities: PreviewActivity
        // from ui-tooling, and the empty host activity from ui-test-manifest.
        // Both are debugImplementation-only and are not in the shipping APK.
        // They are named here rather than waved through with a substring match,
        // so a THIRD one appearing still fails.
        val debugOnlyTooling = setOf(
            "androidx.compose.ui.tooling.PreviewActivity",
            "androidx.activity.ComponentActivity",
        )
        val ours = exported - debugOnlyTooling
        assertEquals(
            "no TruePad activity but the launcher may be exported",
            setOf("dev.systemslibrarian.truepad.app.MainActivity"),
            ours,
        )
        // The SHIPPING manifest is checked where it can actually be checked:
        // the :app:verifyReleaseManifest Gradle task parses the merged RELEASE
        // manifest and fails the build if anything but the launcher is exported.
        // That task is wired into `check`, so this pair of gates covers both
        // build types and neither can be satisfied by the other.
    }

    /**
     * NO PROVIDER of TruePad's own. This is the strongest form of the
     * FileProvider question: rather than configuring one narrowly and hoping the
     * paths XML stays correct, the app has none at all — export goes through the
     * Storage Access Framework to a location the operator picked, and sharing an
     * encrypted message uses plain text. There is therefore no way to hand
     * another app a URI into the pad store, because there is no authority that
     * could resolve one.
     *
     * AndroidX merges in its own initialisation and profile providers. They are
     * asserted un-exported by name rather than waved through as "framework
     * stuff".
     */
    @Test
    fun theAppPublishesNoExportedProviderAndNoFileProvider() {
        val providers = info(PackageManager.GET_PROVIDERS).providers?.toList() ?: emptyList()
        val exported = providers.filter { it.exported }.map { it.name }
        assertTrue("no provider may be exported, found: $exported", exported.isEmpty())

        val fileProviders = providers.filter { it.name.contains("FileProvider", ignoreCase = true) }
        assertTrue(
            "the app deliberately has no FileProvider; found ${fileProviders.map { it.name }}",
            fileProviders.isEmpty(),
        )
        // Every provider that survived the merge is androidx infrastructure.
        for (p in providers) {
            assertTrue(
                "unexpected content provider in the merged manifest: ${p.name}",
                p.name.startsWith("androidx."),
            )
        }
    }

    @Test
    fun thereAreNoExportedServicesOrReceivers() {
        val services = info(PackageManager.GET_SERVICES).services?.toList() ?: emptyList()
        assertTrue(
            "no service may be exported, found: ${services.filter { it.exported }.map { it.name }}",
            services.none { it.exported },
        )
        val receivers = info(PackageManager.GET_RECEIVERS).receivers?.toList() ?: emptyList()
        assertTrue(
            "no receiver may be exported, found: ${receivers.filter { it.exported }.map { it.name }}",
            receivers.none { it.exported },
        )
    }

    /**
     * The app advertises itself as a handler for NOTHING. A hostile application
     * cannot push a file, a URI, or a share into TruePad — the operator pulls,
     * through a picker they opened. The launcher activity's only filter is
     * MAIN/LAUNCHER, so nothing resolves to it by data type.
     */
    @Test
    fun theAppIsNotAHandlerForAnyContent() {
        val pm = context.packageManager
        val hostile = listOf(
            android.content.Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(android.net.Uri.parse("content://example/x"), "application/json"),
            android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain"),
            android.content.Intent(android.content.Intent.ACTION_SEND).setType("*/*"),
            android.content.Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(android.net.Uri.parse("file:///sdcard/x.json"), "*/*"),
        )
        for (intent in hostile) {
            intent.setPackage(pkg)
            @Suppress("DEPRECATION")
            val matches = pm.queryIntentActivities(intent, 0)
            assertTrue(
                "TruePad must not resolve $intent — found ${matches.map { it.activityInfo.name }}",
                matches.isEmpty(),
            )
        }
    }

    /**
     * Backup is off, and it is off in the flags the platform actually reads —
     * not merely in an XML file that a wrong attribute could leave unconsulted.
     */
    @Test
    fun backupIsDisabledInTheAppliedApplicationFlags() {
        val app = context.applicationInfo
        assertEquals(
            "FLAG_ALLOW_BACKUP must be clear",
            0,
            app.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP,
        )
        assertNull(
            "with allowBackup=false there must be no backup agent",
            app.backupAgentName,
        )
        assertEquals(
            "cleartext traffic must be off",
            0,
            app.flags and android.content.pm.ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC,
        )
    }
}
