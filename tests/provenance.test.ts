/* ============================================================================
 * CLI immutable provenance record — strict, fail-closed, self-consistent,
 * and PAIR-BOUND (§1)
 * ----------------------------------------------------------------------------
 * `provenance.json` records FACTS about how a pair was created and delivered,
 * bound to the exact pair by the public `pairId`. It is the CLI's durable
 * provenance authority, read by `status` and `ceremony accept` and mapped to a
 * deployment classification by the single evaluator.
 *
 * These tests pin the reader's strictness (§47 hostile input): ANY malformation
 * — unparsable, wrong key set, wrong version, unknown enum, wrong type, a bad
 * pairId, or a record that contradicts itself — returns null, which the caller
 * treats as UNKNOWN provenance (never a stronger story). They pin the round-trip
 * and the two constructors (gen vs ceremony), that a CLI record is never sealed,
 * and that `provenanceBoundTo` binds a record to its exact pair.
 * ========================================================================= */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ceremonyProvenance,
  genProvenance,
  PROVENANCE_FILE,
  provenanceBoundTo,
  type ProvenanceRecord,
  readProvenance,
  writeProvenance
} from "../src/cli/v2/provenance";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-provenance-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CREATED = "2026-09-02T00:00:00.000Z";
const PAIR = "0123456789abcdef0123456789abcdef";
const OTHER_PAIR = "fedcba9876543210fedcba9876543210";
// Write raw bytes as the provenance file, bypassing writeProvenance's schema.
const writeRaw = (text: string): void => writeFileSync(join(dir, PROVENANCE_FILE), text);

describe("the two constructors record honest, distinct, pair-bound facts (§26/§1)", () => {
  it("gen provenance is plain-gen, external source, local-only, premises absent, not sealed, bound to the pair", () => {
    expect(genProvenance(PAIR, CREATED)).toEqual({
      provenanceVersion: 1,
      pairId: PAIR,
      creation: "cli-gen",
      source: "external-declared",
      delivery: "local-only",
      sealedAncestor: false,
      ceremonyPremises: "absent",
      createdAt: CREATED
    });
  });

  it("ceremony provenance is the physical ceremony, premises accepted — distinct from gen", () => {
    const c = ceremonyProvenance(PAIR, CREATED);
    expect(c.creation).toBe("cli-ceremony");
    expect(c.ceremonyPremises).toBe("accepted");
    expect(c.delivery).toBe("local-only"); // acceptance is a separate, later step
    expect(c.pairId).toBe(PAIR);
    expect(c).not.toEqual(genProvenance(PAIR, CREATED)); // gen never masquerades as ceremony
  });
});

describe("pair binding (§1)", () => {
  it("provenanceBoundTo is true only for the exact pairId", () => {
    const rec = ceremonyProvenance(PAIR, CREATED);
    expect(provenanceBoundTo(rec, PAIR)).toBe(true);
    expect(provenanceBoundTo(rec, OTHER_PAIR)).toBe(false);
  });

  it("a record whose pairId is not the public-identity shape fails to read", () => {
    writeRaw(JSON.stringify({ ...ceremonyProvenance(PAIR, CREATED), pairId: "not-hex" }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...ceremonyProvenance(PAIR, CREATED), pairId: PAIR.toUpperCase() }));
    expect(readProvenance(dir)).toBeNull(); // uppercase is not the lowercase-hex identity shape
  });
});

describe("round-trip through the durable writer", () => {
  it("writes and reads back a gen record byte-faithfully", () => {
    writeProvenance(dir, genProvenance(PAIR, CREATED));
    expect(readProvenance(dir)).toEqual(genProvenance(PAIR, CREATED));
  });

  it("writes and reads back a ceremony record", () => {
    writeProvenance(dir, ceremonyProvenance(PAIR, CREATED));
    expect(readProvenance(dir)).toEqual(ceremonyProvenance(PAIR, CREATED));
  });

  it("accepts the one legitimate one-way delivery upgrade on a ceremony record", () => {
    const accepted: ProvenanceRecord = { ...ceremonyProvenance(PAIR, CREATED), delivery: "physical-private-operator-asserted" };
    writeProvenance(dir, accepted);
    expect(readProvenance(dir)?.delivery).toBe("physical-private-operator-asserted");
  });
});

describe("absence is UNKNOWN, never reconstructed (§45)", () => {
  it("a missing file reads as null", () => {
    expect(readProvenance(dir)).toBeNull();
  });

  it("a truncated / torn file reads as null, not a partial record", () => {
    writeRaw('{"provenanceVersion":1,"creation":"cli-cere');
    expect(readProvenance(dir)).toBeNull();
  });
});

describe("the reader is strict and fails closed (§47 hostile input)", () => {
  const base = ceremonyProvenance(PAIR, CREATED);

  it("rejects a non-object top level", () => {
    for (const raw of ["null", "42", '"x"', "[]", "true"]) {
      writeRaw(raw);
      expect(readProvenance(dir), raw).toBeNull();
    }
  });

  it("rejects an extra key", () => {
    writeRaw(JSON.stringify({ ...base, shannonEligible: true }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a missing key", () => {
    const { sealedAncestor, ...missing } = base;
    void sealedAncestor;
    writeRaw(JSON.stringify(missing));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a missing pairId", () => {
    const { pairId, ...missing } = base;
    void pairId;
    writeRaw(JSON.stringify(missing));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a wrong version", () => {
    writeRaw(JSON.stringify({ ...base, provenanceVersion: 2 }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects an unknown creation / source / delivery / premise enum", () => {
    writeRaw(JSON.stringify({ ...base, creation: "browser-generated" }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, source: "software-csprng" }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, delivery: "sealed-tps2" }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, ceremonyPremises: "banana" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a wrong type on a field", () => {
    writeRaw(JSON.stringify({ ...base, sealedAncestor: "false" }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, createdAt: 123 }));
    expect(readProvenance(dir)).toBeNull();
    writeRaw(JSON.stringify({ ...base, pairId: 123 }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a self-contradiction: cli-gen with non-absent premises", () => {
    writeRaw(JSON.stringify({ ...genProvenance(PAIR, CREATED), ceremonyPremises: "accepted" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a self-contradiction: cli-ceremony with absent premises", () => {
    writeRaw(JSON.stringify({ ...base, ceremonyPremises: "absent" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a forged private-handoff on a plain-gen record — no laundering (§7)", () => {
    writeRaw(JSON.stringify({ ...genProvenance(PAIR, CREATED), delivery: "physical-private-operator-asserted" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a sealed CLI record — a CLI store is never sealed (§14)", () => {
    writeRaw(JSON.stringify({ ...base, sealedAncestor: true }));
    expect(readProvenance(dir)).toBeNull();
  });
});
