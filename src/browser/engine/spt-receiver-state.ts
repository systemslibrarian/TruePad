/* ============================================================================
 * TruePad Browser Edition — receiver request state (worker-side)
 * ----------------------------------------------------------------------------
 * The recipient of a sealed transfer holds a ONE-TIME X-Wing decapsulation key.
 * Its whole security value is that it decapsulates once:
 *
 *     create → PENDING → CANCELLED  or  CONSUMED,  and never PENDING again.
 *
 * WHY THIS IS NOT A state.json
 * ----------------------------
 * The obvious shape — one mutable record rewritten `PENDING` → `CONSUMED` — is
 * unavailable here. `OpfsVfs.writeFileAtomic()` is genuinely atomic only where
 * `FileSystemFileHandle.move()` works; elsewhere it truncates, writes and
 * flushes the target in place. A torn rewrite of that record would leave a file
 * that is neither value, and the failure mode of guessing wrong is
 * **resurrecting a one-time key**.
 *
 * So the representation is immutable creation plus existence-based terminal
 * markers, the same conservative shape as `handoff.json` and the request claim:
 *
 *     spt/receive/<requestIdHex>/request.json    creation + publication marker
 *     spt/receive/<requestIdHex>/dk.bin          the 32-byte X-Wing seed
 *     spt/receive/<requestIdHex>/cancelled.json  terminal, by existence
 *     spt/receive/<requestIdHex>/consumed.json   terminal, by existence
 *
 * Nothing is ever rewritten. A terminal marker is created, never a state
 * transitioned, and no code path deletes one.
 *
 *     EXISTENCE IS LOAD-BEARING.
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * A torn terminal marker costs the transfer. That is the correct trade: the
 * alternative is a recipient key that decapsulates a second package.
 *
 * FOUR SEPARATE AUTHORITIES, NOT TO BE CONFLATED
 * ----------------------------------------------
 *   1. sender CONFIRMED       — the operator's declaration that words matched
 *   2. sender request CLAIM   — spt/claims/…      one request, one package
 *   3. sender pair HANDOFF    — <pairId>/handoff.json  one pad, one handoff
 *   4. receiver request state — THIS module       one request, one decapsulation
 *
 * (2) and (4) both concern a request and are still different things: (2) lives
 * in the SENDER's origin and binds a request to a pad; (4) lives in the
 * RECIPIENT's origin and governs their private key. Neither can see the other.
 *
 * STORAGE ONLY. Nothing here parses TPS2, decapsulates, opens a package, runs a
 * session, or decides a ceremony. Phase 1C owns all of that; §22 and §23 of this
 * file's header record the contracts it must honour.
 * ========================================================================= */

import { bytesToHex } from "../../core/hex.ts";
import { equalBytes, fromBase64Url, toBase64Url } from "../../spt/bytes.ts";
import { requestFingerprint } from "../../spt/fingerprint.ts";
import { parseRequestBody } from "../../spt/receive-request.ts";
import { TPR2_BODY_BYTES, XWING_SEED_BYTES } from "../../spt/constants.ts";
import { EngineRefused } from "./store.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const RECEIVE_ROOT = "spt/receive";
export const REQUEST_FILE = "request.json";
export const DK_FILE = "dk.bin";
export const CANCELLED_FILE = "cancelled.json";
export const CONSUMED_FILE = "consumed.json";

const RECORD_VERSION = 1;
const HASH_BYTES = 32;
const REQUEST_ID_BYTES = 16;
const HEX_32 = /^[0-9a-f]{32}$/;

/** Exactly seven days, as an instant difference. Not "the same clock time seven
 *  calendar days later" — that is a different quantity across a DST boundary,
 *  and a TTL that stretches by an hour twice a year is a TTL nobody specified. */
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REFUSE_RECEIVE_STATE = "receive-request-state";
export const REFUSE_ID_UNAVAILABLE = "request-id-unavailable";

export const receiveDir = (requestIdHex: string): string => `${RECEIVE_ROOT}/${requestIdHex}`;
export const requestPath = (id: string): string => `${receiveDir(id)}/${REQUEST_FILE}`;
export const dkPath = (id: string): string => `${receiveDir(id)}/${DK_FILE}`;
export const cancelledPath = (id: string): string => `${receiveDir(id)}/${CANCELLED_FILE}`;
export const consumedPath = (id: string): string => `${receiveDir(id)}/${CONSUMED_FILE}`;

export type CancelReason = "operator" | "expired" | "rejected";

export type ReceiverState =
  | { kind: "absent" }
  | {
      kind: "pending";
      requestId: string;
      requestHash: Uint8Array;
      body: Uint8Array;
      createdAt: string;
      expiresAt: string;
      /** A COPY. Only a valid, unexpired PENDING ever carries one. */
      dk: Uint8Array;
    }
  | {
      kind: "expired-pending";
      requestId: string;
      requestHash: Uint8Array;
      body: Uint8Array;
      createdAt: string;
      expiresAt: string;
    }
  | { kind: "cancelled"; requestId: string; reason: CancelReason; at: string }
  | { kind: "consumed"; requestId: string; pairId: string; packageIdentity: Uint8Array; at: string }
  /** The namespace holds something, and it is not a usable request. Never
   *  `absent`, because absence is what would license reusing the requestId. */
  | { kind: "unusable"; message: string }
  | { kind: "terminal-unreadable"; message: string }
  | { kind: "terminal-inconsistent"; message: string };

export const TERMINAL_ADVICE =
  "TruePad cannot safely determine whether this receive request was already used, so it will not use its " +
  "one-time key again. Ask for a new receive request.";

/* ---- shared validators ---------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} is not a canonical ISO-8601 timestamp`);
  }
  return value;
}

function decodeExact(value: unknown, length: number, field: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  const bytes = fromBase64Url(value);
  if (bytes === null) throw new Error(`${field} is not canonical unpadded base64url`);
  if (bytes.length !== length) throw new Error(`${field} decodes to ${bytes.length} bytes, expected ${length}`);
  if (toBase64Url(bytes) !== value) throw new Error(`${field} has a non-canonical base64url spelling`);
  return bytes;
}

function requireExactKeys(parsed: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(parsed).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    throw new Error(`the ${what}'s fields are wrong`);
  }
}

function serialize(order: readonly string[], record: Record<string, unknown>): Uint8Array {
  return enc.encode(`{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(",")}}`);
}

function parseJsonObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  if (bytes.length === 0) throw new Error(`the ${what} is empty`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error(`the ${what} does not parse as JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`the ${what} is not a JSON object`);
  if (parsed.version !== RECORD_VERSION) throw new Error(`unsupported ${what} version`);
  return parsed;
}

/* ---- request.json --------------------------------------------------------- */

const REQUEST_KEYS = ["version", "requestId", "requestHash", "body", "createdAt", "expiresAt"] as const;

export type StoredRequest = {
  requestId: string;
  requestHash: Uint8Array;
  body: Uint8Array;
  createdAt: string;
  expiresAt: string;
};

/** Strict parse AND full re-derivation. §21: a persisted request is not trusted
 *  because its JSON parsed. Every relationship is recomputed on every read —
 *  the body is re-parsed as a canonical TPR2 body, its embedded requestId must
 *  equal the path, and the stored `requestHash` must equal the hash recomputed
 *  from the body. A `request.json` copied from one request's directory into
 *  another's must never cause request R's `dk` to be used against body B′. */
export async function parseStoredRequest(bytes: Uint8Array, requestIdHex: string): Promise<StoredRequest> {
  const parsed = parseJsonObject(bytes, REQUEST_FILE);
  requireExactKeys(parsed, REQUEST_KEYS, REQUEST_FILE);

  if (typeof parsed.requestId !== "string" || !HEX_32.test(parsed.requestId)) {
    throw new Error("requestId is not 32 lowercase hex characters");
  }
  if (parsed.requestId !== requestIdHex) throw new Error("the record names a different request");

  const requestHash = decodeExact(parsed.requestHash, HASH_BYTES, "requestHash");
  const body = decodeExact(parsed.body, TPR2_BODY_BYTES, "body");

  const createdAt = requireIso(parsed.createdAt, "createdAt");
  const expiresAt = requireIso(parsed.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("expiresAt is not after createdAt");

  // The body must be a canonical §5.1 request in its own right.
  const request = parseRequestBody(body);
  if (!request.ok) throw new Error(`the stored body is not a canonical request: ${request.message}`);
  if (bytesToHex(request.request.requestId) !== requestIdHex) {
    throw new Error("the stored body names a different request");
  }
  // ...and the fingerprint must be the fingerprint OF THAT BODY.
  const recomputed = await requestFingerprint(body);
  if (!equalBytes(recomputed, requestHash)) {
    throw new Error("the stored requestHash is not the hash of the stored body");
  }
  return { requestId: requestIdHex, requestHash, body, createdAt, expiresAt };
}

/* ---- terminal markers ----------------------------------------------------- */

const CANCELLED_KEYS = ["version", "requestId", "at", "reason"] as const;
const CONSUMED_KEYS = ["version", "requestId", "at", "pairId", "packageIdentity"] as const;

export type CancelledMarker = { requestId: string; at: string; reason: CancelReason };
export type ConsumedMarker = { requestId: string; at: string; pairId: string; packageIdentity: Uint8Array };

function isCancelReason(value: unknown): value is CancelReason {
  return value === "operator" || value === "expired" || value === "rejected";
}

export function parseCancelled(bytes: Uint8Array, requestIdHex: string): CancelledMarker {
  const parsed = parseJsonObject(bytes, CANCELLED_FILE);
  requireExactKeys(parsed, CANCELLED_KEYS, CANCELLED_FILE);
  if (parsed.requestId !== requestIdHex) throw new Error("the marker names a different request");
  if (typeof parsed.requestId !== "string" || !HEX_32.test(parsed.requestId)) throw new Error("bad requestId");
  const at = requireIso(parsed.at, "at");
  if (!isCancelReason(parsed.reason)) throw new Error("unrecognised cancellation reason");
  return { requestId: requestIdHex, at, reason: parsed.reason };
}

export function parseConsumed(bytes: Uint8Array, requestIdHex: string): ConsumedMarker {
  const parsed = parseJsonObject(bytes, CONSUMED_FILE);
  requireExactKeys(parsed, CONSUMED_KEYS, CONSUMED_FILE);
  if (parsed.requestId !== requestIdHex) throw new Error("the marker names a different request");
  if (typeof parsed.requestId !== "string" || !HEX_32.test(parsed.requestId)) throw new Error("bad requestId");
  const at = requireIso(parsed.at, "at");
  if (typeof parsed.pairId !== "string" || !HEX_32.test(parsed.pairId)) throw new Error("bad pairId");
  const packageIdentity = decodeExact(parsed.packageIdentity, HASH_BYTES, "packageIdentity");
  return { requestId: requestIdHex, at, pairId: parsed.pairId, packageIdentity };
}

/* ---- namespace occupancy -------------------------------------------------- */

/** Does ANYTHING live under this requestId? A valid request, a terminal marker,
 *  an orphan `dk.bin`, a torn `request.json`, junk from a failed creation — all
 *  count. §7: a requestId whose namespace has ever held anything is unavailable
 *  forever, and is never cleaned up for reuse. 128 bits makes honest collision
 *  negligible; this rule exists to remove state ambiguity, not to improve the
 *  randomness. */
export async function namespaceOccupied(vfs: Vfs, requestIdHex: string): Promise<boolean> {
  const entries = await vfs.list(receiveDir(requestIdHex));
  return entries.length > 0;
}

/* ---- reading state -------------------------------------------------------- */

function terminalUnreadable(detail: string): ReceiverState {
  return { kind: "terminal-unreadable", message: `${TERMINAL_ADVICE} (${detail})` };
}

/** The receiver's durable state.
 *
 *  §9's precedence is not negotiable and is implemented in exactly this order:
 *  terminal markers are examined BEFORE any private-key material is looked at,
 *  and a terminal marker that exists always beats a still-present `dk.bin`.
 *  There is no path from "the marker is bad" to "so try request.json instead" —
 *  a corrupt terminal marker is terminal.
 *
 *  `now` is required rather than defaulted: expiry decides whether a one-time
 *  key is handed out, and the instant that decision is made against should be
 *  the caller's explicit choice, not an ambient clock read buried here. */
export async function readReceiverState(vfs: Vfs, requestIdHex: string, now: Date): Promise<ReceiverState> {
  if (!HEX_32.test(requestIdHex)) {
    return { kind: "unusable", message: "a requestId is exactly 32 lowercase hex characters" };
  }

  let hasCancelled: boolean;
  let hasConsumed: boolean;
  try {
    hasCancelled = await vfs.exists(cancelledPath(requestIdHex));
    hasConsumed = await vfs.exists(consumedPath(requestIdHex));
  } catch (error) {
    // Cannot tell whether a terminal marker exists. Fail closed.
    return terminalUnreadable((error as Error).message);
  }

  if (hasCancelled && hasConsumed) {
    return {
      kind: "terminal-inconsistent",
      message: `${TERMINAL_ADVICE} (this request carries both a cancellation and a consumption record)`
    };
  }

  if (hasCancelled) {
    try {
      const bytes = await vfs.readFile(cancelledPath(requestIdHex));
      if (bytes === null) return terminalUnreadable("the cancellation record vanished while being read");
      const marker = parseCancelled(bytes, requestIdHex);
      return { kind: "cancelled", requestId: requestIdHex, reason: marker.reason, at: marker.at };
    } catch (error) {
      return terminalUnreadable((error as Error).message);
    }
  }

  if (hasConsumed) {
    try {
      const bytes = await vfs.readFile(consumedPath(requestIdHex));
      if (bytes === null) return terminalUnreadable("the consumption record vanished while being read");
      const marker = parseConsumed(bytes, requestIdHex);
      return {
        kind: "consumed",
        requestId: requestIdHex,
        pairId: marker.pairId,
        packageIdentity: marker.packageIdentity,
        at: marker.at
      };
    } catch (error) {
      return terminalUnreadable((error as Error).message);
    }
  }

  // No terminal marker. Only now is the creation state examined.
  let requestBytes: Uint8Array | null;
  try {
    requestBytes = await vfs.readFile(requestPath(requestIdHex));
  } catch (error) {
    return { kind: "unusable", message: `this receive request cannot be read (${(error as Error).message})` };
  }

  if (requestBytes === null) {
    // Absent ONLY if the namespace is genuinely empty. Residue — an orphan
    // dk.bin, junk from a failed creation — is `unusable`, because reporting it
    // as absence is what would license reusing the requestId.
    let occupied: boolean;
    try {
      occupied = await namespaceOccupied(vfs, requestIdHex);
    } catch {
      occupied = true;
    }
    return occupied
      ? { kind: "unusable", message: "this receive request was never completed and cannot be used" }
      : { kind: "absent" };
  }

  let stored: StoredRequest;
  try {
    stored = await parseStoredRequest(requestBytes, requestIdHex);
  } catch (error) {
    return { kind: "unusable", message: `this receive request is not usable (${(error as Error).message})` };
  }

  let dk: Uint8Array | null;
  try {
    dk = await vfs.readFile(dkPath(requestIdHex));
  } catch (error) {
    return { kind: "unusable", message: `this receive request's key cannot be read (${(error as Error).message})` };
  }
  if (dk === null || dk.length !== XWING_SEED_BYTES) {
    return { kind: "unusable", message: "this receive request's key is missing or the wrong size" };
  }

  const expired = now.getTime() >= Date.parse(stored.expiresAt);
  if (expired) {
    // Deliberately WITHOUT a dk. An expired request is not usable, and the read
    // API must not be the thing that hands out the key anyway (§19).
    return {
      kind: "expired-pending",
      requestId: stored.requestId,
      requestHash: stored.requestHash,
      body: stored.body,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    };
  }

  return {
    kind: "pending",
    requestId: stored.requestId,
    requestHash: stored.requestHash,
    body: stored.body,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    dk: dk.slice() // a COPY; the caller owns it and zeroizes it
  };
}

/* ---- creation ------------------------------------------------------------- */

export type PendingRequestInput = {
  /** The exact canonical 1235-byte TPR2 body. */
  body: Uint8Array;
  /** 16 bytes. */
  requestId: Uint8Array;
  /** 32 bytes; must be the hash of `body`. */
  requestHash: Uint8Array;
  /** The 32-byte X-Wing seed — the only persisted private representation. */
  dk: Uint8Array;
  createdAt: string;
  /** Exactly `createdAt` + 7 days. */
  expiresAt: string;
};

function refuse(message: string): never {
  throw new EngineRefused(REFUSE_RECEIVE_STATE, message);
}

/** `requireIso` throws a plain Error, which is right on the READ path — it is
 *  caught there and becomes `unusable`. On a WRITE path a caller's bad argument
 *  should arrive as a typed refusal like every other input check, not as a raw
 *  throw that skips the refusal contract. */
function refuseUnlessIso(value: string, field: string): string {
  try {
    return requireIso(value, field);
  } catch (error) {
    return refuse((error as Error).message);
  }
}

/** Create a PENDING receive request, request.json LAST.
 *
 *  `request.json` is the creation AND publication commit marker: no TPR2 may
 *  cross the worker boundary until this function has returned, because a
 *  published request whose key did not survive is a request the recipient can
 *  never answer. Every relationship is re-verified from what came back off the
 *  disk, not from what we meant to write. */
export async function commitPendingReceiveRequest(vfs: Vfs, input: PendingRequestInput): Promise<StoredRequest> {
  const { body, requestId, requestHash, dk, createdAt, expiresAt } = input;

  if (requestId.length !== REQUEST_ID_BYTES) refuse(`requestId must be ${REQUEST_ID_BYTES} bytes`);
  const requestIdHex = bytesToHex(requestId);
  if (!HEX_32.test(requestIdHex)) refuse("requestId must render as 32 lowercase hex characters");
  if (dk.length !== XWING_SEED_BYTES) refuse(`the decapsulation seed must be exactly ${XWING_SEED_BYTES} bytes`);
  if (requestHash.length !== HASH_BYTES) refuse(`requestHash must be ${HASH_BYTES} bytes`);

  // 1, 2 — the body is a canonical request, and it is THIS request.
  const parsedBody = parseRequestBody(body);
  if (!parsedBody.ok) refuse(`the request body is not canonical: ${parsedBody.message}`);
  if (!equalBytes(parsedBody.request.requestId, requestId)) {
    refuse("the request body names a different requestId");
  }
  // 3 — and the supplied hash is the hash of that body.
  if (!equalBytes(await requestFingerprint(body), requestHash)) {
    refuse("the supplied requestHash is not the hash of the supplied body");
  }
  // 5 — exactly seven days, as an instant difference.
  refuseUnlessIso(createdAt, "createdAt");
  refuseUnlessIso(expiresAt, "expiresAt");
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== REQUEST_TTL_MS) {
    refuse("expiresAt must be exactly seven days after createdAt");
  }

  // 6 — the namespace must never have held anything. It is not cleaned up.
  if (await namespaceOccupied(vfs, requestIdHex)) {
    throw new EngineRefused(
      REFUSE_ID_UNAVAILABLE,
      "This request identifier has already been used in this browser. Identifiers are never reused, even when " +
        "the earlier attempt left nothing usable behind. Generate another."
    );
  }

  // 7, 8 — the key first, and verified.
  await vfs.writeFileAtomic(dkPath(requestIdHex), dk);
  const storedDk = await vfs.readFile(dkPath(requestIdHex));
  if (storedDk === null || storedDk.length !== XWING_SEED_BYTES || !equalBytes(storedDk, dk)) {
    refuse("the decapsulation key did not store intact; nothing was published.");
  }

  // 9, 10 — request.json LAST. This is the commit point.
  const record = serialize(REQUEST_KEYS, {
    version: RECORD_VERSION,
    requestId: requestIdHex,
    requestHash: toBase64Url(requestHash),
    body: toBase64Url(body),
    createdAt,
    expiresAt
  });
  await vfs.writeFileAtomic(requestPath(requestIdHex), record);

  // 11, 12 — read it back and re-verify EVERY relationship from disk.
  const readBack = await vfs.readFile(requestPath(requestIdHex));
  if (readBack === null) refuse("the receive request did not survive being written; nothing was published.");
  let verified: StoredRequest;
  try {
    verified = await parseStoredRequest(readBack, requestIdHex);
  } catch (error) {
    refuse(`the receive request read back invalid (${(error as Error).message}); nothing was published.`);
  }
  if (!equalBytes(verified.body, body) || !equalBytes(verified.requestHash, requestHash)) {
    refuse("the receive request read back with different contents; nothing was published.");
  }
  // 13 — only now may a caller publish the TPR2 text.
  return verified;
}

/* ---- terminal transitions ------------------------------------------------- */

/** Establish durable terminal state, then report what the disk actually says.
 *
 *  A write that throws proves nothing about what landed, so this never decides
 *  from the exception: it re-reads. If no marker exists the transition did not
 *  commit and the caller must NOT tell the operator it did. If one exists and is
 *  valid, the transition happened. If one exists and is malformed, the request
 *  is terminal-unreadable — which loses the transfer and is the correct outcome,
 *  because the alternative is a one-time key that might be used again. */
async function writeTerminal(
  vfs: Vfs,
  path: string,
  bytes: Uint8Array,
  requestIdHex: string,
  now: Date
): Promise<ReceiverState> {
  try {
    await vfs.writeFileAtomic(path, bytes);
  } catch (error) {
    const after = await readReceiverState(vfs, requestIdHex, now);
    if (after.kind === "pending" || after.kind === "expired-pending" || after.kind === "absent") {
      // Nothing landed. The request is untouched and the caller must not
      // acknowledge a transition that did not happen.
      throw new EngineRefused(
        REFUSE_RECEIVE_STATE,
        `the request was not changed (${(error as Error).message}); it has not been cancelled or consumed.`
      );
    }
    return after;
  }
  return readReceiverState(vfs, requestIdHex, now);
}

/** PENDING → CANCELLED. One terminal writer, three reasons: an operator
 *  cancelling, a TTL expiring, and §8.2.1's terminal rejection. */
export async function cancelPendingReceiveRequest(
  vfs: Vfs,
  requestIdHex: string,
  reason: CancelReason,
  at: string,
  now: Date
): Promise<ReceiverState> {
  refuseUnlessIso(at, "at");
  const state = await readReceiverState(vfs, requestIdHex, now);

  switch (state.kind) {
    case "cancelled":
      // Already terminal: idempotent, and the FIRST reason recorded stands.
      // Nothing is rewritten, so a retry cannot restate why.
      return state;
    case "pending":
      break;
    case "expired-pending":
      // An expired request is terminalized through this same transaction, and
      // only with the reason that is true of it.
      if (reason !== "expired") {
        refuse("an expired receive request is terminalized as expired, not by any other reason.");
      }
      break;
    case "consumed":
      refuse("this receive request was already used to receive a pad; it cannot be cancelled.");
      break;
    case "absent":
      refuse("there is no such receive request.");
      break;
    default:
      throw new EngineRefused(REFUSE_RECEIVE_STATE, state.message);
  }

  const bytes = serialize(CANCELLED_KEYS, { version: RECORD_VERSION, requestId: requestIdHex, at, reason });
  return writeTerminal(vfs, cancelledPath(requestIdHex), bytes, requestIdHex, now);
}

/** The same transaction, named for the caller that will use it. §18: expiry is
 *  a terminal TRANSITION, not a computed opinion — a request that merely
 *  *reads* as expired while a usable `dk.bin` sits beside it with no durable
 *  terminal authority is exactly the state this module exists to prevent. */
export async function expirePendingReceiveRequest(
  vfs: Vfs,
  requestIdHex: string,
  at: string,
  now: Date
): Promise<ReceiverState> {
  return cancelPendingReceiveRequest(vfs, requestIdHex, "expired", at, now);
}

export type ConsumeInput = { pairId: string; packageIdentity: Uint8Array; at: string };

/** PENDING → CONSUMED, the CONSUME-BEFORE-IMPORT commit boundary.
 *
 *  Phase 1C must call this BEFORE the pair import commits. If the import then
 *  fails, the transfer is LOST — and the request is still never reopened. That
 *  ordering is the whole point: the reverse would let an interrupted import be
 *  retried against a request whose key had already decapsulated a package. */
export async function consumePendingReceiveRequest(
  vfs: Vfs,
  requestIdHex: string,
  input: ConsumeInput,
  now: Date
): Promise<ReceiverState> {
  const { pairId, packageIdentity, at } = input;
  refuseUnlessIso(at, "at");
  if (!HEX_32.test(pairId)) refuse("pairId must be 32 lowercase hex characters");
  if (packageIdentity.length !== HASH_BYTES) refuse(`packageIdentity must be ${HASH_BYTES} bytes`);

  const state = await readReceiverState(vfs, requestIdHex, now);
  switch (state.kind) {
    case "pending":
      break;
    case "expired-pending":
      refuse("this receive request has expired and cannot receive a pad.");
      break;
    case "cancelled":
      refuse("this receive request was cancelled and cannot receive a pad.");
      break;
    case "consumed":
      refuse("this receive request has already received a pad.");
      break;
    case "absent":
      refuse("there is no such receive request.");
      break;
    default:
      throw new EngineRefused(REFUSE_RECEIVE_STATE, state.message);
  }

  const bytes = serialize(CONSUMED_KEYS, {
    version: RECORD_VERSION,
    requestId: requestIdHex,
    at,
    pairId,
    packageIdentity: toBase64Url(packageIdentity)
  });
  return writeTerminal(vfs, consumedPath(requestIdHex), bytes, requestIdHex, now);
}

/** Best-effort removal of the stored key after a request is durably terminal.
 *
 *  **The terminal marker is the authority, not this.** Reuse is prevented by
 *  `cancelled.json` / `consumed.json` existing, and a failure here does not
 *  change the state, does not warrant a retry of the transition, and is never
 *  reported as "the key was erased". JavaScript cannot promise that a
 *  garbage-collected copy is gone, that the engine forgot the bytes, or that
 *  physical storage was overwritten. */
export async function bestEffortDropKey(vfs: Vfs, requestIdHex: string): Promise<void> {
  try {
    const size = await vfs.size(dkPath(requestIdHex));
    if (size !== null && size > 0) await vfs.writeRange(dkPath(requestIdHex), 0, new Uint8Array(size));
  } catch {
    /* the marker is what prevents reuse; this is hygiene */
  }
  try {
    await vfs.remove(dkPath(requestIdHex));
  } catch {
    /* same */
  }
}
