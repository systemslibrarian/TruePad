/* ============================================================================
 * TruePad Browser Edition — the sender's CONFIRMED declaration (worker-side)
 * ----------------------------------------------------------------------------
 * The fifth durable fact, and the only one that is NOT a one-way use marker.
 *
 *   spt/confirmed/<requestHashHex>.json
 *
 * It means exactly one thing: **the UI reported that the operator said all
 * twelve request words matched.** It is an operator DECLARATION, never a proof
 * that the comparison happened, and never evidence of human intent.
 *
 * WHAT IT CLOSES, AND WHAT IT DOES NOT
 * ------------------------------------
 * It closes the accidental case — the page displays request body `B` and then
 * asks the worker to seal body `B′` — because the worker seals the body it
 * holds, not one the caller re-supplies (§8 of the Phase 1C brief, and the
 * `reviewId` handle in spt-runtime.ts).
 *
 * It does **not** defend against malicious page code holding worker-RPC
 * authority. Such code can drive the review and the confirmation itself. That
 * is ENDPOINT COMPROMISE (§15 of the spec), it always was, and no storage
 * record changes it. There is no secure-attention claim here.
 *
 * WHY THIS ONE IS REPLACEABLE
 * ---------------------------
 * `handoff.json` and `spt/claims/…` are irreversible: they record that
 * something LEFT. A confirmation records only that a human looked. So a
 * malformed or expired confirmation simply fails to authorize sealing, and a
 * fresh explicit review-and-confirm of the SAME body may replace it.
 *
 * Replacing a confirmation does **not** touch the claim or the handoff. Those
 * stay permanent, and they are what actually prevent a second package.
 * ========================================================================= */

import { bytesToHex } from "../../core/hex.ts";
import { equalBytes, fromBase64Url, toBase64Url } from "../../spt/bytes.ts";
import { requestFingerprint } from "../../spt/fingerprint.ts";
import { parseRequestBody } from "../../spt/receive-request.ts";
import { TPR2_BODY_BYTES } from "../../spt/constants.ts";
import { EngineRefused } from "./store.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CONFIRMED_DIR = "spt/confirmed";
const RECORD_VERSION = 1;
const HASH_BYTES = 32;
const HEX_64 = /^[0-9a-f]{64}$/;

/** The same seven days the receive request lives for. A confirmation that
 *  outlived the request it confirms would authorize sealing to something the
 *  recipient has already discarded. */
export const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REFUSE_CONFIRMATION_MISSING = "spt-confirmation-missing";
export const REFUSE_CONFIRMATION_EXPIRED = "spt-confirmation-expired";

export const confirmedPath = (requestHashHex: string): string => `${CONFIRMED_DIR}/${requestHashHex}.json`;

const CONFIRMED_KEYS = ["version", "requestHash", "body", "confirmedAt", "expiresAt"] as const;

export type ConfirmedRecord = {
  requestHash: Uint8Array;
  /** The exact canonical 1235-byte body the operator reviewed. */
  body: Uint8Array;
  confirmedAt: string;
  expiresAt: string;
};

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

/** Strict parse AND full re-derivation, the same discipline as the receiver's
 *  `request.json`: the body must parse as a canonical §5.1 request and must
 *  hash to the `requestHash` this record is filed under. A confirmation is not
 *  trusted because its JSON parsed. */
export async function parseConfirmed(bytes: Uint8Array, requestHashHex: string): Promise<ConfirmedRecord> {
  if (bytes.length === 0) throw new Error("the confirmation record is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error("the confirmation record does not parse as JSON");
  }
  if (!isRecord(parsed)) throw new Error("the confirmation record is not a JSON object");
  if (parsed.version !== RECORD_VERSION) throw new Error("unsupported confirmation record version");
  const actual = Object.keys(parsed).sort();
  const wanted = [...CONFIRMED_KEYS].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    throw new Error("the confirmation record's fields are wrong");
  }

  const requestHash = decodeExact(parsed.requestHash, HASH_BYTES, "requestHash");
  if (bytesToHex(requestHash) !== requestHashHex) throw new Error("the record names a different request");
  const body = decodeExact(parsed.body, TPR2_BODY_BYTES, "body");
  const confirmedAt = requireIso(parsed.confirmedAt, "confirmedAt");
  const expiresAt = requireIso(parsed.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) - Date.parse(confirmedAt) !== CONFIRMATION_TTL_MS) {
    throw new Error("expiresAt is not exactly seven days after confirmedAt");
  }

  const request = parseRequestBody(body);
  if (!request.ok) throw new Error(`the confirmed body is not a canonical request: ${request.message}`);
  if (!equalBytes(await requestFingerprint(body), requestHash)) {
    throw new Error("the confirmed body does not hash to this request");
  }
  return { requestHash, body, confirmedAt, expiresAt };
}

export type ConfirmationState =
  | { kind: "absent" }
  | { kind: "confirmed"; record: ConfirmedRecord }
  | { kind: "expired"; record: ConfirmedRecord }
  /** Present and not usable. It authorizes nothing — and unlike a torn handoff
   *  marker it costs nothing either, because a fresh review can replace it. */
  | { kind: "unusable"; message: string };

export async function readConfirmation(vfs: Vfs, requestHashHex: string, now: Date): Promise<ConfirmationState> {
  if (!HEX_64.test(requestHashHex)) return { kind: "unusable", message: "a requestHash is 64 lowercase hex characters" };
  let bytes: Uint8Array | null;
  try {
    bytes = await vfs.readFile(confirmedPath(requestHashHex));
  } catch (error) {
    return { kind: "unusable", message: `the confirmation could not be read (${(error as Error).message})` };
  }
  if (bytes === null) return { kind: "absent" };
  let record: ConfirmedRecord;
  try {
    record = await parseConfirmed(bytes, requestHashHex);
  } catch (error) {
    return { kind: "unusable", message: `the confirmation is not usable (${(error as Error).message})` };
  }
  if (now.getTime() >= Date.parse(record.expiresAt)) return { kind: "expired", record };
  return { kind: "confirmed", record };
}

/** Record the operator's declaration for the body the WORKER reviewed.
 *
 *  The caller passes the body it holds from the review handle, never one a page
 *  supplied — that is the whole point of the two-step boundary. This function
 *  re-derives the hash from those bytes anyway, so the file cannot be filed
 *  under a name that does not match what is inside it. */
export async function commitConfirmation(
  vfs: Vfs,
  body: Uint8Array,
  confirmedAt: string,
  now: Date
): Promise<{ requestHashHex: string; record: ConfirmedRecord }> {
  const request = parseRequestBody(body);
  if (!request.ok) {
    throw new EngineRefused("spt-request-unavailable", `this is not a canonical receive request: ${request.message}`);
  }
  requireIso(confirmedAt, "confirmedAt");
  const requestHash = await requestFingerprint(body);
  const requestHashHex = bytesToHex(requestHash);
  const expiresAt = new Date(Date.parse(confirmedAt) + CONFIRMATION_TTL_MS).toISOString();

  const record = {
    version: RECORD_VERSION,
    requestHash: toBase64Url(requestHash),
    body: toBase64Url(body),
    confirmedAt,
    expiresAt
  } as const;
  const serialized = enc.encode(
    `{${CONFIRMED_KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(",")}}`
  );
  await vfs.writeFileAtomic(confirmedPath(requestHashHex), serialized);

  // Read back and re-verify, like every other record in this engine. A
  // confirmation that did not land must not be reported as one that did.
  const state = await readConfirmation(vfs, requestHashHex, now);
  if (state.kind !== "confirmed") {
    throw new EngineRefused(
      REFUSE_CONFIRMATION_MISSING,
      "the confirmation did not store intact, so nothing is authorized to be sealed. Review the request again."
    );
  }
  return { requestHashHex, record: state.record };
}

/** The gate `spt-seal` runs before a NEW handoff. Returns the exact confirmed
 *  body; refuses if there is no usable, unexpired confirmation.
 *
 *  Deliberately NOT called on the exact-re-share path: that package was
 *  authorized before its handoff committed, and requiring a fresh confirmation
 *  to hand over bytes that already exist would make a lost confirmation into a
 *  lost pad. */
export async function requireConfirmedBody(vfs: Vfs, requestHashHex: string, now: Date): Promise<ConfirmedRecord> {
  const state = await readConfirmation(vfs, requestHashHex, now);
  switch (state.kind) {
    case "confirmed":
      return state.record;
    case "expired":
      throw new EngineRefused(
        REFUSE_CONFIRMATION_EXPIRED,
        "the confirmation for this receive request has expired. Compare the twelve words again to re-confirm it."
      );
    case "absent":
      throw new EngineRefused(
        REFUSE_CONFIRMATION_MISSING,
        "this receive request has not been confirmed on this device. Review it and compare the twelve words first."
      );
    default:
      throw new EngineRefused(REFUSE_CONFIRMATION_MISSING, `${state.message} Review the request again.`);
  }
}
