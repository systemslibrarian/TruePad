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
 * the reverse in B's. Then the workspace copy is removed, and the removal
 * is priced honestly: deletion, not proof of erasure — destruction claims
 * and their limits are Phase 6's register, not this file's.
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
  rmSync,
  writeSync
} from "node:fs";
import { join, resolve } from "node:path";
import type { PadDirection } from "../../core/pad.ts";
import { acquireLock, LOCK_FILE } from "../lock.ts";
import { HEAD_FILE, loadStore2, type LoadedStore2 } from "./store2.ts";
import { gen, Refused2, SUBDIR2, type Args2 } from "./truepad2.ts";

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
  if (mediumA === mediumB) {
    throw new Error("--medium-a and --medium-b name the same directory; the ceremony provisions two peer media");
  }

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

  const pairDir = join(workspace, "pair");
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
    "verify-attempt-limit",
    "max-auth-lookahead",
    "freeze-threshold"
  ]) {
    const list = args.flags.get(name);
    if (list !== undefined) {
      genFlags.set(name, [...list]);
    }
  }
  gen({ positional: ["gen", pairDir], flags: genFlags });

  const manifest = JSON.parse(readFileSync(join(pairDir, "manifest.json"), "utf8")) as Manifest;

  // Provision the two peer media: each receives the WHOLE pair — both
  // direction stores plus the manifest. Two full copies, one per peer,
  // never one direction per drive: each peer needs its sending half to
  // burn and its receiving half to open.
  err(`medium A: copying the full pair to ${mediumA}`);
  copyTreeDurably(pairDir, mediumA);
  err(`medium B: copying the full pair to ${mediumB}`);
  copyTreeDurably(pairDir, mediumB);

  // Post-copy check, BEFORE the workspace copy is removed: both media must
  // load as whole pairs. A medium that fails here is a provisioning failure,
  // and destroying the only good copy over it would be absurd.
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
            `${pairDir} was NOT removed; fix the medium and re-provision before anything else.`
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
  err(`medium A:  ${mediumA} (full pair: a-to-b/, b-to-a/, manifest.json)`);
  err(`medium B:  ${mediumB} (full pair: a-to-b/, b-to-a/, manifest.json)`);
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
