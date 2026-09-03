# Third-party notices

TruePad itself is licensed **AGPL-3.0-only**. The components below are bundled
into the Browser Edition and keep their own licenses and notices, reproduced
here. Nothing on this list is fetched at runtime — the build makes no network
request during operation. The three **direct** runtime dependencies are pinned to
exact versions in `package.json`; their transitive dependencies are pinned by
`package-lock.json` (lockfileVersion 3, with sha512 integrity). The full runtime
closure is six packages: `@noble/post-quantum` and its three `@noble/*` transitive
dependencies, plus `qrcode-generator` and `jsqr`.

The prior vendored component, the BIP-39 English wordlist, has its own detailed
provenance record at [`src/browser/ui/wordlist/PROVENANCE.md`](../src/browser/ui/wordlist/PROVENANCE.md).

---

## Sealed Pad Transfer — post-quantum hybrid KEM

The Sealed Pad Transfer feature (`src/spt/**`) uses the X-Wing hybrid KEM
(ML-KEM-768 + X25519) from the `@noble/post-quantum` package, which pulls three
`@noble/*` transitive runtime dependencies. All four are **MIT**. They are bundled
into the engine **worker** chunk; the ordinary OTP message path (gen/burn/open,
the message/compact envelopes, frame, and one-time authentication) imports none of
them — this KEM code is reached only through Sealed Pad Transfer.

### @noble/post-quantum, @noble/ciphers, @noble/curves, @noble/hashes

- **Packages:** `@noble/post-quantum` 0.7.1; transitive `@noble/ciphers` 2.4.0,
  `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0.
- **Author:** Paul Miller (https://paulmillr.com)
- **Repository:** https://github.com/paulmillr/noble-post-quantum (and the sibling
  `noble-ciphers`, `noble-curves`, `noble-hashes` repositories).
- **License:** MIT (each package).

MIT license, reproduced verbatim (applies to each of the four `@noble/*` packages;
copyright held by their author):

```
The MIT License (MIT)

Copyright (c) 2024 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

> The exact upstream copyright line should be confirmed against each package's
> bundled `LICENSE` file at release time and the notice conveyed with the built
> `dist/` artifact, not left only in `node_modules`.

---

## QR transport (Sealed Pad Transfer convenience)

Two libraries move the **public** TPR2 receive code between screens as a QR code.
They add no cryptography and no protocol: one turns the receive-code text into a
symbol, the other reads a symbol back into text. The twelve-word comparison is
still what authenticates the request; the QR carries exactly the same text the
clipboard carries.

### qrcode-generator

- **Version:** 2.0.4 (exact pin)
- **Purpose:** encode the receive-code text into a QR module matrix (byte mode,
  EC level M). Used on the receiver's "Show QR code".
- **Repository:** https://github.com/kazuhikoarase/qrcode-generator
- **License:** MIT
- **Runtime surface:** pure JavaScript. No `eval`, no `new Function`, no
  WebAssembly, no workers, no network. Zero transitive dependencies.

MIT license, reproduced verbatim:

```
Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

### jsQR

- **Version:** 1.4.0 (exact pin)
- **Purpose:** decode a QR image (a camera frame or a chosen image file) back
  into candidate text. Used on the sender's "Scan QR code" / "Choose QR image".
  Dynamically imported the first time a scan happens, never at page load.
- **Repository:** https://github.com/cozmo/jsQR
- **License:** Apache-2.0
- **Runtime surface:** pure JavaScript. No `eval`, no `new Function`, no
  WebAssembly, no workers, no network. Zero transitive dependencies.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at:

```
http://www.apache.org/licenses/LICENSE-2.0
```

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License. The
full license text ships in the package at `node_modules/jsqr/LICENSE`.

---

## Android Edition — post-quantum hybrid KEM (Bouncy Castle)

The Android Edition (`android/**`) implements the **same** Sealed Pad Transfer
protocol and the **same** X-Wing hybrid KEM (ML-KEM-768 + X25519), but on the
JVM it uses **Bouncy Castle** in place of `@noble/post-quantum`. The bytes are
identical: `android/truepad-spt` reproduces the X-Wing draft-10 Appendix-C
known-answer vectors and the cross-language SPT interop corpus (see
`android/truepad-spt/src/test`). Bouncy Castle is reached only through Sealed
Pad Transfer; the OTP message path (gen/burn/open) imports none of it.

Bouncy Castle is a pure-Java cryptography library. It ships no Android manifest,
declares no permission, opens no socket, and is used through BC's **low-level
API** (e.g. `XWingKeyPairGenerator`, `XWingKEMGenerator`, `XWingKEMExtractor`,
`org.bouncycastle.math.ec.rfc7748.X25519`), **not** by registering a JCA
provider — so it never clashes with the trimmed `org.bouncycastle` classes some
Android platforms bundle.

### bcprov-jdk18on

- **Package:** `org.bouncycastle:bcprov-jdk18on` **1.85.2** (exact pin, in
  `android/gradle/libs.versions.toml`; do not bump without re-running the SPT
  known-answer and interop corpora).
- **Provider:** The Legion of the Bouncy Castle Inc. (https://www.bouncycastle.org)
- **Repository:** https://github.com/bcgit/bc-java
- **License:** the Bouncy Castle Licence — an adaptation of the MIT/X11 license,
  reproduced verbatim below. It is AGPL-3.0-only compatible.

```
Copyright (c) 2000 - 2025 The Legion of the Bouncy Castle Inc.
(https://www.bouncycastle.org)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Comparison wordlist (Android)

The Android Edition vendors the same BIP-39 English comparison wordlist as the
Browser Edition, byte-for-byte, at
`android/truepad-spt/src/main/resources/comparison-words.txt`, with its
provenance and MIT notice at
`android/truepad-spt/src/main/resources/COMPARISON-WORDS-PROVENANCE.md` and its
SHA-256 pinned by `ComparisonWordsTest`.

### TPR2 QR — encode and scan (Android)

The Android Edition offers the same TPR2 QR workflow as the Browser Edition: the
receiver can show the PUBLIC receive code as a QR, and the sender can scan it.
Where the browser uses `qrcode-generator` + `jsQR`, the Android app uses ZXing
for both encode and decode and AndroidX CameraX for the camera. Both are
reached ONLY through Sealed Pad Transfer. A scanned string is handed to the same
strict TPR2 parser a pasted code is, so a mis-scan is refused, never trusted, and
the camera frames are analysed in-process and discarded — the app has no
INTERNET permission for them to leave by.

#### ZXing core

- **Package:** `com.google.zxing:core` **3.5.3** (exact pin). Pure Java, no
  transitive dependencies, no network, no Google Play Services.
- **Repository:** https://github.com/zxing/zxing
- **License:** Apache-2.0.

#### AndroidX CameraX

- **Packages:** `androidx.camera:camera-core`, `camera-camera2`,
  `camera-lifecycle`, `camera-view` — all **1.4.1** (exact pin). Standard Jetpack
  libraries; the camera2 backend uses the platform Camera2 API, not Google Play
  Services.
- **Repository:** https://android.googlesource.com/platform/frameworks/support
- **License:** Apache-2.0.

Both are licensed under the Apache License, Version 2.0. The full license text is
reproduced above (see jsQR) and is available at
`http://www.apache.org/licenses/LICENSE-2.0`.
