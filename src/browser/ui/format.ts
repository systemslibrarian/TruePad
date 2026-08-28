/* ============================================================================
 * TruePad 2 Browser Edition — formatting & consequence vocabulary
 * ----------------------------------------------------------------------------
 * Pure presentation helpers. The heart of this file is CONSEQUENCES: the map
 * from a typed engine-refusal `reason` (the same reasons the CLI uses, §14.1)
 * to the exact operational consequence the operator must see. The engine's own
 * `message` is always shown verbatim as well; this map adds the headline, the
 * severity, and the plain-language "what this means for your material" line so
 * an open never resolves into a bare string.
 * ========================================================================= */

import type { DirectionMeters, PairSummary, BrowserWitnessClass } from "../engine/protocol.ts";
import type { PadDirection } from "../../core/pad.ts";

export type Tone = "danger" | "warn" | "ok" | "info" | "neutral";

const INT = new Intl.NumberFormat("en-US");

export const fmtInt = (n: number): string => INT.format(n);

export function fmtBytes(n: number): string {
  const exact = `${INT.format(n)} byte${n === 1 ? "" : "s"}`;
  if (n < 1024) return exact;
  const units = ["KiB", "MiB", "GiB"];
  let value = n;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${exact} (${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]})`;
}

export function abbreviatePairId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export const PARTY_NAME: Record<"A" | "B", string> = { A: "Alice", B: "Bob" };

export function directionLabel(direction: PadDirection): string {
  return direction === "A->B" ? "Alice → Bob" : "Bob → Alice";
}

export function localRoleLabel(role: "A" | "B"): string {
  return `${PARTY_NAME[role]} (${role})`;
}

export function witnessClassLabel(cls: BrowserWitnessClass): string {
  return cls === "browser-none" ? "None" : "Browser-local witness";
}

export function witnessStateView(state: DirectionMeters["witness"]["state"]): { label: string; tone: Tone } {
  switch (state) {
    case "n/a":
      return { label: "No witness", tone: "neutral" };
    case "fresh":
      return { label: "Fresh", tone: "ok" };
    case "aligned":
      return { label: "Aligned", tone: "ok" };
    case "ahead":
      return { label: "Ahead of store", tone: "warn" };
    case "regressed":
      return { label: "Store regressed", tone: "danger" };
    case "unreachable":
      return { label: "Unreachable", tone: "danger" };
    case "inconsistent":
      return { label: "Inconsistent", tone: "danger" };
  }
}

export type MeterView = {
  name: string;
  valueText: string;
  footText: string;
  fraction: number; // remaining / capacity, clamped 0..1
  level: "ok" | "low" | "exhausted";
};

function level(remaining: number, capacity: number): MeterView["level"] {
  if (remaining <= 0) return "exhausted";
  if (capacity > 0 && remaining / capacity < 0.15) return "low";
  return "ok";
}

export function encryptionMeter(m: DirectionMeters): MeterView {
  const { capacity, remainingBytes } = m.encryption;
  return {
    name: "Encryption budget",
    valueText: `${fmtInt(remainingBytes)} / ${fmtInt(capacity)} B`,
    footText: `${fmtInt(remainingBytes)} bytes remain of ${fmtInt(capacity)}`,
    fraction: capacity > 0 ? Math.max(0, Math.min(1, remainingBytes / capacity)) : 0,
    level: level(remainingBytes, capacity)
  };
}

export function authMeter(m: DirectionMeters): MeterView {
  const { capacityRecords, remainingRecords, contestedLive } = m.authentication;
  const contested = contestedLive > 0 ? ` · ${fmtInt(contestedLive)} contested` : "";
  return {
    name: "Authentication records",
    valueText: `${fmtInt(remainingRecords)} / ${fmtInt(capacityRecords)}`,
    footText: `${fmtInt(remainingRecords)} records remain of ${fmtInt(capacityRecords)}${contested}`,
    fraction: capacityRecords > 0 ? Math.max(0, Math.min(1, remainingRecords / capacityRecords)) : 0,
    level: level(remainingRecords, capacityRecords)
  };
}

export type StatusView = { label: string; tone: Tone };

export function directionStatus(m: DirectionMeters): StatusView {
  if (m.verification.frozen) return { label: "Frozen", tone: "danger" };
  if (m.maxRemainingSends <= 0) return { label: "Exhausted", tone: "warn" };
  return { label: "Ready", tone: "ok" };
}

export function pairStatus(pair: PairSummary): StatusView {
  if (pair.destroyed) return { label: "Destroyed", tone: "danger" };
  const ab = directionStatus(pair.meters["A->B"]);
  const ba = directionStatus(pair.meters["B->A"]);
  if (ab.tone === "danger" || ba.tone === "danger") return { label: "Frozen", tone: "danger" };
  if (ab.tone === "warn" && ba.tone === "warn") return { label: "Exhausted", tone: "warn" };
  return { label: "Ready", tone: "ok" };
}

export function recordModeLabel(record: DirectionMeters["record"]): string {
  return record.kind === "fixed" ? `Fixed · ${fmtInt(record.bytes)} B per record` : "Variable length";
}

/* ---- the consequence vocabulary ---------------------------------------- */

export type Consequence = { title: string; tone: Tone; consequence: string };

const CONSEQUENCES: Record<string, Consequence> = {
  // structural / envelope grammar — refused for free, before any state moves
  "malformed-envelope": {
    title: "Malformed envelope",
    tone: "danger",
    consequence: "The text is not a well-formed v2 envelope. It was refused by the grammar; nothing was read and no material moved."
  },
  "sequence-malformed": {
    title: "Malformed sequence",
    tone: "danger",
    consequence: "The envelope's record fields did not parse. Refused before verification; nothing was consumed."
  },
  "half-pair": {
    title: "Incomplete store",
    tone: "danger",
    consequence: "Only one direction of this pair's store is present. The store cannot be operated until both halves are whole."
  },

  // routing — this envelope is not for this store
  "wrong-pair": {
    title: "Wrong pair",
    tone: "danger",
    consequence: "This envelope was sealed for a different pair id. Nothing was verified, released, or consumed."
  },
  "wrong-direction": {
    title: "Wrong direction",
    tone: "danger",
    consequence: "This envelope carries the opposite direction's traffic. Each direction opens only its own; nothing moved."
  },

  // one-time-state — the reuse guard, refused before verification
  "sequence-retired": {
    title: "Sequence already retired",
    tone: "warn",
    consequence: "A replay, or a record that arrived after a later one already retired it. Refused before verification — no plaintext, nothing consumed. Loss is acceptable; reuse is not."
  },
  "sequence-out-of-window": {
    title: "Outside the acceptance window",
    tone: "warn",
    consequence: "The record's sequence sits beyond the look-ahead window. Refused for free; nothing was verified or consumed."
  },
  "offset-retired": {
    title: "Offset already retired",
    tone: "warn",
    consequence: "The encryption offset this envelope names is at or below the high-water mark. Refused before anything is consumed."
  },
  "sequence-contested": {
    title: "Record permanently contested",
    tone: "danger",
    consequence: "This sequence exhausted its verification-attempt budget. It will never open: the earlier failed guesses spent this record's material, and it is gone, unread."
  },

  // authentication — the tag decides, and failing costs a durable reservation
  "auth-failed": {
    title: "Authentication failed",
    tone: "danger",
    consequence: "The tag did not verify: the envelope was altered in transit, or does not belong here. No plaintext is released. The failure is recorded and cost one durable attempt against this record; enough failures freeze the direction."
  },
  "record-size-mismatch": {
    title: "Record size mismatch",
    tone: "danger",
    consequence: "This pair uses fixed-size records and the ciphertext is not exactly the fixed length. Refused; nothing was released or consumed."
  },
  "oversize-ciphertext": {
    title: "Ciphertext too large",
    tone: "danger",
    consequence: "The ciphertext exceeds this pair's maximum. Refused before any material is touched."
  },

  // budgets spent
  "encryption-exhausted": {
    title: "Encryption budget spent",
    tone: "warn",
    consequence: "This direction has no encryption material left. A one-time pad cannot borrow, wrap, or reuse — generate a new pair to keep sending."
  },
  "auth-exhausted": {
    title: "Authentication budget spent",
    tone: "warn",
    consequence: "This direction has no authentication records left. Every record is used exactly once — generate a new pair to keep sending."
  },
  "source-too-short": {
    title: "Source material too short",
    tone: "danger",
    consequence: "The selected sources do not supply the exact L = 2·(E + 32·N) bytes this pair requires. Nothing was generated."
  },

  // freeze state
  frozen: {
    title: "Direction frozen",
    tone: "danger",
    consequence: "Repeated authentication failures froze this direction. No open proceeds until the freeze is cleared — an explicit, recorded operator decision."
  },

  // rollback witness
  "witness-regressed": {
    title: "Store regressed below its witness",
    tone: "danger",
    consequence: "The rollback witness is ahead of the store — the signature of a restored backup or cleared-then-partly-restored storage. Refused before anything is consumed, so material the witness says was already spent cannot be reused."
  },
  "witness-inconsistent": {
    title: "Witness record inconsistent",
    tone: "danger",
    consequence: "The witness record is malformed (a missing, extra, or negative counter). It fails closed; no material is consumed."
  },
  "witness-unreachable": {
    title: "Witness unreachable",
    tone: "danger",
    consequence: "The configured rollback witness could not be read. It fails closed at burn / open / retire; nothing is consumed until it is reachable again."
  },
  "witness-unsupported": {
    title: "Witness class unsupported",
    tone: "danger",
    consequence: "The requested witness class is not offered by this edition. It is refused, never silently downgraded to a weaker class."
  },

  // store integrity
  "corrupt-head": { title: "Corrupt head", tone: "danger", consequence: "The store head did not validate. Refused; no material was touched." },
  "corrupt-store": { title: "Corrupt store", tone: "danger", consequence: "The store did not validate. Refused; no material was touched." },
  "corrupt-journal": { title: "Corrupt journal", tone: "danger", consequence: "The store journal did not validate. Refused; no material was touched." },
  "corrupt-secret-body": { title: "Corrupt secret body", tone: "danger", consequence: "The secret body did not validate against the head. Refused; no material was touched." },
  "regressed-below-mark": { title: "Regressed below mark", tone: "danger", consequence: "The store's counters fell below a recorded mark. Refused before anything is consumed." },
  "v1-store": { title: "Legacy v1 store", tone: "danger", consequence: "This is a v1 store. The Browser Edition has no v1 path and never downgrades — it is refused, not opened." },
  "no-store": { title: "No store", tone: "danger", consequence: "No store was found for this pair." },

  // destroyed
  "pair-destroyed": {
    title: "Pair destroyed",
    tone: "danger",
    consequence: "This pair has crossed the irreversible destruction boundary. Every operation refuses it before any secret is read. There is no path back to active use."
  },

  // concurrency
  locked: {
    title: "Pair busy",
    tone: "warn",
    consequence: "Another operation holds this pair's single-writer lock. Exactly one mutator runs per pair at a time — try again in a moment."
  },

  // confirmation
  "destroy-unconfirmed": {
    title: "Destruction not confirmed",
    tone: "warn",
    consequence: "The confirmation did not match the pair id. Nothing was destroyed."
  },
  "ceremony-incomplete": {
    title: "Ceremony incomplete",
    tone: "warn",
    consequence: "A required verification step has not been completed for this pair."
  }
};

export function consequenceFor(reason: string): Consequence {
  return (
    CONSEQUENCES[reason] ?? {
      title: reason.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      tone: "danger",
      consequence: "The operation was refused. Nothing was released or consumed."
    }
  );
}
