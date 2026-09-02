/* ============================================================================
 * truepad2 immutable provenance record — the CLI's durable provenance authority
 * ----------------------------------------------------------------------------
 * A strict, versioned `provenance.json` at the pair-dir root, next to
 * head.json/manifest.json but OUTSIDE the frozen Store Format v2 store: the
 * head-loader validates only head.json's own keys, so a sibling file never
 * trips its unknown-key rule and Format v2 stays byte-frozen.
 *
 * It records FACTS about how a pair was created and how it will be delivered —
 * never a self-certifying verdict. There is no `shannonEligible`, `itCapable`,
 * `trueRandom`, `perfectSecrecy`, or equivalent field, and none may be added;
 * the deployment classification is DERIVED from these facts by the single
 * evaluator (src/claims/shannon-deployment.ts).
 *
 * FAIL CLOSED. The reader is strict: any malformation, unknown enum value,
 * missing/extra field, wrong version, or self-contradiction returns null. The
 * caller treats null as UNKNOWN provenance, which the evaluator maps to
 * INSUFFICIENT EVIDENCE — never a stronger result. Absence is never
 * reconstructed into a strong story from surrounding files.
 *
 * LOSS IS ACCEPTABLE, REUSE IS NOT — and a STRONGER-looking half-written record
 * is not acceptable either: the record is written with head.json's durability
 * discipline (writeFileDurably: temp → fsync → rename → fsync dir), so a crash
 * leaves the old record or none, never a torn one, and never one that looks
 * more assured than what was durably established.
 * ========================================================================= */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurably } from "./store2.ts";
import type { CeremonyPremises, CreationClass, DeliveryClass, SourceClass } from "../../claims/shannon-deployment.ts";

export const PROVENANCE_FILE = "provenance.json";
export const PROVENANCE_VERSION = 1;

/** The durable CLI provenance record. `pairId` BINDS this record to its exact
 *  pair (the public, non-secret pair identity — never a pad-derived value): a
 *  valid record transplanted beside a different pair is rejected because its
 *  `pairId` no longer matches the heads. `createdAt` is operational metadata,
 *  never load-bearing. `sealedAncestor` is always false for a CLI store (the CLI
 *  has no sealed path); the field exists so the schema is uniform across
 *  editions. */
export interface ProvenanceRecord {
  provenanceVersion: 1;
  pairId: string;
  creation: CreationClass;
  source: SourceClass;
  delivery: DeliveryClass;
  sealedAncestor: boolean;
  ceremonyPremises: CeremonyPremises;
  createdAt: string;
}

/** The public pair identity shape: 32 lowercase hex, identical to `head.pairId`.
 *  A record whose `pairId` is not this shape is malformed and fails closed. */
const PAIR_ID_RE = /^[0-9a-f]{32}$/;

// The exact values the CLI ever writes and accepts. A browser-only value
// (e.g. "browser-generated") is not accepted here — a CLI store never carries
// one, and a record claiming one is treated as malformed (fail closed).
const CLI_CREATIONS = new Set<CreationClass>(["cli-gen", "cli-ceremony"]);
const CLI_SOURCES = new Set<SourceClass>(["external-declared"]);
const CLI_DELIVERIES = new Set<DeliveryClass>(["local-only", "physical-private-operator-asserted"]);
const CLI_PREMISES = new Set<CeremonyPremises>(["absent", "accepted", "withdrawn"]);

const EXPECTED_KEYS = [
  "ceremonyPremises",
  "createdAt",
  "creation",
  "delivery",
  "pairId",
  "provenanceVersion",
  "sealedAncestor",
  "source"
] as const;

/** Write (or overwrite for a legitimate one-way transition) the provenance
 *  record, durably. */
export function writeProvenance(pairDir: string, record: ProvenanceRecord): void {
  writeFileDurably(pairDir, PROVENANCE_FILE, `${JSON.stringify(record)}\n`);
}

/**
 * Read and strictly validate the provenance record. Returns null on ANY
 * problem — absent, unparsable, wrong key set, wrong version, unknown enum,
 * wrong type, or a self-contradiction. Null means UNKNOWN provenance to the
 * caller; it is never promoted.
 */
export function readProvenance(pairDir: string): ProvenanceRecord | null {
  const path = join(pairDir, PROVENANCE_FILE);
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
  if (o.provenanceVersion !== PROVENANCE_VERSION) return null;
  if (typeof o.pairId !== "string" || !PAIR_ID_RE.test(o.pairId)) return null;
  if (!CLI_CREATIONS.has(o.creation as CreationClass)) return null;
  if (!CLI_SOURCES.has(o.source as SourceClass)) return null;
  if (!CLI_DELIVERIES.has(o.delivery as DeliveryClass)) return null;
  if (o.sealedAncestor !== false && o.sealedAncestor !== true) return null;
  if (!CLI_PREMISES.has(o.ceremonyPremises as CeremonyPremises)) return null;
  if (typeof o.createdAt !== "string") return null;

  const rec = o as unknown as ProvenanceRecord;
  // Self-contradiction checks — a record that disagrees with itself is not a
  // safe basis for any classification (§47). Fail closed.
  if (rec.creation === "cli-gen" && rec.ceremonyPremises !== "absent") return null;
  if (rec.creation === "cli-ceremony" && rec.ceremonyPremises === "absent") return null;
  if (rec.delivery === "physical-private-operator-asserted") {
    if (rec.creation !== "cli-ceremony" || rec.ceremonyPremises !== "accepted") return null;
  }
  if (rec.sealedAncestor !== false) return null; // a CLI store is never sealed
  return rec;
}

/** True iff this record is bound to the given pair. The caller cross-checks the
 *  record's `pairId` against the loaded heads' `pairId`; a mismatch means the
 *  record was written for a DIFFERENT pair (or transplanted) and must not be
 *  used to derive assurance. */
export function provenanceBoundTo(record: ProvenanceRecord, pairId: string): boolean {
  return record.pairId === pairId;
}

/** The provenance a plain `truepad2 gen` store records: external sources, no
 *  ceremony, not yet distributed. Bound to `pairId`. */
export function genProvenance(pairId: string, createdAt: string): ProvenanceRecord {
  return {
    provenanceVersion: PROVENANCE_VERSION,
    pairId,
    creation: "cli-gen",
    source: "external-declared",
    delivery: "local-only",
    sealedAncestor: false,
    ceremonyPremises: "absent",
    createdAt
  };
}

/** The provenance a `truepad2 ceremony create` store records: the physical
 *  ceremony path, premises accepted, delivery not yet accepted (that is the
 *  one-way `ceremony accept` step). Bound to `pairId`. */
export function ceremonyProvenance(pairId: string, createdAt: string): ProvenanceRecord {
  return {
    provenanceVersion: PROVENANCE_VERSION,
    pairId,
    creation: "cli-ceremony",
    source: "external-declared",
    delivery: "local-only",
    sealedAncestor: false,
    ceremonyPremises: "accepted",
    createdAt
  };
}
