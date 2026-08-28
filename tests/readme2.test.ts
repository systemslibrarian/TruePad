import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * README v2 section claims (Phase 3 documentation). The truepad2 section's
 * load-bearing sentences must stay verbatim, and the claims this project
 * refuses to make must stay absent from the WHOLE README — v1 sections
 * included. Companion to tests/claims.test.ts, which guards the retracted
 * v1 claims; this file guards what v2 is allowed to say about itself.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

// A sentence quoted from the README, matched across its line wraps: every
// space may be any whitespace run, everything else is literal.
function phrase(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/ /g, "\\s+"));
}

describe("README v2 section: the load-bearing sentences stay", () => {
  it("has the section, titled as the verb surface names itself", () => {
    expect(readme).toContain("## truepad2 — Store Format v2: authenticated envelopes");
  });

  const LOAD_BEARING: [string, string][] = [
    [
      "The per-attempt forgery bound is exactly ε = 65540 · 2^-128 at the 1 MiB record cap, and per record at most `verifyAttemptLimit` times that",
      "FORMAT-V2.md §5 / ledger N7: the exact bound, no ≈, with its per-record multiple"
    ],
    [
      "Every in-window forgery attempt costs the receiver one durable write",
      "§8.4: the availability price is stated, not hidden"
    ],
    [
      "destruction from the channel is not eliminated, it is bounded by the window, surfaced to the operator, and never silent",
      "§8.4: bounded, surfaced, never silent — the price of a finite forgery bound"
    ],
    [
      "the v2 format does not fix backup: a configured rollback witness (`--witness-class separate-state-file`) closes the restore hole for that store, and at the default `witnessClass: none` the residual is STILL OPEN",
      "§9.4/§15: a witness closes the restore hole for that store; at witnessClass none the residual stands"
    ],
    [
      "a pair directory is restored as all three files together or not at all",
      "§9.4: the v2-specific named operator assumption"
    ],
    [
      "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes",
      "§17: destroy claims what software can claim and states the rest; erasure of the medium is not claimed"
    ],
    [
      "This repository still does not recommend one-time pads for real traffic",
      "the verdict does not soften with v2"
    ],
    [
      "There is no conversion, in either direction, ever — no `--legacy`, no `--no-auth`, no `--force`",
      "§9.2: refusals, not bridges"
    ],
    [
      "the channel observes record count and timing but never message length",
      "§16: the length-hiding property of a fixed-record store"
    ],
    [
      "its per-attempt forgery bound is exactly `(4 + F/16) · 2^-128`",
      "§16 / N20: the fixed-store ε, stated as the number, not stronger"
    ],
    [
      "a message may hold at most `F − 4` bytes",
      "§16.1: the fixed-record plaintext capacity, and its pad-spend price"
    ],
    [
      "The witness sees only the three counters (the two high-waters plus `attemptsReserved`)",
      "§15.1 / N17: the frozen three-counter witness shape, so the README cannot drift back to two"
    ]
  ];

  for (const [sentence, why] of LOAD_BEARING) {
    it(`keeps: "${sentence.slice(0, 60)}…" — ${why}`, () => {
      expect(readme).toMatch(phrase(sentence));
    });
  }
});

describe("claims the README must never make, anywhere", () => {
  const FORBIDDEN: [RegExp, string][] = [
    [/unforgeable/i, "the tag is a stated bound per attempt, not immunity — the README says the number"],
    [/provably secure/i, "every bound is conditional: declared-uniform sources (§7) and the §10 durability scope"],
    [/fixes (the )?backup/i, "the whole-directory restore residual is open until a Phase-4 witness (§9.4)"]
  ];

  for (const [pattern, why] of FORBIDDEN) {
    it(`README does not match ${pattern} — ${why}`, () => {
      expect(readme).not.toMatch(pattern);
    });
  }
});
