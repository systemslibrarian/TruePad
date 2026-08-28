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
witness, the tombstone — run inside a dedicated **Web Worker** and its OPFS
directory. The UI thread communicates with the worker only through the narrow
RPC of `src/browser/engine/protocol.ts`. What crosses to the UI is exactly
what the frozen protocol allows to leave the store: wire-public envelopes,
non-secret meters, and — on a successful `open` — the plaintext the operator
asked to see. No pad byte, key, mask, or pad-derived value ever crosses.

Secrets are **never** placed in: `localStorage`, `sessionStorage`, URLs,
query strings, fragment identifiers, the browser history, `console`,
analytics, telemetry, or any error-reporting service. There is no backend, no
account, no cloud storage, and no automatic sync. After first load the crypto
workflow needs no network (§6).

---

## 2. Storage: OPFS, and exactly what "durable" means here

**BROWSER-OP.** The store is the **Origin Private File System** (OPFS),
reached in the worker via `navigator.storage.getDirectory()`. Reads and
writes use **`FileSystemSyncAccessHandle`** (worker-only), whose `write`,
`read`, `truncate`, `getSize`, and **`flush()`** give the strongest
file-like primitives a browser offers. The store keeps the **exact
FORMAT-V2 files** per pair — `head.json`, `secret.bin`, `journal.log`, plus
the `witness` and `destroyed.json` — so a browser store is the same logical
shape as a CLI store (see `docs/INTEROPERABILITY.md`).

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

## 4. Rollback witness — browser classes, named honestly

The CLI's `separate-state-file` witness assumes a file in an **independent
host failure domain**. A browser page has no such reach, so this edition does
**not** offer it and does **not** relabel browser-local state as its
equivalent. Two honest classes:

- **`browser-none`** — no witness. `FORMAT-V2.md` §9.4's backup-restore
  residual stands in full: restoring the OPFS store (via profile backup)
  regresses it, and — without a witness — resets the per-record attempt
  budget. Stated, not hidden.
- **`browser-independent-store`** — the witness counters are kept in a
  **second, separately-cleared OPFS store** (a distinct directory the pair's
  own export/backup does not include). This gives a *partial* failure-domain
  distinction: it catches a restore that rolls back the pair's store while the
  witness store is untouched. Its honest caveat, in the register of §15.2:
  **it is only as independent as the two stores' clearing/backup are
  independent** — both live under the same origin, and "clear site data"
  removes both, so a witness cleared alongside the pair knows nothing. It is
  weaker than the CLI's cross-medium witness, and the UI says so verbatim:

  > Rollback protection: browser-local only. This does not provide the same
  > independent rollback witness guarantee as Operational TruePad.

**PROTOCOL.** Whatever the class, the witness records exactly the three
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
underlying file the way the CLI does. It de-duplicates by the handle the
picker returns and by content-length + a full byte comparison of *declared*
sources, and it **states the limitation** rather than inventing identity
from a pad-derived hash. No pad-derived hash, checksum, or fingerprint is
ever written to metadata (N14).

**PROTOCOL / labelled.** If the edition offers *generated* pad material from
`crypto.getRandomValues()`, it is labelled **"computational random material
from the browser/platform DRBG"**, never information-theoretic entropy — the
combiner is unconditional given the conditions, the source is graded
separately, exactly as the exhibit already teaches. Serious use is external
source files.

---

## 7. Network, PWA, and privacy

**BROWSER-OP.** The Browser Edition is an installable PWA (web app manifest +
service worker) with an offline application shell. **TruePad makes zero
network requests during cryptographic operation.** No analytics, telemetry,
remote logging, crash reporting, ad network, account, cloud pad backup,
automatic source upload, or remote crypto/auth API. Third-party assets are
vendored locally; a strict Content-Security-Policy is set. A CDN outage or a
TruePad-service outage cannot make a local pair unusable, because there is no
such service.

---

## 8. What the Browser Edition does NOT claim

- **NOT** native `fsync`/power-loss durability — that is Linux-ext4 CLI
  territory (`FORMAT-V2.md` §10), not verified here.
- **NOT** an independent external rollback witness — only the browser-local
  classes of §4.
- **NOT** physical erasure on `destroy` (§5).
- **NOT** verification of source physical provenance or uniformity (§6).
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
| three-counter witness, `witness-regressed` | PROTOCOL + BROWSER-OP | recorded in the witness store; browser classes per §4 |
| irreversible `destroyed.json` boundary; restartable destroy | PROTOCOL + BROWSER-OP | tombstone in OPFS; every verb gates on it |
| no downgrade; v1 refused | PROTOCOL | the browser engine has no `--legacy`/`--no-auth`/`--force` and no v1 path |
| power-loss durability | NATIVE-ONLY / UNVERIFIED | not claimed (§2) |
| external independent witness | NATIVE-ONLY | not offered (§4) |
| physical erasure | NATIVE-ONLY / not claimed | §5 |
| physical source provenance / one-file-one-source by identity | OPERATOR / platform caveat | declared, not verified; alias detection limited (§6) |
