package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.AssuranceAuthority
import dev.systemslibrarian.truepad.core.CeremonyPremises
import dev.systemslibrarian.truepad.core.CreationClass
import dev.systemslibrarian.truepad.core.DeliveryClass
import dev.systemslibrarian.truepad.core.DeploymentAssessment
import dev.systemslibrarian.truepad.core.DeploymentFacts
import dev.systemslibrarian.truepad.core.RollbackAuthority
import dev.systemslibrarian.truepad.core.SealedAncestor
import dev.systemslibrarian.truepad.core.SourceClass
import dev.systemslibrarian.truepad.core.StorageAuthority
import dev.systemslibrarian.truepad.core.WitnessHealth
import dev.systemslibrarian.truepad.core.assessDeployment

/*
 * HONEST ANDROID DEPLOYMENT-FACT ASSEMBLY.
 *
 * The pure evaluator (core.assessDeployment) is the ONE authority; this file maps
 * an Android pad's REALITY onto the frozen `DeploymentFacts` axes and calls it.
 * It never invents a classification and it can never manufacture the facts that
 * would raise one:
 *
 *   - storage is `native`  — the store is app-private native files, not OPFS.
 *   - assuranceAuthority is ALWAYS `unavailable` — an Android device has no
 *     TPM-anchored platform authority and no operator-pinned root of trust, so it
 *     cannot ATTEST a ceremony. This is the fact that keeps an Android pad out of
 *     CONDITIONALLY ELIGIBLE forever, and it is derived from the platform, not
 *     hard-coded as a verdict.
 *   - rollback is `separate-state-file` (the android-local-witness, a real but
 *     restorable-with-the-pair journal) or `none`; NEVER `platform-monotonic`.
 *
 * Provenance may DOWNGRADE but is never laundered upward: the strongest an
 * Android pad ever reaches is INSUFFICIENT EVIDENCE. A software-CSPRNG source is
 * a hard NOT ELIGIBLE.
 */

/** The released wire name for the platform-CSPRNG source, recorded in head.json.
 *  It is a FROZEN WIRE VALUE (identical in the Browser Edition), not an app
 *  constant — a pad made by any edition's device generator carries this name, so
 *  matching it here classifies the source honestly across editions. */
const val DEVICE_SOURCE_NAME_WIRE: String = "device-random"

/** Map the live witness comparison to the evaluator's health vocabulary. A
 *  LOCAL witness that reads `n/a` cannot confirm its own health, so it is
 *  `unreachable` (the requirement is not confirmed) — never silently healthy. */
private fun healthOf(state: WitnessState): WitnessHealth = when (state) {
    WitnessState.ALIGNED, WitnessState.AHEAD -> WitnessHealth.HEALTHY
    WitnessState.REGRESSED -> WitnessHealth.REGRESSED
    WitnessState.INCONSISTENT -> WitnessHealth.INCONSISTENT
    WitnessState.NA -> WitnessHealth.UNREACHABLE
}

/**
 * Assemble the honest [DeploymentFacts] for one direction of an Android pad.
 *
 * @param sourceDeclarations this direction's head.sourceDeclarations.
 * @param origin the pair's recorded provenance (pair.json), never inferred.
 * @param witnessKind the live witness kind (pair.json), never the frozen head.
 * @param witnessState the live witness comparison for this direction.
 * @param sealedAncestor true iff this pad arrived by sealed transfer (a durable
 *   consumed.json marker names it) — a PERMANENT, computational-delivery fact that
 *   forces NOT ELIGIBLE and can never be laundered away by re-import/QR/wording.
 */
fun deploymentFactsFor(
    sourceDeclarations: List<SourceDeclaration>,
    origin: PairOrigin,
    witnessKind: WitnessKind,
    witnessState: WitnessState,
    sealedAncestor: Boolean = false,
): DeploymentFacts {
    // Source premise B/C. Derived from HOW the pad was actually made: every source
    // is the platform CSPRNG -> software-csprng (a hard disqualifier); at least one
    // operator-supplied external source -> external-declared (unverified, but not
    // software-only); no declarations at all (a bare copied-in store) -> unknown.
    val source = when {
        sourceDeclarations.isEmpty() -> SourceClass.UNKNOWN
        sourceDeclarations.all { it.name == DEVICE_SOURCE_NAME_WIRE } -> SourceClass.SOFTWARE_CSPRNG
        else -> SourceClass.EXTERNAL_DECLARED
    }

    // Creation / delivery / sealed-ancestor / ceremony premises, from provenance.
    // Android NEVER claims cli-gen, cli-ceremony, or browser-generated: it is a
    // native client with no physical-ceremony authority, so a generated-here pad's
    // creation class is simply `unknown` to this evaluator (the source axis carries
    // the real disqualification). It never asserts a sealed ancestor (Android has
    // no sealed .tps2 delivery) and never claims a private-handoff ceremony premise.
    val creation: CreationClass
    val delivery: DeliveryClass
    val originSealed: SealedAncestor
    val premises: CeremonyPremises
    when (origin) {
        PairOrigin.GENERATED_HERE -> {
            creation = CreationClass.UNKNOWN
            delivery = DeliveryClass.LOCAL_ONLY
            originSealed = SealedAncestor.NO
            premises = CeremonyPremises.ABSENT
        }
        PairOrigin.IMPORTED -> {
            creation = CreationClass.IMPORTED
            delivery = DeliveryClass.RAW_IMPORT_UNKNOWN
            originSealed = SealedAncestor.UNKNOWN
            premises = CeremonyPremises.UNKNOWN
        }
        PairOrigin.UNKNOWN -> {
            creation = CreationClass.UNKNOWN
            delivery = DeliveryClass.UNKNOWN
            originSealed = SealedAncestor.UNKNOWN
            premises = CeremonyPremises.UNKNOWN
        }
    }
    // A durable sealed-delivery marker is a HARD, permanent fact: a pad received by
    // .tps2 is computationally delivered and NOT ELIGIBLE, and that can never be
    // laundered upward. When present it forces sealedAncestor YES and the delivery
    // class to sealed-tps2, both of which the evaluator treats as disqualifying.
    val sealed = if (sealedAncestor) SealedAncestor.YES else originSealed
    val effectiveDelivery = if (sealedAncestor) DeliveryClass.SEALED_TPS2 else delivery

    // Rollback authority — the LIVE fact. The android-local-witness is a genuine
    // separate-state-file (its journal lives outside the backed-up tree), but it
    // is restorable together with a full device restore, so it is exactly the
    // `separate-state-file` class the evaluator treats as real-but-insufficient.
    // NONE means no witness at all. Neither is ever `platform-monotonic`.
    val rollback: RollbackAuthority = when (witnessKind) {
        WitnessKind.NONE -> RollbackAuthority.None
        WitnessKind.LOCAL -> RollbackAuthority.SeparateStateFile(healthOf(witnessState))
    }

    return DeploymentFacts(
        creation = creation,
        source = source,
        delivery = effectiveDelivery,
        sealedAncestor = sealed,
        ceremonyPremises = premises,
        storage = StorageAuthority.NATIVE,
        rollback = rollback,
        assuranceAuthority = AssuranceAuthority.UNAVAILABLE,
    )
}

// A one-step `assessAndroidDeployment` convenience once lived here and was
// deliberately REMOVED: it called deploymentFactsFor(...) WITHOUT the
// `sealedAncestor` argument (defaulting it to false), so wiring it to a live path
// would silently drop the sealed-transfer disqualifier and report a dishonest
// verdict. The one production path — Engine.directionMeters — calls
// deploymentFactsFor(...) and assessDeployment(...) directly and threads the real
// sealedAncestor fact, so no convenience that can omit it should exist.
