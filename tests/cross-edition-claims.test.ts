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

  it("keeps the SPT pad-influence dependency stated, never denied", () => {
    // The row reads as "nothing about my pad reaches metadata", and a bare check
    // in every column used to say exactly that. It is true for the N14 store
    // scope and NOT true without qualification: sealed transfer writes a durable
    // handoff.json whose packageIdentity/confirmHash the pad influences, and
    // SEALED-PAD-TRANSFER.md §17 states that rather than denying it. The ledger
    // must not be quieter than the specification it summarises.
    const row = matrix().find((r) => r[1].includes("No pad-derived value"));
    expect(row, "the N14 row must exist").toBeDefined();
    const claim = (row as string[])[1];
    expect(claim, "the SPT exception must stay named").toMatch(/handoff\.json/);
    expect(claim).toMatch(/stated rather than denied/);
    expect(claim, "…and be labelled computational, not information-theoretic")
      .toMatch(/computational/);
    for (const cell of (row as string[]).slice(EDITION_COLUMNS)) {
      expect(cell, "no column may carry a bare, unscoped check on this row")
        .toMatch(/N14 store scope|same scope/);
    }
  });

  it("states secret.bin's write rule at N13's real scope", () => {
    // "Written once and never rewritten" is what the row used to say, and a
    // reviewer who greps finds THREE durable write sites (gen, import staging,
    // import commit) because import materialises the bundle's secret.bin halves.
    // N13 is scoped "after gen" for exactly that reason. A ledger that is
    // tidier than its own spec teaches the reviewer to distrust it.
    const row = matrix().find((r) => r[1].includes("Retirement is logical"));
    expect(row, "the retirement row must exist").toBeDefined();
    const claim = (row as string[])[1];
    expect(claim, "N13's scope must be carried, not flattened")
      .toMatch(/after gen/i);
    expect(claim, "the import write path must be named, not hidden")
      .toMatch(/import/i);
    expect(claim, "…and destroy must remain the one exception")
      .toMatch(/destroy/);
  });

  it("keeps power-loss durability confined to where it was measured", () => {
    const [browser, android, ios, cli] = rowCells("Power-loss durability");
    for (const cell of [browser, android, ios]) expect(cell).toMatch(/NOT CLAIMED/);
    expect(cli, "the CLI claims it only on Linux ext4, and must keep saying so")
      .toMatch(/ext4/);
  });

  it("keeps byte-identity evidence attached to what actually proves it", () => {
    // THIS GUARD HAS BEEN WRONG IN BOTH DIRECTIONS, so it pins per-edition facts
    // rather than one slogan.
    //
    // First it required Android AND iOS to say "No whole-store byte-identity test
    // exists" — false for Android, which has EngineTraceTest against a released
    // transcript of REAL artifacts (811-byte v2 heads, 768-byte secrets, a 5 KB
    // container). Understating evidence is drift too, and a guard can make it
    // permanent.
    //
    // Then the correction over-swung and promoted iOS on the same row. It must
    // not be: the shared courier fixture holds THREE STUB FILES — head.json is
    // the literal 19 bytes {"formatVersion":2} — so it pins the bundle envelope
    // format, not store bytes, and iOS has no engine-trace equivalent at all.
    // The two phones are NOT at the same standing, and the table must not say so.
    const [browser, android, ios, cli] = rowCells("byte-identical");

    // Browser/CLI: the real binary on both ends, and the §2 carve-out carried.
    expect(browser).toMatch(/browser-interop\.test\.ts/);
    expect(browser, "the byte-equality that is unqualified is the ENVELOPE one")
      .toMatch(/envelope/i);
    for (const cell of [browser, cli]) {
      expect(cell, "the browser ⇄ CLI pair must carry the §2 carve-out")
        .toMatch(/carve-out|§2/);
    }

    // Android: names its transcript, the PINNED released commit, and its residual.
    expect(android).toMatch(/EngineTraceTest|engine-trace\.json/);
    expect(android, "the PINNED commit, not just the tag name").toMatch(/240d7f0/);
    expect(android).toMatch(/hash-pinned/);
    expect(android, "no live round trip runs; that must stay named")
      .toMatch(/UNVERIFIED/);
    expect(android).toMatch(/live/);

    // iOS: must stay UNVERIFIED, and must say WHY it is weaker than Android.
    expect(ios, "iOS has no engine-trace equivalent and must not be promoted")
      .toMatch(/UNVERIFIED/);
    expect(ios, "the stub fixture is the reason, and must be stated")
      .toMatch(/stub/);
    expect(ios).toMatch(/formatVersion/);

    // And the two phones must not be described as equally proven.
    expect(ios, "iOS must not claim Android's standing").not.toMatch(/EngineTraceTest/);
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
