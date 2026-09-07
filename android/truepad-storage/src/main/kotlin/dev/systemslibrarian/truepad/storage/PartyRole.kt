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
 * free-floating default. `UNKNOWN` returns null and the interface REFUSES; it
 * does not delegate. (This once said "the operator is asked, exactly as the CLI
 * asks", and this edition did ask, with radios on the Security screen. The CLI's
 * `--as` is a different thing: stated per invocation by someone driving the
 * engine directly, not a control offered beside a prompt that says a pick would
 * be a guess. A picker in the interface is a SECOND role authority beside the
 * origin — see src/browser/ui/role.ts, which declined to add one for exactly this
 * reason.) Refusing to proceed is LOSS, which this project accepts; guessing is
 * REUSE, which it does not.
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

    /**
     * WHAT TO SAY WHEN THE ROLE CANNOT BE DERIVED.
     *
     * THIS TOLD THE OPERATOR TO USE A CONTROL THAT NO LONGER EXISTS — and, before
     * that, one that should never have existed. It said "Choose the role you were
     * given when this pad was created", which was rendered in four places after
     * the radios came out: the pad screen's callout, the Security screen where the
     * radios used to be, and the detail of both `role-unknown` refusals. An
     * operator was told three times to perform an action the interface does not
     * offer, in a product whose whole argument is that a picked role is a guess.
     *
     * Both sibling editions had the identical sentence and both fixed it, and the
     * Browser wrote down why: "Directions to a button nobody can find are worse
     * than no directions." Word for word the iOS `PartyRole.unknownOriginPrompt`.
     *
     * EVERY ROUTE NAMED HERE IS A REAL, VISIBLE CONTROL, spelled exactly as the
     * operator sees it — "Create a pad" on the Pads screen (ui/Screens.kt) and
     * "Create a receive code" on the Inbox (ui/SptScreens.kt). `RolePromptTest`
     * holds each quoted label against the interface source.
     */
    const val UNKNOWN_ORIGIN_PROMPT: String =
        "TruePad cannot tell which half of this pair is yours, so it will not " +
            "guess, and it will not send or open with this pad until it can. " +
            "TruePad records which half is yours when a pad is created here, or " +
            "when it arrives here through a receive code; a pad that got here some " +
            "other way carries no such record, and there is nothing for you to set " +
            "by hand \u2014 a role you picked would be a guess wearing a different " +
            "name. Acquire the pad again: \u201CCreate a pad\u201D on the Pads " +
            "screen, or \u201CCreate a receive code\u201D on the Inbox tab " +
            "and have the other person send it to you. Guessing does not corrupt " +
            "the pad, but it spends material the other person is spending too, " +
            "which is the one thing TruePad will not do on your behalf."
}
