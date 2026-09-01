package dev.systemslibrarian.truepad.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * The released product's palette, carried over so the two editions read as one
 * product: #11100C ground, #F3EFE4 ink, from the shipped PWA manifest.
 *
 * Deliberately NOT dynamic colour. TruePad's warnings and refusals rely on
 * contrast being predictable, and a wallpaper-derived palette can put a refusal
 * banner and a success banner within a hair of each other. Nothing in this app
 * conveys meaning by colour ALONE — every state that matters is also words — but
 * the colours should still be the ones that were checked.
 */

private val Ground = Color(0xFF11100C)
private val Ink = Color(0xFFF3EFE4)
private val Muted = Color(0xFF9E9887)
private val Raised = Color(0xFF1D1B15)
private val Line = Color(0xFF3A362C)
private val Accent = Color(0xFFD8B25A)
private val Danger = Color(0xFFE0705E)
private val OnDanger = Color(0xFF2A0F0A)

private val PaperGround = Color(0xFFFBF9F3)
private val PaperInk = Color(0xFF1A1813)
private val PaperMuted = Color(0xFF5C5747)
private val PaperRaised = Color(0xFFF1EDE1)
private val PaperLine = Color(0xFFD8D2C0)
private val PaperAccent = Color(0xFF6B5312)
private val PaperDanger = Color(0xFF8C2F1E)

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Ground,
    secondary = Muted,
    onSecondary = Ground,
    background = Ground,
    onBackground = Ink,
    surface = Ground,
    onSurface = Ink,
    surfaceVariant = Raised,
    onSurfaceVariant = Muted,
    outline = Line,
    outlineVariant = Line,
    error = Danger,
    onError = OnDanger,
    errorContainer = Raised,
    onErrorContainer = Danger,
)

private val LightScheme = lightColorScheme(
    primary = PaperAccent,
    onPrimary = PaperGround,
    secondary = PaperMuted,
    onSecondary = PaperGround,
    background = PaperGround,
    onBackground = PaperInk,
    surface = PaperGround,
    onSurface = PaperInk,
    surfaceVariant = PaperRaised,
    onSurfaceVariant = PaperMuted,
    outline = PaperLine,
    outlineVariant = PaperLine,
    error = PaperDanger,
    onError = PaperGround,
    errorContainer = PaperRaised,
    onErrorContainer = PaperDanger,
)

/*
 * Every size is in sp and none is hard-capped, so the whole interface scales
 * with the system font setting. Nothing here sets maxLines on text that carries
 * a warning or a refusal: those must be allowed to wrap and grow rather than be
 * clipped at a large font size, which is exactly when a person most needs to
 * read them.
 */
private val TruePadTypography = Typography(
    displaySmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 38.sp),
    headlineSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 30.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 24.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 17.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontSize = 15.sp, lineHeight = 23.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Default, fontSize = 13.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
)

/** Monospace, for the one thing that is genuinely machine text: an envelope. */
val EnvelopeStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp)

@Composable
fun TruePadTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkScheme else LightScheme,
        typography = TruePadTypography,
        content = content,
    )
}
