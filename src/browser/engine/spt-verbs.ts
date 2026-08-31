/* ============================================================================
 * TruePad Browser Edition — Sealed Pad Transfer, composed
 * ----------------------------------------------------------------------------
 * The engine flow. Every durable authority it relies on was built and tested in
 * an earlier phase; this file is the wiring, and the wiring is where the
 * ordering lives.
 *
 * THE ORDER, WHICH IS THE SECURITY
 * --------------------------------
 * SENDER, per pad:
 *     request claim  →  encapsulation  →  pad handoff  →  release
 * RECEIVER, per request:
 *     structural parse  →  session lock  →  request authority  →  decapsulate
 *     →  in-memory preflight  →  human comparison  →  consume  →  import
 *
 * Nothing crosses the worker boundary before its commit. A package is not
 * released until the handoff is durable; a pad is not imported until the
 * request is durably consumed. Both orders lose material on a crash rather than
 * risk reuse, which is the trade this product makes everywhere.
 *
 * WHAT THE PAGE MAY NOT SUPPLY
 * ----------------------------
 * Two RPCs take an opaque handle and nothing else, deliberately:
 *
 *   spt-confirm-request(reviewId)   not the body — the worker holds what it
 *                                   decoded, so "displayed B, sealed B′" is
 *                                   not expressible
 *   spt-commit-receive(sessionId)   not the pad bytes — the worker imports the
 *                                   exact plaintext that produced the words
 *
 * And `spt-seal(requestHash, pairId)` names a request and a pad; it takes no
 * body, no recipient key, no pad bytes, no package. There is one authority for
 * the recipient (the sender's own confirmation record) and one for the pad (the
 * live store).
 *
 * None of this defends against a malicious page holding worker-RPC authority.
 * That is endpoint compromise (§15) and always was.
 * ========================================================================= */

import { bytesToHex } from "../../core/hex.ts";
import { equalBytes, toBase64Url } from "../../spt/bytes.ts";
import { confirmationIndices88, requestFingerprint, requestIndices132 } from "../../spt/fingerprint.ts";
import {
  decodeReceiveRequest,
  encodeReceiveRequest,
  encodeRequestBody,
  parseRequestBody
} from "../../spt/receive-request.ts";
import { openPayloadV1, sealPayloadV1 } from "../../spt/crypto-v1.ts";
import { packageIdentity, parseSealedPackage } from "../../spt/sealed-package.ts";
import { generateKeyPair } from "../../spt/xwing-v1.ts";
import { MAX_PLAINTEXT_BYTES } from "../../spt/constants.ts";

import { unpackContainer } from "./courier-format.ts";
import {
  commitSealedHandoff,
  loadCommittedSealedHandoff,
  readHandoffState,
  REFUSE_ALREADY_HANDED_OFF,
  REFUSE_ALREADY_SEALED,
  REFUSE_UNREADABLE
} from "./handoff.ts";
import { claimRequestForPair } from "./request-claim.ts";
import { commitConfirmation, requireConfirmedBody } from "./spt-confirmed.ts";
import {
  cancelPendingReceiveRequest,
  commitPendingReceiveRequest,
  consumePendingReceiveRequest,
  namespaceOccupied,
  readReceiverState,
  REQUEST_TTL_MS
} from "./spt-receiver-state.ts";
import type { SptRuntime } from "./spt-runtime.ts";
import { EngineRefused } from "./store.ts";
import { MemoryVfs, type Vfs } from "./vfs.ts";

/* ---- stable typed reasons ------------------------------------------------- */

export const R_REQUEST_UNAVAILABLE = "spt-request-unavailable";
export const R_REQUEST_EXPIRED = "spt-request-expired";
export const R_REQUEST_CANCELLED = "spt-request-cancelled";
export const R_REQUEST_CONSUMED = "spt-request-consumed";
export const R_REVIEW_NOT_FOUND = "spt-review-not-found";
export const R_SESSION_BUSY = "spt-session-busy";
export const R_SESSION_NOT_FOUND = "spt-session-not-found";
export const R_PACKAGE_MALFORMED = "spt-package-malformed";
export const R_PACKAGE_OPEN_FAILED = "spt-package-open-failed";
export const R_PACKAGE_NOT_IMPORTABLE = "spt-package-not-importable";
export const R_RECEIVE_LOSS = "spt-receive-loss";
export const R_PAD_INELIGIBLE = "spt-pad-ineligible";

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_ID_ATTEMPTS = 16;

const wipe = (...b: (Uint8Array | undefined)[]): void => {
  for (const x of b) {
    if (!x) continue;
    try {
      x.fill(0);
    } catch {
      /* detached */
    }
  }
};

const randomHex16 = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

/** Map a receiver state that is not usable onto its stable public reason. The
 *  same mapping everywhere, so a caller cannot learn more from one entry point
 *  than another. */
function refuseReceiverState(kind: string, message: string): never {
  switch (kind) {
    case "cancelled":
      throw new EngineRefused(R_REQUEST_CANCELLED, "this receive request was cancelled and cannot be used.");
    case "consumed":
      throw new EngineRefused(R_REQUEST_CONSUMED, "this receive request has already received a pad.");
    case "expired-pending":
      throw new EngineRefused(R_REQUEST_EXPIRED, "this receive request has expired.");
    default:
      throw new EngineRefused(R_REQUEST_UNAVAILABLE, message || "this receive request is not usable.");
  }
}

/* ==========================================================================
 * RECEIVER — create and cancel
 * ======================================================================== */

export type CreateRequestResult = {
  ok: true;
  op: "spt-create-request";
  requestId: string;
  requestHash: string;
  tpr2: string;
  requestIndices: number[];
  expiresAt: string;
};

/** Generate a one-time recipient key and publish a receive request.
 *
 *  No caller-supplied cryptographic input of any kind. The TPR2 text is
 *  produced only AFTER `request.json` and `dk.bin` have been written and read
 *  back — a published request whose key did not survive is a request the
 *  recipient can never answer. */
export async function createRequestImpl(vfs: Vfs, runtime: SptRuntime): Promise<CreateRequestResult> {
  void runtime;
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const expiresAt = new Date(createdAt.getTime() + REQUEST_TTL_MS).toISOString();

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const requestId = crypto.getRandomValues(new Uint8Array(16));
    const requestIdHex = bytesToHex(requestId);
    // A namespace that has EVER held anything makes that identifier unavailable
    // forever (§10.1.1). Discard this keypair and draw again; never clean up.
    if (await namespaceOccupied(vfs, requestIdHex)) continue;

    const keys = generateKeyPair();
    const body = encodeRequestBody(requestId, keys.encapsulationKey);
    const requestHash = await requestFingerprint(body);
    try {
      return await vfs.withLock(`spt-req:${requestIdHex}`, async (): Promise<CreateRequestResult> => {
        await commitPendingReceiveRequest(vfs, {
          body,
          requestId,
          requestHash,
          dk: keys.decapsulationSeed,
          createdAt: createdAtIso,
          expiresAt
        });
        return {
          ok: true,
          op: "spt-create-request",
          requestId: requestIdHex,
          requestHash: bytesToHex(requestHash),
          tpr2: encodeReceiveRequest(requestId, keys.encapsulationKey),
          requestIndices: requestIndices132(requestHash),
          expiresAt
        };
      });
    } catch (error) {
      // A collision is the ONLY retryable case. A storage failure is not, and
      // must not be retried into a loop that eats identifiers.
      if (error instanceof EngineRefused && error.reason === "request-id-unavailable") continue;
      throw error;
    } finally {
      wipe(keys.decapsulationSeed);
    }
  }
  throw new EngineRefused(
    R_REQUEST_UNAVAILABLE,
    "could not allocate a new receive request identifier. Nothing was created."
  );
}

export type CancelRequestResult = {
  ok: true;
  op: "spt-cancel-request";
  requestId: string;
  state: "cancelled" | "terminal-unreadable";
  reason: "operator" | "expired";
};

export async function cancelRequestImpl(vfs: Vfs, requestIdHex: string): Promise<CancelRequestResult> {
  if (!HEX_32.test(requestIdHex)) {
    throw new EngineRefused(R_REQUEST_UNAVAILABLE, "a request identifier is 32 lowercase hex characters.");
  }
  const now = new Date();
  return vfs.withLock(`spt-req:${requestIdHex}`, async (): Promise<CancelRequestResult> => {
    const before = await readReceiverState(vfs, requestIdHex, now);
    // The worker chooses the reason; a caller never supplies one. An already
    // expired request is terminalized as what it is.
    const reason = before.kind === "expired-pending" ? "expired" : "operator";
    if (before.kind === "consumed") {
      throw new EngineRefused(R_REQUEST_CONSUMED, "this receive request has already received a pad.");
    }
    const after = await cancelPendingReceiveRequest(vfs, requestIdHex, reason, now.toISOString(), now);
    if (after.kind === "cancelled") {
      return { ok: true, op: "spt-cancel-request", requestId: requestIdHex, state: "cancelled", reason };
    }
    // Terminal but unreadable: the request is dead, and saying so is honest.
    // It is NOT reported as a successful cancellation.
    return { ok: true, op: "spt-cancel-request", requestId: requestIdHex, state: "terminal-unreadable", reason };
  });
}

/* ==========================================================================
 * SENDER — inspect, confirm, seal
 * ======================================================================== */

export type InspectResult = {
  ok: true;
  op: "spt-inspect-request";
  reviewId: string;
  requestHash: string;
  requestIndices: number[];
};

/** Decode a pasted TPR2 and hand back ONLY public material plus a handle.
 *
 *  The canonical body stays in the worker under `reviewId`, so the confirm step
 *  cannot be given a different body than the one whose words were displayed. */
export async function inspectRequestImpl(runtime: SptRuntime, text: string): Promise<InspectResult> {
  const decoded = decodeReceiveRequest(text);
  if (!decoded.ok) {
    throw new EngineRefused(R_REQUEST_UNAVAILABLE, `this is not a valid receive request: ${decoded.message}`);
  }
  const requestHash = await requestFingerprint(decoded.canonicalBody);
  const reviewId = randomHex16();
  runtime.putReview(reviewId, { canonicalBody: decoded.canonicalBody, requestHash: requestHash.slice() });
  return {
    ok: true,
    op: "spt-inspect-request",
    reviewId,
    requestHash: bytesToHex(requestHash),
    requestIndices: requestIndices132(requestHash)
  };
}

export type ConfirmResult = {
  ok: true;
  op: "spt-confirm-request";
  requestHash: string;
  expiresAt: string;
};

/** Record the operator's declaration for the reviewed body. Takes the handle
 *  and nothing else. */
export async function confirmRequestImpl(vfs: Vfs, runtime: SptRuntime, reviewId: string): Promise<ConfirmResult> {
  const review = runtime.getReview(reviewId);
  if (!review) {
    throw new EngineRefused(
      R_REVIEW_NOT_FOUND,
      "that review is no longer open. Paste the receive request again and compare the twelve words."
    );
  }
  const now = new Date();
  const { requestHashHex, record } = await commitConfirmation(vfs, review.canonicalBody, now.toISOString(), now);
  // Only after the confirmation is durably readable is the handle spent. If
  // persistence failed the handle survives, so a retry does not cost the
  // operator another twelve-word comparison.
  runtime.dropReview(reviewId);
  return { ok: true, op: "spt-confirm-request", requestHash: requestHashHex, expiresAt: record.expiresAt };
}

export type SealResult = {
  ok: true;
  op: "spt-seal";
  requestHash: string;
  packageIdentity: string;
  package: Uint8Array;
  confirmationIndices: number[];
  reshared: boolean;
};

export type SealDeps = {
  /** Injected so the pad-eligibility gates stay in verbs.ts, where the store
   *  helpers live, instead of being reimplemented here. */
  requirePadSealable(vfs: Vfs, pairId: string): Promise<void>;
  buildContainer(vfs: Vfs, pairId: string): Promise<Uint8Array>;
};

/** Seal a live, generated-here, genesis pad to a confirmed receive request.
 *
 *  LOCK ORDER, frozen: pad lock OUTERMOST, then the request-scoped sender lock.
 *  Never the reverse, anywhere. */
export async function sealImpl(
  vfs: Vfs,
  requestHashHex: string,
  pairId: string,
  deps: SealDeps
): Promise<SealResult> {
  if (!HEX_64.test(requestHashHex)) {
    throw new EngineRefused(R_REQUEST_UNAVAILABLE, "a request fingerprint is 64 lowercase hex characters.");
  }
  if (!HEX_32.test(pairId)) throw new EngineRefused(R_PAD_INELIGIBLE, "a pad id is 32 lowercase hex characters.");
  const now = new Date();

  return vfs.withLock(pairId, async (): Promise<SealResult> => {
    // Pad eligibility first: exists, not destroyed, not mid-import,
    // origin "generated-here", and BOTH directions at genesis in the LIVE store.
    await deps.requirePadSealable(vfs, pairId);


    const handoff = await readHandoffState(vfs, pairId);
    if (handoff.kind === "unreadable-spent") throw new EngineRefused(REFUSE_UNREADABLE, handoff.message);
    if (handoff.kind === "physical") {
      throw new EngineRefused(
        REFUSE_ALREADY_HANDED_OFF,
        "This pad has already been handed off as a file, so it cannot also be sent by sealed transfer. " +
          "Generate a new pad for that."
      );
    }

    if (handoff.kind === "sealed") {
      // EXACT RE-SHARE ONLY. Never a second encapsulation — and deliberately no
      // fresh confirmation required: this package was authorized before its
      // handoff committed, and demanding a new one would turn an expired
      // confirmation into a lost pad.
      if (handoff.marker.requestHash !== toBase64Url(hexToBytes32(requestHashHex))) {
        throw new EngineRefused(
          REFUSE_ALREADY_SEALED,
          "This pad was already sealed to a different receive request. Generate a new pad for this one."
        );
      }
      const committed = await loadCommittedSealedHandoff(vfs, pairId);
      return {
        ok: true,
        op: "spt-seal",
        requestHash: requestHashHex,
        packageIdentity: handoff.marker.packageIdentity,
        package: committed.packageBytes.slice(),
        confirmationIndices: confirmationIndices88(committed.confirmValue),
        reshared: true
      };
    }

    // ABSENT — and only here may anything be encapsulated.
    return vfs.withLock(`spt-send:${requestHashHex}`, async (): Promise<SealResult> => {
      // Re-check the pad's handoff with BOTH locks held.
      const again = await readHandoffState(vfs, pairId);
      if (again.kind !== "absent") {
        throw new EngineRefused(REFUSE_ALREADY_SEALED, "this pad's handoff was committed concurrently.");
      }
      const confirmed = await requireConfirmedBody(vfs, requestHashHex, now);
      const requestHash = await requestFingerprint(confirmed.body);
      if (bytesToHex(requestHash) !== requestHashHex) {
        throw new EngineRefused(R_REQUEST_UNAVAILABLE, "the stored confirmation does not match this request.");
      }

      // STEP 1 of the frozen write order: bind the REQUEST to this pad before
      // anything is encapsulated. Refuses if it is already bound elsewhere.
      await claimRequestForPair(vfs, requestHash, pairId, now.toISOString());

      // STEP 2: the exact live courier bytes, then one encapsulation.
      const container = await deps.buildContainer(vfs, pairId);
      if (container.length > MAX_PLAINTEXT_BYTES) {
        throw new EngineRefused(R_PAD_INELIGIBLE, "this pad is too large to send by sealed transfer.");
      }
      let sealed;
      try {
        sealed = await sealPayloadV1(confirmed.body, container);
      } finally {
        wipe(container);
      }

      // STEP 3: the pad handoff, marker-last. Nothing is released before it.
      await commitSealedHandoff(
        vfs,
        pairId,
        {
          packageBytes: sealed.packageBytes,
          requestHash,
          confirmValue: sealed.confirmValue,
          packageIdentity: sealed.packageIdentity
        },
        now.toISOString()
      );
      // STEP 4, and only now: verify what was committed and release a COPY, so
      // transferring the response cannot detach the bytes kept for re-share.
      const committed = await loadCommittedSealedHandoff(vfs, pairId);
      return {
        ok: true,
        op: "spt-seal",
        requestHash: requestHashHex,
        packageIdentity: toBase64Url(sealed.packageIdentity),
        package: committed.packageBytes.slice(),
        confirmationIndices: confirmationIndices88(committed.confirmValue),
        reshared: false
      };
    });
  });
}

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/* ==========================================================================
 * RECEIVER — open, reject, abandon, commit
 * ======================================================================== */

export type OpenSealedResult = {
  ok: true;
  op: "spt-open-sealed";
  sessionId: string;
  requestId: string;
  confirmationIndices: number[];
};

/** Open a sealed package into a transient, worker-only session.
 *
 *  Ordering, all of it load-bearing:
 *    1. structural TPS2 parse — before there is a trustworthy requestId at all;
 *    2. the receive session lock, `ifAvailable`, never queued;
 *    3. the request authority, which refuses terminal/expired states BEFORE
 *       any private-key use;
 *    4. `requestHash` binding — `requestId` alone never authorizes `dk`;
 *    5. decapsulation and AEAD;
 *    6. a fully in-memory import preflight;
 *    7. only then a session. */
export type OpenDeps = {
  /** The importer's own bundle validation, against a scratch Vfs. */
  validateBundle(scratch: Vfs, pairId: string, files: { path: string; bytes: Uint8Array }[]): Promise<string | null>;
  requireImportable(vfs: Vfs, pairId: string): Promise<void>;
};

export async function openSealedImpl(
  vfs: Vfs,
  runtime: SptRuntime,
  packageBytes: Uint8Array,
  deps: OpenDeps
): Promise<OpenSealedResult> {
  // 1 — structure only. No key material has been touched.
  const parsed = parseSealedPackage(packageBytes);
  if (!parsed.ok) {
    throw new EngineRefused(R_PACKAGE_MALFORMED, `this sealed file is not usable: ${parsed.message}`);
  }
  const requestIdHex = bytesToHex(parsed.parsed.header.requestId);

  // 2 — one live session per request, across tabs. Never queued: queueing would
  // let a second decapsulation start the instant the first session ended.
  const lease = await runtime.locks.tryAcquire(`spt-recv:${requestIdHex}`);
  if (lease === null) {
    throw new EngineRefused(
      R_SESSION_BUSY,
      "this transfer is already open in another tab. Finish or close it there first."
    );
  }
  if (lease === null) {
    throw new EngineRefused(
      R_SESSION_BUSY,
      "this transfer is already open in another tab. Finish or close it there first."
    );
  }

  let padFileBytes: Uint8Array | undefined;
  let dk: Uint8Array | undefined;
  try {
    const now = new Date();
    const opened = await vfs.withLock(`spt-req:${requestIdHex}`, async () => {
      const state = await readReceiverState(vfs, requestIdHex, now);
      if (state.kind === "expired-pending") {
        // Terminalize rather than merely reporting an opinion (§10.1.1).
        await cancelPendingReceiveRequest(vfs, requestIdHex, "expired", now.toISOString(), now);
        throw new EngineRefused(R_REQUEST_EXPIRED, "this receive request has expired.");
      }
      if (state.kind !== "pending") {
        refuseReceiverState(state.kind, "message" in state ? state.message : "");
      }
      // 4 — the binding that actually authorizes the key.
      if (!equalBytes(parsed.parsed.header.requestHash, state.requestHash)) {
        throw new EngineRefused(R_REQUEST_UNAVAILABLE, "this sealed file is for a different receive request.");
      }
      dk = state.dk;
      // 5 — decapsulate + AEAD. KEM and AEAD failure are ONE outcome.
      const outcome = await openPayloadV1(packageBytes, state.body, state.dk);
      if (!outcome.ok) {
        throw new EngineRefused(
          R_PACKAGE_OPEN_FAILED,
          "this sealed file could not be opened for this receive request."
        );
      }
      return { result: outcome.result, requestHash: state.requestHash.slice() };
    });

    padFileBytes = opened.result.payload;

    // 6 — is it actually a TruePad pad? "AEAD verified" only proves these are
    // the bytes the sender sealed. The preflight runs entirely in memory: the
    // decrypted plaintext never touches OPFS.
    const pairId = await preflightContainer(padFileBytes, deps);
    // 6b — and against the real store, non-mutating. FREE failures: nothing
    // consumed, no importer called. Re-checked at commit, because state moves.
    await deps.requireImportable(vfs, pairId);

    const sessionId = randomHex16();
    runtime.putSession({
      sessionId,
      requestId: requestIdHex,
      requestHash: opened.requestHash,
      packageIdentity: opened.result.packageIdentity.slice(),
      pairId,
      padFileBytes,
      confirmValue: opened.result.confirmValue.slice(),
      lease
    });
    padFileBytes = undefined; // ownership passes to the session
    return {
      ok: true,
      op: "spt-open-sealed",
      sessionId,
      requestId: requestIdHex,
      confirmationIndices: opened.result.confirmationIndices
    };
  } catch (error) {
    lease.release();
    throw error;
  } finally {
    wipe(dk, padFileBytes);
  }
}

/** Everything the existing importer would check, run on a private in-memory
 *  copy. Nothing is written anywhere real, and the decrypted bytes never reach
 *  OPFS — not under `<pairId>/`, not under `importing/`, not under any scratch
 *  path. The session already has to hold the plaintext in worker memory; this
 *  adds no second place for it to live. */
async function preflightContainer(padFileBytes: Uint8Array, deps: OpenDeps): Promise<string> {
  const unpacked = unpackContainer(padFileBytes);
  if (!unpacked.ok) {
    throw new EngineRefused(R_PACKAGE_NOT_IMPORTABLE, `this is not a usable pad file: ${unpacked.message}`);
  }
  if (!HEX_32.test(unpacked.pairId)) {
    throw new EngineRefused(R_PACKAGE_NOT_IMPORTABLE, "this pad file has an invalid identifier.");
  }
  // An IN-MEMORY scratch store. The decrypted plaintext is validated exactly as
  // the importer would, and never reaches OPFS — not under `<pairId>/`, not
  // under `importing/`, not under any scratch path.
  const problem = await deps.validateBundle(new MemoryVfs(), unpacked.pairId, unpacked.files);
  if (problem !== null) {
    throw new EngineRefused(R_PACKAGE_NOT_IMPORTABLE, `${problem} Nothing was imported.`);
  }
  return unpacked.pairId;
}

export type AbandonResult = { ok: true; op: "spt-abandon"; requestId: string };

/** The operator closed the ceremony without deciding. NOT a rejection: the
 *  request stays PENDING, no terminal marker is written, and the stored key is
 *  untouched. Only the transient session and its lock go away. */
export async function abandonImpl(runtime: SptRuntime, sessionId: string): Promise<AbandonResult> {
  const session = runtime.getSession(sessionId);
  if (!session) throw new EngineRefused(R_SESSION_NOT_FOUND, "that transfer is no longer open.");
  const requestId = session.requestId;
  runtime.endSession(sessionId);
  return { ok: true, op: "spt-abandon", requestId };
}

export type RejectResult = { ok: true; op: "spt-reject"; requestId: string; state: "cancelled" | "terminal-unreadable" };

/** The confirmation comparison failed. Rejection is TERMINAL (§8.2.1), and the
 *  durable marker must exist BEFORE it is acknowledged.
 *
 *  If the terminal write does not commit, the session is deliberately KEPT
 *  ALIVE — with its lock — so the operator can retry the rejection or abandon
 *  explicitly. Reporting a rejection that did not land would claim the
 *  confirmation proof survived a transition that never happened. */
export async function rejectImpl(vfs: Vfs, runtime: SptRuntime, sessionId: string): Promise<RejectResult> {
  const session = runtime.getSession(sessionId);
  if (!session) throw new EngineRefused(R_SESSION_NOT_FOUND, "that transfer is no longer open.");
  const now = new Date();
  const after = await vfs.withLock(`spt-req:${session.requestId}`, async () =>
    cancelPendingReceiveRequest(vfs, session.requestId, "rejected", now.toISOString(), now)
  );
  if (after.kind !== "cancelled" && after.kind !== "terminal-unreadable" && after.kind !== "terminal-inconsistent") {
    // Nothing durable landed. Keep the session and its lock.
    throw new EngineRefused(
      R_REQUEST_UNAVAILABLE,
      "TruePad could not record that you rejected this transfer, so it has not been recorded. " +
        "Try again, or close the transfer without deciding."
    );
  }
  const requestId = session.requestId;
  runtime.endSession(sessionId);
  return {
    ok: true,
    op: "spt-reject",
    requestId,
    state: after.kind === "cancelled" ? "cancelled" : "terminal-unreadable"
  };
}

export type CommitReceiveDeps = {
  importUnderPairLock(
    vfs: Vfs,
    unpacked: { pairId: string; files: { path: string; bytes: Uint8Array }[] },
    label: string
  ): Promise<{ pair: unknown }>;
  requireImportable(vfs: Vfs, pairId: string): Promise<void>;
};

export type CommitReceiveResult = {
  ok: true;
  op: "spt-commit-receive";
  requestId: string;
  pair: unknown;
  complete: boolean;
};

/** CONSUME BEFORE IMPORT.
 *
 *  Takes an opaque `sessionId` and nothing else. The pad bytes, the pairId, the
 *  package identity and the request are all the worker's own — there is no
 *  parameter through which a caller could substitute any of them, which is what
 *  makes "the bytes that produced the words are the bytes that get imported" a
 *  structural fact rather than a promise.
 *
 *  Lock order, outermost first: the session lease (already held) → the request
 *  lock → the pad lock. */
export async function commitReceiveImpl(
  vfs: Vfs,
  runtime: SptRuntime,
  sessionId: string,
  deps: CommitReceiveDeps
): Promise<CommitReceiveResult> {
  const session = runtime.getSession(sessionId);
  if (!session) throw new EngineRefused(R_SESSION_NOT_FOUND, "that transfer is no longer open.");
  const now = new Date();

  return vfs.withLock(`spt-req:${session.requestId}`, async (): Promise<CommitReceiveResult> => {
    // Re-resolve: the session may have ended while we waited for the lock.
    const live = runtime.getSession(sessionId);
    if (!live) throw new EngineRefused(R_SESSION_NOT_FOUND, "that transfer is no longer open.");

    const state = await readReceiverState(vfs, live.requestId, now);
    if (state.kind === "expired-pending") {
      await cancelPendingReceiveRequest(vfs, live.requestId, "expired", now.toISOString(), now);
      runtime.endSession(sessionId);
      throw new EngineRefused(R_REQUEST_EXPIRED, "this receive request expired before the pad was saved.");
    }
    if (state.kind !== "pending") {
      runtime.endSession(sessionId);
      refuseReceiverState(state.kind, "message" in state ? state.message : "");
    }
    if (!equalBytes(state.requestHash, live.requestHash)) {
      runtime.endSession(sessionId);
      throw new EngineRefused(R_REQUEST_UNAVAILABLE, "this transfer no longer matches its receive request.");
    }
    wipe(state.dk); // read but not needed here

    return vfs.withLock(live.pairId, async (): Promise<CommitReceiveResult> => {
      // Re-run the cheap real-state checks: a pair or a tombstone can appear
      // between the preflight and now. Refusing HERE is FREE — nothing consumed.
      await deps.requireImportable(vfs, live.pairId);

      const unpacked = unpackContainer(live.padFileBytes);
      if (!unpacked.ok) {
        throw new EngineRefused(R_PACKAGE_NOT_IMPORTABLE, `this pad file is not usable: ${unpacked.message}`);
      }

      // CONSUME. After this returns valid, any failure below is LOSS.
      const consumed = await consumePendingReceiveRequest(
        vfs,
        live.requestId,
        { pairId: live.pairId, packageIdentity: live.packageIdentity, at: now.toISOString() },
        now
      );
      if (consumed.kind !== "consumed") {
        // The marker exists but is not readable: terminal, and the importer
        // must NOT run. The transfer is lost and the request never reopens.
        runtime.endSession(sessionId);
        throw new EngineRefused(
          R_RECEIVE_LOSS,
          "TruePad could not safely record that this receive request was used, so the pad was not saved. " +
            "The request cannot be used again — ask the sender to generate a new pad and start a new transfer."
        );
      }

      let imported;
      try {
        imported = await deps.importUnderPairLock(vfs, unpacked, "Received pad");
      } catch (error) {
        // LOSS. The request is consumed and stays consumed; the package is not
        // re-opened and nothing is rolled back.
        runtime.endSession(sessionId);
        throw new EngineRefused(
          R_RECEIVE_LOSS,
          "The one-time receive request was used, but the pad did not finish saving " +
            `(${(error as Error).message}). The request cannot be used again — ask the sender to generate a new ` +
            "pad and start a new transfer."
        );
      }

      const requestId = live.requestId;
      runtime.endSession(sessionId);
      return { ok: true, op: "spt-commit-receive", requestId, pair: imported.pair, complete: true };
    });
  });
}

export { packageIdentity, parseRequestBody };
