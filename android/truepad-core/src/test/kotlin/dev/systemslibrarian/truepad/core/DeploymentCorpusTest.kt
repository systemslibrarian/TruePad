package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CROSS-LANGUAGE EVALUATOR CONFORMANCE.
 *
 * `android/vectors/deployment-evaluator-v3.json` is derived DIRECTLY from the
 * canonical TypeScript evaluator (src/claims/shannon-deployment.ts's
 * `assessDeployment`) by scripts/gen-evaluator-corpus.ts, and is byte-identical
 * to the repo-root test-vectors/ copy (guarded on the TS side). This test proves
 * the Kotlin `assessDeployment` reproduces the canonical classification for every
 * fact tuple. A divergence here means the two editions could disagree about
 * whether a pad is eligible — a release blocker.
 *
 * It also re-pins the honest Android mandate at the evaluator level: no Android
 * fact tuple is ever CONDITIONALLY ELIGIBLE, a software-CSPRNG source is a hard
 * NOT ELIGIBLE, and an external-source native Android pad is INSUFFICIENT.
 */
class DeploymentCorpusTest {

    private fun health(o: JsonObject): WitnessHealth =
        WitnessHealth.fromWire(o.str("health")) ?: error("bad witness health: ${o.str("health")}")

    private fun rollback(o: JsonObject): RollbackAuthority = when (val kind = o.str("kind")) {
        "none" -> RollbackAuthority.None
        "unknown" -> RollbackAuthority.Unknown
        "browser-local" -> RollbackAuthority.BrowserLocal
        "separate-state-file" -> RollbackAuthority.SeparateStateFile(health(o))
        "platform-monotonic" -> RollbackAuthority.PlatformMonotonic(health(o))
        else -> error("bad rollback kind: $kind")
    }

    private fun sealedAncestor(v: JsonValue): SealedAncestor = when (v) {
        is JsonBool -> if (v.value) SealedAncestor.YES else SealedAncestor.NO
        is JsonString -> if (v.value == "unknown") SealedAncestor.UNKNOWN else error("bad sealedAncestor: ${v.value}")
        else -> error("bad sealedAncestor json: $v")
    }

    private fun facts(o: JsonObject): DeploymentFacts = DeploymentFacts(
        creation = CreationClass.fromWire(o.str("creation")) ?: error("bad creation"),
        source = SourceClass.fromWire(o.str("source")) ?: error("bad source"),
        delivery = DeliveryClass.fromWire(o.str("delivery")) ?: error("bad delivery"),
        sealedAncestor = sealedAncestor(o.members.getValue("sealedAncestor")),
        ceremonyPremises = CeremonyPremises.fromWire(o.str("ceremonyPremises")) ?: error("bad premises"),
        storage = StorageAuthority.fromWire(o.str("storage")) ?: error("bad storage"),
        rollback = rollback(o.obj("rollback")),
        assuranceAuthority = AssuranceAuthority.fromWire(o.str("assuranceAuthority")) ?: error("bad assurance"),
    )

    private val corpus = Vectors.obj("deployment-evaluator-v3.json")
    private val cases = corpus.arr("cases").map { it.asObj() }

    @Test
    fun theCorpusIsNonTrivialAndSelfDescribing() {
        assertEquals(corpus.long("count"), cases.size.toLong())
        assertTrue("expected a substantial corpus, found ${cases.size}", cases.size >= 40)
        val seen = cases.map { it.str("expected") }.toSet()
        assertEquals(
            setOf("conditionally-eligible", "insufficient-evidence", "not-eligible"),
            seen,
        )
    }

    @Test
    fun kotlinReproducesTheCanonicalClassificationForEveryCase() {
        for (c in cases) {
            val name = c.str("name")
            val expected = Assessment.fromWire(c.str("expected")) ?: error("bad expected in $name")
            val got = assessDeployment(facts(c.obj("facts"))).assessment
            assertEquals("case \"$name\"", expected, got)
        }
    }

    @Test
    fun noAndroidTupleIsEverConditionallyEligible() {
        // The honest Android mandate, pinned at the evaluator: every fact tuple
        // this repo labels "android-*" has assurance unavailable, a non-platform
        // rollback authority, and therefore can never reach the strongest verdict.
        val android = cases.filter { it.str("name").startsWith("android") }
        assertTrue("expected the android scenario cases", android.size >= 3)
        for (c in android) {
            val f = facts(c.obj("facts"))
            assertEquals("android case ${c.str("name")}", AssuranceAuthority.UNAVAILABLE, f.assuranceAuthority)
            assertNotEquals(
                "android case ${c.str("name")} must not claim a platform-monotonic authority",
                "platform-monotonic",
                f.rollback.kind,
            )
            assertNotEquals(
                "android case ${c.str("name")}",
                Assessment.CONDITIONALLY_ELIGIBLE,
                assessDeployment(f).assessment,
            )
        }
    }

    @Test
    fun theTwoAndroidSourceOutcomesAreExactlyAsMandated() {
        // Software CSPRNG -> NOT ELIGIBLE; external-source native -> INSUFFICIENT.
        val byName = cases.associateBy { it.str("name") }
        assertEquals(
            Assessment.NOT_ELIGIBLE,
            assessDeployment(facts(byName.getValue("android-software-source").obj("facts"))).assessment,
        )
        assertEquals(
            Assessment.INSUFFICIENT_EVIDENCE,
            assessDeployment(facts(byName.getValue("android-generated-here-external").obj("facts"))).assessment,
        )
    }
}
