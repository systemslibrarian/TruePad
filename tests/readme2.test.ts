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
      "the v2 format does not fix backup, and that residual is STILL OPEN until a Phase-4 rollback witness exists",
      "§9.4: the whole-directory restore residual stands until a witness lands"
    ],
    [
      "a pair directory is restored as all three files together or not at all",
      "§9.4: the v2-specific named operator assumption"
    ],
    [
      "This repository still does not recommend one-time pads for real traffic",
      "the verdict does not soften with v2"
    ],
    [
      "There is no conversion, in either direction, ever — no `--legacy`, no `--no-auth`, no `--force`",
      "§9.2: refusals, not bridges"
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
