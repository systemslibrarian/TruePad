/* ============================================================================
 * CLI immutable provenance record — strict, fail-closed, self-consistent
 * ----------------------------------------------------------------------------
 * `provenance.json` records FACTS about how a pair was created and delivered. It
 * is the CLI's durable provenance authority, read by `status` and `ceremony
 * accept` and mapped to a deployment classification by the single evaluator.
 *
 * These tests pin the reader's strictness (§47 hostile input): ANY malformation
 * — unparsable, wrong key set, wrong version, unknown enum, wrong type, or a
 * record that contradicts itself — returns null, which the caller treats as
 * UNKNOWN provenance (never a stronger story). They pin the round-trip and the
 * two constructors (gen vs ceremony), and that a CLI record is never sealed.
 * ========================================================================= */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ceremonyProvenance,
  genProvenance,
  PROVENANCE_FILE,
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
// Write raw bytes as the provenance file, bypassing writeProvenance's schema.
const writeRaw = (text: string): void => writeFileSync(join(dir, PROVENANCE_FILE), text);

describe("the two constructors record honest, distinct facts (§26)", () => {
  it("gen provenance is plain-gen, external source, local-only, premises absent, not sealed", () => {
    expect(genProvenance(CREATED)).toEqual({
      provenanceVersion: 1,
      creation: "cli-gen",
      source: "external-declared",
      delivery: "local-only",
      sealedAncestor: false,
      ceremonyPremises: "absent",
      createdAt: CREATED
    });
  });

  it("ceremony provenance is the physical ceremony, premises accepted — distinct from gen", () => {
    const c = ceremonyProvenance(CREATED);
    expect(c.creation).toBe("cli-ceremony");
    expect(c.ceremonyPremises).toBe("accepted");
    expect(c.delivery).toBe("local-only"); // acceptance is a separate, later step
    expect(c).not.toEqual(genProvenance(CREATED)); // gen never masquerades as ceremony
  });
});

describe("round-trip through the durable writer", () => {
  it("writes and reads back a gen record byte-faithfully", () => {
    writeProvenance(dir, genProvenance(CREATED));
    expect(readProvenance(dir)).toEqual(genProvenance(CREATED));
  });

  it("writes and reads back a ceremony record", () => {
    writeProvenance(dir, ceremonyProvenance(CREATED));
    expect(readProvenance(dir)).toEqual(ceremonyProvenance(CREATED));
  });

  it("accepts the one legitimate one-way delivery upgrade on a ceremony record", () => {
    const accepted: ProvenanceRecord = { ...ceremonyProvenance(CREATED), delivery: "physical-private-operator-asserted" };
    writeProvenance(dir, accepted);
    expect(readProvenance(dir)?.delivery).toBe("physical-private-operator-asserted");
  });
});

describe("absence is UNKNOWN, never reconstructed (§45)", () => {
  it("a missing file reads as null", () => {
    expect(readProvenance(dir)).toBeNull();
  });

  it("a truncated / torn file reads as null, not a partial record", () => {
    // A crash mid-write is prevented by writeFileDurably, but if the on-disk
    // bytes are ever partial they must not parse into a weaker-or-stronger record.
    writeRaw('{"provenanceVersion":1,"creation":"cli-cere');
    expect(readProvenance(dir)).toBeNull();
  });
});

describe("the reader is strict and fails closed (§47 hostile input)", () => {
  const base = ceremonyProvenance(CREATED);

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

  it("rejects a wrong version", () => {
    writeRaw(JSON.stringify({ ...base, provenanceVersion: 2 }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects an unknown creation / source / delivery / premise enum", () => {
    writeRaw(JSON.stringify({ ...base, creation: "browser-generated" })); // a browser-only value
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
  });

  it("rejects a self-contradiction: cli-gen with non-absent premises", () => {
    writeRaw(JSON.stringify({ ...genProvenance(CREATED), ceremonyPremises: "accepted" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a self-contradiction: cli-ceremony with absent premises", () => {
    writeRaw(JSON.stringify({ ...base, ceremonyPremises: "absent" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a forged private-handoff on a plain-gen record — no laundering (§7)", () => {
    // The strongest-delivery value is only self-consistent on an accepted ceremony
    // record. A plain-gen record claiming it is rejected outright.
    writeRaw(JSON.stringify({ ...genProvenance(CREATED), delivery: "physical-private-operator-asserted" }));
    expect(readProvenance(dir)).toBeNull();
  });

  it("rejects a sealed CLI record — a CLI store is never sealed (§14)", () => {
    writeRaw(JSON.stringify({ ...base, sealedAncestor: true }));
    expect(readProvenance(dir)).toBeNull();
  });
});
