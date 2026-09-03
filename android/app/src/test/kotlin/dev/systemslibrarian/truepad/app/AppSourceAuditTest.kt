package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SOURCE-LEVEL AUDITS, for the properties a behavioural test cannot see.
 *
 * A logging call that only fires on an error path, a dependency that only opens
 * a socket in production, a backup rule that stops excluding things — none of
 * those show up when the app is working correctly. They show up in the source,
 * so that is where they are checked, and the build fails rather than the leak
 * shipping.
 *
 * These run as plain JVM tests, so they gate every build, not only the ones with
 * a device attached.
 */
class AppSourceAuditTest {

    private val appSources: List<File> = File("src/main/kotlin")
        .walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    private val resDir = File("src/main/res")
    private val manifest = File("src/main/AndroidManifest.xml")

    /*
     * CODE ONLY, never commentary.
     *
     * This file's own first draft failed against itself, and it was right to:
     * these sources explain at length WHY they do not use SharedPreferences, a
     * FileProvider, or the INTERNET permission, and a scanner that reads the
     * explanation as the thing it forbids is a scanner that punishes the
     * documentation. Comments are stripped before any banned token is looked
     * for; a sentence saying "TruePad has no FileProvider" must not fail a test
     * that exists to keep it true.
     */
    private fun File.code(): String {
        var text = readText().replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), " ")
        text = text.lines().joinToString("\n") { line ->
            var inString = false
            var i = 0
            while (i < line.length - 1) {
                val c = line[i]
                if (c == '"' && (i == 0 || line[i - 1] != '\\')) inString = !inString
                if (!inString && c == '/' && line[i + 1] == '/') return@joinToString line.substring(0, i)
                i += 1
            }
            line
        }
        return text
    }

    private fun xmlCode(f: File): String =
        f.readText().replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), " ")

    @Test
    fun theAuditActuallyFindsTheSources() {
        assertTrue("expected the app sources, found ${appSources.size}", appSources.size >= 8)
        assertTrue(manifest.isFile)
    }

    /**
     * NO CONTROL CHARACTER SURVIVES IN A SOURCE FILE, anywhere under android/.
     *
     * This has now bitten twice, both times in HostileUriTest, both times because
     * a test needed a NUL or a bidi override as DATA and it was written as a raw
     * byte instead of an escape. The consequence is not cosmetic: git classifies
     * the whole file as binary, so it stops producing diffs, `grep` stops finding
     * anything in it, and a security test file becomes one nobody can review.
     *
     * The data is still tested — as `\u0000`, `\u202e` and so on, which the
     * compiler turns into exactly the same characters at runtime. What is
     * forbidden is the raw byte in the file on disk.
     *
     * Bidi overrides are included because they are worse than invisible: they
     * REORDER the text around them, so a line can render as something other than
     * what it says.
     */
    @Test
    fun noSourceFileContainsARawControlCharacter() {
        val roots = listOf(File("src"), File("../truepad-core/src"), File("../truepad-storage/src"), File("../tools"))
        val sources = roots.flatMap { root ->
            root.walkTopDown()
                .filter { it.isFile && it.extension in setOf("kt", "kts", "xml", "sh", "mjs", "pro") }
                .toList()
        }
        assertTrue("the audit must find sources, found ${sources.size}", sources.size >= 25)

        val forbidden = sortedSetOf<Int>()
        val offenders = mutableListOf<String>()
        for (f in sources) {
            val bytes = f.readBytes()
            // Raw control bytes: anything below space except tab and newline,
            // plus DEL. Carriage return is allowed only as part of CRLF, which
            // this repo does not use, so it is forbidden too.
            val control = bytes.filter { b ->
                val v = b.toInt() and 0xFF
                (v < 0x20 && v != 0x09 && v != 0x0A) || v == 0x7F
            }
            if (control.isNotEmpty()) {
                control.forEach { forbidden.add(it.toInt() and 0xFF) }
                offenders += "${f.path} (${control.map { "0x%02x".format(it.toInt() and 0xFF) }.distinct()})"
            }
            // Invisible direction controls. The overrides and isolates REORDER
            // the text around them, so a line can render as something other than
            // what it says; the marks are merely invisible. Both are banned raw.
            val text = String(bytes, Charsets.UTF_8)
            val bidi = text.filter {
                it in "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F"
            }
            if (bidi.isNotEmpty()) {
                offenders += "${f.path} (direction control ${bidi.map { "U+%04X".format(it.code) }.distinct()})"
            }
        }
        assertTrue(
            "write these as escapes, never as raw bytes — a source file with one in it " +
                "stops being diffable and greppable:\n  " + offenders.joinToString("\n  "),
            offenders.isEmpty(),
        )
    }

    /**
     * NOTHING IS LOGGED. Not a debug line, not an error, not a stack trace.
     *
     * Logcat is readable by the user, by any debugger attached to the device, and
     * historically by other applications. TruePad has nothing it needs to say
     * there, and the only way a plaintext or a pad byte reaches it is through a
     * call that does not exist.
     */
    @Test
    fun theAppLogsNothing() {
        val banned = listOf(
            "android.util.Log", "Log.d(", "Log.e(", "Log.i(", "Log.v(", "Log.w(", "Log.wtf(",
            "println(", "System.out", "System.err", "printStackTrace", "Timber",
        )
        for (f in appSources) {
            val text = f.code()
            for (b in banned) {
                assertFalse("${f.name} must not reference $b", text.contains(b))
            }
        }
    }

    /**
     * NO NETWORK, NO TELEMETRY, and no way to add one by accident. The manifest
     * has no INTERNET permission; this makes sure no code is written that would
     * need it, so the two cannot drift apart.
     */
    @Test
    fun theAppHasNoNetworkOrTelemetrySurface() {
        val banned = listOf(
            "java.net.", "HttpURLConnection", "okhttp", "retrofit", "Socket(", "URLConnection",
            "firebase", "crashlytics", "analytics", "Sentry", "WebSocket", "WebView",
            "android.webkit",
        )
        for (f in appSources) {
            val text = f.code()
            for (b in banned) {
                assertFalse("${f.name} must not reference $b", text.contains(b, ignoreCase = true))
            }
        }
        val manifestText = xmlCode(manifest)
        assertFalse("no INTERNET permission", manifestText.contains("android.permission.INTERNET"))
        assertFalse("no permission of any kind", manifestText.contains("<uses-permission"))
        assertTrue("cleartext traffic is off", manifestText.contains("android:usesCleartextTraffic=\"false\""))
    }

    /**
     * BACKUP STAYS OFF, in all three places it is expressed.
     *
     * allowBackup is the attribute the platform reads; the two XML rule files are
     * the belt for the channels where the attribute alone has not always been
     * documented as sufficient — notably device-to-device transfer. Weakening any
     * one of them is what would let a pad store come back from a copy, which is
     * the restore-to-reuse path the whole witness design exists to catch.
     */
    @Test
    fun everyBackupChannelExcludesEverything() {
        val manifestText = xmlCode(manifest)
        assertTrue("allowBackup must be false", manifestText.contains("android:allowBackup=\"false\""))
        assertTrue(manifestText.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""))
        assertTrue(manifestText.contains("android:fullBackupContent=\"@xml/backup_rules\""))
        assertTrue(
            "uninstall must not offer to keep the data",
            manifestText.contains("android:hasFragileUserData=\"false\""),
        )

        val extraction = xmlCode(File(resDir, "xml/data_extraction_rules.xml"))
        assertTrue("cloud backup must exclude root", Regex("<cloud-backup>\\s*<exclude domain=\"root\"\\s*/>").containsMatchIn(extraction))
        assertTrue("device transfer must exclude root", Regex("<device-transfer>\\s*<exclude domain=\"root\"\\s*/>").containsMatchIn(extraction))
        assertFalse("nothing may be included", extraction.contains("<include"))

        val full = xmlCode(File(resDir, "xml/backup_rules.xml"))
        assertTrue(full.contains("<exclude domain=\"root\""))
        assertFalse("nothing may be included", full.contains("<include"))
    }

    /**
     * NO FileProvider, and no paths XML. The app hands nothing to another
     * application by URI: export writes through the Storage Access Framework to
     * a destination the operator picked. There is therefore no authority that
     * could ever resolve a path into the pad store.
     */
    @Test
    fun thereIsNoFileProviderAndNoPathsConfiguration() {
        assertFalse(xmlCode(manifest).contains("FileProvider", ignoreCase = true))
        val pathsFiles = resDir.walkTopDown().filter { it.isFile && it.name.contains("path", ignoreCase = true) }.toList()
        assertTrue("no provider paths XML may exist, found $pathsFiles", pathsFiles.isEmpty())
        for (f in appSources) {
            assertFalse("${f.name} must not use FileProvider", f.code().contains("FileProvider"))
        }
    }

    /**
     * FLAG_SECURE is set, and it is set on the WINDOW before the first frame —
     * not per-screen, where a new screen would be forgotten.
     */
    @Test
    fun theWindowIsMarkedSecureInSource() {
        val activity = appSources.single { it.name == "MainActivity.kt" }.code()
        assertTrue(activity.contains("WindowManager.LayoutParams.FLAG_SECURE"))
        assertTrue(
            "the flag must be applied before super.onCreate so the first frame and the Recents thumbnail are covered",
            activity.indexOf("applySecureFlag()") < activity.indexOf("super.onCreate"),
        )
    }

    /**
     * SECRET STATE GOES IN ONE PLACE. Not SharedPreferences, not DataStore, not
     * external or media storage — the engine's app-private directories, through
     * the engine. The only preference this app keeps is a list of pairIds it has
     * been asked to stop showing, which is public metadata in a plain file.
     */
    @Test
    fun noSecretStateGoesToAPlatformStore() {
        val banned = listOf(
            "getSharedPreferences", "SharedPreferences", "PreferenceManager",
            "DataStore", "preferencesDataStore",
            "getExternalStorageDirectory", "getExternalFilesDir", "Environment.DIRECTORY",
            "MediaStore", "openFileOutput",
        )
        for (f in appSources) {
            val text = f.code()
            for (b in banned) {
                assertFalse("${f.name} must not use $b", text.contains(b))
            }
        }
    }

    /**
     * THE TWO DIRECTORIES. The store goes in filesDir; the rollback witness goes
     * in noBackupFilesDir, which backup and device transfer do not carry. Binding
     * them to the same tree would silently destroy rollback detection while every
     * behavioural test still passed, so it is asserted in the source as well as
     * on the device.
     */
    @Test
    fun theWitnessIsBoundOutsideTheBackedUpTree() {
        val storage = appSources.single { it.name == "AndroidStorage.kt" }.code()
        assertTrue("the store must use filesDir", storage.contains("File(context.filesDir, STORE_DIR_NAME)"))
        assertTrue(
            "the witness must use noBackupFilesDir",
            storage.contains("File(context.noBackupFilesDir, WITNESS_DIR_NAME)"),
        )
        val witnessFn = storage.substringAfter("fun witnessRoot(").substringBefore("\n")
        assertFalse("witnessRoot must not resolve to filesDir", witnessFn.contains("filesDir)"))
    }

    /**
     * THE CLAIMS TEXT is not editorial. The released product forbids a specific
     * vocabulary on the randomness path, and forbids it as an ASSERTION — a
     * sentence whose whole purpose is to deny the claim ("TruePad cannot
     * determine whether a file is truly random") is the discipline working, not
     * a violation. So the scan is sentence-scoped, exactly as the released
     * suite's is: a banned phrase is only a failure in a sentence that does not
     * negate it.
     */
    @Test
    fun noClaimAssertsWhatTheProductRefusesToClaim() {
        val banned = listOf(
            "truly random", "true random", "physical randomness", "physically random",
            "physically proven", "proven random", "information-theoretically verified",
            "perfect secrecy achieved", "true otp verified", "information-theoretic security confirmed",
            "verified", "certified", "proven", "confirmed",
        )
        val negation = Regex(
            "\\bnever\\b|\\bnot\\b|\\bno\\b|\\bcannot\\b|\\bcan't\\b|\\bwithout\\b|\\bunverified\\b|\\bonly if\\b|\\bwould\\b",
            RegexOption.IGNORE_CASE,
        )
        // The VALUES, read off the compiled object with plain Java reflection.
        // Scraping literals out of the source would split a concatenated
        // constant into fragments and then judge each fragment as if it were a
        // sentence — which is how the first version of this test failed. Java
        // reflection rather than Kotlin's keeps kotlin-reflect off the test
        // classpath for one assertion.
        val literals = Claims::class.java.declaredFields
            .filter { it.type == String::class.java }
            .mapNotNull { f -> runCatching { f.isAccessible = true; f.get(Claims) as? String }.getOrNull() }
            .filter { it.length >= 20 }
        assertTrue("expected the claims strings, found ${literals.size}", literals.size >= 15)

        for (literal in literals) {
            for (sentence in literal.split(Regex("(?<=[.!?])\\s+"))) {
                for (phrase in banned) {
                    if (sentence.contains(phrase, ignoreCase = true) && !negation.containsMatchIn(sentence)) {
                        throw AssertionError("a claim ASSERTS \"$phrase\" without negating it: $sentence")
                    }
                }
            }
        }

        // And the load-bearing sentences are present verbatim, so a future edit
        // cannot quietly drop the disclaimer half of a claim.
        assertEquals(
            "TruePad cannot determine whether a file is truly random.",
            Claims.CEREMONY_CANNOT_VERIFY,
        )
        assertTrue(Claims.DEVICE_DETAIL.contains("does not call this physically proven randomness"))
        assertTrue(Claims.DEVICE_DETAIL.contains("computational and platform assumptions"))
        assertTrue(Claims.OPERATOR_DECLARATION.startsWith("I understand that TruePad cannot verify physical randomness."))
        assertTrue(Claims.OPERATOR_DECLARATION.contains("about this pad's material"))
        assertTrue(Claims.EXTERNAL_NOT_VERIFIED == "TruePad did not verify that assumption.")
        assertTrue(Claims.CEREMONY_COMBINER == "TruePad combines every selected source byte-for-byte using XOR.")
    }
}
