# TruePad — Privacy Policy

*Applies to the TruePad iOS application. Last reviewed for the 3.0.0 line.*

## The short version

**TruePad does not collect any data.** There is no account, no backend, no
analytics, no advertising, and no tracking. The app makes no network requests: it
links no networking framework, and its compiled binary imports no networking
symbols at all.

That claim is deliberately narrow, so it is worth separating two things that are
easy to blur:

- **Data exists on your device.** Pads, messages and receive codes are stored
  locally. That is the product.
- **No data is collected by the developer.** None of it is sent anywhere, because
  the app has no mechanism to send anything.

## What TruePad stores on your device

Pad material, the state that records which parts of a pad have been used, messages
you open, and any file you explicitly choose to save. All of it lives inside the
app's own container. The store is marked as excluded from device backups, because a
restored backup could otherwise reinstate an older record of what had been used —
which is the exact failure a one-time pad cannot survive.

Deleting the app removes its container and everything in it.

## Two things that live outside the app's own container

Stated because "everything stays in the container" would not be strictly true, and
this document is meant to survive being checked.

**The rollback witness, in the iOS Keychain.** A small record used to detect
whether the app's state has been rolled back — for example by a restored backup.
It is stored device-bound (`ThisDeviceOnly`) and is **never** synchronised to
iCloud or to your other devices. It structurally cannot hold pad material.

**The system clipboard, when you press Copy.** Copying an encrypted message or a
receive code puts it on the ordinary iOS clipboard. On Apple devices signed into
the same account, the clipboard can be shared between them by **Universal
Clipboard** — an iOS feature, not something TruePad sends. Only material that is
already public is ever copied this way: encrypted transports and receive codes.
Decrypted message text has no Copy control at all, and cannot be selected.

Sharing a pad file or a sealed package uses the standard iOS share sheet, and the
destination is whichever one you choose.

## Camera

TruePad uses the camera for one thing: scanning a QR code that contains a **public**
receive code. Permission is requested when you choose to scan, not at launch.
Camera frames are processed on the device to read the code and are **not saved and
not transmitted**.

## Network

The application performs no network communication. There is nothing to opt out of,
because there is no request to make.

If a link in the app or its store listing takes you to a web page, that page is
loaded by your browser under its own terms, not by TruePad.

## Third-party components

TruePad bundles one third-party library: Apple's open-source **swift-crypto**,
vendored and pinned in the repository. It performs cryptography locally and
transmits nothing. It ships its own privacy manifests, which declare no data
collection and no tracking.

There are no analytics SDKs, no advertising SDKs, and no crash-reporting SDKs.

## Crash reports and diagnostics

TruePad itself collects none. If you have enabled Apple's own diagnostics sharing
in iOS settings, Apple may collect crash information under **Apple's** policy — that
is a platform behaviour outside TruePad's control, and it is mentioned here so this
document does not appear to promise something it cannot.

## Children

TruePad has no accounts, no user-generated content shared with anyone, and no
messaging service. It collects nothing from anyone, of any age.

## Changes

Material changes to this policy will accompany a release, and the repository's
history records them.

## Contact

Issues and questions: through the project repository linked from the App Store
listing.
