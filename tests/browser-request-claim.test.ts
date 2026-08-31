import { describe, expect, it } from "vitest";

import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { EngineRefused } from "../src/browser/engine/store";
import {
  claimPath,
  claimRequestForPair,
  parseClaim,
  readRequestClaim,
  requireClaimedByPair
} from "../src/browser/engine/request-claim";
import {
  commitSealedHandoff,
  handoffPackagePath,
  loadCommittedSealedHandoff,
  markerPath,
  readHandoffState
} from "../src/browser/engine/handoff";
import { packageIdentity } from "../src/spt/sealed-package";
import { toBase64Url } from "../src/spt/bytes";
import { bytesToHex } from "../src/core/hex";
import { FaultVfs } from "./helpers/fault-vfs";

/* ============================================================================
 * ONE REQUEST → ONE PACKAGE, ACROSS PADS
 * ----------------------------------------------------------------------------
 * The defect this closes, in full:
 *
 *     Bob creates receive request R.  Alice confirms R.
 *     Alice seals pad P to R          → P/handoff.json exists.
 *     Alice later picks a FRESH pad Q, still holding her confirmation of R.
 *     Q/handoff.json is absent — the PAD gate has nothing to say about R.
 *     The spt-send:R lock was released when the first seal returned.
 *     → a second independent X-Wing package for the same R.
 *
 * The pad gate is keyed by pairId and protects the pad. It cannot see this,
 * because the pad is the thing being varied. Locks cannot see it either: mutual
 * exclusion is not one-shot-ness.
 *
 * CLAIMED IS NOT CONSUMED. Between the claim landing and that pad's handoff
 * committing, R is PERMANENTLY BOUND TO P — not spent, not consumed:
 *
 *     retry R → P   ALLOWED (the same attempt, resumed)
 *     retry R → Q   REFUSED (permanently, whatever P's handoff state is)
 * ========================================================================= */

const P = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const Q = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AT = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-31T09:30:00.000Z";
const enc = new TextEncoder();

const R = () => new Uint8Array(32).fill(0xa1);
const R2 = () => new Uint8Array(32).fill(0xb2);
const confirmValue = () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const bytesFor = (pad: string) => Uint8Array.from({ length: 1258 }, (_, i) => (i * 7 + pad.charCodeAt(0)) & 0xff);

async function sealedInput(pad: string, requestHash = R()) {
  const bytes = bytesFor(pad);
  return { packageBytes: bytes, requestHash, confirmValue: confirmValue(), packageIdentity: await packageIdentity(bytes) };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<EngineRefused> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof EngineRefused) return error;
    throw error;
  }
  throw new Error("expected a refusal, got success");
}

/* ---- the regression, end to end ------------------------------------------- */

describe("the cross-pad second package", () => {
  it("Alice cannot seal a fresh pad Q to a request already sealed with P", async () => {
    const vfs = new MemoryVfs();

    // Round one: R is bound to P, then P's handoff commits.
    await claimRequestForPair(vfs, R(), P, AT);
    await commitSealedHandoff(vfs, P, await sealedInput(P), AT);
    expect((await readHandoffState(vfs, P)).kind).toBe("sealed");

    // Later. Q is fresh: its own handoff state is absent, and it would sail
    // through every pad-side check.
    expect((await readHandoffState(vfs, Q)).kind).toBe("absent");

    // The request gate is what refuses.
    const refusal = await refusalOf(() => claimRequestForPair(vfs, R(), Q, LATER));
    expect(refusal.reason).toBe("request-claimed-elsewhere");
    expect(refusal.message).toMatch(/already bound to a different pad/);
    expect(refusal.message).toMatch(/two different confirmation/);

    // And a caller that skips the claim step cannot commit either, because the
    // storage layer requires the binding rather than trusting the order. Here
    // R *is* bound — to P — so the precise refusal names that, not absence.
    const direct = await refusalOf(async () => commitSealedHandoff(vfs, Q, await sealedInput(Q), AT));
    expect(direct.reason).toBe("request-claimed-elsewhere");
    expect((await readHandoffState(vfs, Q)).kind).toBe("absent");
    expect(await vfs.exists(handoffPackagePath(Q))).toBe(false);
  });

  it("a caller that claims R→Q by force still cannot commit against P's claim", async () => {
    // Belt and braces: even if the claim file were somehow made to name Q, the
    // commit checks the binding names THIS pair.
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    const refusal = await refusalOf(async () => commitSealedHandoff(vfs, Q, await sealedInput(Q), AT));
    expect(refusal.reason).toBe("request-claimed-elsewhere");
  });

  it("Q remains free for a DIFFERENT request — the binding is per request", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    await commitSealedHandoff(vfs, P, await sealedInput(P), AT);
    // A new request R2 may be bound to Q and sealed normally.
    await claimRequestForPair(vfs, R2(), Q, LATER);
    const marker = await commitSealedHandoff(vfs, Q, await sealedInput(Q, R2()), LATER);
    expect(marker.mode).toBe("sealed");
    expect(marker.requestHash).toBe(toBase64Url(R2()));
  });

  it("P remains bound to R even after P's handoff is dismissed", async () => {
    const { dismissSealedPayload } = await import("../src/browser/engine/handoff");
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    await commitSealedHandoff(vfs, P, await sealedInput(P), AT);
    await dismissSealedPayload(vfs, P);
    // Dismissal drops the payload; it does not unbind the request.
    expect((await readRequestClaim(vfs, R())).kind).toBe("claimed");
    expect((await refusalOf(() => claimRequestForPair(vfs, R(), Q, LATER))).reason).toBe("request-claimed-elsewhere");
  });
});

/* ---- claimed is not consumed ---------------------------------------------- */

describe("CLAIMED / BOUND is not consumed, and not spent", () => {
  it("retry R→P before any handoff is ALLOWED, and is the same binding", async () => {
    const vfs = new MemoryVfs();
    const first = await claimRequestForPair(vfs, R(), P, AT);
    expect((await readHandoffState(vfs, P)).kind).toBe("absent");

    // The attempt is resumed. This is the ONLY circumstance in which a new
    // encapsulation for R may occur at all.
    const second = await claimRequestForPair(vfs, R(), P, LATER);
    expect(second.pairId).toBe(P);
    // Not rewritten: `at` stays the time of the FIRST binding.
    expect(second.at).toBe(first.at);
    expect(second.at).toBe(AT);

    // ...and the resumed attempt can complete normally.
    const marker = await commitSealedHandoff(vfs, P, await sealedInput(P), LATER);
    expect(marker.mode).toBe("sealed");
  });

  it("retry R→Q before any handoff is REFUSED — a claim with no package still binds", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    // Nothing was sealed. P is completely untouched. R is still bound to P.
    expect((await readHandoffState(vfs, P)).kind).toBe("absent");
    expect((await refusalOf(() => claimRequestForPair(vfs, R(), Q, LATER))).reason).toBe("request-claimed-elsewhere");
  });

  it("a crash after the claim strands R on P but does NOT burn P", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    // The pad is untouched by the binding: no marker, no staging, nothing.
    expect((await readHandoffState(vfs, P)).kind).toBe("absent");
    expect(await vfs.exists(markerPath(P))).toBe(false);
    expect(await vfs.exists(handoffPackagePath(P))).toBe(false);
    // P is still a perfectly good pad — for this request.
    const marker = await commitSealedHandoff(vfs, P, await sealedInput(P), LATER);
    expect(marker.mode).toBe("sealed");
  });

  it("after P's handoff commits, no new encapsulation happens — only exact re-share", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    const input = await sealedInput(P);
    await commitSealedHandoff(vfs, P, input, AT);

    // Same request, same pad: the committed bytes come back, unchanged.
    const loaded = await loadCommittedSealedHandoff(vfs, P);
    expect(bytesToHex(loaded.packageBytes)).toBe(bytesToHex(input.packageBytes));
    // A second commit is refused by the pad gate before anything is written.
    expect((await refusalOf(async () => commitSealedHandoff(vfs, P, await sealedInput(P), LATER))).reason).toBe(
      "pad-already-sealed"
    );
  });
});

/* ---- the claim's own grammar ---------------------------------------------- */

describe("the claim parser refuses everything it should", () => {
  const good = { version: 1, requestHash: toBase64Url(R()), pairId: P, at: AT };
  const parse = (o: unknown) => parseClaim(enc.encode(JSON.stringify(o)), R());

  it("accepts a well-formed claim", () => {
    expect(parse(good).pairId).toBe(P);
  });

  const bad: Array<[string, unknown]> = [
    ["a non-object", [1]],
    ["null", null],
    ["the wrong version", { ...good, version: 2 }],
    ["a missing field", { version: 1, requestHash: good.requestHash, pairId: P }],
    ["an extra field", { ...good, extra: 1 }],
    ["an uppercase pairId", { ...good, pairId: P.toUpperCase() }],
    ["a short pairId", { ...good, pairId: "abc" }],
    ["a non-ISO timestamp", { ...good, at: "soon" }],
    ["padded base64url", { ...good, requestHash: `${good.requestHash}=` }],
    ["a hash of the wrong size", { ...good, requestHash: toBase64Url(new Uint8Array(31)) }],
    ["a claim for ANOTHER request", { ...good, requestHash: toBase64Url(R2()) }]
  ];
  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parse(value)).toThrow();
    });
  }

  it("refuses empty bytes and non-JSON", () => {
    expect(() => parseClaim(new Uint8Array(0), R())).toThrow(/empty/);
    expect(() => parseClaim(enc.encode("{"), R())).toThrow(/parse/);
  });

  it("a claim cannot be moved onto another request's path", async () => {
    // The record names its own request, so copying the file elsewhere is caught
    // rather than silently binding a request nobody bound.
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    const bytes = await vfs.readFile(claimPath(R()));
    await vfs.writeFileAtomic(claimPath(R2()), bytes!);
    const state = await readRequestClaim(vfs, R2());
    expect(state.kind).toBe("unreadable");
  });

  it("writes its fields in the frozen order", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    const raw = new TextDecoder().decode((await vfs.readFile(claimPath(R())))!);
    expect(raw.indexOf('"version"')).toBeLessThan(raw.indexOf('"requestHash"'));
    expect(raw.indexOf('"requestHash"')).toBeLessThan(raw.indexOf('"pairId"'));
    expect(raw.indexOf('"pairId"')).toBeLessThan(raw.indexOf('"at"'));
  });

  it("lives outside every pair directory", () => {
    // A per-pad location could not see the collision: the pad is what varies.
    expect(claimPath(R())).toMatch(/^spt\/claims\//);
    expect(claimPath(R())).not.toContain(P);
    expect(claimPath(R())).not.toContain(Q);
    // 32 bytes of hash, lowercase hex, one filename.
    expect(claimPath(R())).toBe(`spt/claims/${"a1".repeat(32)}.json`);
  });
});

/* ---- a torn claim fails closed FOR THE REQUEST ---------------------------- */

describe("an unreadable claim fails closed for the request, and does not burn the pad", () => {
  const corruptions: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["one byte", Uint8Array.from([0x7b])],
    ["truncated JSON", enc.encode('{"version":1,"requestHash":"')],
    ["valid JSON, wrong shape", enc.encode('{"hello":"world"}')]
  ];

  for (const [name, bytes] of corruptions) {
    it(`${name} reads as unreadable, never absent`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(claimPath(R()), bytes);
      expect((await readRequestClaim(vfs, R())).kind).toBe("unreadable");
    });

    it(`${name} refuses any claim and any commit for that request`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(claimPath(R()), bytes);
      expect((await refusalOf(() => claimRequestForPair(vfs, R(), P, AT))).reason).toBe("request-claim-unreadable");
      expect((await refusalOf(async () => commitSealedHandoff(vfs, P, await sealedInput(P), AT))).reason).toBe(
        "request-claim-unreadable"
      );
    });

    it(`${name} leaves the PAD usable for a different request`, async () => {
      // The request fails closed; the pad is not collateral damage.
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(claimPath(R()), bytes);
      await claimRequestForPair(vfs, R2(), P, AT);
      const marker = await commitSealedHandoff(vfs, P, await sealedInput(P, R2()), AT);
      expect(marker.mode).toBe("sealed");
    });

    it(`${name} is never auto-deleted or repaired`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(claimPath(R()), bytes);
      await readRequestClaim(vfs, R());
      await refusalOf(() => claimRequestForPair(vfs, R(), P, AT));
      const after = await vfs.readFile(claimPath(R()));
      expect(after).not.toBeNull();
      expect(bytesToHex(after!)).toBe(bytesToHex(bytes));
    });
  }

  it("a claim that cannot be READ is unreadable, not absent", async () => {
    const vfs = new FaultVfs(new MemoryVfs());
    await claimRequestForPair(vfs, R(), P, AT);
    vfs.failRead(claimPath(R()), 1);
    expect((await readRequestClaim(vfs, R())).kind).toBe("unreadable");
  });

  it("the refusal does not tell the operator to delete the record", async () => {
    const vfs = new MemoryVfs();
    await vfs.writeFileAtomic(claimPath(R()), new Uint8Array(1));
    const state = await readRequestClaim(vfs, R());
    expect(state.kind).toBe("unreadable");
    if (state.kind !== "unreadable") return;
    expect(state.message).toMatch(/refuses to seal anything to it/);
    expect(state.message).not.toMatch(/delete|remove|erase/i);
  });
});

/* ---- fault injection on the claim write ----------------------------------- */

for (const nonAtomic of [false, true]) {
  const backing = nonAtomic ? "the non-atomic fallback" : "an atomic replace backing";

  describe(`claim write faults on ${backing}`, () => {
    const make = () => new FaultVfs(new MemoryVfs(), { nonAtomic });

    it("a throw BEFORE the claim exists leaves the request unbound and retryable", async () => {
      const vfs = make();
      vfs.failWrite({ path: claimPath(R()), mode: "throw-before" });
      await expect(claimRequestForPair(vfs, R(), P, AT)).rejects.toThrow();
      expect((await readRequestClaim(vfs, R())).kind).toBe("absent");
      // Nothing was bound, so R may still go to Q — this is the case where that
      // is correct, and the only one.
      const claim = await claimRequestForPair(vfs, R(), Q, LATER);
      expect(claim.pairId).toBe(Q);
    });

    it("a torn claim fails closed for the request", async () => {
      const vfs = make();
      vfs.failWrite({ path: claimPath(R()), mode: nonAtomic ? "partial-then-throw" : "throw-before", bytes: 10 });
      const outcome = await claimRequestForPair(vfs, R(), P, AT).then(
        () => "ok" as const,
        (e) => e as Error
      );
      expect(outcome).not.toBe("ok");
      if (nonAtomic) {
        expect((outcome as EngineRefused).reason).toBe("request-claim-unreadable");
        expect((await readRequestClaim(vfs, R())).kind).toBe("unreadable");
        // Bound to something unreadable: neither pad may now be sealed to R.
        expect((await refusalOf(() => claimRequestForPair(vfs, R(), P, LATER))).reason).toBe("request-claim-unreadable");
        expect((await refusalOf(() => claimRequestForPair(vfs, R(), Q, LATER))).reason).toBe("request-claim-unreadable");
      } else {
        expect((await readRequestClaim(vfs, R())).kind).toBe("absent");
      }
    });

    it("a write that silently truncates is caught by the read-back", async () => {
      const vfs = make();
      vfs.failWrite({ path: claimPath(R()), mode: "silently-truncate", bytes: 12 });
      const refusal = await refusalOf(() => claimRequestForPair(vfs, R(), P, AT));
      expect(refusal.reason).toBe("request-claim-unreadable");
      expect(refusal.message).toMatch(/read back invalid/);
      expect((await readRequestClaim(vfs, R())).kind).toBe("unreadable");
    });

    it("a complete-but-unacknowledged claim write is a real binding", async () => {
      if (!nonAtomic) return;
      const vfs = make();
      vfs.failWrite({ path: claimPath(R()), mode: "complete-then-throw" });
      await refusalOf(() => claimRequestForPair(vfs, R(), P, AT));
      // The record landed and is valid: R really is bound to P, and the retry
      // to P succeeds while the retry to Q does not.
      const state = await readRequestClaim(vfs, R());
      expect(state.kind).toBe("claimed");
      if (state.kind !== "claimed") return;
      expect(state.claim.pairId).toBe(P);
      expect((await claimRequestForPair(vfs, R(), P, LATER)).pairId).toBe(P);
      expect((await refusalOf(() => claimRequestForPair(vfs, R(), Q, LATER))).reason).toBe("request-claimed-elsewhere");
    });
  });
}

/* ---- the storage layer enforces the order --------------------------------- */

describe("the frozen write order is structural, not a convention", () => {
  it("commitSealedHandoff refuses a request it was never given a binding for", async () => {
    const vfs = new MemoryVfs();
    const refusal = await refusalOf(async () => commitSealedHandoff(vfs, P, await sealedInput(P), AT));
    expect(refusal.reason).toBe("request-not-claimed");
    // Nothing staged, nothing committed.
    expect(await vfs.exists(handoffPackagePath(P))).toBe(false);
    expect((await readHandoffState(vfs, P)).kind).toBe("absent");
  });

  it("requireClaimedByPair is the check, and it is exact", async () => {
    const vfs = new MemoryVfs();
    await claimRequestForPair(vfs, R(), P, AT);
    await expect(requireClaimedByPair(vfs, R(), P)).resolves.toMatchObject({ pairId: P });
    expect((await refusalOf(() => requireClaimedByPair(vfs, R(), Q))).reason).toBe("request-claimed-elsewhere");
    expect((await refusalOf(() => requireClaimedByPair(vfs, R2(), P))).reason).toBe("request-not-claimed");
  });

  it("the PAD gate answers first, so a torn marker is never masked", async () => {
    // Existence is load-bearing: nothing may answer ahead of it.
    const vfs = new MemoryVfs();
    await vfs.writeFileAtomic(markerPath(P), new Uint8Array(2));
    const refusal = await refusalOf(async () => commitSealedHandoff(vfs, P, await sealedInput(P), AT));
    expect(refusal.reason).toBe("handoff-state-unreadable");
  });
});
