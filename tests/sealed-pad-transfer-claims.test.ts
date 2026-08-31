import { existsSync, readFileSync, readdirSync } from "node:fs";
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

describe("the document says exactly what is and is not implemented", () => {
  it("carries the Phase 1B status", () => {
    expect(SPEC).toContain(
      "STATUS: PHASE 1B — STORAGE / PROVENANCE FOUNDATION IMPLEMENTED;\nSEALED TRANSFER PRODUCT FLOW NOT IMPLEMENTED."
    );
  });

  it("refuses the promotion the status line invites", () => {
    // Phase 1A ships a cryptographic core, not a feature. The sentence a
    // reader would otherwise write for us is refused in the document itself.
    expect(FLAT).toMatch(/Nothing in the shipped product offers sealed transfer/);
    expect(FLAT).toMatch(/TruePad does not support online PQC pad transfer/);
    expect(FLAT).toMatch(/There is no UI, no\s*verb, no menu item/);
  });

  it("lists the product machinery that does NOT exist", () => {
    for (const absent of [
      "persisted receive requests",
      "one-time recipient `dk` lifecycle",
      "TPR2 operator ceremony",
      "sender verification state",
      "cross-tab receive session",
      "any Browser UI, QR, or CLI verb"
    ]) {
      expect(FLAT, `${absent} must be listed as not implemented`).toContain(absent);
    }
  });

  it("the crypto core exists in an isolated module family, and core does not depend on it", () => {
    // src/spt is real now; the arrow must still point one way only.
    expect(existsSync(join(ROOT, "src/spt/index.ts"))).toBe(true);
    for (const file of readdirSync(join(ROOT, "src/core"))) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(ROOT, "src/core", file), "utf8");
      expect(source, `src/core/${file} must not import src/spt`).not.toMatch(/spt\//);
    }
  });

  it("no product surface reaches the transfer CRYPTO", () => {
    // Phase 1B gave the browser engine a storage substrate, so a blanket "the
    // engine never mentions src/spt" is no longer the right guard — it would
    // now be false for a reason that is fine. The precise claim is that the
    // engine may use the PURE byte modules (base64url, the frozen sizes, and
    // the one packageIdentity definition) and may NOT reach the KEM, the key
    // schedule, or the request codec. Those are Phase 1C.
    const ENGINE_ALLOWED = new Set(["bytes.ts", "constants.ts", "sealed-package.ts"]);
    for (const file of readdirSync(join(ROOT, "src/browser/engine"), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts")) continue;
      const source = readFileSync(join(ROOT, "src/browser/engine", file.name), "utf8");
      for (const m of source.matchAll(/from "[^"]*spt\/([^"]+)"/g)) {
        expect(ENGINE_ALLOWED.has(m[1]), `engine/${file.name} may not import spt/${m[1]}`).toBe(true);
      }
    }
    // The UI and the CLI reach NONE of it. There is no user-facing surface.
    for (const dir of ["src/browser/ui", "src/cli", "src/cli/v2"]) {
      for (const file of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".ts")) continue;
        const source = readFileSync(join(ROOT, dir, file.name), "utf8");
        expect(source, `${dir}/${file.name} must not reach src/spt`).not.toMatch(/from "[^"]*spt\//);
      }
    }
  });

  it("the KEM is still absent from the shipped browser bundle", () => {
    // The engine imports only pure byte modules, so no X-Wing, ML-KEM, SHA-3 or
    // X25519 code should reach dist. If this fails, an import crept sideways.
    const dist = join(ROOT, "dist", "assets");
    if (!existsSync(dist)) return; // no build in this run
    for (const file of readdirSync(dist)) {
      if (!file.endsWith(".js")) continue;
      const source = readFileSync(join(dist, file), "utf8");
      expect(source, `${file} must not contain KEM code`).not.toMatch(/ml_kem768|x25519|shake256|sha3_256/);
    }
  });

  it("the forbidden byte-taking RPC name exists nowhere in src", () => {
    // §18/§20: seal() names the pad. A `seal(body, padFileBytes)` RPC would let
    // a caller choose the snapshot the genesis check evaluates.
    for (const dir of ["src/spt", "src/browser/engine"]) {
      for (const file of readdirSync(join(ROOT, dir))) {
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(join(ROOT, dir, file), "utf8");
        const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        expect(withoutComments, `${dir}/${file}`).not.toMatch(/seal\s*\(\s*body\s*,\s*padFileBytes/);
      }
    }
  });

  it("the one production dependency is pinned exactly", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@noble/post-quantum"]);
    // No caret, no tilde, no range: the KEM implementation is part of the suite.
    expect(pkg.dependencies["@noble/post-quantum"]).toBe("0.7.1");
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/@noble/post-quantum"].version).toBe("0.7.1");
    expect(lock.packages["node_modules/@noble/post-quantum"].integrity).toMatch(/^sha512-/);
  });

  it("says what became of the storage prerequisite, and does not claim the platform got safer", () => {
    expect(FLAT).toMatch(/The Phase-1A storage prerequisite, and what became of it/);
    expect(FLAT).toMatch(/atomic only where `FileSystemFileHandle\.move\(\)`\s*exists/);
    // The resolution taken, named as one of the three that were open.
    expect(FLAT).toMatch(/Phase 1B took the first: §10\.9 is now marker-last/);
    // ...and the honest standing fact.
    expect(FLAT).toMatch(/fallback is still not atomic/);
    expect(FLAT).toMatch(/rather than trusting `MemoryVfs`/);
  });
});

describe("the validation record backs the implementation claims", () => {
  const VALIDATION = readFileSync(join(ROOT, "docs", "SEALED-PAD-TRANSFER-VALIDATION.md"), "utf8");
  const VFLAT = VALIDATION.replace(/^\s*>\s?/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ");

  it("names the exact production implementation and pins its integrity", () => {
    expect(VALIDATION).toContain("@noble/post-quantum");
    expect(VALIDATION).toContain("0.7.1");
    expect(VALIDATION).toMatch(/sha512-\+P9981IiAnVh/);
  });

  it("names a genuinely independent draft-10 implementation, and why others were excluded", () => {
    expect(VALIDATION).toContain("rxwing");
    expect(VALIDATION).toContain("0.1.0-draft10");
    // The exclusions are recorded, so "independent" is not asserted loosely.
    expect(VFLAT).toMatch(/authored by this repository's own owner/);
    expect(VFLAT).toMatch(/draft-06/);
  });

  it("records the divergence, and records that it was ACCEPTED", () => {
    expect(VFLAT).toMatch(/DECISION: ACCEPT `@noble\/post-quantum` 0\.7\.1's stricter low-order rejection/);
    expect(VFLAT).toMatch(/The dependency is kept\. The suite is unchanged/);
    // The exception is preserved permanently, not resolved away.
    expect(VFLAT).toMatch(/adversarial low-order `ct_X` inputs are a documented decapsulation-behaviour divergence/i);
    // ...and what was deliberately NOT done about it.
    expect(VFLAT).toMatch(/suite was not modified to match the library/);
    expect(VFLAT).toMatch(/No shim reimplements/);
  });

  it("gives the RFC 7748 basis, so the rejection is not called a TruePad invention", () => {
    expect(VFLAT).toMatch(/RFC 7748.{0,40}§6\.1 explicitly says an implementation MAY check/);
    expect(VFLAT).toMatch(/conforming RFC 7748 implementation exercising a permitted policy/);
    // draft-10's own side of it, stated separately.
    expect(VFLAT).toMatch(/specifies no all-zero abort/);
  });

  it("withdraws the false 'both refuse' argument instead of quietly deleting it", () => {
    expect(VFLAT).toMatch(/The "both refuse" argument was wrong, and is withdrawn/);
    expect(VFLAT).toMatch(/That is not true in general/);
    // The malicious-sender case that makes it false is spelled out.
    expect(VFLAT).toMatch(/keep `ss_M`/);
    expect(VFLAT).toMatch(/a package Noble refuses here is one a\s*non-aborting draft-10 implementation may accept/);
    // The old claim must not survive anywhere as a live statement.
    const live = VFLAT.replace(/An earlier version of this section said[\s\S]*?repair the AEAD\./, "");
    expect(live).not.toMatch(/Under both behaviours the package is refused/);
    expect(live).not.toMatch(/the attacker cannot predict/);
  });

  it("does not promote stricter input acceptance into sender authentication", () => {
    expect(VFLAT).toMatch(/X-Wing does not authenticate the sender, and never claimed to/);
    expect(VFLAT).toMatch(/not created by the low-order case/);
    expect(VFLAT).toMatch(/stricter input acceptance/i);
    expect(VFLAT).toMatch(/must not be promoted into an identity\s*claim/);
  });

  it("claims only reason/message equality, never timing", () => {
    expect(VFLAT).toMatch(/the same `reason` and the same `message`/);
    expect(VFLAT).toMatch(/That is too\s*strong and is withdrawn/);
    expect(VFLAT).toMatch(/Not claimed: constant-time equality of the two paths, timing\s*indistinguishability, or unobservability/);
    // The retracted phrase survives only inside its own retraction.
    const idx = VFLAT.indexOf("not observable at all");
    if (idx !== -1) {
      expect(VFLAT.slice(idx, idx + 160)).toMatch(/too\s*strong and is withdrawn/);
    }
  });

  it("states the interoperability claim at its true boundary", () => {
    expect(VFLAT).toMatch(/byte-identical to draft-10 for\s*`GenerateKeyPair`, `Encapsulate`, and all honestly generated ciphertexts/);
    expect(VFLAT).toMatch(/does not claim\s*arbitrary-malformed-ciphertext decapsulation equivalence/);
    // The unqualified phrasing is forbidden in terms.
    expect(VFLAT).toMatch(/may be written without that qualification attached/);
  });

  it("the accepted exception is pinned by a test that forces a re-audit", () => {
    expect(VFLAT).toMatch(/If a future Noble version begins\s*returning a combined secret instead, that test fails/);
    expect(existsSync(join(ROOT, "tests/spt-lowzero-divergence.test.ts"))).toBe(true);
  });

  it("keeps the draft's own vector caveat attached", () => {
    expect(VALIDATION).toContain("TODO: replace with test vectors that re-use");
    expect(VFLAT).toMatch(/not a NIST CAVP validation/);
    expect(VFLAT).toMatch(/a vector that only agrees with itself proves nothing/);
  });

  it("states what may NOT be said", () => {
    expect(VFLAT).toMatch(/Not \*"TruePad supports online PQC pad transfer\."\*/);
    expect(VFLAT).toMatch(/X-Wing is a standard.*It is an Internet-Draft/);
    expect(VFLAT).toMatch(/Not \*"the implementation is constant-time\."\*/);
    expect(VFLAT).toMatch(/Not \*"validated"\* in the FIPS or CAVP sense/);
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
    expect(FLAT).toMatch(/three facts, and TruePad adds no check of\s*its own/i);
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
    expect(FLAT).toMatch(/only after that commit succeeds/i);
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
    expect(FLAT).toMatch(/Provenance, NOT a marker, is what an import records/i);
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
    expect(FLAT).toMatch(/A pad whose provenance is `unknown` may not be sealed/);
    expect(FLAT).toMatch(/No migration, no backfill/);
    expect(FLAT).toMatch(/The absence of a field is information/);
  });

  it("an imported pad may not be EXPORTED onward either, not only not sealed", () => {
    // The walking-pace twin of the sealed hole. Gating sealing alone left it
    // open, and the document now says so in its own words.
    expect(FLAT).toMatch(/And an `imported` pad may not be exported onward either/);
    expect(FLAT).toMatch(/An earlier draft\s*gated \*?sealing\*? only/);
    expect(FLAT).toMatch(/done with a file manager/);
    expect(FLAT).toMatch(/never, by either route/i);
  });

  it("unknown keeping physical export is called a legacy boundary, not a safety finding", () => {
    expect(FLAT).toMatch(/legacy compatibility boundary, and not\s*evidence that forwarding is safe/);
    expect(FLAT).toMatch(/stated as a\s*concession, not a finding/);
    // And the reason software refuses one and not the other is given.
    expect(FLAT).toMatch(/Software\s*refuses what it knows, and documents what it cannot/);
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

describe("the sender handoff record is marker-last", () => {
  it("withdraws the one-atomic-file model, and says why", () => {
    expect(FLAT).toMatch(/The Phase-0\.6 model is withdrawn/);
    expect(FLAT).toMatch(/right about the hazard and wrong about the primitive/);
    // Both bad repairs are refused by name.
    expect(FLAT).toMatch(/narrowing supported browsers to\s*make the old prose true would choose the document over the users/);
    expect(FLAT).toMatch(/calling\s*the fallback atomic would be false/);
  });

  it("names the three files and puts the marker LAST", () => {
    expect(SPEC).toContain("<pairId>/handoff.json");
    expect(SPEC).toContain("<pairId>/handoff/package.tps2");
    expect(SPEC).toContain("<pairId>/handoff/confirm.bin");
    expect(FLAT).toMatch(/write `handoff\.json` LAST/);
    expect(FLAT).toMatch(/`handoff\.json` is the commit point/i);
  });

  it("no package byte is released before the commit", () => {
    expect(FLAT).toMatch(/only now may any package byte or confirmation datum reach a caller/i);
    expect(FLAT).toMatch(/Everything before it is pre-commit and,\s*by invariant, was never released/);
  });

  it("existence is load-bearing: a torn marker is SPENT, never absence", () => {
    expect(FLAT).toMatch(/A `handoff\.json` that exists but cannot be read is not "no handoff"/);
    expect(FLAT).toMatch(/HANDOFF-SPENT \/ STATE UNREADABLE/);
    expect(FLAT).toMatch(/LOSS IS ACCEPTABLE\. REUSE IS NOT/);
    expect(FLAT).toMatch(/There is no\s*`catch \{ return absent \}` on this path/);
    // ...and the operator is not told to delete it.
    expect(FLAT).toMatch(/They are not told to delete the\s*file/);
  });

  it("the marker is permanent", () => {
    expect(FLAT).toMatch(/Once `handoff\.json` exists it is never deleted by normal product operation/);
    expect(FLAT).toMatch(/it may not delete the marker/);
    expect(FLAT).toMatch(/no new package is created in its place/i);
  });

  it("the storage layer is not the authorization layer", () => {
    expect(FLAT).toMatch(/it takes\s*no `origin` argument/);
    expect(FLAT).toMatch(/a storage layer that\s*guessed at authorization would be a second, weaker gate/);
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
  it("dismissal clears the payload files, never the marker", () => {
    // The §10.9 rewrite moved the payload out of the marker, so the rule is now
    // stated over files rather than fields — but it is the same rule, and the
    // same regression it exists to prevent: tidying up must not re-open the pad.
    expect(FLAT).toMatch(/Dismissing a sealed transfer may delete/);
    expect(FLAT).toMatch(/it may not delete the marker/);
    expect(FLAT).toMatch(/the pad stays permanently handed off/);
    expect(FLAT).toMatch(/no new package is created in its place/i);
    expect(FLAT).toMatch(/a same-request re-share\s*is correctly unavailable/);
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

/* ---------------------------------------------------------------------------
 * Phase 1B — the storage foundation, checked against the tree
 * ------------------------------------------------------------------------ */

describe("the normative spec and the validation record do not drift apart", () => {
  const VALIDATION = readFileSync(join(ROOT, "docs", "SEALED-PAD-TRANSFER-VALIDATION.md"), "utf8");
  const VFLAT = VALIDATION.replace(/^\s*>\s?/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ");

  it("both say the same three things about the all-zero abort", () => {
    for (const doc of [FLAT, VFLAT]) {
      // draft-10 specifies none...
      expect(doc).toMatch(/draft-10 specifies no all-zero abort|specifies no all-zero abort/);
      // ...TruePad adds none...
      expect(doc).toMatch(/TruePad (adds|writes) no such check|TruePad adds no check of its own/);
      // ...the dependency does, on RFC 7748's permission, and it is accepted.
      expect(doc).toMatch(/RFC 7748 §6\.1/);
    }
    // The specific claim, in the normative document: the DEPENDENCY aborts, and
    // that is accepted. Dropping it would leave the spec saying nothing aborts
    // while the record says one does.
    expect(FLAT).toMatch(/The pinned dependency does abort, and TruePad accepts that/);
    expect(VFLAT).toMatch(/Noble aborts on an all-zero X25519 result/);
    expect(FLAT).toMatch(/It is inherited,\s*not added/);
    expect(FLAT).toMatch(/The decision to keep the dependency is closed/);
    // The normative section points at the record, so a reader cannot get one
    // half of the story.
    expect(FLAT).toMatch(/SEALED-PAD-TRANSFER-VALIDATION\.md` §6 is the full\s*record; the two documents must not drift apart/);
  });
});

describe("Phase 1B implemented what it says it implemented", () => {
  /** Prose in this codebase quotes the anti-patterns it forbids, so a guard
   *  that scanned raw text would fire on the very comment explaining the rule.
   *  These guards read CODE. */
  const codeOf = (rel: string) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const verbs = readFileSync(join(ROOT, "src/browser/engine/verbs.ts"), "utf8");
  const verbsCode = codeOf("src/browser/engine/verbs.ts");
  const handoff = readFileSync(join(ROOT, "src/browser/engine/handoff.ts"), "utf8");
  const handoffCode = codeOf("src/browser/engine/handoff.ts");

  it("gen writes generated-here and import writes imported, in the same pair.json", () => {
    expect(verbs).toMatch(/origin: "generated-here"/);
    expect(verbs).toMatch(/origin: "imported"/);
    // One writer for pair.json, so provenance cannot arrive by a second path.
    expect(verbs.match(/async function writePairMeta/g)?.length).toBe(1);
    // No separate provenance file anywhere.
    expect(verbsCode).not.toMatch(/origin\.json|provenance\.json/);
  });

  it("there is no backfill and no inference", () => {
    // `unknown` is never written, and nothing derives origin from counters,
    // genesis or a timestamp.
    expect(verbsCode).not.toMatch(/origin: "unknown"[^;]*writeFileAtomic/);
    expect(verbsCode).not.toMatch(/origin\s*=\s*.*(createdAt|nextOffset|genesis)/);
    // Reading it never rewrites it: readPairMeta has no write.
    const readFn = verbsCode.slice(verbsCode.indexOf("async function readPairMeta"), verbsCode.indexOf("async function writePairMeta"));
    expect(readFn).not.toMatch(/writeFileAtomic|writePairMeta/);
  });

  it("export refuses an imported pad, a sealed marker, and a torn marker", () => {
    const fn = verbsCode.slice(verbsCode.indexOf("async function exportImpl"), verbsCode.indexOf("function validateBundleFileSet"));
    expect(fn).toMatch(/imported-pair-cannot-export/);
    expect(fn).toMatch(/REFUSE_ALREADY_SEALED/);
    expect(fn).toMatch(/REFUSE_UNREADABLE/);
    // The marker is committed AFTER the container is built, and only when absent.
    expect(fn.indexOf("packContainer(")).toBeLessThan(fn.indexOf("commitPhysicalHandoff("));
    expect(fn).toMatch(/if \(handoff\.kind === "absent"\)\s*\{\s*await commitPhysicalHandoff/);
  });

  it("the handoff module never treats a present marker as absence", () => {
    // The specific anti-pattern the whole design turns on.
    expect(handoffCode).not.toMatch(/catch\s*\{[^}]*absent/);
    expect(handoffCode).toMatch(/kind: "unreadable-spent"/);
    // ...and nothing in it ever removes the marker.
    const removals = [...handoffCode.matchAll(/vfs\.remove\(([^)]*)\)/g)].map((m) => m[1]);
    expect(removals.length).toBeGreaterThan(0);
    for (const target of removals) {
      expect(target, `handoff.ts must never remove ${target}`).not.toMatch(/markerPath/);
    }
  });

  it("the marker is the last write of the sealed transaction", () => {
    const fn = handoffCode.slice(handoffCode.indexOf("export async function commitSealedHandoff"));
    expect(fn.indexOf("handoffPackagePath")).toBeLessThan(fn.indexOf("writeAndVerifyMarker"));
    expect(fn.indexOf("handoffConfirmPath")).toBeLessThan(fn.indexOf("writeAndVerifyMarker"));
  });

  it("the storage helpers are not worker RPCs", () => {
    const protocol = readFileSync(join(ROOT, "src/browser/engine/protocol.ts"), "utf8");
    for (const name of ["commitSealedHandoff", "loadCommittedSealedHandoff", "dismissSealedPayload", "seal", "openSealed"]) {
      expect(protocol, `${name} must not be an engine op`).not.toMatch(new RegExp(`op: "${name}"`));
    }
    // And no UI reaches them.
    for (const file of readdirSync(join(ROOT, "src/browser/ui"))) {
      if (!file.endsWith(".ts")) continue;
      // "physical handoff" appears in the claims copy as ordinary English; what
      // must not appear is a reference to the storage module or its helpers.
      const ui = codeOf(join("src/browser/ui", file));
      expect(ui, `${file} must not reach the handoff storage`).not.toMatch(
        /handoff\.ts|commitSealedHandoff|readHandoffState|dismissSealedPayload/
      );
    }
  });

  it("there is exactly one pad lock namespace", () => {
    // Phase 0.6's lesson: two locks over one pair exclude nothing.
    for (const file of ["verbs.ts", "handoff.ts"]) {
      const source = codeOf(join("src/browser/engine", file));
      expect(source, `${file} must not open a second pad lock namespace`).not.toMatch(/"spt-pad:|"spt-seal:/);
      for (const m of source.matchAll(/withLock\(([^,)]+)[,)]/g)) {
        expect(m[1].trim(), `${file} locks on ${m[1]}`).toMatch(/^(pairId|scope|req\.pairId)$/);
      }
    }
  });

  it("the courier bundle still lists exactly the six FORMAT-V2 files", () => {
    const bundle = verbsCode.slice(verbsCode.indexOf("const BUNDLE_FILES"), verbsCode.indexOf("const BUNDLE_FILE_SET"));
    expect(bundle).not.toMatch(/pair\.json|handoff|origin|PAIR_META_FILE/);
    expect((bundle.match(/SUBDIR/g) ?? []).length).toBe(6);
  });
});

/* ---------------------------------------------------------------------------
 * Phase 1B.1 — the withdrawn Phase-0.6 storage model must not come back
 * ------------------------------------------------------------------------ */

describe("no live normative text describes the withdrawn atomic-single-file model", () => {
  /** The document quotes what it withdrew, so a guard on raw text would fire on
   *  the retraction itself. These check that each stale phrase survives ONLY
   *  inside a passage that says it is withdrawn. */
  function onlyInRetraction(haystack: string, phrase: string): void {
    let at = haystack.indexOf(phrase);
    while (at !== -1) {
      const window = haystack.slice(Math.max(0, at - 320), at + 320);
      expect(window, `"${phrase}" must appear only where it is withdrawn`).toMatch(
        /withdrawn|earlier draft|An earlier version|no longer|obsolete|is now wrong|could not be honoured|not atomic/i
      );
      at = haystack.indexOf(phrase, at + 1);
    }
  }

  it("the package and the confirmation value are not fields of handoff.json", () => {
    // The marker carries HASHES. The bytes live in their own files.
    expect(SPEC).not.toMatch(/handoff\.json with\s*\{[^}]*package\s*=/);
    expect(SPEC).not.toMatch(/confirmValue\s*=\s*confirm\s*\}/);
    expect(FLAT).toMatch(/The marker holds \*\*hashes\*\*, not the package and not the confirmation value|marker holds hashes, not the package and not the confirmation value/);
    for (const phrase of ["one atomic replace", "atomically replace"]) onlyInRetraction(FLAT, phrase);
  });

  it("§20's seal pseudocode uses the marker-last storage API", () => {
    const seal = SPEC.slice(SPEC.indexOf("seal(body, pairId):"), SPEC.indexOf("exportPad(pairId):"));
    expect(seal).toContain("readHandoffState(vfs, pairId)");
    expect(seal).toContain("commitSealedHandoff(vfs, pairId,");
    expect(seal).toContain("loadCommittedSealedHandoff(vfs, pairId)");
    // The withdrawn algorithm is gone from it entirely.
    expect(seal).not.toMatch(/atomically replace/);
    expect(seal).not.toMatch(/package\s*=\s*header/);
    // A committed marker permits re-share only.
    expect(seal).toMatch(/RE-SHARE ONLY\. Never a second encapsulation/);
  });

  it("§20's export pseudocode builds the container BEFORE committing the marker", () => {
    const exp = SPEC.slice(SPEC.indexOf("exportPad(pairId):"), SPEC.indexOf("openSealed(pkg)"));
    expect(exp.indexOf("packContainer(")).toBeLessThan(exp.indexOf("commitPhysicalHandoff("));
    expect(exp).toMatch(/MARKER LAST/);
    expect(exp).toMatch(/ONLY now, after the marker commit succeeded/);
    // Provenance is checked before a single store byte is read.
    expect(exp.indexOf("imported-pair-cannot-export")).toBeLessThan(exp.indexOf("packContainer("));
    expect(exp).not.toMatch(/atomically replace/);
  });

  it("dismissal never removes SEALED/handoff-spent state", () => {
    expect(FLAT).toMatch(/Handoff-spent state\s*is permanent/i);
    expect(FLAT).toMatch(/it may \*\*never\*\* delete `handoff\.json`|may never delete `handoff\.json`/);
    expect(FLAT).toMatch(/Dismissal is \*\*not\*\* a return to `ABSENT` or to\s*`CONFIRMED`|Dismissal is not a return to `ABSENT` or to `CONFIRMED`/);
    // The old sentence must not survive as a live claim.
    onlyInRetraction(FLAT, "Cleanup removes CONFIRMED and SEALED state");
  });

  it("an import records provenance and creates no sender handoff marker", () => {
    expect(FLAT).toMatch(/an installation that imported a pad is not that pad's sender/i);
    expect(FLAT).toMatch(/Writing one\s*there would claim a handoff this installation never performed/);
    expect(FLAT).toMatch(/is never created\s*merely because a pad was imported/);
    // And the pseudocode says it too.
    expect(SPEC).toMatch(/It creates NO handoff[\s\S]{0,12}marker/);
  });

  it("same-request means RE-SHARE, never a second encapsulation", () => {
    expect(FLAT).toMatch(/\*\*Re-share, not re-seal\.\*\*|Re-share, not re-seal\./);
    expect(FLAT).toMatch(/re-share only, never a new encapsulation/i);
    expect(FLAT).toMatch(/No new X-Wing encapsulation/);
    // ...and the two are distinguished, not treated as degrees of one thing.
    expect(FLAT).toMatch(/one hands over bytes that already exist, the other\s*runs `XWing\.Encaps` again/);
  });

  it("§10.5 separates ceremony state, transient state, and durable handoff state", () => {
    expect(FLAT).toMatch(/Three kinds of state, deliberately kept apart/);
    expect(FLAT).toMatch(/It is not the durable handoff authority/);
    expect(FLAT).toMatch(/Once `handoff\.json` exists, the pad's handoff is SPENT/);
  });

  it("the marker grammar is owned by one section", () => {
    // §10.6 must not restate a competing schema; the old
    // `{ pairId, requestHash, at }` shape is gone.
    expect(SPEC).not.toMatch(/marker\*?\*? `\{ pairId, requestHash, at \}`/);
    expect(FLAT).toMatch(/§10\.9 owns its grammar\s*and this section does not restate it/);
  });

  it("status language recognises what is built without claiming the feature", () => {
    const claims = readFileSync(join(ROOT, "docs", "PRODUCT-CLAIMS.md"), "utf8");
    expect(claims).not.toMatch(/Sealed Pad Transfer — SPECIFIED, NOT IMPLEMENTED/);
    expect(claims).toMatch(/PARTLY BUILT, NOT OFFERED/);
    expect(claims).toMatch(/No product screen offers it and no operator can reach it/);
    expect(claims).toMatch(/TruePad does not\s*support online sealed pad transfer today/);
    // The three layers are stated separately, so "implemented" cannot be read
    // as "available".
    expect(claims).toMatch(/Cryptographic \/ transport core.*implemented/);
    expect(claims).toMatch(/Storage \/ provenance foundation.*implemented/);
    expect(claims).toMatch(/product transfer flow.*NOT implemented/);
    for (const doc of [claims, SPEC]) expect(doc).not.toMatch(/specified, not implemented/i);
  });
});

describe("the marker readback failure is typed, and only when a record exists", () => {
  const handoffCode = readFileSync(join(ROOT, "src/browser/engine/handoff.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  /** Just this function: slicing to end of file would sweep in the
   *  `storage-failed` refusals that belong to commitSealedHandoff's staging
   *  steps, where retry IS correct. */
  const writeAndVerify = (() => {
    const from = handoffCode.indexOf("async function writeAndVerifyMarker");
    const next = handoffCode.indexOf("export async function", from);
    return handoffCode.slice(from, next === -1 ? undefined : next);
  })();

  it("a parse failure after a write becomes handoff-state-unreadable", () => {
    const fn = writeAndVerify;
    expect(fn).toMatch(/parseMarker\(readBack, pairId\)/);
    expect(fn).toMatch(/REFUSE_UNREADABLE/);
    // ...and never re-typed as something retryable.
    expect(fn).not.toMatch(/storage-failed/);
    // The marker is never removed or rewritten to recover.
    expect(fn).not.toMatch(/vfs\.remove/);
  });

  it("which case occurred is decided by LOOKING, not by the exception's shape", () => {
    const fn = writeAndVerify;
    // On a write throw it re-reads the target before deciding.
    expect(fn).toMatch(/catch[\s\S]{0,200}readFile\(markerPath\(pairId\)\)/);
    expect(fn).toMatch(/if \(!landed\) throw error/);
  });
});
