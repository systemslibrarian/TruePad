/* ============================================================================
 * TruePad Browser Edition — the operations (verbs) over the Vfs
 * ----------------------------------------------------------------------------
 * The browser twin of src/cli/v2/truepad2.ts. Each verb runs the SAME frozen
 * §12 transaction as the CLI — burn is SEND (S0..S3), open is OPEN (O0..O6),
 * and the order of durable acts inside each is normative — but over the async
 * Vfs and returning the structured results of protocol.ts (ok / refused /
 * error) instead of printing. Every byte of crypto is reused from src/core; no
 * construction is reimplemented here.
 *
 * The single-writer discipline is the Vfs's Web-Locks lock (`withLock(pairId)`),
 * the browser twin of the CLI's O_EXCL pair lock — real mutual exclusion, not a
 * UI flag. The destruction boundary (§17) is checked BEFORE any secret is read:
 * once <pairId>/destroyed.json is durable, every consuming verb refuses
 * `pair-destroyed`. There is no --legacy, --no-auth or --force here — those
 * flags do not exist in this API at all, and a v1 store (pad.json) is refused.
 *
 * What the browser does NOT claim — power-loss durability, an external
 * independent witness, physical erasure on destroy, verified source provenance
 * — is stated in docs/BROWSER-SECURITY.md and never faked here.
 * ========================================================================= */

import { bytesToHex, hexToBytes } from "../../core/hex.ts";
import type { PadDirection } from "../../core/pad.ts";
import {
  FREEZE_THRESHOLD_DEFAULT,
  MAX_AUTH_LOOKAHEAD_DEFAULT,
  VERIFY_ATTEMPT_LIMIT_DEFAULT,
  tagsEqual,
  wcTag,
  type CanonicalFields
} from "../../core/wc-one-time.ts";
import { decodeEnvelope2, encodeEnvelope2, type EnvelopeV2 } from "../../core/envelope2.ts";
import { decodeEnvelopeTransport2 } from "../../core/compact-envelope2.ts";
import { buildFrame, frameCapacity, parseFrame } from "../../core/frame2.ts";
import { combineSources, partition, requiredSourceLength } from "../../core/partition2.ts";
import type {
  DirectionMeters,
  EngineRequest,
  EngineResponse,
  EnvelopeLine,
  ManifestView,
  PairSummary
} from "./protocol.ts";
import {
  EngineRefused,
  HEAD_FILE,
  JOURNAL_FILE,
  SECRET_FILE,
  SUBDIR,
  commitAdvance,
  initStore,
  loadStore,
  persistAuthFail,
  readAuthRecord,
  readEncryption,
  reserveAttempt,
  type BrowserRollback,
  type HeadV2,
  type LoadedStore,
  type RecordSpec,
  type SourceDeclaration
} from "./store.ts";
import { witnessFor, type BrowserWitness, type BrowserWitnessKind } from "./witness.ts";
import { packContainer, unpackContainer, type CourierFile } from "./courier-format.ts";
import {
  commitPhysicalHandoff,
  readHandoffState,
  REFUSE_ALREADY_SEALED,
  REFUSE_UNREADABLE
} from "./handoff.ts";
import { readReceiverState, type ReceiverState } from "./spt-receiver-state.ts";
import type { SptRuntime } from "./spt-runtime.ts";
import {
  abandonImpl,
  cancelRequestImpl,
  commitReceiveImpl,
  confirmRequestImpl,
  createRequestImpl,
  inspectRequestImpl,
  openSealedImpl,
  rejectImpl,
  sealImpl
} from "./spt-verbs.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const TOMBSTONE_FILE = "destroyed.json";
const PAIR_META_FILE = "pair.json";
// A courier import in progress marks the final pair dir with this file BEFORE
// it copies any store bytes, and removes it only after pair.json commits. While
// it is present the pair is NOT active (import-incomplete): a crash mid-import
// leaves an inactive, retryable pair, never a partial active one (§6).
const IMPORT_MARKER_FILE = "importing.json";
// The browser-only staging root a courier import validates a whole bundle in
// before committing. Not a 32-hex name, so list-pairs never treats it as a pair.
const STAGING_ROOT = "importing";
const V1_PAD_FILE = "pad.json";
const UNREADABLE_PAIR_TOKEN = "destroy-unreadable-pair";
const HEX_32 = /^[0-9a-f]{32}$/;

// The verbatim §17 sentence — identical in the tombstone and the UI.
const DESTROY_LIMITATION =
  "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

// The verbatim §7 verdict — scoped, never promoted to a stronger claim.
const VERDICT = "Uniform if at least one declared source was uniform and independent of the others.";

/* ---- paths ---------------------------------------------------------------- */

const storeDir = (pairId: string, direction: PadDirection): string => `${pairId}/${SUBDIR[direction]}`;
const filePath = (prefix: string, name: string): string => `${prefix}/${name}`;
const tombstonePath = (pairId: string): string => `${pairId}/${TOMBSTONE_FILE}`;
const pairMetaPath = (pairId: string): string => `${pairId}/${PAIR_META_FILE}`;
const importMarkerPath = (pairId: string): string => `${pairId}/${IMPORT_MARKER_FILE}`;
const stagingDir = (pairId: string): string => `${STAGING_ROOT}/${pairId}`;

function directionFor(role: "A" | "B", op: "burn" | "open"): PadDirection {
  if (op === "burn") {
    return role === "A" ? "A->B" : "B->A";
  }
  return role === "A" ? "B->A" : "A->B";
}

/* ---- typed request/result helpers ----------------------------------------- */

type Req<K extends EngineRequest["op"]> = Extract<EngineRequest, { op: K }>;

type GenResult = { ok: true; op: "gen"; pair: PairSummary; verdict: string; manifest: ManifestView };
type StatusResult = { ok: true; op: "status"; pair: PairSummary };
type BurnResult = { ok: true; op: "burn"; envelope: EnvelopeLine; consumed: { encryptionBytes: number; authRecords: 1 }; meters: PairSummary };
type OpenResult = { ok: true; op: "open"; plaintext: Uint8Array; skipped: { encryptionBytes: number; authRecords: number }; meters: PairSummary };
type RetireResult = { ok: true; op: "retire"; meters: PairSummary };
type ClearFreezeResult = { ok: true; op: "clear-freeze"; cleared: number; meters: PairSummary };
type DestroyResult = { ok: true; op: "destroy"; alreadyDestroyed: boolean; limitation: string };
type ExportResult = { ok: true; op: "export-pair"; container: Uint8Array; fileCount: number };
type ImportResult = { ok: true; op: "import-pair"; pair: PairSummary };
type ListResult = { ok: true; op: "list-pairs"; pairs: PairSummary[] };

/* ---- validation helpers --------------------------------------------------- */

function requirePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNeg(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function recordSpecFrom(recordBytes: number | undefined): RecordSpec {
  if (recordBytes === undefined) {
    return { kind: "variable" };
  }
  if (!Number.isSafeInteger(recordBytes) || recordBytes < 32 || recordBytes > 1048576 || recordBytes % 16 !== 0) {
    throw new Error(`recordBytes must be a multiple of 16 with 32 <= F <= 1048576 (§16); found ${JSON.stringify(recordBytes)}`);
  }
  return { kind: "fixed", bytes: recordBytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---- pair gates & metadata ------------------------------------------------ */

async function requireNotDestroyed(vfs: Vfs, pairId: string): Promise<void> {
  if (await vfs.exists(tombstonePath(pairId))) {
    throw new EngineRefused(
      "pair-destroyed",
      `${pairId} carries a durable ${TOMBSTONE_FILE}: destruction of this pair was initiated (§17), so it is ` +
        `permanently unusable. Its secret material may be partially overwritten or already absent, and there is no ` +
        `path back to an active state. Nothing was touched.`
    );
  }
}

// §6: a pair whose courier import has not committed (its importing.json marker
// is still present) is NOT active. It is refused here rather than used partially,
// and re-running the import completes or discards it.
async function requireImportComplete(vfs: Vfs, pairId: string): Promise<void> {
  if (await vfs.exists(importMarkerPath(pairId))) {
    throw new EngineRefused(
      "import-incomplete",
      `${pairId} has an unfinished courier import (${IMPORT_MARKER_FILE} is present): the import did not commit, so ` +
        `the pair is not active. Re-run the import of the same bundle to complete it, or it will be discarded and ` +
        `retried on the next import. Nothing was touched.`
    );
  }
}

async function refuseIfV1(vfs: Vfs, pairId: string): Promise<void> {
  for (const direction of ["A->B", "B->A"] as const) {
    if (await vfs.exists(filePath(storeDir(pairId, direction), V1_PAD_FILE))) {
      throw new EngineRefused(
        "v1-store",
        `${storeDir(pairId, direction)} holds a v1 store (${V1_PAD_FILE}). v2 tooling refuses every v1 store and no ` +
          `conversion exists (§9). Generate a fresh v2 pair for v2.`
      );
    }
  }
}

async function requirePair(vfs: Vfs, pairId: string): Promise<void> {
  await refuseIfV1(vfs, pairId);
  const abHead = await vfs.exists(filePath(storeDir(pairId, "A->B"), HEAD_FILE));
  const baHead = await vfs.exists(filePath(storeDir(pairId, "B->A"), HEAD_FILE));
  if (!abHead && !baHead) {
    throw new EngineRefused("no-store", `${pairId} holds no v2 pad pair (no a-to-b/ or b-to-a/ head.json); run gen first.`);
  }
  if (!abHead || !baHead) {
    const missing = !abHead ? SUBDIR["A->B"] : SUBDIR["B->A"];
    throw new EngineRefused(
      "half-pair",
      `${pairId} is a half-pair: ${missing}/ is missing. gen did not complete. Do not use the surviving half.`
    );
  }
}

async function loadHalf(vfs: Vfs, pairId: string, direction: PadDirection): Promise<LoadedStore> {
  const loaded = await loadStore(vfs, storeDir(pairId, direction));
  if (!loaded.ok) {
    throw new EngineRefused(loaded.reason, loaded.message);
  }
  return loaded;
}

type LoadedPair = { "A->B": LoadedStore; "B->A": LoadedStore };

// Hold the gates in the frozen order: the tombstone (§17) is checked BEFORE
// anything else, then v1/wholeness, then both halves load. Both halves are
// loaded even for single-direction verbs because the freeze is pair-wide.
async function loadPair(vfs: Vfs, pairId: string): Promise<LoadedPair> {
  await requireNotDestroyed(vfs, pairId);
  await requireImportComplete(vfs, pairId);
  await requirePair(vfs, pairId);
  return { "A->B": await loadHalf(vfs, pairId, "A->B"), "B->A": await loadHalf(vfs, pairId, "B->A") };
}

function frozenHalf(store: LoadedStore): boolean {
  return store.effective.failureCount - store.effective.clearedAtFailureCount >= store.head.verification.failurePolicy.threshold;
}

function requireNotFrozen(pair: LoadedPair): void {
  const frozen = (["A->B", "B->A"] as const).filter((d) => frozenHalf(pair[d]));
  if (frozen.length > 0) {
    throw new EngineRefused(
      "frozen",
      `The pair is frozen: ${frozen.join(" and ")} reached the failure threshold. The freeze is the reversible ` +
        `operator brake (§8.4): it burns nothing and resets nothing. Run clear-freeze to resume. Nothing was burned.`
    );
  }
}

// §15.3 PREFLIGHT for one direction's store, returning the witness so the
// caller can advance it after the durable commit. The witness KIND comes from
// the browser-only pair.json (`kind`), never the frozen head. A store below its
// witness refuses `witness-regressed`; a missing/torn provisioned witness
// `witness-inconsistent`.
async function witnessPreflight(vfs: Vfs, store: LoadedStore, kind: BrowserWitnessKind): Promise<BrowserWitness> {
  const witness = witnessFor(vfs, kind);
  const pf = await witness.preflight(store.head.pairId, store.head.direction, {
    nextOffset: store.effective.nextOffset,
    nextSequence: store.effective.nextSequence,
    attemptsReserved: store.effective.attemptsReserved
  });
  if (!pf.ok) {
    throw new EngineRefused(pf.reason, pf.message);
  }
  return witness;
}

/* ---- pair provenance -----------------------------------------------------
 * WHERE A PAD CAME FROM, recorded by the installation about ITSELF.
 *
 * `pair.json` is browser-local and is NOT one of the six courier files, so a
 * sender cannot put a chosen origin into a bundle and have the importer believe
 * it. The value is written by whichever installation created or imported the
 * pad, about its own act.
 *
 * Two values are ever serialized. The third, `unknown`, is an in-memory state
 * only — it is what an absent `pair.json`, or a legacy one written before this
 * field existed, means. It is NEVER written to disk, never backfilled, and
 * never inferred from createdAt, from counters, or from whether the pad happens
 * to sit at genesis. The absence of the field is information: it means nobody
 * recorded this, and guessing in the direction that permits forwarding is
 * exactly how a pad ends up in two hands.
 *
 * A field that is PRESENT but not one of the two values is corruption and fails
 * closed, the same way an unrecognised `witness` does. A MISSING field is
 * legacy, not corruption.
 */
type SerializedOrigin = "generated-here" | "imported";
export type PairOrigin = SerializedOrigin | "unknown";

type PairMeta = {
  pairId: string;
  label: string;
  createdAt: string;
  witness: BrowserWitnessKind;
  origin: PairOrigin;
};

/** What is written to disk: `origin` is always one of the two real values. */
type WritablePairMeta = Omit<PairMeta, "origin"> & { origin: SerializedOrigin };

function isWitnessKind(value: unknown): value is BrowserWitnessKind {
  return value === "browser-none" || value === "browser-local-witness";
}

function isSerializedOrigin(value: unknown): value is SerializedOrigin {
  return value === "generated-here" || value === "imported";
}

// Read the browser-only pair.json. Its `witness` field is LOAD-BEARING: it says
// whether a rollback witness applies, so a present-but-corrupt pair.json fails
// CLOSED rather than silently defaulting to no-witness (which would bypass a
// provisioned witness). A pair with NO pair.json is a bare FORMAT-V2 store the
// browser never provisioned (e.g. a CLI store placed directly) — browser-none,
// with defaulted display fields.
/** A pad's provenance, for callers that must authorize a handoff. Exported for
 *  the engine and its tests only: it is NOT a worker op and no UI reaches it.
 *  Until sealing exists, `unknown` and `generated-here` behave alike in the
 *  product, so this is the only way to observe that a legacy pad was not
 *  quietly upgraded. */
export async function readPairOrigin(vfs: Vfs, pairId: string): Promise<PairOrigin> {
  return (await readPairMeta(vfs, pairId)).origin;
}

async function readPairMeta(vfs: Vfs, pairId: string): Promise<PairMeta> {
  const bytes = await vfs.readFile(pairMetaPath(pairId));
  if (bytes === null) {
    return { pairId, label: pairId, createdAt: "", witness: "browser-none", origin: "unknown" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    throw new EngineRefused(
      "corrupt-pair-meta",
      `${PAIR_META_FILE} for ${pairId} does not parse as JSON, so the browser cannot tell whether this pair carries a ` +
        `rollback witness. It fails closed rather than assume none. Nothing was touched.`
    );
  }
  if (!isRecord(parsed) || !isWitnessKind(parsed.witness)) {
    throw new EngineRefused(
      "corrupt-pair-meta",
      `${PAIR_META_FILE} for ${pairId} has no recognised witness kind (found ${JSON.stringify(isRecord(parsed) ? parsed.witness : parsed)}). ` +
        `It fails closed rather than guess whether a rollback witness applies. Nothing was touched.`
    );
  }
  // Provenance is load-bearing in the same way `witness` is: a value we do not
  // recognise means we cannot tell where this pad came from, and the safe
  // reading of "cannot tell" is not "it was made here".
  if ("origin" in parsed && !isSerializedOrigin(parsed.origin)) {
    throw new EngineRefused(
      "corrupt-pair-meta",
      `${PAIR_META_FILE} for ${pairId} has an unrecognised origin (found ${JSON.stringify(parsed.origin)}). ` +
        `It fails closed rather than guess whether this pad was generated here or arrived from elsewhere. Nothing was touched.`
    );
  }
  // A MISSING field is legacy, not corruption: pads written before provenance
  // existed keep working, and are simply never eligible to be forwarded.
  const origin: PairOrigin = isSerializedOrigin(parsed.origin) ? parsed.origin : "unknown";
  const label = typeof parsed.label === "string" ? parsed.label : pairId;
  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
  return { pairId, label, createdAt, witness: parsed.witness, origin };
}

async function writePairMeta(vfs: Vfs, meta: WritablePairMeta): Promise<void> {
  await vfs.writeFileAtomic(pairMetaPath(meta.pairId), enc.encode(JSON.stringify(meta)));
}

// The pair's browser-product witness kind, from pair.json (fails closed on a
// corrupt pair.json). Callers hold the pair lock and have passed the gates.
async function witnessKindFor(vfs: Vfs, pairId: string): Promise<BrowserWitnessKind> {
  return (await readPairMeta(vfs, pairId)).witness;
}

/* ---- meters & summaries --------------------------------------------------- */

async function directionMeters(vfs: Vfs, store: LoadedStore, kind: BrowserWitnessKind): Promise<DirectionMeters> {
  const { head, effective } = store;
  const remainingBytes = head.encryption.capacity - effective.nextOffset;
  const remainingRecords = head.authentication.capacityRecords - effective.nextSequence;
  let contestedLive = 0;
  for (const [sequence, count] of effective.attempts) {
    if (sequence >= effective.nextSequence && count >= head.authentication.verifyAttemptLimit) {
      contestedLive += 1;
    }
  }
  const limitedBy =
    remainingRecords <= Math.ceil(remainingBytes / head.authentication.maxCiphertextBytes) ? "AUTHENTICATION" : "ENCRYPTION";
  const witness = witnessFor(vfs, kind);
  const state = await witness.report(head.pairId, head.direction, {
    nextOffset: effective.nextOffset,
    nextSequence: effective.nextSequence,
    attemptsReserved: effective.attemptsReserved
  });
  return {
    direction: head.direction,
    encryption: { capacity: head.encryption.capacity, nextOffset: effective.nextOffset, remainingBytes },
    authentication: {
      capacityRecords: head.authentication.capacityRecords,
      nextSequence: effective.nextSequence,
      remainingRecords,
      contestedLive
    },
    record: head.recordPolicy.record,
    verification: { failureCount: effective.failureCount, frozen: frozenHalf(store) },
    maxRemainingSends: remainingRecords,
    limitedBy,
    witness: { class: kind, state }
  };
}

// A live pair's non-secret summary. loadPair enforces the gates, so a pair
// reaching here is not destroyed — destroyed:false always holds.
async function buildSummary(vfs: Vfs, pairId: string): Promise<PairSummary> {
  const pair = await loadPair(vfs, pairId);
  const meta = await readPairMeta(vfs, pairId);
  return {
    pairId,
    label: meta.label,
    createdAt: meta.createdAt,
    destroyed: false,
    meters: {
      "A->B": await directionMeters(vfs, pair["A->B"], meta.witness),
      "B->A": await directionMeters(vfs, pair["B->A"], meta.witness)
    }
  };
}

function zeroMeters(direction: PadDirection): DirectionMeters {
  return {
    direction,
    encryption: { capacity: 0, nextOffset: 0, remainingBytes: 0 },
    authentication: { capacityRecords: 0, nextSequence: 0, remainingRecords: 0, contestedLive: 0 },
    record: { kind: "variable" },
    verification: { failureCount: 0, frozen: false },
    maxRemainingSends: 0,
    limitedBy: "AUTHENTICATION",
    witness: { class: "browser-none", state: "n/a" }
  };
}

/* ---- gen (multi-source generation, §7) ------------------------------------ */

async function genImpl(vfs: Vfs, req: Req<"gen">): Promise<GenResult> {
  const capacity = requirePositive(req.encryptionBytes, "encryptionBytes");
  const capacityRecords = requirePositive(req.authRecords, "authRecords");
  const verifyAttemptLimit =
    req.verifyAttemptLimit === undefined ? VERIFY_ATTEMPT_LIMIT_DEFAULT : requirePositive(req.verifyAttemptLimit, "verifyAttemptLimit");
  const maxAuthLookahead =
    req.maxAuthLookahead === undefined ? MAX_AUTH_LOOKAHEAD_DEFAULT : requirePositive(req.maxAuthLookahead, "maxAuthLookahead");
  const freezeThreshold =
    req.freezeThreshold === undefined ? FREEZE_THRESHOLD_DEFAULT : requirePositive(req.freezeThreshold, "freezeThreshold");
  const record = recordSpecFrom(req.recordBytes);

  if (req.sources.length === 0) {
    throw new Error("gen needs at least one source of declared-uniform material");
  }
  const required = requiredSourceLength(capacity, capacityRecords);
  const short = req.sources.filter((s) => s.bytes.length < required);
  if (short.length > 0) {
    throw new EngineRefused(
      "source-too-short",
      `every declared source must supply the complete ${required} bytes (2·(E + 32·N) for E=${capacity}, ` +
        `N=${capacityRecords}); too short: ${short.map((s) => s.name).join(", ")}. Nothing was written.`
    );
  }
  // NO content-dependent deduplication, and NO inspection of the combined
  // bytes by value. If at least one declared source is uniform and independent
  // of the others, the XOR is exactly uniform over the FULL space — every
  // combined value, all-zeros included, is a legitimate draw. Refusing a source
  // because its bytes equal another's would condition the accepted distribution
  // (the same mistake as the removed all-zero tripwire), so it is not done.
  // The browser File API exposes no filesystem identity (no inode), so this
  // edition CANNOT prove two selections are aliases of one file the way the CLI
  // does — a stated limitation (docs/BROWSER-SECURITY.md §6). Refusing a literal
  // same-object re-selection is a UI concern (the picker can compare handles);
  // the engine, which sees only bytes, never judges source content.

  const declarations: SourceDeclaration[] = req.sources.map((s) => ({
    name: s.name,
    declaredOrigin: s.declaredOrigin.length > 0 ? s.declaredOrigin : "declared by operator at gen; not verified by this tool",
    lengthBytes: s.bytes.length
  }));

  const combined = combineSources(
    req.sources.map((s) => s.bytes),
    required
  );
  let slices: ReturnType<typeof partition>;
  try {
    slices = partition(combined, capacity, capacityRecords);
  } finally {
    // partition() returns COPIES, never views of `combined` (§7), so the
    // combined buffer is dead the moment it returns — or throws. In-memory
    // hygiene only; no erasure claim.
    combined.fill(0);
  }

  const pairId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  // The frozen head is NEVER forked: rollback is always the CLI's { none }
  // (§2). The browser's own witness kind is a product choice recorded in the
  // browser-only pair.json below, outside these bytes.
  const rollback: BrowserRollback = { witnessClass: "none", config: {} };

  const headFor = (direction: PadDirection): HeadV2 => ({
    formatVersion: 2,
    pairId,
    direction,
    mode: "bytes",
    sourceDeclarations: declarations,
    encryption: { capacity, nextOffset: 0 },
    authentication: {
      profile: "wc-one-time-v1",
      tagBits: 128,
      capacityRecords,
      nextSequence: 0,
      verifyAttemptLimit,
      maxCiphertextBytes: 1048576,
      maxAuthLookahead
    },
    recordPolicy: { authenticated: "required", downgradeAllowed: false, record },
    rollback,
    verification: {
      failurePolicy: { kind: "freeze", threshold: freezeThreshold },
      failureCount: 0,
      clearedAtFailureCount: 0,
      perSequenceAttempts: {}
    }
  });

  const secretFor = (encSlice: Uint8Array, authSlice: Uint8Array): Uint8Array => {
    const secret = new Uint8Array(capacity + 32 * capacityRecords);
    secret.set(encSlice, 0);
    secret.set(authSlice, capacity);
    return secret;
  };
  const secretAB = secretFor(slices.abEncryption, slices.abAuthentication);
  const secretBA = secretFor(slices.baEncryption, slices.baAuthentication);
  const createdAt = new Date().toISOString();

  const witnessKind: BrowserWitnessKind = req.witnessClass;
  try {
    await vfs.withLock(pairId, async (): Promise<void> => {
      // §12.4: per half, secret.bin is durable before head.json and the init line.
      await initStore(vfs, storeDir(pairId, "A->B"), headFor("A->B"), secretAB);
      await initStore(vfs, storeDir(pairId, "B->A"), headFor("B->A"), secretBA);
      // Provision the browser-local witness (explicit event), THEN commit the
      // pair with pair.json last: a crash before pair.json leaves a fresh store
      // with no committed browser witness (browser-none, nothing advanced yet).
      await witnessFor(vfs, witnessKind).bootstrap(pairId);
      // Provenance rides in the SAME pair.json commit that already makes the
      // browser metadata authoritative — no second file, no second transaction.
      // A crash before this leaves a bare store whose origin is `unknown`: it
      // works normally and is simply never eligible to be forwarded.
      await writePairMeta(vfs, { pairId, label: req.label, createdAt, witness: witnessKind, origin: "generated-here" });
    });
  } finally {
    // AFTER the awaited provisioning has settled — never before it, so nothing
    // is zeroed while initStore still needs the bytes. The finally is what
    // covers the failure path: a store that failed half-way leaves its files
    // for the caller to see, but these in-memory copies do not outlive it.
    // In-memory hygiene only; no erasure claim.
    secretAB.fill(0);
    secretBA.fill(0);
    slices.abEncryption.fill(0);
    slices.abAuthentication.fill(0);
    slices.baEncryption.fill(0);
    slices.baAuthentication.fill(0);
  }

  // The manifest is operational metadata only — NOTHING pad-derived (N14).
  const manifest: ManifestView = {
    pairId,
    createdAt,
    encryptionBytesPerDirection: capacity,
    authRecordsPerDirection: capacityRecords,
    requiredSourceLength: required,
    sources: declarations.map((d) => ({
      name: d.name,
      declaredOrigin: d.declaredOrigin,
      lengthBytes: d.lengthBytes,
      unusedBytes: d.lengthBytes - required
    })),
    verdict: VERDICT
  };

  const pair = await buildSummary(vfs, pairId);
  return { ok: true, op: "gen", pair, verdict: VERDICT, manifest };
}

/* ---- status --------------------------------------------------------------- */

async function statusImpl(vfs: Vfs, req: Req<"status">): Promise<StatusResult> {
  return vfs.withLock(req.pairId, async (): Promise<StatusResult> => {
    const pair = await buildSummary(vfs, req.pairId);
    return { ok: true, op: "status", pair };
  });
}

/* ---- burn (SEND, §12.2) --------------------------------------------------- */

async function burnImpl(vfs: Vfs, req: Req<"burn">): Promise<BurnResult> {
  const pairId = req.pairId;
  const plaintext = req.plaintext;
  return vfs.withLock(pairId, async (): Promise<BurnResult> => {
    const pair = await loadPair(vfs, pairId);
    const kind = await witnessKindFor(vfs, pairId);
    // S0 — checks, all free.
    requireNotFrozen(pair);
    const direction = directionFor(req.as, "burn");
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);
    const witness = await witnessPreflight(vfs, store, kind);

    const record = head.recordPolicy.record;
    let payload: Uint8Array;
    if (record.kind === "fixed") {
      const cap = frameCapacity(record.bytes);
      if (plaintext.length > cap) {
        throw new EngineRefused(
          "record-size-mismatch",
          `this store fixes every record at ${record.bytes} ciphertext bytes, so a message holds at most ${cap} ` +
            `bytes (F − 4); this one is ${plaintext.length}. Nothing was burned.`
        );
      }
      payload = buildFrame(plaintext, record.bytes);
    } else {
      payload = plaintext;
    }
    const c = payload.length;
    if (c > head.authentication.maxCiphertextBytes) {
      throw new EngineRefused(
        "oversize-ciphertext",
        `this message is ${c} bytes; MAX_CIPHERTEXT_BYTES is ${head.authentication.maxCiphertextBytes}. Split it into ` +
          `multiple records. Nothing was burned.`
      );
    }
    if (effective.nextSequence >= head.authentication.capacityRecords) {
      throw new EngineRefused(
        "auth-exhausted",
        `authentication records are exhausted (${head.authentication.capacityRecords} of ` +
          `${head.authentication.capacityRecords} used). Auth exhaustion permanently kills sending on this direction. ` +
          `Nothing was burned.`
      );
    }
    if (effective.nextOffset + c > head.encryption.capacity) {
      throw new EngineRefused(
        "encryption-exhausted",
        `this message needs ${c} encryption bytes but only ${head.encryption.capacity - effective.nextOffset} remain. ` +
          `A one-time pad cannot borrow, wrap, or reuse. Nothing was burned.`
      );
    }

    // S1 — staged in memory. Nothing on disk changes.
    const sequence = effective.nextSequence;
    const startOffset = effective.nextOffset;
    const { key, mask } = await readAuthRecord(vfs, prefix, head, sequence);
    const pad = await readEncryption(vfs, prefix, head, startOffset, c);
    const ciphertext = new Uint8Array(c);
    for (let i = 0; i < c; i += 1) {
      ciphertext[i] = payload[i] ^ pad[i];
    }
    const pairIdBytes = hexToBytes(head.pairId);
    if (pairIdBytes === null || pairIdBytes.length !== 16) {
      throw new EngineRefused("corrupt-head", `pairId in head.json is not 32 lowercase hex characters: ${head.pairId}`);
    }
    const fields: CanonicalFields = { pairId: pairIdBytes, direction, sequence, startOffset, ciphertext };
    const tag = wcTag(key, mask, fields);
    const envelope: EnvelopeV2 = {
      pairId: head.pairId,
      direction,
      sequence,
      startOffset,
      ciphertextLength: c,
      ciphertext,
      tag
    };

    // S2 — durable commit of BOTH namespaces. secret.bin is untouched (§1.2).
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: startOffset + c },
      authentication: { ...head.authentication, nextSequence: sequence + 1 }
    };
    await commitAdvance(vfs, prefix, newHead, {
      op: "send",
      sequence,
      startOffset,
      consumed: c,
      nextOffset: startOffset + c,
      nextSequence: sequence + 1,
      at: new Date().toISOString()
    });

    // §15.3 advance — after the durable commit, before the emit. burn reserves
    // no verification attempt, so attemptsReserved is unchanged.
    await witness.advance(pairId, direction, {
      encryptionNextOffset: startOffset + c,
      authenticationNextSequence: sequence + 1,
      attemptsReserved: effective.attemptsReserved
    });

    // S3 — only now does the envelope exist outside this call.
    const line = encodeEnvelope2(envelope);
    plaintext.fill(0); // in-memory hygiene only; no erasure claim
    payload.fill(0); // the frame when fixed (else the same buffer as plaintext)
    pad.fill(0);
    key.fill(0);
    mask.fill(0);

    const meters = await buildSummary(vfs, pairId);
    return { ok: true, op: "burn", envelope: line, consumed: { encryptionBytes: c, authRecords: 1 }, meters };
  });
}

/* ---- open (OPEN, §12.3) --------------------------------------------------- */

async function openImpl(vfs: Vfs, req: Req<"open">): Promise<OpenResult> {
  const pairId = req.pairId;
  return vfs.withLock(pairId, async (): Promise<OpenResult> => {
    const pair = await loadPair(vfs, pairId);
    const kind = await witnessKindFor(vfs, pairId);
    const direction = directionFor(req.as, "open");
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);

    // O0 — structural, free, before any secret is touched.
    // O0 — structural, free, before any secret is touched. Either spelling of
    // the SAME envelope is accepted here: canonical §6.2 JSON, or the TP2
    // compact transport, which decodes to an EnvelopeV2 and then goes through
    // exactly this pipeline. A malformed TP2 input is refused AS compact and
    // never re-tried as JSON. JSON behaviour and refusal precedence are
    // unchanged.
    const decoded = decodeEnvelopeTransport2(req.envelope);
    if (!decoded.ok) {
      throw new EngineRefused(decoded.reason, decoded.message);
    }
    const envelope = decoded.envelope;
    if (envelope.pairId !== head.pairId) {
      throw new EngineRefused(
        "wrong-pair",
        `this envelope is addressed to pair ${envelope.pairId}, but this pair is ${head.pairId}. Nothing was burned.`
      );
    }
    if (envelope.direction !== direction) {
      throw new EngineRefused(
        "wrong-direction",
        `this envelope carries ${envelope.direction} traffic; as ${req.as} you open ${direction}. Nothing was burned.`
      );
    }
    const sequence = envelope.sequence;
    const startOffset = envelope.startOffset;
    const c = envelope.ciphertextLength;

    const record = head.recordPolicy.record;
    if (record.kind === "fixed" && c !== record.bytes) {
      throw new EngineRefused(
        "record-size-mismatch",
        `this store fixes every record at ${record.bytes} ciphertext bytes, but this envelope declares ` +
          `ciphertextLength ${c}. It cannot be one of this store's records. Nothing was burned.`
      );
    }

    // O1 — window, free.
    if (sequence < effective.nextSequence) {
      throw new EngineRefused(
        "sequence-retired",
        `sequence ${sequence} is below this store's auth high-water ${effective.nextSequence}: a replayed, late, or ` +
          `already-opened record. Its authentication material is retired in this copy, never again usable. Nothing ` +
          `was burned.`
      );
    }
    if (sequence >= head.authentication.capacityRecords) {
      throw new EngineRefused(
        "sequence-malformed",
        `sequence ${sequence} does not exist in this store (capacityRecords ${head.authentication.capacityRecords}): ` +
          `malformed. Nothing was burned.`
      );
    }
    if (sequence >= effective.nextSequence + head.authentication.maxAuthLookahead) {
      throw new EngineRefused(
        "sequence-out-of-window",
        `sequence ${sequence} is beyond the finite lookahead window [${effective.nextSequence}, ` +
          `${effective.nextSequence + head.authentication.maxAuthLookahead}). More than ` +
          `${head.authentication.maxAuthLookahead} consecutive lost records need explicit operator recovery (retire); ` +
          `the channel does not heal silently. Nothing was burned.`
      );
    }
    if (startOffset < effective.nextOffset) {
      throw new EngineRefused(
        "offset-retired",
        `startOffset ${startOffset} is below this store's encryption high-water ${effective.nextOffset}: a legitimate ` +
          `sender's offsets never run behind an accepting receiver. Nothing was burned.`
      );
    }
    if (startOffset + c > head.encryption.capacity) {
      throw new EngineRefused(
        "encryption-exhausted",
        `this record's window [${startOffset}, ${startOffset + c}) runs past the encryption capacity ` +
          `${head.encryption.capacity}. Nothing was burned.`
      );
    }

    // O2 — state gates, free.
    requireNotFrozen(pair);
    const witness = await witnessPreflight(vfs, store, kind);
    const attempts = effective.attempts.get(sequence) ?? 0;
    if (attempts >= head.authentication.verifyAttemptLimit) {
      throw new EngineRefused(
        "sequence-contested",
        `sequence ${sequence} has used all ${head.authentication.verifyAttemptLimit} verification attempts and is ` +
          `permanently contested: never verifiable again under its key and mask. Recovery is an explicit operator ` +
          `retire. Nothing was burned.`
      );
    }

    // O3 — the reservation. Durable BEFORE any verification.
    await reserveAttempt(vfs, prefix, sequence);
    const attemptsNow = attempts + 1;

    // §15.3 advance the witness with the new attempt total, still BEFORE the
    // verification — so a later restore that rolls the attempt budget back is
    // refused witness-regressed at preflight.
    await witness.advance(pairId, direction, {
      encryptionNextOffset: effective.nextOffset,
      authenticationNextSequence: effective.nextSequence,
      attemptsReserved: effective.attemptsReserved + 1
    });

    // O4 — verify over canonical bytes.
    const { key, mask } = await readAuthRecord(vfs, prefix, head, sequence);
    const pairIdBytes = hexToBytes(head.pairId);
    if (pairIdBytes === null || pairIdBytes.length !== 16) {
      throw new EngineRefused("corrupt-head", `pairId in head.json is not 32 lowercase hex characters: ${head.pairId}`);
    }
    const fields: CanonicalFields = { pairId: pairIdBytes, direction, sequence, startOffset, ciphertext: envelope.ciphertext };
    const expected = wcTag(key, mask, fields);
    if (!tagsEqual(expected, envelope.tag)) {
      // FAIL: burn neither namespace; persist the failure durably, THEN refuse.
      const baseAttempts = { ...head.verification.perSequenceAttempts };
      if (attempts > 0) {
        baseAttempts[String(sequence)] = attempts;
      }
      const failHead: HeadV2 = {
        ...head,
        verification: { ...head.verification, failureCount: effective.failureCount, perSequenceAttempts: baseAttempts }
      };
      await persistAuthFail(vfs, prefix, failHead, sequence);
      key.fill(0);
      mask.fill(0);
      const remaining = head.authentication.verifyAttemptLimit - attemptsNow;
      throw new EngineRefused(
        "auth-failed",
        `the tag does not verify: a tampered, corrupted, or forged record. No pad material was consumed. Sequence ` +
          `${sequence} has ${remaining} verification attempt${remaining === 1 ? "" : "s"} left before it is ` +
          `permanently contested. This refusal cost one durable attempt reservation — the stated availability price ` +
          `of a finite forgery bound (§8.4).`
      );
    }

    // PASS: plaintext in memory, then O5.
    const pad = await readEncryption(vfs, prefix, head, startOffset, c);
    const plaintext = new Uint8Array(c);
    for (let i = 0; i < c; i += 1) {
      plaintext[i] = envelope.ciphertext[i] ^ pad[i];
    }
    const skippedBytes = startOffset - effective.nextOffset;
    const skippedRecords = sequence - effective.nextSequence;

    // O5 — durably retire every position ≤ N in BOTH namespaces, including the
    // skipped material, which is destroyed unused.
    const prunedAttempts: Record<string, number> = {};
    for (const [key2, count] of Object.entries(head.verification.perSequenceAttempts)) {
      if (Number(key2) > sequence) {
        prunedAttempts[key2] = count;
      }
    }
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: startOffset + c },
      authentication: { ...head.authentication, nextSequence: sequence + 1 },
      verification: { ...head.verification, perSequenceAttempts: prunedAttempts }
    };
    await commitAdvance(vfs, prefix, newHead, {
      op: "open",
      sequence,
      startOffset,
      consumed: c,
      skipped: skippedBytes,
      nextOffset: startOffset + c,
      nextSequence: sequence + 1,
      at: new Date().toISOString()
    });

    // §15.3 advance — after the durable commit (O5), before the release (O6).
    await witness.advance(pairId, direction, {
      encryptionNextOffset: startOffset + c,
      authenticationNextSequence: sequence + 1,
      attemptsReserved: effective.attemptsReserved + 1
    });

    // §16.2: on a fixed store the decrypted bytes are the frame; the length
    // prefix selects the released plaintext. A prefix past F − 4 cannot come
    // from a conforming sender — but if it occurs the material is already
    // retired (O5), so this is an error (nothing released), not a refusal.
    let released: Uint8Array = plaintext;
    if (record.kind === "fixed") {
      const parsed = parseFrame(plaintext);
      if (parsed === null) {
        throw new Error(
          `record-frame-invalid: the decrypted frame's length prefix exceeds this store's ${frameCapacity(record.bytes)}-` +
            `byte capacity (F − 4 for F=${record.bytes}). The record's pad material is already retired (O5) and is ` +
            `LOST; no plaintext was released (§16.2, the same loss row as a crash after O5).`
        );
      }
      released = parsed;
    }

    pad.fill(0);
    key.fill(0);
    mask.fill(0);

    // O6 — only now is the plaintext released, byte-exact.
    const meters = await buildSummary(vfs, pairId);
    return {
      ok: true,
      op: "open",
      plaintext: released,
      skipped: { encryptionBytes: skippedBytes, authRecords: skippedRecords },
      meters
    };
  });
}

/* ---- retire (§8.5 operator recovery) -------------------------------------- */

async function retireImpl(vfs: Vfs, req: Req<"retire">): Promise<RetireResult> {
  const pairId = req.pairId;
  const direction = req.direction;
  const throughSequence = requireNonNeg(req.throughSequence, "throughSequence");
  return vfs.withLock(pairId, async (): Promise<RetireResult> => {
    const pair = await loadPair(vfs, pairId);
    const kind = await witnessKindFor(vfs, pairId);
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);
    const witness = await witnessPreflight(vfs, store, kind);
    if (throughSequence >= head.authentication.capacityRecords) {
      throw new EngineRefused(
        "sequence-malformed",
        `throughSequence ${throughSequence} does not exist (capacityRecords ${head.authentication.capacityRecords}).`
      );
    }
    if (throughSequence < effective.nextSequence) {
      throw new EngineRefused(
        "sequence-retired",
        `sequences through ${throughSequence} are already retired (auth high-water ${effective.nextSequence}). ` +
          `Nothing to do; nothing was burned.`
      );
    }
    const newNextSequence = throughSequence + 1;
    let newNextOffset = effective.nextOffset;
    if (req.throughOffset !== undefined) {
      const throughOffset = requireNonNeg(req.throughOffset, "throughOffset");
      if (throughOffset >= head.encryption.capacity) {
        throw new EngineRefused("encryption-exhausted", `throughOffset ${throughOffset} runs past capacity ${head.encryption.capacity}.`);
      }
      if (throughOffset + 1 < effective.nextOffset) {
        throw new EngineRefused("offset-retired", `offsets through ${throughOffset} are already retired (high-water ${effective.nextOffset}).`);
      }
      newNextOffset = throughOffset + 1;
    }

    const prunedAttempts: Record<string, number> = {};
    for (const [key2, count] of Object.entries(head.verification.perSequenceAttempts)) {
      if (Number(key2) >= newNextSequence) {
        prunedAttempts[key2] = count;
      }
    }
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: newNextOffset },
      authentication: { ...head.authentication, nextSequence: newNextSequence },
      verification: { ...head.verification, perSequenceAttempts: prunedAttempts }
    };
    await commitAdvance(vfs, prefix, newHead, {
      op: "retire",
      toSequence: newNextSequence,
      toOffset: newNextOffset,
      reason: req.reason ?? "operator retire",
      at: new Date().toISOString()
    });
    await witness.advance(pairId, direction, {
      encryptionNextOffset: newNextOffset,
      authenticationNextSequence: newNextSequence,
      attemptsReserved: effective.attemptsReserved
    });
    const meters = await buildSummary(vfs, pairId);
    return { ok: true, op: "retire", meters };
  });
}

/* ---- clear-freeze (§8.4) -------------------------------------------------- */

async function clearFreezeImpl(vfs: Vfs, req: Req<"clear-freeze">): Promise<ClearFreezeResult> {
  return vfs.withLock(req.pairId, async (): Promise<ClearFreezeResult> => {
    const pair = await loadPair(vfs, req.pairId);
    let cleared = 0;
    for (const direction of ["A->B", "B->A"] as const) {
      const store = pair[direction];
      if (!frozenHalf(store)) {
        continue;
      }
      const prefix = storeDir(req.pairId, direction);
      const newHead: HeadV2 = {
        ...store.head,
        verification: {
          ...store.head.verification,
          failureCount: store.effective.failureCount,
          clearedAtFailureCount: store.effective.failureCount
        }
      };
      await commitAdvance(vfs, prefix, newHead, {
        op: "clear-freeze",
        atFailureCount: store.effective.failureCount,
        at: new Date().toISOString()
      });
      cleared += 1;
    }
    const meters = await buildSummary(vfs, req.pairId);
    return { ok: true, op: "clear-freeze", cleared, meters };
  });
}

/* ---- destroy (§17 destruction) -------------------------------------------- */

type HalfSummary = { pairId: string | null; nextOffset: number | null; nextSequence: number | null };
type ExistingTombstone = { exists: boolean; pairId: string | null; record: Record<string, unknown> | null };

async function readTombstone(vfs: Vfs, pairId: string): Promise<ExistingTombstone> {
  const bytes = await vfs.readFile(tombstonePath(pairId));
  if (bytes === null) {
    return { exists: false, pairId: null, record: null };
  }
  try {
    const parsed: unknown = JSON.parse(dec.decode(bytes));
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const tombId = typeof obj.pairId === "string" && HEX_32.test(obj.pairId) ? obj.pairId : null;
      return { exists: true, pairId: tombId, record: obj.formatVersion === 2 ? obj : null };
    }
  } catch {
    /* unparseable tombstone: the boundary stands, rewrite a clean one */
  }
  return { exists: true, pairId: null, record: null };
}

function safeCountField(container: unknown, field: string): number | null {
  if (typeof container !== "object" || container === null) {
    return null;
  }
  const value = (container as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readHalfSummary(vfs: Vfs, pairId: string, direction: PadDirection): Promise<HalfSummary> {
  const loaded = await loadStore(vfs, storeDir(pairId, direction));
  if (loaded.ok) {
    return { pairId: loaded.head.pairId, nextOffset: loaded.effective.nextOffset, nextSequence: loaded.effective.nextSequence };
  }
  const bytes = await vfs.readFile(filePath(storeDir(pairId, direction), HEAD_FILE));
  if (bytes !== null) {
    try {
      const parsed: unknown = JSON.parse(dec.decode(bytes));
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const headId = typeof obj.pairId === "string" && HEX_32.test(obj.pairId) ? obj.pairId : null;
        return { pairId: headId, nextOffset: safeCountField(obj.encryption, "nextOffset"), nextSequence: safeCountField(obj.authentication, "nextSequence") };
      }
    } catch {
      /* head.json unparseable — the pairId stays unreadable */
    }
  }
  return { pairId: null, nextOffset: null, nextSequence: null };
}

function highWatersOrNull(summary: HalfSummary): { nextOffset: number; nextSequence: number } | null {
  return summary.nextOffset !== null && summary.nextSequence !== null
    ? { nextOffset: summary.nextOffset, nextSequence: summary.nextSequence }
    : null;
}

async function halfHasFiles(vfs: Vfs, pairId: string, direction: PadDirection): Promise<boolean> {
  const prefix = storeDir(pairId, direction);
  return (
    (await vfs.exists(filePath(prefix, HEAD_FILE))) ||
    (await vfs.exists(filePath(prefix, SECRET_FILE))) ||
    (await vfs.exists(filePath(prefix, JOURNAL_FILE)))
  );
}

// §17.2 step 3: best-effort zero-overwrite of one half's secret.bin. It proves
// nothing about the medium and claims no erasure — the file is removed anyway.
async function overwriteSecretZeros(vfs: Vfs, pairId: string, direction: PadDirection): Promise<void> {
  const secretPath = filePath(storeDir(pairId, direction), SECRET_FILE);
  const size = await vfs.size(secretPath);
  if (size === null || size === 0) {
    return;
  }
  try {
    await vfs.writeRange(secretPath, 0, new Uint8Array(size));
  } catch {
    /* best-effort: the file is removed regardless */
  }
}

async function destroyImpl(vfs: Vfs, req: Req<"destroy">): Promise<DestroyResult> {
  const pairId = req.pairId;
  return vfs.withLock(pairId, async (): Promise<DestroyResult> => {
    const priorTombstone = await readTombstone(vfs, pairId);
    // A v1 store is refused — unless this is already a tombstoned pair being
    // finished (a leftover pad.json must not misroute a destroy-resume to v1).
    if (!priorTombstone.exists) {
      await refuseIfV1(vfs, pairId);
    }

    const abSum = await readHalfSummary(vfs, pairId, "A->B");
    const baSum = await readHalfSummary(vfs, pairId, "B->A");
    const resolvedPairId = abSum.pairId ?? baSum.pairId ?? priorTombstone.pairId;

    // §17.1 confirmation: --confirm MUST equal the pairId where a head yields
    // one; a pair too corrupt to yield one needs the literal token. The pairId
    // is deliberately NOT echoed — the operator confirms by knowing it.
    const requiredToken = resolvedPairId ?? UNREADABLE_PAIR_TOKEN;
    if (req.confirm !== requiredToken) {
      throw new EngineRefused(
        "destroy-unconfirmed",
        resolvedPairId === null
          ? `this pair is too corrupt to confirm by pairId — no half's ${HEAD_FILE} nor the tombstone yields one — so ` +
              `destroy requires confirm "${UNREADABLE_PAIR_TOKEN}". Nothing was touched.`
          : `confirm must equal the pair's pairId to destroy it. It is NOT echoed here — read it from the pad book, a ` +
              `half's ${HEAD_FILE}, or ${TOMBSTONE_FILE} and pass it verbatim. Nothing was touched.`
      );
    }

    // Already fully torn down: idempotent — report and change nothing.
    const alreadyGone =
      priorTombstone.exists && !(await halfHasFiles(vfs, pairId, "A->B")) && !(await halfHasFiles(vfs, pairId, "B->A"));
    if (alreadyGone) {
      return { ok: true, op: "destroy", alreadyDestroyed: true, limitation: DESTROY_LIMITATION };
    }

    // §17.2 order is normative. 2 — the tombstone (durable, survives the
    // destruction). On a RESUME (a well-formed tombstone exists) it is
    // PRESERVED, not rewritten — its destroyedAt is the historical truth.
    if (priorTombstone.record === null) {
      const tombstone = {
        formatVersion: 2,
        pairId: resolvedPairId,
        destroyedAt: new Date().toISOString(),
        reason: req.reason ?? "operator destroy",
        finalHighWaters: { "A->B": highWatersOrNull(abSum), "B->A": highWatersOrNull(baSum) },
        limitation: DESTROY_LIMITATION
      };
      await vfs.writeFileAtomic(tombstonePath(pairId), enc.encode(JSON.stringify(tombstone, null, 2)));
    }

    // 3 & 4 — per half: best-effort zero-overwrite of secret.bin, then unlink
    // the three files and the half directory.
    for (const direction of ["A->B", "B->A"] as const) {
      await overwriteSecretZeros(vfs, pairId, direction);
      const prefix = storeDir(pairId, direction);
      for (const name of [SECRET_FILE, HEAD_FILE, JOURNAL_FILE]) {
        await vfs.remove(filePath(prefix, name));
      }
      await vfs.remove(prefix);
    }

    return { ok: true, op: "destroy", alreadyDestroyed: false, limitation: DESTROY_LIMITATION };
  });
}

/* ---- export-pair / import-pair (the courier bundle) ----------------------- */

const BUNDLE_FILES: readonly string[] = [
  `${SUBDIR["A->B"]}/${HEAD_FILE}`,
  `${SUBDIR["A->B"]}/${SECRET_FILE}`,
  `${SUBDIR["A->B"]}/${JOURNAL_FILE}`,
  `${SUBDIR["B->A"]}/${HEAD_FILE}`,
  `${SUBDIR["B->A"]}/${SECRET_FILE}`,
  `${SUBDIR["B->A"]}/${JOURNAL_FILE}`
];
const BUNDLE_FILE_SET = new Set(BUNDLE_FILES);

/* Export is a HANDOFF, and a pad gets one.
 *
 * Two gates precede the bytes, in this order.
 *
 * PROVENANCE. An `imported` pad may never be exported onward. Phase 0.5 caught
 * the sealed version of this — Alice seals to Bob, Bob seals the same pad to
 * Charlie — and provenance closed it. The physical version is the same two-time
 * pad by a slower route: Alice hands the pad to Bob, Bob imports it, Bob picks
 * "Save the pad file" and gives that to Charlie. Bob and Charlie then hold
 * independently consumable copies of the same directional material and the same
 * one-time authentication keys. Once provenance exists, software CAN tell this
 * case apart from a first handoff, so it does.
 *
 *   generated-here → may perform the first software-mediated handoff
 *   imported       → may NEVER export or seal onward
 *   unknown        → legacy physical export only, never sealed transfer
 *
 * `unknown` is an explicit legacy boundary, not evidence that forwarding is
 * safe. It exists so pads written before this field keep working.
 *
 * HANDOFF STATE, then, and MARKER-LAST. The container is built in worker memory
 * and NOT released until the physical marker has been written and read back:
 * bytes that left without a record would be a handoff nothing knows about. A
 * sealed marker refuses; a torn marker refuses; a physical marker permits
 * re-export under the frozen legacy policy and does NOT rewrite the marker.
 */
/** The EXACT six-file courier container, read from the LIVE store.
 *
 *  One reader for two callers with different consequences: `export-pair`
 *  commits a physical handoff around it, and Phase 1C's sealed transfer
 *  encrypts it. Two copies of this loop would be two chances for the sealed
 *  path and the physical path to disagree about what a pad IS.
 *
 *  It mutates NO handoff state, and it carries exactly the six FORMAT-V2 files
 *  — never `pair.json`, never the handoff record, never provenance, never
 *  Browser witness metadata. */
export async function buildLiveCourierContainer(vfs: Vfs, pairId: string): Promise<Uint8Array> {
  const files: CourierFile[] = [];
  for (const rel of BUNDLE_FILES) {
    const bytes = await vfs.readFile(`${pairId}/${rel}`);
    if (bytes === null) {
      throw new EngineRefused("corrupt-store", `${rel} is missing; the pair is not whole. Nothing was exported.`);
    }
    files.push({ path: rel, bytes });
  }
  return packContainer(pairId, files);
}

async function exportImpl(vfs: Vfs, req: Req<"export-pair">): Promise<ExportResult> {
  const pairId = req.pairId;
  return vfs.withLock(pairId, async (): Promise<ExportResult> => {
    await requireNotDestroyed(vfs, pairId);
    await requireImportComplete(vfs, pairId);
    await requirePair(vfs, pairId);

    const meta = await readPairMeta(vfs, pairId);
    if (meta.origin === "imported") {
      throw new EngineRefused(
        "imported-pair-cannot-export",
        "This pad arrived from someone else, so TruePad will not save another copy of it to pass on. " +
          "Two people holding the same pad would each use the same material, which is the one failure this " +
          "product exists to prevent. Generate a new pad to share with someone new."
      );
    }

    const handoff = await readHandoffState(vfs, pairId);
    if (handoff.kind === "unreadable-spent") {
      throw new EngineRefused(REFUSE_UNREADABLE, handoff.message);
    }
    if (handoff.kind === "sealed") {
      throw new EngineRefused(
        REFUSE_ALREADY_SEALED,
        "This pad has already been sent by sealed transfer, so it will not also be saved as a file to pass on. " +
          "Generate a new pad for any further transfer."
      );
    }

    // §4: the container is packed IN THE WORKER and returned as one transferred
    // buffer. No pad material is base64-stringified on the UI thread.
    const container = await buildLiveCourierContainer(vfs, pairId);

    // MARKER LAST, and before the container is released. A first export records
    // the handoff; a re-export under an existing physical marker leaves it
    // alone, so the recorded time stays the time of the FIRST handoff.
    if (handoff.kind === "absent") {
      await commitPhysicalHandoff(vfs, pairId, new Date().toISOString());
    }
    return { ok: true, op: "export-pair", container, fileCount: BUNDLE_FILES.length };
  });
}

// Exactly the expected FORMAT-V2 files — no unknown, no duplicate, none missing.
function validateBundleFileSet(files: CourierFile[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    if (!BUNDLE_FILE_SET.has(f.path)) {
      return `bundle path ${JSON.stringify(f.path)} is not one of this store's files.`;
    }
    if (seen.has(f.path)) {
      return `bundle path ${JSON.stringify(f.path)} appears more than once.`;
    }
    seen.add(f.path);
  }
  const missing = BUNDLE_FILES.filter((p) => !seen.has(p));
  if (missing.length > 0) {
    return `bundle is missing store file(s): ${missing.join(", ")}.`;
  }
  return null;
}

// Remove the six store files (and their two direction dirs) under a root. Works
// on every Vfs backing: MemoryVfs keys by full path, so the leaf files are
// removed explicitly; OPFS/Node also drop the now-empty dirs.
async function removeStoreFiles(vfs: Vfs, root: string): Promise<void> {
  for (const rel of BUNDLE_FILES) {
    await vfs.remove(`${root}/${rel}`);
  }
  await vfs.remove(`${root}/${SUBDIR["A->B"]}`);
  await vfs.remove(`${root}/${SUBDIR["B->A"]}`);
}

// Discard any INCOMPLETE import of this pairId (never a committed pair — the
// caller checks that first): the partial store, its browser metadata, its
// witness journal, the import marker, and the staging tree. Idempotent.
async function discardIncompleteImport(vfs: Vfs, pairId: string): Promise<void> {
  await removeStoreFiles(vfs, pairId);
  await vfs.remove(pairMetaPath(pairId));
  await vfs.remove(importMarkerPath(pairId));
  await vfs.remove(`witness/${pairId}.log`);
  await vfs.remove(pairId);
  await removeStoreFiles(vfs, stagingDir(pairId));
  await vfs.remove(stagingDir(pairId));
}

// A COMMITTED (active) pair with this id: a head.json is present AND the pair is
// not mid-import (no importing.json). A pair still carrying the import marker is
// not committed, so a retry may clean and redo it.
async function committedPairExists(vfs: Vfs, pairId: string): Promise<boolean> {
  if (await vfs.exists(importMarkerPath(pairId))) {
    return false;
  }
  return (
    (await vfs.exists(filePath(storeDir(pairId, "A->B"), HEAD_FILE))) ||
    (await vfs.exists(filePath(storeDir(pairId, "B->A"), HEAD_FILE)))
  );
}

async function importImpl(vfs: Vfs, req: Req<"import-pair">): Promise<ImportResult> {
  // §4: the operator-selected bytes were transferred into the worker; unpack and
  // validate the WHOLE container here before anything touches the store.
  const unpacked = unpackContainer(req.container);
  if (!unpacked.ok) {
    throw new EngineRefused("malformed-bundle", `${unpacked.message} Nothing was imported.`);
  }
  const pairId = unpacked.pairId;
  if (!HEX_32.test(pairId)) {
    throw new EngineRefused(
      "malformed-bundle",
      `bundle pairId must be exactly 32 lowercase hex characters (found ${JSON.stringify(pairId)}). Nothing was imported.`
    );
  }
  const witnessKind: BrowserWitnessKind = req.witnessClass ?? "browser-local-witness";

  return vfs.withLock(pairId, () => importContainerUnderPairLock(vfs, unpacked, req.label, witnessKind));
}

/** The whole existing import transaction, with the pair lock ALREADY HELD.
 *
 *  Split out so sealed transfer can commit through the identical code path
 *  while holding that lock for its own consume-before-import ordering. There is
 *  no second importer: same staging, same file-set and `loadStore` validation,
 *  same witness bootstrap, same `pair.json` including `origin: "imported"`,
 *  same `importing.json` commit gate, same cleanup. `import-pair` is now a thin
 *  lock-taking wrapper, and its bytes and behaviour are unchanged. */
export async function importContainerUnderPairLock(
  vfs: Vfs,
  unpacked: { pairId: string; files: CourierFile[] },
  label: string,
  witnessKind: BrowserWitnessKind
): Promise<ImportResult> {
  const pairId = unpacked.pairId;
  const req = { label } as Req<"import-pair">;
  {
    await requireNotDestroyed(vfs, pairId);
    if (await committedPairExists(vfs, pairId)) {
      throw new EngineRefused(
        "pair-exists",
        `a pair with id ${pairId} already exists in this browser; importing would overwrite it. Nothing was imported.`
      );
    }
    // A prior interrupted/failed import of this same pairId leaves no active
    // pair, only removable partial/staging files: clear them so a retry is
    // never blocked by a ghost, and so bootstrap starts from a clean witness.
    await discardIncompleteImport(vfs, pairId);

    // §6 STAGE + VALIDATE. The whole bundle is validated in importing/<pairId>/
    // — file set, both headers (incl. rollback:none-only, so a CLI store whose
    // frozen witness class the browser cannot honour is REFUSED, not
    // downgraded), journals, secret sizes, reconciliation, pairId and direction
    // agreement — before ANY of it is made active. On any failure the staging is
    // removed and nothing active was ever written.
    const setError = validateBundleFileSet(unpacked.files);
    if (setError) {
      throw new EngineRefused("malformed-bundle", `${setError} Nothing was imported.`);
    }
    for (const f of unpacked.files) {
      await vfs.writeFileAtomic(`${stagingDir(pairId)}/${f.path}`, f.bytes);
    }
    let ab: LoadedStore | null = null;
    let ba: LoadedStore | null = null;
    try {
      const loadedAB = await loadStore(vfs, `${stagingDir(pairId)}/${SUBDIR["A->B"]}`);
      if (!loadedAB.ok) {
        throw new EngineRefused(loadedAB.reason, `imported A->B store: ${loadedAB.message}`);
      }
      const loadedBA = await loadStore(vfs, `${stagingDir(pairId)}/${SUBDIR["B->A"]}`);
      if (!loadedBA.ok) {
        throw new EngineRefused(loadedBA.reason, `imported B->A store: ${loadedBA.message}`);
      }
      if (loadedAB.head.pairId !== pairId || loadedBA.head.pairId !== pairId) {
        throw new EngineRefused("malformed-bundle", `the bundle's head.json pairId disagrees with the container pairId ${pairId}. Nothing was imported.`);
      }
      if (loadedAB.head.direction !== "A->B" || loadedBA.head.direction !== "B->A") {
        throw new EngineRefused("malformed-bundle", `the bundle's two halves are not a matched A->B / B->A pair. Nothing was imported.`);
      }
      ab = loadedAB;
      ba = loadedBA;
    } catch (error) {
      await removeStoreFiles(vfs, stagingDir(pairId));
      await vfs.remove(stagingDir(pairId));
      throw error;
    }

    // §6 COMMIT. Everything is validated. Mark the pair provisioning FIRST (so a
    // crash mid-copy leaves an inactive, retryable pair — never a partial active
    // one), copy the validated files in, bootstrap the witness to the imported
    // high-waters (only after the FORMAT-V2 state is validated), write pair.json
    // (the commit), then clear the marker and the staging.
    await vfs.writeFileAtomic(importMarkerPath(pairId), enc.encode(JSON.stringify({ pairId, at: new Date().toISOString() })));
    for (const f of unpacked.files) {
      await vfs.writeFileAtomic(`${pairId}/${f.path}`, f.bytes);
    }
    if (witnessKind === "browser-local-witness") {
      await witnessFor(vfs, "browser-local-witness").bootstrap(pairId, {
        "A->B": {
          encryptionNextOffset: ab.effective.nextOffset,
          authenticationNextSequence: ab.effective.nextSequence,
          attemptsReserved: ab.effective.attemptsReserved
        },
        "B->A": {
          encryptionNextOffset: ba.effective.nextOffset,
          authenticationNextSequence: ba.effective.nextSequence,
          attemptsReserved: ba.effective.attemptsReserved
        }
      });
    }
    // origin is a FIELD of the pair.json the commit already writes, before
    // importing.json is removed. There is no ordering in which an imported pair
    // becomes active carrying "generated-here", and no ordering in which a
    // crash upgrades a pad's provenance: a crash before this leaves
    // importing.json in place, so the pair is not committed at all.
    await writePairMeta(vfs, {
      pairId,
      label: req.label,
      createdAt: new Date().toISOString(),
      witness: witnessKind,
      origin: "imported"
    });
    await vfs.remove(importMarkerPath(pairId)); // COMMIT: the pair is now active
    await removeStoreFiles(vfs, stagingDir(pairId));
    await vfs.remove(stagingDir(pairId));

    const pair = await buildSummary(vfs, pairId);
    return { ok: true, op: "import-pair", pair };
  }
}

/* ---- helpers the Sealed Pad Transfer engine composes ----------------------
 * These exist so spt-verbs.ts never reimplements a gate that already lives
 * here. It receives them as injected dependencies, so the import arrow runs
 * one way — verbs.ts → spt-verbs.ts — and nothing circular is needed.
 * ------------------------------------------------------------------------- */

/** May this pad be sealed at all? Exists, whole, not destroyed, not mid-import,
 *  generated HERE, and BOTH directions at genesis read from the LIVE store —
 *  never from bytes a caller supplied. */
export async function requirePadSealable(vfs: Vfs, pairId: string): Promise<void> {
  await requireNotDestroyed(vfs, pairId);
  await requireImportComplete(vfs, pairId);
  await requirePair(vfs, pairId);
  const meta = await readPairMeta(vfs, pairId);
  if (meta.origin !== "generated-here") {
    throw new EngineRefused(
      meta.origin === "imported" ? "imported-pair-cannot-export" : "pad-provenance-unknown",
      meta.origin === "imported"
        ? "This pad arrived from someone else, so TruePad will not pass it on again. Generate a new pad to share."
        : "TruePad cannot tell where this pad came from, so it will not send it onward. Generate a new pad to share."
    );
  }
  const pair = await loadPair(vfs, pairId);
  for (const direction of ["A->B", "B->A"] as const) {
    const half = pair[direction];
    const used =
      half.effective.nextOffset !== 0 || half.effective.nextSequence !== 0 || half.effective.attemptsReserved !== 0;
    if (used) {
      throw new EngineRefused(
        "pad-not-at-genesis",
        "This pad has already been used, so it cannot be sent by sealed transfer. A pad is delivered before it " +
          "carries anything. Generate a new pad to share."
      );
    }
  }
}

/** Non-mutating: is this pairId importable into THIS store right now? Pure
 *  lookups — no staging, no writes, nothing consumed. Re-run at commit because
 *  a tombstone or a pair can appear in between. */
export async function requireImportable(vfs: Vfs, pairId: string): Promise<void> {
  await requireNotDestroyed(vfs, pairId);
  if (await committedPairExists(vfs, pairId)) {
    throw new EngineRefused(
      "pair-exists",
      `a pair with id ${pairId} already exists in this browser; importing would overwrite it. Nothing was imported.`
    );
  }
}

/** The importer's own bundle validation, run against a caller-supplied scratch
 *  Vfs so a decrypted container can be checked WITHOUT touching real state and
 *  without the plaintext reaching OPFS. Returns a message, or null when the
 *  bundle would be accepted. */
export async function validateBundleForImport(
  scratch: Vfs,
  pairId: string,
  files: CourierFile[]
): Promise<string | null> {
  const setError = validateBundleFileSet(files);
  if (setError) return setError;
  for (const f of files) {
    await scratch.writeFileAtomic(`${stagingDir(pairId)}/${f.path}`, f.bytes);
  }
  const loadedAB = await loadStore(scratch, `${stagingDir(pairId)}/${SUBDIR["A->B"]}`);
  if (!loadedAB.ok) return `imported A->B store: ${loadedAB.message}`;
  const loadedBA = await loadStore(scratch, `${stagingDir(pairId)}/${SUBDIR["B->A"]}`);
  if (!loadedBA.ok) return `imported B->A store: ${loadedBA.message}`;
  if (loadedAB.head.pairId !== pairId || loadedBA.head.pairId !== pairId) {
    return `the bundle's head.json pairId disagrees with the container pairId ${pairId}.`;
  }
  if (loadedAB.head.direction !== "A->B" || loadedBA.head.direction !== "B->A") {
    return `the bundle's two halves are not a matched A->B / B->A pair.`;
  }
  return null;
}

/* ---- derived receive completion ------------------------------------------
 * COMPLETE has no record of its own, deliberately. §16: writing a
 * `complete.json`, or rewriting `consumed` → `complete`, would add a terminal
 * state transition — and every terminal rewrite is a chance for a torn write to
 * resurrect PENDING. So COMPLETE is DERIVED from two facts that already exist
 * durably and independently:
 *
 *   1. a valid `consumed.json` for the request, and
 *   2. the pair it names being committed here as an IMPORTED pair.
 *
 * The two crash orders both behave. Consumed lands and the import never
 * commits: LOSS — real, permanent, and still not a reason to reopen the
 * request. Consumed lands, the import commits, and the worker dies before
 * replying: COMPLETE is derivable on the next read, with nothing to repair.
 * ------------------------------------------------------------------------- */

export type ReceiveCompletion =
  | { kind: "complete"; requestId: string; pairId: string }
  /** Consumed, but the pad never became a committed imported pair here. */
  | { kind: "lost"; requestId: string; pairId: string; message: string }
  | { kind: "not-consumed"; state: ReceiverState };

export async function deriveReceiveCompletion(
  vfs: Vfs,
  requestIdHex: string,
  now: Date
): Promise<ReceiveCompletion> {
  const state = await readReceiverState(vfs, requestIdHex, now);
  if (state.kind !== "consumed") return { kind: "not-consumed", state };
  const pairId = state.pairId;
  // "Committed as an imported pair" is exactly the importer's own definition:
  // the pair exists, its commit gate has cleared, and it says it arrived here.
  if (await vfs.exists(importMarkerPath(pairId))) {
    return { kind: "lost", requestId: requestIdHex, pairId, message: "the pad's import never completed." };
  }
  let origin: PairOrigin;
  try {
    origin = (await readPairMeta(vfs, pairId)).origin;
  } catch {
    return { kind: "lost", requestId: requestIdHex, pairId, message: "the pad's metadata cannot be read." };
  }
  if (origin !== "imported") {
    return { kind: "lost", requestId: requestIdHex, pairId, message: "the pad was never committed as an imported pair." };
  }
  return { kind: "complete", requestId: requestIdHex, pairId };
}

/* ---- list-pairs ----------------------------------------------------------- */

async function listImpl(vfs: Vfs): Promise<ListResult> {
  const names = await vfs.list("");
  const pairs: PairSummary[] = [];
  for (const name of names) {
    if (!HEX_32.test(name)) {
      continue; // skip the "witness" store and any non-pair entry
    }
    try {
      if (await vfs.exists(tombstonePath(name))) {
        const meta = await readPairMeta(vfs, name);
        pairs.push({
          pairId: name,
          label: meta.label,
          createdAt: meta.createdAt,
          destroyed: true,
          meters: { "A->B": zeroMeters("A->B"), "B->A": zeroMeters("B->A") }
        });
        continue;
      }
      pairs.push(await buildSummary(vfs, name));
    } catch {
      /* a pair that cannot be summarised (mid-write, corrupt) is skipped */
    }
  }
  return { ok: true, op: "list-pairs", pairs };
}

/* ---- the dispatcher ------------------------------------------------------- */

// Dispatch one EngineRequest over the Vfs and return the EngineResponse with a
// matching id. A typed EngineRefused becomes a structured `refused`; any other
// throw becomes `error` with only its message — never a stack with secret
// context. Secrets never appear in a response other than the plaintext an open
// releases and the pad material an explicit export bundles.
/** The Sealed Pad Transfer engine, composed from the helpers above.
 *
 *  `handle` takes an optional runtime so existing callers and tests are
 *  untouched; the worker creates exactly one. An SPT request without a runtime
 *  is refused rather than silently given a fresh one, because a per-call
 *  runtime would give every RPC its own session map and quietly break the
 *  one-live-session rule. */
function requireRuntime(runtime: SptRuntime | undefined): SptRuntime {
  if (!runtime) {
    throw new EngineRefused("spt-unavailable", "sealed transfer is not available in this context.");
  }
  return runtime;
}

const SEAL_DEPS = { requireNotDestroyed, requirePadSealable, buildContainer: buildLiveCourierContainer };
const OPEN_DEPS = { validateBundle: validateBundleForImport, requireImportable };
const COMMIT_DEPS = {
  importUnderPairLock: (vfs: Vfs, unpacked: { pairId: string; files: CourierFile[] }, label: string) =>
    importContainerUnderPairLock(vfs, unpacked, label, "browser-local-witness"),
  requireImportable
};

async function handleSpt(vfs: Vfs, req: EngineRequest, runtime: SptRuntime | undefined): Promise<EngineResponse> {
  const rt = requireRuntime(runtime);
  switch (req.op) {
    case "spt-create-request":
      return { id: req.id, ...(await createRequestImpl(vfs, rt)) };
    case "spt-cancel-request":
      return { id: req.id, ...(await cancelRequestImpl(vfs, req.requestId)) };
    case "spt-inspect-request":
      return { id: req.id, ...(await inspectRequestImpl(rt, req.text)) };
    case "spt-confirm-request":
      return { id: req.id, ...(await confirmRequestImpl(vfs, rt, req.reviewId)) };
    case "spt-seal":
      return { id: req.id, ...(await sealImpl(vfs, req.requestHash, req.pairId, SEAL_DEPS)) };
    case "spt-open-sealed":
      return { id: req.id, ...(await openSealedImpl(vfs, rt, req.package, OPEN_DEPS)) };
    case "spt-commit-receive": {
      const result = await commitReceiveImpl(vfs, rt, req.sessionId, COMMIT_DEPS);
      return { id: req.id, ...result, pair: result.pair as PairSummary };
    }
    case "spt-reject":
      return { id: req.id, ...(await rejectImpl(vfs, rt, req.sessionId)) };
    case "spt-abandon":
      return { id: req.id, ...(await abandonImpl(rt, req.sessionId)) };
    default: {
      const never: never = req as never;
      throw new Error(`unknown op ${JSON.stringify((never as { op?: unknown }).op)}`);
    }
  }
}

export async function handle(vfs: Vfs, req: EngineRequest, runtime?: SptRuntime): Promise<EngineResponse> {
  try {
    switch (req.op) {
      case "list-pairs":
        return { id: req.id, ...(await listImpl(vfs)) };
      case "gen":
        return { id: req.id, ...(await genImpl(vfs, req)) };
      case "status":
        return { id: req.id, ...(await statusImpl(vfs, req)) };
      case "burn":
        return { id: req.id, ...(await burnImpl(vfs, req)) };
      case "open":
        return { id: req.id, ...(await openImpl(vfs, req)) };
      case "retire":
        return { id: req.id, ...(await retireImpl(vfs, req)) };
      case "clear-freeze":
        return { id: req.id, ...(await clearFreezeImpl(vfs, req)) };
      case "destroy":
        return { id: req.id, ...(await destroyImpl(vfs, req)) };
      case "export-pair":
        return { id: req.id, ...(await exportImpl(vfs, req)) };
      case "import-pair":
        return { id: req.id, ...(await importImpl(vfs, req)) };
      case "spt-create-request":
      case "spt-cancel-request":
      case "spt-inspect-request":
      case "spt-confirm-request":
      case "spt-seal":
      case "spt-open-sealed":
      case "spt-commit-receive":
      case "spt-reject":
      case "spt-abandon":
        // AWAITED: returning the promise from inside this try would let a
        // refusal escape as a rejection instead of becoming a typed response.
        return await handleSpt(vfs, req, runtime);
      default: {
        const never: never = req;
        throw new Error(`unknown op ${JSON.stringify((never as { op?: unknown }).op)}`);
      }
    }
  } catch (error) {
    if (error instanceof EngineRefused) {
      return { id: req.id, op: req.op, ok: false, kind: "refused", reason: error.reason, message: error.message };
    }
    return { id: req.id, op: req.op, ok: false, kind: "error", message: (error as Error).message };
  }
}
