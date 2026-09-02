import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import { combineSources, partition, requiredSourceLength } from "../src/core/partition2";
import * as CLAIMS from "../src/browser/ui/source-claims";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

/* ============================================================================
 * True OTP ceremony / source-claim closure
 * ----------------------------------------------------------------------------
 * The governing rule, tested rather than trusted:
 *
 *   The XOR is already a true one-time pad. The machinery only keeps the
 *   theorem's hypotheses true OUTSIDE the equation. Never promote an
 *   engineering action into a stronger cryptographic claim than it deserves.
 *
 * Two independent halves, and the whole point is that they stay independent:
 *
 *   THE COMBINER is exact and unconditional — every source supplies the whole
 *   of L, bytewise XOR, then the §7 partition, and NOTHING else. These specs
 *   try to falsify that: they pin the transformation against hand-computed
 *   fixtures, prove surplus is ignored, prove an all-zero result is accepted,
 *   prove equal-content sources are accepted, and grep the real source files
 *   for any KDF / hash / extractor / whitening / statistical gate that could
 *   have crept between combineSources() and partition().
 *
 *   THE SOURCE CLAIM is graded, and the grading lives in words. These specs
 *   pin the verbatim wording of both classes: the device path must never read
 *   as physically verified, and the external path must state that TruePad
 *   cannot verify physical randomness, must carry the §7 verdict EXACTLY, and
 *   must stay conditional — no "verified", "certified", "proven", "confirmed",
 *   "perfect secrecy achieved".
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
// The docs hard-wrap and quote; sentences are asserted verbatim modulo the
// wrap and the blockquote markers, and nothing else changes.
const flat = (s: string): string => s.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");

// A forbidden phrase is only a problem when it is ASSERTED. A sentence that
// exists precisely to forbid it — "TruePad does not call this physically
// proven randomness" — is the claim discipline working, not a violation. So
// the scan is sentence-scoped: a hit must sit in a sentence that also negates.
const NEGATION = /\bnever\b|\bnot\b|\bno\b|\bcannot\b|\bcan't\b|\bwithout\b|\bunverified\b|\bonly if\b|\bwould\b/i;

function assertedOverclaims(text: string, patterns: RegExp[]): string[] {
  const sentences = flat(text).split(/(?<=[.!?])\s+/);
  const offending: string[] = [];
  for (const sentence of sentences) {
    for (const pattern of patterns) {
      if (pattern.test(sentence) && !NEGATION.test(sentence)) {
        offending.push(sentence.trim());
        break;
      }
    }
  }
  return offending;
}

// The verbatim §7 verdict. Written out here rather than imported so a change
// to the engine's constant has to be made in two places on purpose.
const VERDICT = "Uniform if at least one declared source was uniform and independent of the others.";

let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}
function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) throw new Error(`expected ok:${op} but got ${res.kind}: ${res.message}`);
  if (res.op !== op) throw new Error(`expected op ${op} but got ${res.op}`);
  return res as Extract<EngineOk, { op: K }>;
}

type Source = { name: string; declaredOrigin: string; bytes: Uint8Array };
async function gen(vfs: Vfs, e: number, n: number, sources: Source[]): Promise<Extract<EngineOk, { op: "gen" }>> {
  return asOk(
    await send(vfs, {
      op: "gen",
      label: "ceremony",
      sources,
      encryptionBytes: e,
      authRecords: n,
      witnessClass: "browser-none"
    }),
    "gen"
  );
}

// A deterministic, reproducible byte stream — NOT random, so a fixture can be
// computed by hand and compared exactly.
function ramp(length: number, seed: number, step: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed + i * step) & 0xff;
  return out;
}

/* ==========================================================================
 * 1. The combiner: exact XOR, and provably nothing else.
 * ======================================================================== */

describe("the combiner is bytewise XOR of the full L, and nothing else", () => {
  it("(6, 11) known deterministic fixtures combine to exactly the hand-computed XOR", () => {
    const L = requiredSourceLength(4, 1); // 2*(4 + 32*1) = 72
    expect(L).toBe(72);
    const s1 = ramp(L, 0x00, 1);
    const s2 = ramp(L, 0x5a, 3);
    const s3 = ramp(L, 0xc3, 7);

    const expected = new Uint8Array(L);
    for (let i = 0; i < L; i += 1) expected[i] = s1[i] ^ s2[i] ^ s3[i];

    expect([...combineSources([s1, s2, s3], L)]).toEqual([...expected]);
    // Order cannot matter for XOR — if a conditioner existed, it almost
    // certainly would.
    expect([...combineSources([s3, s1, s2], L)]).toEqual([...expected]);
    // One source alone is that source, untouched: no whitening, no folding.
    expect([...combineSources([s1], L)]).toEqual([...s1.subarray(0, L)]);
  });

  it("(7) surplus bytes beyond L are never read and never change the result", () => {
    const L = requiredSourceLength(4, 1);
    const exact = ramp(L, 0x11, 5);
    const surplus = new Uint8Array(L + 4096);
    surplus.set(exact, 0);
    // Fill the tail with a value that would be obvious if it leaked in.
    surplus.fill(0xff, L);
    expect([...combineSources([surplus], L)]).toEqual([...exact]);
    expect([...combineSources([exact, surplus], L)]).toEqual(new Array(L).fill(0));
  });

  it("(4) every source must independently supply the complete L — no concatenation, no splitting", () => {
    const L = requiredSourceLength(4, 1);
    const full = ramp(L, 1, 1);
    const short = ramp(L - 1, 1, 1);
    // Two sources that TOGETHER hold 2L bytes still fail if either is short:
    // the model is n complete covers, never a partitioned contribution.
    expect(() => combineSources([full, short], L)).toThrow(/source 1 supplies/);
    expect(() => combineSources([short, full], L)).toThrow(/source 0 supplies/);
    expect(() => combineSources([], L)).toThrow(/at least one source/);
  });

  it("(3, 12) L = 2·(E + 32·N) and the partition is exactly [AB enc][AB auth][BA enc][BA auth]", () => {
    const E = 5;
    const N = 2;
    const L = requiredSourceLength(E, N);
    expect(L).toBe(2 * (E + 32 * N));

    // A marker stream: each byte equals its own index modulo 256, so a slice's
    // contents name the exact offsets of `combined` it came from.
    const combined = ramp(L, 0, 1);
    const p = partition(combined, E, N);
    expect([...p.abEncryption]).toEqual([...combined.subarray(0, E)]);
    expect([...p.abAuthentication]).toEqual([...combined.subarray(E, E + 32 * N)]);
    expect([...p.baEncryption]).toEqual([...combined.subarray(E + 32 * N, 2 * E + 32 * N)]);
    expect([...p.baAuthentication]).toEqual([...combined.subarray(2 * E + 32 * N, L)]);

    // Every combined byte lands in exactly one slice, once.
    const total = p.abEncryption.length + p.abAuthentication.length + p.baEncryption.length + p.baAuthentication.length;
    expect(total).toBe(L);
    // ...and the slices are COPIES, so zeroing one cannot disturb another.
    combined.fill(0);
    expect(p.abEncryption.some((b) => b !== 0)).toBe(true);
  });
});

/* ==========================================================================
 * 2. Content never conditions acceptance.
 * ======================================================================== */

describe("no content-dependent acceptance anywhere in the gen path", () => {
  it("(8) an all-zero combined result is accepted and produces a working pad", async () => {
    const vfs = new MemoryVfs();
    const same = ramp(requiredSourceLength(64, 4), 0x2b, 11);
    const reply = await gen(vfs, 64, 4, [
      { name: "a.bin", declaredOrigin: "operator asserted A", bytes: same.slice() },
      { name: "b.bin", declaredOrigin: "operator asserted B", bytes: same.slice() }
    ]);
    const secret = await vfs.readFile(`${reply.pair.pairId}/a-to-b/secret.bin`);
    expect(secret).not.toBeNull();
    expect((secret as Uint8Array).every((b) => b === 0)).toBe(true);
  });

  it("(9) sources holding identical bytes are NOT rejected by engine content inspection", async () => {
    const vfs = new MemoryVfs();
    const same = ramp(requiredSourceLength(64, 4), 0x77, 13);
    const reply = await gen(vfs, 64, 4, [
      { name: "one.bin", declaredOrigin: "op A", bytes: same.slice() },
      { name: "two.bin", declaredOrigin: "op B", bytes: same.slice() }
    ]);
    expect(reply.manifest.sources).toHaveLength(2);
    expect(reply.verdict).toBe(VERDICT);
  });

  it("(1) device generation goes through the platform CSPRNG, not Math.random or a fold", () => {
    const ui = read("src", "browser", "ui", "create-pair.ts");
    expect(ui).toContain("crypto.getRandomValues");
    expect(ui).not.toMatch(/Math\.random/);
    // The engine's pairId is likewise platform CSPRNG, never pad-derived.
    expect(read("src", "browser", "engine", "verbs.ts")).toContain("crypto.getRandomValues(new Uint8Array(16))");
  });
});

/* ==========================================================================
 * 3. The falsification grep: nothing between combineSources and partition.
 * ======================================================================== */

describe("(10) no KDF, hash, extractor, or conditioner exists on the source path", () => {
  const CONDITIONERS = [
    /\bsha-?(1|256|384|512)\b/i,
    /\bhkdf\b/i,
    /\bpbkdf/i,
    /\bscrypt\b/i,
    /\bargon2?\b/i,
    /\bblake[23]?\b/i,
    /crypto\.subtle/i,
    /\.digest\s*\(/i,
    /\bwhiten/i,
    /\bvon ?neumann\b/i,
    /\bchi-?squared?\b/i,
    /\bextractor\b/i
  ];

  it("src/core/partition2.ts is XOR + slicing only", () => {
    const src = read("src", "core", "partition2.ts");
    // Strip the block comments: the file DOCUMENTS that it has no extractor,
    // and that sentence must not fail its own test.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const pattern of CONDITIONERS) {
      expect(code, `partition2.ts must not reference ${pattern}`).not.toMatch(pattern);
    }
    // The only combining operator in the file is XOR-assign.
    expect(code).toContain("combined[i] ^= source[i]");
    expect(code).not.toMatch(/combined\[i\]\s*[+\-*/%|&]=/);
  });

  it("the browser gen verb calls combineSources then partition with nothing in between", () => {
    const src = read("src", "browser", "engine", "verbs.ts");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const start = code.indexOf("const combined = combineSources(");
    const end = code.indexOf("partition(combined,");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const between = code.slice(start, end).replace(/\s+/g, " ").trim();
    // Not merely "nothing conditioning" — the EXACT text, so any future
    // insertion between the XOR and the partition fails this test by
    // construction. The only plumbing allowed is selecting the byte arrays.
    expect(between).toBe(
      "const combined = combineSources( req.sources.map((s) => s.bytes), required ); let slices: ReturnType<typeof partition>; try { slices ="
    );
    for (const pattern of CONDITIONERS) {
      expect(between, `nothing conditioning may sit between combine and partition (${pattern})`).not.toMatch(pattern);
    }
  });

  it("the CLI gen verb does the same, so the two editions cannot drift", () => {
    const src = read("src", "cli", "v2", "truepad2.ts");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const start = code.indexOf("combineSources(");
    const end = code.indexOf("partition(combined");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const pattern of CONDITIONERS) {
      expect(code.slice(start, end)).not.toMatch(pattern);
    }
  });

  it("(23, 24) the browser introduces no network, telemetry, or backend on any path", () => {
    for (const file of [
      ["src", "browser", "ui", "create-pair.ts"],
      ["src", "browser", "ui", "source-claims.ts"],
      ["src", "browser", "engine", "verbs.ts"],
      ["src", "browser", "engine", "worker.ts"]
    ]) {
      const code = read(...file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${file.join("/")} must make no network call`).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource/
      );
      expect(code, `${file.join("/")} must carry no telemetry`).not.toMatch(/analytics|telemetry|gtag|sentry/i);
    }
  });
});

/* ==========================================================================
 * 4. The two source claims, in the exact words.
 * ======================================================================== */

describe("(16) the device-generated claim is computational and platform-scoped", () => {
  const OVERCLAIMS = [
    /truly random/i,
    /true random(ness)?/i,
    /verified true/i,
    /physical(ly)? random/i,
    /information-theoretically verified/i,
    /proven random/i,
    /perfect secrecy achieved/i
  ];

  it("names the CSPRNG and the assumption it rests on", () => {
    expect(CLAIMS.DEVICE_SHORT).toBe("TruePad uses your device's cryptographic random generator.");
    expect(CLAIMS.DEVICE_DETAIL).toContain("crypto.getRandomValues");
    expect(CLAIMS.DEVICE_DETAIL).toContain("cryptographically secure platform generator");
    expect(CLAIMS.DEVICE_DETAIL).toContain("computational and platform assumptions");
  });

  it("(2) explicitly refuses the physical / information-theoretic promotion", () => {
    expect(CLAIMS.DEVICE_DETAIL).toContain("does not call this physically proven randomness");
    expect(CLAIMS.DEVICE_DETAIL).toContain("does not promote it to an unconditional information-theoretic source claim");
    // And the short form a beginner reads makes no such claim either.
    for (const bad of OVERCLAIMS) {
      expect(CLAIMS.DEVICE_SHORT, `device copy must not read as ${bad}`).not.toMatch(bad);
    }
  });

  it("the persisted declaredOrigin for the device path is itself scoped", () => {
    const ui = read("src", "browser", "ui", "create-pair.ts");
    expect(ui).toContain("a computational CSPRNG source, not verified physical randomness");
  });
});

describe("(17, 18) the external ceremony states the combiner and refuses to verify", () => {
  it("the load-bearing sentence is present, verbatim", () => {
    expect(CLAIMS.CEREMONY_CANNOT_VERIFY).toBe("TruePad cannot determine whether a file is truly random.");
  });

  it("(6, 8) the combiner is stated exactly, and its conditional never dropped", () => {
    expect(CLAIMS.CEREMONY_COMBINER).toBe("TruePad combines every selected source byte-for-byte using XOR.");
    expect(CLAIMS.CEREMONY_CONDITIONAL).toBe(
      "If at least one source is actually uniform and independent of the others, the combined material is uniform."
    );
    // The guaranteeing source must also be SECRET.
    expect(CLAIMS.CEREMONY_SECRECY).toContain("must also be secret");
  });

  // The correction that matters most: the claim used to say material an
  // adversary can obtain "is not a source", which is FALSE. Such material may
  // be XORed in; it simply cannot be the one carrying the guarantee. These
  // pins hold the weaker true statement AND the two things that make it safe:
  // uniformity is severed from secrecy, and the permission carries its
  // independence proviso.
  it("secrecy is a separate requirement, and a known source may still be combined", () => {
    const secrecy = CLAIMS.CEREMONY_SECRECY;
    // The retracted absolute must not come back, in any phrasing.
    expect(secrecy).not.toMatch(/is not a source/i);
    expect(secrecy).not.toMatch(/cannot be combined|must not be combined|disqualif/i);
    // The permission, stated.
    expect(secrecy).toContain("may still be XORed in");
    expect(secrecy).toContain("cannot be the source that carries the guarantee");
    // Uniformity severed from secrecy — the one clause that does that work.
    expect(secrecy).toContain("however uniform it is");
    // ...and the proviso that makes the permission safe: an adversary-chosen
    // source is correlated, not a harmless extra input.
    expect(secrecy).toMatch(/never combine material an adversary supplied, chose, or could have influenced/i);
    // Non-factive: it must not presuppose that a secret source already exists.
    expect(secrecy).not.toMatch(/must remain secret/i);
  });

  it("the operator can actually evaluate the message-independence clause", () => {
    // A condition you cannot evaluate is not one you can honestly declare, so
    // the checkbox's hardest clause gets a plain-language gloss beside it.
    expect(CLAIMS.CEREMONY_MESSAGE_INDEPENDENCE).toContain(
      "Never derive source material from the messages you plan to send"
    );
    expect(CLAIMS.CEREMONY_MESSAGE_INDEPENDENCE).toMatch(/not independent of it/);
  });

  it("(7) the length rule says complete-cover, never concatenation", () => {
    const rule = CLAIMS.ceremonyLengthRule(1024);
    expect(rule).toContain("independently supply the full 1,024 bytes");
    expect(rule).toContain("never concatenated and never split between them");
    expect(rule).toContain("unused");
  });

  it("(9) the aliasing limitation is stated, not invented around", () => {
    expect(CLAIMS.CEREMONY_ALIASING).toContain("no");
    expect(CLAIMS.CEREMONY_ALIASING).toContain("filesystem identity");
    expect(CLAIMS.CEREMONY_ALIASING).toContain("will not inspect your source bytes");
  });

  it("(17) the created external pad carries the §7 verdict EXACTLY and stays conditional", async () => {
    const vfs = new MemoryVfs();
    const L = requiredSourceLength(64, 4);
    const reply = await gen(vfs, 64, 4, [
      { name: "geiger.bin", declaredOrigin: "operator asserted physical source", bytes: ramp(L + 99, 3, 17) }
    ]);
    // Verbatim, from the engine, character for character.
    expect(reply.verdict).toBe(VERDICT);
    expect(reply.manifest.verdict).toBe(VERDICT);
    // Surplus is reported unused, never silently spent.
    expect(reply.manifest.requiredSourceLength).toBe(L);
    expect(reply.manifest.sources[0].unusedBytes).toBe(99);

    expect(CLAIMS.EXTERNAL_SOURCE_LABEL).toBe("External material — operator declared");
    expect(CLAIMS.EXTERNAL_NOT_VERIFIED).toBe("TruePad did not verify that assumption.");
    expect(CLAIMS.EXTERNAL_CONDITIONAL).toMatch(/^If that source assumption is true, /);
    expect(CLAIMS.EXTERNAL_CONDITIONAL).toContain(
      "the pad material satisfies the information-theoretic randomness requirement of a one-time pad"
    );
  });

  // UNIFORMITY is not SECRECY. The frozen verdict claims the first; the second
  // needs four more hypotheses, and this constant carries them without ever
  // presupposing they hold.
  it("the created pad separates the uniformity verdict from the full secrecy premise", () => {
    const rest = CLAIMS.EXTERNAL_BEYOND_UNIFORMITY;
    // It names the verdict's scope rather than extending it.
    expect(rest).toContain("about uniformity only");
    // Subjunctive: no line in this panel may stop being conditional, and none
    // may presuppose that a guaranteeing source exists.
    expect(rest).toContain("would also require");
    expect(rest).not.toMatch(/the guaranteeing source/i);
    // The remaining hypotheses, each pinned.
    expect(rest).toContain("secret from the adversary");
    expect(rest).toContain("independent of the messages this pad will protect");
    expect(rest).toContain("in either direction");
    expect(rest).toContain("no other pad is ever derived from it");
    expect(rest).toContain("used exactly once");
    // Single use is guarantee C — machinery TruePad DOES enforce. Handing it to
    // the operator as an unmet condition would understate the product exactly
    // as badly as claiming the others would overstate it.
    expect(rest).toContain("TruePad's counters enforce that last condition within TruePad");
    expect(rest).toContain("a copy of the pad file made outside it is beyond them");
    // ...and it closes on a negation, like EXTERNAL_NOT_VERIFIED.
    expect(rest).toMatch(/TruePad established none of the rest/);
  });

  it("the uniformity pole and the secrecy premise are never fused", () => {
    // The frozen verdict and its mirror in the ceremony speak to uniformity
    // ONLY. An XOR's uniformity genuinely does not require secrecy or
    // independence from the plaintext; propagating either into these strings
    // would make them claim something the combiner does not establish.
    for (const uniformityOnly of [VERDICT, CLAIMS.CEREMONY_CONDITIONAL, CLAIMS.EXTERNAL_CONDITIONAL]) {
      expect(uniformityOnly, `${uniformityOnly} must not claim secrecy`).not.toMatch(/secret|secrecy/i);
      expect(uniformityOnly, `${uniformityOnly} must not claim message independence`).not.toMatch(/message|plaintext/i);
    }
    // And the converse: the secrecy premise must not be dropped from the
    // ceremony, or uniformity would silently read as secrecy.
    expect(CLAIMS.CEREMONY_SECRECY).toMatch(/secret from the adversary/);
    expect(CLAIMS.EXTERNAL_BEYOND_UNIFORMITY).toMatch(/secret from the adversary/);
  });

  it("(19) the operator declaration is a declaration, never a verification result", () => {
    expect(CLAIMS.OPERATOR_DECLARATION).toContain("TruePad cannot verify physical randomness");
    expect(CLAIMS.OPERATOR_DECLARATION).toContain("never previously used");
  });

  // The declaration must enumerate the FULL secrecy premise, not the uniformity
  // half. Each limb is pinned separately so dropping any one of them fails.
  it("the declaration carries every limb of the source premise", () => {
    const decl = CLAIMS.OPERATOR_DECLARATION;
    expect(decl).toContain("uniformly random");
    expect(decl).toContain("secret from the adversary");
    // Key-message independence — a hypothesis of the theorem in its own right,
    // and the limb that was missing before this closure.
    expect(decl).toContain("of the messages this pad will protect");
    // JOINT independence, not pairwise: S3 = S1 XOR S2 is independent of each
    // of S1 and S2 separately yet cancels the XOR to zero.
    expect(decl).toContain("independent of all the other selected sources taken together");
    // Source reuse, both directions in time.
    expect(decl).toContain("never previously used");
    expect(decl).toContain("never be used to make another pad");
    // Scoped to the SOURCE: end-to-end secrecy additionally needs delivery, so
    // this sentence must not read as the whole premise.
    expect(decl).toContain("about this pad's material");
    // It states NECESSITY, never a result TruePad obtained.
    expect(decl).toMatch(/^I understand that TruePad cannot verify/);
  });

  it("no claim string anywhere ASSERTS a verification, certification, or proof", () => {
    const FORBIDDEN = [
      /\bverified\b/i,
      /\bcertified\b/i,
      /\bproven\b/i,
      /\bconfirmed\b/i,
      /perfect secrecy achieved/i,
      /true otp verified/i,
      /information-theoretic security confirmed/i,
      /truly random\b/i
    ];
    for (const [name, value] of Object.entries(CLAIMS)) {
      if (typeof value !== "string") continue;
      expect(assertedOverclaims(value, FORBIDDEN), `${name} asserts an overclaim`).toEqual([]);
    }
    // And the negations really are there, not merely absent claims.
    expect(CLAIMS.DEVICE_DETAIL).toMatch(/does not call this physically proven randomness/);
    expect(CLAIMS.CEREMONY_CANNOT_VERIFY).toMatch(/cannot determine/);
    expect(CLAIMS.EXTERNAL_NOT_VERIFIED).toMatch(/did not verify/);
  });
});

/* ==========================================================================
 * 5. Delivery is the other half — and a different claim from a secure transfer.
 * ======================================================================== */

describe("(20) pad delivery distinguishes physical handoff from computational transfer", () => {
  it("keeps the essential warning on both paths", () => {
    expect(CLAIMS.DELIVERY_ESSENTIAL).toContain("read and forge");
    expect(CLAIMS.DELIVERY_ESSENTIAL).toContain("never email, upload, or sync it");
  });

  it("states the information-theoretic delivery requirement exactly", () => {
    expect(CLAIMS.DELIVERY_CEREMONY).toContain("end-to-end information-theoretic secrecy claim");
    expect(CLAIMS.DELIVERY_CEREMONY).toContain(
      "does not itself depend on computational encryption assumptions"
    );
    expect(CLAIMS.DELIVERY_CEREMONY).toContain("Physical handoff on removable media is the clearest ceremony");
  });

  it("names the channels that do NOT preserve it, and says why that is a different claim", () => {
    for (const channel of ["Email", "Dropbox", "Google Drive", "OneDrive", "cloud storage", "encrypted messengers"]) {
      expect(CLAIMS.DELIVERY_NOT_ITS).toContain(channel);
    }
    expect(CLAIMS.DELIVERY_NOT_ITS).toContain("different guarantee, not a weaker form of this one");
  });
});

/* ==========================================================================
 * 6. Store Format v2 stays frozen: a checkbox is not a persisted fact.
 * ======================================================================== */

describe("(13, 15) the store format is unchanged and carries no randomness claim flag", () => {
  // Every spelling of a self-certifying security verdict this project bans.
  const FLAG =
    /\btrueRandom\b|\binformationTheoretic\b|\bverifiedRandom\b|\bphysicallyRandom\b|\bitCapable\b|\bperfectSecrecy\b|\bshannonSecure\b|\bcertifiedEntropy\b/;

  it("no claim flag exists in the store, the protocol, the deployment classifier, or the spec", () => {
    for (const file of [
      ["src", "browser", "engine", "store.ts"],
      ["src", "browser", "engine", "protocol.ts"],
      ["src", "browser", "engine", "verbs.ts"],
      ["src", "cli", "v2", "store2.ts"],
      ["src", "cli", "v2", "truepad2.ts"],
      // The Shannon deployment classifier DERIVES, it never persists a verdict:
      // its source (comments aside) must carry none of these identifiers either.
      ["src", "claims", "shannon-deployment.ts"],
      ["docs", "FORMAT-V2.md"]
    ]) {
      // Strip block/line comments: the classifier's prose forbids these words by
      // naming them, which is not the same as defining a flag.
      const src = read(...file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src, `${file.join("/")} must carry no randomness/verdict claim flag`).not.toMatch(FLAG);
    }
  });

  it("a generated head.json carries exactly the frozen fields, sourceDeclarations included", async () => {
    const vfs = new MemoryVfs();
    const L = requiredSourceLength(32, 2);
    const reply = await gen(vfs, 32, 2, [
      { name: "s.bin", declaredOrigin: "operator asserted", bytes: ramp(L, 9, 19) }
    ]);
    const head = JSON.parse(new TextDecoder().decode((await vfs.readFile(`${reply.pair.pairId}/a-to-b/head.json`))!));
    expect(Object.keys(head).sort()).toEqual(
      ["authentication", "direction", "encryption", "formatVersion", "mode", "pairId", "recordPolicy", "rollback", "sourceDeclarations", "verification"].sort()
    );
    expect(head.formatVersion).toBe(2);
    expect(head.sourceDeclarations).toEqual([
      { name: "s.bin", declaredOrigin: "operator asserted", lengthBytes: L }
    ]);
    // Nothing pad-derived, and nothing claiming the material's physics (N14).
    expect(JSON.stringify(head)).not.toMatch(FLAG);
  });

  it("(13) the FORMAT-V2 §7 verdict sentence is unchanged", () => {
    expect(flat(read("docs", "FORMAT-V2.md"))).toContain(VERDICT);
  });
});

/* ==========================================================================
 * 7. The documentation says the same thing as the code.
 * ======================================================================== */

describe("the claim ledgers carry the two source classes", () => {
  it("PRODUCT-CLAIMS.md separates the source claim from the combiner claim", () => {
    const doc = flat(read("docs", "PRODUCT-CLAIMS.md"));
    expect(doc).toContain("The two source classes");
    expect(doc).toContain("computational / platform source assumption");
    expect(doc).toContain("information-theoretic *eligibility* only if");
    expect(doc).toContain("no KDF, no extractor, no hash conditioner");
    expect(doc).toContain(VERDICT);
    // And it is explicit that the checkbox is not a measurement.
    expect(doc).toContain("A checkbox is not a measurement");
    expect(doc).toContain("OPERATOR declaration and never a verification result");
  });

  it("PRODUCT-CLAIMS.md keeps the three guarantees apart", () => {
    const doc = flat(read("docs", "PRODUCT-CLAIMS.md"));
    expect(doc).toContain("B and C do not prove A's physical-randomness premise");
    expect(doc).toContain("strengthens neither the authentication construction nor the operational reuse-prevention machinery");
  });

  it("no doc still carries the retracted \"is not a source\" absolute", () => {
    for (const file of [["docs", "PRODUCT-CLAIMS.md"], ["docs", "BROWSER-SECURITY.md"], ["docs", "CEREMONY.md"], ["README.md"]]) {
      const doc = flat(read(...file));
      expect(doc, `${file.join("/")} must not say obtainable material is not a source`).not.toMatch(
        /is not a source|uniform.{0,4}but.{0,4}published source guarantees nothing/i
      );
    }
    // ...and the claim ledgers state the corrected, weaker truth.
    for (const file of [["docs", "PRODUCT-CLAIMS.md"], ["docs", "BROWSER-SECURITY.md"], ["docs", "CEREMONY.md"]]) {
      const doc = flat(read(...file));
      expect(doc, `${file.join("/")} states the permission`).toMatch(/may still be XORed in/);
      expect(doc, `${file.join("/")} separates secrecy from uniformity`).toMatch(/[Uu]niformity is not secrecy|separate requirement from uniformity/);
    }
  });

  it("the docs carry the full premise, message-independence included", () => {
    const pc = flat(read("docs", "PRODUCT-CLAIMS.md"));
    expect(pc).toContain("independent of the messages it protects");
    expect(pc).toContain("joint, not pairwise");
    // The declaration is quoted verbatim in all three ledgers.
    for (const file of [["docs", "PRODUCT-CLAIMS.md"], ["docs", "BROWSER-SECURITY.md"], ["docs", "CEREMONY.md"]]) {
      expect(flat(read(...file)), `${file.join("/")} quotes the declaration verbatim`).toContain(
        CLAIMS.OPERATOR_DECLARATION
      );
    }
    // ...and so is the sentence that keeps uniformity from reading as secrecy.
    for (const file of [["docs", "PRODUCT-CLAIMS.md"], ["docs", "BROWSER-SECURITY.md"], ["docs", "CEREMONY.md"]]) {
      expect(flat(read(...file)), `${file.join("/")} quotes the beyond-uniformity line`).toContain(
        CLAIMS.EXTERNAL_BEYOND_UNIFORMITY
      );
    }
  });

  it("BROWSER-SECURITY.md §6.1 carries both classes and the declaration", () => {
    const doc = flat(read("docs", "BROWSER-SECURITY.md"));
    expect(doc).toContain("The two source classes");
    expect(doc).toContain(CLAIMS.CEREMONY_CANNOT_VERIFY);
    expect(doc).toContain("declaration, not a verification result");
    expect(doc).toContain("no `trueRandom`,");
    // ...and the memory-hygiene claim is stated as hygiene, not erasure.
    expect(doc).toContain("hygiene, not erasure");
    expect(doc).toContain("NOT** erasure of secret bytes from process memory");
  });

  it("CEREMONY.md documents the browser ceremony as weaker than the CLI's", () => {
    const doc = flat(read("docs", "CEREMONY.md"));
    expect(doc).toContain("The Browser Edition source ceremony");
    expect(doc).toContain("cannot require");
    expect(doc).toContain(CLAIMS.OPERATOR_DECLARATION);
  });

  it("the docs never ASSERT a verified physical claim on either path", () => {
    const FORBIDDEN = [
      /perfect secrecy achieved/i,
      /true otp verified/i,
      /information-theoretic security confirmed/i,
      /verified true randomness/i,
      /physically proven randomness/i
    ];
    for (const file of [["docs", "PRODUCT-CLAIMS.md"], ["docs", "BROWSER-SECURITY.md"], ["docs", "CEREMONY.md"], ["README.md"]]) {
      expect(assertedOverclaims(read(...file), FORBIDDEN), `${file.join("/")} asserts an overclaim`).toEqual([]);
    }
  });
});
