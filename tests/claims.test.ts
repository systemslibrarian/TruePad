import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * Propagation guard (Lane 4). The claims this revision retracted must not
 * creep back into any restatement, and the disclosures it added must stay.
 * Scoped to the files the repo controls; the GitHub About blurb is repo
 * metadata and is checked by hand (see the Lane 4 PR).
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|html|md|yml)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [
  join(ROOT, "README.md"),
  join(ROOT, "index.html"),
  join(ROOT, "vite.config.ts"),
  join(ROOT, "playwright.config.ts"),
  join(ROOT, ".github", "workflows", "deploy.yml"),
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "bin")),
  ...walk(join(ROOT, "e2e"))
];

// Phrases retracted by Lanes 1–4. A match anywhere is a regression.
const RETRACTED: [RegExp, string][] = [
  [/information[- ]theoretically secure/i, "F1: getRandomValues is a DRBG; the pad is bounded by its state entropy"],
  [/reuse is impossible,? (?:not|rather than) merely forbidden/i, "F2: only true within one process; say so"],
  [/no api can return a burned value\s*[—-]/i, "F2: qualify with 'within one process' / 'on this instance'"],
  [/decrypt messages in the order they were sent/i, "F3: the envelope carries its offset; the receiver seeks"],
  [/the e2e suite both assert/i, "F5: the old comment described a suite that did not exist"]
];

describe("retracted claims do not come back", () => {
  for (const [pattern, why] of RETRACTED) {
    it(`no file matches ${pattern} — ${why}`, () => {
      const hits = FILES.filter((file) => file !== __filename && pattern.test(readFileSync(file, "utf8")));
      expect(hits.map((h) => h.replace(ROOT + "/", ""))).toEqual([]);
    });
  }
});

describe("the disclosures stay where a reader will meet them", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const cli = readFileSync(join(ROOT, "src", "cli", "truepad-pad.ts"), "utf8");

  it("README: computational source, unauthenticated envelope, Wegman–Carter seam, backup limitation, no recommendation", () => {
    expect(readme).toMatch(/deterministic random\s+bit generator/);
    expect(readme).toMatch(/not\s+information-theoretically/);
    expect(readme).toContain("The envelope is not authenticated");
    expect(readme).toContain("Wegman–Carter");
    expect(readme).toMatch(/restoring the whole directory from a\s+backup/);
    expect(readme).toMatch(/does not recommend one-time pads for real\s+traffic/);
    expect(readme).toMatch(/still requires out-of-band\s+delivery/);
  });

  it("exhibit: the header bullets and the honest panel carry the same story as the verdict", () => {
    expect(html).toContain("holds computationally");
    expect(html).toContain("The envelope is unauthenticated");
    expect(html).toContain("Wegman–Carter");
    expect(html).toContain("Nothing here persists, on purpose");
  });

  it("CLI banner: not secure messaging, without softening", () => {
    expect(cli).toContain("NOT secure messaging");
    expect(cli).toContain("flip chosen bits (or shift chosen letters) undetectably");
    expect(cli).not.toMatch(/no integrity checking yet/i);
  });
});
