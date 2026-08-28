/* ============================================================================
 * TruePad Browser Edition — browser rollback witness classes (§15, §BROWSER-
 * SECURITY.md §4)
 * ----------------------------------------------------------------------------
 * The rollback witness remembers how far a store has advanced, so a store
 * rolled back by a backup/profile restore refuses to move (`witness-
 * regressed`) instead of reusing retired positions or refilling a contested
 * record's attempt budget. It records EXACTLY the three frozen monotone
 * counters and nothing else (ledger N17):
 *
 *   { encryptionNextOffset, authenticationNextSequence, attemptsReserved }
 *
 * The CLI's `separate-state-file` class assumes a file in an INDEPENDENT host
 * failure domain. A browser page has no such reach, so this edition does NOT
 * offer it and does NOT relabel browser-local state as its equivalent. Two
 * honest classes:
 *
 *   browser-none               — no witness. A no-op. Restoring the OPFS store
 *                                regresses it and resets the per-record attempt
 *                                budget; §BROWSER-SECURITY.md §4 states this.
 *   browser-independent-store  — counters in a SECOND OPFS store, a directory
 *                                distinct from the pair dir (root
 *                                `witness/<pairId>.json`). This is only as
 *                                independent as the two stores' clearing/backup
 *                                are: both live under the same origin, and
 *                                "clear site data" removes both. Weaker than the
 *                                CLI's cross-medium witness — the UI says so.
 *
 * Because both stores live under one origin, an emptied or cleared witness
 * "knows nothing" (§4): an absent witness file reads as FRESH, not as an
 * outage. This is the honest browser behaviour and is deliberately NOT the
 * CLI's fail-closed-on-a-missing-configured-file. A witness that PARSES but
 * violates its own three-counter shape is `witness-inconsistent`.
 * ========================================================================= */

import type { PadDirection } from "../../core/pad.ts";
import type { BrowserWitnessClass } from "./protocol.ts";
import type { Vfs } from "./vfs.ts";

export type WitnessCounters = {
  encryptionNextOffset: number;
  authenticationNextSequence: number;
  attemptsReserved: number;
};

// The non-secret comparison of a store against its witness, for status (§15.3).
export type WitnessState = "n/a" | "fresh" | "aligned" | "ahead" | "regressed" | "unreachable" | "inconsistent";

export type WitnessPreflight =
  | { ok: true; state: "n/a" | "fresh" | "aligned" | "ahead" }
  | { ok: false; reason: "witness-regressed" | "witness-inconsistent"; message: string };

type WitnessFile = { formatVersion: 2; witness: Record<string, WitnessCounters> };

const enc = new TextEncoder();
const dec = new TextDecoder();

const witnessPath = (pairId: string): string => `witness/${pairId}.json`;
const keyOf = (pairId: string, direction: PadDirection): string => `${pairId}/${direction}`;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate a parsed witness file against the §15.2 shape. Returns a freshly
// constructed WitnessFile, or the reason it fails — a missing, extra or
// negative counter field is a shape violation (fails closed), never a silent 0.
function validateWitnessFile(raw: unknown): { file: WitnessFile } | { why: string } {
  if (!isRecord(raw)) {
    return { why: "not a JSON object" };
  }
  if (raw.formatVersion !== 2) {
    return { why: `formatVersion must be the integer 2 (found ${JSON.stringify(raw.formatVersion)})` };
  }
  if (!isRecord(raw.witness)) {
    return { why: "witness must be an object mapping <pairId>/<direction> to counters" };
  }
  const witness: Record<string, WitnessCounters> = {};
  for (const [key, value] of Object.entries(raw.witness)) {
    if (!isRecord(value)) {
      return { why: `witness["${key}"] is not an object` };
    }
    const keys = Object.keys(value);
    if (
      keys.length !== 3 ||
      !isSafeCount(value.encryptionNextOffset) ||
      !isSafeCount(value.authenticationNextSequence) ||
      !isSafeCount(value.attemptsReserved)
    ) {
      return {
        why:
          `witness["${key}"] must be exactly { encryptionNextOffset, authenticationNextSequence, attemptsReserved } ` +
          `with safe integers >= 0 and no other keys`
      };
    }
    witness[key] = {
      encryptionNextOffset: value.encryptionNextOffset,
      authenticationNextSequence: value.authenticationNextSequence,
      attemptsReserved: value.attemptsReserved
    };
  }
  return { file: { formatVersion: 2, witness } };
}

type ReadResult =
  | { ok: true; counters: WitnessCounters | null } // null = no entry / fresh witness
  | { ok: false; reason: "witness-inconsistent"; message: string };

async function readWitness(vfs: Vfs, pairId: string, direction: PadDirection): Promise<ReadResult> {
  const bytes = await vfs.readFile(witnessPath(pairId));
  if (bytes === null || dec.decode(bytes).trim() === "") {
    // Absent / empty: a fresh (or cleared) witness — it knows nothing (§4).
    return { ok: true, counters: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch (error) {
    return {
      ok: false,
      reason: "witness-inconsistent",
      message: `the rollback witness at ${witnessPath(pairId)} does not parse as JSON (${(error as Error).message}). Nothing was burned.`
    };
  }
  const validated = validateWitnessFile(parsed);
  if ("why" in validated) {
    return {
      ok: false,
      reason: "witness-inconsistent",
      message: `the rollback witness at ${witnessPath(pairId)} violates its own shape — ${validated.why} (§15.2). Nothing was burned.`
    };
  }
  return { ok: true, counters: validated.file.witness[keyOf(pairId, direction)] ?? null };
}

// ADVANCE: read-modify-write the entry, MONOTONE (elementwise maximum), atomic
// replace + flush. Creates the file if absent. Throws only on I/O failure.
async function advanceWitness(vfs: Vfs, pairId: string, direction: PadDirection, counters: WitnessCounters): Promise<void> {
  const bytes = await vfs.readFile(witnessPath(pairId));
  let file: WitnessFile;
  if (bytes === null || dec.decode(bytes).trim() === "") {
    file = { formatVersion: 2, witness: {} };
  } else {
    const validated = validateWitnessFile(JSON.parse(dec.decode(bytes)));
    if ("why" in validated) {
      throw new Error(`the rollback witness at ${witnessPath(pairId)} is inconsistent (${validated.why}); refusing to advance over it`);
    }
    file = validated.file;
  }
  const key = keyOf(pairId, direction);
  const prev = file.witness[key] ?? { encryptionNextOffset: 0, authenticationNextSequence: 0, attemptsReserved: 0 };
  file.witness[key] = {
    encryptionNextOffset: Math.max(prev.encryptionNextOffset, counters.encryptionNextOffset),
    authenticationNextSequence: Math.max(prev.authenticationNextSequence, counters.authenticationNextSequence),
    attemptsReserved: Math.max(prev.attemptsReserved, counters.attemptsReserved)
  };
  await vfs.writeFileAtomic(witnessPath(pairId), enc.encode(JSON.stringify(file)));
}

// The store's effective high-waters, for the preflight/report comparison.
export type StoreHighWaters = { nextOffset: number; nextSequence: number; attemptsReserved: number };

function belowWitness(store: StoreHighWaters, w: WitnessCounters): boolean {
  return (
    store.nextOffset < w.encryptionNextOffset ||
    store.nextSequence < w.authenticationNextSequence ||
    store.attemptsReserved < w.attemptsReserved
  );
}

function alignedWith(store: StoreHighWaters, w: WitnessCounters): boolean {
  return (
    store.nextOffset === w.encryptionNextOffset &&
    store.nextSequence === w.authenticationNextSequence &&
    store.attemptsReserved === w.attemptsReserved
  );
}

/* ---- the witness classes -------------------------------------------------- */

export type BrowserWitness = {
  readonly witnessClass: BrowserWitnessClass;
  // Provision the witness at gen (browser-independent-store only).
  bootstrap(pairId: string): Promise<void>;
  // §15.3 PREFLIGHT: a free state gate before anything is consumed. A store
  // below its witness refuses `witness-regressed`; a broken witness refuses
  // `witness-inconsistent`.
  preflight(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessPreflight>;
  // §15.3 ADVANCE: after the durable §12 commit, before the emit. Throws on an
  // I/O failure — the caller has already committed, so the output is withheld.
  advance(pairId: string, direction: PadDirection, counters: WitnessCounters): Promise<void>;
  // §15.3 status: read-only comparison; refuses nothing.
  report(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessState>;
};

// browser-none: no witness. Every touchpoint is a no-op; status reports "n/a".
function browserNoneWitness(): BrowserWitness {
  return {
    witnessClass: "browser-none",
    async bootstrap(): Promise<void> {
      /* no witness to provision */
    },
    async preflight(): Promise<WitnessPreflight> {
      return { ok: true, state: "n/a" };
    },
    async advance(): Promise<void> {
      /* no witness to advance */
    },
    async report(): Promise<WitnessState> {
      return "n/a";
    }
  };
}

// browser-independent-store: counters in the separate `witness/<pairId>.json`.
function browserIndependentStoreWitness(vfs: Vfs): BrowserWitness {
  return {
    witnessClass: "browser-independent-store",
    async bootstrap(pairId: string): Promise<void> {
      // Provision both directions at {0,0,0}; protection begins here.
      const zero: WitnessCounters = { encryptionNextOffset: 0, authenticationNextSequence: 0, attemptsReserved: 0 };
      await advanceWitness(vfs, pairId, "A->B", zero);
      await advanceWitness(vfs, pairId, "B->A", zero);
    },
    async preflight(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessPreflight> {
      const result = await readWitness(vfs, pairId, direction);
      if (!result.ok) {
        return { ok: false, reason: result.reason, message: result.message };
      }
      if (result.counters === null) {
        return { ok: true, state: "fresh" };
      }
      if (belowWitness(store, result.counters)) {
        const w = result.counters;
        return {
          ok: false,
          reason: "witness-regressed",
          message:
            `this store is behind its rollback witness: the witness records encryptionNextOffset ` +
            `${w.encryptionNextOffset}, authenticationNextSequence ${w.authenticationNextSequence}, and ` +
            `attemptsReserved ${w.attemptsReserved}, but this store is at nextOffset ${store.nextOffset}, ` +
            `nextSequence ${store.nextSequence}, and attemptsReserved ${store.attemptsReserved}. A store below its ` +
            `witness is the restored-store signature (§9.4): the pair store was rolled back while the witness, in a ` +
            `separate OPFS store the pair's backup does not include, remembers the true high-water and attempt ` +
            `budget. Refusing before anything is consumed. Nothing was burned.`
        };
      }
      return { ok: true, state: alignedWith(store, result.counters) ? "aligned" : "ahead" };
    },
    async advance(pairId: string, direction: PadDirection, counters: WitnessCounters): Promise<void> {
      await advanceWitness(vfs, pairId, direction, counters);
    },
    async report(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessState> {
      const result = await readWitness(vfs, pairId, direction);
      if (!result.ok) {
        return "inconsistent";
      }
      if (result.counters === null) {
        return "fresh";
      }
      if (belowWitness(store, result.counters)) {
        return "regressed";
      }
      return alignedWith(store, result.counters) ? "aligned" : "ahead";
    }
  };
}

// Build the witness for a store's declared rollback class. The head serialises
// browser-none as the CLI's { witnessClass:"none" }, so map that back here.
export function witnessFor(vfs: Vfs, rollbackClass: "none" | "browser-independent-store"): BrowserWitness {
  return rollbackClass === "browser-independent-store" ? browserIndependentStoreWitness(vfs) : browserNoneWitness();
}
