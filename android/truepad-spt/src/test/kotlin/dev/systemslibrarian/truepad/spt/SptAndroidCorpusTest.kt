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
 * The ANDROID-generated SPT corpus — `android/vectors/spt-android-generated.json`.
 *
 * The counterpart of the iOS Edition's `spt-vector-tool`. It exists so the other
 * editions can open bytes ANDROID produced, rather than inferring that they could
 * from the fact that Android reproduces the TypeScript corpus. The distinction is
 * not pedantic: every derandomized corpus bypasses production encapsulation, so a
 * fault confined to the real-entropy path would be invisible to all of them.
 *
 * Ordinarily this test VERIFIES the committed corpus — deterministic cases must
 * reseal to identical bytes, and every case must open. To regenerate it after a
 * deliberate change:
 *
 *   TRUEPAD_REGENERATE_ANDROID_CORPUS=1 ./gradlew :truepad-spt:test \
 *       --tests '*SptAndroidCorpusTest*' --rerun-tasks
 *
 * (An environment variable, not -D: Gradle's -D reaches the daemon, while the
 * test JVM is forked and inherits the environment.)
 *
 * Regeneration rewrites the production-entropy cases with fresh randomness, which
 * is expected: those bytes are evidence, not a fixture.
 */
class SptAndroidCorpusTest {

    private val corpusFile = File("../vectors/spt-android-generated.json")

    private fun hx(s: String) = hexToBytes(s) ?: error("bad hex: $s")
    private fun rep(b: String, n: Int) = b.repeat(n)

    /** Deterministic cases use the SAME inputs as the TypeScript corpus, so this
     *  file is directly comparable with `spt-interop.json`. */
    private val deterministicInputs = listOf(
        Quad(
            "vector-c",
            "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c",
            "07121d28333e49545f6a75808b96a1acb7c2cdd8e3eef9040f1a25303b46515c" +
                "67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85909ba6b1bc",
            "031425364758697a8b9cadbecfe0f102",
            "TruePad SPT vector C payload — opaque bytes.\n",
        ),
        Quad("empty-payload", rep("aa", 32), rep("bb", 64), rep("cc", 16), ""),
        Quad("one-kib-payload", rep("11", 32), rep("22", 64), rep("33", 16), "P".repeat(1024)),
    )

    private val productionInputs = listOf(
        Triple("production-entropy-short", rep("3d", 32) to rep("d3", 16), "sealed by Android with SecureRandom\n"),
        Triple("production-entropy-empty", rep("4e", 32) to rep("e4", 16), ""),
        Triple("production-entropy-1kib", rep("5f", 32) to rep("f5", 16), "R".repeat(1024)),
    )

    private data class Quad(
        val label: String,
        val seed: String,
        val eseed: String,
        val requestId: String,
        val payload: String,
    )

    private fun seal(seedHex: String, requestIdHex: String, payload: ByteArray, eseedHex: String?): Triple<ByteArray, ByteArray, SealResult> {
        val seed = hx(seedHex)
        val keys = XWing.generateKeyPairDerand(seed)
        val body = encodeRequestBody(hx(requestIdHex), keys.encapsulationKey)
        val sealed =
            if (eseedHex != null) sealPayloadV1(body, payload, eseedForVectorsOnly = hx(eseedHex))
            else sealPayloadV1(body, payload)
        // Self-check before the bytes become evidence for anyone else.
        when (val outcome = openPayloadV1(sealed.packageBytes, body, seed)) {
            is OpenOutcome.Fail -> error("Android could not open its own package: ${outcome.reason}")
            is OpenOutcome.Ok -> check(outcome.result.payload.contentEquals(payload)) {
                "Android open payload mismatch"
            }
        }
        return Triple(body, seed, sealed)
    }

    private fun entry(
        label: String,
        reproducible: Boolean,
        eseedHex: String?,
        body: ByteArray,
        seedHex: String,
        payload: ByteArray,
        sealed: SealResult,
    ): String {
        val indices = sealed.confirmationIndices.joinToString(", ")
        val eseedLine = if (eseedHex != null) "\n      \"eseedHex\": \"$eseedHex\"," else ""
        return """
    {
      "confirmValueHex": "${bytesToHex(sealed.confirmValue)}",
      "confirmationIndices": [$indices],
      "decapSeedHex": "$seedHex",$eseedLine
      "label": "$label",
      "packageHex": "${bytesToHex(sealed.packageBytes)}",
      "payloadHex": "${bytesToHex(payload)}",
      "reproducible": $reproducible,
      "requestBodyHex": "${bytesToHex(body)}"
    }""".trimEnd()
    }

    private fun regenerate() {
        val entries = mutableListOf<String>()
        for (c in deterministicInputs) {
            val payload = c.payload.toByteArray(Charsets.UTF_8)
            val (body, _, sealed) = seal(c.seed, c.requestId, payload, c.eseed)
            entries += entry(c.label, true, c.eseed, body, c.seed, payload, sealed)
        }
        for ((label, keys, text) in productionInputs) {
            val payload = text.toByteArray(Charsets.UTF_8)
            val (body, _, sealed) = seal(keys.first, keys.second, payload, null)
            entries += entry(label, false, null, body, keys.first, payload, sealed)
        }
        val note = "Android Edition SPT seal output. Cases with reproducible=true must be reproduced " +
            "byte-for-byte by any edition from the same inputs; every case must OPEN to payloadHex. " +
            "Cases with reproducible=false were sealed with real entropy from the production path " +
            "and cannot be regenerated identically -- they exist so the other editions open bytes " +
            "this edition produced WITHOUT injected randomness."
        corpusFile.writeText(
            """{
  "note": "$note",
  "source": "android/truepad-spt CryptoV1.kt sealPayloadV1",
  "cases": [${entries.joinToString(",")}
  ]
}
""",
        )
    }

    @Test
    fun theAndroidCorpusReproducesAndOpens() {
        if (System.getenv("TRUEPAD_REGENERATE_ANDROID_CORPUS") == "1") {
            regenerate()
            println("regenerated ${corpusFile.canonicalPath}")
        }
        assertTrue("the Android corpus should be committed", corpusFile.isFile)

        val root = parseJson(corpusFile.readText()) as JsonObject
        val cases = (root.members.getValue("cases") as JsonArray).items.map { it as JsonObject }
        assertTrue("expected Android corpus cases", cases.size >= 6)

        var deterministic = 0
        var production = 0
        for (o in cases) {
            fun s(k: String) = (o.members.getValue(k) as JsonString).value
            val label = s("label")
            val reproducible = (o.members.getValue("reproducible") as JsonBool).value
            val body = hx(s("requestBodyHex"))
            val payload = hx(s("payloadHex"))
            val packageBytes = hx(s("packageHex"))
            val seed = hx(s("decapSeedHex"))
            val confirmValue = hx(s("confirmValueHex"))
            val indices = (o.members.getValue("confirmationIndices") as JsonArray).items
                .map { (it as JsonNumber).raw.toInt() }.toIntArray()

            // Every case must open here.
            when (val outcome = openPayloadV1(packageBytes, body, seed)) {
                is OpenOutcome.Fail -> throw AssertionError("$label: Android refused its own corpus: ${outcome.reason}")
                is OpenOutcome.Ok -> {
                    assertArrayEquals("$label: payload", payload, outcome.result.payload)
                    assertArrayEquals("$label: confirmValue", confirmValue, outcome.result.confirmValue)
                    assertArrayEquals("$label: confirmationIndices", indices, outcome.result.confirmationIndices)
                }
            }

            if (reproducible) {
                deterministic += 1
                val eseed = hx(s("eseedHex"))
                val resealed = sealPayloadV1(body, payload, eseedForVectorsOnly = eseed)
                assertEquals("$label: package", s("packageHex"), bytesToHex(resealed.packageBytes))
            } else {
                production += 1
            }
        }
        assertTrue("expected deterministic cases", deterministic >= 3)
        assertTrue("expected production-entropy cases", production >= 3)
    }
}
