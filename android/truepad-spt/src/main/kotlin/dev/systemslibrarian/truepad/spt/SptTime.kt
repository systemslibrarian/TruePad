package dev.systemslibrarian.truepad.spt

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/* ============================================================================
 * Canonical ISO-8601 timestamps, exactly the `YYYY-MM-DDTHH:mm:ss.sssZ` form
 * `new Date().toISOString()` emits (always 3-digit millis, always Z). The SPT
 * durable records store and re-validate timestamps in this exact spelling.
 * ========================================================================= */
object SptTime {
    private val ISO: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** Exactly seven days as an instant difference (not "same clock time 7 days
     *  later" — that stretches across a DST boundary). */
    const val REQUEST_TTL_MS: Long = 7L * 24 * 60 * 60 * 1000

    fun format(instant: Instant): String = ISO.format(instant.truncatedTo(ChronoUnit.MILLIS))

    /** Matches the browser's requireIso: a canonical timestamp is one whose parse
     *  re-formats to the identical spelling — so a value without 3-digit millis,
     *  or with extra precision, is rejected. */
    fun isCanonicalIso(s: String): Boolean = try {
        format(Instant.parse(s)) == s
    } catch (_: Exception) {
        false
    }

    fun parseMillis(s: String): Long = Instant.parse(s).toEpochMilli()
}
