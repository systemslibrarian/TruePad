/* ============================================================================
 * Sealed Pad Transfer v1 — frozen constants
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/constants.ts. Every value here is normative in
 * docs/SEALED-PAD-TRANSFER.md. Nothing may be "improved": a different byte here
 * is a different protocol, and suite 0x0001 is defined by that document rather
 * than by any one edition's code.
 *
 * The domain-separator LENGTHS are computed, never written down — §6.2 states
 * the rule and why. A wrong length octet does not fail loudly; it silently forks
 * requestHash, and with it the safety words, the HKDF salt and AAD bytes
 * [23, 55), between two conforming builds — producing exactly the symptom of an
 * active attack. For DS_PAD it is worse: padHash never reaches the wire, so two
 * builds would derive different nonces for the same pad and every package would
 * still verify. The counts below are comments, asserted by tests against the
 * measured strings; no code path reads them.
 * ========================================================================= */

public enum SptConstants {
    public static let transferVersion: UInt8 = 0x01
    public static let suiteId: UInt16 = 0x0001

    public static let tpr2Prefix = "TPR2:"
    public static let tps2Magic = "TPS2"
    public static let tps2MagicBytes: [UInt8] = [0x54, 0x50, 0x53, 0x32]

    // ---- domain separators (§6.2) ------------------------------------------
    public static let dsRequestFP = "TruePad/SPT/v1/request-fingerprint"   //  34
    public static let dsAeadKey = "TruePad/SPT/v1/aead-key"                //  23
    public static let dsConfirm = "TruePad/SPT/v1/transfer-confirmation"   //  36
    public static let dsNonce = "TruePad/SPT/v1/aead-nonce"                //  25
    public static let dsPad = "TruePad/SPT/v1/pad-commitment"              //  29

    // ---- X-Wing suite 0x0001 sizes (§2.2) ----------------------------------
    public static let xwingSeedBytes = 32
    public static let xwingPublicKeyBytes = 1216
    public static let xwingCiphertextBytes = 1120
    public static let xwingSharedSecretBytes = 32
    public static let xwingEseedBytes = 64
    /// ML-KEM-768 halves of the concatenations, for the split checks.
    public static let mlkemPublicKeyBytes = 1184
    public static let mlkemCiphertextBytes = 1088
    public static let x25519Bytes = 32

    // ---- TPR2 — the receive request (§5.1, §5.2) ---------------------------
    public static let requestIdBytes = 16
    public static let tpr2BodyBytes = 1235   // 1 + 2 + 16 + 1216
    public static let tpr2TextChars = 1652   // 5 prefix + ceil(1235 * 4 / 3)

    // ---- TPS2 — the sealed package (§7.1) ----------------------------------
    public static let requestHashBytes = 32
    public static let aeadNonceBytes = 12
    public static let aeadTagBytes = 16
    public static let aeadKeyBytes = 32
    public static let tps2HeaderBytes = 1195          // 4+1+2+16+32+1120+12+8 — also the AAD
    public static let tps2FixedOverheadBytes = 1211   // header + tag
    public static let maxPlaintextBytes = 16_777_216  // 16 MiB

    /// Field offsets into the TPS2 header, half-open [start, end).
    public enum TPS2Offsets {
        public static let magic = 0
        public static let version = 4
        public static let suite = 5
        public static let requestId = 7
        public static let requestHash = 23
        public static let kemCiphertext = 55
        public static let nonce = 1175
        public static let plaintextLength = 1187
        public static let ciphertext = 1195
    }

    // ---- safety-word renderings (§6.3, §8.2) -------------------------------
    public static let requestWordsCount = 12
    public static let requestWordsBits = 132
    public static let confirmWordsCount = 8
    public static let confirmWordsBits = 88
    public static let confirmValueBytes = 11
    public static let wordlistSize = 2048
}
