package dev.systemslibrarian.truepad.core

/* ============================================================================
 * Deployment assurance — the single derived evaluator, never a stored verdict
 * ----------------------------------------------------------------------------
 * A BYTE-EXACT DECISION TWIN of src/claims/shannon-deployment.ts's
 * `assessDeployment`. TruePad's message cipher is a literal one-time-pad XOR,
 * authenticated by one-time Wegman-Carter; those are facts about the COMBINER.
 * Whether a PARTICULAR DEPLOYMENT can still support Shannon's information-
 * theoretic confidentiality is a different question, and it is the one this
 * module answers, conservatively, from FACTS the client has actually recorded.
 *
 * This is the ONE authority for the Android client, exactly as the TypeScript
 * file is for the CLI and Browser editions. Android ASSEMBLES the same
 * `DeploymentFacts` from its own store/platform (see the app's DeploymentView)
 * and calls `assessDeployment`. It invents no eligibility rule of its own, and
 * it can NEVER reach CONDITIONALLY ELIGIBLE: an Android device has no platform-
 * monotonic (TPM) authority and no pinned root of trust, so `assuranceAuthority`
 * is always `unavailable` and `rollback` is never `platform-monotonic`. The
 * strongest an Android pad reaches is INSUFFICIENT EVIDENCE.
 *
 * The ordering below is LOAD-BEARING and identical to the TypeScript source. It
 * is proven equal to the canonical evaluator by DeploymentCorpusTest against the
 * committed test-vectors/deployment-evaluator-v3.json.
 *
 * No `gold`/`perfectSecrecy`/`shannonSecure`/`maximumSecurity`/`trueRandom`/
 * `verifiedRandom` flag is ever persisted, and no value derived from pad bytes is
 * persisted anywhere. This module only DERIVES; it stores nothing.
 * ========================================================================= */

/** How the pad was created. Frozen at creation, never raised afterward. */
enum class CreationClass(val wire: String) {
    BROWSER_GENERATED("browser-generated"),
    CLI_GEN("cli-gen"),
    CLI_CEREMONY("cli-ceremony"),
    IMPORTED("imported"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): CreationClass? = entries.firstOrNull { it.wire == s }
    }
}

/** How the pad MATERIAL was sourced — premise B/C. */
enum class SourceClass(val wire: String) {
    SOFTWARE_CSPRNG("software-csprng"),
    EXTERNAL_DECLARED("external-declared"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): SourceClass? = entries.firstOrNull { it.wire == s }
    }
}

/** How the pad was DELIVERED to its intended holder — premise E. */
enum class DeliveryClass(val wire: String) {
    LOCAL_ONLY("local-only"),
    PHYSICAL_PRIVATE_OPERATOR_ASSERTED("physical-private-operator-asserted"),
    SEALED_TPS2("sealed-tps2"),
    RAW_IMPORT_UNKNOWN("raw-import-unknown"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): DeliveryClass? = entries.firstOrNull { it.wire == s }
    }
}

/** The ceremony's operator-premise state. It may be WITHDRAWN (a downgrade),
 *  never re-accepted to cross a boundary. */
enum class CeremonyPremises(val wire: String) {
    ACCEPTED("accepted"),
    ABSENT("absent"),
    WITHDRAWN("withdrawn"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): CeremonyPremises? = entries.firstOrNull { it.wire == s }
    }
}

/** Where the LIVE pad state is authoritatively held. */
enum class StorageAuthority(val wire: String) {
    NATIVE("native"),
    BROWSER_OPFS("browser-opfs"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): StorageAuthority? = entries.firstOrNull { it.wire == s }
    }
}

/** The LIVE health of a configured rollback authority, obtained at evaluation
 *  time under the pair lock — never merely the configured class. */
enum class WitnessHealth(val wire: String) {
    HEALTHY("healthy"),
    UNREACHABLE("unreachable"),
    REGRESSED("regressed"),
    INCONSISTENT("inconsistent"),
    UNSUPPORTED("unsupported");

    companion object {
        fun fromWire(s: String): WitnessHealth? = entries.firstOrNull { it.wire == s }
    }
}

/** The rollback/reuse authority, as a LIVE fact. A witness is about state
 *  discipline, never entropy or delivery. Ordinary browser storage
 *  (`browser-local`) is one rollback domain, not an independent authority. Only a
 *  live, healthy `platform-monotonic` authority satisfies the maximum-assurance
 *  rollback requirement — and an Android device never provides one. */
sealed class RollbackAuthority(val kind: String) {
    data object None : RollbackAuthority("none")
    data object Unknown : RollbackAuthority("unknown")
    data object BrowserLocal : RollbackAuthority("browser-local")
    data class SeparateStateFile(val health: WitnessHealth) : RollbackAuthority("separate-state-file")
    data class PlatformMonotonic(val health: WitnessHealth) : RollbackAuthority("platform-monotonic")
}

/** The LIVE ceremony-assurance the independent platform authority attests for
 *  THIS pair — the strong-making fact that pair-directory JSON cannot forge. On
 *  Android this is ALWAYS `unavailable`: there is no TPM-anchored platform state. */
enum class AssuranceAuthority(val wire: String) {
    UNAVAILABLE("unavailable"),
    UNTRUSTED_AUTHORITY("untrusted-authority"),
    ORDINARY("ordinary"),
    CEREMONY_CREATED("ceremony-created"),
    HANDOFF_ACCEPTED("handoff-accepted"),
    WITHDRAWN("withdrawn"),
    INCONSISTENT("inconsistent");

    companion object {
        fun fromWire(s: String): AssuranceAuthority? = entries.firstOrNull { it.wire == s }
    }
}

/** A sealed (.tps2) ancestor anywhere in this copy's lineage — PERMANENT once
 *  YES; UNKNOWN only when a provenance record could not be read. The wire form is
 *  a JSON boolean `true`/`false` OR the string `"unknown"`. */
enum class SealedAncestor(val yes: Boolean) {
    YES(true),
    NO(false),
    UNKNOWN(false)
}

data class DeploymentFacts(
    val creation: CreationClass,
    val source: SourceClass,
    val delivery: DeliveryClass,
    val sealedAncestor: SealedAncestor,
    val ceremonyPremises: CeremonyPremises,
    val storage: StorageAuthority,
    val rollback: RollbackAuthority,
    val assuranceAuthority: AssuranceAuthority,
)

enum class Assessment(val wire: String) {
    CONDITIONALLY_ELIGIBLE("conditionally-eligible"),
    NOT_ELIGIBLE("not-eligible"),
    INSUFFICIENT_EVIDENCE("insufficient-evidence");

    companion object {
        fun fromWire(s: String): Assessment? = entries.firstOrNull { it.wire == s }
    }
}

/** A short factual reason for a NOT ELIGIBLE / INSUFFICIENT result; null when
 *  CONDITIONALLY ELIGIBLE (whose qualifier is [CONDITIONAL_CAVEAT]). */
data class DeploymentAssessment(val assessment: Assessment, val knownReason: String?)

private fun notEligible(reason: String) = DeploymentAssessment(Assessment.NOT_ELIGIBLE, reason)
private fun insufficient(reason: String) = DeploymentAssessment(Assessment.INSUFFICIENT_EVIDENCE, reason)

/**
 * Classify a deployment from recorded facts. Pure, total, and deliberately
 * conservative. The ordering is load-bearing and identical to the canonical
 * TypeScript `assessDeployment`:
 *
 *   1. A KNOWN contradictory path is NOT ELIGIBLE and can never be promoted.
 *   2. The ONE strongest path is CONDITIONALLY ELIGIBLE (unreachable on Android).
 *   3. Everything else is INSUFFICIENT EVIDENCE.
 */
fun assessDeployment(f: DeploymentFacts): DeploymentAssessment {
    // 1 — known contradictions (checked first; any one is disqualifying).
    if (f.source == SourceClass.SOFTWARE_CSPRNG) {
        return notEligible("the source material was generated by a software CSPRNG")
    }
    if (f.delivery == DeliveryClass.SEALED_TPS2 || f.sealedAncestor == SealedAncestor.YES) {
        return notEligible("the pad was delivered by sealed .tps2 — computational delivery, end to end")
    }
    if (f.storage == StorageAuthority.BROWSER_OPFS) {
        return notEligible(
            "the live pad state is held in ordinary browser storage, which is one rollback domain with no " +
                "independent witness",
        )
    }
    if (f.ceremonyPremises == CeremonyPremises.WITHDRAWN) {
        return notEligible("an operator withdrew a required ceremony premise, and that downgrade is permanent")
    }
    if (f.creation == CreationClass.CLI_GEN) {
        return notEligible("the pad was generated by plain gen, not the physical ceremony")
    }
    // A CONFIGURED rollback authority showing a POSITIVE rollback/corruption signal
    // is disqualifying, not merely unproven.
    val rb = f.rollback
    if (rb is RollbackAuthority.SeparateStateFile) {
        if (rb.health == WitnessHealth.REGRESSED) {
            return notEligible("the rollback witness shows this store is behind it — the restored/rolled-back-store signature")
        }
        if (rb.health == WitnessHealth.INCONSISTENT) {
            return notEligible("the rollback witness is in an inconsistent state (corruption, or a foreign authority)")
        }
    }
    if (rb is RollbackAuthority.PlatformMonotonic) {
        if (rb.health == WitnessHealth.REGRESSED) {
            return notEligible("the rollback witness shows this store is behind it — the restored/rolled-back-store signature")
        }
        if (rb.health == WitnessHealth.INCONSISTENT) {
            return notEligible("the rollback witness is in an inconsistent state (corruption, or a foreign authority)")
        }
    }
    // The independent platform ceremony-assurance authority. A terminal withdrawal
    // is permanent; an inconsistent (stale/substituted) authority fails closed.
    if (f.assuranceAuthority == AssuranceAuthority.UNTRUSTED_AUTHORITY) {
        return notEligible(
            "this pair names a platform authority that is NOT this installation's pinned trusted authority — a pair " +
                "may reference an authority but may not choose the trust root",
        )
    }
    if (f.assuranceAuthority == AssuranceAuthority.WITHDRAWN) {
        return notEligible(
            "the platform authority attests a TERMINAL withdrawal of this pair's ceremony premises — a permanent downgrade",
        )
    }
    if (f.assuranceAuthority == AssuranceAuthority.INCONSISTENT) {
        return notEligible("the platform ceremony-assurance authority is inconsistent (stale, substituted, or corrupt)")
    }

    // 2 — the single strongest path. Every condition must hold; the rollback
    //     component requires a LIVE, healthy platform-monotonic authority, and the
    //     ceremony must be attested by the INDEPENDENT platform authority as
    //     `handoff-accepted`.
    val maximalExceptRollback =
        f.creation == CreationClass.CLI_CEREMONY &&
            f.source == SourceClass.EXTERNAL_DECLARED &&
            f.delivery == DeliveryClass.PHYSICAL_PRIVATE_OPERATOR_ASSERTED &&
            f.sealedAncestor == SealedAncestor.NO &&
            f.ceremonyPremises == CeremonyPremises.ACCEPTED &&
            f.storage == StorageAuthority.NATIVE
    if (
        maximalExceptRollback &&
        rb is RollbackAuthority.PlatformMonotonic &&
        rb.health == WitnessHealth.HEALTHY &&
        f.assuranceAuthority == AssuranceAuthority.HANDOFF_ACCEPTED
    ) {
        return DeploymentAssessment(Assessment.CONDITIONALLY_ELIGIBLE, null)
    }

    // 3 — INSUFFICIENT EVIDENCE. Name exactly what remains when a pad is maximal
    //     in every way EXCEPT the rollback authority.
    if (maximalExceptRollback) {
        if (rb is RollbackAuthority.SeparateStateFile && rb.health == WitnessHealth.HEALTHY) {
            return insufficient(
                "this pad is rollback-protected by a separate state file, but the maximum-assurance profile requires " +
                    "a live, reachable, consistent platform-monotonic (TPM) rollback authority; a separate state file " +
                    "can be restored together with the pair",
            )
        }
        if (rb is RollbackAuthority.PlatformMonotonic && rb.health == WitnessHealth.UNREACHABLE) {
            return insufficient(
                "the platform-monotonic rollback authority is currently unreachable, so the maximum-assurance " +
                    "rollback requirement is not confirmed",
            )
        }
        if (rb is RollbackAuthority.PlatformMonotonic && rb.health == WitnessHealth.UNSUPPORTED) {
            return insufficient(
                "the platform-monotonic rollback authority is unsupported in this build, so the maximum-assurance " +
                    "rollback requirement is not confirmed",
            )
        }
        if (rb is RollbackAuthority.PlatformMonotonic && rb.health == WitnessHealth.HEALTHY) {
            if (f.assuranceAuthority == AssuranceAuthority.UNAVAILABLE) {
                return insufficient(
                    "the platform ceremony-assurance authority does not attest a completed ceremony for this pair " +
                        "(it reads unavailable); a provenance.json that merely claims a ceremony is not sufficient",
                )
            }
            return insufficient(
                "the platform authority has not attested an accepted private handoff for this pair (ceremony " +
                    "assurance: ${f.assuranceAuthority.wire}); a provenance.json that merely claims one is not sufficient",
            )
        }
        return insufficient(
            "this pad has no independent live platform-monotonic rollback authority, which the maximum-assurance " +
                "profile requires",
        )
    }
    return insufficient(
        "the maximum-assurance premises are not all recorded — the physical-ceremony creation, the private-handoff " +
            "acceptance, or the source/delivery provenance is unknown or not yet established",
    )
}

/* ---- display vocabulary --------------------------------------------------- */

val ASSESSMENT_LABEL: Map<Assessment, String> = mapOf(
    Assessment.CONDITIONALLY_ELIGIBLE to "CONDITIONALLY ELIGIBLE",
    Assessment.NOT_ELIGIBLE to "NOT ELIGIBLE",
    Assessment.INSUFFICIENT_EVIDENCE to "INSUFFICIENT EVIDENCE",
)

val SOURCE_LABEL: Map<SourceClass, String> = mapOf(
    SourceClass.EXTERNAL_DECLARED to "external, operator-declared",
    SourceClass.SOFTWARE_CSPRNG to "software random generator",
    SourceClass.UNKNOWN to "unknown",
)

/** A human line for the LIVE rollback authority — its class and, for a configured
 *  witness, its current health. */
fun rollbackAuthorityLabel(r: RollbackAuthority): String = when (r) {
    is RollbackAuthority.None -> "NONE (no independent rollback authority)"
    is RollbackAuthority.Unknown -> "unknown"
    is RollbackAuthority.BrowserLocal -> "browser-local (one rollback domain, not independent)"
    is RollbackAuthority.SeparateStateFile ->
        "separate-state-file (${r.health.wire}) — rollback-protected, but not the maximum-assurance authority"
    is RollbackAuthority.PlatformMonotonic ->
        if (r.health == WitnessHealth.HEALTHY) {
            "platform-monotonic (live, healthy) — maximum-assurance authority"
        } else {
            "platform-monotonic (${r.health.wire}) — not currently satisfying the maximum-assurance requirement"
        }
}

/** The premises TruePad did NOT prove — shown wherever a strong label is
 *  displayed, so a label can never be screenshot alone as "secure". */
val UNPROVEN_PREMISES: List<String> = listOf(
    "at least one source was genuinely uniform and secret",
    "the source was independent of the other sources and of the messages",
    "no extra copies, backups, or cloud-synced snapshots exist",
    "the courier handoff was actually private",
    "no stale external clone can cause reuse",
    "the pad material was physically erased on retirement",
)

const val CONDITIONAL_CAVEAT: String =
    "TruePad has recorded no known disqualifying path. It has not proved physical randomness, source independence, " +
        "the absence of copies, private courier behaviour, the absence of a restore, or physical erasure."
