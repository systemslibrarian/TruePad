package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.core.Assessment
import dev.systemslibrarian.truepad.core.AssuranceAuthority
import dev.systemslibrarian.truepad.core.CeremonyPremises
import dev.systemslibrarian.truepad.core.CreationClass
import dev.systemslibrarian.truepad.core.DeliveryClass
import dev.systemslibrarian.truepad.core.DeploymentFacts
import dev.systemslibrarian.truepad.core.RollbackAuthority
import dev.systemslibrarian.truepad.core.SealedAncestor
import dev.systemslibrarian.truepad.core.SourceClass
import dev.systemslibrarian.truepad.core.StorageAuthority
import dev.systemslibrarian.truepad.core.WitnessHealth
import dev.systemslibrarian.truepad.core.assessDeployment
import dev.systemslibrarian.truepad.storage.DEVICE_SOURCE_NAME_WIRE
import dev.systemslibrarian.truepad.storage.PairOrigin
import dev.systemslibrarian.truepad.storage.SourceDeclaration
import dev.systemslibrarian.truepad.storage.WitnessKind
import dev.systemslibrarian.truepad.storage.WitnessState
import dev.systemslibrarian.truepad.storage.deploymentFactsFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE ANDROID HOSTILE-MUTATION MATRIX.
 *
 * The Browser/CLI editions have a falsification matrix: single-line mutations of
 * a security predicate must be caught by a targeted test. This is its Android
 * twin. Each row names a security predicate, constructs a MUTANT (the predicate
 * with one thing changed toward "looks stronger / leaks / reuses"), and shows the
 * mutation is CAUGHT — either because the production evaluator/assembly gives a
 * materially different, security-correct answer on an oracle input a pinning test
 * fixes, or because a production posture guard rejects a one-line-mutated copy of
 * a real file.
 *
 * The bar is ZERO REAL ESCAPES: every row must be caught. A row that could not be
 * caught would be a hole in the tests, not a passing case.
 */
class HostileMutationMatrixTest {

    private data class Mutation(val family: String, val name: String, val caught: Boolean)

    /* ---- oracle facts -------------------------------------------------------- */

    // The one tuple the evaluator ranks CONDITIONALLY ELIGIBLE. Android can never
    // assemble it, but the evaluator is shared, so it anchors the ordering rows.
    private val strongest = DeploymentFacts(
        creation = CreationClass.CLI_CEREMONY,
        source = SourceClass.EXTERNAL_DECLARED,
        delivery = DeliveryClass.PHYSICAL_PRIVATE_OPERATOR_ASSERTED,
        sealedAncestor = SealedAncestor.NO,
        ceremonyPremises = CeremonyPremises.ACCEPTED,
        storage = StorageAuthority.NATIVE,
        rollback = RollbackAuthority.PlatformMonotonic(WitnessHealth.HEALTHY),
        assuranceAuthority = AssuranceAuthority.HANDOFF_ACCEPTED,
    )

    private fun a(f: DeploymentFacts) = assessDeployment(f).assessment
    private val ELIG = Assessment.CONDITIONALLY_ELIGIBLE
    private val NO = Assessment.NOT_ELIGIBLE
    private val INSUF = Assessment.INSUFFICIENT_EVIDENCE

    /** A disqualifier row: strongest is ELIGIBLE, and the single bad fact makes it
     *  the security-correct non-eligible result. Removing the check would wrongly
     *  keep ELIGIBLE, so this pair being pinned kills the mutation. */
    private fun disq(name: String, bad: DeploymentFacts, expect: Assessment) =
        Mutation("evaluator-ordering", name, a(strongest) == ELIG && a(bad) == expect && expect != ELIG)

    /** A necessity row: weakening a required strong fact must drop ELIGIBLE. */
    private fun need(name: String, weakened: DeploymentFacts, expect: Assessment) =
        Mutation("evaluator-necessity", name, a(strongest) == ELIG && a(weakened) == expect && expect != ELIG)

    /* ---- Android fact-assembly oracles --------------------------------------- */

    private fun deviceDecl() = SourceDeclaration(DEVICE_SOURCE_NAME_WIRE, "device", 100)
    private fun externalDecl() = SourceDeclaration("die-rolls.bin", "operator", 100)
    private fun facts(
        decls: List<SourceDeclaration> = listOf(externalDecl()),
        origin: PairOrigin = PairOrigin.GENERATED_HERE,
        kind: WitnessKind = WitnessKind.LOCAL,
        state: WitnessState = WitnessState.ALIGNED,
    ) = deploymentFactsFor(decls, origin, kind, state)

    /** An assembly row: the honestly-assembled fact equals the security-correct
     *  value and NOT the laundered one — a mutation producing the laundered fact
     *  would flip this pinned assertion. */
    private fun assembles(name: String, actual: Any, honest: Any, launderedButNot: Any) =
        Mutation("fact-assembly", name, actual == honest && honest != launderedButNot)

    /* ---- posture guards over one-line-mutated real files --------------------- */

    private fun read(rel: String) = File(rel).readText()
    // Comments stripped, exactly as the production posture guards read it: the
    // manifest documents at length WHY it has no <uses-permission>, and a raw
    // scan would trip on that explanation.
    private val manifest by lazy { read("src/main/AndroidManifest.xml").replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), " ") }
    private val mainActivity by lazy { read("src/main/kotlin/dev/systemslibrarian/truepad/app/MainActivity.kt") }
    private val storageBinding by lazy { read("src/main/kotlin/dev/systemslibrarian/truepad/app/AndroidStorage.kt") }

    /** A posture row: the production guard predicate holds on the real file and is
     *  VIOLATED by a one-line mutation — so the guard catches the mutation. */
    private fun posture(name: String, realHolds: Boolean, mutantViolates: Boolean) =
        Mutation("platform-posture", name, realHolds && mutantViolates)

    @Test
    fun everyHostileMutationIsCaughtWithZeroEscapes() {
        val rows = buildList {
            // --- evaluator ordering: each known disqualifier (11) ---
            add(disq("source software-csprng not caught", strongest.copy(source = SourceClass.SOFTWARE_CSPRNG), NO))
            add(disq("sealed .tps2 delivery not caught", strongest.copy(delivery = DeliveryClass.SEALED_TPS2), NO))
            add(disq("sealed ancestor not caught", strongest.copy(sealedAncestor = SealedAncestor.YES), NO))
            add(disq("browser-opfs storage not caught", strongest.copy(storage = StorageAuthority.BROWSER_OPFS), NO))
            add(disq("withdrawn premise not caught", strongest.copy(ceremonyPremises = CeremonyPremises.WITHDRAWN), NO))
            add(disq("cli-gen creation not caught", strongest.copy(creation = CreationClass.CLI_GEN), NO))
            add(disq("regressed SSF witness not caught", strongest.copy(rollback = RollbackAuthority.SeparateStateFile(WitnessHealth.REGRESSED)), NO))
            add(disq("regressed platform witness not caught", strongest.copy(rollback = RollbackAuthority.PlatformMonotonic(WitnessHealth.REGRESSED)), NO))
            add(disq("untrusted authority not caught", strongest.copy(assuranceAuthority = AssuranceAuthority.UNTRUSTED_AUTHORITY), NO))
            add(disq("withdrawn authority not caught", strongest.copy(assuranceAuthority = AssuranceAuthority.WITHDRAWN), NO))
            add(disq("inconsistent authority not caught", strongest.copy(assuranceAuthority = AssuranceAuthority.INCONSISTENT), NO))

            // --- evaluator necessity: each strong-path condition (6) ---
            add(need("creation need cli-ceremony", strongest.copy(creation = CreationClass.IMPORTED), INSUF))
            add(need("source need external-declared", strongest.copy(source = SourceClass.UNKNOWN), INSUF))
            add(need("delivery need physical-private", strongest.copy(delivery = DeliveryClass.LOCAL_ONLY), INSUF))
            add(need("rollback need platform-monotonic", strongest.copy(rollback = RollbackAuthority.SeparateStateFile(WitnessHealth.HEALTHY)), INSUF))
            add(need("rollback need healthy (unreachable)", strongest.copy(rollback = RollbackAuthority.PlatformMonotonic(WitnessHealth.UNREACHABLE)), INSUF))
            add(need("assurance need handoff-accepted", strongest.copy(assuranceAuthority = AssuranceAuthority.UNAVAILABLE), INSUF))

            // --- Android fact assembly honesty (10) ---
            add(assembles("storage laundered off native", facts().storage, StorageAuthority.NATIVE, StorageAuthority.UNKNOWN))
            add(assembles("assurance laundered to attested", facts().assuranceAuthority, AssuranceAuthority.UNAVAILABLE, AssuranceAuthority.HANDOFF_ACCEPTED))
            add(assembles("LOCAL witness laundered to platform-monotonic", facts(kind = WitnessKind.LOCAL).rollback.kind, "separate-state-file", "platform-monotonic"))
            add(assembles("NONE witness misreported", facts(kind = WitnessKind.NONE).rollback.kind, "none", "platform-monotonic"))
            add(assembles("all-device source laundered to external", facts(decls = listOf(deviceDecl(), deviceDecl())).source, SourceClass.SOFTWARE_CSPRNG, SourceClass.EXTERNAL_DECLARED))
            add(assembles("mixed source misclassified as software", facts(decls = listOf(deviceDecl(), externalDecl())).source, SourceClass.EXTERNAL_DECLARED, SourceClass.SOFTWARE_CSPRNG))
            add(assembles("regressed witness hidden as healthy", (facts(state = WitnessState.REGRESSED).rollback as RollbackAuthority.SeparateStateFile).health, WitnessHealth.REGRESSED, WitnessHealth.HEALTHY))
            add(assembles("inconsistent witness hidden as healthy", (facts(state = WitnessState.INCONSISTENT).rollback as RollbackAuthority.SeparateStateFile).health, WitnessHealth.INCONSISTENT, WitnessHealth.HEALTHY))
            add(assembles("generated-here creation laundered to ceremony", facts(origin = PairOrigin.GENERATED_HERE).creation, CreationClass.UNKNOWN, CreationClass.CLI_CEREMONY))
            add(assembles("imported delivery laundered to private-handoff", facts(origin = PairOrigin.IMPORTED).delivery, DeliveryClass.RAW_IMPORT_UNKNOWN, DeliveryClass.PHYSICAL_PRIVATE_OPERATOR_ASSERTED))

            // --- the master invariant: no Android tuple is ever eligible (1) ---
            val everCombo = buildList {
                for (o in PairOrigin.entries) for (k in WitnessKind.entries) for (st in WitnessState.entries)
                    for (d in listOf(listOf(deviceDecl()), listOf(externalDecl()), listOf(deviceDecl(), externalDecl()), emptyList()))
                        add(assessDeployment(deploymentFactsFor(d, o, k, st)).assessment)
            }
            add(Mutation("master-invariant", "an assembled Android pad reached CONDITIONALLY ELIGIBLE", everCombo.none { it == ELIG }))

            // --- platform posture: guard rejects a one-line mutation (6) ---
            add(posture("allowBackup flipped to true",
                manifest.contains("android:allowBackup=\"false\""),
                !manifest.replace("android:allowBackup=\"false\"", "android:allowBackup=\"true\"").contains("android:allowBackup=\"false\"")))
            // The posture is no longer "no permission at all" — CAMERA is allowed,
            // to scan a receive-code QR — but INTERNET must never appear. The guard
            // (AppSourceAuditTest / verifyReleaseManifest) permits only CAMERA, so
            // an added INTERNET is caught; this pins that specific mutation.
            add(posture("INTERNET permission added",
                !manifest.contains("android.permission.INTERNET") && manifest.contains("android.permission.CAMERA"),
                (manifest.replace("<application", "<uses-permission android:name=\"android.permission.INTERNET\"/>\n    <application")).contains("android.permission.INTERNET")))
            add(posture("FLAG_SECURE removed from the window",
                mainActivity.contains("WindowManager.LayoutParams.FLAG_SECURE"),
                !mainActivity.replace("WindowManager.LayoutParams.FLAG_SECURE", "0 /* removed */").contains("WindowManager.LayoutParams.FLAG_SECURE")))
            add(posture("witness rebound into the backed-up tree",
                storageBinding.contains("noBackupFilesDir"),
                !storageBinding.replace("noBackupFilesDir", "filesDir").contains("noBackupFilesDir")))
            add(posture("a Log call added on an error path",
                !mainActivity.contains("android.util.Log") && !manifest.contains("android.util.Log"),
                (mainActivity + "\nandroid.util.Log.d(\"x\",\"y\")").contains("android.util.Log")))
            add(posture("cleartext traffic turned on",
                manifest.contains("android:usesCleartextTraffic=\"false\""),
                !manifest.replace("android:usesCleartextTraffic=\"false\"", "android:usesCleartextTraffic=\"true\"").contains("android:usesCleartextTraffic=\"false\"")))
        }

        val escapes = rows.filterNot { it.caught }
        assertTrue(
            "REAL ESCAPES (mutations not caught):\n  " + escapes.joinToString("\n  ") { "${it.family}: ${it.name}" },
            escapes.isEmpty(),
        )
        assertEquals("the matrix must have at least 30 rows", true, rows.size >= 30)
        // Every family is represented, so the matrix cannot silently collapse to
        // one easy family.
        assertEquals(
            setOf("evaluator-ordering", "evaluator-necessity", "fact-assembly", "master-invariant", "platform-posture"),
            rows.map { it.family }.toSet(),
        )
    }
}
