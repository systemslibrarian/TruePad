package dev.systemslibrarian.truepad.core

/*
 * The two directions of a pair, and which party sends/receives on each. The
 * frozen wire spelling is "A->B" / "B->A"; the canonical-bytes encoding is
 * 0x00 / 0x01 (FORMAT-V2.md §6.1). This mirrors src/core/pad.ts's PadDirection.
 */
enum class Party { A, B }

enum class Direction(val wire: String, val canonicalByte: Int) {
    A_TO_B("A->B", 0x00),
    B_TO_A("B->A", 0x01);

    val sender: Party get() = if (this == A_TO_B) Party.A else Party.B
    val receiver: Party get() = if (this == A_TO_B) Party.B else Party.A
    val opposite: Direction get() = if (this == A_TO_B) B_TO_A else A_TO_B

    companion object {
        fun fromWire(s: String): Direction? = when (s) {
            "A->B" -> A_TO_B
            "B->A" -> B_TO_A
            else -> null
        }
    }
}
