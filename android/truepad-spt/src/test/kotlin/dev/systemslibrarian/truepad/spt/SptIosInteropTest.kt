package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonBool
import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.hexToBytes
import dev.systemslibrarian.truepad.core.parseJson
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Cross-language SPT interoperability with the iOS Edition.
 *
 * SptInteropTest checks the TypeScript-generated corpus. This one points the
 * other way: `ios/vectors/spt-swift-generated.json` is sealed by the iOS Edition
 * (`swift run spt-vector-tool`), and Kotlin must open it.
 *
 *   - IOS -> ANDROID: Kotlin OPENS every Swift-sealed package and recovers
 *     exactly `payloadHex`, with the same confirmation value and word indices —
 *     so two people running Android and iOS read the same eight words.
 *   - ANDROID -> IOS: for the `reproducible` cases, Kotlin re-seals the same
 *     inputs to byte-identical bytes, so a Swift opener (which opens its own
 *     byte-identical output, self-checked at generation) opens an Android
 *     package too.
 *
 * The `reproducible: false` cases were sealed with REAL entropy on the iOS
 * production path. Nobody can reproduce those bytes, so they are opened and not
 * compared. They matter because every derandomized corpus — this one included —
 * bypasses production encapsulation entirely, and a fault confined to that path
 * would otherwise be invisible.
 */
class SptIosInteropTest {

    private fun hx(s: String) = hexToBytes(s) ?: error("bad hex: $s")

    private data class Case(
        val label: String,
        val reproducible: Boolean,
        val eseed: ByteArray?,
        val requestBody: ByteArray,
        val decapSeed: ByteArray,
        val payload: ByteArray,
        val packageBytes: ByteArray,
        val confirmValue: ByteArray,
        val indices: IntArray,
    )

    private val root: JsonObject =
        parseJson(File("../../ios/vectors/spt-swift-generated.json").readText()) as JsonObject

    private val cases: List<Case> = run {
        (root.members.getValue("cases") as JsonArray).items.map { it as JsonObject }.map { o ->
            fun s(k: String) = (o.members.getValue(k) as JsonString).value
            val idx = (o.members.getValue("confirmationIndices") as JsonArray).items
                .map { (it as JsonNumber).raw.toInt() }.toIntArray()
            val reproducible = (o.members.getValue("reproducible") as JsonBool).value
            Case(
                s("label"),
                reproducible,
                if (reproducible) hx(s("eseedHex")) else null,
                hx(s("requestBodyHex")),
                hx(s("decapSeedHex")),
                hx(s("payloadHex")),
                hx(s("packageHex")),
                hx(s("confirmValueHex")),
                idx,
            )
        }
    }

    @Test
    fun theIosCorpusIsPresentAndCoversBothSealPaths() {
        assertTrue("expected iOS interop cases", cases.size >= 6)
        assertTrue("expected deterministic cases", cases.any { it.reproducible })
        assertTrue("expected production-entropy cases", cases.any { !it.reproducible })
        assertTrue(
            "the corpus should still be the iOS seal output",
            (root.members.getValue("source") as JsonString).value.contains("ios/TruePadKit"),
        )
    }

    /** IOS -> ANDROID. Every Swift-sealed package, including the ones sealed with
     *  real entropy, opens here and yields the same payload and ceremony values. */
    @Test
    fun androidOpensEveryIosSealedPackage() {
        for (c in cases) {
            when (val outcome = openPayloadV1(c.packageBytes, c.requestBody, c.decapSeed)) {
                is OpenOutcome.Fail ->
                    throw AssertionError("${c.label}: Android refused an iOS package: ${outcome.reason} — ${outcome.message}")
                is OpenOutcome.Ok -> {
                    assertArrayEquals("${c.label}: payload", c.payload, outcome.result.payload)
                    assertArrayEquals("${c.label}: confirmValue", c.confirmValue, outcome.result.confirmValue)
                    assertArrayEquals("${c.label}: confirmationIndices", c.indices, outcome.result.confirmationIndices)
                }
            }
        }
    }

    /** ANDROID -> IOS, for the deterministic cases: identical inputs must give
     *  byte-identical output across the two implementations. */
    @Test
    fun androidResealsTheIosDeterministicCasesToIdenticalBytes() {
        val deterministic = cases.filter { it.reproducible }
        assertTrue("expected deterministic cases", deterministic.isNotEmpty())
        for (c in deterministic) {
            val sealed = sealPayloadV1(c.requestBody, c.payload, eseedForVectorsOnly = c.eseed!!)
            assertEquals("${c.label}: package", bytesToHex(c.packageBytes), bytesToHex(sealed.packageBytes))
            assertEquals("${c.label}: confirmValue", bytesToHex(c.confirmValue), bytesToHex(sealed.confirmValue))
            assertArrayEquals("${c.label}: confirmationIndices", c.indices, sealed.confirmationIndices)
        }
    }

    /** The recipient's stored private key is the 32-byte X-Wing seed. The public
     *  half carried in the iOS request body must be exactly what that seed
     *  re-derives here — the property that keeps a recipient key portable across
     *  editions. */
    @Test
    fun androidRederivesTheEncapsulationKeyFromTheIosSeed() {
        for (c in cases) {
            val parsed = parseRequestBody(c.requestBody)
            assertTrue("${c.label}: iOS request body should parse", parsed is RequestBodyParse.Ok)
            val request = (parsed as RequestBodyParse.Ok).request
            val pair = XWing.generateKeyPairDerand(c.decapSeed)
            assertEquals(
                "${c.label}: decapSeed does not re-derive the iOS encapsulation key",
                bytesToHex(request.encapsulationKey),
                bytesToHex(pair.encapsulationKey),
            )
        }
    }
}
