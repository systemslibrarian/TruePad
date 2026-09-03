/* ============================================================================
 * truepad2 ceremony — Phase 3: the generation ceremony as code
 * ----------------------------------------------------------------------------
 * Node only. docs/CEREMONY.md is the operator-facing procedure; FORMAT-V2.md
 * §8.5, §12.4, and §14.2 L3 bound what this file may claim. The split is
 * strict and printed rather than implied: what code can enforce (at least
 * two sources, full-length material, the §12.4 write order, two full pair
 * copies) is enforced; what code cannot verify (offline, distinct physics,
 * tmpfs workspace, no other copy) is an operator ASSERTION — a required
 * flag whose statement is recorded and printed, with this tool saying
 * plainly that it cannot check it.
 *
 *   ceremony create <workspace> --medium-a DIR --medium-b DIR
 *                   --source F --source F [--origin TEXT ...]
 *                   --encryption-bytes E --auth-records N [gen knobs]
 *                   --assert-offline --assert-distinct-physics
 *                   --assert-tmpfs-workspace --assert-no-persistent-copy
 *   ceremony verify <dir>
 *
 * create runs gen's own generation path (the same function, the same
 * refusals, the same §12.4 durability order) into <workspace>/pair, then
 * provisions TWO PEER MEDIA: each medium receives the WHOLE pair — both
 * direction stores and the manifest — never one direction per drive. Each
 * peer needs both halves: A burns a-to-b and opens b-to-a in A's copy, B
 * the reverse in B's. The two media must be two filesystem objects
 * (requireDistinctMedia), and before the workspace copy is touched every
 * load-bearing file on each medium is byte-compared against the workspace
 * original (verifyMediumCopy) and both copies are re-loaded structurally.
 * Only then is the workspace copy removed, and the removal is priced
 * honestly: deletion, not proof of erasure — destruction claims and their
 * limits are Phase 6's register, not this file's.
 *
 * verify is structural only: it loads both halves of one medium's copy via
 * loadStore2, cross-checks that they are halves of ONE pair, prints the
 * meters and the manifest, and never prints or hashes a secret byte
 * (loadStore2 checks secret.bin by length; content never decides liveness).
 * ========================================================================= */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PadDirection } from "../../core/pad.ts";
import { acquireLock, LOCK_FILE } from "../lock.ts";
import { HEAD_FILE, JOURNAL_FILE, loadStore2, SECRET_FILE, type LoadedStore2 } from "./store2.ts";
import { gen, Refused2, SUBDIR2, withPair, type Args2, type LoadedPair } from "./truepad2.ts";
import { ceremonyProvenance, PROVENANCE_FILE, provenanceBoundTo, readProvenance, writeProvenance } from "./provenance.ts";
import { isWithdrawn, withdrawalRecord, writeWithdrawal } from "./withdrawal.ts";
import {
  platformAssurance,
  platformRecordAssurance,
  resolvePlatformAuthority,
  type AssuranceLevel,
  type PlatformConfig
} from "./platform-witness.ts";

/* ---- the operator assertions ----------------------------------------------
 * Presence flags (parseArgs2 consumes no value for them): the operator makes
 * the statement by naming the flag. Every one is REQUIRED, every one is a
 * statement this tool cannot verify, and the CEREMONY RECORD prints each
 * statement next to the flag that asserted it.
 */

export const CEREMONY_ASSERTIONS: readonly { flag: string; statement: string }[] = [
  {
    flag: "assert-offline",
    statement:
      "The generating machine is offline: every network interface is down, and stays down until the workspace is gone."
  },
  {
    flag: "assert-distinct-physics",
    statement:
      "The declared sources were produced by at least two devices of distinct physics — different physical processes, " +
      "not two readouts of one device."
  },
  {
    flag: "assert-tmpfs-workspace",
    statement:
      "The workspace is memory-backed (tmpfs): no pad byte is written to the generating machine's persistent storage."
  },
  {
    flag: "assert-no-persistent-copy",
    statement:
      "After this ceremony, no copy of the pair remains on the generating machine; the two peer media hold the only copies."
  }
];

/* ---- local helpers (truepad2.ts keeps its own private) --------------------- */

const out = (text: string): void => {
  writeSync(1, text.endsWith("\n") ? text : `${text}\n`);
};
const err = (text: string): void => {
  writeSync(2, text.endsWith("\n") ? text : `${text}\n`);
};

function single(args: Args2, name: string): string | undefined {
  const list = args.flags.get(name);
  if (list === undefined) {
    return undefined;
  }
  if (list.length > 1) {
    throw new Error(`--${name} may be given only once`);
  }
  return list[0];
}

// The manifest gen writes (operational metadata only — nothing derived from
// pad bytes, ever). Read back for the CEREMONY RECORD before the workspace
// copy goes away.
type Manifest = {
  formatVersion: number;
  pairId: string;
  createdAt: string;
  encryptionBytesPerDirection: number;
  authRecordsPerDirection: number;
  requiredSourceLength: number;
  sources: { name: string; declaredOrigin: string; lengthBytes: number; unusedBytes: number }[];
  verdict: string;
};

function writeAllTo(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(`short write: ${offset} of ${bytes.length} bytes`);
    }
    offset += written;
  }
}

// Copy a pair tree file by file: full writes with short writes detected
// (a truncated secret.bin on a medium would be caught by the length check,
// but a truncated copy is refused here, not discovered later), then fsync
// of each file and directory, best-effort — media differ, and the format's
// §10 durability scope does not extend to removable drives. A lockfile is
// never copied onto a medium.
function copyTreeDurably(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === LOCK_FILE) {
      continue;
    }
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTreeDurably(from, to);
      continue;
    }
    // readFileSync's Buffer is used directly (a Buffer is a Uint8Array), so
    // the fill(0) below wipes the actual allocation, not a copy of it.
    const bytes: Uint8Array = readFileSync(from);
    const fd = openSync(to, "w", 0o600);
    try {
      writeAllTo(fd, bytes);
      try {
        fsyncSync(fd);
      } catch {
        /* best-effort */
      }
    } finally {
      closeSync(fd);
    }
    bytes.fill(0); // in-memory hygiene only; no erasure claim
  }
  try {
    const fd = openSync(dst, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort: not every platform opens a directory handle */
  }
}

// The load-bearing files of one pair copy, relative to the pair root: per
// direction the header, the secret body, and the journal, plus the manifest.
// This list is the provisioning contract — nothing else on a medium carries
// state the tooling reads. Computed per call, not at module load: this
// module and truepad2.ts import each other, and a module-level read of
// SUBDIR2 would evaluate before truepad2's body has run.
function pairFiles(): readonly string[] {
  return [
    ...(["A->B", "B->A"] as const).flatMap((direction) => [
      join(SUBDIR2[direction], HEAD_FILE),
      join(SUBDIR2[direction], SECRET_FILE),
      join(SUBDIR2[direction], JOURNAL_FILE)
    ]),
    "manifest.json",
    // The provenance record is part of the provisioning contract: it is
    // byte-verified on each medium, so a ceremony pair cannot arrive on a peer
    // medium with a missing or altered creation/premise record.
    PROVENANCE_FILE
  ];
}

// Byte-verification of one medium's copy against the workspace pair, run
// BEFORE the workspace copy is removed. The structural re-load in
// ceremonyCreate proves each copy LOADS; it cannot prove the copy EQUALS
// the workspace bytes — a medium that flipped a bit inside a correct-length
// secret.bin still loads cleanly, because content never decides liveness
// (§1.2), and would burn garbage. So every load-bearing file is compared
// byte-for-byte. The comparison's OUTPUT is value-independent by
// construction: it passes, or it names the medium and the file that
// differed — never a checksum, hash, fingerprint, offset, or byte, in any
// message, log, or record, because a value derived from pad bytes lives
// nowhere but secret.bin (§1.1, N14). What byte equality proves is the copy
// AT THIS MOMENT; a later ceremony verify proves structure, not continued
// bitwise identity with the ceremony image.
// The recovery a provisioning failure leaves the operator, stated where the
// failure is reported so the message never orders an action the tooling
// cannot perform. There is no re-provision verb by design: the safe path is
// to abandon the run, not to patch a suspect medium in place.
export const RECOVERY_NOTE =
  "Recovery: destroy or quarantine BOTH media's copies (a failed medium may hold a near-complete copy of the pad), " +
  "then restart the ceremony from a clean workspace. Do NOT reuse the collected source files: gen is a deterministic " +
  "XOR of the sources, so the same sources reproduce the same pad material — draw fresh source material for the retry " +
  "(docs/CEREMONY.md, retirement & recovery).";

export function verifyMediumCopy(workspacePair: string, mediumPair: string, mediumLabel: string): void {
  for (const rel of pairFiles()) {
    const mediumPath = join(mediumPair, rel);
    if (!existsSync(mediumPath)) {
      throw new Refused2(
        "ceremony-incomplete",
        `medium ${mediumLabel}: ${mediumPath} is missing after the copy. The workspace copy at ${workspacePair} was ` +
          "NOT removed — it is still the good copy. " + RECOVERY_NOTE
      );
    }
    // readFileSync's Buffers are compared and then wiped in place — for
    // secret.bin these two allocations hold pad material, and a Buffer IS
    // its allocation (a Buffer is a Uint8Array), so the fill(0) wipes the
    // actual bytes, not a copy of them. In-memory hygiene only; no erasure
    // claim. The wipe runs on the mismatch path too, before the throw.
    const expected = readFileSync(join(workspacePair, rel));
    const actual = readFileSync(mediumPath);
    const equal = expected.equals(actual);
    expected.fill(0);
    actual.fill(0);
    if (!equal) {
      throw new Refused2(
        "ceremony-incomplete",
        `medium ${mediumLabel}: ${mediumPath} does not byte-match the workspace original. Only the medium and file ` +
          "are named — no checksum, fingerprint, or content of either copy is printed (§1.1). The workspace copy at " +
          `${workspacePair} was NOT removed — it is still the good copy. ` + RECOVERY_NOTE
      );
    }
  }
}

// The two media must be two filesystem objects, not one object under two
// names. Identity is checked per the platform: the resolved path strings,
// the realpaths, and — when both directories exist — the (device, inode)
// pair of the destinations, which catches what realpath can miss (one
// directory reached through two mount points). What this establishes is
// distinctness per the platform's identity checks, no more: two mount
// points that pass can still be one physical flash device or controller
// presenting twice, and no filesystem call can see that — the media's
// physical distinctness stays operator knowledge (docs/CEREMONY.md §1
// step 4), like the sources' physics.
// Two paths are the same filesystem object when they resolve to the same
// realpath OR the same device+inode. Only meaningful once both exist —
// callers that need certainty check AFTER the directories are created,
// since a dangling symlink or an unmounted alias resolves to nothing until
// then.
function sameFsObject(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (!existsSync(a) || !existsSync(b)) {
    return false;
  }
  if (realpathSync(a) === realpathSync(b)) {
    return true;
  }
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

const ALIAS_LIMITS =
  "This check establishes distinctness per the platform's identity checks (realpath, device+inode); it cannot " +
  "prove two mount points are not the same physical device or controller — that stays the operator's knowledge.";

// The two media must be distinct filesystem objects. Called once early (a
// fast fail on obvious aliases) and AGAIN after both media directories
// exist, because a dangling symlink or unmounted-alias destination cannot
// be resolved until the copy has created it — and a one-object "two media"
// would leave a single physical copy while the record claims two.
function requireDistinctMedia(mediumA: string, mediumB: string, when: "before" | "after"): void {
  if (sameFsObject(mediumA, mediumB)) {
    throw new Refused2(
      "ceremony-incomplete",
      `--medium-a (${mediumA}) and --medium-b (${mediumB}) resolve to the same filesystem object; the ceremony ` +
        "provisions two peer media, and one directory under two names is one medium holding one copy. " +
        ALIAS_LIMITS +
        (when === "after"
          ? " The alias only became detectable once the copies created both paths; the workspace copy was NOT removed."
          : "") +
        " Nothing was generated and nothing was written."
    );
  }
}

// A medium may not be the workspace itself, nor contain or sit inside the
// pair directory: those would leave a copy on the generating machine (a
// medium == workspace) or copy the tree into itself. Path-based, so it
// holds before anything exists.
function requireMediumOutsideWorkspace(workspace: string, pairDir: string, medium: string, label: string): void {
  const within = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent + sep);
  if (medium === workspace || within(pairDir, medium) || within(medium, pairDir)) {
    throw new Refused2(
      "ceremony-incomplete",
      `medium ${label} (${medium}) is the workspace or overlaps the generated pair at ${pairDir}; a medium must be ` +
        "a separate destination, so that removing the workspace copy really leaves no copy on the generating " +
        "machine. Nothing was generated and nothing was written."
    );
  }
}

/* ---- one medium's pair, loaded and cross-checked --------------------------- */

type MediumPair = { "A->B": LoadedStore2; "B->A": LoadedStore2 };

// Structural load of one medium's pair copy: v1 detection, half-pair
// detection, both halves through loadStore2, then the cross-checks a single
// half cannot make — the two halves must be halves of ONE pair, each under
// the subdirectory its direction names. Throws typed Refused2 only.
function loadMediumPair(dir: string): MediumPair {
  for (const direction of ["A->B", "B->A"] as const) {
    if (existsSync(join(dir, SUBDIR2[direction], "pad.json"))) {
      throw new Refused2(
        "v1-store",
        `${join(dir, SUBDIR2[direction])} holds a v1 store (pad.json). v2 tooling refuses every v1 store and no ` +
          "conversion exists (FORMAT-V2.md §9)."
      );
    }
  }
  const missing = (["A->B", "B->A"] as const).filter((d) => !existsSync(join(dir, SUBDIR2[d], HEAD_FILE)));
  if (missing.length === 2) {
    throw new Refused2("no-store", `${dir} holds no v2 pad pair (no a-to-b/ or b-to-a/ ${HEAD_FILE})`);
  }
  if (missing.length === 1) {
    throw new Refused2(
      "half-pair",
      `${dir} is a half-pair: ${SUBDIR2[missing[0]]}/ is missing. A medium carries the WHOLE pair — both direction ` +
        "stores — or it carries nothing usable. Do not use the surviving half; re-provision the medium from a good copy."
    );
  }
  const pair = {} as MediumPair;
  for (const direction of ["A->B", "B->A"] as const) {
    const loaded = loadStore2(join(dir, SUBDIR2[direction]));
    if (!loaded.ok) {
      throw new Refused2(loaded.reason, loaded.message);
    }
    if (loaded.head.direction !== direction) {
      throw new Refused2(
        "corrupt-store",
        `${join(dir, SUBDIR2[direction])} holds a ${loaded.head.direction} store; a pair directory places A->B ` +
          "under a-to-b/ and B->A under b-to-a/. Nothing was burned."
      );
    }
    pair[direction] = loaded;
  }
  if (pair["A->B"].head.pairId !== pair["B->A"].head.pairId) {
    throw new Refused2(
      "corrupt-store",
      `the two halves disagree: a-to-b/ is pair ${pair["A->B"].head.pairId} and b-to-a/ is pair ` +
        `${pair["B->A"].head.pairId} — halves of two different pairs, not one pair. Nothing was burned.`
    );
  }
  return pair;
}

type VerifyMeters = {
  encryption: { capacity: number; nextOffset: number; remainingBytes: number };
  authentication: { capacityRecords: number; nextSequence: number; remainingRecords: number };
  frozen: boolean;
};

function metersOf(store: LoadedStore2): VerifyMeters {
  const { head, effective } = store;
  return {
    encryption: {
      capacity: head.encryption.capacity,
      nextOffset: effective.nextOffset,
      remainingBytes: head.encryption.capacity - effective.nextOffset
    },
    authentication: {
      capacityRecords: head.authentication.capacityRecords,
      nextSequence: effective.nextSequence,
      remainingRecords: head.authentication.capacityRecords - effective.nextSequence
    },
    frozen:
      effective.failureCount - effective.clearedAtFailureCount >= head.verification.failurePolicy.threshold
  };
}

/* ---- ceremony create ------------------------------------------------------- */

function requireUnprovisioned(medium: string): void {
  // A tombstoned medium (§17.3) is past the destruction boundary: never
  // provision a fresh pair onto it. Typed pair-destroyed like every other
  // consuming path that meets a tombstone.
  if (existsSync(join(medium, "destroyed.json"))) {
    throw new Refused2(
      "pair-destroyed",
      `${medium} carries a durable destroyed.json: this medium held a destroyed pair (§17.3) and must not be ` +
        "reprovisioned. Use fresh media. Nothing was written."
    );
  }
  for (const direction of ["A->B", "B->A"] as const) {
    const half = join(medium, SUBDIR2[direction]);
    if (existsSync(join(half, HEAD_FILE)) || existsSync(join(half, "pad.json"))) {
      // A ceremony precondition, typed like the other ceremony gates: the
      // operation does not happen, nothing is written, exit 2.
      throw new Refused2(
        "ceremony-incomplete",
        `${medium} already holds a pad store under ${SUBDIR2[direction]}/; a ceremony never overwrites ` +
          "provisioned media. Provide blank media, or retire the existing pair first. Nothing was written."
      );
    }
  }
}

export function ceremonyCreate(args: Args2): void {
  const workspaceArg = args.positional[2];
  if (workspaceArg === undefined) {
    throw new Error("ceremony create needs <workspace>: the tmpfs directory the pair is generated in");
  }
  const workspace = resolve(workspaceArg);
  const mediumAArg = single(args, "medium-a");
  const mediumBArg = single(args, "medium-b");
  if (mediumAArg === undefined || mediumBArg === undefined) {
    throw new Error(
      "ceremony create needs --medium-a DIR and --medium-b DIR: two peer media, each receiving a FULL copy of the pair"
    );
  }
  const mediumA = resolve(mediumAArg);
  const mediumB = resolve(mediumBArg);
  const pairDir = join(workspace, "pair");
  requireMediumOutsideWorkspace(workspace, pairDir, mediumA, "A");
  requireMediumOutsideWorkspace(workspace, pairDir, mediumB, "B");
  requireDistinctMedia(mediumA, mediumB, "before");

  // Every assertion is required. An assertion is a statement by the operator
  // — this tool cannot verify the network state, the mount table, the
  // sources' physics, or what other copies exist, and it does not pretend
  // to: it refuses to generate until the operator states each one, and then
  // it records the statements as statements.
  const missingAssertions = CEREMONY_ASSERTIONS.filter(({ flag }) => !args.flags.has(flag));
  if (missingAssertions.length > 0) {
    throw new Refused2(
      "ceremony-incomplete",
      `the ceremony requires every operator assertion; missing: ` +
        `${missingAssertions.map(({ flag }) => `--${flag}`).join(", ")}. An assertion is an operator statement this ` +
        "tool cannot verify — it checks no network, no mount table, no physics, and no absence of copies; it records " +
        "what the operator asserted and says so. Nothing was generated and nothing was written."
    );
  }

  const sources = args.flags.get("source") ?? [];
  if (sources.length < 2) {
    throw new Refused2(
      "ceremony-incomplete",
      `the ceremony requires at least two --source files of distinct declared physics (${sources.length} declared). ` +
        'gen alone accepts one source; a ceremony does not — the combined verdict ("Uniform if at least one declared ' +
        'source was uniform and independent of the others") is only worth holding when the sources can fail ' +
        "independently. Nothing was generated and nothing was written."
    );
  }

  // The physical/Shannon ceremony is the serious deployment profile, and it
  // must not silently expose exact plaintext length: it requires a FIXED record
  // size. gen accepts variable records; a ceremony does not. This is a
  // metadata-hardening policy — it is NOT what makes the one-time-pad theorem
  // apply — and choosing it is explicit, never implied.
  if (single(args, "record-bytes") === undefined) {
    throw new Refused2(
      "ceremony-incomplete",
      "the physical/Shannon ceremony requires a fixed record size: pass --record-bytes F (F a multiple of 16, " +
        "32 <= F <= 1048576; 4096 is recommended for ordinary messages). Fixed records hide the exact plaintext " +
        "length of each message, so this profile does not expose it through the ciphertext length. This is a " +
        "metadata-hardening policy, not what makes the one-time-pad theorem apply. Nothing was generated and " +
        "nothing was written."
    );
  }

  if (existsSync(pairDir)) {
    throw new Error(`${pairDir} already exists; a ceremony starts from an empty workspace`);
  }
  requireUnprovisioned(mediumA);
  requireUnprovisioned(mediumB);

  // The generation path is gen's own — the same function, the same refusals
  // (source-too-short, one-file-one-source), the same §12.4 durability
  // order, the same manifest. gen's machine line on stdout is this verb's
  // machine line; everything the ceremony adds goes to stderr.
  const genFlags = new Map<string, string[]>();
  for (const name of [
    "source",
    "origin",
    "encryption-bytes",
    "auth-records",
    "record-bytes",
    "verify-attempt-limit",
    "max-auth-lookahead",
    "freeze-threshold",
    "witness-class",
    "witness-path"
  ]) {
    const list = args.flags.get(name);
    if (list !== undefined) {
      genFlags.set(name, [...list]);
    }
  }
  gen({ positional: ["gen", pairDir], flags: genFlags });

  const manifest = JSON.parse(readFileSync(join(pairDir, "manifest.json"), "utf8")) as Manifest;

  // LOAD-BEARING ceremony authority (§5): if this ceremony is anchored to a
  // platform-monotonic (TPM) authority, record `ceremony-created` for THIS pair
  // in that independent authority, outside the pair directory. A plain `gen`
  // store NEVER records this, so a gen pair whose provenance.json is later edited
  // to claim `cli-ceremony` cannot be accepted or ranked maximum-assurance —
  // `ceremony accept` will find the authority at `ordinary` and refuse (Attack A).
  const headForAssurance = JSON.parse(readFileSync(join(pairDir, SUBDIR2["A->B"], HEAD_FILE), "utf8")) as {
    rollback?: { witnessClass?: string; config?: unknown };
  };
  if (headForAssurance.rollback?.witnessClass === "platform-monotonic") {
    const config = headForAssurance.rollback.config as PlatformConfig;
    // Authority-redirect closure: the platform authority MUST be external to the
    // pair (it is copied to media, and an in-pair authority is not independent).
    // Refuse before provisioning rather than build a pair that can never be gold.
    const stateResolved = resolve(config.statePath);
    const pairResolved = resolve(pairDir);
    if (stateResolved === pairResolved || stateResolved.startsWith(pairResolved + sep)) {
      throw new Refused2(
        "ceremony-incomplete",
        `the platform witness state file (${config.statePath}) is inside the ceremony workspace/pair directory. The ` +
          "rollback authority must be independent of the pair it protects — point --witness-path at an external " +
          "location. Nothing usable was provisioned."
      );
    }
    // Root of trust: a maximum-assurance ceremony pair may only be created against
    // this installation's PINNED trusted authority. Record `ceremony-created`
    // there — never the authority head.json alone names (§7, §19).
    const res = resolvePlatformAuthority(config);
    if (res.trust === "unpinned") {
      throw new Refused2(
        "ceremony-incomplete",
        "no trusted platform authority is pinned for this installation (`truepad2 authority pin`). A ceremony pair " +
          "cannot be created against an unpinned authority. Nothing usable was provisioned."
      );
    }
    if (res.trust === "mismatched") {
      throw new Refused2("ceremony-incomplete", `${res.message} Nothing usable was provisioned.`);
    }
    const created = platformRecordAssurance(res.config, manifest.pairId, "ceremony-created");
    if (!created.ok) {
      throw new Refused2(
        "ceremony-incomplete",
        `the independent platform ceremony authority could not record this pair's ceremony creation: ${created.message} ` +
          "Nothing usable was provisioned."
      );
    }
  }

  // Overwrite gen's `cli-gen` provenance with the ceremony's: this pair was
  // created by the physical ceremony, and every operator premise was asserted.
  // Delivery is still `local-only` — the private-handoff fact is established
  // ONLY by the one-way `ceremony accept` step on a peer medium, never here.
  // This is durable BEFORE the media are copied, so both peers carry it and it
  // is byte-verified. (On a platform pair the provenance is DESCRIPTIVE; the
  // load-bearing ceremony fact is the platform assurance recorded just above.)
  writeProvenance(pairDir, ceremonyProvenance(manifest.pairId, manifest.createdAt));

  // Provision the two peer media: each receives the WHOLE pair — both
  // direction stores plus the manifest. Two full copies, one per peer,
  // never one direction per drive: each peer needs its sending half to
  // burn and its receiving half to open.
  err(`medium A: copying the full pair to ${mediumA}`);
  copyTreeDurably(pairDir, mediumA);
  err(`medium B: copying the full pair to ${mediumB}`);
  copyTreeDurably(pairDir, mediumB);

  // Decisive identity re-check: both media directories now exist, so a
  // dangling-symlink or unmounted alias that was invisible at the "before"
  // check resolves and is caught here — before the workspace copy, the only
  // other copy, is removed.
  requireDistinctMedia(mediumA, mediumB, "after");

  // Two post-copy checks, both BEFORE the workspace copy is removed, each
  // catching what the other cannot. First, byte-verification: every
  // load-bearing file on each medium must equal the workspace original —
  // a copy that loads but differs would pass every structural check and
  // burn garbage. On a mismatch the refusal names the medium and file, the
  // workspace copy stays, and the operator inspects the medium.
  for (const [label, medium] of [
    ["A", mediumA],
    ["B", mediumB]
  ] as const) {
    err(`medium ${label}: byte-verifying every load-bearing file against the workspace pair`);
    verifyMediumCopy(pairDir, medium, label);
  }

  // Second, the structural re-load: both media must load as whole pairs
  // through the same loader every later verb will use — an unreadable
  // medium or a store the loader refuses is a different failure class from
  // a byte mismatch. A medium that fails either check is a provisioning
  // failure, and destroying the only good copy over it would be absurd.
  let headSample: LoadedStore2 | undefined;
  for (const [label, medium] of [
    ["A", mediumA],
    ["B", mediumB]
  ] as const) {
    try {
      const pair = loadMediumPair(medium);
      headSample = headSample ?? pair["A->B"];
    } catch (error) {
      if (error instanceof Refused2) {
        throw new Refused2(
          error.type,
          `medium ${label} (${medium}) failed its post-copy check — ${error.message} The workspace copy at ` +
            `${pairDir} was NOT removed — it is still the good copy. ` + RECOVERY_NOTE
        );
      }
      throw error;
    }
  }
  const head = (headSample as LoadedStore2).head;

  // Remove the workspace copy — and price the removal honestly. Removal is
  // deletion: software can forget its reference to pad material; whether
  // the storage medium forgot the bytes is a destruction claim, and
  // destruction's limits are Phase 6's register, not this phase's. The
  // tmpfs assertion above is what makes this deletion worth more than
  // ordinary deletion, and that assertion is the operator's.
  rmSync(pairDir, { recursive: true, force: true });
  const removed = !existsSync(pairDir);
  if (removed) {
    err(
      `workspace: ${pairDir} removed. Removal is deletion, not proof of erasure — destruction claims are Phase 6's ` +
        "(FORMAT-V2.md §14.2 L6); the tmpfs assertion is what keeps these bytes off persistent storage, and that " +
        "assertion is the operator's."
    );
    err(
      `note: the manifest path on the stdout line was the workspace copy just removed; each medium now holds its own ` +
        "manifest.json (see medium A/B in the record below)."
    );
  } else {
    err(`workspace: WARNING — ${pairDir} could not be removed. Remove it by hand before the machine leaves the ceremony.`);
  }

  // The CEREMONY RECORD: hand-copy it into the pad book. Its integrity is
  // the printed copy, not cryptography — deliberately (§1.1: nothing in a
  // manifest or record is ever derived from pad bytes).
  err("");
  err("==== CEREMONY RECORD — hand-copy into the pad book; its integrity is the copy, not cryptography ====");
  err(`pairId:    ${manifest.pairId}`);
  err(`created:   ${manifest.createdAt}`);
  err(
    `budgets:   per direction: ${head.encryption.capacity} encryption bytes, ` +
      `${head.authentication.capacityRecords} auth records; verify-attempt-limit ` +
      `${head.authentication.verifyAttemptLimit}, max-auth-lookahead ${head.authentication.maxAuthLookahead}, ` +
      `freeze-threshold ${head.verification.failurePolicy.threshold}`
  );
  err(`sources:   ${manifest.sources.length} declared, XOR-combined over the first ${manifest.requiredSourceLength} bytes of each`);
  for (const source of manifest.sources) {
    err(`  ${source.name}: ${source.lengthBytes} bytes declared, ${source.unusedBytes} unused. Origin: ${source.declaredOrigin}`);
  }
  err(`verdict:   ${manifest.verdict}`);
  err("assertions (operator statements — recorded by this tool, verified by no tool):");
  for (const { flag, statement } of CEREMONY_ASSERTIONS) {
    err(`  --${flag}: ${statement}`);
  }
  err(`medium A:  ${mediumA} (full pair: a-to-b/, b-to-a/, manifest.json; byte-verified against the workspace pair at provisioning)`);
  err(`medium B:  ${mediumB} (full pair: a-to-b/, b-to-a/, manifest.json; byte-verified against the workspace pair at provisioning)`);
  err(`workspace: ${pairDir} ${removed ? "removed (deletion, not proof of erasure)" : "NOT removed — remove it by hand"}`);
  err(`recorded:  ${new Date().toISOString()}`);
  err("==== END CEREMONY RECORD ====");
}

/* ---- ceremony verify ------------------------------------------------------- */

export function ceremonyVerify(args: Args2): void {
  const target = args.positional[2];
  if (target === undefined) {
    throw new Error("ceremony verify needs <dir>: one medium's pair copy");
  }
  const dir = resolve(target);
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused2("locked", lock.message);
  }
  try {
    // §17: a tombstoned pair is permanently unusable and must not be reported
    // as a verifiable medium, even if the store files still look structurally
    // valid. Checked before any secret is read.
    if (existsSync(join(dir, "destroyed.json"))) {
      throw new Refused2(
        "pair-destroyed",
        `${dir} carries a durable destroyed.json: this pair was destroyed (§17) and is not a usable medium. ` +
          "Nothing was touched."
      );
    }
    const pair = loadMediumPair(dir);
    const pairId = pair["A->B"].head.pairId;
    const snapshot = { "A->B": metersOf(pair["A->B"]), "B->A": metersOf(pair["B->A"]) };
    for (const direction of ["A->B", "B->A"] as const) {
      const m = snapshot[direction];
      err(
        `${direction}: encryption ${m.encryption.remainingBytes}/${m.encryption.capacity} bytes · authentication ` +
          `${m.authentication.remainingRecords}/${m.authentication.capacityRecords} records` +
          (m.frozen ? " · FROZEN" : "")
      );
    }

    // The manifest is operational metadata: printed here for checking
    // against the pad book, never load-bearing and never refused over —
    // the pair itself is the authority.
    let manifestState: "present" | "missing" | "unreadable" | "wrong-pair" = "missing";
    const manifestPath = join(dir, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
        manifestState = manifest.pairId === pairId ? "present" : "wrong-pair";
        err("manifest (operational metadata — check it against the pad book; its integrity is the printed copy, not cryptography):");
        err(JSON.stringify(manifest, null, 2));
        if (manifestState === "wrong-pair") {
          err(`WARNING: manifest pairId ${manifest.pairId} does not match this pair ${pairId} — this manifest belongs to a different pair.`);
        }
      } catch {
        manifestState = "unreadable";
        err(`WARNING: ${manifestPath} does not parse. The pair is the authority; restore the manifest from the pad book.`);
      }
    } else {
      err("manifest.json is missing from this medium. The pair is the authority; restore the manifest from the pad book.");
    }

    err(
      "ceremony verify: structural checks passed — both halves load, agree on the pair, and sit under the right " +
        "subdirectories. What this proves is structure, not provenance: whether these are the ceremony's bytes, and " +
        "whether other copies exist, remain the pad book's business. No secret byte was printed or hashed."
    );
    out(JSON.stringify({ pairId, "A->B": snapshot["A->B"], "B->A": snapshot["B->A"], manifest: manifestState }));
  } finally {
    lock.release();
  }
}

/* ============================================================================
 * ceremony accept — the one-way physical-handoff acceptance step
 * ----------------------------------------------------------------------------
 * `truepad2 ceremony create` records that a pair was created by the physical
 * ceremony, but it CANNOT record that the private courier handoff happened —
 * that is a fact only the operator holds, established after the media reach
 * their peers. `ceremony accept` is that one-way boundary: on a peer medium
 * that carries a ceremony pair, the operator asserts the handoff was private
 * and that no extra copy exists, and TruePad records `delivery = physical
 * private handoff (operator assertion)`. It NEVER observes the courier.
 *
 * It refuses anything but a ceremony pair whose premises were accepted and whose
 * delivery is still local-only: a plain-gen store, an imported/sealed lineage,
 * an unreadable provenance, or an already-accepted handoff all fail closed and
 * change nothing. The transition is one-way — `local-only -> physical-private`
 * — and never the reverse, and never from a non-ceremony creation.
 * ========================================================================= */

export const ACCEPT_ASSERTIONS = [
  {
    flag: "assert-private-handoff",
    statement:
      "This medium reached its intended peer by a private physical handoff I performed or trust; no one else obtained the pad in transit."
  },
  {
    flag: "assert-no-extra-copy",
    statement:
      "No copy of this pair remains anywhere but the two intended peer media — no backup, no cloud sync, no snapshot."
  }
] as const;

// The shared pairId of a whole, loaded pair — or a typed refusal when the two
// halves disagree (a spliced pair cannot accept or withdraw). withPair has
// already taken the lock, checked the tombstone, and loaded both halves.
function requireSharedPairId(pair: LoadedPair): string {
  const idA = pair["A->B"].head.pairId;
  const idB = pair["B->A"].head.pairId;
  if (idA !== idB) {
    throw new Refused2(
      "ceremony-incomplete",
      `this pair's two halves disagree on their pairId (a-to-b ${idA}, b-to-a ${idB}) — a spliced pair is not a ` +
        "single ceremony pair. Nothing was changed."
    );
  }
  return idA;
}

// The platform config a pair is bound to, if BOTH halves carry a
// platform-monotonic witness; else null. The ceremony-assurance ladder lives in
// that independent, TPM-anchored authority (§2-§7), outside the pair directory.
function platformConfigOfPair(pair: LoadedPair): PlatformConfig | null {
  const a = pair["A->B"].head.rollback;
  const b = pair["B->A"].head.rollback;
  if (a.witnessClass !== "platform-monotonic" || b.witnessClass !== "platform-monotonic") return null;
  return a.config as unknown as PlatformConfig;
}

// Advance the platform ceremony-assurance ladder for this pair, refusing if the
// INDEPENDENT authority will not attest the transition — this is what stops a
// forged provenance (a plain-gen pair the authority never recorded as
// ceremony-created) from being accepted (§2, Attack A). A non-platform pair has
// no such authority to advance; the caller records only the descriptive sidecar,
// and such a pair can never reach the maximum-assurance verdict anyway.
function advancePlatformAssurance(pair: LoadedPair, pairId: string, target: AssuranceLevel): boolean {
  const claimed = platformConfigOfPair(pair);
  if (claimed === null) return false;
  // Root of trust: the transition is recorded ONLY in this installation's PINNED
  // trusted authority, never the one head.json names. An unpinned installation
  // or a pair naming a different authority is refused (§7, §20-§21).
  const res = resolvePlatformAuthority(claimed);
  if (res.trust === "unpinned") {
    throw new Refused2(
      "ceremony-incomplete",
      "no trusted platform authority is pinned for this installation (`truepad2 authority pin`); a ceremony " +
        "transition cannot be recorded. Nothing was changed."
    );
  }
  if (res.trust === "mismatched") {
    throw new Refused2("ceremony-incomplete", `${res.message} Nothing was changed.`);
  }
  const r = platformRecordAssurance(res.config, pairId, target);
  if (!r.ok) {
    throw new Refused2(
      "ceremony-incomplete",
      `the independent platform ceremony authority did not attest this transition: ${r.message} Nothing was changed.`
    );
  }
  return true;
}

export function ceremonyAccept(args: Args2): void {
  const mediumArg = args.positional[2];
  if (mediumArg === undefined) {
    throw new Error("ceremony accept needs <medium-dir>: the peer medium holding the ceremony pair");
  }
  const medium = resolve(mediumArg);
  const as = single(args, "as");
  if (as !== "A" && as !== "B") {
    throw new Error("ceremony accept needs --as A or --as B: your role on this medium");
  }

  // §17/§4: acquire the pair lock, refuse a tombstoned or half/malformed pair,
  // and load BOTH halves — all via withPair — BEFORE any provenance mutation.
  // The whole check-and-transition runs under that one lock, so accept-vs-accept
  // and accept-vs-destroy are serialised by the existing pair authority.
  withPair(medium, (pair) => {
    const pairId = requireSharedPairId(pair);

    const record = readProvenance(medium);
    if (record === null) {
      throw new Refused2(
        "ceremony-incomplete",
        "this medium carries no readable ceremony provenance; only a pair created by `truepad2 ceremony create` can " +
          "accept a private handoff. Nothing was changed."
      );
    }
    // §1 pair binding: the provenance must be bound to THIS pair. A valid record
    // transplanted from another pair is rejected outright.
    if (!provenanceBoundTo(record, pairId)) {
      throw new Refused2(
        "ceremony-incomplete",
        `this medium's provenance is bound to pair ${record.pairId}, not to this pair ${pairId} — it was written ` +
          "for a different pair (or transplanted). Nothing was changed."
      );
    }
    // §5: a durable withdrawal is a permanent downgrade; a withdrawn pair can
    // never re-accept a handoff, whatever provenance.json says.
    if (isWithdrawn(medium, pairId)) {
      throw new Refused2(
        "ceremony-incomplete",
        "this pair's ceremony premises were withdrawn — a permanent downgrade. It cannot accept a private handoff. " +
          "Nothing was changed."
      );
    }
    if (record.creation !== "cli-ceremony" || record.ceremonyPremises !== "accepted") {
      throw new Refused2(
        "ceremony-incomplete",
        "only a ceremony-created pair whose premises were recorded can accept a private handoff; this pair was not " +
          "created by the physical ceremony. Nothing was changed."
      );
    }
    if (record.sealedAncestor) {
      throw new Refused2(
        "ceremony-incomplete",
        "this pair has a sealed ancestor — a computational-delivery lineage that a private handoff cannot override. " +
          "Nothing was changed."
      );
    }
    if (record.delivery === "physical-private-operator-asserted") {
      throw new Refused2(
        "ceremony-incomplete",
        "this pair's private handoff was already accepted; the delivery fact is one-way and does not change. " +
          "Nothing was changed."
      );
    }
    // record.delivery is "local-only" here (the only other value the schema and
    // its self-consistency checks allow for a cli-ceremony record).

    const missing = ACCEPT_ASSERTIONS.filter(({ flag }) => !args.flags.has(flag));
    if (missing.length > 0) {
      throw new Refused2(
        "ceremony-incomplete",
        `accepting a private handoff requires every operator assertion; missing: ` +
          `${missing.map(({ flag }) => `--${flag}`).join(", ")}. Each is a statement TruePad cannot verify — it did ` +
          "not observe the courier and cannot prove the handoff was private or that no other copy exists. Nothing " +
          "was changed."
      );
    }

    // LOAD-BEARING transition first: advance the INDEPENDENT platform authority
    // to handoff-accepted. On a platform pair this REFUSES unless the authority
    // already attests ceremony-created — so a forged provenance on a plain-gen
    // pair (which the authority never recorded) cannot be accepted (§2/§6,
    // Attack A). A non-platform pair has no authority to advance and only the
    // descriptive sidecar is written (such a pair is never maximum-assurance).
    const platformAttested = advancePlatformAssurance(pair, pairId, "handoff-accepted");

    // Descriptive one-way sidecar, durable BEFORE anything is reported.
    writeProvenance(medium, { ...record, delivery: "physical-private-operator-asserted" });

    err("CEREMONY HANDOFF ACCEPTED");
    err(`  medium:  ${medium}`);
    err(`  pairId:  ${pairId}`);
    err(`  authority: ${platformAttested ? "platform-attested (handoff-accepted)" : "descriptive only (no platform authority; not maximum-assurance)"}`);
    err(`  role:    ${as}`);
    err(
      "  TruePad recorded this OPERATOR ASSERTION. It did NOT observe the courier and cannot prove the handoff was " +
        "private or that no other copy exists:"
    );
    for (const { flag, statement } of ACCEPT_ASSERTIONS) {
      err(`    --${flag}: ${statement}`);
    }
    err("  Delivery is now: physical private handoff (operator premise). This is one-way.");
    out(JSON.stringify({ medium, as, pairId, delivery: "physical-private-operator-asserted" }));
  });
}

/* ============================================================================
 * ceremony withdraw — the SUPPORTED, irreversible assurance downgrade (§5)
 * ----------------------------------------------------------------------------
 * `provenance.json` is a replaceable sibling file. To make a downgrade real and
 * MONOTONIC, `withdraw` records the withdrawal in a SEPARATE durable authority,
 * `withdrawal.json`, pair-bound by the public pairId. The evaluator consults it
 * INDEPENDENTLY of provenance.json and, when it names this pair, forces the
 * ceremony premise to `withdrawn` — NOT ELIGIBLE.
 *
 * So restoring an older, stronger `provenance.json` after a withdrawal cannot
 * raise the classification: the withdrawal is a different file the evaluator
 * checks first. (A whole-directory restore that also deletes the withdrawal is
 * the general restore attack, caught by the live rollback witness.)
 *
 * Like accept, it runs entirely under the pair lock and refuses a tombstoned or
 * spliced pair. It is one-way and idempotent: withdrawing an already-withdrawn
 * pair reports that it is already withdrawn and changes nothing new.
 * ========================================================================= */

export function ceremonyWithdraw(args: Args2): void {
  const mediumArg = args.positional[2];
  if (mediumArg === undefined) {
    throw new Error("ceremony withdraw needs <medium-dir>: the pair whose ceremony premises you are withdrawing");
  }
  const medium = resolve(mediumArg);
  const as = single(args, "as");
  if (as !== "A" && as !== "B") {
    throw new Error("ceremony withdraw needs --as A or --as B: your role on this medium");
  }
  const reason = single(args, "reason") ?? "operator withdrawal (no reason given)";

  withPair(medium, (pair) => {
    const pairId = requireSharedPairId(pair);
    const claimed = platformConfigOfPair(pair);

    // Already-withdrawn is decided by the LOAD-BEARING authority: the PINNED
    // platform authority for a platform pair, the sidecar otherwise.
    let alreadyWithdrawn: boolean;
    if (claimed !== null) {
      const res = resolvePlatformAuthority(claimed);
      alreadyWithdrawn = res.trust === "trusted" && platformAssurance(res.config, pairId) === "withdrawn";
    } else {
      alreadyWithdrawn = isWithdrawn(medium, pairId);
    }
    if (alreadyWithdrawn) {
      err("CEREMONY PREMISES ALREADY WITHDRAWN");
      err(`  medium:  ${medium}`);
      err(`  pairId:  ${pairId}`);
      err("  A withdrawal is one-way; nothing changed. This pair is NOT ELIGIBLE and cannot be re-accepted.");
      out(JSON.stringify({ medium, as, pairId, ceremonyPremises: "withdrawn", changed: false }));
      return;
    }

    // LOAD-BEARING terminal transition first: record `withdrawn` in the
    // independent platform authority (§7). For a platform pair this is what
    // makes the downgrade survive deleting or corrupting the sidecar, and a
    // stale restore of the platform state is caught by its anchor.
    const platformAttested = advancePlatformAssurance(pair, pairId, "withdrawn");
    // Descriptive sidecar, durable BEFORE anything is reported.
    writeWithdrawal(medium, withdrawalRecord(pairId, new Date().toISOString(), reason));

    err("CEREMONY PREMISES WITHDRAWN");
    err(`  medium:  ${medium}`);
    err(`  pairId:  ${pairId}`);
    err(`  authority: ${platformAttested ? "platform-attested terminal (survives sidecar deletion/corruption)" : "descriptive sidecar only (no platform authority)"}`);
    err(`  role:    ${as}`);
    err(`  reason:  ${reason}`);
    err(
      "  This is a PERMANENT downgrade. On a platform pair it is attested by the independent TPM-anchored authority, " +
        "so deleting or editing pair-directory files cannot raise the classification again. This pair is now NOT ELIGIBLE."
    );
    out(JSON.stringify({ medium, as, pairId, ceremonyPremises: "withdrawn", changed: true }));
  });
}
