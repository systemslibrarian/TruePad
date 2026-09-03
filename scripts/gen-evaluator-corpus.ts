/* Generate the cross-language deployment-evaluator conformance corpus from the
 * CANONICAL TypeScript evaluator (src/claims/shannon-deployment.ts). Every entry
 * is { name, facts, expected } where `expected` is the assessment the canonical
 * evaluator returns. A second implementation (Kotlin/Android) MUST reproduce
 * `expected` for each `facts`. Run: node scripts/gen-evaluator-corpus.ts
 */
import { writeFileSync } from "node:fs";
import { assessDeployment, type DeploymentFacts } from "../src/claims/shannon-deployment.ts";

// The one facts tuple the evaluator ranks CONDITIONALLY ELIGIBLE.
const STRONGEST: DeploymentFacts = {
  creation: "cli-ceremony",
  source: "external-declared",
  delivery: "physical-private-operator-asserted",
  sealedAncestor: false,
  ceremonyPremises: "accepted",
  storage: "native",
  rollback: { kind: "platform-monotonic", health: "healthy" },
  assuranceAuthority: "handoff-accepted"
};

const cases: { name: string; facts: DeploymentFacts }[] = [];
const add = (name: string, patch: Partial<DeploymentFacts>) => cases.push({ name, facts: { ...STRONGEST, ...patch } });

add("strongest", {});
// single-axis sweeps
for (const v of ["browser-generated", "cli-gen", "cli-ceremony", "imported", "unknown"] as const) add(`creation:${v}`, { creation: v });
for (const v of ["software-csprng", "external-declared", "unknown"] as const) add(`source:${v}`, { source: v });
for (const v of ["local-only", "physical-private-operator-asserted", "sealed-tps2", "raw-import-unknown", "unknown"] as const) add(`delivery:${v}`, { delivery: v });
for (const v of [true, false, "unknown"] as const) add(`sealedAncestor:${v}`, { sealedAncestor: v });
for (const v of ["accepted", "absent", "withdrawn", "unknown"] as const) add(`premises:${v}`, { ceremonyPremises: v });
for (const v of ["native", "browser-opfs", "unknown"] as const) add(`storage:${v}`, { storage: v });
for (const v of ["unavailable", "untrusted-authority", "ordinary", "ceremony-created", "handoff-accepted", "withdrawn", "inconsistent"] as const) add(`assurance:${v}`, { assuranceAuthority: v });
// rollback authority sweep
add("rollback:none", { rollback: { kind: "none" } });
add("rollback:unknown", { rollback: { kind: "unknown" } });
add("rollback:browser-local", { rollback: { kind: "browser-local" } });
for (const h of ["healthy", "unreachable", "regressed", "inconsistent", "unsupported"] as const) {
  add(`rollback:ssf:${h}`, { rollback: { kind: "separate-state-file", health: h } });
  add(`rollback:platform:${h}`, { rollback: { kind: "platform-monotonic", health: h } });
}
// scenario combos (realistic pads)
add("browser-generated-pad", { creation: "browser-generated", source: "software-csprng", delivery: "local-only", storage: "browser-opfs", rollback: { kind: "browser-local" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" });
add("plain-gen-native", { creation: "cli-gen", source: "external-declared", delivery: "local-only", storage: "native", rollback: { kind: "none" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" });
add("sealed-import", { creation: "imported", source: "unknown", delivery: "sealed-tps2", sealedAncestor: true, storage: "native", rollback: { kind: "none" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" });
// The exact fact tuples Android's Deployment.kt assembles (honest mapping):
// Android never claims cli-gen/cli-ceremony/browser-generated; its on-device
// witness is a separate-state-file in ONE backup domain (never platform-
// monotonic); it has no pinned platform ceremony authority (unavailable).
add("android-generated-here-external", { creation: "unknown", source: "external-declared", delivery: "local-only", sealedAncestor: false, storage: "native", rollback: { kind: "separate-state-file", health: "healthy" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" }); // -> INSUFFICIENT (the primary honest Android path)
add("android-generated-here-no-witness", { creation: "unknown", source: "external-declared", delivery: "local-only", sealedAncestor: false, storage: "native", rollback: { kind: "none" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" }); // -> INSUFFICIENT (WitnessKind.NONE)
add("android-external-source", { creation: "imported", source: "external-declared", delivery: "raw-import-unknown", sealedAncestor: false, storage: "native", rollback: { kind: "separate-state-file", health: "healthy" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" }); // -> INSUFFICIENT (IMPORTED)
add("android-software-source", { creation: "unknown", source: "software-csprng", delivery: "local-only", sealedAncestor: false, storage: "native", rollback: { kind: "separate-state-file", health: "healthy" }, ceremonyPremises: "absent", assuranceAuthority: "unavailable" }); // -> NOT ELIGIBLE (source)
add("android-imported-unknown-source", { creation: "imported", source: "unknown", delivery: "raw-import-unknown", sealedAncestor: "unknown", storage: "native", rollback: { kind: "separate-state-file", health: "unreachable" }, ceremonyPremises: "unknown", assuranceAuthority: "unavailable" }); // -> INSUFFICIENT
add("accepted-ceremony-ssf", { rollback: { kind: "separate-state-file", health: "healthy" } });
add("accepted-ceremony-platform-unpinned", { assuranceAuthority: "unavailable" });
add("accepted-ceremony-untrusted-authority", { assuranceAuthority: "untrusted-authority" });
add("withdrawn-platform", { assuranceAuthority: "withdrawn" });

const corpus = cases.map(({ name, facts }) => ({ name, facts, expected: assessDeployment(facts).assessment }));
const out = {
  generator: "scripts/gen-evaluator-corpus.ts",
  source: "src/claims/shannon-deployment.ts (assessDeployment)",
  note: "Canonical TypeScript evaluator output. A second implementation MUST reproduce `expected` for each `facts`.",
  count: corpus.length,
  cases: corpus
};
writeFileSync("test-vectors/deployment-evaluator-v3.json", `${JSON.stringify(out, null, 2)}\n`);
const tally = corpus.reduce<Record<string, number>>((m, c) => ((m[c.expected] = (m[c.expected] ?? 0) + 1), m), {});
console.log(`wrote test-vectors/deployment-evaluator-v3.json — ${corpus.length} cases`, tally);
