/* ============================================================================
 * TruePad Browser Edition — the one-handoff record (worker-side)
 * ----------------------------------------------------------------------------
 * A pad may leave this installation ONCE, by ONE route. This module is the
 * durable record of that fact, and nothing else: it decides no policy, reads no
 * pad material, and knows nothing about X-Wing, TPR2, requests, or ceremonies.
 * Callers that have already passed their own gates hand it finished bytes.
 *
 * WHY THE PHASE-0.6 "ONE ATOMIC handoff.json" MODEL IS WITHDRAWN
 * -------------------------------------------------------------
 * That model required the marker, the sealed package and the confirmation value
 * to land in a single atomic replace. `OpfsVfs.writeFileAtomic()` cannot promise
 * that: it is genuinely atomic only where `FileSystemFileHandle.move()` works,
 * and otherwise falls back to truncate → write → flush, which a crash can tear.
 * Narrowing browser support to preserve the old prose would have been choosing
 * the document over the users, and pretending the fallback is atomic would have
 * been worse. The transaction is MARKER-LAST instead, which is safe under both
 * behaviours:
 *
 *     stage package.tps2  →  read back  →  stage confirm.bin  →  read back
 *                                                     →  write handoff.json
 *
 * `handoff.json` is the COMMIT POINT. Everything before it is pre-commit, by
 * invariant unreleased, and therefore safe to discard and retry. Everything
 * after it is spent.
 *
 * THE RULE THAT MATTERS MOST: EXISTENCE IS LOAD-BEARING
 * -----------------------------------------------------
 * If `handoff.json` exists but is empty, truncated, malformed, semantically
 * invalid, or merely unreadable, that is NOT "no handoff". It is
 * `unreadable-spent`. The file is never auto-deleted, never auto-repaired, and
 * never treated as absence — because the one thing a torn marker can mean is
 * that a package already left. A torn marker may cost the handoff.
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * There is deliberately no `catch { return absent }` anywhere in this file.
 *
 * WHAT LIVES WHERE
 * ----------------
 *     <pairId>/handoff.json            the permanent commit marker
 *     <pairId>/handoff/package.tps2    the exact TPS2 bytes   (sealed only)
 *     <pairId>/handoff/confirm.bin     the exact 11 bytes     (sealed only)
 *
 * None of these is Store Format v2, and none travels in the six-file courier
 * bundle. They are browser product bookkeeping about a pad, not part of it.
 *
 * All of it runs under the store's OWN pad lock, `vfs.withLock(pairId)` — never
 * a second `"spt-pad:"`-style namespace. Two lock namespaces over one pair
 * exclude nothing, which is the Phase-0.6 lesson.
 * ========================================================================= */

import { packageIdentity } from "../../spt/sealed-package.ts";
import { equalBytes, fromBase64Url, toBase64Url } from "../../spt/bytes.ts";
import { EngineRefused } from "./store.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const HANDOFF_MARKER_FILE = "handoff.json";
export const HANDOFF_DIR = "handoff";
export const HANDOFF_PACKAGE_FILE = "package.tps2";
export const HANDOFF_CONFIRM_FILE = "confirm.bin";

export const CONFIRM_VALUE_BYTES = 11;
const HASH_BYTES = 32;
const MARKER_VERSION = 1;
const HEX_32 = /^[0-9a-f]{32}$/;

export const markerPath = (pairId: string) => `${pairId}/${HANDOFF_MARKER_FILE}`;
export const handoffPackagePath = (pairId: string) => `${pairId}/${HANDOFF_DIR}/${HANDOFF_PACKAGE_FILE}`;
export const handoffConfirmPath = (pairId: string) => `${pairId}/${HANDOFF_DIR}/${HANDOFF_CONFIRM_FILE}`;

/* ---- the marker ----------------------------------------------------------- */

export type HandoffMode = "physical" | "sealed";

export type PhysicalMarker = { version: 1; pairId: string; mode: "physical"; at: string };

export type SealedMarker = {
  version: 1;
  pairId: string;
  mode: "sealed";
  at: string;
  requestHash: string;
  packageIdentity: string;
  confirmHash: string;
};

export type HandoffMarker = PhysicalMarker | SealedMarker;

export type HandoffState =
  | { kind: "absent" }
  | { kind: "physical"; marker: PhysicalMarker }
  | { kind: "sealed"; marker: SealedMarker; packageAvailable: boolean; confirmationAvailable: boolean }
  /** The file exists and cannot be trusted. NOT absence. */
  | { kind: "unreadable-spent"; message: string };

export const REFUSE_UNREADABLE = "handoff-state-unreadable";
export const REFUSE_ALREADY_SEALED = "pad-already-sealed";
export const REFUSE_ALREADY_HANDED_OFF = "pad-already-handed-off";
export const REFUSE_UNRECOVERABLE = "handoff-unrecoverable";

/** The one sentence the operator gets about a torn marker. It says what TruePad
 *  does not know and what it therefore will not do — and deliberately does not
 *  suggest deleting the file, because deleting it is exactly the action that
 *  would turn a lost handoff into a reused pad. */
export const UNREADABLE_ADVICE =
  "TruePad cannot safely determine this pad's handoff state, so it refuses to create another copy. " +
  "A record of a handoff exists but cannot be read. Generate a new pad for any further transfer.";

/* ---- canonical encodings -------------------------------------------------- */

/** Canonical unpadded base64url of exactly 32 bytes, decoded and re-encoded to
 *  refuse a second spelling of the same value. */
function decodeHash32(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  const bytes = fromBase64Url(value);
  if (bytes === null) throw new Error(`${field} is not canonical unpadded base64url`);
  if (bytes.length !== HASH_BYTES) throw new Error(`${field} decodes to ${bytes.length} bytes, expected ${HASH_BYTES}`);
  if (toBase64Url(bytes) !== value) throw new Error(`${field} has a non-canonical base64url spelling`);
  return bytes;
}

/** The exact `YYYY-MM-DDTHH:mm:ss.sssZ` form, checked by round-trip so no other
 *  spelling of the same instant is accepted. */
function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} is not a canonical ISO-8601 timestamp`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PHYSICAL_KEYS = ["version", "pairId", "mode", "at"] as const;
const SEALED_KEYS = ["version", "pairId", "mode", "at", "requestHash", "packageIdentity", "confirmHash"] as const;

/** Serialize with the frozen property order. Built from an ordered list rather
 *  than an object literal so the order is a fact of the code, not of the
 *  engine's key-insertion behaviour. */
function serializeMarker(marker: HandoffMarker): Uint8Array {
  const keys = marker.mode === "sealed" ? SEALED_KEYS : PHYSICAL_KEYS;
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify((marker as Record<string, unknown>)[k])}`);
  return enc.encode(`{${parts.join(",")}}`);
}

/** Strict parse. Every failure throws; NOTHING here defaults, coerces, or
 *  tolerates an extra field. A reader that shrugged at an unexpected key would
 *  be a reader that could be handed a physical marker wearing sealed clothes. */
export function parseMarker(bytes: Uint8Array, pairId: string): HandoffMarker {
  if (bytes.length === 0) throw new Error("the handoff marker is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error("the handoff marker does not parse as JSON");
  }
  if (!isRecord(parsed)) throw new Error("the handoff marker is not a JSON object");
  if (parsed.version !== MARKER_VERSION) throw new Error(`unsupported handoff marker version`);
  if (typeof parsed.pairId !== "string" || !HEX_32.test(parsed.pairId)) {
    throw new Error("the handoff marker has no valid pairId");
  }
  if (parsed.pairId !== pairId) throw new Error("the handoff marker names a different pair");
  if (parsed.mode !== "physical" && parsed.mode !== "sealed") {
    throw new Error("the handoff marker has an unsupported mode");
  }
  const at = requireIsoTimestamp(parsed.at, "at");
  const expected: readonly string[] = parsed.mode === "sealed" ? SEALED_KEYS : PHYSICAL_KEYS;
  const actual = Object.keys(parsed).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    // Catches BOTH a physical marker carrying sealed-only fields and a sealed
    // marker missing one.
    throw new Error(`the handoff marker's fields do not match mode ${parsed.mode}`);
  }
  if (parsed.mode === "physical") {
    return { version: MARKER_VERSION, pairId, mode: "physical", at };
  }
  decodeHash32(parsed.requestHash, "requestHash");
  decodeHash32(parsed.packageIdentity, "packageIdentity");
  decodeHash32(parsed.confirmHash, "confirmHash");
  return {
    version: MARKER_VERSION,
    pairId,
    mode: "sealed",
    at,
    requestHash: parsed.requestHash as string,
    packageIdentity: parsed.packageIdentity as string,
    confirmHash: parsed.confirmHash as string
  };
}

/* ---- reading state -------------------------------------------------------- */

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBufferView<ArrayBuffer>));
}

/** Read a file, distinguishing "not there" from "could not be read". The
 *  distinction is the whole point: `null` is absence, a throw is not. */
async function readOrThrow(vfs: Vfs, path: string): Promise<Uint8Array | null> {
  return vfs.readFile(path);
}

/** The pad's handoff state. Callers hold `vfs.withLock(pairId)`.
 *
 *  There is no path from a present-but-bad marker to `absent`. A read that
 *  throws becomes `unreadable-spent`, not a swallowed error, because the one
 *  interpretation that is never safe is "so there was no handoff". */
export async function readHandoffState(vfs: Vfs, pairId: string): Promise<HandoffState> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readOrThrow(vfs, markerPath(pairId));
  } catch (error) {
    return { kind: "unreadable-spent", message: `${UNREADABLE_ADVICE} (${(error as Error).message})` };
  }
  if (bytes === null) return { kind: "absent" };

  let marker: HandoffMarker;
  try {
    marker = parseMarker(bytes, pairId);
  } catch (error) {
    return { kind: "unreadable-spent", message: `${UNREADABLE_ADVICE} (${(error as Error).message})` };
  }
  if (marker.mode === "physical") return { kind: "physical", marker };

  // Availability, not validity: a dismissed payload is a normal, intended
  // state (§12) and does not make the marker unreadable.
  let packageAvailable = false;
  let confirmationAvailable = false;
  try {
    packageAvailable = await vfs.exists(handoffPackagePath(pairId));
    confirmationAvailable = await vfs.exists(handoffConfirmPath(pairId));
  } catch (error) {
    return { kind: "unreadable-spent", message: `${UNREADABLE_ADVICE} (${(error as Error).message})` };
  }
  return { kind: "sealed", marker, packageAvailable, confirmationAvailable };
}

/** Turn a state into the refusal a caller that must not create another copy
 *  should raise, or `null` when the state permits the operation. */
export function refusalForNewHandoff(state: HandoffState): EngineRefused | null {
  switch (state.kind) {
    case "absent":
      return null;
    case "physical":
      return new EngineRefused(
        REFUSE_ALREADY_HANDED_OFF,
        "This pad has already been handed off by the physical route, so it cannot also be sent by sealed transfer. " +
          "Generate a new pad for that."
      );
    case "sealed":
      return new EngineRefused(
        REFUSE_ALREADY_SEALED,
        "This pad has already been sent by sealed transfer, so it cannot be handed off again. " +
          "Generate a new pad for any further transfer."
      );
    case "unreadable-spent":
      return new EngineRefused(REFUSE_UNREADABLE, state.message);
  }
}

/* ---- pre-commit staging --------------------------------------------------- */

/** Remove staged payload files. Safe ONLY when no marker exists: by the
 *  marker-last invariant, staging without a marker was never released through
 *  any caller-visible path, so discarding it loses nothing. With a marker
 *  present — valid or torn — this must never run: the marker means spent, and
 *  the staged bytes may be the only copy of what the recipient was given. */
export async function cleanPreCommitStaging(vfs: Vfs, pairId: string): Promise<void> {
  const state = await readHandoffState(vfs, pairId);
  if (state.kind !== "absent") {
    throw new EngineRefused(
      state.kind === "unreadable-spent" ? REFUSE_UNREADABLE : REFUSE_ALREADY_SEALED,
      state.kind === "unreadable-spent"
        ? state.message
        : "This pad's handoff is already committed; its staged files are not orphans and are not removed."
    );
  }
  await vfs.remove(handoffPackagePath(pairId));
  await vfs.remove(handoffConfirmPath(pairId));
}

/* ---- committing ----------------------------------------------------------- */

/** Write the marker, read it back, and strict-parse what came back.
 *
 *  The two failures here are NOT the same failure, and the difference decides
 *  whether the pad may ever be handed off again:
 *
 *    · the write throws and NO marker file exists — nothing committed, the pad
 *      is still free, and a retry is legitimate. This propagates as the
 *      underlying error; the caller's next `readHandoffState` will say `absent`.
 *
 *    · a marker file EXISTS and cannot be validated — truncated by the
 *      non-atomic fallback, or otherwise unverifiable. The pad is SPENT, and
 *      the immediate call must say so in the same typed terms a later read
 *      would, rather than letting a generic parse error escape and read like a
 *      retryable storage hiccup.
 *
 *  The durable state was always safe — a later `readHandoffState` sees
 *  `unreadable-spent` either way — so this is a reporting fix, not a reuse fix.
 *  It matters because the immediate caller is the one deciding whether to hand
 *  bytes to an operator.
 *
 *  Which case occurred is decided by LOOKING, never by assuming from the shape
 *  of an exception. And the marker is never deleted and never rewritten to
 *  "recover": that is the action that turns a lost handoff into a reused pad. */
async function writeAndVerifyMarker(vfs: Vfs, pairId: string, marker: HandoffMarker): Promise<HandoffMarker> {
  try {
    await vfs.writeFileAtomic(markerPath(pairId), serializeMarker(marker));
  } catch (error) {
    // Ask the disk which case this is rather than guessing from the throw.
    let landed = false;
    try {
      landed = (await vfs.readFile(markerPath(pairId))) !== null;
    } catch {
      // Cannot even tell. A record may exist; refuse as spent.
      landed = true;
    }
    if (!landed) throw error; // nothing committed — the pad is still free
    throw new EngineRefused(
      REFUSE_UNREADABLE,
      `${UNREADABLE_ADVICE} (writing the handoff record failed after it had begun: ${(error as Error).message})`
    );
  }
  const readBack = await vfs.readFile(markerPath(pairId));
  if (readBack === null) {
    throw new EngineRefused(
      REFUSE_UNREADABLE,
      `${UNREADABLE_ADVICE} (the handoff record did not survive being written)`
    );
  }
  try {
    return parseMarker(readBack, pairId);
  } catch (error) {
    // A record EXISTS and is not valid. Typed, and never retryable.
    throw new EngineRefused(
      REFUSE_UNREADABLE,
      `${UNREADABLE_ADVICE} (the handoff record read back invalid: ${(error as Error).message})`
    );
  }
}

/** Record a PHYSICAL handoff. The caller must already hold the pad lock, have
 *  checked provenance, and have confirmed there is no marker. */
export async function commitPhysicalHandoff(vfs: Vfs, pairId: string, at: string): Promise<PhysicalMarker> {
  const marker: PhysicalMarker = { version: MARKER_VERSION, pairId, mode: "physical", at };
  const verified = await writeAndVerifyMarker(vfs, pairId, marker);
  if (verified.mode !== "physical") {
    throw new EngineRefused(REFUSE_UNREADABLE, `${UNREADABLE_ADVICE} (the record read back with the wrong mode)`);
  }
  return verified;
}

export type SealedHandoffInput = {
  /** The exact TPS2 bytes, stored verbatim: no base64, no JSON, no compression,
   *  no normalization. */
  packageBytes: Uint8Array;
  /** 32 bytes. */
  requestHash: Uint8Array;
  /** Exactly 11 bytes — the value, never words and never indices. */
  confirmValue: Uint8Array;
  /** 32 bytes, and required to equal SHA-256(packageBytes): the Phase-1A
   *  definition, checked here rather than redefined. */
  packageIdentity: Uint8Array;
};

/** The marker-last sealed transaction (§10 of the Phase 1B brief).
 *
 *  STORAGE ONLY. It does not parse TPR2, generate keys, encapsulate, choose a
 *  pad, judge genesis eligibility, or verify any human ceremony — Phase 1C owns
 *  every one of those. It persists bytes a caller has already produced, under
 *  the one-handoff rule, and refuses if a handoff already exists.
 *
 *  The caller must hold `vfs.withLock(pairId)`. */
export async function commitSealedHandoff(
  vfs: Vfs,
  pairId: string,
  input: SealedHandoffInput,
  at: string
): Promise<SealedMarker> {
  if (input.confirmValue.length !== CONFIRM_VALUE_BYTES) {
    throw new EngineRefused("bad-request", `confirmValue must be exactly ${CONFIRM_VALUE_BYTES} bytes`);
  }
  if (input.requestHash.length !== HASH_BYTES || input.packageIdentity.length !== HASH_BYTES) {
    throw new EngineRefused("bad-request", `requestHash and packageIdentity must be ${HASH_BYTES} bytes`);
  }

  // 1 — a handoff must not already exist, in any state.
  const before = await readHandoffState(vfs, pairId);
  const refusal = refusalForNewHandoff(before);
  if (refusal !== null) throw refusal;

  // 2 — only NOW, with no marker present, are staged files provably pre-commit.
  await vfs.remove(handoffPackagePath(pairId));
  await vfs.remove(handoffConfirmPath(pairId));

  // 3, 4 — stage the package and read it back byte-for-byte.
  await vfs.writeFileAtomic(handoffPackagePath(pairId), input.packageBytes);
  const storedPackage = await vfs.readFile(handoffPackagePath(pairId));
  if (storedPackage === null || !equalBytes(storedPackage, input.packageBytes)) {
    throw new EngineRefused("storage-failed", "the sealed package did not store intact; nothing was committed.");
  }

  // 5 — the identity the caller supplied must be the identity of what is on
  // disk. One definition of that hash, imported from where it was frozen.
  const identity = await packageIdentity(storedPackage);
  if (!equalBytes(identity, input.packageIdentity)) {
    throw new EngineRefused("storage-failed", "the stored package does not match its supplied identity.");
  }

  // 6, 7 — stage the confirmation value and read it back.
  await vfs.writeFileAtomic(handoffConfirmPath(pairId), input.confirmValue);
  const storedConfirm = await vfs.readFile(handoffConfirmPath(pairId));
  if (storedConfirm === null || !equalBytes(storedConfirm, input.confirmValue)) {
    throw new EngineRefused("storage-failed", "the confirmation value did not store intact; nothing was committed.");
  }

  // 8, 9, 10 — build the marker and write it LAST. This is the commit point.
  const marker: SealedMarker = {
    version: MARKER_VERSION,
    pairId,
    mode: "sealed",
    at,
    requestHash: toBase64Url(input.requestHash),
    packageIdentity: toBase64Url(identity),
    confirmHash: toBase64Url(await sha256(storedConfirm))
  };
  // 11 — written, read back, strict-parsed.
  const verified = await writeAndVerifyMarker(vfs, pairId, marker);
  if (verified.mode !== "sealed") {
    throw new EngineRefused(REFUSE_UNREADABLE, `${UNREADABLE_ADVICE} (the record read back with the wrong mode)`);
  }
  // 12 — and the marker must describe the bytes actually staged.
  if (
    verified.packageIdentity !== marker.packageIdentity ||
    verified.confirmHash !== marker.confirmHash ||
    verified.requestHash !== marker.requestHash
  ) {
    throw new EngineRefused(REFUSE_UNREADABLE, `${UNREADABLE_ADVICE} (the record read back with different contents)`);
  }
  // 13 — only now may a caller be handed package bytes or confirmation data.
  return verified;
}

export type CommittedSealedHandoff = {
  marker: SealedMarker;
  packageBytes: Uint8Array;
  confirmValue: Uint8Array;
};

/** Re-read a committed sealed handoff and verify both payload files against the
 *  marker. This is how a retry after a crash returns the EXACT original package
 *  and confirmation instead of re-encapsulating: the bytes are on disk and the
 *  marker says which bytes they must be.
 *
 *  If the marker is valid but a payload is missing or does not match, the pad is
 *  spent AND unrecoverable. That is a real, permanent loss, and it is still not
 *  a reason to seal again. */
export async function loadCommittedSealedHandoff(vfs: Vfs, pairId: string): Promise<CommittedSealedHandoff> {
  const state = await readHandoffState(vfs, pairId);
  if (state.kind !== "sealed") {
    const refusal = refusalForNewHandoff(state);
    throw refusal ?? new EngineRefused(REFUSE_UNRECOVERABLE, "this pad has no committed sealed handoff.");
  }
  const packageBytes = await vfs.readFile(handoffPackagePath(pairId));
  const confirmValue = await vfs.readFile(handoffConfirmPath(pairId));
  if (packageBytes === null || confirmValue === null) {
    throw new EngineRefused(
      REFUSE_UNRECOVERABLE,
      "This pad's handoff is committed, but the sealed package is no longer stored, so it cannot be produced again. " +
        "The pad stays handed off; generate a new pad for any further transfer."
    );
  }
  const identity = await packageIdentity(packageBytes);
  if (toBase64Url(identity) !== state.marker.packageIdentity) {
    throw new EngineRefused(
      REFUSE_UNRECOVERABLE,
      "This pad's stored sealed package does not match the committed record, so it cannot be produced again. " +
        "The pad stays handed off; generate a new pad for any further transfer."
    );
  }
  if (confirmValue.length !== CONFIRM_VALUE_BYTES || toBase64Url(await sha256(confirmValue)) !== state.marker.confirmHash) {
    throw new EngineRefused(
      REFUSE_UNRECOVERABLE,
      "This pad's stored confirmation value does not match the committed record. " +
        "The pad stays handed off; generate a new pad for any further transfer."
    );
  }
  return { marker: state.marker, packageBytes, confirmValue };
}

/** Drop the sealed payload while KEEPING the marker. The pad stays permanently
 *  handed off; what is discarded is only the ability to hand the same package
 *  over again. A same-request re-share correctly becomes unavailable, and no
 *  new package may be created in its place. */
export async function dismissSealedPayload(vfs: Vfs, pairId: string): Promise<void> {
  const state = await readHandoffState(vfs, pairId);
  if (state.kind === "unreadable-spent") throw new EngineRefused(REFUSE_UNREADABLE, state.message);
  if (state.kind !== "sealed") {
    throw new EngineRefused(REFUSE_UNRECOVERABLE, "this pad has no committed sealed handoff to dismiss.");
  }
  await vfs.remove(handoffPackagePath(pairId));
  await vfs.remove(handoffConfirmPath(pairId));
  // handoff.json is NOT removed. Not here, not anywhere.
}
