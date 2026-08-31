/* ============================================================================
 * TruePad Browser Edition — the one-request claim (worker-side)
 * ----------------------------------------------------------------------------
 * THE SECOND DURABLE GATE, AND WHY ONE WAS NOT ENOUGH
 *
 * `handoff.ts` records that a PAD has been handed off. That protects the pad,
 * and it is keyed by `pairId`. It says nothing whatever about the REQUEST, and
 * the two are not the same invariant:
 *
 *     Bob creates receive request R.  Alice confirms R.
 *     Alice seals pad P to R          → P/handoff.json exists.
 *     Alice later picks a FRESH pad Q, still holding her confirmation of R.
 *     Q/handoff.json is absent. The pad gate has nothing to say.
 *     → a second independent X-Wing package for the same R.
 *
 * The locks cannot close this: `"spt-send:" ‖ requestHash` gives mutual
 * exclusion, not one-shot-ness, and it is released the moment the first seal
 * returns. Only durable state makes something happen once.
 *
 * This is not a two-time pad — Bob's request holds one `dk` and one
 * compare-and-set, so only one package can ever commit. What it costs is a pad
 * destroyed for nothing (P is permanently handed off and reached no one), two
 * valid packages with two different confirmation values for one request, and
 * §8.2.1's premise that "Alice's target is fixed for the life of the request".
 *
 * So: two gates, protecting two different things, neither implying the other.
 *
 *     <pairId>/handoff.json               one pad, one handoff
 *     spt/claims/<requestHash>.json       one request, one package
 *
 * CLAIMED IS NOT CONSUMED
 *
 * A claim binds a request to a pair. Between the claim landing and that pair's
 * handoff committing, the request is **PERMANENTLY CLAIMED / BOUND TO THAT
 * PAIR** — it is *not* consumed, and *not* spent. The distinction is the whole
 * retry story:
 *
 *     claim R → P, P's handoff absent, nothing released
 *         retry R → P   ALLOWED — the resumption of that same attempt,
 *                       and the only circumstance in which a new
 *                       encapsulation for R may occur at all
 *         retry R → Q   REFUSED — R is bound to P, permanently
 *
 * Once P's handoff commits, no new encapsulation happens for R by any route;
 * only the exact committed package may be re-shared.
 *
 * WRITE ORDER, FROZEN
 *
 *     1. durable request claim  R → P
 *     2. X-Wing encapsulation and package construction
 *     3. durable P/handoff.json (marker-last, §10.9.1)
 *     4. only then may a package or confirmation be released
 *
 * A crash after (1) and before (3) strands R on P and **does not burn P**: the
 * pad's handoff is still absent, so the same P/R attempt resumes. The reverse
 * order would spend a pad and leave the request open — which is precisely the
 * defect above, arriving by a different door.
 *
 * A claim file that exists and cannot be validated fails closed FOR THAT
 * REQUEST. It does not burn the pad, and it is never deleted or repaired.
 *
 * This directory is deliberately NOT under `<pairId>/`: the pad is the thing
 * being varied, so a per-pad location could not see the collision. `spt/` is a
 * top-level name that `list-pairs` already skips (it is not 32 hex characters).
 * ========================================================================= */

import { equalBytes, fromBase64Url, toBase64Url } from "../../spt/bytes.ts";
import { EngineRefused } from "./store.ts";
import type { Vfs } from "./vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CLAIMS_DIR = "spt/claims";
const CLAIM_VERSION = 1;
const HASH_BYTES = 32;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export const REFUSE_CLAIMED_ELSEWHERE = "request-claimed-elsewhere";
export const REFUSE_CLAIM_UNREADABLE = "request-claim-unreadable";
export const REFUSE_NOT_CLAIMED = "request-not-claimed";

export const CLAIM_UNREADABLE_ADVICE =
  "TruePad cannot safely determine which pad this receive request was already bound to, so it refuses to seal " +
  "anything to it. A record of that binding exists but cannot be read. Ask for a new receive request.";

/** Lowercase hex of the 32-byte requestHash. Hex rather than base64url because
 *  this is a PATH component: one case, one alphabet, no separator characters,
 *  and no filesystem to disagree with us about any of it. */
function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function claimPath(requestHash: Uint8Array): string {
  if (requestHash.length !== HASH_BYTES) {
    throw new RangeError(`requestHash must be ${HASH_BYTES} bytes, got ${requestHash.length}`);
  }
  return `${CLAIMS_DIR}/${hexOf(requestHash)}.json`;
}

export type RequestClaim = {
  version: 1;
  /** canonical unpadded base64url of the 32-byte requestHash */
  requestHash: string;
  /** the pair this request is bound to, permanently */
  pairId: string;
  at: string;
};

export type RequestClaimState =
  | { kind: "absent" }
  | { kind: "claimed"; claim: RequestClaim }
  /** A record exists and cannot be trusted. NOT absence. */
  | { kind: "unreadable"; message: string };

const CLAIM_KEYS = ["version", "requestHash", "pairId", "at"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} is not a canonical ISO-8601 timestamp`);
  }
  return value;
}

/** Frozen property order, built from an ordered list rather than an object
 *  literal so the order is a fact of the code. */
function serializeClaim(claim: RequestClaim): Uint8Array {
  const parts = CLAIM_KEYS.map(
    (k) => `${JSON.stringify(k)}:${JSON.stringify((claim as Record<string, unknown>)[k])}`
  );
  return enc.encode(`{${parts.join(",")}}`);
}

/** Strict parse. Nothing defaults, nothing coerces, no extra field is tolerated
 *  — and the record must name the request whose file it was read from, so a
 *  claim cannot be moved or copied onto another request's path. */
export function parseClaim(bytes: Uint8Array, requestHash: Uint8Array): RequestClaim {
  if (bytes.length === 0) throw new Error("the request claim is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error("the request claim does not parse as JSON");
  }
  if (!isRecord(parsed)) throw new Error("the request claim is not a JSON object");
  if (parsed.version !== CLAIM_VERSION) throw new Error("unsupported request claim version");
  const actual = Object.keys(parsed).sort();
  const wanted = [...CLAIM_KEYS].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    throw new Error("the request claim's fields are wrong");
  }
  if (typeof parsed.requestHash !== "string") throw new Error("requestHash is not a string");
  const decoded = fromBase64Url(parsed.requestHash);
  if (decoded === null) throw new Error("requestHash is not canonical unpadded base64url");
  if (decoded.length !== HASH_BYTES) throw new Error(`requestHash decodes to ${decoded.length} bytes`);
  if (toBase64Url(decoded) !== parsed.requestHash) throw new Error("requestHash is not canonically spelled");
  if (!equalBytes(decoded, requestHash)) throw new Error("the request claim names a different request");
  if (typeof parsed.pairId !== "string" || !HEX_32.test(parsed.pairId)) {
    throw new Error("the request claim has no valid pairId");
  }
  const at = requireIsoTimestamp(parsed.at, "at");
  return { version: CLAIM_VERSION, requestHash: parsed.requestHash, pairId: parsed.pairId, at };
}

/** Read a request's claim state. A read that throws becomes `unreadable`, never
 *  `absent`: "we could not tell" must never resolve to "so nothing was bound". */
export async function readRequestClaim(vfs: Vfs, requestHash: Uint8Array): Promise<RequestClaimState> {
  const path = claimPath(requestHash);
  let bytes: Uint8Array | null;
  try {
    bytes = await vfs.readFile(path);
  } catch (error) {
    return { kind: "unreadable", message: `${CLAIM_UNREADABLE_ADVICE} (${(error as Error).message})` };
  }
  if (bytes === null) return { kind: "absent" };
  try {
    return { kind: "claimed", claim: parseClaim(bytes, requestHash) };
  } catch (error) {
    return { kind: "unreadable", message: `${CLAIM_UNREADABLE_ADVICE} (${(error as Error).message})` };
  }
}

/** Bind a receive request to a pair, permanently — step (1) of the frozen write
 *  order, before any encapsulation happens.
 *
 *  Idempotent for the SAME pair: a claim of R → P when R is already claimed by P
 *  returns the existing claim untouched, because that is the retry of an
 *  interrupted pre-handoff attempt and is explicitly allowed. A claim of R → Q
 *  when R is bound to P is refused, permanently, whatever state P's handoff is
 *  in — including absent.
 *
 *  The caller holds the request-scoped sender lock. */
export async function claimRequestForPair(
  vfs: Vfs,
  requestHash: Uint8Array,
  pairId: string,
  at: string
): Promise<RequestClaim> {
  if (!HEX_32.test(pairId)) throw new RangeError("pairId must be 32 lowercase hex characters");
  const path = claimPath(requestHash);
  const existing = await readRequestClaim(vfs, requestHash);

  if (existing.kind === "unreadable") {
    throw new EngineRefused(REFUSE_CLAIM_UNREADABLE, existing.message);
  }
  if (existing.kind === "claimed") {
    if (existing.claim.pairId !== pairId) {
      throw new EngineRefused(
        REFUSE_CLAIMED_ELSEWHERE,
        "This receive request is already bound to a different pad. A request receives one pad and one package; " +
          "sealing a second pad to it would leave the recipient two packages with two different confirmation " +
          "codes and no way to tell which is real. Ask for a new receive request."
      );
    }
    // Same pair: the retry of a pre-handoff attempt. Nothing is rewritten, so
    // the recorded time stays the time of the FIRST binding.
    return existing.claim;
  }

  const claim: RequestClaim = {
    version: CLAIM_VERSION,
    requestHash: toBase64Url(requestHash),
    pairId,
    at
  };
  try {
    await vfs.writeFileAtomic(path, serializeClaim(claim));
  } catch (error) {
    // Which case is this? Ask the disk, never the exception's shape. If no
    // record landed, nothing is bound and a retry is legitimate. If one did,
    // the request is bound to SOMETHING we cannot read, and fails closed.
    let landed = false;
    try {
      landed = (await vfs.readFile(path)) !== null;
    } catch {
      landed = true;
    }
    if (!landed) throw error;
    throw new EngineRefused(
      REFUSE_CLAIM_UNREADABLE,
      `${CLAIM_UNREADABLE_ADVICE} (writing the binding failed after it had begun: ${(error as Error).message})`
    );
  }

  const readBack = await vfs.readFile(path);
  if (readBack === null) {
    throw new EngineRefused(REFUSE_CLAIM_UNREADABLE, `${CLAIM_UNREADABLE_ADVICE} (the binding did not survive being written)`);
  }
  let verified: RequestClaim;
  try {
    verified = parseClaim(readBack, requestHash);
  } catch (error) {
    throw new EngineRefused(
      REFUSE_CLAIM_UNREADABLE,
      `${CLAIM_UNREADABLE_ADVICE} (the binding read back invalid: ${(error as Error).message})`
    );
  }
  if (verified.pairId !== pairId) {
    throw new EngineRefused(REFUSE_CLAIM_UNREADABLE, `${CLAIM_UNREADABLE_ADVICE} (the binding read back naming another pad)`);
  }
  return verified;
}

/** The check `commitSealedHandoff` runs before it will commit anything: this
 *  request must already be bound, and bound to THIS pair.
 *
 *  Enforcing it in storage rather than trusting the caller is deliberate. It
 *  makes the frozen write order structural — a caller cannot commit a handoff
 *  it never claimed — so a later mistake in the product layer cannot produce a
 *  second package for one request. */
export async function requireClaimedByPair(vfs: Vfs, requestHash: Uint8Array, pairId: string): Promise<RequestClaim> {
  const state = await readRequestClaim(vfs, requestHash);
  if (state.kind === "unreadable") throw new EngineRefused(REFUSE_CLAIM_UNREADABLE, state.message);
  if (state.kind === "absent") {
    throw new EngineRefused(
      REFUSE_NOT_CLAIMED,
      "This receive request was never bound to this pad, so no package may be committed for it. " +
        "The binding is written before anything is encapsulated."
    );
  }
  if (state.claim.pairId !== pairId) {
    throw new EngineRefused(
      REFUSE_CLAIMED_ELSEWHERE,
      "This receive request is bound to a different pad. Ask for a new receive request."
    );
  }
  return state.claim;
}
