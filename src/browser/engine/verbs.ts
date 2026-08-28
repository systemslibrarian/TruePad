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
import { buildFrame, frameCapacity, parseFrame } from "../../core/frame2.ts";
import { combineSources, partition, requiredSourceLength } from "../../core/partition2.ts";
import type {
  DirectionMeters,
  EngineRequest,
  EngineResponse,
  EnvelopeLine,
  ManifestView,
  PairBundle,
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
import { witnessFor, type BrowserWitness } from "./witness.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const TOMBSTONE_FILE = "destroyed.json";
const PAIR_META_FILE = "pair.json";
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
type ExportResult = { ok: true; op: "export-pair"; bundle: PairBundle };
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

function bytesEqualPrefix(a: Uint8Array, b: Uint8Array, length: number): boolean {
  if (a.length < length || b.length < length) {
    return false;
  }
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
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
// caller can advance it after the durable commit. A store below its witness
// refuses `witness-regressed`; a broken witness `witness-inconsistent`.
async function witnessPreflight(vfs: Vfs, store: LoadedStore): Promise<BrowserWitness> {
  const witness = witnessFor(vfs, store.head.rollback.witnessClass);
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

type PairMeta = { pairId: string; label: string; createdAt: string };

async function readPairMeta(vfs: Vfs, pairId: string): Promise<PairMeta> {
  const bytes = await vfs.readFile(pairMetaPath(pairId));
  if (bytes !== null) {
    try {
      const parsed: unknown = JSON.parse(dec.decode(bytes));
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const label = typeof obj.label === "string" ? obj.label : pairId;
        const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";
        return { pairId, label, createdAt };
      }
    } catch {
      /* fall through to defaults */
    }
  }
  return { pairId, label: pairId, createdAt: "" };
}

async function writePairMeta(vfs: Vfs, meta: PairMeta): Promise<void> {
  await vfs.writeFileAtomic(pairMetaPath(meta.pairId), enc.encode(JSON.stringify(meta)));
}

/* ---- meters & summaries --------------------------------------------------- */

function displayWitnessClass(head: HeadV2): DirectionMeters["witness"]["class"] {
  return head.rollback.witnessClass === "browser-independent-store" ? "browser-independent-store" : "browser-none";
}

async function directionMeters(vfs: Vfs, store: LoadedStore): Promise<DirectionMeters> {
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
  const witness = witnessFor(vfs, head.rollback.witnessClass);
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
    witness: { class: displayWitnessClass(head), state }
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
    meters: { "A->B": await directionMeters(vfs, pair["A->B"]), "B->A": await directionMeters(vfs, pair["B->A"]) }
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
  // §6 platform caveat: the browser File API exposes no filesystem identity, so
  // it cannot detect two aliases of one file the way the CLI does. It de-
  // duplicates by a full byte comparison of the DECLARED sources — two sources
  // identical over the required bytes would XOR to zeros — and states the limit.
  for (let i = 0; i < req.sources.length; i += 1) {
    for (let j = i + 1; j < req.sources.length; j += 1) {
      if (bytesEqualPrefix(req.sources[i].bytes, req.sources[j].bytes, required)) {
        throw new EngineRefused(
          "duplicate-source",
          `sources "${req.sources[i].name}" and "${req.sources[j].name}" carry identical bytes over the required ` +
            `${required}, so the XOR would cancel them to zeros; one file is one source. (The browser cannot check ` +
            `filesystem identity, so it compares content — a stated limitation of this edition.) Nothing was written.`
        );
      }
    }
  }

  const declarations: SourceDeclaration[] = req.sources.map((s) => ({
    name: s.name,
    declaredOrigin: s.declaredOrigin.length > 0 ? s.declaredOrigin : "declared by operator at gen; not verified by this tool",
    lengthBytes: s.bytes.length
  }));

  const combined = combineSources(
    req.sources.map((s) => s.bytes),
    required
  );
  const slices = partition(combined, capacity, capacityRecords);
  combined.fill(0); // in-memory hygiene only; no erasure claim

  const pairId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const rollback: BrowserRollback =
    req.witnessClass === "browser-independent-store"
      ? { witnessClass: "browser-independent-store", config: {} }
      : { witnessClass: "none", config: {} };

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

  await vfs.withLock(pairId, async (): Promise<void> => {
    // §12.4: per half, secret.bin is durable before head.json and the init line.
    await initStore(vfs, storeDir(pairId, "A->B"), headFor("A->B"), secretAB);
    await initStore(vfs, storeDir(pairId, "B->A"), headFor("B->A"), secretBA);
    await writePairMeta(vfs, { pairId, label: req.label, createdAt });
    await witnessFor(vfs, rollback.witnessClass).bootstrap(pairId);
  });

  secretAB.fill(0);
  secretBA.fill(0);
  slices.abEncryption.fill(0);
  slices.abAuthentication.fill(0);
  slices.baEncryption.fill(0);
  slices.baAuthentication.fill(0);

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
    // S0 — checks, all free.
    requireNotFrozen(pair);
    const direction = directionFor(req.as, "burn");
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);
    const witness = await witnessPreflight(vfs, store);

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
    const direction = directionFor(req.as, "open");
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);

    // O0 — structural, free, before any secret is touched.
    const decoded = decodeEnvelope2(req.envelope);
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
    const witness = await witnessPreflight(vfs, store);
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
    const store = pair[direction];
    const { head, effective } = store;
    const prefix = storeDir(pairId, direction);
    const witness = await witnessPreflight(vfs, store);
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

async function exportImpl(vfs: Vfs, req: Req<"export-pair">): Promise<ExportResult> {
  const pairId = req.pairId;
  return vfs.withLock(pairId, async (): Promise<ExportResult> => {
    await requireNotDestroyed(vfs, pairId);
    await requirePair(vfs, pairId);
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const rel of BUNDLE_FILES) {
      const bytes = await vfs.readFile(`${pairId}/${rel}`);
      if (bytes === null) {
        throw new EngineRefused("corrupt-store", `${rel} is missing; the pair is not whole. Nothing was exported.`);
      }
      files.push({ path: rel, bytes });
    }
    return { ok: true, op: "export-pair", bundle: { pairId, files } };
  });
}

async function importImpl(vfs: Vfs, req: Req<"import-pair">): Promise<ImportResult> {
  const bundle = req.bundle;
  const pairId = bundle.pairId;
  if (!HEX_32.test(pairId)) {
    throw new EngineRefused("malformed-bundle", `bundle pairId must be exactly 32 lowercase hex characters (found ${JSON.stringify(pairId)}).`);
  }
  return vfs.withLock(pairId, async (): Promise<ImportResult> => {
    await requireNotDestroyed(vfs, pairId);
    if (
      (await vfs.exists(filePath(storeDir(pairId, "A->B"), HEAD_FILE))) ||
      (await vfs.exists(filePath(storeDir(pairId, "B->A"), HEAD_FILE)))
    ) {
      throw new EngineRefused(
        "pair-exists",
        `a pair with id ${pairId} already exists in this browser; importing would overwrite it. Nothing was imported.`
      );
    }
    const allowed = new Set(BUNDLE_FILES);
    for (const f of bundle.files) {
      if (!allowed.has(f.path)) {
        throw new EngineRefused("malformed-bundle", `bundle path ${JSON.stringify(f.path)} is not an allowed store file.`);
      }
      await vfs.writeFileAtomic(`${pairId}/${f.path}`, f.bytes);
    }
    const ab = await loadStore(vfs, storeDir(pairId, "A->B"));
    if (!ab.ok) {
      throw new EngineRefused(ab.reason, `imported A->B store: ${ab.message}`);
    }
    const ba = await loadStore(vfs, storeDir(pairId, "B->A"));
    if (!ba.ok) {
      throw new EngineRefused(ba.reason, `imported B->A store: ${ba.message}`);
    }
    if (ab.head.pairId !== pairId || ba.head.pairId !== pairId) {
      throw new EngineRefused("malformed-bundle", `the bundle's head.json pairId disagrees with the declared pairId ${pairId}.`);
    }
    await writePairMeta(vfs, { pairId, label: req.label, createdAt: new Date().toISOString() });
    // Align the witness to the imported store's high-waters so a fresh import
    // is not spuriously refused witness-regressed (independent-store class).
    for (const direction of ["A->B", "B->A"] as const) {
      const loaded = direction === "A->B" ? ab : ba;
      await witnessFor(vfs, loaded.head.rollback.witnessClass).advance(pairId, direction, {
        encryptionNextOffset: loaded.effective.nextOffset,
        authenticationNextSequence: loaded.effective.nextSequence,
        attemptsReserved: loaded.effective.attemptsReserved
      });
    }
    const pair = await buildSummary(vfs, pairId);
    return { ok: true, op: "import-pair", pair };
  });
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
export async function handle(vfs: Vfs, req: EngineRequest): Promise<EngineResponse> {
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
