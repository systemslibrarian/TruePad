import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/hex";
import { canonicalBytes, wcHash, wcTag, type CanonicalFields } from "../src/core/wc-one-time";
import { handle } from "../src/browser/engine/verbs";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";
import type { Vfs } from "../src/browser/engine/vfs";
import { NodeVfs } from "./helpers/node-vfs";

/* ============================================================================
 * CLI <-> browser interop — the critical proof (FORMAT-V2 §12, §14.1)
 * ----------------------------------------------------------------------------
 * The browser engine (src/browser/engine/*) and the operational CLI
 * (bin/truepad2.mjs) run the SAME frozen protocol and reuse the SAME src/core
 * crypto. This suite proves that is not merely a claim but a byte-for-byte fact
 * ON DISK: the browser store, written through a Node-fs Vfs, is the exact
 * FORMAT-V2 three-file store the actual CLI opens — and the reverse. A
 * browser-burned envelope opens in the CLI with the exact plaintext; a
 * CLI-burned envelope opens in the browser engine; the same pad material and
 * fields yield a byte-identical envelope from either side; and an adversarial
 * corpus draws the SAME typed refusal from both.
 *
 * The one node:fs boundary is tests/helpers/node-vfs.ts — test-only, so the
 * src/browser core-only layering invariant is untouched. The interop store
 * uses witnessClass "browser-none", which serialises to the CLI's
 * { witnessClass: "none" } byte-for-byte (BROWSER-SECURITY.md §4), so the CLI
 * reads it without a browser-only class it does not honour.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "truepad2-interop-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/* ---- CLI + engine drivers ------------------------------------------------- */

function cli(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

// The CLI prints a typed refusal as `refused: <type> — <message>` on stderr
// (exit 2). Pull the type so it can be compared to the engine's `reason`.
function cliRefusalReason(stderr: string): string | null {
  const m = /refused:\s+(\S+)/.exec(stderr);
  return m ? m[1] : null;
}

let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}

function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) {
    const reason = (res as { reason?: string }).reason ?? "";
    throw new Error(`expected ok:${op} but got ${res.kind} ${reason}: ${res.message}`);
  }
  if (res.op !== op) {
    throw new Error(`expected op ${op} but got ${res.op}`);
  }
  return res as Extract<EngineOk, { op: K }>;
}

function expectRefused(res: EngineResponse): string {
  if (res.ok) {
    throw new Error(`expected refused but got ok:${res.op}`);
  }
  if (res.kind !== "refused") {
    throw new Error(`expected refused but got error: ${res.message}`);
  }
  return res.reason;
}

type GenOpts = { e: number; n: number; recordBytes?: number; maxAuthLookahead?: number };

// A browser `gen` over a Node-fs Vfs → REAL FORMAT-V2 files under root/<pairId>.
async function browserGen(vfs: NodeVfs, o: GenOpts): Promise<string> {
  const required = 2 * (o.e + 32 * o.n);
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label: "interop",
      sources: [
        {
          name: "interop-source.bin",
          declaredOrigin: "interop test material, operator-asserted (randomBytes)",
          bytes: new Uint8Array(randomBytes(required))
        }
      ],
      encryptionBytes: o.e,
      authRecords: o.n,
      // browser-none serialises to the CLI's { witnessClass: "none" }, so the
      // resulting head.json is byte-identical to a CLI-written one and needs no
      // separate witness store.
      witnessClass: "browser-none",
      recordBytes: o.recordBytes,
      maxAuthLookahead: o.maxAuthLookahead
    }),
    "gen"
  );
  return res.pair.pairId;
}

let cliSrcSeq = 0;
function cliGen(dir: string, e: number, n: number, ...extra: string[]): { code: number; stdout: string; stderr: string } {
  const src = join(tmp, `cli-src-${cliSrcSeq++}.bin`);
  writeFileSync(src, randomBytes(2 * (e + 32 * n)));
  return cli("gen", dir, "--source", src, "--encryption-bytes", String(e), "--auth-records", String(n), ...extra);
}

let copySeq = 0;
function freshDir(prefix: string): string {
  return join(tmp, `${prefix}-${copySeq++}`);
}

/* ============================================================================
 * 1. Browser-generated store + browser envelope open in the actual CLI.
 * ========================================================================= */

describe("interop: a browser store and envelope open in the actual truepad2 CLI", () => {
  it("the CLI reads a browser-generated store and opens a browser-burned envelope byte-for-byte", async () => {
    const root = mkdtempSync(join(tmp, "b2c-root-"));
    const vfs = new NodeVfs(root);
    const pairId = await browserGen(vfs, { e: 64, n: 8 });
    const pairDir = join(root, pairId);

    // The on-disk head.json is the CLI's exact compact canonical JSON.
    const headText = readFileSync(join(pairDir, "a-to-b", "head.json"), "utf8");
    expect(headText).not.toContain("\n");
    expect(headText.startsWith(`{"formatVersion":2,"pairId":"${pairId}","direction":"A->B",`)).toBe(true);
    expect(headText).toContain('"rollback":{"witnessClass":"none","config":{}}');

    // (a) the CLI can READ a browser-generated store (status meters agree).
    const status = cli("status", pairDir);
    expect(status.code).toBe(0);
    const meters = JSON.parse(status.stdout);
    // The CLI's status machine line carries the pairId inside each direction block.
    expect(meters["A->B"].pairId).toBe(pairId);
    expect(meters["B->A"].pairId).toBe(pairId);
    expect(meters["A->B"]).toMatchObject({ direction: "A->B", maxRemainingSends: 8 });
    expect(meters["A->B"].authentication).toMatchObject({ nextSequence: 0, remainingRecords: 8 });

    // Courier Bob a pre-burn copy (the CLI opens in a copy, per the courier model).
    const bobDir = freshDir("b2c-bob");
    cpSync(pairDir, bobDir, { recursive: true });

    // (b) a browser-burned envelope opens in the CLI with the EXACT plaintext.
    const message = "attack at dawn — interop 2026";
    const burn = asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: utf8.encode(message) }), "burn");
    const opened = cli("open", bobDir, "--as", "B", burn.envelope);
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe(message); // O6 releases the plaintext byte-exact, no trailing newline

    // The browser advanced ITS copy; the CLI's status of that copy agrees.
    const after = JSON.parse(cli("status", pairDir).stdout);
    expect(after["A->B"].authentication.nextSequence).toBe(1);
    // Bob's copy self-retired on his open; a replay is refused there.
    const replay = cli("open", bobDir, "--as", "B", burn.envelope);
    expect(replay.code).toBe(2);
    expect(cliRefusalReason(replay.stderr)).toBe("sequence-retired");
  });
});

/* ============================================================================
 * 2. CLI-generated store + CLI envelope open in the browser engine.
 * ========================================================================= */

describe("interop: a CLI store and envelope open in the browser engine", () => {
  it("the browser engine reads a CLI-generated store and opens a CLI-burned envelope byte-for-byte", async () => {
    const cliDir = freshDir("c2b-cli");
    const gen = cliGen(cliDir, 64, 8, "--origin", "interop fixture, randomBytes");
    expect(gen.code).toBe(0);
    const pairId = JSON.parse(gen.stdout).pairId;
    expect(pairId).toMatch(/^[0-9a-f]{32}$/);

    // Bob's browser copy: the CLI store placed under a Vfs root as <pairId>/…
    // (a pre-burn copy — the browser opens in a copy, per the courier model).
    const root = mkdtempSync(join(tmp, "c2b-root-"));
    cpSync(cliDir, join(root, pairId), { recursive: true });
    const bobVfs = new NodeVfs(root);

    // Sanity: the browser engine reads the CLI store's meters.
    const st = asOk(await send(bobVfs, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].authentication.nextSequence).toBe(0);

    const message = "meet me at noon — interop";
    const burn = cli("burn", cliDir, "--as", "A", message);
    expect(burn.code).toBe(0);
    const envelope = burn.stdout.trim();

    const open = asOk(await send(bobVfs, { op: "open", pairId, as: "B", envelope }), "open");
    expect(fromUtf8.decode(open.plaintext)).toBe(message);
    expect(open.meters.meters["A->B"].authentication.nextSequence).toBe(1);
  });
});

/* ============================================================================
 * 3. Envelope byte-identity: same pad + same fields => identical envelope.
 *    Both sides reuse src/core, so the wire bytes MUST be equal — assert it.
 * ========================================================================= */

describe("interop: the browser and the CLI emit a byte-identical envelope", () => {
  it("burning the same message over two identical copies yields the same wire line", async () => {
    const root = mkdtempSync(join(tmp, "ident-root-"));
    const vfs = new NodeVfs(root);
    const pairId = await browserGen(vfs, { e: 64, n: 4 });
    const browserPairDir = join(root, pairId);

    // A byte-identical pre-burn CLI copy of the very same store.
    const cliCopy = freshDir("ident-cli");
    cpSync(browserPairDir, cliCopy, { recursive: true });

    const message = "one identical record";
    const browserEnvelope = asOk(await send(vfs, { op: "burn", pairId, as: "A", plaintext: utf8.encode(message) }), "burn").envelope;
    const cliBurn = cli("burn", cliCopy, "--as", "A", message);
    expect(cliBurn.code).toBe(0);

    // The strongest interop assertion: identical bytes, tag included.
    expect(browserEnvelope).toBe(cliBurn.stdout.trim());
  });
});

/* ============================================================================
 * 4. The frozen FORMAT-V2 §11 wc-one-time-v1 vectors, through the browser
 *    build's own src/core — the same modules the CLI links, so a match here
 *    plus §3 above pins both to the frozen construction.
 * ========================================================================= */

describe("interop: the browser build reproduces the frozen §11 vectors", () => {
  it("canonicalBytes, wcHash and wcTag match the §11 full-tag vector", () => {
    const fields: CanonicalFields = {
      pairId: hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf") as Uint8Array,
      direction: "A->B",
      sequence: 7,
      startOffset: 4096,
      ciphertext: hexToBytes("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f") as Uint8Array
    };
    const key = hexToBytes("000102030405060708090a0b0c0d0e0f") as Uint8Array;
    const mask = hexToBytes("101112131415161718191a1b1c1d1e1f") as Uint8Array;
    expect(bytesToHex(canonicalBytes(fields))).toBe(
      "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
        "0200000000000000070000000000000000100000000000002000000000000000" +
        "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
    );
    expect(bytesToHex(wcHash(key, fields))).toBe("4ba90e0dd06af1497c869bc334117ac6");
    expect(bytesToHex(wcTag(key, mask, fields))).toBe("5bb81c1ec47fe75e649f81d8280c64d9");
  });
});

/* ============================================================================
 * 5. Adversarial corpus: the browser engine and the CLI give the SAME typed
 *    refusal for each hostile input. Each fixture runs on a FRESH copy of the
 *    base store for each engine, so a mutating refusal (auth-failed reserves a
 *    durable attempt) never leaks into the next case.
 * ========================================================================= */

const flipNibble = (hex: string): string => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

describe("interop: browser and CLI agree on every typed refusal", () => {
  let variablePairId: string;
  let variableBaseDir: string;
  let fixedPairId: string;
  let fixedBaseDir: string;
  let lookaheadPairId: string;
  let lookaheadBaseDir: string;
  let validEnvelope: string; // a genuine A->B seq-0 envelope for the variable store

  beforeAll(async () => {
    // Base stores are generated ONCE by the browser (browser-none, so CLI-
    // readable), left pre-burn, and copied per fixture.
    const vRoot = mkdtempSync(join(tmp, "adv-var-"));
    const vVfs = new NodeVfs(vRoot);
    variablePairId = await browserGen(vVfs, { e: 256, n: 8 });
    variableBaseDir = join(vRoot, variablePairId);

    const fRoot = mkdtempSync(join(tmp, "adv-fixed-"));
    fixedPairId = await browserGen(new NodeVfs(fRoot), { e: 1024, n: 8, recordBytes: 64 });
    fixedBaseDir = join(fRoot, fixedPairId);

    const lRoot = mkdtempSync(join(tmp, "adv-look-"));
    lookaheadPairId = await browserGen(new NodeVfs(lRoot), { e: 256, n: 8, maxAuthLookahead: 2 });
    lookaheadBaseDir = join(lRoot, lookaheadPairId);

    // A valid seq-0 envelope, burned on a throwaway copy so the base stays pre-burn.
    const sRoot = mkdtempSync(join(tmp, "adv-sender-"));
    cpSync(variableBaseDir, join(sRoot, variablePairId), { recursive: true });
    const sVfs = new NodeVfs(sRoot);
    validEnvelope = asOk(await send(sVfs, { op: "burn", pairId: variablePairId, as: "A", plaintext: utf8.encode("valid record") }), "burn").envelope;
  });

  // Copy the base store into a fresh browser Vfs root AND a fresh CLI pair dir;
  // optionally advance both receivers by one legit open (to set up a replay);
  // then assert the adversarial open draws the SAME typed refusal from each.
  async function sameRefusal(baseDir: string, pairId: string, input: string, expected: string, preOpen = false): Promise<void> {
    const root = mkdtempSync(join(tmp, "adv-root-"));
    cpSync(baseDir, join(root, pairId), { recursive: true });
    const vfs = new NodeVfs(root);
    const cliDir = freshDir("adv-clidir");
    cpSync(baseDir, cliDir, { recursive: true });

    if (preOpen) {
      asOk(await send(vfs, { op: "open", pairId, as: "B", envelope: input }), "open");
      const first = cli("open", cliDir, "--as", "B", input);
      expect(first.code).toBe(0);
    }

    const browserReason = expectRefused(await send(vfs, { op: "open", pairId, as: "B", envelope: input }));
    const r = cli("open", cliDir, "--as", "B", input);
    expect(r.code).toBe(2);
    const cliReason = cliRefusalReason(r.stderr);

    expect(browserReason).toBe(expected);
    expect(cliReason).toBe(expected);
  }

  it("duplicate-key -> malformed-envelope", async () => {
    // A second "sequence" key: JSON.parse collapses it, the strict lexical scan
    // does not — both engines refuse before any parse-object check.
    const input = validEnvelope.replace('"sequence":0', '"sequence":0,"sequence":0');
    await sameRefusal(variableBaseDir, variablePairId, input, "malformed-envelope");
  });

  it("unicode-escaped-key -> malformed-envelope", async () => {
    const input = validEnvelope.replace('"pairId"', '"\\u0070airId"');
    await sameRefusal(variableBaseDir, variablePairId, input, "malformed-envelope");
  });

  it("wrong-pair -> wrong-pair", async () => {
    const v = JSON.parse(validEnvelope);
    const input = JSON.stringify({ ...v, pairId: flipNibble(v.pairId) });
    await sameRefusal(variableBaseDir, variablePairId, input, "wrong-pair");
  });

  it("wrong-direction -> wrong-direction", async () => {
    const v = JSON.parse(validEnvelope);
    const input = JSON.stringify({ ...v, direction: "B->A" });
    await sameRefusal(variableBaseDir, variablePairId, input, "wrong-direction");
  });

  it("wrong-tag -> auth-failed (a mutating refusal; a fresh copy per engine)", async () => {
    const v = JSON.parse(validEnvelope);
    const input = JSON.stringify({ ...v, tag: flipNibble(v.tag) });
    await sameRefusal(variableBaseDir, variablePairId, input, "auth-failed");
  });

  it("replay -> sequence-retired (open once, then again)", async () => {
    await sameRefusal(variableBaseDir, variablePairId, validEnvelope, "sequence-retired", true);
  });

  it("oversize -> oversize-ciphertext", async () => {
    const input = JSON.stringify({
      formatVersion: 2,
      pairId: variablePairId,
      direction: "A->B",
      sequence: 0,
      startOffset: 0,
      ciphertextLength: 1048577,
      ciphertext: "00",
      tag: "0".repeat(32)
    });
    await sameRefusal(variableBaseDir, variablePairId, input, "oversize-ciphertext");
  });

  it("v1-envelope -> envelope-v1", async () => {
    const input = JSON.stringify({ label: "PAD-TEST-AB", startOffset: 0, consumed: 5, payload: "deadbeef" });
    await sameRefusal(variableBaseDir, variablePairId, input, "envelope-v1");
  });

  it("fixed-size-mismatch -> record-size-mismatch (fixed store, wrong ciphertext length)", async () => {
    const input = JSON.stringify({
      formatVersion: 2,
      pairId: fixedPairId,
      direction: "A->B",
      sequence: 0,
      startOffset: 0,
      ciphertextLength: 16,
      ciphertext: "00".repeat(16),
      tag: "0".repeat(32)
    });
    await sameRefusal(fixedBaseDir, fixedPairId, input, "record-size-mismatch");
  });

  it("sequence-out-of-window -> sequence-out-of-window (maxAuthLookahead 2, sequence 5)", async () => {
    const input = JSON.stringify({
      formatVersion: 2,
      pairId: lookaheadPairId,
      direction: "A->B",
      sequence: 5,
      startOffset: 0,
      ciphertextLength: 8,
      ciphertext: "00".repeat(8),
      tag: "0".repeat(32)
    });
    await sameRefusal(lookaheadBaseDir, lookaheadPairId, input, "sequence-out-of-window");
  });
});
