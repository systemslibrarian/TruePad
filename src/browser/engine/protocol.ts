/* ============================================================================
 * TruePad Browser Edition — the worker RPC contract
 * ----------------------------------------------------------------------------
 * The engine (crypto + OPFS store state machine) runs in a dedicated Web
 * Worker; the UI thread talks to it only through the messages below. This is
 * the security boundary: pad material, Wegman–Carter keys/masks, the secret
 * body, and the journal live ONLY in the worker and its OPFS store. What
 * crosses to the UI is exactly what the frozen protocol lets leave the
 * store — wire-public envelopes, non-secret meters/status, and, on a
 * successful open, the plaintext the operator asked to see. Never a pad byte,
 * key, mask, or pad-derived value.
 *
 * Every request carries an `id`; the worker replies with the same `id`. A
 * refusal is a typed, structured result (mirroring the CLI's typed refusals),
 * not an exception string — so the UI can render the exact consequence.
 * ========================================================================= */

import type { PadDirection } from "../../core/pad.ts";

export type RecordPolicy = { kind: "variable" } | { kind: "fixed"; bytes: number };

// Browser rollback-witness kinds (§BROWSER-SECURITY.md §4). This is a
// browser-PRODUCT choice recorded in the browser-only pair.json — NOT a class
// of the frozen store (a browser store's head.json always serialises
// rollback:{witnessClass:"none",config:{}}, byte-identical to the CLI, §2).
// Named honestly: `browser-local-witness` is a second OPFS store under the same
// origin, NOT an independent host failure domain — it does not imply the CLI's
// separate-state-file reach.
export type BrowserWitnessClass = "browser-none" | "browser-local-witness";

// Non-secret per-direction meters — the numbers the dashboard shows. No
// counter here is a secret; all are already visible via the CLI's `status`.
export type DirectionMeters = {
  direction: PadDirection;
  encryption: { capacity: number; nextOffset: number; remainingBytes: number };
  authentication: { capacityRecords: number; nextSequence: number; remainingRecords: number; contestedLive: number };
  record: RecordPolicy;
  verification: { failureCount: number; frozen: boolean };
  maxRemainingSends: number;
  limitedBy: "AUTHENTICATION" | "ENCRYPTION";
  witness: { class: BrowserWitnessClass; state: "n/a" | "fresh" | "aligned" | "ahead" | "regressed" | "unreachable" | "inconsistent" };
};

export type PairSummary = {
  pairId: string;
  label: string; // operator-chosen display name; non-secret metadata only
  createdAt: string;
  destroyed: boolean;
  meters: { "A->B": DirectionMeters; "B->A": DirectionMeters };
};

// The eight-field frozen wire envelope, as JSON text (encodeEnvelope2 output).
export type EnvelopeLine = string;

// A structured refusal, carrying the SAME typed reason the CLI uses (§14.1)
// so the UI shows the exact operational consequence.
export type EngineRefusal = { ok: false; kind: "refused"; reason: string; message: string };
export type EngineError = { ok: false; kind: "error"; message: string };

/* ---- requests (UI → worker) ------------------------------------------------ */

export type EngineRequest =
  | { id: number; op: "list-pairs" }
  | {
      id: number;
      op: "gen";
      label: string;
      // Source material as raw bytes (the UI reads the File objects; the bytes
      // are transferred to the worker and never held in UI reactive state).
      sources: { name: string; declaredOrigin: string; bytes: Uint8Array }[];
      encryptionBytes: number;
      authRecords: number;
      recordBytes?: number; // fixed-record F; omit for variable
      witnessClass: BrowserWitnessClass;
      verifyAttemptLimit?: number;
      maxAuthLookahead?: number;
      freezeThreshold?: number;
    }
  | { id: number; op: "status"; pairId: string }
  | { id: number; op: "burn"; pairId: string; as: "A" | "B"; plaintext: Uint8Array }
  | { id: number; op: "open"; pairId: string; as: "A" | "B"; envelope: EnvelopeLine }
  | { id: number; op: "retire"; pairId: string; direction: PadDirection; throughSequence: number; throughOffset?: number; reason?: string }
  | { id: number; op: "clear-freeze"; pairId: string }
  | { id: number; op: "destroy"; pairId: string; confirm: string; reason?: string }
  // Export a pair's whole store as a courier container for out-of-band delivery
  // to the peer. Secrets DO leave here — deliberately, to the operator's chosen
  // destination — this is the pad courier step, and the UI must present it as
  // such (never an automatic upload). The worker packs the container and returns
  // ONE transferred byte buffer (§4): no pad material is ever base64-stringified
  // or JSON-assembled on the UI thread.
  | { id: number; op: "export-pair"; pairId: string }
  // Import a couriered pad. The UI reads the operator-selected file and TRANSFERS
  // its bytes into the worker (detaching the UI's ArrayBuffer); the worker parses
  // and validates the whole container before any pair becomes active (§6).
  | { id: number; op: "import-pair"; label: string; container: Uint8Array; witnessClass?: BrowserWitnessClass };

/* ---- responses (worker → UI) ----------------------------------------------- */

export type EngineOk =
  | { id: number; ok: true; op: "list-pairs"; pairs: PairSummary[] }
  | { id: number; ok: true; op: "gen"; pair: PairSummary; verdict: string; manifest: ManifestView }
  | { id: number; ok: true; op: "status"; pair: PairSummary }
  | { id: number; ok: true; op: "burn"; envelope: EnvelopeLine; consumed: { encryptionBytes: number; authRecords: 1 }; meters: PairSummary }
  | { id: number; ok: true; op: "open"; plaintext: Uint8Array; skipped: { encryptionBytes: number; authRecords: number }; meters: PairSummary }
  | { id: number; ok: true; op: "retire"; meters: PairSummary }
  | { id: number; ok: true; op: "clear-freeze"; cleared: number; meters: PairSummary }
  | { id: number; ok: true; op: "destroy"; alreadyDestroyed: boolean; limitation: string }
  // The packed courier container, as one transferred byte buffer (§4). This IS
  // pad material; the UI hands it straight to a file the operator names.
  | { id: number; ok: true; op: "export-pair"; container: Uint8Array; fileCount: number }
  | { id: number; ok: true; op: "import-pair"; pair: PairSummary };

export type EngineResponse = EngineOk | ((EngineRefusal | EngineError) & { id: number; op: EngineRequest["op"] });

// Operational metadata only — no value derived from pad bytes (§1.1, N14).
export type ManifestView = {
  pairId: string;
  createdAt: string;
  encryptionBytesPerDirection: number;
  authRecordsPerDirection: number;
  requiredSourceLength: number;
  sources: { name: string; declaredOrigin: string; lengthBytes: number; unusedBytes: number }[];
  verdict: string;
};
