package dev.systemslibrarian.truepad.storage


/**
 * WHICH HALF OF THE PAIR THIS DEVICE OWNS.
 *
 * THE DEFECT THIS CLOSES. The Browser Edition pins the operator's role per pair
 * at acquisition (creator -> A, importer -> B) and the CLI refuses to guess at
 * all: `--as A or --as B is required: it names YOUR role, and picks which half of
 * the pair is used`. Both mobile editions dropped that guard. Android carried a
 * single GLOBAL `UiState.role = Party2.A` — not even per pad — behind a radio on
 * the Security screen introduced with "Implementation detail. You never need this
 * to use TruePad."
 *
 * So two devices holding one pair both burned `A_TO_B`, at the same offsets,
 * against the same one-time authentication record. Each store's counters advanced
 * monotonically on its own copy, each witness agreed, and no engine on either
 * side could see it: the reuse is ACROSS two copies, not within one store. Two
 * plaintexts under the same pad bytes is the failure the product exists to
 * prevent, and it happened on the ordinary no-error path with no adversary.
 *
 * THE RULE. One role per pair, derived from how the pad was acquired — never a
 * free-floating default. `UNKNOWN` returns null: the operator is asked, exactly
 * as the CLI asks. Refusing to proceed is LOSS, which this project accepts;
 * guessing is REUSE, which it does not.
 */
object PartyRole {
    fun derive(origin: PairOrigin): Party2? = when (origin) {
        PairOrigin.GENERATED_HERE -> Party2.A
        PairOrigin.IMPORTED -> Party2.B
        // NOT A. An unreadable or absent origin is exactly the case where a guess
        // is most likely to be wrong, because it is the case where the provenance
        // evidence was lost.
        PairOrigin.UNKNOWN -> null
    }

    const val UNKNOWN_ORIGIN_PROMPT: String =
        "TruePad cannot tell which half of this pair is yours, so it will not " +
            "guess. Choose the role you were given when this pad was created. " +
            "Choosing wrong does not corrupt the pad, but it spends material the " +
            "other person is also spending."
}
