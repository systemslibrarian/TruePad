# TruePad iOS — App Store / TestFlight readiness

**THIS DOCUMENT IS THE CANONICAL RECORD FOR THE DISTRIBUTION LANE.** Where another
document disagrees with it about what is ready, blocked, or waiting on someone,
this one is correct and the other is stale.

**Nothing here has been uploaded to Apple.** No build has been submitted, no
review requested, no TestFlight distribution made. Every row below is either
evidence gathered locally or an action that is explicitly still owed.

State labels are used strictly, and "not checked" is never written as READY:

| Label | Meaning |
| --- | --- |
| **READY** | verified locally, evidence recorded here |
| **BLOCKED** | cannot proceed; the blocker is named |
| **NEEDS USER ACTION** | requires the developer's Apple account or assets |
| **NEEDS APP STORE CONNECT DETERMINATION** | only Apple's own tooling can answer |
| **NOT APPLICABLE** | genuinely does not apply, with the reason |
| **NOT VERIFIED** | not established in this pass; do not read as pass or fail |

---

## 1. Build and toolchain — READY

Apple requires uploads to be built with Xcode 26 or later and the iOS 26 SDK or
later. Proven locally rather than inferred from a CI log:

| | |
| --- | --- |
| Xcode | **26.6**, build 17F113 |
| Swift | 6.3.3 (swiftlang-6.3.3.1.3) |
| iOS SDK | **26.5** (`iphoneos26.5`) — and the archive records `DTSDKName = iphoneos26.5`, `DTXcode = 2660` |

## 2. Bundle identity and project — READY

| | |
| --- | --- |
| Bundle identifier | `dev.systemslibrarian.truepad` — stable, no clone suffix |
| Marketing version | `3.0.0` |
| Build number | `2` |
| Deployment target | iOS 16.0 |
| Device family | iPhone only (`TARGETED_DEVICE_FAMILY = 1`), portrait only |
| Architecture | arm64 |
| Embedded frameworks | none — everything links statically |

## 3. Archive — READY (unsigned) / signing BLOCKED

**Precise terminology matters here.** What was produced is an **unsigned
generic-device Release archive**, not an App Store-uploadable `.ipa`.

- `xcodebuild archive` with signing allowed: **fails** — *"Signing for
  'TruePadApp' requires a development team."*
- `xcodebuild archive` with `CODE_SIGNING_ALLOWED=NO`: **ARCHIVE SUCCEEDED**.

**And "ARCHIVE SUCCEEDED" is not evidence of uploadability.** `VALIDATE_PRODUCT`
ran Xcode's `-validate-for-store` during that archive and **passed anyway**, with
no app icon present. The icon is rejected at upload (ITMS-90713), not at archive
time, so a green archive here says nothing about §9.

Inspected in the resulting `TruePad.app`:

| Check | Result |
| --- | --- |
| Test bundle or XCTest inside the app | **none** |
| `swift-crypto` resource bundles present with their own privacy manifests | yes, 6 |
| Networking frameworks linked | **none** — no CFNetwork, no Network.framework |
| Networking/cloud/tracking symbols imported | **zero** across 1,426 undefined symbols |
| Camera symbols (expected) | `AVCapture` present |
| App icon | **ABSENT — see §9** |

### Export path — PREPARED, NEVER RUN

`ios/TruePadApp/ExportOptions.plist` targets `app-store-connect` with automatic
signing and carries **no secrets**: no team id, no provisioning profile, no
certificate. The team is supplied on the command line so an account identity never
becomes a committed fact.

```
xcodebuild archive -scheme TruePadApp -configuration Release \
    -destination 'generic/platform=iOS' -archivePath build/TruePad.xcarchive \
    DEVELOPMENT_TEAM=YOUR_TEAM_ID

ios/scripts/check-app-store-archive.sh build/TruePad.xcarchive

xcodebuild -exportArchive -archivePath build/TruePad.xcarchive \
    -exportPath build/export \
    -exportOptionsPlist ios/TruePadApp/ExportOptions.plist \
    -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM_ID
```

**This path has never been executed successfully**, because it needs a developer
team. It is a prepared route, not a demonstrated one, and is described that way
deliberately.

### Archive inspection — READY

`ios/scripts/check-app-store-archive.sh` fails closed on: wrong or clone bundle
identifier, missing icon, wrong marketing version, missing or invalid build
number, test bundle in the archive, embedded frameworks, background modes, URL
types, ATS exceptions, file sharing, missing privacy manifest, a wrong
`ITSAppUsesNonExemptEncryption`, a camera string that has lost its retention
promise, unexpected entitlements, networking or tracking symbols, and test-only
KAT surface. It reuses the repaired captured-symbol machinery rather than
re-implementing a `nm | grep -q` probe.

Run against the current archive it reports **FAIL**, and the only failing section
is the icon — which is the correct answer today.

### Build number — READY

`ios/scripts/set-build-number.sh` sets `CURRENT_PROJECT_VERSION` in all four
configurations at once and **refuses to decrease it**, because App Store Connect
rejects a build number that goes backward and finding that out at upload is the
expensive way. `tests/release-state.test.ts` asserts all four agree. Current
value: **2**. Bumping it is a TestFlight upload, not a GitHub release.

## 4. Signing — NEEDS USER ACTION

Expected, and not a product failure. Nothing about signing is committed, and
nothing should be: no Team ID, certificate, private key, provisioning profile,
Apple ID or App Store Connect API key is in this repository.

One project detail worth changing when signing is configured: the Release
configuration currently specifies `CODE_SIGN_IDENTITY = Apple Development`, a
**development** identity. A distribution archive needs the distribution identity
that automatic signing selects once a team is set. Left alone here because setting
it without an account to test against would be guesswork.

## 5. Capabilities and entitlements — READY

There is **no `.entitlements` file and no `CODE_SIGN_ENTITLEMENTS` setting**, which
is correct for this product. TruePad requests no capability: no background modes,
no push, no iCloud, no app groups, no associated domains, no network extension.

## 6. Info.plist — READY

Written out explicitly rather than generated, and short enough to read whole. It
declares exactly one permission and no URL scheme, no background mode, no ATS
exception, no exported document type. `UIFileSharingEnabled` and
`LSSupportsOpeningDocumentsInPlace` are both **false** — deliberately, since a pad
a file picker can reach is a pad that can leave the app's control without the
one-handoff rule ever running.

## 7. Privacy manifest — READY

`ios/TruePadApp/TruePadApp/PrivacyInfo.xcprivacy`, wired into the app target's
Resources phase and verified present in the built bundle.

- `NSPrivacyTracking`: **false**
- `NSPrivacyTrackingDomains`: empty
- `NSPrivacyCollectedDataTypes`: **empty**
- `NSPrivacyAccessedAPITypes`: **one** — `NSPrivacyAccessedAPICategoryFileTimestamp`, reason **`C617.1`**

Declared because it is true, not because it is reassuring. TruePad makes three
stat-family calls, all in `TruePadStorage/DarwinFs.swift` and all on paths inside
its own container: `stat` at `:232` (a regular file, followed through symlinks,
reads normally), and `lstat` at `:239` and `:352` (existence *without* following,
because a `stat` that follows would let a symlinked `destroyed.json` read as absent
and a destroyed pair become usable again). None reads a timestamp — only `st_mode`
type bits — but Apple's category is keyed on the API, not the field.

The other four categories — system boot time, disk space, active keyboards, user
defaults — have **zero** hits in shipping source, and nothing is declared for them.

`tests/ios-privacy-manifest.test.ts` holds this in both directions: an undeclared
required-reason API fails, and so does a declared category no code reaches. Six
mutations were proved, including a new `UserDefaults` use and a networking API
entering the engine.

## 8. App Privacy answers — READY (proposed)

Proposed answers, each supported by the binary rather than by intent. See
`PRIVACY.md` for the user-facing statement.

| Question | Answer | Evidence |
| --- | --- | --- |
| Data collected by the developer | **None** | no networking framework linked; zero networking symbols |
| Tracking | **No** | no AdSupport, no AppTrackingTransparency, no ASIdentifierManager |
| Third-party analytics or ads | **No** | the only dependency is vendored swift-crypto |
| Accounts / external authentication | **No** | none exists in the product |
| Cloud storage of user data | **No** | no CloudKit, no `NSUbiquitous*` |
| Camera frames or QR scans uploaded | **No** | no egress path exists to upload them with |

**Stated as "TruePad does not collect", not "no data exists".** Pads, messages and
receive codes plainly exist on the device — that is the product. Data existing on a
device is not data collected by a developer, and only the second is what Apple
asks. No claim is made about what Apple or iOS itself collects; TruePad does not
control that.

## 9. App icon — infrastructure READY / artwork BLOCKED

**Infrastructure: READY.** `Assets.xcassets/AppIcon.appiconset` exists with the
single 1024×1024 universal slot modern Xcode uses, is a resource of the app
target, and `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` is set in **both** app
configurations. `tests/ios-distribution.test.ts` holds all of that, and was
mutation-proved seven ways.

**Artwork: BLOCKED — FINAL ARTWORK REQUIRED.** The slot carries no `filename`
because no icon exists. Measured consequence, not assumed: with the catalog wired
and the slot empty, `xcodebuild archive` **still succeeds**, and the bundle still
has **no `Assets.car`, no `CFBundleIconName`, no `CFBundleIcons`**. Wiring the
infrastructure does not fake readiness, which is the point.

No placeholder has been committed, and the guard fails if one appears: an
unreferenced image in the iconset is treated as filler dropped in to green the
gate. The full handoff — sizes, colour space, legibility criteria and the
acceptance procedure — is in [`APP-ICON-SPEC.md`](APP-ICON-SPEC.md).

## 10. Export compliance — NEEDS APP STORE CONNECT DETERMINATION

`ITSAppUsesNonExemptEncryption = true` in the shipping Info.plist, which is the
truthful answer and was not changed to ease submission.

The full inventory and the BIS analysis are in
[`APPLE-EXPORT-COMPLIANCE.md`](APPLE-EXPORT-COMPLIANCE.md). Its headline:
TruePad implements encryption **outside** Apple's OS (CryptoKit is deliberately
bypassed for an iOS 16 deployment target), and whether that lands under BIS
§740.17(b)(1) self-classification or (b)(3) classification request is **an open
determination** — not, as an earlier draft of that document wrongly concluded, an
automatic classification request.

## 11. App Review notes — READY (draft)

[`APP-REVIEW-NOTES.md`](APP-REVIEW-NOTES.md).

## 12. Store metadata and screenshots — READY (draft) / artwork NEEDS USER ACTION

[`APP-STORE-METADATA.md`](APP-STORE-METADATA.md), including the screenshot plan.
No screenshots have been captured; the plan specifies safe synthetic content and
forbids real pad material.

## 13. TestFlight — NOT APPLICABLE until §9 and §4 clear

Repository-side work is done. Everything remaining is account-side:

| Action | State |
| --- | --- |
| Apple Developer Program membership | **NEEDS USER ACTION** |
| App ID registration for `dev.systemslibrarian.truepad` | **NEEDS USER ACTION** |
| App Store Connect app record | **NEEDS USER ACTION** |
| Signing certificate + distribution profile | **NEEDS USER ACTION** |
| Export compliance answers | **NEEDS APP STORE CONNECT DETERMINATION** |
| App Privacy answers | drafted in §8, entry is **NEEDS USER ACTION** |
| Privacy policy URL | `PRIVACY.md` drafted; hosting is **NEEDS USER ACTION** |
| Screenshots | **BLOCKED** on §9 and capture |
| Pricing and availability | **NEEDS USER ACTION** — see the metadata document |

## 14. Version policy for a submission

The public `v3.0.0` tag is immutable and is **not** what would be uploaded: this
lane adds a privacy manifest and documentation, so an App Store binary is not
byte-identical to the v3.0.0 source release. That is stated rather than hidden.

Master remains at **3.0.0**, matching the project's practice of holding the
released version until the next line is deliberately opened. **No version was
bumped and no tag was created in this lane.** If a submission is made later, the
build number is the value to increment; whether it also warrants `3.0.1` is a
decision for that moment, not this one.

## 15. Final classification

**B — REPOSITORY READY; USER/APPLE COMPLIANCE ACTIONS REMAIN**, with one technical
blocker inside it: the app icon (§9), which needs artwork rather than code.
