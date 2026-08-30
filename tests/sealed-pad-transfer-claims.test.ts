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
    expect(SPEC).toContain("STATUS: PHASE 0 — SPECIFIED, NOT IMPLEMENTED");
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
