# TruePad v2 ceremony — generation, distribution, retirement (Phase 3)

**Status.** This is the operator-facing ceremony for TruePad Store Format
v2 pairs. `docs/FORMAT-V2.md` is the binding format specification; this
document is the procedure the format expects around it — §12.4's closing
paragraph places the workspace rules here on purpose, §8.5 places operator
recovery here, and §14.2 L3 names what this phase may claim. The code half
is `truepad2 ceremony create` and `truepad2 ceremony verify`
(`src/cli/v2/ceremony.ts`); everything code cannot enforce is listed in §6
below rather than implied away. Nothing in this document is a
recommendation to use one-time pads for real traffic.

**The split, stated once.** A ceremony is the set of hypotheses the
mathematics needs that no program can check. Every step below is marked
either **enforced** — the tool refuses if it does not hold — or
**asserted** — a statement the operator makes, which the tool requires,
records, and prints, saying plainly that it cannot verify it. An assertion
flag is not a checkbox to satisfy the tool; it is a sentence the operator
signs in the pad book.

---

## 1. The generation ceremony

Run once per pair, on a machine that will hold no copy afterwards.

1. **Stage the machine offline.** Every network interface down, and down
   until the workspace is gone. *Asserted:* `--assert-offline`.
2. **Mount a memory-backed workspace** (tmpfs), so no pad byte is written
   to the machine's persistent storage. *Asserted:*
   `--assert-tmpfs-workspace`.
3. **Bring at least two source devices of distinct physics** — different
   physical processes, not two readouts of one device — and read at least
   `L = 2·(E + 32·N)` bytes from each into the workspace (FORMAT-V2.md
   §7). *Enforced:* at least two `--source` files, one file is one source,
   and every source supplies the full `L` bytes (`source-too-short`)
   — surplus is reported unused, never silently spent. *Asserted:* that
   the devices' physics are distinct (`--assert-distinct-physics`), and
   that any source is uniform at all (`--origin` records the claim; §7's
   verdict is conditional on it).
4. **Prepare two blank peer media**, one per peer. *Enforced:* a medium
   that already holds a pad store is refused (`ceremony-incomplete`,
   exit 2); nothing is written.
5. **Run the ceremony:**

   ```sh
   node bin/truepad2.mjs ceremony create <workspace> \
     --medium-a /media/peer-a --medium-b /media/peer-b \
     --source qrng.bin --source diode.bin \
     --origin "vendor QRNG, operator-asserted" --origin "avalanche diode, operator-asserted" \
     --encryption-bytes E --auth-records N \
     --assert-offline --assert-distinct-physics \
     --assert-tmpfs-workspace --assert-no-persistent-copy
   ```

   *Enforced:* every assertion flag is required — a missing one is the
   typed refusal `ceremony-incomplete`, and nothing is generated. The
   generation itself is gen's own path: XOR combination and the exact §7
   partition, `secret.bin` durable before `head.json` and the `init`
   journal line exist (§12.4), and a manifest containing nothing derived
   from pad bytes (§1.1). Each medium then receives the **whole pair** —
   both direction stores and the manifest — copied file by file with
   short writes detected and fsync attempted per file and directory
   (best-effort: removable media sit outside §10's verified durability
   scope). Both copies are structurally re-loaded before the workspace
   copy is touched.
6. **The workspace copy is removed** — and priced honestly: removal is
   deletion, not proof of erasure. Software can drop its reference to pad
   material; whether the medium forgot the bytes is a destruction claim,
   and destruction's limits belong to Phase 6 (§14.2 L6). The tmpfs
   assertion in step 2 is what keeps those bytes off persistent storage,
   and that assertion is the operator's. *Enforced:* the removal and the
   sentence saying what it is worth. *Asserted:* that no other copy exists
   (`--assert-no-persistent-copy`) — unmount the tmpfs or power the
   machine off before it leaves the ceremony.
7. **Hand-copy the CEREMONY RECORD into the pad book.** The tool prints
   it on stderr: pairId, budgets, source declarations, every operator
   assertion verbatim, both media paths, timestamps. *Operator step:* the
   record's integrity is the copy in the book, not cryptography (§3
   below).
8. **Verify each medium** before it travels: `truepad2 ceremony verify
   <medium>` (§4 below). *Enforced:* structural checks; typed refusal on
   any failure.
9. **Distribute:** each courier carries one medium to its peer, out of
   band. *Operator step,* end to end: the tool cannot see the couriers.

| step | enforced by code | asserted by the operator |
| --- | --- | --- |
| 1 offline machine | — | `--assert-offline` |
| 2 tmpfs workspace | — | `--assert-tmpfs-workspace` |
| 3 sources | ≥2 sources; one file = one source; full `L` bytes each (`source-too-short`) | distinct physics (`--assert-distinct-physics`); uniformity of any source |
| 4 blank media | refuses provisioned media | media are the intended drives |
| 5 generation | all assertions present (`ceremony-incomplete`); §7 partition; §12.4 write order; manifest free of pad-derived values; two FULL pair copies; post-copy load check | — |
| 6 workspace removal | removal, and the statement of what removal is not | no persistent copy (`--assert-no-persistent-copy`); unmount/power-off |
| 7 pad book entry | prints the record | copies it into the book |
| 8 verify media | structural verification | — |
| 9 distribution | — | courier handling, one medium per peer |

---

## 2. The distribution model: two peer media, two full copies

Each medium holds the **whole pair** — `a-to-b/`, `b-to-a/`, and
`manifest.json`. Never one direction per drive: a peer needs its sending
half to burn and its receiving half to open, so a direction-per-drive
split hands each peer half a channel and buys nothing — both direction
stores came off the same generating machine either way.

The courier model is v1's, carried forward (README, "Direction"): the pair
is generated once and copied whole; `--as` names the party. A burns
`a-to-b` and opens `b-to-a` in **A's copy**; B the reverse in **B's
copy**. The two copies diverge by use, and that is the design: A's burn
self-retires the spent material in A's copy, and B's open retires the same
positions in B's copy when the record arrives. The two parties must not
share one directory — a burn self-retires its own material, so in a shared
copy every open of that record would land below the high-water and be
refused `sequence-retired`.

Two media, two copies, and — by the operator's assertion — none anywhere
else. Every additional copy is another place for material to be read or
for stale state to be restored from (§9.4's whole-directory-restore
residual is open until Phase 4; more copies widen it).

---

## 3. The pad book and the manifest

The manifest (`manifest.json`, on each medium) and the CEREMONY RECORD
(printed at create) carry operational metadata only: pairId, creation
time, budgets, source declarations with declared origins and unused byte
counts, and the verbatim verdict line — "Uniform if at least one declared
source was uniform and independent of the others."

**Manifest integrity is operational, never cryptographic** — deliberately.
A checksum, hash, or fingerprint of pad bytes is a value derived from the
pad living outside `secret.bin`, which §1.1 forbids and §14.2 N14 makes
testable; a digest strong enough to detect substitution is strong enough
to help confirm a guessed pad. So the practice is paper: the record is
hand-copied into the pad book at generation, and later ceremonies check
the medium's manifest against the book, not the book against the medium.
The pad book records every ceremony against the pairId: generation,
verification, each retire with its reason, and destruction with date and
witness.

---

## 4. Verifying a medium

```sh
node bin/truepad2.mjs ceremony verify <medium-dir>
```

Structural verification of one medium's pair copy: both halves are loaded
through the store loader (`loadStore2`), which refuses v1 stores, corrupt
headers, wrong-length secret bodies, torn journals, and headers behind
their own history — plus the pair-level checks a single half cannot make:
both halves present (a lone half is `half-pair`), both carrying the same
pairId, each under the subdirectory its direction names. It prints the
status meters and the manifest, and exits 2 with the store's typed refusal
if anything is wrong. It never prints or hashes a secret byte:
`secret.bin` is checked by length only, because content never decides
liveness (§1.2).

What verify proves is structure, not provenance. It cannot show that the
bytes on the medium are the ceremony's bytes, that the declared sources
were what the operator said, or that no other copy exists. Those live in
the pad book and in the assertions — which is where this document filed
them.

---

## 5. The retirement ceremony

Retirement is the operator half of §8.5: the format defines the journal
record and the monotonicity rule (§13 — state never moves backwards);
the ceremony is when and how an operator invokes it, and what happens to
the media afterwards.

### 5.1 Contested records, via the existing verb

A sequence that has spent its `verifyAttemptLimit` is permanently
contested (§8.3): never verifiable again under its key and mask. A sender
pushed more than `maxAuthLookahead` records ahead of the receiver is
outside the window (§8.2), and the channel does not heal silently. Both
recover the same way:

```sh
node bin/truepad2.mjs retire <dir> --direction a-to-b \
  --through-sequence S [--through-offset O] --reason "why, for the pad book"
```

This advances the direction store past the affected records, destroying
their authentication material **unused** — never spending it — and
journals the action with its reason (§12.1). It is irreversible. The
ceremony around the verb: agree with the peer out of band on the retire
point, run the retire in **each party's own copy** (the copies advance
independently, exactly as they do in normal use), and enter both retires
in the pad book. A retire executed on one side only leaves the other
side's window behind; the out-of-band agreement is the step that keeps the
two books telling one story.

### 5.2 Auth-exhausted pairs

Authentication exhaustion permanently ends sending on a direction
(`auth-exhausted`, §14.1): records cannot be borrowed, and encryption
bytes stranded behind the last record can never be sent authenticated —
the format admits no unauthenticated record (§1.1), so stranded material
has exactly one future, and it is destruction. The ceremony: confirm with
`truepad2 status` (`CHANNEL CAPACITY LIMITED BY: AUTHENTICATION`, zero
remaining sends), agree out of band that the pair is done — one direction
exhausted generally means the pair retires whole — record the final meters
in the pad book, and proceed to §5.3 for both media. Stranded encryption
material is destroyed at this ceremony, never spent.

### 5.3 Exhausted media, and destruction

**Physical destruction is a ceremony step, not a software claim.** There
is no `destroy` verb — Phase 6 owns destruction semantics and the exact
statement of their limits (§14.2 L6), and this phase does not reach past
it. What the software does along the way — zeroizing retired ranges,
removing the workspace copy — is hygiene (§1.2): the counters make the
material unusable through this tooling, and no more than that is claimed.

So the media themselves are destroyed by the operator, physically, by
means fit for the medium, when the pair is exhausted, retired whole, or
either copy is suspected compromised — in which case both copies retire,
since either copy contains the whole pair. Both peers destroy their media,
each destruction entered in the pad book with pairId, date, method, and
witness. The book entry is the record that the pair ended on purpose;
the destruction is the only step in this document that removes the §1.3
at-rest exposure rather than managing it.

---

## 6. Limitations — what code cannot enforce

Stated here rather than distributed as caveats:

- **Offline, tmpfs, distinct physics, no persistent copy** are operator
  assertions. The tool requires the flags, records the statements, and
  checks no network state, no mount table, no device physics, and no
  absence of copies. A false assertion produces a pair whose record says
  more than what is true, and no later step detects it.
- **Source quality is declared, not measured.** §7's verdict is
  conditional: uniform **if** at least one declared source was uniform and
  independent of the others. No test in this repository can establish
  that; two sources of distinct physics are demanded so the condition has
  independent chances to hold.
- **Erasure is not proved.** Workspace removal is deletion; zeroization is
  hygiene (§1.2). What a flash controller, a journaling filesystem, or a
  swap file retained is outside every claim here; Phase 6 will state
  destruction's limits rather than remove them.
- **Whole-directory restore regresses a store** (§9.4, open until
  Phase 4): an operator restoring a medium from a backup regresses the
  header and journal together, and the tooling cannot tell. The ceremony's
  mitigation is procedural — two media, no other copies, by assertion.
- **Durability is scoped** (§10.2): verified on Linux ext4; macOS carries
  no full-flush guarantee in these primitives; removable media add their
  own write-cache behavior, which is why the provisioning fsync is called
  best-effort.
- **Manifest and pad book are paper-integrity** (§3): anyone who can
  rewrite a medium can rewrite its manifest. The book detects that only if
  the book was kept.
- **Roles and couriers are trusted as declared.** `--as` guards against
  accident, not against a party who lies; a courier who copies a medium in
  transit defeats the two-copies model, and no software on either end can
  see it.

Each of these is a hypothesis the ceremony carries so the format's claims
(§14.2) can stay exact. Where a limitation ends is where the pad book, the
operator, and the physical world begin — which is what a ceremony is for.
