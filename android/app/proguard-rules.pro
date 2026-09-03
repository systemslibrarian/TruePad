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
# registering a JCA provider. R8 therefore keeps the whole X-Wing path by
# ordinary reachability and strips the unused provider/algorithm classes — the
# release mapping confirms the X-Wing classes are retained while ~7000 unused BC
# classes are removed.
#
# These keeps are DEFENSE IN DEPTH, not a correctness crutch: they pin exactly
# the low-level packages the KEM path uses, so a future BC bump that introduced a
# reflective lookup here could not silently shrink a needed class away. They add
# ~no size (these classes are already reachable). The JCA provider
# (org.bouncycastle.jce / jcajce) is deliberately NOT kept, so it stays stripped.
# The on-device X-Wing known-answer test against the release build is the final
# proof that the shrunk crypto path still reproduces the draft-10 vectors.
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
