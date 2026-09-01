package dev.systemslibrarian.truepad.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/*
 * The shared pieces. Three accessibility rules are built in here rather than
 * remembered at each call site:
 *
 *   1. NOTHING IS SAID BY COLOUR ALONE. A callout's tone changes its border and
 *      its title colour, and it also always carries a word — "Problem", "Note",
 *      "Done" — so a person who cannot distinguish the two reds still reads
 *      which one it is.
 *   2. WARNINGS AND REFUSALS ARE NEVER CLIPPED. No maxLines, no ellipsis, no
 *      fixed height on any text that carries a consequence. At the largest
 *      system font it grows and the screen scrolls; it does not truncate.
 *   3. TAP TARGETS ARE AT LEAST 48dp. Enforced by heightIn on every button here.
 */

private val MinTouchTarget = 48.dp

@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.displaySmall,
        color = MaterialTheme.colorScheme.onBackground,
        modifier = modifier.semantics { heading() },
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onBackground,
        modifier = modifier.semantics { heading() },
    )
}

@Composable
fun Body(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onBackground, modifier = modifier)
}

@Composable
fun Muted(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** The smallest print in the app, and still never clipped. */
@Composable
fun Faint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

enum class Tone { Neutral, Warn, Danger, Good }

/**
 * A bordered callout. The `word` is what makes the tone readable without
 * colour, and it is announced first by a screen reader.
 */
@Composable
fun Callout(
    tone: Tone,
    title: String,
    modifier: Modifier = Modifier,
    body: @Composable () -> Unit = {},
) {
    val scheme = MaterialTheme.colorScheme
    val (accent, word) = when (tone) {
        Tone.Neutral -> scheme.onSurfaceVariant to "Note"
        Tone.Warn -> scheme.primary to "Important"
        Tone.Danger -> scheme.error to "Problem"
        Tone.Good -> scheme.primary to "Done"
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, accent, RoundedCornerShape(10.dp))
            .background(scheme.surfaceVariant, RoundedCornerShape(10.dp))
            .padding(14.dp)
            // A callout that appears in response to an action is announced.
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = "$word: $title",
            style = MaterialTheme.typography.titleMedium,
            color = accent,
            modifier = Modifier.semantics { heading() },
        )
        body()
    }
}

@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, busy: Boolean = false, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().heightIn(min = MinTouchTarget),
        shape = RoundedCornerShape(10.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onPrimary,
            )
            Spacer(Modifier.size(10.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

@Composable
fun SecondaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = MinTouchTarget),
        shape = RoundedCornerShape(10.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/**
 * The one irreversible action is the quietest thing on the screen — the
 * released dashboard's rule, carried over. It is a text button, not a red slab.
 */
@Composable
fun QuietDangerButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = MinTouchTarget),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun BackLink(text: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = MinTouchTarget)) {
        Text("‹  $text", style = MaterialTheme.typography.labelLarge)
    }
}

/** A row of label and value, read as one unit by a screen reader. */
@Composable
fun KeyValue(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Muted(label, Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.End,
        )
    }
}

/**
 * A collapsible details block. Level 3 material — the exact engine reason, the
 * byte counts — lives behind one of these and never above it.
 */
@Composable
fun Details(summary: String, content: @Composable () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        TextButton(onClick = { open = !open }, modifier = Modifier.heightIn(min = MinTouchTarget)) {
            Text(
                if (open) "▾  $summary" else "▸  $summary",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (open) {
            Column(Modifier.padding(start = 12.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                content()
            }
        }
    }
}

@Composable
fun Rule() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outline, thickness = 1.dp)
}
