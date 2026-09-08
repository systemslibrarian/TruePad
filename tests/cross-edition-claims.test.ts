import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * THE CLAIMS TABLE MUST KEEP UP WITH THE PRODUCTS — AND THE GUARD MUST PIN
 * EVIDENCE, NOT SLOGANS
 * ----------------------------------------------------------------------------
 * `docs/PRODUCT-CLAIMS.md` is the cross-edition ledger. Its first defect was
 * three columns reading "forthcoming" while three editions shipped.
 *
 * The SECOND defect was in this file. An adversarial pass mutated the document
 * and demonstrated, by execution, that the guard stayed green while the ledger
 * said things that were flatly false. Every rule below exists because a specific
 * mutation walked through the old version:
 *
 *   · row 15 rewritten to "✓ guaranteed — this is no longer NOT CLAIMED" passed,
 *     because the check was a SUBSTRING match for "NOT CLAIMED" anywhere in the
 *     cell. A cell that mentions its own verdict in order to renounce it now
 *     fails: the verdict must be the cell's LEADING token.
 *   · row 2 passed both when iOS was promoted to Android's standing and when
 *     Android was demoted to UNVERIFIED, because the check was an unordered bag
 *     of lexemes with no per-edition verdict pinned.
 *   · 22 cells replaced with a bare "✓" passed, including rows where the doc
 *     says the opposite. A bare check is now legal only on a UNIFORM row.
 *   · cells set to U+200B, `&nbsp;` and `<!-- -->` passed `cell.length > 0`,
 *     because `String.trim()` removes none of them.
 *   · every Class VALUE blanked passed, because only the header was checked.
 *   · deleting the legend passed once the matrix heading was renamed, because
 *     `indexOf` returned -1 and `slice(0, -1)` is the whole document.
 *   · IOS-OP / NATIVE-OP deleted from every cell passed, because the check was
 *     `DOC.toContain(name)` and the legend still defined them.
 *   · the 240d7f0 pin survived a cell rewritten to say the pin had been REMOVED,
 *     because the guard only asked whether seven characters occurred somewhere.
 *
 * The rule this file now follows: pin the EVIDENCE and the VERDICT, never the
 * document's own self-description. A phrase that a defect can simply contain is
 * not a guard.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const DOC = readFileSync(resolve(ROOT, "docs/PRODUCT-CLAIMS.md"), "utf8");

/** Columns before the per-edition verdicts: #, Claim, Class. */
const EDITION_COLUMNS = 3;
const EDITIONS = ["Browser", "Android", "iOS", "CLI / Native"] as const;

function splitRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** The matrix rows, as arrays of trimmed cells. */
function matrix(): string[][] {
  return DOC.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l)).map(splitRow);
}

function header(): string[] {
  const line = DOC.split("\n").find((l) => /^\|\s*#\s*\|/.test(l));
  expect(line, "the matrix header must exist").toBeDefined();
  return splitRow(line as string);
}

function row(n: number): string[] {
  const r = matrix().find((x) => Number(x[0]) === n);
  expect(r, `row ${n} must exist`).toBeDefined();
  return r as string[];
}

const cellsOf = (n: number): string[] => row(n).slice(EDITION_COLUMNS);

/**
 * What a cell renders as, once the things that LOOK like content but are not
 * have been removed. U+200B/U+FEFF/U+00A0 survive String.trim(); an HTML comment
 * and a bare entity render as nothing at all. All three were used to empty cells
 * while keeping this file green.
 */
function visible(cell: string): string {
  return cell
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, "")
    .replace(/[​-‍﻿ ]/g, "")
    .replace(/[*_`~]/g, "")
    .trim();
}

/**
 * The cell's VERDICT: the leading token, not any token. "NOT CLAIMED" appearing
 * mid-sentence is prose; appearing first is a classification.
 */
function verdict(cell: string): string {
  const v = visible(cell);
  const bold = v.match(/^([A-Z][A-Z]+(?: [A-Z]+)*)\b/);
  if (bold) return bold[1];
  if (v.startsWith("✓")) return "✓";
  return v.slice(0, 24);
}

describe("the table's structure cannot rot", () => {
  it("finds a matrix of the expected size", () => {
    // POSITIVE CONTROL: a guard that silently matches zero rows passes forever.
    expect(matrix().length, "claim rows").toBe(17);
    expect(DOC.length, "bytes of PRODUCT-CLAIMS.md").toBeGreaterThan(10_000);
  });

  it("has one column per shipping edition, and no stale ones", () => {
    const cols = header();
    expect(cols.slice(0, 3)).toEqual(["#", "Claim", "Class"]);
    expect(cols.slice(3), "the four edition columns, in order").toEqual([...EDITIONS]);
    expect(cols.join(" ")).not.toMatch(/\bDesktop\b/);
  });

  it("keeps every row full width, with a real Class VALUE", () => {
    for (const r of matrix()) {
      expect(r.length, `row ${r[0]} must have every column`).toBe(EDITION_COLUMNS + 4);
      // Not just the Class HEADING — the value. Blanking all 17 used to pass.
      expect(visible(r[2]).length, `row ${r[0]} has no classification`).toBeGreaterThan(2);
    }
  });

  it("leaves no cell empty, including cells that only look full", () => {
    for (const r of matrix()) {
      for (let i = EDITION_COLUMNS; i < r.length; i++) {
        const raw = r[i];
        const label = `row ${r[0]}, ${header()[i]}`;
        expect(visible(raw).length, `${label} renders empty`).toBeGreaterThan(0);
        expect(raw.toLowerCase(), `${label} is a placeholder`)
          .not.toMatch(/\b(forthcoming|tbd|todo|xxx|n\/a)\b/);
      }
    }
  });

  it("allows a bare check only where the whole row is uniform", () => {
    // 22 cells were replaced with "✓" and this file stayed green — including
    // row 16, where the document says both phones expose no filesystem identity.
    // A bare check beside a qualified sibling is a hidden platform difference.
    for (const r of matrix()) {
      const cells = r.slice(EDITION_COLUMNS);
      const bare = cells.filter((c) => visible(c) === "✓");
      if (bare.length === 0 || bare.length === cells.length) continue;
      expect.fail(
        `row ${r[0]}: ${bare.length} of ${cells.length} cells are a bare "✓" while `
        + `the others carry qualification — a bare check next to a qualified cell `
        + `hides the platform difference this table exists to show`);
    }
  });
});

describe("the rows that are absent on purpose stay absent", () => {
  /** Rows whose verdict must LEAD the cell, per edition index. */
  const ABSENT: Array<{ n: number; want: string; only?: number[] }> = [
    { n: 15, want: "NOT CLAIMED" },                 // physical erasure, everywhere
    { n: 14, want: "NOT OFFERED" },                 // independent external witness
    { n: 13, want: "NOT CLAIMED", only: [0, 1, 2] },// power loss; the CLI qualifies
  ];

  for (const { n, want, only } of ABSENT) {
    it(`keeps row ${n} at "${want}" as the leading verdict`, () => {
      const cells = cellsOf(n);
      const idxs = only ?? cells.map((_, i) => i);
      for (const i of idxs) {
        expect(verdict(cells[i]), `row ${n}, ${EDITIONS[i]}: the verdict must LEAD `
          + `the cell, not merely appear in it`).toBe(want);
        expect(cells[i], `row ${n}, ${EDITIONS[i]} must not claim the thing it denies`)
          .not.toMatch(/\bguaranteed\b/i);
      }
    });
  }

  it("keeps power-loss durability confined to where it was measured", () => {
    expect(cellsOf(13)[3], "the CLI claims it only on Linux ext4").toMatch(/ext4/);
  });

  it("records that NO edition reaches an independent host witness", () => {
    // This corrected a real overclaim: the CLI cell used to read "✓ the one
    // edition that can be pointed at an independent host". remote-monotonic is
    // refused witness-unsupported, so no store can carry it.
    const cli = cellsOf(14)[3];
    expect(cli).toMatch(/remote-monotonic/);
    expect(cli, "the refusal is the evidence").toMatch(/witness-unsupported/);
    expect(cli, "and the CLI must not re-acquire the capability")
      .not.toMatch(/✓/);
  });
});

describe("row 2 pins a verdict per edition, not a bag of words", () => {
  it("keeps Browser and CLI on the real binary, with the §2 carve-out", () => {
    const [browser, , , cli] = cellsOf(2);
    expect(browser).toMatch(/browser-interop\.test\.ts/);
    expect(browser, "the unqualified byte-equality is the ENVELOPE one").toMatch(/envelope/i);
    for (const c of [browser, cli]) expect(c).toMatch(/carve-out|§2/);
    expect(row(2)[1], "the row's own claim must carry the carve-out")
      .toMatch(/pairId/);
  });

  it("keeps Android at a check, naming its transcript and the PINNED commit", () => {
    const android = cellsOf(2)[1];
    expect(verdict(android), "Android is proven for this row").toBe("✓");
    expect(android).toMatch(/EngineTraceTest|engine-trace\.json/);
    expect(android, "the pinned commit, not the tag name").toMatch(/240d7f0/);
    // The pin survived a cell that said the pin had been REMOVED. Naming it is
    // not enough; the cell must not simultaneously disown it.
    expect(android, "the cell must not narrate the pin's removal")
      .not.toMatch(/\b(removed|no longer|regenerated on every run|not pinned)\b/i);
    expect(android, "the residual live round trip stays named").toMatch(/UNVERIFIED/);
  });

  it("keeps iOS UNVERIFIED, and weaker than Android for a stated reason", () => {
    const ios = cellsOf(2)[2];
    expect(verdict(ios), "iOS must not be promoted on this row").toBe("UNVERIFIED");
    expect(ios, "the stub fixture is why").toMatch(/stub/);
    expect(ios).toMatch(/formatVersion/);
    expect(ios, "iOS must not borrow Android's artifact").not.toMatch(/EngineTraceTest/);
  });
});

describe("claims whose scope the summary keeps flattening", () => {
  it("keeps the SPT pad-influence dependency stated, never denied", () => {
    // The old guard required the literal phrase "stated rather than denied" —
    // which a cell DENYING the dependency can simply contain. Pin the mechanism.
    const claim = row(10)[1];
    expect(claim).toMatch(/handoff\.json/);
    expect(claim, "the influence path is the evidence").toMatch(/padHash/);
    expect(claim).toMatch(/computational/);
    expect(claim, "the dependency must not be denied")
      .not.toMatch(/the pad does not|no pad-derived value in any metadata|none in handoff/i);
    for (const c of cellsOf(10)) {
      expect(c, "no column may carry a bare, unscoped check on this row")
        .toMatch(/N14 store scope|same scope/);
    }
  });

  it("states secret.bin's write rule at N13's real scope", () => {
    const claim = row(8)[1];
    expect(claim, "N13's scope must be carried").toMatch(/after gen/i);
    expect(claim, "the acquisition write must be named").toMatch(/import|ceremony/i);
    expect(claim).toMatch(/destroy/);
    // The flattened slogan the row exists to forbid, which the old lexeme guard
    // happily allowed a cell to contain.
    expect(claim, "the universal slogan must not return")
      .not.toMatch(/written once and never rewritten/i);
  });
});

describe("the vocabulary the table depends on is actually defined and used", () => {
  it("defines every classification it uses, above the matrix", () => {
    const anchor = DOC.indexOf("## Cross-edition claims matrix");
    // indexOf returning -1 made slice(0, -1) the WHOLE document, so the legend
    // could be deleted entirely and this still passed.
    expect(anchor, "the matrix heading must be findable").toBeGreaterThan(0);
    const legend = DOC.slice(0, anchor);
    const WORDS = ["PROTOCOL", "PLATFORM-OP", "OPERATOR", "NOT CLAIMED",
      "NOT OFFERED", "UNVERIFIED"];
    const used = WORDS.filter((w) => matrix().some((r) => r.slice(2).some((c) => c.includes(w))));
    expect(used.length, "the table should exercise its vocabulary").toBeGreaterThanOrEqual(5);
    for (const w of used) {
      expect(legend, `"${w}" is used in the matrix but never defined above it`)
        .toContain(`**${w}**`);
    }
  });

  it("names each platform's operational form inside actual CELLS", () => {
    // DOC.toContain(name) was satisfied by the legend alone, so all four names
    // could be deleted from every cell and replaced with a generic PLATFORM-OP.
    const body = matrix().flatMap((r) => r.slice(EDITION_COLUMNS)).join("\n");
    for (const name of ["BROWSER-OP", "ANDROID-OP", "IOS-OP", "NATIVE-OP"]) {
      expect(body, `${name} must name a substrate in real cells, not just the legend`)
        .toContain(name);
    }
  });
});
