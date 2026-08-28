/* ============================================================================
 * TruePad Browser Edition — the crash-safe browser rollback witness (§15,
 * §BROWSER-SECURITY.md §4)
 * ----------------------------------------------------------------------------
 * The rollback witness remembers how far a store has advanced, so a store
 * rolled back by a backup/profile restore refuses to move (`witness-regressed`)
 * instead of reusing retired positions or refilling a contested record's
 * attempt budget. It records EXACTLY the three frozen monotone counters and
 * nothing else (ledger N17):
 *
 *   { encryptionNextOffset, authenticationNextSequence, attemptsReserved }
 *
 * This is a browser-PRODUCT layer, NOT a class of the frozen store. The store's
 * head.json always carries the CLI's rollback:{witnessClass:"none"} (store.ts);
 * whether a pair also carries a browser-local witness is recorded in the
 * browser-only pair.json (`witness`), and the two kinds are:
 *
 *   browser-none          — no witness. A no-op. Restoring the OPFS store
 *                           regresses it and resets the per-record attempt
 *                           budget; §BROWSER-SECURITY.md §4 states this. A bare
 *                           FORMAT-V2 store placed directly (e.g. a CLI store)
 *                           that the browser never provisioned is browser-none.
 *   browser-local-witness — an APPEND-ONLY journal in a SECOND OPFS store
 *                           (`witness/<pairId>.log`, a directory distinct from
 *                           the pair dir). Named honestly: browser-LOCAL, not an
 *                           independent host failure domain. Both stores live
 *                           under one origin; "clear site data" removes both.
 *
 * CRASH SAFETY (the §3 fix). The journal is APPEND-ONLY and is NEVER truncated,
 * so no write interruption can shrink it, and records are LEADING-newline framed
 * (`\n<json>`, encodeRecord). `appendFile` gives no record boundary, so a crash
 * mid-append can leave a newline-free partial at EOF — but leading framing bounds
 * every record by its own `\n` and the next record's `\n`, so a torn partial is
 * always an isolated line, never fused with the record before or after it. The
 * read DROPS any line that does not parse and folds the SURVIVING records into
 * the per-direction max. So only a TORN advance loses its own value; every
 * advance whose append COMPLETED is preserved. Crucially, a torn advance's
 * operation ERRORED and WITHHELD its output (burn emits the envelope / open
 * releases the plaintext only AFTER a successful advance), so the witness never
 * under-reports below a state whose output was RELEASED — a rollback below any
 * released-output high-water is still caught `witness-regressed`, and the very
 * next clean advance re-records the current high-water (self-heal). Because a
 * provisioned journal is never emptied by an advance, an established
 * browser-local witness NEVER reads as "fresh": a provisioned pair (pair.json
 * says browser-local-witness) whose journal is missing, empty, all-corrupt, or
 * missing a direction fails CLOSED as `witness-inconsistent`. Bootstrap — the
 * explicit provisioning event — is the only writer that creates the first
 * records, at gen or a successful import, never inferred from an empty file.
 * (Skipping — not failing closed on — a malformed line is safe: the witness
 * cannot defend against an attacker who can already rewrite same-origin OPFS,
 * the §4 browser-local limitation; its jobs are crash-safety and detecting a
 * rollback of the PAIR store.)
 * ========================================================================= */

import type { PadDirection } from "../../core/pad.ts";
import type { Vfs } from "./vfs.ts";

// The browser-product witness kind, as recorded in pair.json.
export type BrowserWitnessKind = "browser-none" | "browser-local-witness";

export type WitnessCounters = {
  encryptionNextOffset: number;
  authenticationNextSequence: number;
  attemptsReserved: number;
};

// The non-secret comparison of a store against its witness, for status (§15.3).
export type WitnessState = "n/a" | "aligned" | "ahead" | "regressed" | "inconsistent";

export type WitnessPreflight =
  | { ok: true; state: "n/a" | "aligned" | "ahead" }
  | { ok: false; reason: "witness-regressed" | "witness-inconsistent"; message: string };

// The store's effective high-waters, for the preflight/report comparison.
export type StoreHighWaters = { nextOffset: number; nextSequence: number; attemptsReserved: number };

const enc = new TextEncoder();
const dec = new TextDecoder();

const witnessLogPath = (pairId: string): string => `witness/${pairId}.log`;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---- the append-only journal --------------------------------------------- */

// One physical record on the witness journal. The three counters are stored
// under short keys so the file stays small; the shape is validated strictly.
type WitnessRecord = { direction: PadDirection; counters: WitnessCounters };

// Each record is framed with a LEADING newline (`\n<json>`), NOT a trailing one.
// This is what makes a torn append harmless to its neighbours: `appendFile`
// writes at EOF with no boundary, so a crash mid-append can leave a newline-free
// partial. With leading framing, every record — the torn one included — is
// bounded on the LEFT by its own `\n` and on the RIGHT by the NEXT record's `\n`,
// so a torn partial is always an isolated line that the reader drops, and it can
// never fuse into and destroy the record before OR after it. (Trailing framing
// would let a torn partial swallow the following clean record — the flaw this
// framing fixes.)
function encodeRecord(direction: PadDirection, counters: WitnessCounters): Uint8Array {
  const line = JSON.stringify({
    d: direction,
    eno: counters.encryptionNextOffset,
    ans: counters.authenticationNextSequence,
    ar: counters.attemptsReserved
  });
  return enc.encode(`\n${line}`);
}

function parseRecord(raw: unknown): WitnessRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (Object.keys(raw).length !== 4) {
    return null;
  }
  if (raw.d !== "A->B" && raw.d !== "B->A") {
    return null;
  }
  if (!isSafeCount(raw.eno) || !isSafeCount(raw.ans) || !isSafeCount(raw.ar)) {
    return null;
  }
  return {
    direction: raw.d,
    counters: { encryptionNextOffset: raw.eno, authenticationNextSequence: raw.ans, attemptsReserved: raw.ar }
  };
}

type ReadEffective =
  | { present: false } // absent / empty / no surviving record — no provisioned high-water
  | { present: true; byDirection: Map<PadDirection, WitnessCounters> };

// Read the append-only journal and fold the SURVIVING records into the
// per-direction elementwise maximum. This is what makes the journal crash-safe
// WITHOUT relying on any atomic replace:
//
//   * Records are LEADING-newline framed (encodeRecord: `\n<json>`), so every
//     record is bounded by its own `\n` and the next record's `\n`. A torn
//     append (a crash mid-append) leaves an isolated partial line, never one
//     fused with the record before or after it. Any unparseable / malformed
//     line is skipped, wherever it sits.
//   * Only a TORN advance loses its own value; every advance whose append
//     COMPLETED is on its own clean line and is always folded in. Because a
//     torn advance's operation ERRORED (its output was withheld — burn's
//     envelope / open's plaintext is emitted only AFTER a successful advance),
//     the witness never under-reports below a state whose output was released:
//     a rollback below any released-output high-water is still caught
//     witness-regressed. The very next CLEAN advance re-records the current
//     high-water, so the witness self-heals immediately.
//
// Skipping (rather than failing closed on) a malformed line is safe here
// precisely because the witness cannot defend against an attacker who can
// already rewrite same-origin OPFS — that is the §4 browser-local limitation,
// not this layer's job. Its jobs are crash-safety and detecting a rollback of
// the PAIR store, both of which the max-of-survivors delivers. `present:false`
// (nothing parsed) is turned into `witness-inconsistent` by a provisioned
// caller — an established witness is never read as fresh.
async function readEffective(vfs: Vfs, pairId: string): Promise<ReadEffective> {
  const bytes = await vfs.readFile(witnessLogPath(pairId));
  if (bytes === null) {
    return { present: false };
  }
  const byDirection = new Map<PadDirection, WitnessCounters>();
  for (const line of dec.decode(bytes).split("\n")) {
    if (line === "") {
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn / corrupt / fused record — drop it, keep scanning
    }
    const record = parseRecord(parsed);
    if (record === null) {
      continue; // not a well-formed witness record — drop it
    }
    const prev = byDirection.get(record.direction);
    byDirection.set(
      record.direction,
      prev === undefined
        ? record.counters
        : {
            encryptionNextOffset: Math.max(prev.encryptionNextOffset, record.counters.encryptionNextOffset),
            authenticationNextSequence: Math.max(prev.authenticationNextSequence, record.counters.authenticationNextSequence),
            attemptsReserved: Math.max(prev.attemptsReserved, record.counters.attemptsReserved)
          }
    );
  }
  if (byDirection.size === 0) {
    return { present: false };
  }
  return { present: true, byDirection };
}

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

/* ---- the witness contract ------------------------------------------------- */

export type BrowserWitness = {
  readonly kind: BrowserWitnessKind;
  // Provision the witness — the explicit event at gen or a successful import.
  // `initial` seeds each direction (gen: {0,0,0}; import: the imported store's
  // high-waters, so a mid-life import is not spuriously refused witness-
  // regressed). browser-none is a no-op.
  bootstrap(pairId: string, initial?: { "A->B": WitnessCounters; "B->A": WitnessCounters }): Promise<void>;
  // §15.3 PREFLIGHT: a free state gate before anything is consumed. A store
  // below its witness refuses `witness-regressed`; a missing/empty/torn/absent-
  // direction PROVISIONED witness refuses `witness-inconsistent` (fail closed —
  // an established witness never reads as fresh).
  preflight(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessPreflight>;
  // §15.3 ADVANCE: after the durable §12 commit, before the emit. Appends one
  // record. Throws on an I/O failure — the caller has already committed, so the
  // output is withheld.
  advance(pairId: string, direction: PadDirection, counters: WitnessCounters): Promise<void>;
  // §15.3 status: read-only comparison; refuses nothing.
  report(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessState>;
};

// browser-none: no witness. Every touchpoint is a no-op; status reports "n/a".
function browserNoneWitness(): BrowserWitness {
  return {
    kind: "browser-none",
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

function inconsistent(message: string): { ok: false; reason: "witness-inconsistent"; message: string } {
  return { ok: false, reason: "witness-inconsistent", message: `${message} Nothing was burned.` };
}

// browser-local-witness: the append-only journal at `witness/<pairId>.log`.
function browserLocalWitness(vfs: Vfs): BrowserWitness {
  const ZERO: WitnessCounters = { encryptionNextOffset: 0, authenticationNextSequence: 0, attemptsReserved: 0 };
  return {
    kind: "browser-local-witness",
    async bootstrap(pairId: string, initial?: { "A->B": WitnessCounters; "B->A": WitnessCounters }): Promise<void> {
      // Provision both directions; protection begins here. Append-only: the two
      // records are the journal's first durable content.
      const seed = initial ?? { "A->B": ZERO, "B->A": ZERO };
      await vfs.appendFile(witnessLogPath(pairId), encodeRecord("A->B", seed["A->B"]));
      await vfs.appendFile(witnessLogPath(pairId), encodeRecord("B->A", seed["B->A"]));
    },
    async preflight(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessPreflight> {
      const eff = await readEffective(vfs, pairId);
      if (!eff.present) {
        return inconsistent(
          `this pair is provisioned with a browser-local rollback witness, but its journal ${witnessLogPath(pairId)} ` +
            `is missing, empty, or holds no surviving record. An established witness is never treated as fresh: a ` +
            `vanished witness is a possible rollback, so this fails closed.`
        );
      }
      const w = eff.byDirection.get(direction);
      if (w === undefined) {
        return inconsistent(
          `the browser-local rollback witness ${witnessLogPath(pairId)} carries no record for ${direction}: its ` +
            `provisioning record for this direction is gone, so it fails closed rather than assume a fresh store.`
        );
      }
      if (belowWitness(store, w)) {
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
      return { ok: true, state: alignedWith(store, w) ? "aligned" : "ahead" };
    },
    async advance(pairId: string, direction: PadDirection, counters: WitnessCounters): Promise<void> {
      await vfs.appendFile(witnessLogPath(pairId), encodeRecord(direction, counters));
    },
    async report(pairId: string, direction: PadDirection, store: StoreHighWaters): Promise<WitnessState> {
      const eff = await readEffective(vfs, pairId);
      if (!eff.present) {
        return "inconsistent";
      }
      const w = eff.byDirection.get(direction);
      if (w === undefined) {
        return "inconsistent";
      }
      if (belowWitness(store, w)) {
        return "regressed";
      }
      return alignedWith(store, w) ? "aligned" : "ahead";
    }
  };
}

// Build the witness for a pair's browser-product witness kind (from pair.json).
export function witnessFor(vfs: Vfs, kind: BrowserWitnessKind): BrowserWitness {
  return kind === "browser-local-witness" ? browserLocalWitness(vfs) : browserNoneWitness();
}
