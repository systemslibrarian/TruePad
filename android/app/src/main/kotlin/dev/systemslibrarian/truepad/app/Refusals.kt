package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.storage.EngineRefused

/*
 * Turning the engine's typed refusals into sentences a person can act on.
 *
 * The engine's own message is precise and correct, and it is what the Details
 * line shows. What it is not is a first sentence for someone who just wanted to
 * send a message — "sequence 4 is beyond the finite lookahead window [0, 64)"
 * is true and unhelpful. This maps each typed reason to a plain sentence and a
 * suggested next step, and NOTHING here changes what happened: the engine has
 * already decided, already refused, and already consumed or not consumed.
 *
 * The reason string is the contract, not the message text, exactly as the CLI
 * and Browser Edition treat it. An unrecognised reason falls through to the
 * engine's own words rather than being swallowed — a refusal nobody mapped is
 * still a refusal the operator must see.
 *
 * Nothing here may add detail the engine withheld. The engine's messages are
 * audited to carry no pad byte, key, mask, tag or plaintext; this layer only
 * ever makes them SHORTER.
 */
data class UserFacingRefusal(
    val reason: String,
    val headline: String,
    val detail: String,
) {
    /** True when nothing was consumed, so the operator can simply try again. */
    val isFree: Boolean get() = reason in FREE_REASONS

    private companion object {
        /**
         * Refusals that happen before anything is consumed. The engine's own
         * word for this is "Nothing was burned." — these are the reasons where
         * a retry costs the operator nothing at all.
         */
        val FREE_REASONS = setOf(
            "frozen", "witness-regressed", "witness-inconsistent", "locked",
            "sequence-retired", "sequence-malformed", "sequence-out-of-window",
            "sequence-contested", "offset-retired", "encryption-exhausted",
            "auth-exhausted", "record-size-mismatch", "wrong-pair", "wrong-direction",
            "malformed-envelope", "envelope-v1", "oversize-ciphertext",
            "pair-destroyed", "import-incomplete", "pair-exists", "malformed-bundle",
            "imported-pair-cannot-export", "source-too-short", "destroy-unconfirmed",
            "no-store", "half-pair", "v1-store",
        )
    }
}

fun EngineRefused.toUserFacing(): UserFacingRefusal {
    val engineDetail = message ?: ""
    // These sentences are the RELEASED Browser Edition's own refusal copy where
    // the release has one, so the two editions say the same thing about the same
    // typed reason. Where Android reaches a reason the browser UI never
    // surfaces, the sentence is written in the same register: what happened,
    // and what the operator can do about it.
    val headline = when (reason) {
        /* ---- the pad is out of material ------------------------------------ */
        "encryption-exhausted" -> "This pad has no material left. Create a new pad to keep messaging."
        "auth-exhausted" -> "This pad is out of space for new messages. Create a new pad to keep sending."

        /* ---- the message does not belong here ------------------------------ */
        "wrong-pair" -> "This message was written for a different pad."
        "wrong-direction" -> "This is a message you sent, not one you received."
        "malformed-envelope" -> "This does not look like an encrypted message from TruePad."
        "envelope-v1" -> "This message came from TruePad 1, which this app cannot open."
        "oversize-ciphertext" -> "This message is too large for TruePad to open in one piece."
        "record-size-mismatch" -> "This message is the wrong size for this pad's fixed message size."

        /* ---- already used, or out of order --------------------------------- */
        "sequence-retired", "offset-retired" ->
            "You've already opened this message, or a later one from the same pad."
        "sequence-out-of-window" ->
            "This message is too far ahead of where this pad is. Open earlier messages first."
        "sequence-malformed" -> "This message refers to a slot that does not exist in this pad."
        "sequence-contested" ->
            "This message can no longer be opened — too many failed attempts used it up."

        /* ---- authentication -------------------------------------------------- */
        "auth-failed" ->
            "This message could not be verified. It was changed, damaged, or is not really from the other person."

        /* ---- pair-level state ------------------------------------------------ */
        "frozen" ->
            "Too many messages failed to verify, so this pad is paused. Resume it from the pad screen."
        "witness-regressed" ->
            "Something looks wrong with this pad's history — it may have been restored from a backup. " +
                "TruePad stopped before using any of it, so no part of the pad can be used twice."
        "witness-inconsistent" ->
            "TruePad cannot confirm how far this pad has been used, so it stopped rather than risk using part " +
                "of it twice."
        "locked" -> "Another action on this pad is still running. Try again in a moment."
        "pair-destroyed" -> "This pad has been disabled and can no longer be used."
        "import-incomplete" -> "Adding this pad did not finish. Add the same pad file again to complete it."
        "pair-exists" -> "You already have this pad. Adding it again would undo what you have already used."
        "imported-pair-cannot-export" ->
            "This pad came from someone else, so TruePad will not save another copy to pass on. " +
                "Create a new pad to share with someone new."
        "handoff-state-unreadable", "pad-already-sealed" ->
            "TruePad cannot tell whether this pad has already been given to someone, so it will not make " +
                "another copy. Create a new pad for any further sharing."

        /* ---- the pad file itself --------------------------------------------- */
        "malformed-bundle" -> "This pad file can't be added. Ask the other person for a new pad."
        "corrupt-head", "corrupt-store", "corrupt-secret-body", "corrupt-journal", "corrupt-pair-meta" ->
            "This pad's files are damaged, so TruePad will not use them."
        "regressed-below-mark" ->
            "This pad's records disagree with its own history, so TruePad will not use it."
        "no-store" -> "There is no pad here."
        "half-pair" -> "This pad is incomplete — only one half of it is present."
        "v1-store" -> "This pad was made by TruePad 1, which this app cannot read."

        /* ---- creating ---------------------------------------------------------- */
        "source-too-short" -> "One of the files you chose is too small to make a pad of this size."
        "destroy-unconfirmed" -> "The confirmation did not match, so nothing was disabled."

        else -> "TruePad refused this action."
    }
    return UserFacingRefusal(reason, headline, engineDetail)
}
