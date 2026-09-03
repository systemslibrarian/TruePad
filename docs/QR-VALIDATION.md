# Handheld QR camera validation procedure

> **STATUS: TEST PROCEDURE PREPARED — NOT EXECUTED. Real handheld QR: OUTSTANDING.**
> This requires real phone cameras. Playwright, headless decoding, and image-file
> decoding are **not** substitutes for a handheld camera and do not satisfy this
> gate.

## What QR is (and is not)

QR carries the Sealed Pad Transfer **receive code** (a `TPR2` request) between two
screens/cameras. It carries no secret and changes no security property — it is a
presentation/transport for copy/paste. This gate is about **usability and correct
rejection**, not confidentiality.

## Devices and conditions (matrix)

Run the flows on a matrix of:

- **Cameras:** at least one recent Android phone camera and one iPhone camera.
- **Lighting:** normal indoor · bright / direct light · lower light.
- **Display:** screen glare present · common screen sizes (phone, laptop, larger
  monitor).
- **Distance:** close · a reasonable arm's-length distance.

## Positive flows (each must succeed on each device)

1. Sender shows the receive-code QR on screen; receiver scans with the handheld
   camera; the scanned `TPR2` enters the **same** flow as paste (no auto-confirm —
   the human still compares the words and confirms).
2. Receiver's own "Show QR" renders the same receive code; the twelve words stay
   visible/unchanged.
3. The sealed pad remains a file; the sender's eight words stay masked as designed.

## Rejection flows (each must fail closed)

4. **Malformed QR** (random/garbage QR) → rejected, no flow entered.
5. **Wrong payload** (a QR that is not a `TPR2` receive code) → rejected clearly.
6. **Duplicate scans** of the same code → no double-commit; idempotent.
7. **Cancellation** mid-scan → returns cleanly, nothing committed.
8. **Camera-permission denial** → a clear message and a working paste fallback;
   never a crash or a silent failure.

## Reporting

For each (device × lighting × flow) cell: record device model, OS version, camera
app path, lighting, result, and a photo where useful. Retain the matrix and the SHA.

Only after the positive flows succeed and the rejection flows fail closed on
**real Android and iPhone cameras** may the release checklist's "Real handheld
QR-camera validation" item be marked complete. Do not mark it complete from
emulator or image-decode evidence.
