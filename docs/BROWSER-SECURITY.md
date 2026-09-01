# TruePad 2 Browser Edition — security & durability claims

This document is the **browser** claims ledger. It is deliberately separate
from the CLI's `docs/FORMAT-V2.md` §10 (Linux-ext4) and the operational
desktop's claims: the Browser Edition runs the **same frozen protocol** but a
**different, weaker, honestly-scoped operational substrate**. Where the
browser cannot provide a guarantee the CLI provides, this document says so
rather than implying equality.

The governing rule is unchanged: *the XOR is already a true one-time pad; the
machinery keeps the theorem's hypotheses true outside the equation, and no
engineering action is promoted into a stronger cryptographic claim than it
deserves.*

Every statement below carries one classification:

- **PROTOCOL** — guaranteed by the frozen Store Format v2 / `wc-one-time-v1`
  construction, identical on every edition (the `src/core` modules are reused
  byte-for-byte).
- **BROWSER-OP** — an operational guarantee this edition enforces using
  browser primitives (OPFS, sync access handles, Web Locks), weaker than and
  distinct from the native equivalent.
- **OPERATOR** — an assumption only the operator can discharge (physical
  source provenance, out-of-band pad delivery, not clearing site data).
- **NATIVE-ONLY / UNVERIFIED** — a guarantee the CLI makes that the browser
  does **not**; stated as absent, never faked.

---

## 1. Architecture: where secrets live

**BROWSER-OP.** The cryptographic engine and the entire store — pad material,
Wegman–Carter keys `K` and masks `R`, the secret body, the journal, the
browser-local witness, the tombstone — run inside a dedicated **Web Worker**
and its OPFS directory. The UI thread communicates with the worker only through
the narrow RPC of `src/browser/engine/protocol.ts`. **Pad material remains
confined to the worker and its OPFS store EXCEPT during an explicit
operator-requested courier export or import.** In ordinary operation what
crosses to the UI is only what the frozen protocol allows to leave the store:
wire-public envelopes, non-secret meters, and — on a successful `open` — the
plaintext the operator asked to see. The one deliberate exception is the
courier step (§7 of `create-pair`): on **export**, the worker packs the pair's
store into one byte container and transfers it out for the operator to save to
a file they choose; on **import**, the operator-selected bytes are transferred
in and unpacked inside the worker. That container **is** the pad — the UI never
base64-encodes or reassembles pad material on its own thread, and the transfer
detaches the buffer it hands over. Outside that explicit step, no pad byte,
key, mask, or pad-derived value crosses.

Secrets are **never** placed in: `localStorage`, `sessionStorage`, URLs,
query strings, fragment identifiers, the browser history, `console`,
analytics, telemetry, or any error-reporting service. There is no backend, no
account, no cloud storage, and no automatic sync. After first load the crypto
workflow needs no network (§6).

### 1.1 In-memory hygiene — best-effort, and named as such

**BROWSER-OP / limited.** Secret-bearing buffers are zeroed once they are no
longer needed, on the success **and** failure paths:

- The UI **transfers** secret-bearing request payloads to the worker
  (`postMessage` transfer list), so the page's `ArrayBuffer` is *detached*
  rather than copied — declared source bytes, the plaintext of a send, and the
  courier container do not linger on the UI thread.
- The worker owns what arrives. It zeroes those request buffers in a `finally`
  **after** the verb has returned or thrown — never before, so nothing is wiped
  while an operation still needs it.
- Inside `gen`, the combined material is zeroed as soon as the partition has
  copied out of it (`partition()` returns copies, never views), and the four
  slices and the two per-direction secret bodies are zeroed in a `finally`
  **after** the awaited provisioning has settled, so a store that failed
  half-way still does not leave the material live in memory.
- `File.arrayBuffer()` hands out a fresh buffer, so **the operator's source
  file on disk is never mutated**.

This is **hygiene, not erasure**. It does **not** prove that a
garbage-collected copy is gone, that the JavaScript engine's internals,
intermediate buffers, or the browser's storage layer forgot the bytes, or that
physical RAM was overwritten — a managed runtime gives no such guarantee, and
TruePad claims none. It also changes no mathematical transformation: the
combiner and partition are untouched by any of it.

---

## 2. Storage: OPFS, and exactly what "durable" means here

**BROWSER-OP.** The store is the **Origin Private File System** (OPFS),
reached in the worker via `navigator.storage.getDirectory()`. Reads and
writes use **`FileSystemSyncAccessHandle`** (worker-only), whose `write`,
`read`, `truncate`, `getSize`, and **`flush()`** give the strongest
file-like primitives a browser offers. The store keeps the **exact
FORMAT-V2 files** per pair — `head.json`, `secret.bin`, `journal.log` — so a
browser store is byte-for-byte the same store a CLI opens (see
`docs/INTEROPERABILITY.md`). Two browser-only files sit *alongside* the frozen
store, never inside it and never in the courier bundle: `pair.json` (a display
label plus which rollback-witness kind applies, §4) and `destroyed.json` (the
§17 tombstone). The rollback witness itself is a **separate** OPFS store
(`witness/<pairId>.log`, §4). `head.json` is replaced with an atomic
temp-and-`move` where the OPFS build supports it, else a durable in-place
rewrite whose torn write every reader refuses closed (`corrupt-head`) — never a
silently-accepted partial.

**What "durable" means in this edition — stated precisely, because it is
weaker than the CLI:**

| question | browser answer |
| --- | --- |
| What persists across a page reload / browser restart? | Everything written to OPFS and `flush()`ed. OPFS survives normal reloads and browser restarts. |
| What does `flush()` mean? | The bytes were handed to the browser's storage layer. It is the browser's analogue of the CLI's `fsync` — **not** a proof of media write, and **weaker**: browsers do not document power-loss semantics for OPFS. |
| Tab / worker crash after `flush()`? | **BROWSER-OP.** Survived — the flushed bytes are in OPFS. The commit-before-emit ordering (§3) makes a crash lose material, never reuse it. |
| Power loss mid-write? | **NATIVE-ONLY / UNVERIFIED.** Not claimed. The CLI does not claim it outside Linux ext4 either; the browser claims it nowhere. |
| "Clear site data" / clear browsing data? | **OPERATOR.** Destroys the OPFS store — all pads for this origin are gone. This is the operator's responsibility to understand; it is deletion, not a protocol event. |
| Browser profile backup / sync? | **OPERATOR / caveat.** If the browser profile (including OPFS) is backed up and later restored, the store regresses exactly like the CLI's whole-directory restore (`FORMAT-V2.md` §9.4). The rollback residual applies (§4). |
| Private / Incognito window? | **OPERATOR.** OPFS is typically ephemeral there — the store vanishes when the private session ends. The UI warns when it detects a non-persistent context. |
| Two browser profiles / two devices? | **OPERATOR.** Each is an independent copy of whatever was couriered there — the same two-copy discipline as the CLI's courier model. TruePad never syncs them. |

**PROTOCOL.** Retirement is logical: advancing the durable counters is what
retires material; `secret.bin` is written once at generation and thereafter
only zero-overwritten at destruction (§5). Content never decides liveness.

---

## 3. Single-writer & commit ordering

**BROWSER-OP.** Exactly one mutator per pair at a time is enforced with the
**Web Locks API** (`navigator.locks.request`), the browser twin of the CLI's
`O_EXCL` lock (`FORMAT-V2.md` §10.3). It is real mutual exclusion in the
worker, **not** a UI `isBusy` flag. Its scope is this origin in this browser;
two *different* browsers or profiles are two hosts (out of scope, §2).

**PROTOCOL.** The frozen §12 transaction order is preserved unchanged:

- **SEND (burn):** stage in memory → durably commit `head.json` then
  `journal.log` → advance the witness → **only then** emit the envelope. A
  crash before emit loses the record's material, never reuses it.
- **OPEN:** structural/window/state checks (free) → durable attempt
  reservation → advance the witness with the new `attemptsReserved` (before
  verification) → verify → on fail, persist the failure, burn nothing → on
  pass, retire both namespaces durably and advance the witness → **only
  then** release plaintext.

The failure direction is the frozen one: **loss is acceptable; reuse is
not.**

---

## 4. Rollback witness — a browser-local layer, named honestly and crash-safe

The rollback witness is a **browser-product layer, not a fork of the frozen
store.** A browser store's `head.json` always serialises the CLI's
`rollback:{ witnessClass:"none", config:{} }` — byte-identical to a CLI store,
so the courier bundle carries no browser-only header vocabulary (§2). Whether a
pair *also* carries a browser-local witness is recorded in the browser-only
`pair.json`, outside the frozen bytes. That `pair.json` field is load-bearing:
a present-but-corrupt `pair.json` fails **closed** (`corrupt-pair-meta`) rather
than silently assume no witness. Two honest kinds:

- **`browser-none`** — no witness. `FORMAT-V2.md` §9.4's backup-restore
  residual stands in full: restoring the OPFS store (via profile backup)
  regresses it, and — without a witness — resets the per-record attempt
  budget. Stated, not hidden. A bare FORMAT-V2 store placed directly (e.g. a
  CLI store) that the browser never provisioned is `browser-none`.
- **`browser-local-witness`** — the three counters are kept in a **second,
  separately-cleared OPFS store** (`witness/<pairId>.log`, a distinct directory
  the pair's own export/backup does not include). Named honestly: it is
  browser-**LOCAL**, *not* an independent host failure domain, and does not
  imply the CLI's `separate-state-file` reach. It gives a *partial*
  failure-domain distinction — it catches a restore that rolls back the pair's
  store while the witness store is untouched — with the §15.2 caveat: **it is
  only as independent as the two stores' clearing/backup are independent.**
  Both live under the same origin, and "clear site data" removes both. The UI
  says so verbatim:

  > Rollback protection: browser-local only. This does not provide the same
  > independent rollback witness guarantee as Operational TruePad.

**BROWSER-OP — crash safety.** The witness is an **append-only journal**, never
truncated, with each record **leading-newline framed** (`\n<json>`). `appendFile`
gives no record boundary, so a crash mid-append can leave a partial at the end
of the file — but leading framing bounds every record by its own `\n` and the
next record's `\n`, so a torn partial is always an **isolated** line, never fused
with the record before or after it. The read **drops any line that does not
parse** and folds the surviving records into the per-direction max. So only a
**torn** advance loses its own value; every advance whose append **completed** is
preserved. And because a torn advance's operation **errors and withholds its
output** — a burn emits its envelope, an open releases its plaintext, only
*after* a successful advance — **the witness never under-reports below a state
whose output was released**: a rollback below any released-output high-water is
still caught `witness-regressed`, and the very next clean advance re-records the
current high-water. Because a provisioned journal is never emptied by an advance,
**an established witness never reads as fresh**: a pair whose `pair.json` says
`browser-local-witness` but whose journal is missing, empty, all-corrupt, or
missing a direction fails **closed** as `witness-inconsistent`. Provisioning is
an explicit event at generation or a successful import — never inferred from an
unexpectedly empty file — so the old truncate-then-crash hole (an advanced
witness silently becoming "fresh") is closed.

The one honestly-stated residual concerns an **unused reservation**, not an extra
verification. In `open` the durable order is: the O3 attempt reservation, then
`await witness.advance(...)`, and **only after that advance succeeds** does O4
read the auth record and evaluate the tag. So a torn/failed pre-verification
witness advance **aborts the operation before any tag verification is
performed** — no verification query is issued on that crash path. A subsequent
backup-restore may recover that single reserved-but-**unused** attempt, but
because no verification occurred, **the finite per-sequence verification-query
bound (`verifyAttemptLimit`) is not increased by this crash path.** The
forgery probability per verification query remains exactly the Wegman–Carter
per-attempt bound defined in `FORMAT-V2.md` (§5 / N7: `ε = 65540·2⁻¹²⁸` at
`maxCiphertextBytes = 1048576`, and at most `verifyAttemptLimit·ε` per record) —
this crash path adds no query to which that bound applies. It is the same
**browser-local** limitation as above (a witness in the same origin as the store
it guards). No released ciphertext's keystream, and no released plaintext, is
ever reusable this way.

**PROTOCOL.** Whatever the kind, the witness records exactly the three
frozen monotone counters — `encryptionNextOffset`,
`authenticationNextSequence`, `attemptsReserved` — and refuses a regressed
store `witness-regressed` before anything is consumed. It holds counters and
nothing else (N17).

---

## 5. Destruction — the same irreversible boundary

**PROTOCOL + BROWSER-OP.** `destroy` writes the durable tombstone
`destroyed.json`; from then on the pair has crossed the §17.3 boundary and
every operation refuses it `pair-destroyed` before any secret is read.
Destruction is restartable/idempotent, the tombstone is preserved on resume,
and no path returns a tombstoned pair to active use. The engine best-effort
zero-overwrites `secret.bin` and removes the store files.

**NATIVE-ONLY / not claimed.** The browser makes the same modest claim as the
CLI, verbatim:

> Software can forget its reference to pad material; it cannot prove that
> flash forgot the bytes.

OPFS gives no control over the underlying medium — copy-on-write filesystems,
SSD wear leveling, and the OS page cache may all preserve pre-overwrite
blocks. The zero-overwrite is best-effort hygiene, **never** erasure, and the
UI shows this sentence during destruction.

---

## 6. Generation, sources, and randomness

**PROTOCOL.** Generation is the frozen path: user-supplied source files,
exact bytewise XOR, the §7 four-slice partition, the exact
`L = 2·(E + 32·N)` required length, no KDF/extractor/conditioner. The verdict
is verbatim: *"Uniform if at least one declared source was uniform and
independent of the others."*

**OPERATOR / platform caveat.** One file is one source. The browser File API
exposes **no reliable filesystem identity** (no inode), so the edition
**cannot** detect that two selected files are hardlink/alias copies of one
underlying file the way the CLI does — and it **states that limitation** rather
than inventing identity from a pad-derived hash. Crucially, the combiner does
**no content-dependent deduplication and never inspects the combined bytes by
value**: it does not reject a source because its bytes equal another's, and it
does not reject an all-zero combined result. If at least one declared source is
uniform and independent of the others, the XOR is exactly uniform over the
**full** space, and every combined value — all-zeros included — is a legitimate
draw; refusing any specific value would condition the accepted distribution
(the same mistake as the retired all-zero tripwire). Refusing a literal
same-object re-selection is a UI concern (the picker may compare handles); the
engine sees only bytes and never judges source content. No pad-derived hash,
checksum, or fingerprint is ever written to metadata (N14).

**PROTOCOL / labelled.** If the edition offers *generated* pad material from
`crypto.getRandomValues()`, it is labelled **"computational random material
from the browser/platform DRBG"**, never information-theoretic entropy — the
combiner is unconditional given the conditions, the source is graded
separately, exactly as the exhibit already teaches. Serious use is external
source files.

### 6.1 The two source classes

The **combiner** is identical on both paths and is exact (above). The **source
claim** is not, and the UI keeps them apart in the words it uses.

**Device-generated — PLATFORM-OP (source).** `crypto.getRandomValues()`, the
platform's cryptographic random generator. This is the default, and the whole
of what a normal operator reads is *"TruePad uses your device's cryptographic
random generator."* Under Security the exact statement is:

> Generated by your device's cryptographic random generator
> (`crypto.getRandomValues`) — a cryptographically secure platform generator,
> or CSPRNG. Its security rests on computational and platform assumptions.
> TruePad does not call this physically proven randomness, and does not
> promote it to an unconditional information-theoretic source claim.

It is **never** described as "truly random", "verified true randomness",
"physical randomness", or "information-theoretically verified".

**External ceremony — OPERATOR (source).** Operator-supplied material, exposed
under *Advanced options → Randomness → Use external random material*. The
disclosure states the combiner exactly, then the load-bearing sentence:

> **TruePad cannot determine whether a file is truly random.**

and the secrecy condition, stated at its true strength: **secrecy is a separate
requirement from uniformity**, and material an adversary can obtain **may still
be XORed in** — the combiner has no content-dependent rejection and is no weaker
for it — it simply cannot be the source that *carries* the guarantee. At least
one combined source must also be secret from the adversary. That permission
holds only under **independence**, so the ceremony also says never to combine
material an adversary supplied, chose, or could have influenced: a source chosen
against yours can cancel it. Alongside it sits the plain-language gloss for
key-message independence — *"Never derive source material from the messages you
plan to send."* Creation additionally requires an explicit **operator
declaration**:

> I understand that TruePad cannot verify physical randomness. For an
> information-theoretic one-time-pad secrecy claim about this pad's material, at
> least one selected source must actually be uniformly random, secret from the
> adversary, and never previously used. That source must also be independent of
> all the other selected sources taken together, and of the messages this pad
> will protect. It must never be used to make another pad.

That is a **declaration, not a verification result**. Words like *verified*,
*certified*, *passed*, *confirmed* and *proven* do not appear on this path, and
**nothing about the declaration is persisted**: there is no `trueRandom`,
`informationTheoretic` or `verifiedRandom` field in Store Format v2, and none
may be added. The only record is the existing `sourceDeclarations[]` — name,
the operator's own origin note, and length. The created pad's statement stays
conditional: the verbatim verdict, then *"TruePad did not verify that
assumption."*, then *"If that source assumption is true, the pad material
satisfies the information-theoretic randomness requirement of a one-time pad."*
Never *"perfect secrecy achieved"*, *"true OTP verified"*, or
*"information-theoretic security confirmed"*.

**Uniformity is not secrecy**, and the panel says so immediately after:

*"The verdict above is about uniformity only. An information-theoretic secrecy
claim would also require that the source material you supplied was, and stays,
secret from the adversary; that it was independent of the messages this pad will
protect, in either direction; that no other pad is ever derived from it; and
that this pad material is used exactly once. TruePad's counters enforce that
last condition within TruePad — a copy of the pad file made outside it is beyond
them. TruePad established none of the rest; that is what you declared."*

The frozen verdict speaks to the uniformity hypothesis only — an XOR's
uniformity genuinely does not require secrecy or independence from the
plaintext. That asymmetry is correct, and the two statements must never be
fused: propagating secrecy or key-message independence *into* the verdict would
make it claim something the combiner does not establish, and dropping them from
the ceremony would let uniformity read as secrecy.

**Same-object re-selection.** The UI refuses to add the **same `File` object**
twice in one session. That is an object-reference comparison and nothing more:
it reads no bytes, and two separate picks of one underlying file remain
indistinguishable, which the ceremony copy says outright. Source **content**
never conditions acceptance, here or in the engine.

### 6.2 Delivery is the other half of the ceremony

**OPERATOR.** A source claim is not an end-to-end claim. On both paths the
essential warning is the same — the pad file is the secret; possession allows
reading *and* forging; ciphertext may travel publicly, pad material may not.
For the external ceremony the edition adds the expert half:

> For an end-to-end information-theoretic secrecy claim, the pad file must also
> be delivered through a secret method whose confidentiality does not itself
> depend on computational encryption assumptions. Physical handoff on removable
> media is the clearest ceremony.

Email, Dropbox, Google Drive, OneDrive, ordinary cloud storage and encrypted
messengers **do not preserve that claim**. They may be computationally secure
ways to move a file — a *different* guarantee, not a weaker form of this one.

### 6.3 Sending a pad online — a computational delivery route

The Browser Edition also offers **Sealed Pad Transfer**: the pad is sealed for one
receive code and the resulting `.tps2` file travels through an ordinary channel —
chat, email, cloud storage. TruePad makes the file; the operator chooses the
channel. Nothing is uploaded and no recipient is stored.

What that route claims, and what it does not:

* **The messages are unchanged.** After the pad is added, ordinary TruePad
  messages use the same one-time pad and the same `wc-one-time-v1` tags. Sealed
  transfer delivers the existing pad; it is not a second cryptosystem.
* **The delivery is computational.** Sealing uses X-Wing suite `0x0001`
  (draft-connolly-cfrg-xwing-kem-10 — ML-KEM-768 with X25519), HKDF-SHA-256 and
  AES-256-GCM. ML-KEM is standardised; **X-Wing is a draft**, not a NIST, RFC or
  IETF standard. A pad delivered this way therefore carries a computational
  end-to-end claim, not the conditional information-theoretic one §6.2 describes.
* **Two word ceremonies, both OPERATOR declarations.** Twelve words (132 bits)
  bind the receive code before the pad is sealed; eight (88 bits) bind the
  package afterwards. The recipient reads his eight first, and the sender's are
  not rendered until she says she heard them — the engine returns her indices
  when she seals and cannot know who actually spoke first. This is support for an
  honest operator's ceremony, never a verification result.
* **Endpoint compromise is out of scope.** A page holding worker-RPC authority
  can call these operations itself. No ordering in the engine changes that; it is
  the §15 boundary, not an attacker the ceremonies stop.
* **Harvest-now, decrypt-later.** An archived `.tps2` is computationally
  protected transport ciphertext. It could become readable if this device's
  storage is later restored from a backup — the recipient's one-time key state
  coming back with it — or if the delivery cryptography is broken in future.
  Deleting a local copy does not delete anyone else's.
* **One delivery method per pad.** A pad given out as a file cannot also be sent
  online, and vice versa; the engine refuses, and an imported pad can never be
  passed on again.

`docs/SEALED-PAD-TRANSFER.md` is normative for all of the above;
`docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md` records how it was verified.

### 6.4 The source claim is independent of the platform claim

Choosing the external ceremony gives this edition **none** of §8's absent
guarantees: no power-loss durability, no independent external rollback
witness, no physical erasure, no survival across "clear site data". The device
generator takes none of them away either. Likewise a genuinely physical source
does not strengthen the Wegman–Carter authentication bound or the operational
reuse-prevention machinery (counters, journal, attempt reservation, witness,
locks, retirement, tombstone) — and neither of those proves anything about the
source's physics. Three separate guarantees; never quote one for another.

---

## 7. Network, PWA, and privacy

**BROWSER-OP.** The Browser Edition ships a web app manifest and a service
worker that precaches the application shell. **The app page does not currently
register that service worker** — only the teaching Lab entry point does, so the
offline shell and installability arrive for a visitor who has opened the Lab and
not for one who has only ever opened the app. This is a functionality gap, not a
security one: the service worker precaches eighteen static build artifacts and
registers a navigation route, and has no code path that could cache a `.pad`, a
`.tps2`, or worker RPC traffic — which is `postMessage`, not network.
**TruePad makes zero network requests during cryptographic operation.** No analytics, telemetry,
remote logging, crash reporting, ad network, account, cloud pad backup,
automatic source upload, or remote crypto/auth API. There are no third-party
assets — the page references no external origins.

**A Content-Security-Policy ships in the document itself** (`<meta
http-equiv>` in `index.html` and `learn.html`), because the default deploy
target is GitHub Pages, which serves no custom response headers — so the meta
CSP is the enforcement point for the directives a **meta** CSP can enforce. Its
scope, stated exactly: `default-src 'self'`, `script-src 'self'`, `connect-src
'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
`frame-src 'none'`. `blob:` is permitted for the module worker and the
operator's courier/plaintext downloads; `data:` for inline icons;
`'unsafe-inline'` is scoped to **style only** (Vite inlines critical CSS),
never to script.

**What this CSP is, and what it is not.** It **restricts script, style,
connection, object and frame loading to this origin** — defense in depth that
narrows what a future edit or an injected script could reach. It is **not**
itself a proof that data can never leave the browser, and this ledger does not
claim that. Two precise limits:

- **`frame-src 'none'`** stops **this** page from *loading* child frames. It is
  **NOT** the same as **`frame-ancestors`**, which controls who may *embed*
  this page. `frame-ancestors` (and `X-Frame-Options`) are **ignored in a meta
  CSP** and can only be set as an **HTTP response header** by a hosting layer —
  which the default GitHub Pages deployment cannot do. So the earlier ledger's
  `frame-ancestors 'none'` was removed from the meta CSP rather than left as a
  directive that was silently not enforced.
- Anti-embedding is instead enforced at **runtime**: `src/browser/main.ts`
  refuses to start the worker or render the operational UI if the page is not
  the top-level document (`window.self !== window.top`, and a cross-origin
  parent that throws on the check is treated as framed). A deployment that can
  set response headers **should still** add `frame-ancestors 'none'` /
  `X-Frame-Options: DENY` as belt-and-braces — an **OPERATOR** step. A stricter
  script-nonce/hash policy or a full HTTP-header CSP is likewise an OPERATOR
  step; the default GitHub Pages deployment provides exactly the meta CSP above
  plus the runtime gate, and this ledger claims no more.

A CDN outage or a TruePad-service outage cannot make a local pair unusable,
because there is no such service.

**The camera, when QR scanning is used.** The Sealed-Pad-Transfer sender may
scan a receive code instead of pasting it. The camera is a **borrowed
capability**: `getUserMedia` is called **only after the operator clicks "Scan QR
code"** — never on page load, never merely because scanning exists — with
`facingMode: environment` preferred, and it is **released on the first of** a
successful decode, Cancel, an error, or leaving the screen (`src/browser/ui/qr/`
stops every `MediaStreamTrack` on each of those paths, proven by
`tests/qr-camera.test.ts` against the real controller). **No frame is recorded,
saved, uploaded, or logged.** A camera stream is not a network path, and the QR
libraries make no request; the decoded output is only candidate **text**, which
goes to the **same** worker receive-code parser that pasted text does — a scan
authenticates nothing, and the twelve-word comparison still follows. A QR
carries only the **public** TPR2 receive code: the encoder refuses anything the
receive-code codec would reject, so no pad byte, key, sealed package, or
confirmation word can be turned into a symbol. **No CSP change was needed** —
`img-src 'self' data:` already covers a rendered symbol, `connect-src 'self'` is
untouched, and the decoder is a bundled pure-JS library (no `eval`, no
WebAssembly, no fetch; loaded on demand and precached), so nothing here reaches
the network.

---

## 8. What the Browser Edition does NOT claim

- **NOT** native `fsync`/power-loss durability — that is Linux-ext4 CLI
  territory (`FORMAT-V2.md` §10), not verified here.
- **NOT** an independent external rollback witness — only the browser-local
  kinds of §4.
- **NOT** physical erasure on `destroy` (§5).
- **NOT** verification of source physical provenance or uniformity (§6) — on
  **either** source path. The operator declaration required by the external
  ceremony (§6.1) is a declaration, not a measurement, and TruePad never calls
  device-generated material physically proven randomness.
- **NOT** erasure of secret bytes from process memory. Buffers are zeroed
  best-effort on success and failure paths (§1.1), which does not prove a
  garbage-collected copy, a runtime-internal buffer, or physical RAM was
  cleared.
- **NOT** protection against "clear site data", profile restore, or an
  Incognito context evaporating the store (§2) — these are stated operator
  responsibilities.

Every one of these is surfaced in the in-app **Security Status** screen and
the cross-edition claims matrix (`docs/PRODUCT-CLAIMS.md`), so the operator
sees the browser's scope, not a borrowed one.

---

## 9. Invariant map (frozen protocol → browser substrate)

| frozen invariant | class | how the browser honors it |
| --- | --- | --- |
| Store Format v2 files, canonical bytes, POLYVAL, `wc-one-time-v1`, four-slice partition, fixed-record frame, strict envelope grammar | PROTOCOL | `src/core` reused byte-for-byte; the §11 vectors and adversarial fixtures pass in the browser build |
| commit-before-emit; loss not reuse | BROWSER-OP | OPFS `flush()` + the §12 order preserved in the worker verbs |
| one mutator per pair | BROWSER-OP | Web Locks (not a UI flag) |
| three-counter witness, `witness-regressed` | PROTOCOL + BROWSER-OP | recorded in a crash-safe append-only witness store, keyed by pair.json; browser-local kind per §4; established witness fails closed, never fresh |
| irreversible `destroyed.json` boundary; restartable destroy | PROTOCOL + BROWSER-OP | tombstone in OPFS; every verb gates on it |
| no downgrade; v1 refused | PROTOCOL | the browser engine has no `--legacy`/`--no-auth`/`--force` and no v1 path |
| power-loss durability | NATIVE-ONLY / UNVERIFIED | not claimed (§2) |
| external independent witness | NATIVE-ONLY | not offered (§4) |
| physical erasure | NATIVE-ONLY / not claimed | §5 |
| erasure of secrets from process memory | not claimed | best-effort zeroing of transferred request buffers and gen's intermediates, success and failure paths (§1.1) |
| physical source provenance / one-file-one-source by identity | OPERATOR / platform caveat | declared, not verified; alias detection limited to same-`File`-object re-selection, never a content comparison (§6, §6.1) |
