package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Assessment
import dev.systemslibrarian.truepad.core.AssuranceAuthority
import dev.systemslibrarian.truepad.core.CeremonyPremises
import dev.systemslibrarian.truepad.core.CreationClass
import dev.systemslibrarian.truepad.core.DeliveryClass
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.RollbackAuthority
import dev.systemslibrarian.truepad.core.SealedAncestor
import dev.systemslibrarian.truepad.core.SourceClass
import dev.systemslibrarian.truepad.core.StorageAuthority
import dev.systemslibrarian.truepad.core.WitnessHealth
import dev.systemslibrarian.truepad.core.assessDeployment
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE HONEST ANDROID DEPLOYMENT MANDATE, end to end and axis by axis.
 *
 * The pure evaluator's conformance is proven in core against the shared corpus.
 * This suite proves the STORAGE fact-assembly feeds it honest facts from a real
 * `gen`/`import`/`status` path: a software-CSPRNG pad is NOT ELIGIBLE, an
 * external-source native pad is INSUFFICIENT, and NOTHING an Android pad can do
 * reaches CONDITIONALLY ELIGIBLE — because storage is native, the witness is
 * never platform-monotonic, and the assurance authority is never available.
 */
class DeploymentAssemblyTest {

    private val cap = 512L
    private val records = 8L
    private val need = requiredSourceLength(cap, records).toInt()

    private fun deviceSource() =
        SourceInput(DEVICE_SOURCE_NAME_WIRE, "device CSPRNG, declared", genBytes(need, 5))

    private fun externalSource(name: String = "die-rolls.bin") =
        SourceInput(name, "physical dice, declared by operator", genBytes(need, 11))

    private fun freshEngine(): Pair<Engine, MemoryFs> {
        val store = MemoryFs()
        val noBackup = MemoryFs()
        return fixedEngine(store, witnessFs = noBackup) to store
    }

    /* ---- end to end: real gen -> real status --------------------------------- */

    @Test
    fun aDeviceGeneratedPadIsNotEligibleBecauseTheSourceIsASoftwareCsprng() {
        val (e, _) = freshEngine()
        e.gen("device", listOf(deviceSource()), cap, records, witnessKind = WitnessKind.LOCAL)
        val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
        assertEquals(SourceClass.SOFTWARE_CSPRNG, m.sourceClass)
        assertEquals(Assessment.NOT_ELIGIBLE, m.deployment.assessment)
        assertTrue(m.deployment.knownReason!!.contains("software CSPRNG"))
    }

    @Test
    fun anExternalSourcePadIsInsufficientNeverEligible() {
        val (e, _) = freshEngine()
        e.gen("ceremony", listOf(externalSource()), cap, records, witnessKind = WitnessKind.LOCAL)
        val summary = e.status(FIXED_PAIR_ID)
        assertEquals(PairOrigin.GENERATED_HERE, summary.origin)
        for (d in Direction.entries) {
            val m = summary.meters.getValue(d)
            assertEquals(SourceClass.EXTERNAL_DECLARED, m.sourceClass)
            assertEquals(Assessment.INSUFFICIENT_EVIDENCE, m.deployment.assessment)
        }
    }

    @Test
    fun aMixedDevicePlusExternalPadIsExternalDeclaredNotSoftware() {
        // XOR-combining external material in never DOWNGRADES to software-only;
        // one external source makes the source class external-declared.
        val (e, _) = freshEngine()
        e.gen("mixed", listOf(deviceSource(), externalSource()), cap, records, witnessKind = WitnessKind.LOCAL)
        val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
        assertEquals(SourceClass.EXTERNAL_DECLARED, m.sourceClass)
        assertEquals(Assessment.INSUFFICIENT_EVIDENCE, m.deployment.assessment)
    }

    @Test
    fun theWitnessKindNeverRaisesTheVerdictAboveInsufficient() {
        for (kind in listOf(WitnessKind.NONE, WitnessKind.LOCAL)) {
            val (e, _) = freshEngine()
            e.gen("w", listOf(externalSource()), cap, records, witnessKind = kind)
            val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
            assertEquals(
                "witness $kind must not reach CONDITIONALLY ELIGIBLE",
                Assessment.INSUFFICIENT_EVIDENCE,
                m.deployment.assessment,
            )
        }
    }

    @Test
    fun anImportedPadIsInsufficientAndCarriesTheImportedOrigin() {
        val (alice, _) = freshEngine()
        alice.gen("origin", listOf(externalSource()), cap, records, witnessKind = WitnessKind.LOCAL)
        val container = alice.exportPair(FIXED_PAIR_ID).container

        val bobStore = MemoryFs()
        val bobNoBackup = MemoryFs()
        fixedEngine(bobStore, witnessFs = bobNoBackup).importPair("bob", container)
        val summary = fixedEngine(bobStore, witnessFs = bobNoBackup).status(FIXED_PAIR_ID)
        assertEquals(PairOrigin.IMPORTED, summary.origin)
        val m = summary.meters.getValue(Direction.A_TO_B)
        assertEquals(Assessment.INSUFFICIENT_EVIDENCE, m.deployment.assessment)
    }

    /* ---- axis-by-axis unit tests of the fact assembly ------------------------ */

    @Test
    fun theAssembledFactsAreAlwaysNativeStorageAndUnavailableAuthority() {
        for (origin in PairOrigin.entries) {
            for (kind in WitnessKind.entries) {
                val facts = deploymentFactsFor(listOf(externalDecl()), origin, kind, WitnessState.ALIGNED)
                assertEquals(StorageAuthority.NATIVE, facts.storage)
                assertEquals(AssuranceAuthority.UNAVAILABLE, facts.assuranceAuthority)
                // The rollback authority is NEVER platform-monotonic.
                assertTrue(
                    "rollback must be none or separate-state-file, was ${facts.rollback.kind}",
                    facts.rollback is RollbackAuthority.None || facts.rollback is RollbackAuthority.SeparateStateFile,
                )
            }
        }
    }

    @Test
    fun witnessStateMapsToHealthAndRegressionIsDisqualifying() {
        fun assess(state: WitnessState) =
            assessDeployment(deploymentFactsFor(listOf(externalDecl()), PairOrigin.GENERATED_HERE, WitnessKind.LOCAL, state)).assessment
        // A restored/rolled-back or corrupt witness is a POSITIVE disqualifier.
        assertEquals(Assessment.NOT_ELIGIBLE, assess(WitnessState.REGRESSED))
        assertEquals(Assessment.NOT_ELIGIBLE, assess(WitnessState.INCONSISTENT))
        // Healthy/aligned/ahead and n/a are not disqualifiers; they remain INSUFFICIENT.
        assertEquals(Assessment.INSUFFICIENT_EVIDENCE, assess(WitnessState.ALIGNED))
        assertEquals(Assessment.INSUFFICIENT_EVIDENCE, assess(WitnessState.AHEAD))
        assertEquals(Assessment.INSUFFICIENT_EVIDENCE, assess(WitnessState.NA))
    }

    @Test
    fun theHealthMappingIsExact() {
        fun health(state: WitnessState): WitnessHealth {
            val f = deploymentFactsFor(listOf(externalDecl()), PairOrigin.GENERATED_HERE, WitnessKind.LOCAL, state)
            return (f.rollback as RollbackAuthority.SeparateStateFile).health
        }
        assertEquals(WitnessHealth.HEALTHY, health(WitnessState.ALIGNED))
        assertEquals(WitnessHealth.HEALTHY, health(WitnessState.AHEAD))
        assertEquals(WitnessHealth.REGRESSED, health(WitnessState.REGRESSED))
        assertEquals(WitnessHealth.INCONSISTENT, health(WitnessState.INCONSISTENT))
        assertEquals(WitnessHealth.UNREACHABLE, health(WitnessState.NA))
    }

    @Test
    fun originMapsToCreationDeliverySealedAndPremises() {
        val here = deploymentFactsFor(listOf(externalDecl()), PairOrigin.GENERATED_HERE, WitnessKind.LOCAL, WitnessState.ALIGNED)
        assertEquals(CreationClass.UNKNOWN, here.creation)
        assertEquals(DeliveryClass.LOCAL_ONLY, here.delivery)
        assertEquals(SealedAncestor.NO, here.sealedAncestor)
        assertEquals(CeremonyPremises.ABSENT, here.ceremonyPremises)

        val imported = deploymentFactsFor(listOf(externalDecl()), PairOrigin.IMPORTED, WitnessKind.LOCAL, WitnessState.ALIGNED)
        assertEquals(CreationClass.IMPORTED, imported.creation)
        assertEquals(DeliveryClass.RAW_IMPORT_UNKNOWN, imported.delivery)
        assertEquals(SealedAncestor.UNKNOWN, imported.sealedAncestor)
        assertEquals(CeremonyPremises.UNKNOWN, imported.ceremonyPremises)

        val legacy = deploymentFactsFor(listOf(externalDecl()), PairOrigin.UNKNOWN, WitnessKind.NONE, WitnessState.NA)
        assertEquals(CreationClass.UNKNOWN, legacy.creation)
        assertEquals(DeliveryClass.UNKNOWN, legacy.delivery)
    }

    @Test
    fun sourceClassIsDerivedFromHowThePadWasMade() {
        fun source(decls: List<SourceDeclaration>) =
            deploymentFactsFor(decls, PairOrigin.GENERATED_HERE, WitnessKind.LOCAL, WitnessState.ALIGNED).source
        assertEquals(SourceClass.SOFTWARE_CSPRNG, source(listOf(deviceDecl(), deviceDecl())))
        assertEquals(SourceClass.EXTERNAL_DECLARED, source(listOf(deviceDecl(), externalDecl())))
        assertEquals(SourceClass.EXTERNAL_DECLARED, source(listOf(externalDecl())))
        assertEquals(SourceClass.UNKNOWN, source(emptyList()))
    }

    private fun deviceDecl() = SourceDeclaration(DEVICE_SOURCE_NAME_WIRE, "device", 100)
    private fun externalDecl() = SourceDeclaration("die-rolls.bin", "operator", 100)
}
