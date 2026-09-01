# TruePad Android — release shrinking rules.
#
# Nothing here is a security control; R8 is a size/optimisation pass, not a
# protection. The engine has no reflection, no serialization framework and no
# service loaders, so it needs no keep rules at all — this file exists so the
# release build is explicit about that rather than silently relying on defaults.

# Compose ships its own consumer rules. Nothing to add.

# Keep line numbers so a crash report an operator chooses to send by hand is
# readable. It contains no secret: the engine never puts pad material, keys,
# masks, tags or plaintext into an exception message (see the refusal-message
# audit in DestructionAndSecretsTest).
-keepattributes SourceFile,LineNumberTable
