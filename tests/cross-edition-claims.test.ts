import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * THE CLAIMS TABLE MUST KEEP UP WITH THE PRODUCTS
 * ----------------------------------------------------------------------------
 * `docs/PRODUCT-CLAIMS.md` is the cross-edition ledger. For most of 3.0's life
 * it carried a real defect: three of its columns said *forthcoming* while three
 * editions had shipped. Nobody lied — but an unpopulated column reads as a
 * silence, and a silence next to a shipping product is drift.
 *
 * This file is the guard that stops it recurring. It does NOT re-derive the
 * claims — deriving the expectation from whatever the file happens to say would
 * make the check vacuous. It pins the SHAPE that keeps the table honest:
 *
 *   · every shipping edition has its own column;
 *   · no cell is left as a placeholder;
 *   · a "not claimed" is spelled with the vocabulary the doc defines, so that
 *     absence stays visible rather than being softened into prose;
 *   · the four rows that are absent-on-purpose stay absent on every edition
 *     that cannot back them, because those are exactly the rows that would be
 *     most tempting to quietly upgrade.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const DOC = readFileSync(resolve(ROOT, "docs/PRODUCT-CLAIMS.md"), "utf8");

/** The matrix rows, as arrays of trimmed cells. Header and rule excluded. */
function matrix(): string[][] {
  const rows = DOC.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
  return rows.map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
}

/** The header row of the matrix, as trimmed cells. */
function header(): string[] {
  const line = DOC.split("\n").find((l) => /^\|\s*#\s*\|/.test(l));
  expect(line, "the matrix header must exist").toBeDefined();
  return (line as string).replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Columns that hold a per-edition verdict: everything after # / Claim / Class. */
const EDITION_COLUMNS = 3;

describe("the claims table covers every shipping edition", () => {
  it("finds a matrix at all", () => {
    // POSITIVE CONTROL. A guard that silently matches zero rows passes forever.
    expect(matrix().length, "claim rows found").toBeGreaterThanOrEqual(17);
    expect(DOC.length, "bytes of PRODUCT-CLAIMS.md").toBeGreaterThan(10_000);
  });

  it("has one column per shipping edition, and no stale ones", () => {
    const cols = header();
    expect(cols.slice(0, 3)).toEqual(["#", "Claim", "Class"]);
    expect(cols.slice(3), "the four edition columns, in order")
      .toEqual(["Browser", "Android", "iOS", "CLI / Native"]);
  });

  it("leaves no cell unpopulated", () => {
    for (const row of matrix()) {
      const n = row[0];
      expect(row.length, `row ${n} must have every column`).toBe(3 + 4);
      for (let i = EDITION_COLUMNS; i < row.length; i++) {
        const cell = row[i];
        expect(cell.length, `row ${n}, column ${header()[i]} is empty`).toBeGreaterThan(0);
        // The exact word that used to stand in for three shipped products.
        expect(cell.toLowerCase(), `row ${n}, column ${header()[i]} is still a placeholder`)
          .not.toMatch(/\b(forthcoming|tbd|todo|xxx|n\/a)\b/);
      }
    }
  });

  it("names no edition that does not ship", () => {
    // "Desktop" was a column heading for an edition that never shipped under
    // that name; the operational path is the CLI. Keep the ledger's nouns and
    // the product's nouns the same.
    expect(header().join(" ")).not.toMatch(/\bDesktop\b/);
  });
});

describe("the rows that are absent on purpose stay absent", () => {
  /** Cells of the row whose claim text matches, edition columns only. */
  function rowCells(fragment: string): string[] {
    const row = matrix().find((r) => r[1].toLowerCase().includes(fragment.toLowerCase()));
    expect(row, `no claim row mentions "${fragment}"`).toBeDefined();
    return (row as string[]).slice(EDITION_COLUMNS);
  }

  it("does not let physical erasure become a claim anywhere", () => {
    // TruePad may never promote software evidence into proof of physical
    // erasure. Not on one edition, not on four.
    for (const cell of rowCells("Physical erasure")) {
      expect(cell).toMatch(/NOT CLAIMED/);
    }
  });

  it("keeps the independent external witness a CLI-only capability", () => {
    const [browser, android, ios, cli] = rowCells("independent external");
    for (const cell of [browser, android, ios]) expect(cell).toMatch(/NOT OFFERED/);
    // …and the CLI's is not upgraded into something the phones could borrow.
    expect(cli).toMatch(/independent host/);
  });

  it("keeps power-loss durability confined to where it was measured", () => {
    const [browser, android, ios, cli] = rowCells("Power-loss durability");
    for (const cell of [browser, android, ios]) expect(cell).toMatch(/NOT CLAIMED/);
    expect(cli, "the CLI claims it only on Linux ext4, and must keep saying so")
      .toMatch(/ext4/);
  });

  it("keeps whole-store byte-identity unclaimed where no test proves it", () => {
    // Message-level interop is proven on the phones; whole-store byte identity
    // is proven only browser ⇄ CLI. The distinction is the claim.
    const [browser, android, ios] = rowCells("byte-identical");
    expect(browser).toMatch(/browser-interop\.test\.ts/);
    for (const cell of [android, ios]) {
      expect(cell).toMatch(/UNVERIFIED/);
      expect(cell, "an UNVERIFIED cell must name the missing evidence")
        .toMatch(/No whole-store byte-identity test exists/);
    }
  });
});

describe("the vocabulary the table depends on is actually defined", () => {
  it("defines every classification it uses", () => {
    const used = new Set<string>();
    for (const row of matrix()) {
      for (const word of ["PROTOCOL", "PLATFORM-OP", "OPERATOR", "NOT CLAIMED",
        "NOT OFFERED", "UNVERIFIED"]) {
        if (row.slice(2).some((c) => c.includes(word))) used.add(word);
      }
    }
    expect(used.size, "the table should exercise its own vocabulary").toBeGreaterThanOrEqual(5);
    const legend = DOC.slice(0, DOC.indexOf("## Cross-edition claims matrix"));
    for (const word of used) {
      expect(legend, `"${word}" is used in the matrix but never defined above it`)
        .toContain(`**${word}**`);
    }
  });

  it("names each platform's operational form separately", () => {
    // The whole point of PLATFORM-OP is that one edition's strength is never
    // quoted for another. Each substrate needs its own name.
    for (const name of ["BROWSER-OP", "ANDROID-OP", "IOS-OP", "NATIVE-OP"]) {
      expect(DOC, `${name} must be defined and used`).toContain(name);
    }
  });
});
