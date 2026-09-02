import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * Layering invariant
 * ----------------------------------------------------------------------------
 * src/core/    pure: may import only from src/core. No node: builtins, no
 *              DOM-only packages, nothing from exhibit or cli.
 * src/exhibit/ the browser build: may import core. May NOT import cli, and
 *              may NOT import node: builtins (they would break the bundle).
 * src/cli/     the operational tool: may import core. May NOT import exhibit.
 * src/spt/     Sealed Pad Transfer's cryptographic core: self-contained. It may
 *              import only from src/spt (plus its one pinned package), and
 *              NOTHING may make src/core depend on it — the arrow points one
 *              way, so the frozen message core never inherits a KEM.
 *
 * Import direction is one-way into core. This test runs under `npm test`,
 * which gates the build in .github/workflows/deploy.yml, so a violation is
 * a red CI check, not a code-review convention.
 * ========================================================================= */

const SRC = resolve(__dirname, "..", "src");
// src/browser is the Browser Edition (the OPFS-worker product). Like exhibit,
// it may import core; it may NOT import cli (node-only) or exhibit, and it
// runs in the browser/worker so it uses no node: builtins.
const LAYERS = ["core", "claims", "cli", "exhibit", "browser", "spt"] as const;
type Layer = (typeof LAYERS)[number];

// Every static or dynamic import specifier in a TS source file:
//   import x from "spec"; import "spec"; export * from "spec"; import("spec")
const SPECIFIER =
  /(?:\bimport\s*(?:[^"'()]*?\bfrom\s*)?|\bexport\s+[^"']*?\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function walk(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files = files.concat(walk(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function layerOf(file: string): Layer | null {
  const rel = relative(SRC, file).split(/[\\/]/)[0];
  return (LAYERS as readonly string[]).includes(rel) ? (rel as Layer) : null;
}

type Import = { file: string; specifier: string; target: Layer | "node" | "package" | "outside" };

function classify(file: string, specifier: string): Import["target"] {
  if (specifier.startsWith("node:")) return "node";
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = resolve(dirname(file), specifier);
    return layerOf(resolved) ?? "outside";
  }
  return "package";
}

function importsOf(layer: Layer): Import[] {
  const dir = join(SRC, layer);
  let files: string[];
  try {
    files = walk(dir);
  } catch {
    return []; // layer directory does not exist (yet)
  }
  const found: Import[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      found.push({ file: relative(SRC, file), specifier: match[1], target: classify(file, specifier(match)) });
    }
  }
  return found;
}

const specifier = (match: RegExpMatchArray): string => match[1];

const describeViolations = (bad: Import[]): string =>
  bad.map((i) => `${i.file} imports "${i.specifier}" (${i.target})`).join("\n");

describe("layering: import direction is one-way into src/core", () => {
  it("the scanner actually sees imports (sanity check on the regex)", () => {
    const core = importsOf("core");
    expect(core.some((i) => i.file === "core/cipher-otp.ts" && i.specifier === "./pad.ts")).toBe(true);
    const exhibit = importsOf("exhibit");
    expect(exhibit.some((i) => i.file === "exhibit/main.ts" && i.target === "core")).toBe(true);
    // Dynamic import() and side-effect imports are caught too.
    expect(exhibit.some((i) => i.specifier === "virtual:pwa-register")).toBe(true);
    expect(exhibit.some((i) => i.specifier === "./style.css")).toBe(true);
  });

  it("src/core imports nothing outside src/core — no node: builtins, no packages", () => {
    const bad = importsOf("core").filter((i) => i.target !== "core");
    expect(describeViolations(bad)).toBe("");
  });

  it("src/exhibit never imports src/cli or node: builtins", () => {
    const bad = importsOf("exhibit").filter((i) => i.target === "cli" || i.target === "node");
    expect(describeViolations(bad)).toBe("");
  });

  it("src/cli never imports src/exhibit", () => {
    const bad = importsOf("cli").filter((i) => i.target === "exhibit");
    expect(describeViolations(bad)).toBe("");
    // And the scanner really sees the cli layer (it did not exist when this test was written).
    expect(importsOf("cli").some((i) => i.target === "core")).toBe(true);
  });

  it("src/browser (Browser Edition) imports only core, spt and claims — never cli, exhibit, or node: builtins", () => {
    const bad = importsOf("browser").filter(
      (i) => i.target === "cli" || i.target === "exhibit" || i.target === "node"
    );
    expect(describeViolations(bad)).toBe("");
  });

  it("src/claims is self-contained — the deployment classifier imports nothing but src/claims", () => {
    // A pure derivation shared by both editions: no core, no spt, no node, no
    // package. It cannot pull a KEM or a Node builtin into either edition.
    const bad = importsOf("claims").filter((i) => i.target !== "claims");
    expect(describeViolations(bad)).toBe("");
  });

  it("src/spt is self-contained — it imports only src/spt and its one package", () => {
    const bad = importsOf("spt").filter((i) => i.target !== "spt" && i.target !== "package");
    expect(describeViolations(bad)).toBe("");
    // And the one package really is the pinned KEM, not something new.
    const packages = new Set(importsOf("spt").filter((i) => i.target === "package").map((i) => i.specifier));
    for (const p of packages) expect(p.startsWith("@noble/post-quantum/")).toBe(true);
  });

  it("nothing makes src/core depend on src/spt", () => {
    // Restating the direction that matters most: the frozen message core must
    // never acquire a KEM by transitive import.
    expect(importsOf("core").filter((i) => i.target === "spt")).toEqual([]);
    expect(importsOf("exhibit").filter((i) => i.target === "spt")).toEqual([]);
    expect(importsOf("cli").filter((i) => i.target === "spt")).toEqual([]);
  });

  it("no layer imports from outside src/", () => {
    const bad = LAYERS.flatMap((layer) => importsOf(layer)).filter((i) => i.target === "outside");
    expect(describeViolations(bad)).toBe("");
  });
});
