package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SHARING A NEW PAD IS THE NEXT STEP, AND IT LOOKS LIKE ONE.
 *
 * A pad nobody else has is a pad that cannot be used. The app knew that — the
 * post-creation banner already said "give the other person their copy" — and then
 * left the operator to find out how, behind a screen that led with "Save as a
 * file". So the ordinary, secure way to give someone a pad was the one an
 * operator met second, if at all.
 *
 * What must be true now: the secure route is the obvious one, it says plainly
 * that the other person creates a receive code and sends it over, and it enters
 * the EXISTING sealed-transfer flow rather than exporting anything.
 */
class SharingUxTest {

    /**
     * Kotlin string concatenations rejoined, so a sentence the compiler builds
     * from two literals is searched as the sentence a person will read. Without
     * this, wrapping a line at the wrong word makes an assertion silently stop
     * matching the very text it is guarding.
     */
    private fun read(path: String): String =
        File(path).readText().replace(Regex("\"\\s*\\+\\s*\""), "")

    private val screens = read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt")
    private val spt = read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/SptScreens.kt")
    private val root = read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/TruePadRoot.kt")

    /** The instruction, in the words a person who knows nothing about TPR2 needs. */
    private val receiveCodeInstruction =
        "ask the other person to open TruePad and create a receive code"

    // MARK: immediately after creation

    @Test
    fun theCreatedBannerOffersSharingAndSaysHowItWorks() {
        val banner = root.substringAfter("is Banner.Created ->").substringBefore("Banner.Added")
        assertTrue("the created banner is gone", banner.isNotBlank())

        assertTrue(
            "creating a pad no longer offers an obvious way to share it",
            banner.contains("PrimaryButton(\"Share this pad\""),
        )
        assertTrue(
            "the banner does not explain that the other person creates a receive code",
            banner.lowercase().contains(receiveCodeInstruction.lowercase()),
        )
        assertTrue(
            "the banner does not say the code comes back to the sender",
            banner.contains("send that code to you"),
        )
        assertTrue(
            "the banner enters something other than the sealed-transfer flow",
            banner.contains("vm.startSendSealed()"),
        )
        assertFalse(
            "the share action exports a raw pad file",
            banner.contains("exportPad") || banner.contains("save.launch"),
        )
        // CREATING A PAD MUST NOT FORCE AN IMMEDIATE HANDOFF.
        assertTrue("there is no way out of the prompt", banner.contains("Not now"))
        assertTrue(banner.contains("vm.dismissBanner()"))
    }

    // MARK: on an existing pad

    @Test
    fun thePadScreenLeadsWithTheSecureRoute() {
        val share = screens.substringAfter("SectionTitle(\"Share this pad\")").substringBefore("Rule()")
        assertTrue("the pad screen has no share section", share.isNotBlank())

        assertTrue(
            "the secure route is not the primary action on the pad screen",
            share.contains("PrimaryButton(\"Send securely to a receive code\""),
        )
        assertTrue(share.contains("vm.startSendSealed()"))
        assertTrue(
            "the pad screen does not explain the receive code",
            share.lowercase().contains(receiveCodeInstruction.lowercase()),
        )
        // The file route survives, demoted.
        assertTrue("the file route was deleted rather than demoted", share.contains("btn-give-pad"))
        assertFalse(
            "the file route is still a primary action beside the secure one",
            share.contains("PrimaryButton(\"Give this pad to someone\""),
        )
    }

    @Test
    fun theGiveScreenLeadsWithTheSecureRoute() {
        val secure = spt.indexOf("SectionTitle(\"Securely, over any channel\")")
        val inPerson = spt.indexOf("SectionTitle(\"In person\")")
        assertTrue("the give screen lost one of its two routes", secure > 0 && inPerson > 0)
        assertTrue(
            "the give screen still leads with saving a raw pad file",
            secure < inPerson,
        )
        assertTrue(
            "the secure route is not the primary action",
            spt.contains("PrimaryButton(\"Send securely to a receive code\""),
        )
        assertTrue(
            "saving a raw pad file is still a primary action",
            spt.contains("SecondaryButton(\"Save as a file\""),
        )
        // The one-handoff warning must survive this reordering.
        assertTrue(spt.contains("A pad is given only once"))
    }

    /** A pad that cannot be handed over must not advertise a fresh handoff. */
    @Test
    fun theOneHandoffRuleIsStillTheEnginesToEnforce() {
        assertTrue(
            "the give screen no longer warns that a pad leaves only once",
            spt.contains("this pad can be handed over a single time"),
        )
    }

    // MARK: the receiving side

    @Test
    fun theReceiveScreenTellsTheRecipientToSendTheCodeToTheSender() {
        assertTrue(
            "the receive screen does not tell the recipient what to do with the code",
            spt.contains("Send this receive code to the person sharing a pad with you"),
        )
        // And it keeps the security qualification that stops it reading as a pad.
        assertTrue(
            "the receive screen no longer says the code is not a pad",
            spt.contains("it is only a request, not a pad"),
        )
        assertTrue(spt.contains("PrimaryButton(\"Copy code\""))
        assertTrue(spt.contains("SecondaryButton(\"Share code\""))
    }
}
