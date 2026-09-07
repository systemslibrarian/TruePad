package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THERE IS ONE ROLE AUTHORITY, AND IT IS THE PAD'S ORIGIN.
 *
 * Generated here means A. Imported means B. Anything else REFUSES. The rule is
 * not new; what kept breaking is the number of places allowed to answer it.
 *
 * The reuse this exists to prevent is ACROSS two copies, so no single store can
 * see it. iOS carried two independent defaults — `SendModel.role = .a` and
 * `OpenModel.role = .b` — so an importing device opened correctly at ITS default,
 * which masked the problem, and then sent on party A's half. Both devices burned
 * `A->B`, at the same offsets, against the same one-time authentication record.
 * Every counter advanced monotonically and every witness agreed.
 *
 * THE PICKER WAS THE SAME DEFECT WEARING A DIFFERENT NAME. Narrowing it to "only
 * when the pad cannot say" kept the worse half: that is precisely the case where
 * a pick is a guess, and precisely the case where a guess spends the other
 * person's material. It also sat one line under this project's own prompt saying
 * "there is nothing for you to set by hand — a role you picked would be a guess
 * wearing a different name", so the screen contradicted itself in the operator's
 * reading order. The Browser edition declined to add one and wrote down why
 * (src/browser/ui/role.ts): "adding a picker would create a second role authority
 * beside the origin — which is the architecture the cross-copy reuse fix exists
 * to prevent."
 *
 * `PadViewModel` is an `AndroidViewModel` and cannot be constructed on the JVM,
 * so this reads the sources. Every assertion carries a positive control, and the
 * absence assertions are the point: they fail when a control comes back.
 */
class RoleAuthorityTest {

    private fun read(rel: String): String = File(rel).readText()

    /** A file with `//` comments removed — a comment DESCRIBING a removed control
     *  is not that control, and a guard like this was fooled by one before. */
    private fun code(text: String): String =
        // BLOCK COMMENTS TOO. Stripping only `//` left every `/** ... */` KDoc in
        // scope, and these files explain the removed control at length — so a
        // sentence DESCRIBING the picker satisfied an assertion looking for the
        // picker. The sibling audit test in this package already strips both.
        text.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
            .lineSequence().map { it.substringBefore("//") }.joinToString("\n")

    private val viewModel = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/PadViewModel.kt"))
    private val screens = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt"))
    private val iosMessages =
        code(read("../../ios/TruePadKit/Sources/TruePadUI/MessageViews.swift"))

    @Test
    fun `this test read the files it thinks it read`() {
        // POSITIVE CONTROL. Every absence assertion below passes trivially against
        // an empty string, which is how a guard stops guarding without saying so.
        assertTrue("PadViewModel not found or implausibly short", viewModel.length > 5000)
        assertTrue("Screens not found or implausibly short", screens.length > 5000)
        assertTrue("iOS MessageViews not found or implausibly short", iosMessages.length > 3000)
        assertTrue(viewModel.contains("val derivedRole = current?.let { PartyRole.derive(it.origin) }"))
        assertTrue(screens.contains("PartyRole.UNKNOWN_ORIGIN_PROMPT"))
        assertTrue(iosMessages.contains("PartyRole.unknownOriginPrompt"))
    }

    @Test
    fun `the role is derived and has no second source`() {
        assertTrue(
            "the role must be exactly the derived value, with no fallback beside it",
            viewModel.contains("role = derivedRole,"),
        )
        assertFalse(
            "refresh() has a fallback beside the derived role again",
            viewModel.contains("role = derivedRole ?:"),
        )
        assertTrue(
            "roleWasDerived must still report whether the PAD supplied it",
            viewModel.contains("roleWasDerived = derivedRole != null"),
        )
        assertFalse("a setter for the role is back on the view model", viewModel.contains("fun setRole("))
    }

    @Test
    fun `no Android control chooses a half`() {
        for (bad in listOf("vm.setRole(", "testTag(\"role-a\")", "testTag(\"role-b\")")) {
            assertFalse("the Android interface offers a role control again: $bad",
                        screens.contains(bad))
        }
        // The PROMPT stays. Refusing without saying why is its own defect.
        assertTrue("the unknown-origin prompt is no longer shown at all",
                   screens.contains("Faint(PartyRole.UNKNOWN_ORIGIN_PROMPT)"))
    }

    @Test
    fun `no iOS control chooses a half`() {
        for (bad in listOf("Picker(\"Send as\"", "Picker(\"Open as\"", "$" + "model.role")) {
            assertFalse("the iOS interface offers a role control again: $bad",
                        iosMessages.contains(bad))
        }
        assertTrue("the unknown-origin prompt is no longer shown at all",
                   iosMessages.contains("FaintText(PartyRole.unknownOriginPrompt)"))
    }

    @Test
    fun `nothing in the role assignment defaults to a half`() {
        val assignment = viewModel.substringAfter("role = derivedRole").substringBefore("banner =")
        for (bad in listOf("Party2.A", "Party2.B")) {
            assertFalse("the role assignment defaults to $bad", assignment.contains(bad))
        }
    }

    @Test
    fun `an unknown role yields no direction rather than the wrong one`() {
        // `if (role == Party2.A) A_TO_B else B_TO_A` treats "not A" and "we do not
        // know" as the same answer, and the pad screen printed that half's budget
        // as a confident figure. Both getters are nullable now, and the screen
        // renders the refusal instead.
        assertTrue("sendDirection is not nullable", viewModel.contains("val sendDirection: Direction?"))
        assertTrue("receiveDirection is not nullable", viewModel.contains("val receiveDirection: Direction?"))
        assertFalse(
            "a null role resolves to a direction again",
            viewModel.contains("get() = if (role == Party2.A) Direction.A_TO_B else Direction.B_TO_A"),
        )
        assertTrue(
            "the pad screen states a message budget for a half it cannot identify",
            screens.contains("Unknown — TruePad cannot tell which half is yours"),
        )
    }

    @Test
    fun `send and open still fail closed on a role the pad could not supply`() {
        assertTrue(viewModel.contains("reason = \"role-unknown\""))
        // Two of them: one for send, one for open. Losing either would let one
        // verb proceed on a role nothing derived.
        assertTrue("only one verb fails closed on an unknown role",
                   viewModel.split("reason = \"role-unknown\"").size - 1 == 2)
    }
}
