/* ============================================================================
 * truepad2 ceremony-premise withdrawal — the irreversible downgrade authority
 * ----------------------------------------------------------------------------
 * `provenance.json` is a replaceable sibling file: restoring an older, stronger
 * copy of it would otherwise resurrect a stronger classification. That is the
 * §5 defect. This file closes it.
 *
 * A withdrawal is a SUPPORTED, one-way downgrade: `truepad2 ceremony withdraw`
 * records that an operator has withdrawn a ceremony premise. It is written to a
 * SEPARATE durable authority, `withdrawal.json`, pair-bound by the public
 * `pairId`. The deployment evaluator consults this authority INDEPENDENTLY of
 * `provenance.json` and, when it names this pair, forces the ceremony-premise
 * fact to `withdrawn` — NOT ELIGIBLE — no matter what `provenance.json` says.
 *
 * So the invariant holds: once a withdrawal is durable, replacing `provenance.
 * json` with a pre-downgrade accepted copy cannot raise the classification,
 * because the withdrawal is a different file this reader checks first. (A whole-
 * directory restore that also deletes the withdrawal is the general restore
 * attack, caught by the live rollback witness — a restored store reads regressed.)
 *
 * FAIL CLOSED and MONOTONIC. The reader is strict — any malformation, wrong
 * version, wrong shape, or wrong/absent pairId returns null (no withdrawal for
 * THIS pair). Written with head.json's durability discipline (writeFileDurably),
 * so a crash leaves the old withdrawal or none, never a torn one.
 * ========================================================================= */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurably } from "./store2.ts";

export const WITHDRAWAL_FILE = "withdrawal.json";
export const WITHDRAWAL_VERSION = 1;

const PAIR_ID_RE = /^[0-9a-f]{32}$/;

export interface WithdrawalRecord {
  withdrawalVersion: 1;
  pairId: string;
  withdrawnAt: string;
  reason: string;
}

const EXPECTED_KEYS = ["pairId", "reason", "withdrawalVersion", "withdrawnAt"] as const;

/** Write (or overwrite — a withdrawal is one-way and re-recording it is a no-op
 *  change) the withdrawal record, durably. */
export function writeWithdrawal(pairDir: string, record: WithdrawalRecord): void {
  writeFileDurably(pairDir, WITHDRAWAL_FILE, `${JSON.stringify(record)}\n`);
}

/** Read and strictly validate the withdrawal record. Returns null on ANY problem
 *  — absent, unparsable, wrong key set, wrong version, wrong type, or a pairId
 *  that is not the public-identity shape. Null means "no withdrawal recorded". */
export function readWithdrawal(pairDir: string): WithdrawalRecord | null {
  const path = join(pairDir, WITHDRAWAL_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((k, i) => keys[i] === k)) return null;
  if (o.withdrawalVersion !== WITHDRAWAL_VERSION) return null;
  if (typeof o.pairId !== "string" || !PAIR_ID_RE.test(o.pairId)) return null;
  if (typeof o.withdrawnAt !== "string") return null;
  if (typeof o.reason !== "string") return null;
  return o as unknown as WithdrawalRecord;
}

/** True iff a valid withdrawal record for THIS exact pair is durable. The
 *  evaluator uses this to force `ceremonyPremises = withdrawn` independently of
 *  `provenance.json`. A withdrawal recorded for a different pair (or malformed)
 *  does not apply. */
export function isWithdrawn(pairDir: string, pairId: string): boolean {
  const record = readWithdrawal(pairDir);
  return record !== null && record.pairId === pairId;
}

/** Build a withdrawal record bound to `pairId`. */
export function withdrawalRecord(pairId: string, withdrawnAt: string, reason: string): WithdrawalRecord {
  return { withdrawalVersion: WITHDRAWAL_VERSION, pairId, withdrawnAt, reason };
}
