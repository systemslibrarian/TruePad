//
// TruePad Sealed Pad Transfer — iOS Edition.
//
// This module is the byte-exact twin of the Browser Edition's `src/spt/*` and the
// Android Edition's `android/truepad-spt`. It speaks the frozen TruePad wire: the
// same TPR2 receive requests, the same TPS2 sealed packages, the same confirmation
// ceremony. Nothing here may diverge to suit Swift.
//
// Claims boundary, unchanged across editions:
//   * PQC protects pad DELIVERY.
//   * OTP encrypts messages.
//   * Wegman-Carter authenticates messages.
// A pad delivered by Sealed Pad Transfer is computationally delivered, and stays
// NOT ELIGIBLE for the information-theoretic delivery claim, forever.
//
public enum TruePadSPT {
    /// The frozen SPT cipher suite: X-Wing (ML-KEM-768 + X25519), HKDF-SHA-256,
    /// AES-256-GCM. Shared with the Browser and Android Editions.
    public static let suiteId: UInt16 = 0x0001
}
