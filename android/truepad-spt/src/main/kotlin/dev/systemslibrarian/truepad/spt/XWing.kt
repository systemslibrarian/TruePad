package dev.systemslibrarian.truepad.spt

import org.bouncycastle.pqc.crypto.xwing.XWingKEMExtractor
import org.bouncycastle.pqc.crypto.xwing.XWingKEMGenerator
import org.bouncycastle.pqc.crypto.xwing.XWingKeyGenerationParameters
import org.bouncycastle.pqc.crypto.xwing.XWingKeyPairGenerator
import org.bouncycastle.pqc.crypto.xwing.XWingPrivateKeyParameters
import org.bouncycastle.pqc.crypto.xwing.XWingPublicKeyParameters
import java.security.SecureRandom

/* ============================================================================
 * X-Wing (suite 0x0001) — the narrow TruePad wrapper (Kotlin/Android twin)
 * ----------------------------------------------------------------------------
 * A BYTE-EXACT twin of src/spt/xwing-v1.ts. docs/SEALED-PAD-TRANSFER.md §2.2
 * freezes the WHOLE of draft-connolly-cfrg-xwing-kem-10 as suite 0x0001. This
 * file does not implement X-Wing; it wraps Bouncy Castle's low-level
 * `org.bouncycastle.pqc.crypto.xwing` KEM, whose construction the audit
 * (docs/SEALED-PAD-TRANSFER-VALIDATION.md; the Android crypto-library audit)
 * verified byte-identical to draft-10 / @noble/post-quantum 0.7.1 — same seed,
 * SHAKE256(96) expansion, ML-KEM-coins-then-X25519 randomness order, and the
 * SHA3-256(ss_M ‖ ss_X ‖ ct_X ‖ pk_X ‖ label) combiner with the label at the end.
 *
 * It adds NO cryptography (no combiner, no extra KDF), exactly as the TS wrapper
 * refuses to. It uses BC through its LOW-LEVEL API, never registering BC as a JCA
 * provider, so it cannot clash with Android's bundled org.bouncycastle.
 *
 * The 32-byte SEED is the persisted private key (§12), never an expanded,
 * implementation-specific key structure — the reason a recipient key stays
 * portable across any conforming X-Wing implementation.
 *
 * Randomness is injected as a SecureRandom so the KAT corpus can drive the KEM
 * derandomized (draft-10 Appendix C). A PRODUCTION caller MUST use the real
 * platform CSPRNG: passing a chosen RNG to a KEM chooses the shared secret too.
 * ========================================================================= */

const val XWING_SEED_BYTES = 32
const val XWING_PUBLIC_KEY_BYTES = 1216
const val XWING_CIPHERTEXT_BYTES = 1120
const val XWING_SHARED_SECRET_BYTES = 32

/** `eseed` is 64 bytes: [0,32) the ML-KEM-768 coins, [32,64) the X25519 ephemeral
 *  scalar (§2.2). Only meaningful for the derandomized KAT path. */
const val XWING_ESEED_BYTES = 64

class XWingKeyPair(val decapsulationSeed: ByteArray, val encapsulationKey: ByteArray)

class XWingEncapsulation(val ciphertext: ByteArray, val sharedSecret: ByteArray)

private fun requireLength(bytes: ByteArray, expected: Int, what: String) {
    if (bytes.size != expected) throw IllegalArgumentException("$what: expected $expected bytes, got ${bytes.size}")
}

object XWing {

    /** Key generation. Production callers omit [rng] (fresh platform CSPRNG). The
     *  KAT passes a fixed RNG that returns the 32-byte seed so `pk` is reproducible. */
    fun generateKeyPair(rng: SecureRandom = SecureRandom()): XWingKeyPair {
        val gen = XWingKeyPairGenerator()
        gen.init(XWingKeyGenerationParameters(rng))
        val kp = gen.generateKeyPair()
        val seed = (kp.private as XWingPrivateKeyParameters).seed
        val encapsulationKey = (kp.public as XWingPublicKeyParameters).encoded
        requireLength(seed, XWING_SEED_BYTES, "decapsulationSeed")
        requireLength(encapsulationKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey")
        return XWingKeyPair(seed, encapsulationKey)
    }

    /** Encapsulate to [encapsulationKey]. Production callers omit [rng]. The KAT
     *  passes a fixed RNG returning the 64-byte `eseed` so `ct`/`ss` reproduce. */
    fun encapsulate(encapsulationKey: ByteArray, rng: SecureRandom = SecureRandom()): XWingEncapsulation {
        requireLength(encapsulationKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey")
        val pk = XWingPublicKeyParameters(encapsulationKey)
        val out = XWingKEMGenerator(rng).generateEncapsulated(pk)
        val ciphertext = out.encapsulation
        val sharedSecret = out.secret
        requireLength(ciphertext, XWING_CIPHERTEXT_BYTES, "ciphertext")
        requireLength(sharedSecret, XWING_SHARED_SECRET_BYTES, "sharedSecret")
        return XWingEncapsulation(ciphertext, sharedSecret)
    }

    /** Decapsulate — fully deterministic given [ciphertext] and the 32-byte seed. */
    fun decapsulate(ciphertext: ByteArray, decapsulationSeed: ByteArray): ByteArray {
        requireLength(ciphertext, XWING_CIPHERTEXT_BYTES, "ciphertext")
        requireLength(decapsulationSeed, XWING_SEED_BYTES, "decapsulationSeed")
        val sk = XWingPrivateKeyParameters(decapsulationSeed)
        val sharedSecret = XWingKEMExtractor(sk).extractSecret(ciphertext)
        requireLength(sharedSecret, XWING_SHARED_SECRET_BYTES, "sharedSecret")
        return sharedSecret
    }
}
