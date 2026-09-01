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
   exit 2); nothing is written. *Enforced:* the two media must be two
   filesystem objects — the same directory under two names (same resolved
   path, same realpath, or same device+inode of the destinations) is
   refused (`ceremony-incomplete`). The identity check runs twice: once up
   front, and once **after the copies have created both destinations**, so
   an alias that could not be resolved until then — a symlink to a
   not-yet-created directory, an unmounted mount point — is still caught
   before the workspace copy is removed. A medium that is the workspace
   itself, or overlaps the generated pair, is refused for the same reason
   (it would leave a copy on the generating machine). That check
   establishes distinctness per the platform's identity checks, no more:
   it cannot prove that two mount points are not one physical flash device
   or controller presenting twice. *Asserted, in effect:* that the media
   are two physical devices — the operator's knowledge, like the sources'
   physics.
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
   scope). Before the workspace copy is touched, both copies pass two
   checks against different failure classes. First, **byte-verification**:
   every load-bearing file on each medium (`head.json`, `secret.bin`,
   `journal.log` per direction, plus `manifest.json`) is compared
   byte-for-byte against the workspace original. The comparison's output
   is value-independent: it passes, or it names the medium and the file
   that differed — never a checksum, hash, or fingerprint, written or
   printed anywhere (§1.1: no value derived from pad bytes lives outside
   `secret.bin`, and that includes refusal messages, manifests, and the
   pad book). On a mismatch the ceremony refuses (`ceremony-incomplete`),
   the workspace copy is **not** removed, and the operator inspects the
   medium before anything else. Second, both copies are **structurally
   re-loaded** through the store loader. Byte equality proves the copy
   **at that moment**; the later `ceremony verify` (§4) proves structural
   consistency, not provenance or continued bitwise identity with the
   ceremony image.
6. **The workspace copy is removed** — and priced honestly: removal is
   deletion, not proof of erasure. Software can drop its reference to pad
   material; whether the medium forgot the bytes is a destruction claim,
   and destruction's limits are stated at §5.3 and FORMAT-V2.md §17. The tmpfs
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

**Optional: a rollback witness (§15).** Add `--witness-class
separate-state-file --witness-path <absolute path>` to close the §9.4
restore residual for these stores. The absolute path is written verbatim
into both headers and travels with them; on each peer's host it names that
peer's own witness file, on an **independent medium or failure domain** the
pair's backup does not cover — the whole point is an authority outside the
pair directory. Choose that path deliberately (a different device, a
different backup regime), provision the witness there **explicitly**:

   ```sh
   truepad2 witness init /absolute/path/to/witness.json
   ```

   That writes the canonical `{"formatVersion":2,"witness":{}}` at mode 0600
   with the same durable discipline as an advance, and refuses to overwrite a
   witness that already holds entries or one it cannot parse. Protection
   begins at the first witnessed commit. **Do not `touch` the file** — a
   zero-byte or whitespace-only witness is now refused
   `witness-inconsistent` at every touchpoint, because an empty file is
   indistinguishable from one truncated by a failed write or a full medium,
   and adopting it as fresh would durably erase every other pair the witness
   records. Record the class and path in the pad book. The witness holds
only counters — never a pad byte — so it is non-secret, but it is also
*only as monotonic as the mechanism enforcing its non-regression*: a
separate state file that is itself restored or emptied knows nothing.
*Asserted, in effect:* that the witness path lives in a domain the pair's
backup does not reach. *Caveat:* **do not back the witness up together with
the pair** — a backup that captures both restores both, and the witness can
no longer catch the rollback it exists to catch.

| step | enforced by code | asserted by the operator |
| --- | --- | --- |
| 1 offline machine | — | `--assert-offline` |
| 2 tmpfs workspace | — | `--assert-tmpfs-workspace` |
| 3 sources | ≥2 sources; one file = one source; full `L` bytes each (`source-too-short`) | distinct physics (`--assert-distinct-physics`); uniformity of any source |
| 4 blank media | refuses provisioned media; refuses two names for one filesystem object (realpath / device+inode) | media are the intended drives, and two physical devices — identity checks cannot see one flash controller behind two mount points |
| 5 generation | all assertions present (`ceremony-incomplete`); §7 partition; §12.4 write order; manifest free of pad-derived values; two FULL pair copies; per-file byte-verification against the workspace pair (no checksum recorded anywhere); post-copy load check | — |
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
were what the operator said, or that no other copy exists. In particular
it does not re-prove bitwise identity with the ceremony image: the
provisioning-time byte-verification (§1 step 5) proved equality at that
moment, and nothing after it can — a re-comparison would need a reference
copy, and keeping one is exactly what the ceremony forbids. Provenance
lives in the pad book and in the assertions — which is where this
document filed it.

---

## 4.1 When provisioning fails

A byte-verification or structural failure at step 5 is not recoverable by
patching the suspect medium: there is deliberately **no re-provision
verb**. The safe path is to abandon the run. The workspace copy is left in
place only so that nothing is lost before the operator acts — it is still
the good copy, and the next step destroys everything, not preserves it:

1. **Destroy or quarantine both media's copies.** A failed medium may hold
   a near-complete copy of the pad; treat it like exhausted media (§5.3),
   not like a blank to reuse.
2. **Restart from a clean workspace** — a fresh tmpfs, a fresh `pair`
   directory.
3. **Draw fresh source material.** `gen` is a deterministic XOR of the
   declared sources, so the *same* sources reproduce the *same* pad
   material under a new pairId. Reusing the collected source files after a
   provisioning failure would recreate on new media a pad that a suspect
   medium may already hold a copy of. New pad means new sources.

The refusal message states this recovery inline, so the operator is never
directed at a verb the tooling does not have.

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

Destruction is two steps, in this order: the software `destroy` verb
first, then physical destruction of the medium. Neither replaces the
other — the verb tears down the store's software state and records the
intent; only the physical step removes the §1.3 at-rest exposure.

**Step one — `destroy` the pair, in each party's own copy** (Phase 6,
FORMAT-V2.md §17):

```sh
node bin/truepad2.mjs destroy <dir> --confirm <pairId> --reason "why, for the pad book"
```

Under the pair lock this writes a non-secret tombstone (`destroyed.json`:
pairId, timestamp, reason, and each direction's final high-waters),
best-effort zero-overwrites each half's `secret.bin`, then unlinks the
three store files and removes the half directories — leaving
`manifest.json` and the tombstone as the pair's non-secret record. The
`--confirm` value must equal the pair's pairId (the tool does not echo the
expected value — read it from the pad book or `head.json`); a pair too
corrupt to yield a pairId is destroyed with the literal token
`destroy-unreadable-pair`, and any other value is refused
`destroy-unconfirmed` with nothing touched. destroy works on a corrupt or
half store — a store too damaged to load is still one an operator must be
able to remove.

Once the tombstone is durable, the pair is **permanently retired from
software use**: every normal verb refuses it `pair-destroyed`, and no flag
brings it back (§17.3). If the machine crashes mid-teardown, simply run
`destroy` again with the same confirmation — it finishes the cleanup and
never resurrects the pair. Do not attempt to restore an active state from a
backup after this point; the secret body may be half-overwritten, and
reusing it risks reuse of pad material.

**What `destroy` does not claim is erasure.** *Software can forget its
reference to pad material; it cannot prove that flash forgot the bytes.*
The zero-overwrite is best-effort and proves nothing about the medium: a
copy-on-write filesystem (APFS among them) may preserve the pre-overwrite
blocks, SSD wear leveling may preserve any block, and backups are outside
the tool's reach. Retirement is logical, not physical (§1.2); so is
`destroy`'s file removal.

**Step two — physically destroy the media.** The media themselves are
destroyed by the operator, physically, by means fit for the medium, when
the pair is exhausted, retired whole, or either copy is suspected
compromised — in which case both copies are destroyed, since either copy
contains the whole pair. Run `destroy` on each copy, then destroy each
medium; enter each destruction in the pad book with pairId, date, method,
and witness. The book entry is the record that the pair ended on purpose;
the physical destruction is the only step in this document that removes
the §1.3 at-rest exposure rather than managing it.

**The witness, if configured, is left alone.** `destroy` does not touch a
rollback witness (§17.2): its counters are non-secret, monotone, and
harmless for a pair that no longer exists. Record the pair's end in the
pad book against its witness entry, and let the witness file age out on
its own schedule.

---

## 6. Limitations — what code cannot enforce

Stated here rather than distributed as caveats:

- **Offline, tmpfs, distinct physics, no persistent copy** are operator
  assertions. The tool requires the flags, records the statements, and
  checks no network state, no mount table, no device physics, and no
  absence of copies. A false assertion produces a pair whose record says
  more than what is true, and no later step detects it.
- **Media distinctness is a filesystem identity check.** Create refuses
  two names for one filesystem object — same resolved path, same
  realpath, or same device+inode of the destination directories — which
  catches a repeated path, a symlink alias, and a directory reached
  through two mount points. It cannot see whether two mount points that
  pass are one physical flash device or controller presenting twice;
  physical distinctness of the media stays with the operator.
- **Provisioning byte-equality is momentary.** The per-file comparison at
  create proves each medium's copy equaled the workspace pair at that
  moment, and its output is only pass or the name of the medium and file
  that differed — no checksum, hash, or fingerprint exists to re-check
  against later (§1.1, deliberately, per §3). Later `ceremony verify`
  proves structure, not continued bitwise identity with the ceremony
  image.
- **Source quality is declared, not measured.** §7's verdict is
  conditional: uniform **if** at least one declared source was uniform and
  independent of the others. No test in this repository can establish
  that; two sources of distinct physics are demanded so the condition has
  independent chances to hold.
- **Erasure is not proved.** Workspace removal is deletion; retirement is
  logical, not physical (§1.2); and `destroy`'s zero-overwrite (§5.3,
  FORMAT-V2.md §17) is best-effort. What a flash controller, a journaling
  filesystem, or a swap file retained is outside every claim here: software
  can forget its reference to pad material; it cannot prove that flash
  forgot the bytes. Physical destruction of the medium is the only step
  that removes the §1.3 at-rest exposure.
- **A shared witness serialises, and a stale witness lock stops every pair
  that shares it.** One witness file may record several pairs (§15.2), and
  advancing it is a read-modify-write of the whole file — so it is performed
  under an exclusive lock on the witness itself (FORMAT-V2.md §10.3), taken
  after the pair lock and never before it. Two pairs advancing at once wait for
  each other, briefly, instead of one silently erasing the other's committed
  high-water. The cost is stated rather than hidden: a crash or SIGKILL leaves
  the lock file behind, and because nothing here guesses whether the recorded
  pid is still alive — pids are reused, and a wrong guess would admit the second
  writer the lock exists to exclude — **every pair sharing that witness refuses
  until an operator confirms no TruePad operation is running against it and
  removes `<witness>.lock`**. That refusal is **free** — the lock is probed at
  preflight, before anything is consumed, precisely so a leftover cannot make
  every operation retire a record's pad and then withhold the output. That is
  operator recovery, and it is deliberate: a refusal is an availability failure
  the operator can see, a lost update is a silent rollback of committed state
  that nothing would ever report. Removing the lock while a real operation holds
  it re-opens the defect, so confirm first — the lock file names the pid, the
  host, and the pair holding it.
- **The witness path must be one file, named absolutely.** A relative path
  resolves against the working directory, so one header would name different
  witnesses from different directories; it is refused at load. A witness path
  whose final component is a **symbolic link** is refused too: the atomic
  replace does not follow the link, so the first advance would replace the link
  with a regular file and leave its target frozen — one authority silently
  becoming two. Identity is the platform's path identity (the canonical parent
  directory) and no more: a **hard link**, or two bind mounts or network paths
  onto one file, are indistinguishable, and two stores reaching one witness that
  way would not exclude each other. Keep one witness file, at one real path.
- **`platform-monotonic` closes the restore attack, on one platform only.**
  A separate-state-file cannot detect its own rollback: restore an old pair
  AND its old witness together and every check passes, because the two agree
  and there is no external truth to disagree with them. The
  `tpm2-nv-counter-v1` provider supplies that truth — a TPM 2.0 NV counter
  that is not in any backup. Provision a dedicated counter yourself; TruePad
  never defines, undefines, or clears an NV index:

  ```sh
  # Operator, once, on the host. Note nt=1 (COUNTER) and NO "orderly".
  tpm2_nvdefine -C o -s 8 -a "authread|authwrite|nt=1" 0x01500016

  truepad2 witness platform init /absolute/path/platform-witness.json \
      --nv-index 0x01500016

  truepad2 gen <dir> --source F --encryption-bytes E --auth-records N \
      --witness-class platform-monotonic \
      --witness-path /absolute/path/platform-witness.json
  ```

  `init` validates the index (COUNTER, exactly 8 octets, **TPMA_NV_ORDERLY
  absent**), records its TPM Name, and spends one counter value proving it can
  increment before any pad depends on it. Scope: **Linux, TPM 2.0,
  tpm2-tools** — not macOS, not Windows, not Secure Enclave. Every witness
  advance costs one NV increment, and a successful `open` costs two, because
  the attempt reservation and the high-water are separate security boundaries
  that are never batched. It resists RESTORE; it is **not** a claim against a
  compromised host, malicious firmware, or a subverted TPM.

  Two details worth knowing before you provision. A freshly defined counter has
  **no value**: `TPMA_NV_WRITTEN` is clear and reading it fails
  `TPM_RC_NV_UNINITIALIZED` until its first increment, which initialises it to
  the largest value any counter on that TPM has ever had — so **it will not
  start at zero**, and that is correct. And re-running `init` against an
  authority that is already settled is a true no-op: it spends no counter value
  and rewrites nothing. If you delete and re-create the index, a *different*
  public area gives a different Name and TruePad refuses; the *same* public
  area gives the same Name, and what prevents a rollback there is the TPM's own
  counter semantics, not the Name.
- **A replaced witness is caught only inside one operation's window.** From an
  operation's preflight to its advance, the whole witness is snapshotted and
  rechecked: a key that vanished, or any of the three counters going
  backwards, refuses rather than durably republishing a state below what the
  operation already read. That closes a replacement landing *during* an
  operation. It does **not** make a plain file monotonic: an authority
  restored wholesale to an older VALID copy between operations leaves a
  separate state file with no external truth to detect it. That is exactly
  what `platform-monotonic` and `remote-monotonic` are for. Of those,
  `platform-monotonic` is implemented — for one provider, `tpm2-nv-counter-v1`,
  provisioned as in §6, whose TPM counter is the external truth a plain file
  lacks — while `remote-monotonic` is not. For a `separate-state-file` witness
  the operator assumption stands unchanged: keep the witness in a failure
  domain the pair's backup does not reach, and never restore it.
  A basename ending in `.lock` is refused as reserved, because it is the name
  given to a neighbouring witness's lock file.
- **A shared witness must be on local storage, on one host.** The serialisation
  rests on `O_CREAT|O_EXCL`, which FORMAT-V2.md §10.2 scopes to local Linux
  ext4 and does not trust on network filesystems. The temptation runs the wrong
  way here: the reason to put a witness in an independent failure domain is
  precisely the reason an operator reaches for a network share or a sync
  client — and there `O_EXCL` may admit two writers, so two pairs could again
  erase each other's high-water. "Independent failure domain" means a different
  device or backup regime, **not** a network share. Nothing here can detect the
  violation; it is an operator assumption, stated.
- **Whole-directory restore regresses a store** (§9.4): an operator
  restoring a medium from a backup regresses the header and journal
  together, and the tooling cannot tell — unless a rollback witness (§15,
  the optional step above) is configured, in which case the restore refuses
  `witness-regressed` before anything is consumed. At the default
  `witnessClass: none` the ceremony's only mitigation is procedural — two
  media, no other copies, by assertion — and a configured witness is itself
  only as monotonic as the mechanism enforcing its non-regression (do not
  back it up with the pair).
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

---

## 7. The Browser Edition source ceremony

The Browser Edition offers the same **combiner** and a deliberately weaker
**ceremony**, because a web page cannot require what §1 requires. It never
pretends otherwise. Authoritative detail: `docs/BROWSER-SECURITY.md` §6.1.

### 7.1 Two source classes, one combiner

The combiner is identical to the CLI's and identical on both browser paths:
every declared source independently supplies the full `L = 2·(E + 32·N)` bytes;
they are XORed byte-for-byte; the result is partitioned into the four secret
slices. No KDF, no extractor, no hash conditioner, no whitening, no statistical
gate, no content-dependent rejection. Sources are never concatenated and never
split between them; surplus beyond `L` is unused.

- **Generate for me (default).** `crypto.getRandomValues()`. Stated to a normal
  operator as *"TruePad uses your device's cryptographic random generator."*,
  and under Security as a **cryptographically secure platform generator whose
  security rests on computational and platform assumptions** — never "truly
  random", never "physical", never "information-theoretically verified".
- **Use external random material.** Under *Advanced options → Randomness*, the
  **True OTP ceremony**: the operator supplies material whose origin they
  control. It states the combiner, then *"TruePad cannot determine whether a
  file is truly random."*, then the secrecy condition at its true strength:
  material an adversary can obtain **may still be XORed in** — it simply cannot
  be the source that *carries* the guarantee — so at least one combined source
  must also be **secret from the adversary**, and material an adversary
  supplied, chose, or could have influenced must never be combined at all. It
  closes with the gloss for key-message independence: *"Never derive source
  material from the messages you plan to send."*

### 7.2 What the browser can and cannot enforce

| §1 step | CLI | Browser Edition |
| --- | --- | --- |
| offline / tmpfs workspace | asserted by flag | **cannot require** — a page has no mount table and no network control. Nothing is uploaded (`BROWSER-SECURITY.md` §7), which is a different statement |
| ≥ 2 sources of distinct physics | ≥ 2 `--source`, physics asserted | **one source is permitted**; multi-source is offered and encouraged, physics remain the operator's assertion |
| every source supplies the full `L` | enforced (`source-too-short`) | **enforced identically** — the same engine refusal, and the UI marks a short file before Create |
| one file is one source | enforced by device+inode | **cannot be enforced** — the File API exposes no filesystem identity. The UI refuses the **same `File` object** re-selected in one session (an object-reference check that reads no bytes); two separate picks of one file are indistinguishable, and the ceremony copy says so |
| two blank peer media, distinctness checked | enforced by realpath / device+inode | **not applicable** — the browser hands the operator one pad file to deliver (§7.3) |
| source quality | declared, not measured | declared, not measured, plus an explicit **operator declaration** |

### 7.3 The operator declaration, and what it is not

Creating with external material requires ticking, verbatim:

> I understand that TruePad cannot verify physical randomness. For an
> information-theoretic one-time-pad secrecy claim about this pad's material, at
> least one selected source must actually be uniformly random, secret from the
> adversary, and never previously used. That source must also be independent of
> all the other selected sources taken together, and of the messages this pad
> will protect. It must never be used to make another pad.

It is an **operator declaration and never a verification result**. It changes
nothing about the material; it is **not persisted**; and no `trueRandom`,
`informationTheoretic` or `verifiedRandom` field exists in Store Format v2 for
it to be written to. The only record is the existing `sourceDeclarations[]`.
Words like *verified*, *certified*, *passed*, *confirmed* and *proven* do not
appear on this path.

The created pad's statement stays conditional: the verbatim §7 verdict, then
*"TruePad did not verify that assumption."*, then *"If that source assumption is
true, the pad material satisfies the information-theoretic randomness
requirement of a one-time pad."*

**Uniformity is not secrecy**, and the panel then says what the verdict is not:

*"The verdict above is about uniformity only. An information-theoretic secrecy
claim would also require that the source material you supplied was, and stays,
secret from the adversary; that it was independent of the messages this pad will
protect, in either direction; that no other pad is ever derived from it; and
that this pad material is used exactly once. TruePad's counters enforce that
last condition within TruePad — a copy of the pad file made outside it is beyond
them. TruePad established none of the rest; that is what you declared."*

The §7 verdict speaks to the uniformity hypothesis alone. The rest of the
premise — secrecy, key-message independence, one-pad-per-source — is carried by
that sentence, and the two must never be fused in either direction.

### 7.4 Delivery is the other half

The browser's distribution model is one pad file, handed over by the operator —
not §2's two provisioned peer media. The essential warning is unchanged on both
paths: **the pad file is the secret**; possession allows reading *and* forging;
ciphertext may travel publicly, pad material may not. For the external ceremony
the edition adds:

> For an end-to-end information-theoretic secrecy claim, the pad file must also
> be delivered through a secret method whose confidentiality does not itself
> depend on computational encryption assumptions. Physical handoff on removable
> media is the clearest ceremony.

Email, Dropbox, Google Drive, OneDrive, ordinary cloud storage and encrypted
messengers **do not preserve that claim**. They may be computationally secure
ways to move a file — a different guarantee, not a weaker form of this one.

### 7.5 Independence of claims

A genuinely physical source gives the Browser Edition none of the guarantees it
does not claim (`BROWSER-SECURITY.md` §8): no power-loss durability, no
independent external rollback witness, no physical erasure, no survival across
"clear site data". Nor does it strengthen the Wegman–Carter authentication
bound or the operational reuse-prevention machinery — and neither of those
proves anything about the source's physics. Three separate guarantees, never
quoted for one another.
