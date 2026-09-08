# TruePad iOS — app icon handoff specification

**This is the handoff document for the one remaining artwork task.** Everything
around the icon is built and wired; only the picture is missing.

## Current state

- `ios/TruePadApp/TruePadApp/Assets.xcassets/AppIcon.appiconset/` exists,
  `Contents.json` declares the single 1024×1024 universal slot modern Xcode uses,
  and the catalog is a resource of the app target with
  `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`.
- The slot carries **no `filename`**, because there is no final artwork.
- `ios/scripts/check-app-store-archive.sh` fails on exactly this, and reports it
  as an artwork blocker rather than a code one.

**No placeholder has been committed, deliberately.** A grey square would turn a
red gate green while leaving the archive un-uploadable — and it would erase the
difference between "artwork outstanding" and "nobody thought about the icon".

## What is needed

One file: an opaque **1024×1024 PNG**, placed in the `AppIcon.appiconset`
directory with its name added as `"filename"` in `Contents.json`. Modern Xcode
generates every smaller size from it.

| Requirement | Why |
| --- | --- |
| Exactly 1024×1024, square | Apple's marketing-icon size |
| **No alpha channel**, fully opaque | transparency is rejected for the App Store icon |
| **No rounded corners, no drop shadow** | iOS applies the mask itself; baked-in corners look wrong |
| sRGB, 8-bit per channel, flattened | avoids colour shifts and rejection |
| No screenshot of the app inside the icon | Apple rejects icons that are screenshots |

## Design constraints specific to TruePad

- **Carry the existing visual identity.** The apps already share one accent
  (`TruePadPalette.accent`, `0xD8B25A` — a muted gold) against dark surfaces. The
  icon should look like it belongs to the same product, not like a stock padlock.
- **No secret-looking content.** No pad material, no key-like hex strings, no
  fake ciphertext. An icon that displays plausible-looking key bytes is a bad
  joke on a product whose entire point is that key material does not leak.
- **Avoid a plain padlock.** Every security app uses one. TruePad is about a pad
  being *consumed* — the interesting visual idea is one-time-ness, not locking.
- **Legible at 60×60 and 40×40.** Detail that dissolves at Settings-row size is
  noise. Check it at those sizes before accepting it, not at 1024.
- **Text is almost certainly a mistake.** A word at 40×40 is a smudge.
- **Both appearance modes.** iOS 18+ renders tinted and dark variants; a design
  that depends on one background colour will look broken in another. Optional
  dark/tinted variants can be added to the same set later.

## Acceptance procedure

1. Drop the PNG in and add its `filename` to `Contents.json`.
2. `cd ios/TruePadApp && xcodebuild archive -scheme TruePadApp -configuration Release \
   -destination 'generic/platform=iOS' -archivePath /tmp/TruePad.xcarchive \
   CODE_SIGNING_ALLOWED=NO`
3. `ios/scripts/check-app-store-archive.sh /tmp/TruePad.xcarchive` — the icon
   section must turn PASS, which means `CFBundleIconName` is present **and** an
   `Assets.car` was produced. Both, not either: the catalog can be wired and still
   emit nothing.
4. Install to a device or simulator and look at it on the home screen, in
   Settings, and in Spotlight.

Until step 3 passes, the readiness document keeps saying
**APP ICON — BLOCKED: FINAL ARTWORK REQUIRED**, which is the truth.
