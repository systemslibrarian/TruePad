# App Store Connect — proposed answers worksheet

**Nothing here has been entered into App Store Connect.** Each row carries a
proposed answer, the evidence behind it, and what the developer still has to do.
Where only Apple's tooling can settle something, it says so rather than guessing.

---

## Encryption

| Question | Proposed answer | Evidence | User action |
| --- | --- | --- | --- |
| Does your app use encryption? | **Yes** | `ITSAppUsesNonExemptEncryption = true` in the shipping Info.plist, verified in the built bundle | confirm in ASC |
| Does it use only encryption within Apple's OS? | **No** | CryptoKit is bypassed; `import Crypto` resolves to statically linked BoringSSL. `testRunsBelowTheCryptoKitAvailabilityFloor` | confirm |
| Does it implement encryption in addition to Apple's OS? | **Yes** | as above, plus TruePad's own OTP combiner and `wc-one-time-v1` | confirm |
| Is any of it proprietary or non-standard? | **DETERMINATION REQUIRED** — do not answer from intuition | `docs/EXPORT-DETERMINATION-PACKET.md` §2, §6 | **obtain a determination** |
| Export compliance code | **none — do not invent one** | no filing exists | supply only if Apple issues one |

## App Privacy

Every row is **No / None**, and each is supported by the binary rather than by
intent: the archived app links no networking framework and imports zero
networking, cloud or tracking symbols across 1,426 undefined symbols.

| Category | Proposed | Evidence |
| --- | --- | --- |
| Contact info, health, financial, location, browsing | **Not collected** | none of it exists in the product |
| User content (messages, files) | **Not collected** | it exists on device; nothing transmits it |
| Identifiers | **Not collected** | no AdSupport, no ASIdentifierManager |
| Usage data / diagnostics | **Not collected** | no analytics or crash SDK; no logging surface at all |
| Tracking | **No** | `NSPrivacyTracking = false`; no ATT framework |
| Third-party data sharing | **No** | one dependency, vendored swift-crypto, which transmits nothing |

**Phrase it as "TruePad does not collect", never "no data exists."** Pads and
messages plainly exist on the device — that is the product. Data on a device is
not data collected by a developer, and only the second is the question asked.

## Required-reason APIs

| Category | Declared | Reason | Justification |
| --- | --- | --- | --- |
| File timestamp | **Yes** | `C617.1` | three stat-family calls in `DarwinFs.swift` (`stat` :232, `lstat` :239, :352), all on paths inside the app container |
| System boot time / disk space / active keyboards / user defaults | **Not declared** | — | zero hits in shipping source; `tests/ios-privacy-manifest.test.ts` fails if that changes |

## Content, rights, and rating

| Question | Proposed | Evidence | User action |
| --- | --- | --- | --- |
| Age rating | expect **4+** | no objectionable content, no shared UGC, no web view, no gambling | complete the questionnaire |
| Third-party content rights | **No third-party content** | one dependency, Apple's own open-source swift-crypto, attributed in `docs/THIRD-PARTY-NOTICES.md` | confirm |
| Advertising identifier (IDFA) | **No** | no AdSupport symbols in the binary | confirm |
| User accounts / sign-in | **No** | none exists | confirm |
| Account deletion requirement | **Not applicable** | there are no accounts to delete | confirm |
| In-app purchases / subscriptions | **None** | none implemented, and adding them is out of scope | confirm |
| External purchase link entitlement | **Not applicable** | no purchases in-app | — |
| Camera | **Yes, one use** | `NSCameraUsageDescription`; scanning a public receive code only; requested lazily | confirm |
| Data deletion | app deletion removes the container | store is inside the app container | — |

## App Review information

| Field | Proposed |
| --- | --- |
| Demo account | **Not required** — the app has no accounts and no login |
| Notes | the text of `docs/APP-REVIEW-NOTES.md` |
| Contact | **NEEDS USER ACTION** — name, phone, email |
| Attachment | none needed |

## Everything only the developer can do

| Action | State |
| --- | --- |
| Apple Developer Program membership | **NEEDS USER ACTION** |
| App ID for `dev.systemslibrarian.truepad` | **NEEDS USER ACTION** |
| App Store Connect app record | **NEEDS USER ACTION** |
| Paid Applications agreement | **NEEDS USER ACTION** (required to sell) |
| Tax and banking details | **NEEDS USER ACTION** (required to sell) |
| Price tier and territories | **NEEDS USER ACTION** — no price has been chosen |
| Availability date | **NEEDS USER ACTION** |
| Privacy policy URL | `PRIVACY.md` is drafted; **hosting it is NEEDS USER ACTION** — Apple requires a reachable URL |
| Screenshots | plan in `docs/APP-STORE-METADATA.md`; capture blocked on the icon |
| App icon | **BLOCKED — final artwork required** (`docs/APP-ICON-SPEC.md`) |
| Signing certificate and distribution profile | **NEEDS USER ACTION** |

**None of the rows above may be marked complete without external verification.**
