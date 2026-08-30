/* ============================================================================
 * truepad2 platform-monotonic witness — the TPM-anchored state file (§15)
 * ----------------------------------------------------------------------------
 * Node only. The `platform-monotonic` witness class, provider
 * `tpm2-nv-counter-v1`.
 *
 * THE PROBLEM THIS CLOSES. A separate-state-file witness is a plain file, and a
 * plain file cannot detect its own rollback: restore an old pair AND its old
 * witness together and every check passes, because the two agree. There is no
 * external truth to disagree with them. That is the one residual the previous
 * closures could not reach, and it is why this class exists.
 *
 * THE SHAPE OF THE FIX. Two things, with one invariant between them:
 *
 *   T = a TPM 2.0 NV COUNTER — an external authority that only counts up and
 *       cannot be restored, because it does not live in any backup.
 *   F = a durable local state file holding the actual witness map, which a TPM
 *       counter is far too small to hold.
 *
 *   NORMAL:    F.anchor == T
 *   PREPARED:  F.anchor == T + 1     (a commit interrupted before the TPM)
 *   ANYTHING ELSE FAILS CLOSED.
 *
 * Restore F to an older copy and F.anchor < T: the file is behind the hardware
 * and the rollback is visible. It is refused BEFORE anything is consumed, and
 * refused permanently — the TPM is never lowered (it cannot be) and the witness
 * counters are never guessed.
 *
 * WHY THE STATE FILE IS WRITTEN FIRST. The advance prepares F at T+1 durably,
 * and only then increments the TPM. The hardware increment is the COMMIT POINT:
 * before it, nothing was promised and the operation simply lost its record;
 * after it, F already describes the state the anchor now attests. A crash in
 * between leaves the recoverable PREPARED state, which the next preflight
 * completes with exactly one increment. The reverse order would leave a window
 * where the TPM had moved and no durable record said why — unrecoverable.
 *
 * The TPM holds NO pad material and nothing derived from it: one uint64 that
 * counts up. The witness record shape is unchanged (§15.2's three counters).
 *
 * TRUST BOUNDARY, stated rather than implied. TruePad trusts the host to be
 * talking to the real TPM. This is rollback resistance against RESTORE — of the
 * pair, of the state file, or of both together — which is the attack a plain
 * file cannot see. It is NOT a claim against a compromised host, malicious
 * firmware, or a subverted TPM, and no counter inside a machine can defend that
 * machine against its own owner.
 * ========================================================================= */

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { PadDirection } from "../../core/pad.ts";
import {
  acquireWitnessLock,
  writeWitnessDurably,
  type WitnessCounters,
  type WitnessSnapshot
} from "./witness.ts";
import { PROVIDER_ID, UINT64_MAX, parseNvIndex, tpm2ToolsProvider, type TpmProvider } from "./tpm.ts";

export const PLATFORM_STATE_VERSION = 1;

// The durable local half of the authority. Non-secret throughout: public
// identifiers, and the same three monotone counters §15.2 already freezes.
// `anchor` is a DECIMAL STRING because a TPM counter is a uint64 and JavaScript
// numbers stop being exact at 2^53 — it is parsed to BigInt, never to Number.
export type PlatformWitnessState = {
  formatVersion: number;
  provider: string;
  authorityId: string;
  nvIndex: string;
  nvName: string;
  anchor: string;
  witness: Record<string, WitnessCounters>;
};

// What the pair header carries (rollback.config for platform-monotonic). It
// binds the pair to one authority: provider, state file, NV index, the index's
// TPM Name, and the authority id. A substituted state file, a re-created index,
// or a different authority is therefore visible rather than silently adopted.
export type PlatformConfig = {
  provider: string;
  statePath: string;
  nvIndex: string;
  nvName: string;
  authorityId: string;
};

export type PlatformResult<T> = { ok: true; value: T } | { ok: false; message: string };

const keyOf = (pairId: string, direction: PadDirection): string => `${pairId}/${direction}`;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A uint64 written as decimal digits. Rejects signs, whitespace, leading zeros
// beyond "0" itself, and anything past the uint64 ceiling.
function parseAnchor(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    return null;
  }
  const value = BigInt(raw);
  return value <= UINT64_MAX ? value : null;
}

export function validatePlatformState(raw: unknown): { state: PlatformWitnessState } | { why: string } {
  if (!isRecord(raw)) return { why: "not a JSON object" };
  if (raw.formatVersion !== PLATFORM_STATE_VERSION) {
    return { why: `formatVersion must be the integer ${PLATFORM_STATE_VERSION} (found ${JSON.stringify(raw.formatVersion)})` };
  }
  if (raw.provider !== PROVIDER_ID) {
    return { why: `provider must be "${PROVIDER_ID}" (found ${JSON.stringify(raw.provider)})` };
  }
  if (typeof raw.authorityId !== "string" || !/^[0-9a-f]{32}$/.test(raw.authorityId)) {
    return { why: "authorityId must be 32 lowercase hex characters" };
  }
  const index = parseNvIndex(raw.nvIndex);
  if (!index.ok) return { why: index.why };
  if (typeof raw.nvName !== "string" || !/^[0-9a-f]{4,128}$/.test(raw.nvName)) {
    return { why: "nvName must be lowercase hex (the TPM Name of the NV index)" };
  }
  if (parseAnchor(raw.anchor) === null) {
    return { why: `anchor must be a uint64 written as a decimal string (found ${JSON.stringify(raw.anchor)})` };
  }
  if (!isRecord(raw.witness)) return { why: "witness must be an object mapping <pairId>/<direction> to counters" };
  const witness: Record<string, WitnessCounters> = {};
  for (const [key, value] of Object.entries(raw.witness)) {
    if (!isRecord(value)) return { why: `witness["${key}"] is not an object` };
    // The FROZEN §15.2 entry: exactly the three counters, all required.
    if (
      Object.keys(value).length !== 3 ||
      !isSafeCount(value.encryptionNextOffset) ||
      !isSafeCount(value.authenticationNextSequence) ||
      !isSafeCount(value.attemptsReserved)
    ) {
      return {
        why:
          `witness["${key}"] must be exactly { encryptionNextOffset, authenticationNextSequence, attemptsReserved } ` +
          "with safe integers >= 0 and no other keys"
      };
    }
    witness[key] = {
      encryptionNextOffset: value.encryptionNextOffset,
      authenticationNextSequence: value.authenticationNextSequence,
      attemptsReserved: value.attemptsReserved
    };
  }
  return {
    state: {
      formatVersion: PLATFORM_STATE_VERSION,
      provider: PROVIDER_ID,
      authorityId: raw.authorityId,
      nvIndex: index.index,
      nvName: raw.nvName,
      anchor: raw.anchor as string,
      witness
    }
  };
}

function readState(path: string): PlatformResult<PlatformWitnessState> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      message:
        `the platform witness state at ${path} cannot be read (${(error as Error).message}). It fails closed: a ` +
        "platform authority that cannot be reached is an availability failure, never a downgrade to a weaker class."
    };
  }
  if (text.trim() === "") {
    return {
      ok: false,
      message: `the platform witness state at ${path} is empty. An empty file is an accident, never a fresh authority; create one with \`truepad2 witness platform init\`.`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `the platform witness state at ${path} does not parse as JSON (${(error as Error).message})` };
  }
  const validated = validatePlatformState(parsed);
  if ("why" in validated) {
    return { ok: false, message: `the platform witness state at ${path} violates its own shape — ${validated.why}` };
  }
  return { ok: true, value: validated.state };
}

function writeState(path: string, state: PlatformWitnessState): void {
  writeWitnessDurably(path, JSON.stringify(state));
}

/* ---- authority identity --------------------------------------------------- */

// Re-read the NV public area and require it to be the SAME index TruePad bound
// to. A handle is just a number: delete and re-create it with different
// attributes or policy and the number is unchanged, so the TPM Name — the
// index's cryptographic identity — is what gets compared. A different Name is
// a different authority and is never auto-rebound.
function verifyAuthority(tpm: TpmProvider, config: PlatformConfig): PlatformResult<null> {
  const pub = tpm.readPublic(config.nvIndex);
  if (!pub.ok) {
    return { ok: false, message: `the TPM NV index ${config.nvIndex} could not be read (${pub.message})` };
  }
  if (!pub.value.isCounter) {
    return {
      ok: false,
      message:
        `the TPM NV index ${config.nvIndex} is not a COUNTER (attributes: ${pub.value.attributesFriendly}). An ` +
        "ordinary, bitfield, extend or PIN index is an ordinary writable value: holding an integer is not the same " +
        "as being monotonic, and it is never treated as one."
    };
  }
  if (pub.value.isOrderly) {
    return {
      ok: false,
      message:
        `the TPM NV index ${config.nvIndex} has TPMA_NV_ORDERLY set. An orderly counter may update only a RAM ` +
        "representation and defer NV persistence, so an unexpected power loss can lose increments — exactly the " +
        "rollback this class exists to prevent. It is refused, never accepted as a performance shortcut."
    };
  }
  if (pub.value.sizeBytes !== 8) {
    return { ok: false, message: `the TPM NV index ${config.nvIndex} is ${pub.value.sizeBytes} octets; a counter must be exactly 8` };
  }
  if (pub.value.name !== config.nvName) {
    return {
      ok: false,
      message:
        `the TPM NV index ${config.nvIndex} no longer has the Name TruePad bound to. Expected ${config.nvName}, ` +
        `found ${pub.value.name}. The same handle has been re-created with different attributes or policy, so it is ` +
        "a DIFFERENT authority. It is not auto-rebound: re-binding would let a fresh counter impersonate the one " +
        "that recorded this pair's high-water."
    };
  }
  return { ok: true, value: null };
}

/* ---- the anchor relation --------------------------------------------------- */

export type AnchorState = { kind: "normal"; anchor: bigint } | { kind: "prepared"; anchor: bigint };

// The ONLY two relations that may proceed. Everything else fails closed, and
// the two failures are named apart because they mean different things:
// F < T is a restored/replaced state file (the attack this class closes);
// F > T + 1 is corruption or a foreign authority.
export function classifyAnchor(fileAnchor: bigint, tpmCounter: bigint): PlatformResult<AnchorState> {
  if (fileAnchor === tpmCounter) {
    return { ok: true, value: { kind: "normal", anchor: fileAnchor } };
  }
  if (fileAnchor === tpmCounter + 1n) {
    return { ok: true, value: { kind: "prepared", anchor: fileAnchor } };
  }
  if (fileAnchor < tpmCounter) {
    return {
      ok: false,
      message:
        `the platform witness state is BEHIND its TPM anchor (state ${fileAnchor}, TPM ${tpmCounter}). The state ` +
        "file was restored, replaced, or is from another authority, while the TPM counter — which cannot be " +
        "restored — kept moving. This is the rollback this class exists to detect. It is NOT repaired: the TPM is " +
        "never lowered, and the witness counters are never guessed. Restore the correct platform witness state, or " +
        "provision a new authority and re-establish the pairs it records."
    };
  }
  return {
    ok: false,
    message:
      `the platform witness state is AHEAD of its TPM anchor by more than one (state ${fileAnchor}, TPM ` +
      `${tpmCounter}). Only state == TPM (settled) and state == TPM + 1 (a commit interrupted before the hardware ` +
      "increment) are consistent. This is corrupt or belongs to a different authority, and it fails closed."
  };
}

/* ---- reconciliation: settle a prepared commit ------------------------------ */

// A crash between the durable state write and the TPM increment leaves
// F.anchor == T + 1. That is RECOVERABLE, and safe to complete, because the
// interrupted operation never emitted anything: output is released only after
// the anchor is committed. Completing it is exactly one increment, and the
// result is verified.
function reconcile(tpm: TpmProvider, config: PlatformConfig, state: PlatformWitnessState): PlatformResult<bigint> {
  const counter = tpm.readCounter(config.nvIndex);
  if (!counter.ok) {
    return { ok: false, message: `the TPM NV counter at ${config.nvIndex} could not be read (${counter.message})` };
  }
  const fileAnchor = parseAnchor(state.anchor);
  if (fileAnchor === null) {
    return { ok: false, message: "the platform witness anchor is not a uint64 decimal string" };
  }
  const classified = classifyAnchor(fileAnchor, counter.value);
  if (!classified.ok) {
    return { ok: false, message: classified.message };
  }
  if (classified.value.kind === "normal") {
    return { ok: true, value: counter.value };
  }
  // PREPARED: finish the interrupted commit with exactly one increment.
  const bumped = tpm.increment(config.nvIndex);
  if (!bumped.ok) {
    return {
      ok: false,
      message:
        `a previous operation's platform witness commit was interrupted after its state was durable and before the ` +
        `TPM increment, and completing it failed (${bumped.message}). The state remains prepared and will be ` +
        "completed when the TPM is reachable. Nothing was consumed."
    };
  }
  const after = tpm.readCounter(config.nvIndex);
  if (!after.ok) {
    return { ok: false, message: `the TPM NV counter could not be re-read after completing an interrupted commit (${after.message})` };
  }
  if (after.value !== fileAnchor) {
    return {
      ok: false,
      message:
        `completing an interrupted platform witness commit left the TPM at ${after.value}, not the prepared anchor ` +
        `${fileAnchor}. The authority is not in a state TruePad can reason about; it fails closed.`
    };
  }
  return { ok: true, value: after.value };
}

/* ---- the two touchpoints --------------------------------------------------- */

export type PlatformPreflight = {
  snapshot: WitnessSnapshot;
  entry: WitnessCounters | null;
};

// PREFLIGHT. Free: nothing is consumed by any refusal here. Verifies the
// authority's identity, settles a prepared commit if one is pending, requires
// the anchor relation, and captures the WHOLE witness map as this operation's
// snapshot (the b43a21d closure, unchanged).
export function platformPreflight(
  config: PlatformConfig,
  pairId: string,
  direction: PadDirection,
  tpm: TpmProvider = tpm2ToolsProvider()
): PlatformResult<PlatformPreflight> {
  if (config.provider !== PROVIDER_ID) {
    return { ok: false, message: `unknown platform witness provider ${JSON.stringify(config.provider)}` };
  }
  const ready = tpm.available();
  if (!ready.ok) {
    return { ok: false, message: ready.message };
  }
  const release = acquireWitnessLock(config.statePath, { pairId, direction });
  try {
    const identity = verifyAuthority(tpm, config);
    if (!identity.ok) {
      return identity;
    }
    const state = readState(config.statePath);
    if (!state.ok) {
      return state;
    }
    if (state.value.authorityId !== config.authorityId) {
      return {
        ok: false,
        message:
          `the platform witness state at ${config.statePath} belongs to authority ${state.value.authorityId}, but ` +
          `this pair is bound to ${config.authorityId}. A substituted state file is not adopted.`
      };
    }
    if (state.value.nvName !== config.nvName || state.value.nvIndex !== config.nvIndex) {
      return {
        ok: false,
        message: `the platform witness state at ${config.statePath} names a different NV index or Name than this pair's header`
      };
    }
    const settled = reconcile(tpm, config, state.value);
    if (!settled.ok) {
      return settled;
    }
    // Re-read after a possible prepared-commit completion so the snapshot is
    // the settled state, not the pre-recovery one.
    const current = readState(config.statePath);
    if (!current.ok) {
      return current;
    }
    return {
      ok: true,
      value: {
        snapshot: { entries: current.value.witness },
        entry: current.value.witness[keyOf(pairId, direction)] ?? null
      }
    };
  } finally {
    release();
  }
}

// ADVANCE. Runs after the §12 durable store commit and before the emit. The
// state file is PREPARED at T+1 durably, then the TPM is incremented — the
// hardware increment is the commit point of the external authority — then the
// counter is re-read and must equal the prepared anchor. Only then may the
// caller emit.
export function platformAdvance(
  config: PlatformConfig,
  pairId: string,
  direction: PadDirection,
  counters: WitnessCounters,
  snapshot: WitnessSnapshot | null,
  tpm: TpmProvider = tpm2ToolsProvider()
): PlatformResult<null> {
  const release = acquireWitnessLock(config.statePath, { pairId, direction });
  try {
    const identity = verifyAuthority(tpm, config);
    if (!identity.ok) return identity;

    const state = readState(config.statePath);
    if (!state.ok) return state;
    if (state.value.authorityId !== config.authorityId) {
      return { ok: false, message: `the platform witness state belongs to a different authority (${state.value.authorityId})` };
    }

    const settled = reconcile(tpm, config, state.value);
    if (!settled.ok) return settled;

    // Re-read: reconcile() may have completed a prepared commit.
    const current = readState(config.statePath);
    if (!current.ok) return current;

    // The b43a21d closure, unchanged: nothing this operation already saw may
    // have gone backwards or vanished. Componentwise >=, never byte equality.
    if (snapshot !== null) {
      for (const [key, was] of Object.entries(snapshot.entries)) {
        const now = current.value.witness[key];
        if (now === undefined) {
          return { ok: false, message: `the platform witness entry for ${key} has disappeared since this operation's preflight` };
        }
        if (
          now.encryptionNextOffset < was.encryptionNextOffset ||
          now.authenticationNextSequence < was.authenticationNextSequence ||
          now.attemptsReserved < was.attemptsReserved
        ) {
          return {
            ok: false,
            message: `the platform witness entry for ${key} regressed between this operation's preflight and its advance`
          };
        }
      }
    }

    const key = keyOf(pairId, direction);
    const prev = current.value.witness[key] ?? {
      encryptionNextOffset: 0,
      authenticationNextSequence: 0,
      attemptsReserved: 0
    };
    const merged: Record<string, WitnessCounters> = {
      ...current.value.witness,
      [key]: {
        encryptionNextOffset: Math.max(prev.encryptionNextOffset, counters.encryptionNextOffset),
        authenticationNextSequence: Math.max(prev.authenticationNextSequence, counters.authenticationNextSequence),
        attemptsReserved: Math.max(prev.attemptsReserved, counters.attemptsReserved)
      }
    };

    const nextAnchor = settled.value + 1n;
    if (nextAnchor > UINT64_MAX) {
      return {
        ok: false,
        message:
          `the TPM NV counter at ${config.nvIndex} has reached its uint64 maximum and cannot be incremented again. ` +
          "Refused before attempting the increment: this authority is exhausted and a new one must be provisioned."
      };
    }

    // PREPARE: the state file is durable at T+1 BEFORE the hardware moves. A
    // crash from here to the increment leaves the recoverable prepared state.
    writeState(config.statePath, { ...current.value, anchor: nextAnchor.toString(), witness: merged });

    // COMMIT: the external authority moves. This is the commit point.
    const bumped = tpm.increment(config.nvIndex);
    if (!bumped.ok) {
      return {
        ok: false,
        message:
          `the platform witness state was prepared durably but the TPM increment failed (${bumped.message}). The ` +
          "output is withheld. The prepared state is recoverable: the next operation completes it when the TPM is " +
          "reachable. Nothing was reused."
      };
    }
    const after = tpm.readCounter(config.nvIndex);
    if (!after.ok) {
      return { ok: false, message: `the TPM counter could not be re-read after the increment (${after.message}); the output is withheld` };
    }
    if (after.value !== nextAnchor) {
      return {
        ok: false,
        message: `the TPM counter reads ${after.value} after an increment that should have reached ${nextAnchor}; the output is withheld`
      };
    }
    return { ok: true, value: null };
  } finally {
    release();
  }
}

/* ---- explicit initialization ----------------------------------------------- */

export type PlatformInitResult = { created: boolean; config: PlatformConfig; anchor: string };

// Adopts an ALREADY-PROVISIONED NV counter. TruePad never defines, undefines,
// or clears anything: those touch platform ownership and authorization policy
// and must not hide inside a pad tool. The operator creates the index (see
// docs/CEREMONY.md) and this validates and binds to it.
//
// The single increment here is deliberate. It proves this runtime can actually
// move the counter BEFORE a pad depends on it, initialises an index that has
// never been written, and — because the value must move by exactly one — checks
// the big-endian reading of the counter against the real device rather than
// trusting a documented byte order. It consumes one TPM counter value and no
// pad material.
export function initPlatformWitness(
  statePath: string,
  nvIndex: string,
  tpm: TpmProvider = tpm2ToolsProvider()
): PlatformResult<PlatformInitResult> {
  if (!isAbsolute(statePath)) {
    return { ok: false, message: `the platform witness state path must be absolute; found ${JSON.stringify(statePath)}` };
  }
  const index = parseNvIndex(nvIndex);
  if (!index.ok) {
    return { ok: false, message: index.why };
  }
  const ready = tpm.available();
  if (!ready.ok) return ready;

  // ONE authority path, ONE initialization transaction. The lock is taken
  // BEFORE the state file is even looked at, so two concurrent inits cannot
  // both decide the authority is absent, mint two authorityIds, consume two
  // counter values, and overwrite one another. Same fail-closed discipline as
  // everywhere else: no pid-liveness guessing, a stale lock refuses.
  const release = acquireWitnessLock(statePath);
  try {
    return initLocked(statePath, index.index, tpm);
  } finally {
    release();
  }
}

function initLocked(statePath: string, nvIndex: string, tpm: TpmProvider): PlatformResult<PlatformInitResult> {
  const pub = tpm.readPublic(nvIndex);
  if (!pub.ok) return { ok: false, message: pub.message };
  if (!pub.value.isCounter) {
    return {
      ok: false,
      message:
        `${nvIndex} is not a TPM NV COUNTER (attributes: ${pub.value.attributesFriendly}). Provision a ` +
        "dedicated counter index — TruePad never defines one for you."
    };
  }
  if (pub.value.isOrderly) {
    return {
      ok: false,
      message: `${nvIndex} has TPMA_NV_ORDERLY set, which defers NV persistence and can lose increments across power loss. Refused.`
    };
  }
  if (pub.value.sizeBytes !== 8) {
    return { ok: false, message: `${nvIndex} is ${pub.value.sizeBytes} octets; a TPM NV counter must be exactly 8` };
  }

  // ---- an existing authority: adopt it, and touch NOTHING ------------------
  let existing: PlatformWitnessState | null = null;
  try {
    statSync(statePath);
    const loaded = readState(statePath);
    if (!loaded.ok) {
      return {
        ok: false,
        message: `${statePath} exists and is not a valid platform witness state (${loaded.message}). It is NOT overwritten; inspect it by hand.`
      };
    }
    existing = loaded.value;
  } catch {
    /* absent: a fresh authority */
  }

  if (existing !== null) {
    if (existing.nvIndex !== nvIndex || existing.nvName !== pub.value.name) {
      return {
        ok: false,
        message:
          `${statePath} is already bound to NV index ${existing.nvIndex} (Name ${existing.nvName}), not to ` +
          `${nvIndex} (Name ${pub.value.name}). It is NOT re-bound.`
      };
    }
    if (Object.keys(existing.witness).length > 0) {
      const n = Object.keys(existing.witness).length;
      return {
        ok: false,
        message:
          `${statePath} is a live platform witness recording ${n} entr${n === 1 ? "y" : "ies"}. It is NOT ` +
          "overwritten: that would discard the high-water this authority exists to remember."
      };
    }
    // TRUE idempotence. Re-running init against an authority that is already
    // settled must consume NOTHING: no increment, no rewrite, no new
    // authorityId. Calling something idempotent while quietly spending a
    // hardware counter value would be a lie, and TPM counters are finite.
    const counter = tpm.readCounter(nvIndex);
    if (!counter.ok) {
      return { ok: false, message: `${nvIndex} could not be read (${counter.message})` };
    }
    const fileAnchor = parseAnchor(existing.anchor);
    if (fileAnchor === null) {
      return { ok: false, message: `${statePath} has a malformed anchor` };
    }
    const classified = classifyAnchor(fileAnchor, counter.value);
    if (!classified.ok) {
      return {
        ok: false,
        message:
          `${statePath} exists but its anchor and the TPM counter are not in a valid relation. ` +
          `${classified.message} Initialization does not repair this: use the normal operational path, which ` +
          "completes an interrupted commit, or restore the correct authority."
      };
    }
    if (classified.value.kind === "prepared") {
      return {
        ok: false,
        message:
          `${statePath} holds a PREPARED commit (anchor ${fileAnchor}, TPM ${counter.value}): a previous operation ` +
          "was interrupted between its durable state write and the TPM increment. Initialization does not complete " +
          "it — the next ordinary operation does, under the operational protocol. Nothing was changed."
      };
    }
    return {
      ok: true,
      value: {
        created: false,
        config: {
          provider: PROVIDER_ID,
          statePath,
          nvIndex,
          nvName: pub.value.name,
          authorityId: existing.authorityId
        },
        anchor: existing.anchor
      }
    };
  }

  // ---- a fresh authority ---------------------------------------------------
  //
  // TPMA_NV_WRITTEN decides how this begins, and getting it wrong made the
  // previous build unusable on every real first use. A freshly DEFINED counter
  // has WRITTEN CLEAR: it has NO value, and TPM2_NV_Read returns
  // TPM_RC_NV_UNINITIALIZED. Reading first — as the previous build did — fails
  // before the counter can ever be used. Its FIRST TPM2_NV_Increment is what
  // initializes it, to the TPM's largest-ever NV counter value (NOT to zero:
  // the TPM makes no such promise, and this build requires none).
  let firstRead: bigint;
  let increments: number;
  if (!pub.value.isWritten) {
    // Initialize it. No read first — there is nothing to read.
    const init = tpm.increment(nvIndex);
    if (!init.ok) {
      return {
        ok: false,
        message:
          `${nvIndex} is an unwritten counter and its initializing increment failed (${init.message}). ` +
          "Initialization proves increment access before any pad depends on this authority, so this fails closed."
      };
    }
    const t1 = tpm.readCounter(nvIndex);
    if (!t1.ok) {
      return { ok: false, message: `${nvIndex} could not be read after its initializing increment (${t1.message})` };
    }
    firstRead = t1.value;
    increments = 1;
  } else {
    const t0 = tpm.readCounter(nvIndex);
    if (!t0.ok) return { ok: false, message: t0.message };
    firstRead = t0.value;
    increments = 0;
  }

  if (firstRead >= UINT64_MAX) {
    return { ok: false, message: `${nvIndex} is at the uint64 maximum and cannot be incremented` };
  }

  // One further CONTROLLED increment, on both branches, so the runtime
  // confirmation survives: the value must move by exactly one. That proves
  // increment access under this runtime AND checks the big-endian reading of
  // the raw 8 octets against the real device, rather than trusting a documented
  // byte order. A first-time init of an unwritten counter therefore spends TWO
  // counter values (one to initialize, one to confirm) and a written one spends
  // ONE. Both are acceptable: no pad material exists yet.
  const bumped = tpm.increment(nvIndex);
  if (!bumped.ok) {
    return {
      ok: false,
      message:
        `${nvIndex} could not be incremented (${bumped.message}). Initialization proves increment access before ` +
        "any pad depends on this authority, so this fails closed. Check the index's authorization model."
    };
  }
  increments += 1;
  const after = tpm.readCounter(nvIndex);
  if (!after.ok) return { ok: false, message: after.message };
  if (after.value !== firstRead + 1n) {
    return {
      ok: false,
      message:
        `${nvIndex} read ${firstRead} then ${after.value} across one increment, which is not a difference of ` +
        "one. Either this is not behaving as a TPM NV counter, or the 8-octet value is not the big-endian uint64 " +
        "this build reads it as. Refused rather than anchoring a pad to a value TruePad cannot interpret."
    };
  }

  // Public, random, not pad-derived. Binds a state file to a pair header so a
  // substituted file of the same shape is detected.
  // Bind to the SETTLED Name, re-read after the increments — not the one read
  // at the top of this function.
  //
  // The TPM Name of an NV index is computed over its PUBLIC AREA, and the
  // public area includes the attributes — TPMA_NV_WRITTEN among them. So the
  // Name CHANGES the moment a fresh counter's first increment sets WRITTEN.
  // Binding to the pre-write Name made every later operation fail its own
  // identity check; it is a real TPM behaviour that no fake predicted, and the
  // emulator interoperability job is what surfaced it. Once written, an index
  // stays written, so the settled Name is stable for the authority's life.
  const settled = tpm.readPublic(nvIndex);
  if (!settled.ok) {
    return { ok: false, message: `${nvIndex} could not be re-read after initialization (${settled.message})` };
  }
  if (!settled.value.isWritten) {
    return {
      ok: false,
      message: `${nvIndex} still reports TPMA_NV_WRITTEN clear after an increment; this is not behaving as a TPM NV counter`
    };
  }
  const authorityId = randomBytes(16).toString("hex");
  writeState(statePath, {
    formatVersion: PLATFORM_STATE_VERSION,
    provider: PROVIDER_ID,
    authorityId,
    nvIndex,
    nvName: settled.value.name,
    anchor: after.value.toString(),
    witness: {}
  });
  return {
    ok: true,
    value: {
      created: true,
      config: { provider: PROVIDER_ID, statePath, nvIndex, nvName: settled.value.name, authorityId },
      anchor: after.value.toString()
    }
  };
}
