import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * Sealed Pad Transfer — specification claim guards
 * ----------------------------------------------------------------------------
 * The spec is not implemented, so nothing here tests behaviour. What it guards
 * is the SPECIFICATION against drift, and specifically against the twelve
 * regressions that Phase 0's three review rounds and Phase 0.5's closure
 * actually produced. Several of these were mistakes made once and then made
 * again in a different place, which is why they are pinned mechanically rather
 * than trusted to proofreading.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const SPEC = readFileSync(join(ROOT, "docs", "SEALED-PAD-TRANSFER.md"), "utf8");
const FLAT = SPEC.replace(/^\s*>\s?/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ");

describe("the document does not claim the feature exists", () => {
  it("carries the not-implemented status", () => {
    expect(SPEC).toContain("STATUS: PHASE 0.6 — SPECIFIED, NOT IMPLEMENTED");
  });
  it("no runtime code implements it", () => {
    // The guard that matters most: if this ever fails, the spec's status line
    // is a lie somewhere in the tree.
    for (const f of ["src/core", "src/browser/engine", "src/cli"]) {
      const listing = readFileSync(join(ROOT, "package.json"), "utf8");
      expect(listing).not.toMatch(/ml-kem|mlkem|x-wing|xwing/i);
      void f;
    }
  });
});

describe("standards status is stated honestly", () => {
  it("RFC 10024 is a published standard, never called a draft", () => {
    expect(FLAT).toContain("RFC 10024");
    // Pin the status phrases themselves. A window-based regex is not usable
    // here: the RFC's own title contains "TLS 1.3", so any [^.] window stops at
    // that period before reaching the status cell — the first version of this
    // guard silently matched nothing for exactly that reason.
    expect(FLAT).toMatch(/Proposed Standard, August 2026/);
    expect(FLAT).toMatch(/Published IETF Proposed Standard/);
    expect(FLAT).toMatch(/not a draft/);
    // And the RFC is never characterised as one.
    expect(FLAT).not.toMatch(/RFC 10024 is (a|an) (draft|Internet-Draft)/i);
    // ...and it is still rejected for non-TLS use, on its own authority.
    expect(FLAT).toMatch(/relies crucially on the TLS 1\.3 message transcript/);
  });

  it("X-Wing is labelled as the Internet-Draft it is", () => {
    expect(FLAT).toMatch(/draft-connolly-cfrg-xwing-kem-10/);
    expect(FLAT).toMatch(/Independent Submission/);
    expect(FLAT).toMatch(/not an RFC|NOT an RFC/);
  });
});

describe("the X-Wing suite is COMPLETELY frozen, not just its combiner", () => {
  it("every algorithm is pinned, so Phase 1 has nothing to invent", () => {
    for (const fn of [
      "expandDecapsulationKey",
      "GenerateKeyPair",
      "GenerateKeyPairDerand",
      "Encapsulate",
      "EncapsulateDerand",
      "Decapsulate",
      "Combiner"
    ]) {
      expect(SPEC, `${fn} must be pinned in the spec`).toContain(`def ${fn}(`);
    }
    // The seed expansion and the exact split.
    expect(SPEC).toContain("SHAKE256(sk, 96)");
    expect(SPEC).toContain("expanded[64:96]");
    // Layouts.
    expect(SPEC).toContain("pk[0:1184]");
    expect(SPEC).toContain("ct[1088:1120]");
    // The mandated check, and the deliberately absent one.
    expect(FLAT).toMatch(/FIPS 203 §7\.2/);
    expect(FLAT).toMatch(/declines to mandate a check, and TruePad does not add one/);
  });

  it("names every random-oracle dependency, not only the combiner", () => {
    // "SHA3-256 combiner" alone understates what X-Wing assumes. All three
    // names must appear in the dependency statement AND in the claim ledger,
    // so dropping them from one place is caught even if the other survives.
    expect(FLAT).toMatch(/random\s*oracles/);
    for (const primitive of ["SHA3-256", "SHA3-512", "SHAKE-256"]) {
      expect(FLAT, `${primitive} must be named as a dependency`).toContain(primitive);
      // At least twice: the §2.2 dependency list and the §16.1 claim ledger.
      expect(
        FLAT.split(primitive).length - 1,
        `${primitive} must appear in both the dependency list and the claim ledger`
      ).toBeGreaterThanOrEqual(2);
    }
    // SHAKE-256's second role must be stated, not just its name listed.
    expect(FLAT).toMatch(/SHAKE-256[^.]*expands the decapsulation seed|expands the\s*decapsulation seed/);
  });

  it("requires independent cross-implementation vectors before production", () => {
    expect(FLAT).toMatch(/cross-check against at least one independent X-Wing implementation/);
  });
});

describe("the two ceremonies keep their separate strengths", () => {
  it("request authentication is 132 bits — a 128-bit class", () => {
    expect(FLAT).toContain("requestWords132");
    expect(FLAT).toMatch(/12 words/);
    expect(FLAT).toMatch(/132 bits/);
    // The exact extraction, not "take 132 bits".
    expect(SPEC).toContain("(m >> (121 - 11·i)) & 0x7FF");
    // 88 bits must no longer be the request strength.
    expect(FLAT).toMatch(/88 bits is withdrawn here/);
  });

  it("a position challenge is never credited as full-fingerprint security", () => {
    expect(FLAT).toMatch(/MUST NOT replace the normative comparison/);
    expect(FLAT).toMatch(/Un-compared words contribute nothing/);
  });

  it("confirmation stays 88 bits with its OWN proof, not by comparison", () => {
    expect(FLAT).toContain("confirmationWords88");
    expect(FLAT).toMatch(/proved separately/);
    expect(FLAT).toMatch(/not "88 is fine because the other one is stronger"/);
    // The property the argument turns on.
    expect(FLAT).toMatch(/no offline oracle/);
  });
});

describe("the trust boundary is not overclaimed", () => {
  it("the worker is NOT claimed to verify human intent against an active UI", () => {
    expect(FLAT).toMatch(/does not authenticate human intent against an active malicious UI|not.{0,40}authenticate human intent/i);
    expect(FLAT).toMatch(/ENDPOINT COMPROMISE for transfer authorization/);
    // No invented browser capability.
    expect(FLAT).toMatch(/No "secure attention" property exists/);
  });

  it("commitReceive never accepts caller-supplied pad bytes", () => {
    expect(SPEC).toContain("commitReceive(sessionId)");
    expect(FLAT).toMatch(/The ONLY input is an opaque handle|takes no pad bytes/);
    // The withdrawn signature must be present ONLY as an explicit retraction.
    const idx = FLAT.indexOf("commitReceive(requestId, padFileBytes)");
    if (idx !== -1) {
      expect(FLAT.slice(Math.max(0, idx - 200), idx + 200)).toMatch(/withdrawn|Phase-0 signature/);
    }
  });
});

describe("the copy and rollback models are accurate", () => {
  it(".tps2 alone is not called sufficient to recreate the pad", () => {
    expect(FLAT).toMatch(/does not contain Bob's one-time decapsulation key|holds no decapsulation key|The package does not contain/);
    // The Phase-0 error, explicitly retracted.
    expect(FLAT).toMatch(/Correction to the Phase-0 draft/);
    // And never the unqualified phrasing.
    expect(FLAT).not.toMatch(/it is a complete copy of the pad/);
  });

  it("browser profile rollback is in the replay limitations", () => {
    expect(FLAT).toMatch(/rollback boundary/);
    expect(FLAT).toMatch(/Full profile restore/);
    // The two commonly-confused rows must both be present and distinguished.
    expect(FLAT).toMatch(/clear-site-data destroys the key and causes loss/i);
    expect(FLAT).toMatch(/profile restore\/clone restores the key and permits replay/i);
  });
});

describe("state machines are atomic where they must be", () => {
  it("one request -> one package has a persisted sender transaction", () => {
    expect(SPEC).toContain("SEALING");
    expect(SPEC).toContain("SEALED");
    expect(FLAT).toMatch(/only after that persistence succeeds/i);
    expect(FLAT).toMatch(/no package leaves the worker/i);
  });

  it("the destroyed-pair pre-flight is FREE, not LOSS", () => {
    // The Phase-0 contradiction between §11 and the threat matrix.
    const row = FLAT.match(/\| 18 \|[^|]*\|[^|]*\|[^|]*\|([^|]*)\|/);
    expect(row).not.toBeNull();
    if (row) expect(row[1]).toMatch(/FREE/);
  });

  it("the pairing rule is frozen", () => {
    expect(FLAT).toMatch(/genesis/i);
    expect(FLAT).toMatch(/One pad → one sealed handoff|one sealed handoff, ever/);
  });
});

describe("the pairing rule closes the two-time-pad routes", () => {
  it("an IMPORTED pad can never be sealed onward — the marker does not travel", () => {
    // The largest hole the falsification rounds found. The handoff marker lives
    // in the sealer's origin; pair.json is not in the bundle and carries no
    // origin field, so without an explicit rule an imported pad lands at
    // genesis, unmarked, and can be re-sealed to a third party.
    expect(FLAT).toMatch(/An imported pad can never be sealed onward/);
    expect(FLAT).toMatch(/origin: "generated-here"/);
    expect(FLAT).toMatch(/marker is also written on IMPORT/i);
  });

  it("seal() names the pad, never its bytes", () => {
    expect(SPEC).toContain("seal(body, pairId):");
    expect(SPEC).not.toContain("seal(body, padFileBytes):");
    // Genesis is read from the live store, not from a caller's snapshot.
    expect(FLAT).toMatch(/from the live store, never from bytes a caller supplied/);
  });

  it("the lock order is stated, pairId outermost", () => {
    expect(FLAT).toMatch(/pairId lock OUTERMOST, then requestHash/);
  });

  it("recovery from a lost transfer is a NEW PAD, not a re-seal", () => {
    expect(FLAT).toMatch(/The pad's one handoff is spent/);
    // The rejected permissive alternative, and why.
    expect(FLAT).toMatch(/cannot distinguish "Bob never imported" from "Bob\s*imported and says he didn't/);
  });
});

describe("the confirmation proof's conditions are all normative", () => {
  it("names four conditions, including the two the first draft missed", () => {
    expect(FLAT).toMatch(/rejection is terminal/);
    expect(FLAT).toMatch(/one live session per request/i);
    expect(FLAT).toMatch(/were missing from the first Phase-0\.5 draft/i);
  });

  it("rejection is terminal, not a return to PENDING", () => {
    expect(SPEC).toMatch(/operator rejects ──► CANCELLED/);
    expect(SPEC).not.toMatch(/operator rejects ──► back to PENDING/);
  });

  it("receiver-first is classified as an OPERATOR assumption", () => {
    expect(FLAT).toMatch(/it cannot hear who spoke\s*first/);
    expect(FLAT).toMatch(/the receiver-first ordering of §8\.2/);
  });

  it("88 bits is not raised, and the reason is stated", () => {
    expect(FLAT).toMatch(/88 bits does not need to rise/);
    expect(FLAT).toMatch(/X-Wing encapsulations/);
  });
});

describe("the delivery claim is not stronger than the weakest primitive", () => {
  it("does not claim the whole stack survives any single break", () => {
    // The phrase may appear ONLY inside its own retraction — the document
    // quotes the earlier draft's wording in order to correct it.
    const idx = FLAT.indexOf("no single primitive break opens the archive");
    if (idx !== -1) {
      expect(
        FLAT.slice(Math.max(0, idx - 220), idx + 220),
        "the retracted phrase may appear only as a retraction"
      ).toMatch(/earlier draft|which is false|withdrawn/i);
    }
    // ...and the accurate, narrower property is the one actually asserted.
    expect(FLAT).toMatch(/No single KEM component-family failure/);
    expect(FLAT).toMatch(/does not extend to the delivery stack/);
  });

  it("the words are never treated as key material", () => {
    expect(FLAT).toMatch(/never key material/);
    expect(FLAT).toMatch(/not a BIP-39 mnemonic/);
  });
});

/* ---------------------------------------------------------------------------
 * Phase 0.6 — state / persistence closure
 * ------------------------------------------------------------------------ */

describe("the two fingerprint sizes are never conflated", () => {
  it("the request is 132 bits and the confirmation is 88, each by name", () => {
    expect(SPEC).toContain("requestWords132");
    expect(SPEC).toContain("confirmationWords88");
    expect(FLAT).toMatch(/12 words, 132 bits/);
    expect(FLAT).toMatch(/11 bytes → 8 words|8 words/);
  });

  it("the stale 2^88/T multi-target figure survives only as a retraction", () => {
    // 2⁸⁸ is CORRECT for the confirmation value and for the grind in the threat
    // matrix. What was stale is the REQUEST fingerprint's multi-target figure,
    // which the 132-bit move left behind at 2⁸⁸/T.
    const idx = FLAT.indexOf("2⁸⁸/T");
    if (idx !== -1) {
      expect(
        FLAT.slice(Math.max(0, idx - 200), idx + 200),
        "2⁸⁸/T may appear only where it is called stale"
      ).toMatch(/stale/i);
    }
    expect(FLAT).toContain("2¹³²/T");
  });

  it("the TTL does not carry the authentication argument", () => {
    expect(FLAT).toMatch(/It is \*not\*\s*what makes request authentication strong/);
    expect(FLAT).toMatch(/Remove the TTL tomorrow and\s*request authentication does not become weak/);
  });
});

describe("rejection leaves no return-to-PENDING anywhere", () => {
  it("no state, table row, or prose sends a rejected round back", () => {
    // The ONE legitimate return to PENDING is a crash in AWAITING_CONFIRMATION,
    // which consumes nothing. Every other occurrence was a leftover: the state
    // diagram's old edge, and the failure table's "FREE (returns to PENDING)".
    const returns = [...FLAT.matchAll(/.{90}returns to `?PENDING`?/g)].map((m) => m[0]);
    for (const context of returns) {
      expect(context, "the only return to PENDING is a crash").toMatch(/crash/i);
    }
    expect(SPEC).not.toMatch(/operator rejects ──► back to PENDING/);
    expect(SPEC).not.toContain("FREE (returns to `PENDING`)");
  });

  it("recovery is priced as a NEW PAD and a NEW REQUEST", () => {
    expect(FLAT).toMatch(/a NEW PAD \*and\* a NEW RECEIVE REQUEST/);
    expect(FLAT).not.toContain("Cost: one new request");
    expect(FLAT).toMatch(/understates it by a whole pad/);
  });
});

describe("the failure taxonomy has two axes", () => {
  it("names the receiver axis and the sender axis separately", () => {
    for (const token of [
      "REQUEST-FREE",
      "REQUEST-LOST",
      "HANDOFF-UNSPENT",
      "HANDOFF-SPENT",
      "PAD-SPENT"
    ]) {
      expect(SPEC, `${token} must be a named outcome`).toContain(token);
    }
  });

  it("no row is both HANDOFF-SPENT and FREE", () => {
    // The regression this catches is the one Phase 0.6 exists to fix: a table
    // that says FREE on a row where Alice has already sealed. Checked
    // structurally, per row, not by looking for the vocabulary somewhere.
    const rows = SPEC.split("\n").filter(
      (l) => l.startsWith("| ") && l.split("|").length === 6 && /HANDOFF-(SPENT|UNSPENT)/.test(l)
    );
    expect(rows.length, "the failure table must still be classified").toBeGreaterThan(15);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const [, , receiver, sender, outcome] = cells;
      if (sender.includes("HANDOFF-SPENT")) {
        expect(outcome, `spent handoff must not be FREE: ${cells[1]}`).not.toMatch(/\bFREE\b/);
        expect(outcome).toMatch(/PAD-SPENT|LOSS/);
      } else {
        expect(outcome, `unspent handoff is FREE: ${cells[1]}`).toMatch(/\bFREE\b/);
        expect(receiver).toMatch(/REQUEST-FREE/);
      }
      // LOSS requires BOTH axes to be lost.
      if (/\bLOSS\b/.test(outcome)) {
        expect(receiver).toMatch(/REQUEST-LOST/);
        expect(sender).toMatch(/HANDOFF-SPENT/);
      }
    }
  });

  it("only genuinely pre-seal failures are HANDOFF-UNSPENT", () => {
    // Internal consistency is not enough: relabelling a post-seal row
    // HANDOFF-UNSPENT would make it FREE again and stay self-consistent. The
    // set of pre-seal failures is small and closed, so pin it by identity.
    const PRE_SEAL = [
      "malformed receive request",
      "unsupported transfer version",
      "unsupported suite",
      "request fingerprint not confirmed by operator",
      "sender's pad ineligible to seal"
    ];
    const unspent = SPEC.split("\n")
      .filter((l) => l.startsWith("| ") && l.split("|").length === 6 && l.includes("HANDOFF-UNSPENT"))
      .map((l) => l.split("|")[1].trim());
    expect(unspent.length, "the pre-seal set is closed").toBe(PRE_SEAL.length);
    for (const row of unspent) {
      expect(
        PRE_SEAL.some((p) => row.startsWith(p)),
        `"${row}" is not a pre-seal failure — it cannot be HANDOFF-UNSPENT`
      ).toBe(true);
    }
  });

  it("'nothing changed' is never said once the handoff is spent", () => {
    expect(FLAT).toMatch(/Never report a failure as "nothing changed" once the handoff is spent/);
    // FREE is defined as the conjunction, not as a synonym for "recoverable".
    expect(FLAT).toMatch(/`FREE` is reserved for the pre-seal rows/);
  });

  it("exactly two failure rows are REQUEST-LOST", () => {
    // The failure table has 4 cells per row; the 3-cell outcome-definition
    // table above it also mentions REQUEST-LOST and is not a failure row.
    const rows = SPEC.split("\n").filter(
      (l) => l.startsWith("| ") && l.includes("REQUEST-LOST") && l.split("|").length === 6
    );
    expect(rows.length, "terminal rejection, and any failure after the CAS").toBe(2);
    expect(rows.join(" ")).toMatch(/rejects the §8\.2 confirmation words/);
    expect(rows.join(" ")).toMatch(/after\*\* the CAS/);
  });
});

describe("provenance has ONE frozen representation", () => {
  it("Phase 1 is offered no choice", () => {
    expect(FLAT).not.toMatch(/either the same durable marker/);
    expect(FLAT).toMatch(/That choice is withdrawn/);
    expect(FLAT).toMatch(/The representation is `origin` on `pair\.json`, and only that/);
    // ...and the rejected alternative's reason is recorded, not just the verdict.
    expect(FLAT).toMatch(/Overloading a security predicate to carry a\s*second meaning/);
  });

  it("unknown provenance is not generated-here, and is never backfilled", () => {
    expect(FLAT).toMatch(/unknown` is not `generated-here|unknown is not generated-here/);
    expect(FLAT).toMatch(/No migration, no backfill/);
    expect(FLAT).toMatch(/The absence of a field is information/);
    // It gates sealing ONLY — legacy pads keep working.
    expect(FLAT).toMatch(/gates sealing only/i);
  });

  it("the ordinary courier import records imported, in the existing write", () => {
    expect(FLAT).toMatch(/Any import must record "imported"|Any\s*import must record/);
    expect(FLAT).toMatch(/`origin: "imported"` is a field of\s*that same object/);
    expect(FLAT).toMatch(/There is no ordering in which a committed pad exists\s*without provenance/);
  });
});

describe("the cross-mode gap is closed by policy, not by assumption", () => {
  it("physical and sealed handoffs share one record", () => {
    expect(FLAT).toMatch(/one pad, one handoff, whichever mode it used/i);
    expect(FLAT).toMatch(/pad-already-sealed/);
    expect(FLAT).toMatch(/pad-already-handed-off/);
  });

  it("the operator assumption that remains is stated narrowly", () => {
    expect(FLAT).toMatch(/a pad file, once exported, went to at most one other person/i);
    // The old, broader claim is explicitly no longer the residual.
    expect(FLAT).toMatch(/is not "one pad, one other person"/);
  });
});

describe("the sender handoff record is one file, one atomic replace", () => {
  it("names the file and forbids two writes", () => {
    expect(SPEC).toContain("<pairId>/handoff.json");
    expect(FLAT).toMatch(/Never two files, never two writes/);
    expect(FLAT).toMatch(/atomically replace/);
  });

  it("says what each half-write would cost", () => {
    expect(FLAT).toMatch(/A marker without a package bricks\s*the pad/);
    expect(FLAT).toMatch(/A\s*package without a marker releases confirmation words Alice cannot reproduce/);
  });

  it("is not claimed to be a rollback authority", () => {
    expect(FLAT).toMatch(/Not a witness/);
  });
});

describe("the receive session is single across tabs", () => {
  it("a Web Lock is held for the session's whole lifetime", () => {
    // openSealed itself must take it, before decapsulating — not merely be
    // described as doing so in prose.
    expect(SPEC).toMatch(
      /openSealed\(pkg\) -> sessionId:[\s\S]{0,400}?acquire lock "spt-recv:" ‖ pkg\.requestId WITH ifAvailable/
    );
    expect(SPEC).toMatch(/held from here until commitReceive, rejection, or worker teardown/);
    expect(FLAT).toMatch(/holds it until the session ends/);
    expect(FLAT).toMatch(/ifAvailable/);
    expect(FLAT).toMatch(/does not queue behind it|Queueing would/);
  });

  it("the commitReceive lock order is frozen, outermost first", () => {
    expect(FLAT).toMatch(/a request-scoped lock is always acquired\s*before a pad-scoped lock on this path/);
    // seal()'s opposite nesting is acknowledged, and justified rather than hidden.
    expect(FLAT).toMatch(/§20's `seal\(\)` nests the other way/);
    expect(FLAT).toMatch(/nothing that holds `"spt-send:"` waits on\s*anything/);
  });

  it("rejection is durable first and needs no cross-tab message", () => {
    expect(FLAT).toMatch(/written durably first/);
    expect(FLAT).toMatch(/No cross-tab message is required, and none is trusted/);
    expect(FLAT).toMatch(/dead by construction/);
  });
});

describe("packageIdentity commits to the whole package", () => {
  it("is not SHA-256(AAD)", () => {
    expect(FLAT).toMatch(/SHA-256\(COMPLETE TPS2 bytes/);
    expect(FLAT).toMatch(/NOT SHA-256\(AAD\)/);
    expect(FLAT).toMatch(/differing solely in ciphertext or tag/);
    // It is bookkeeping after AEAD, never a substitute for it.
    expect(FLAT).toMatch(/never a substitute for it/);
  });
});

/* ---------------------------------------------------------------------------
 * Phase 0.6 — what the paper falsification rounds A–F found
 * ------------------------------------------------------------------------ */

describe("the two axes are attributed to the party that can see them", () => {
  it("the outcome column is not claimed to be renderable by either side", () => {
    expect(FLAT).toMatch(/The two axes are observed by different\s*people/);
    expect(FLAT).toMatch(/each side is shown the axis it actually knows/i);
    expect(FLAT).toMatch(/It is the ledger this document reasons in, not a string\s*to render/);
  });

  it("the sender axis is scoped to THIS attempt", () => {
    expect(FLAT).toMatch(/It records what \*this attempt\* did/);
    // ...so an already-spent pad refusing again is not miscounted as a new spend.
    expect(FLAT).toMatch(/already\* spent by an earlier ceremony is\s*`HANDOFF-UNSPENT`/);
  });

  it("REQUEST-FREE on a PAD-SPENT row is not oversold", () => {
    expect(FLAT).toMatch(/it does not save the pad/);
  });
});

describe("the lock namespace is frozen and cycle-free", () => {
  it("the pad lock is the store's own lock, not a second one", () => {
    expect(FLAT).toMatch(/The pad lock is the store's own lock, not a new one/);
    expect(FLAT).toMatch(/two locks over one object exclude nothing/);
    // The rejected bespoke name survives ONLY inside its own rejection.
    const idx = FLAT.indexOf('"spt-seal:"');
    expect(idx, "spt-seal must not be reintroduced as a live lock").toBeGreaterThan(-1);
    expect(FLAT.slice(idx, idx + 200)).toMatch(/would have been a \*second\* lock/);
    expect(SPEC).not.toMatch(/acquire lock "spt-seal:"/);
    expect(SPEC).toContain("acquire vfs.withLock(pairId)");
  });

  it("no prefix is keyed by two different things", () => {
    expect(FLAT).toMatch(/no prefix keyed by two different things/i);
    expect(SPEC).toContain('"spt-send:" ‖ requestHash');
    expect(SPEC).toContain('"spt-req:" ‖ requestId');
    expect(SPEC).toContain('"spt-recv:" ‖ requestId');
    // The sender's lock is no longer spelled with the receiver's prefix.
    expect(SPEC).not.toContain('"spt-req:" ‖ requestHash');
  });

  it("deadlock freedom is argued, not assumed", () => {
    expect(FLAT).toMatch(/The wait-for graph therefore has no cycle/);
    expect(FLAT).toMatch(/re-checked before \*\*any\*\* new lock is added|re-check(ed)? before adding a lock/);
  });
});

describe("the session lock is released on every path", () => {
  it("abandon exists and is not rejection", () => {
    expect(SPEC).toContain("abandon(sessionId):");
    expect(FLAT).toMatch(/Abandoning is NOT rejecting|abandoning is not\s*rejecting/i);
    expect(FLAT).toMatch(/The request stays PENDING/);
    expect(FLAT).toMatch(/blocks the request for its own tab/);
  });
});

describe("tidying up cannot un-spend a handoff", () => {
  it("dismissal clears the package, never the record", () => {
    expect(FLAT).toMatch(/Dismissal clears the package, never the record/);
    expect(FLAT).toMatch(/`pairId`, `mode`,\s*`at` and `requestHash` are permanent for the life of the pad/);
    // The specific regression: deleting the file re-opens the pad to a second seal.
    expect(FLAT).toMatch(/re-opening the pad to a second seal by the ordinary act of tidying up/);
  });
});

describe("export keeps the refusals it already has", () => {
  it("the new check is added to them, not substituted for them", () => {
    expect(SPEC).toMatch(/require pair exists, NOT destroyed, NOT mid-import\s+# unchanged from today/);
  });
});

describe("provenance is not claimed to survive endpoint compromise", () => {
  it("says OPFS is reachable from the page", () => {
    expect(FLAT).toMatch(/OPFS is reachable from the page as well\s*as the worker/);
    expect(FLAT).toMatch(/it is not a hole this\s*field could close/i);
  });
});
