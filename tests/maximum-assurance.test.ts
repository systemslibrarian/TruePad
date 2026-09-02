/* ============================================================================
 * Maximum-assurance invariants that span the editions
 * ----------------------------------------------------------------------------
 * The properties no single unit test owns:
 *   §38 ONE evaluator — every edition assembles facts and calls assessDeployment;
 *       no other module decides a classification.
 *   §26 gen ≠ ceremony — a plain-gen store never records or reads as a ceremony
 *       store, and the two reach different assessments.
 *   §40 the CONDITIONALLY ELIGIBLE label never displays without its unproven
 *       physical premises beside it.
 *   §23 no convenience op upgrades assurance — copying/restoring a store, or
 *       reading its status, never raises a plain-gen pad toward the ceremony.
 *   migration — a legacy store with no provenance is UNKNOWN → INSUFFICIENT,
 *       and stays usable.
 * ========================================================================= */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const E = 64;
const N = 4;
const REQUIRED = 2 * (E + 32 * N);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-maxassure-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}
function genStore(at: string): void {
  const s = join(dir, `src-${Math.abs(hash(at))}.bin`);
  writeFileSync(s, new Uint8Array(REQUIRED + 16).fill(0x42));
  expect(run("gen", at, "--source", s, "--encryption-bytes", String(E), "--auth-records", String(N)).code, "gen").toBe(0);
}
// A tiny path-based discriminator so parallel gen calls use distinct source files.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
const provenancePath = (store: string) => join(store, "provenance.json");
const deploymentLine = (store: string): string => {
  const e = run("status", store).stderr;
  const m = e.match(/Deployment assessment \(derived\)\s*\n\s*([A-Z ]+)/);
  return (m?.[1] ?? "").trim();
};

/* ---- §38 ONE evaluator ---------------------------------------------------- */

describe("(§38) exactly one module decides a deployment classification", () => {
  const SRC_FILES = [
    ["src", "cli", "v2", "truepad2.ts"],
    ["src", "browser", "engine", "verbs.ts"],
    ["src", "browser", "ui", "dashboard.ts"],
    ["src", "browser", "engine", "protocol.ts"]
  ];

  it("only the evaluator PRODUCES a verdict value; consumers only compare it for display", () => {
    // Assigning an assessment literal to an `assessment:` field is PRODUCING a
    // verdict. That may happen only inside the single evaluator.
    const produce = /assessment:\s*"(conditionally-eligible|not-eligible|insufficient-evidence)"/;
    for (const file of SRC_FILES) {
      expect(stripComments(read(...file)), `${file.join("/")} must not produce a verdict`).not.toMatch(produce);
    }
    // The evaluator itself does produce them.
    expect(read("src", "claims", "shannon-deployment.ts")).toMatch(produce);
  });

  it("both editions reach the classification through assessDeployment", () => {
    expect(stripComments(read("src", "cli", "v2", "truepad2.ts"))).toMatch(/\bassessDeployment\(/);
    expect(stripComments(read("src", "browser", "engine", "verbs.ts"))).toMatch(/\bassessDeployment\(/);
    // And nothing defines a second evaluator function.
    for (const file of SRC_FILES) {
      expect(stripComments(read(...file)), `${file.join("/")} defines no rival evaluator`).not.toMatch(
        /function\s+assess\w*Deployment/
      );
    }
  });
});

/* ---- §26 gen ≠ ceremony ---------------------------------------------------- */

describe("(§26) a plain-gen store is never a ceremony store", () => {
  it("gen records cli-gen provenance and reads NOT ELIGIBLE; a ceremony store does not", () => {
    const g = join(dir, "g");
    genStore(g);
    const prov = JSON.parse(readFileSync(provenancePath(g), "utf8")) as { creation: string; ceremonyPremises: string };
    expect(prov.creation).toBe("cli-gen");
    expect(prov.ceremonyPremises).toBe("absent");
    expect(deploymentLine(g)).toBe("NOT ELIGIBLE");
    expect(run("status", g).stderr).toMatch(/plain gen/);
  });
});

/* ---- §23 no convenience op upgrades assurance ------------------------------ */

describe("(§23) no ordinary operation raises a plain-gen pad toward the ceremony", () => {
  it("reading status never mutates the recorded provenance", () => {
    const g = join(dir, "g");
    genStore(g);
    const before = readFileSync(provenancePath(g), "utf8");
    run("status", g);
    run("status", g);
    expect(readFileSync(provenancePath(g), "utf8")).toBe(before);
  });

  it("copying/restoring a plain-gen store elsewhere keeps it NOT ELIGIBLE — a clone is not a ceremony", () => {
    const g = join(dir, "g");
    genStore(g);
    const clone = join(dir, "restored");
    cpSync(g, clone, { recursive: true });
    // The clone still carries cli-gen provenance; nothing about relocating it
    // upgrades the creation path.
    expect(deploymentLine(clone)).toBe("NOT ELIGIBLE");
    const prov = JSON.parse(readFileSync(provenancePath(clone), "utf8")) as { creation: string };
    expect(prov.creation).toBe("cli-gen");
  });
});

/* ---- §40 the strongest label never shows alone ---------------------------- */

describe("(§40) CONDITIONALLY ELIGIBLE is emitted only alongside its unproven premises", () => {
  it("the CLI status code prints the unproven-premises list inside the conditionally-eligible branch", () => {
    // Structural guard: the only place the CLI prints CONDITIONALLY-branch content
    // it also iterates UNPROVEN_PREMISES. (The behavioural proof is in
    // shannon-status-cli.test.ts, where a real accepted-ceremony pad shows both.)
    const src = read("src", "cli", "v2", "truepad2.ts");
    const branch = src.slice(src.indexOf('assessment === "conditionally-eligible"'));
    expect(branch).toMatch(/UNPROVEN_PREMISES/);
    expect(branch.indexOf("UNPROVEN_PREMISES")).toBeLessThan(branch.indexOf("} else"));
  });
});

/* ---- migration: legacy store with no provenance --------------------------- */

describe("a legacy store with no provenance is UNKNOWN → INSUFFICIENT, and stays usable", () => {
  it("status reads INSUFFICIENT EVIDENCE, never NOT ELIGIBLE-as-ceremony and never CONDITIONALLY", () => {
    const g = join(dir, "g");
    genStore(g);
    unlinkSync(provenancePath(g)); // simulate a pre-provenance (legacy) store
    expect(deploymentLine(g)).toBe("INSUFFICIENT EVIDENCE");
    expect(run("status", g).stderr).not.toContain("CONDITIONALLY ELIGIBLE");
  });

  it("a legacy store is not backfilled with provenance by status", () => {
    const g = join(dir, "g");
    genStore(g);
    unlinkSync(provenancePath(g));
    run("status", g);
    // Absence is information: status must not invent a provenance file.
    expect(readdirSync(g)).not.toContain("provenance.json");
  });
});

/* ---- §1 pair-bound provenance: transplantation cannot raise assurance ------ */

// Provision an accepted ceremony pair; return its medium-A dir (strong, accepted
// provenance) and the ceremony pairId.
function acceptedCeremony(tag: string): { mediumA: string; pairId: string } {
  const s1 = join(dir, `c1-${tag}.bin`);
  const s2 = join(dir, `c2-${tag}.bin`);
  writeFileSync(s1, new Uint8Array(2 * (8192 + 32 * 4)).fill(0x11));
  writeFileSync(s2, new Uint8Array(2 * (8192 + 32 * 4)).fill(0x22));
  const mA = join(dir, `mA-${tag}`);
  expect(
    run("ceremony", "create", join(dir, `ws-${tag}`), "--medium-a", mA, "--medium-b", join(dir, `mB-${tag}`),
      "--source", s1, "--source", s2, "--record-bytes", "4096", "--encryption-bytes", "8192", "--auth-records", "4",
      "--assert-offline", "--assert-distinct-physics", "--assert-tmpfs-workspace", "--assert-no-persistent-copy").code
  ).toBe(0);
  expect(run("ceremony", "accept", mA, "--as", "A", "--assert-private-handoff", "--assert-no-extra-copy").code).toBe(0);
  const pairId = (JSON.parse(readFileSync(join(mA, "a-to-b", "head.json"), "utf8")) as { pairId: string }).pairId;
  return { mediumA: mA, pairId };
}

describe("(§1) strong provenance cannot be transplanted to raise another pair", () => {
  it("(A) an accepted-ceremony provenance copied beside a plain-gen pair does NOT raise it", () => {
    const { mediumA } = acceptedCeremony("A");
    const b = join(dir, "genB");
    genStore(b);
    // Transplant pair A's accepted provenance onto pair B.
    cpSync(provenancePath(mediumA), provenancePath(b));
    // B's provenance no longer matches B's heads → treated as UNKNOWN.
    expect(deploymentLine(b)).toBe("INSUFFICIENT EVIDENCE");
    expect(run("status", b).stderr).toMatch(/creation path .+ unknown/);
  });

  it("(C) a provenance whose pairId is edited to anything else fails closed to INSUFFICIENT", () => {
    const g = join(dir, "gEdit");
    genStore(g);
    const rec = JSON.parse(readFileSync(provenancePath(g), "utf8")) as { pairId: string };
    rec.pairId = "ffffffffffffffffffffffffffffffff"; // a syntactically valid but wrong pairId
    writeFileSync(provenancePath(g), JSON.stringify(rec));
    expect(deploymentLine(g)).toBe("INSUFFICIENT EVIDENCE");
  });
});

/* ---- Attack A: same-pair semantic rewrite cannot reach GOLD ---------------- */

describe("(Attack A) editing a pair's OWN provenance into a ceremony story cannot reach CONDITIONALLY ELIGIBLE", () => {
  // The full platform-authority closure (a forged pair reads `ordinary` and
  // `ceremony accept` refuses) is proven with a FakeTpm in
  // tests/platform-assurance.test.ts — that path needs a TPM the CLI subprocess
  // cannot fake. Here we pin the CLI-observable invariant: no amount of
  // pair-directory JSON editing produces a maximum-assurance verdict, because
  // gold requires the INDEPENDENT platform ceremony authority, which is
  // `unavailable` for a pair with no platform witness.
  it("a plain-gen pair with its own provenance rewritten to cli-ceremony/accepted never reads gold", () => {
    const g = join(dir, "forge");
    genStore(g);
    const pid = JSON.parse(readFileSync(join(g, "a-to-b", "head.json"), "utf8")).pairId as string;
    writeFileSync(
      provenancePath(g),
      JSON.stringify({
        provenanceVersion: 1,
        pairId: pid,
        creation: "cli-ceremony",
        source: "external-declared",
        delivery: "physical-private-operator-asserted",
        sealedAncestor: false,
        ceremonyPremises: "accepted",
        createdAt: "2026-09-02T00:00:00.000Z"
      })
    );
    const e = run("status", g).stderr;
    expect(e).not.toContain("CONDITIONALLY ELIGIBLE");
    // The independent authority is unavailable (no platform witness), so the
    // forged provenance cannot be promoted to gold.
    expect(e).toMatch(/ceremony assurance .+ unavailable/);
    expect(e).toContain("INSUFFICIENT EVIDENCE");
  });
});

/* ---- §5 irreversible downgrade: stale provenance cannot resurrect assurance - */

describe("(§5) a withdrawal is permanent; stale provenance cannot raise the classification", () => {
  it("(A/B) withdraw, then restore the pre-downgrade accepted provenance — status stays NOT ELIGIBLE", () => {
    const { mediumA } = acceptedCeremony("W");
    const accepted = readFileSync(provenancePath(mediumA), "utf8"); // the strong, accepted copy
    expect(run("ceremony", "withdraw", mediumA, "--as", "A", "--reason", "compromise").code).toBe(0);
    expect(deploymentLine(mediumA)).toBe("NOT ELIGIBLE");
    // The attack: put the old accepted provenance.json back.
    writeFileSync(provenancePath(mediumA), accepted);
    // The withdrawal authority is independent and monotonic — still NOT ELIGIBLE.
    expect(deploymentLine(mediumA)).toBe("NOT ELIGIBLE");
    expect(run("status", mediumA).stderr).toMatch(/withdrew|withdrawn/i);
  });

  it("(C) cloning a stale accepted provenance beside a withdrawn store does not raise it", () => {
    const { mediumA } = acceptedCeremony("C");
    const accepted = readFileSync(provenancePath(mediumA), "utf8");
    run("ceremony", "withdraw", mediumA, "--as", "A", "--reason", "rotate");
    // Even overwriting with a byte-identical accepted record cannot help.
    writeFileSync(provenancePath(mediumA), accepted);
    expect(deploymentLine(mediumA)).toBe("NOT ELIGIBLE");
  });
});
