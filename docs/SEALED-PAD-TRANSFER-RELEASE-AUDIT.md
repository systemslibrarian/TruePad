# Sealed Pad Transfer — Release Audit

**Audited commit:** `40827e0c8d388a57856fcae2e75ea7d629970f70` (branch `master`, clean tree)
**Audit date:** 2026-08-31
**Verdict:** **B — RELEASE READY WITH DOCUMENTED NON-BLOCKING LIMITATIONS**

This is an audit record, not a specification. `docs/SEALED-PAD-TRANSFER.md` remains
normative; where this document and that one disagree, the spec wins.

The audit treated every prior phase report as a hypothesis and verified against the
source tree and a freshly built `dist/`. Ten static auditors, a behavioural suite
driven through a real Chromium against the built bundle, and five falsification
rounds. Findings below are only those that were reproduced.

---

## What is being claimed

**Physical / secret pad handoff.** The raw pad travels through a private ceremony.
If the frozen OTP assumptions hold — pad quality, secrecy, non-reuse, and the
authentication premises — this is the path relevant to the conditional
information-theoretic message-secrecy claim.

**Sealed online delivery.** PQ/T computational cryptography delivers the pad:
X-Wing suite `0x0001` (ML-KEM-768 with X25519, draft-connolly-cfrg-xwing-kem-10),
HKDF-SHA-256, AES-256-GCM. After import, ordinary messages use the *same* OTP and
Wegman–Carter system. Online delivery therefore introduces computational
assumptions and does **not** preserve an end-to-end information-theoretic delivery
claim.

Both ways of giving a pad are offered side by side; neither is presented as better.

---

## Invariants confirmed

| Invariant | How it was confirmed |
| --- | --- |
| Four security authorities stay distinct | OPFS inventory after a full ceremony shows `spt/confirmed/`, `spt/claims/`, `<pairId>/handoff.json`, `spt/receive/<id>/` as separate objects. No mutable `state.json`, no `complete.json`. |
| Nine SPT RPCs, no more | `protocol.ts` exposes 19 ops total; the SPT subset is exactly the nine. No storage-helper, debug, or read-secret RPC in source or in the shipped worker. |
| Commit cannot be steered by the page | `spt-commit-receive` carries `sessionId` and nothing else; pad bytes, pairId, requestHash, packageIdentity and dk all come from worker-held session state. |
| No secret crosses to the page | No SPT response carries dk, shared secret, PRK, AEAD key, or a decrypted container. |
| KEM stays in the worker | ~40 independent markers; the main bundle's only crypto vocabulary is one disclosure string. Deliberately importing `encapsulate` into a UI module grew main by 45,592 B and failed the guard. |
| Receiver-first masking | Before the sender confirms she heard the recipient's words, they are absent from `innerText`, `innerHTML`, every attribute, `title`, `aria-*`, `data-*`, hidden elements, `::before`/`::after`, `localStorage`, `sessionStorage`, URL/hash and the console. |
| No plaintext before commit | After `spt-open-sealed` and before commit, the receiver's OPFS gains **zero** new paths. |
| Consume before import | Fault injection: a torn `consumed.json` yields terminal/LOSS with the importer never called. |
| One pad, one handoff | Cross-mode refusals both directions; a second receive code is refused with no second package. |
| Exact re-share | The same code returns a byte-identical package; two saves are byte-identical; the saved file equals the Blob the page built. |
| Session exclusion | Second tab refused immediately, never queued; a reload releases the lease naturally. |
| Terminal precedence | Cancelled/consumed markers beat a surviving `dk.bin`; corrupt markers are terminal, never PENDING. |

---

## Boundaries — what this release does **not** claim

**Browser profile rollback.** All Browser state is one rollback domain. A
whole-profile restore or clone rewinds pair counters, witness, handoff markers,
request claims, receiver state and confirmed state *together*. There is no external
independent witness in the Browser Edition.

**OPFS fallback is not atomic.** `OpfsVfs.writeFileAtomic`'s fallback may truncate,
write and flush. Safety rests on marker existence, terminal precedence, readback and
fail-closed classification — never on the fiction that replacement is atomic.

**Receiver-first is a human assumption.** The engine returns the sender's eight
indices when she seals and cannot know who spoke first. The UI masks them; that is
support for an honest operator's ceremony, not enforcement.

**X-Wing is a draft.** Suite `0x0001` follows
draft-connolly-cfrg-xwing-kem-10. ML-KEM-768 is standardised; X-Wing is not. It is
not a NIST, RFC or IETF standard.

**Noble low-order divergence.** `@noble/post-quantum` 0.7.1 aborts when X25519
yields all-zero — a policy RFC 7748 §6.1 permits and which it inherits rather than
TruePad adding — where draft-10 specifies no abort. Accepted; wire bytes unchanged.
Through the product both this and an AEAD tag failure surface as one public reason.
No timing claim is made.

**Harvest-now, decrypt-later.** An archived `.tps2` is computationally protected
transport ciphertext. If its delivery cryptography is broken in future, archived
copies could expose the pad. The pad's own messages remain OTP; deleting a local
copy does not delete anyone else's.

**Erasure.** Best-effort wipes are hygiene. Blobs, object URLs, the OS download
folder, recents and any sync the environment performs are outside TruePad's reach.
A saved raw `.pad` may appear in a downloads folder or a backup.

**Web Locks required.** With no `navigator.locks`, `WebLocksProvider` returns no
lease and sealed receive refuses. There is no weak mutex fallback. The refusal the
operator sees is the busy-session wording.

**QR deferred; CLI out of scope.** Copy/paste is the normative channel. No CLI
sealed-transfer verb exists.

---

## Defects found and repaired

All repairs are tests, docs, CI configuration or UI hygiene. No cryptographic
behaviour, wire format, storage format or RPC semantics changed.

1. **The bundle-boundary guard was a no-op in CI** (major). The assertion that keeps
   ML-KEM out of the UI thread reads `dist/` and returned early when absent — and
   `deploy.yml` ran `npm test` *before* `npm run build`, so on every CI run it
   asserted nothing. A KEM leak would have shipped green. Repaired: the guard now
   throws under `CI` when `dist/` is missing, and the workflow builds first.
2. **The vendored wordlist carried no licence notice** (major). The spec requires
   preserving attribution; only a citation existed. The MIT notice is now reproduced
   in `PROVENANCE.md`, the settled-MIT phrasing is qualified, and the test that
   "verified" it — a bare `/\bMIT\b/` — now requires the notice itself.
3. **The commit-argument guard blacklisted names.** `padBytes` slipped past a list
   naming `padFileBytes`. The guard now pins the exact shape.
4. **The commit-time rebinding check had no test.** Deleting the equality between
   the session's requestHash and the durable one passed the entire suite. A
   substitution test now swaps in a valid request for the same requestId with a
   different key; it fails when the check is removed.
5. **The raw `.pad` wipe zeroed the wrong buffer.** `triggerDownload` copied, then
   zeroed its copy after `Blob` had already snapshotted it, leaving the worker's
   container live. Both buffers are wiped now.
6. **No test pinned the CSP**, the only enforcement point on GitHub Pages. Added.
7. **No guard stopped the sealed package becoming clipboard text.** Added.
8. **Undeclared `@noble/hashes`** imported by a test; now a declared devDependency.
9. **`vite-plugin-pwa` floated (`^1.3.0`)** while shipping ~22 KB of Workbox to every
   user. Pinned exactly.
10. **The unique-four-character-prefix property** the spec requires was untested. Added.
11. **The `style-src 'unsafe-inline'` rationale was wrong** — this build emits no
    inline `<style>`. Corrected to describe it as headroom.

### The claims the product had outgrown

Phase 1D updated the sealed-transfer specification and stopped. Six other
documents and one shipped screen still described the version of TruePad that
existed before it. Together these were the most serious finding of the audit: a
feature can be correct and still be misrepresented, and a claims document that is
wrong is worse than one that is missing.

12. **`docs/PRODUCT-CLAIMS.md` said the feature was not offered** (blocker before
    repair). The cross-edition ledger stated as present fact that "no product
    screen offers it and no operator can reach it" while *Send securely online*
    sat on the created-pad screen. Rewritten as SHIPPED (Browser Edition only),
    with QR and the CLI named as what is still absent. The guard that policed this
    section now pins the retraction, not just the new wording — a claims document
    that is only ever added to is how a false statement survives being noticed.
13. **The in-app Security & limitations screen had no entry for sealed delivery.**
    The operator-facing ledger listed only the physical ceremony, so a reader
    concluded no computational delivery route existed in the product they were
    holding. Added an entry and two matrix rows, importing the wording from the
    transfer screens so the two cannot drift.
14. **`docs/BROWSER-SECURITY.md` did not mention sealed transfer at all** — zero
    matches across 471 lines, in the document `PRODUCT-CLAIMS.md` names as the
    source of the Browser column. Added §6.3.
15. **The spec contradicted its own header.** §16.5 still described the two-choice
    UX as future work and reported "no reachable flow", 2350 lines after the
    header declared the UI shipped.
16. **The README's quantum section denied any ML-KEM involvement.** True of the
    message cipher, no longer true of the product: the sealed delivery path uses
    ML-KEM-768. The section now says so and points at the delivery distinction.
17. **The shipped HNDL warning named only future cryptanalysis.** The spec calls
    the restored-or-cloned recipient key state "the real risk", and omitting it
    let the danger read as decades away and hypothetical. Restoring a backup is
    neither. Both clauses now ship, and the guard pins both.
18. **`BROWSER-OP` claimed an installable PWA with an offline shell.** The app
    page never registers the service worker — only the teaching Lab entry does.
    The claim now states the gap. No security consequence: the service worker
    precaches eighteen static artifacts and cannot see blob downloads, OPFS, or
    worker RPC.

## Findings accepted without change

- **The app page never registers the service worker.** `registerSW` is called only
  from the teaching Lab entry, though the manifest declares an installable app. The
  service worker precaches exactly 18 static build artifacts and registers only a
  navigation route: it cannot see blob downloads, OPFS, or worker RPC, so no secret
  can enter its cache. Adding registration is a feature decision, not an audit repair.
- **`props.html` in `dom.ts`** is a live `innerHTML` sink with zero callers.
  Pre-existing, unreachable, and removing it is a refactor rather than a repair.
- **`worker-src 'self' blob:`** is broader than this build needs. Tightening CSP
  without a demonstrated need is the kind of change an audit should propose, not make.

## Observation decisions

**A — the 26 px *Cancel this receive code* target: ACCEPT.** It is a link-style
destructive control, 168 × 26 px, reachable by keyboard, correctly named, and in
normal document flow with no overlap. The app already ships link-style controls in
that class (header, footer and back links measure 29–38 px), so it is consistent
with the product's own convention rather than an outlier, and every *primary* action
is ≥ 44 px. A destructive control that is slightly harder to hit by accident is not
a defect.

**B — cold entry on an already-sealed pad: DEFER.** Re-entering *Send securely
online* shows the paste card again, so an operator can compare twelve words before
the engine reveals the pad was already sent. Audited for impact: the engine refuses
correctly (`This pad was already sent online`), no second package exists, no claim
moves, and nothing is lost — the same code still returns the identical committed
package. It is operator friction, not a security or correctness problem. Answering
earlier would need a tenth read-only RPC; "no new tenth RPC" stands. The behaviour
is documented in `send-online.ts`, and a spec-conformance test pins both branches.

---

## Gate at the audited commit

Node v26.5.0, npm 11.17.0, darwin arm64. Clean `npm ci`.

- `npm test` — **1342 passed**, 49 files (claim guards 180 → 189)
- `npm run test:e2e` — **33 passed**, Chromium
- `npm run build` — clean
- main `109,835 B` · worker `151,761 B` · CSS `30,583 B` + `9,841 B`
- Production dependency closure: 4 packages, all MIT, all exact-pinned
- CSP violations through a full two-browser ceremony: **0**. Console errors: **0**
- Falsification: 5 rounds, 23 injections, 23 caught; tree verified clean after each
- Static audit: 40 agents; every reported defect independently re-verified, 21 refuted, 9 upheld

## Why B and not A

Before repair this was **C**: `docs/PRODUCT-CLAIMS.md` — the authoritative
cross-edition ledger — denied that a shipped, reachable feature existed, which
materially falsifies a public claim. That is repaired, along with every other
claim the product had outgrown, and no unresolved issue can violate a frozen
invariant. Every repaired defect that can carry a regression test has one that
fails without the fix. But the limitations above are real and
operator-visible: profile rollback, non-atomic OPFS fallback, receiver-first as a
human assumption, HNDL exposure of archived sealed files, and the impossibility of
proving erasure. They are documented rather than solved, which is what B describes.
A would require claiming there is nothing left to disclose.
