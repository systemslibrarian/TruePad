package dev.systemslibrarian.truepad.app

import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.systemslibrarian.truepad.app.ui.Body
import dev.systemslibrarian.truepad.app.ui.Callout
import dev.systemslibrarian.truepad.app.ui.Faint
import dev.systemslibrarian.truepad.app.ui.Tone
import dev.systemslibrarian.truepad.app.ui.TruePadTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE INTERFACE AT TWICE THE SYSTEM FONT SIZE.
 *
 * The failure this guards against is specific: a warning that gets truncated
 * exactly when the person reading it most needs the whole sentence. Nothing in
 * this app sets maxLines or an ellipsis on text that carries a consequence, and
 * these tests are what keep that true rather than a comment saying so.
 *
 * A bare compose rule rather than the activity one: this renders the components
 * in isolation at an overridden font scale, which is the thing under test, and
 * does not need a pad or a running journey.
 */
@RunWith(AndroidJUnit4::class)
class LargeFontTest {

    @get:Rule
    val compose = createComposeRule()

    private fun renderClaimsAt(scale: Float) {
        compose.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(scale)) {
                TruePadTheme {
                    Callout(tone = Tone.Warn, title = Claims.CEREMONY_TITLE) {
                        Body(Claims.CEREMONY_CANNOT_VERIFY)
                        Faint(Claims.CEREMONY_SECRECY)
                        Faint(Claims.CEREMONY_MESSAGE_INDEPENDENCE)
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun theCeremonyWarningIsCompleteAtDoubleFontScale() {
        renderClaimsAt(2f)
        // The WHOLE sentence, matched exactly. An ellipsised node would not match.
        for (sentence in listOf(
            Claims.CEREMONY_CANNOT_VERIFY,
            Claims.CEREMONY_SECRECY,
            Claims.CEREMONY_MESSAGE_INDEPENDENCE,
        )) {
            compose.onNode(hasText(sentence), useUnmergedTree = true)
                .assertExists("at 2x font scale this must still be the complete sentence: $sentence")
        }
    }

    @Test
    fun theTitleAndItsToneWordSurviveDoubleFontScale() {
        renderClaimsAt(2f)
        // The tone is carried by a WORD as well as a colour, and that word must
        // survive too — it is what a person who cannot distinguish the two reds
        // is relying on.
        compose.onNodeWithText("Important: ${Claims.CEREMONY_TITLE}", useUnmergedTree = true)
            .assertIsDisplayed()
    }

    @Test
    fun theSameTextIsCompleteAtTheDefaultScaleToo() {
        renderClaimsAt(1f)
        compose.onNode(hasText(Claims.CEREMONY_SECRECY), useUnmergedTree = true).assertExists()
    }
}
