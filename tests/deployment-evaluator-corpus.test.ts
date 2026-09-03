/* ============================================================================
 * Cross-language deployment-evaluator conformance corpus — the canonical anchor
 * ----------------------------------------------------------------------------
 * `test-vectors/deployment-evaluator-v3.json` is the machine-readable corpus a
 * SECOND implementation (Kotlin/Android) must reproduce: for every `facts`, the
 * `expected` assessment. These tests prove the committed corpus is exactly what
 * the CANONICAL TypeScript evaluator (`assessDeployment`) produces today — so a
 * drift in the evaluator cannot silently leave a stale corpus behind, and the
 * Android JVM conformance test is checking against the real thing. They also pin
 * that any committed Android copy is byte-identical to the canonical file.
 * ========================================================================= */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assessDeployment, type Assessment, type DeploymentFacts } from "../src/claims/shannon-deployment.ts";

interface Corpus {
  generator: string;
  source: string;
  count: number;
  cases: { name: string; facts: DeploymentFacts; expected: Assessment }[];
}

const canonicalPath = resolve(import.meta.dirname, "../test-vectors/deployment-evaluator-v3.json");
const canonicalText = readFileSync(canonicalPath, "utf8");
const corpus = JSON.parse(canonicalText) as Corpus;

describe("deployment-evaluator conformance corpus", () => {
  it("is non-trivial and self-describing", () => {
    expect(corpus.cases.length).toBe(corpus.count);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);
    expect(corpus.source).toContain("shannon-deployment");
    // The corpus must exercise all three classifications, or it proves nothing.
    const seen = new Set(corpus.cases.map((c) => c.expected));
    expect([...seen].sort()).toEqual(["conditionally-eligible", "insufficient-evidence", "not-eligible"]);
  });

  it("case names are unique", () => {
    const names = corpus.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every case's expected assessment is exactly what the canonical evaluator returns", () => {
    for (const c of corpus.cases) {
      const got = assessDeployment(c.facts).assessment;
      expect(got, `case "${c.name}"`).toBe(c.expected);
    }
  });

  it("an Android software-CSPRNG pad is NOT ELIGIBLE; an external-source Android pad is INSUFFICIENT", () => {
    // The honest Android mandate: never CONDITIONALLY ELIGIBLE (no platform-
    // monotonic authority), a software source is a hard NOT ELIGIBLE, an
    // external-source native pad without the strong ceremony/rollback facts is
    // INSUFFICIENT — derived from facts, never a hard-coded "insecure".
    const byName = new Map(corpus.cases.map((c) => [c.name, c]));
    expect(byName.get("android-software-source")?.expected).toBe("not-eligible");
    expect(byName.get("android-generated-here-external")?.expected).toBe("insufficient-evidence");
    expect(byName.get("android-external-source")?.expected).toBe("insufficient-evidence");
    // No Android tuple may ever be CONDITIONALLY ELIGIBLE.
    for (const c of corpus.cases.filter((x) => x.name.startsWith("android"))) {
      expect(c.expected, `android case "${c.name}"`).not.toBe("conditionally-eligible");
      expect(c.facts.assuranceAuthority, `android case "${c.name}"`).toBe("unavailable");
      expect(c.facts.rollback.kind, `android case "${c.name}"`).not.toBe("platform-monotonic");
    }
  });

  it("any committed Android copy is byte-identical to the canonical corpus", () => {
    // The Android JVM conformance test reads android/vectors/. That copy must be
    // the SAME bytes as the canonical test-vectors/ file (one source of truth).
    const androidCopy = resolve(import.meta.dirname, "../android/vectors/deployment-evaluator-v3.json");
    if (!existsSync(androidCopy)) return; // android/ not yet merged onto this branch
    expect(readFileSync(androidCopy, "utf8")).toBe(canonicalText);
  });
});
