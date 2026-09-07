# Captured cross-edition artifacts

These two files are **not** fixtures this project generated. They are the literal
bytes a physical Samsung SM-A176U (Android 16, build `BP4A.251205.006.A176USQS6BZG2`)
produced during the cross-edition ceremony run `20260907T013715Z`, against tree
`5af736fd4b514ca9470f6eea4d2c7d6a8d780ff9`.

| File | What it is |
| --- | --- |
| `03-android-tp2.txt` | 398-char `TP2:` compact envelope, read off the Android Copy control |
| `04-android-canonical.json` | 705-char canonical envelope the same screen showed under "Technical form", for a *second* message (a record is one-time) |

`CrossEditionBytesTest` runs the iOS production decoder over them. Regenerating
them would defeat the purpose: the value is precisely that another edition, on
other hardware, produced these exact characters.

The full evidence bundle for that run — device identities, hashes at both ends of
each carry, and both `.xcresult` bundles — is not committed. It is reproducible
with `scripts/cross-edition-physical.sh`.
