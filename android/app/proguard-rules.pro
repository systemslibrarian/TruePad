# TruePad Android — release shrinking rules.
#
# Nothing here is a security control; R8 is a size/optimisation pass, not a
# protection. The engine has no reflection, no serialization framework and no
# service loaders, so it needs no keep rules at all — this file exists so the
# release build is explicit about that rather than silently relying on defaults.

# Compose ships its own consumer rules. Nothing to add.

# Bouncy Castle — the SPT/X-Wing (ML-KEM-768 + X25519) provider, reached ONLY
# through Sealed Pad Transfer. It is used via BC's LOW-LEVEL API by direct static
# reference (XWingKeyPairGenerator, XWingKEMGenerator, XWingKEMExtractor,
# rfc7748.X25519, SHAKEDigest and the ML-KEM/Keccak internals they reach), NOT by
# registering a JCA provider. R8 therefore keeps the whole X-Wing path by ordinary
# reachability and strips the unused provider/algorithm classes.
#
# These keeps are DEFENSE IN DEPTH, not a correctness crutch: they pin exactly
# the low-level packages the KEM path uses, so a future BC bump that introduced a
# reflective lookup here could not silently shrink a needed class away. They add
# ~no size (these classes are already reachable). The JCA provider
# (org.bouncycastle.jce / jcajce) is deliberately NOT kept, so it stays stripped.
#
# WHAT IS ACTUALLY TESTED, AND WHAT IS NOT. Be precise here, because these rules
# protect a path no test currently walks:
#
#   * The draft-10 Appendix-C known-answer test is REAL and byte-for-byte
#     (truepad-spt XWingKatTest), but it is a JVM unit test. It runs against
#     unshrunk classes on a desktop JVM, not on ART and not through R8.
#   * The on-device SPT test (SptDeviceTest) does exercise BC's X-Wing on ART,
#     but it is a ROUND TRIP — self-consistent by construction — not a
#     known-answer test, and instrumentation builds the DEBUG variant
#     (testBuildType is not set), where isMinifyEnabled = false.
#
# So NOTHING exercises the shrunk crypto path. An earlier version of this comment
# claimed the opposite — "the on-device known-answer test against the release
# build is the final proof that the shrunk crypto path still reproduces the
# draft-10 vectors" — and every clause of that was wrong: wrong test kind, wrong
# variant, wrong classpath. It also cited a release mapping as confirming which
# classes survive; that observation was made by hand once and is checked by
# nothing.
#
# That gap is the REASON THESE KEEPS STAY, not a reason to trim them. Rules whose
# necessity is unproven and whose sufficiency is untested are exactly the rules to
# leave conservative.
-keep class org.bouncycastle.pqc.crypto.xwing.** { *; }
-keep class org.bouncycastle.pqc.crypto.mlkem.** { *; }
-keep class org.bouncycastle.math.ec.rfc7748.** { *; }
-keep class org.bouncycastle.crypto.digests.SHAKEDigest { *; }
-dontwarn org.bouncycastle.**

# Keep line numbers so a crash report an operator chooses to send by hand is
# readable. It contains no secret: the engine never puts pad material, keys,
# masks, tags or plaintext into an exception message (see the refusal-message
# audit in DestructionAndSecretsTest).
-keepattributes SourceFile,LineNumberTable
