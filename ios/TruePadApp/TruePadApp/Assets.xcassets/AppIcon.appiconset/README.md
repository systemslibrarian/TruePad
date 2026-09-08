# The App Store icon slot is deliberately EMPTY

`Contents.json` declares the single 1024×1024 universal slot modern Xcode wants,
and carries **no `filename`** because no final artwork exists yet.

**Do not drop a placeholder here to make a build go green.** The whole point of
the empty slot is that `ios/scripts/check-app-store-archive.sh` can tell
"infrastructure wired, artwork outstanding" apart from "nobody has thought about
the icon" — and a grey square would erase that distinction while making an
un-uploadable archive look finished. App Store Connect rejects a missing icon at
UPLOAD (ITMS-90713), not at archive time, so the build itself will not stop you.

To finish it: put a single opaque 1024×1024 PNG here, add its `"filename"` to the
image entry in `Contents.json`, and re-run the archive check. The requirements and
the review criteria are in `docs/APP-ICON-SPEC.md`.
