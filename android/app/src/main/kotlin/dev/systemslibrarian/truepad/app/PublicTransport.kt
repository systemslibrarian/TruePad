package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.decodeCompactEnvelope2
import dev.systemslibrarian.truepad.core.decodeEnvelope2
import dev.systemslibrarian.truepad.core.encodeCompactEnvelope2

/**
 * PUBLIC TRANSPORT MATERIAL — the encrypted message and the receive code, in the
 * spelling a person is actually handed.
 *
 * The engine emits canonical §6.2 JSON, which is the right thing for it to emit
 * and the wrong thing to put in front of a human: it is several hundred
 * characters of structure where `TP2:` is one token. The Browser Edition has
 * always re-spelled it at exactly this seam — in the UI layer, after the engine
 * has replied — leaving the protocol untouched. This is that, for Android.
 *
 * RE-VALIDATED, NOT MERELY RE-SPELLED. [envelope] decodes the compact string it
 * just produced and requires it to come back to the same envelope. A screen
 * cannot display one spelling and copy another, because there is only one value
 * and every control uses it.
 *
 * NOTHING ABOUT THE WIRE CHANGES. Both spellings decode to the same envelope
 * through the same validated path, canonical JSON is still accepted on open, and
 * no byte that is authenticated is affected by which one is shown.
 *
 * NOT A `data class`, DELIBERATELY. A data class with a private constructor still
 * generates a public `copy()`, so any caller could take a validated value and
 * `copy(text = "anything")` — which would defeat the entire point of making this
 * a type rather than a String. The compiler warned about exactly that; this is
 * the warning taken seriously rather than suppressed.
 */
class PublicTransport private constructor(val text: String) {
    companion object {
        /**
         * The compact spelling of a canonical envelope, or null if it does not
         * round-trip. Null is not an error state for the operator: the canonical
         * form is still the message and is still displayed.
         */
        fun envelope(canonicalJson: String): PublicTransport? {
            val decoded = decodeEnvelope2(canonicalJson)
            if (decoded !is EnvelopeDecode.Ok) return null
            val compact = encodeCompactEnvelope2(decoded.envelope)
            val back = decodeCompactEnvelope2(compact)
            if (back !is EnvelopeDecode.Ok) return null
            if (encodeCompactEnvelope2(back.envelope) != compact) return null
            return PublicTransport(compact)
        }
    }
}
