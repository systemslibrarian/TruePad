/* ============================================================================
 * Android interoperability vector generator — RUNS AGAINST THE RELEASED v2.0.0
 * ----------------------------------------------------------------------------
 * DO NOT RUN THIS FILE IN PLACE. It is executed by tools/regenerate-vectors.sh,
 * which checks tag v2.0.0 out into a THROWAWAY DETACHED WORKTREE, copies this
 * file in beside the released src/, runs it, and removes the worktree again.
 * Nothing it does can touch master, the tag, or the release commit.
 *
 * It imports the RELEASED TypeScript directly (node type-stripping) and writes
 * the vectors the Kotlin port must reproduce byte-for-byte into android/vectors/.
 * Nothing here re-implements protocol logic: every value is produced by the
 * released code itself, so a Kotlin match is agreement with WHAT SHIPS, not with
 * a transcription of it. That is the whole reason the generator exists rather
 * than a hand-written fixture table.
 *
 * Determinism: the released engine draws a pairId from crypto.getRandomValues
 * and stamps timestamps from Date, so both are stubbed below and the transcript
 * is reproducible. NOTHING pad-bearing is stubbed — source material is supplied
 * explicitly, exactly as a real operator supplies it (§7).
 *
 *   regenerate:  android/tools/regenerate-vectors.sh
 *   verify:      android/tools/regenerate-vectors.sh --check
 * ========================================================================= */

import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { argv } from "node:process";

/* ---- determinism stubs, installed BEFORE the engine is imported ----------- */

const FIXED_PAIR_ID_BYTES = Uint8Array.from(
  "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4".match(/../g).map((h) => parseInt(h, 16))
);
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
let pairIdDraws = 0;
globalThis.crypto.getRandomValues = (arr) => {
  if (arr.length === 16) {
    pairIdDraws += 1;
    arr.set(FIXED_PAIR_ID_BYTES);
    return arr;
  }
  return realGetRandomValues(arr);
};

const FIXED_NOW = "2026-09-01T00:00:00.000Z";
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }
}
globalThis.Date = FrozenDate;

/* ---- released modules ------------------------------------------------------ */

const { encodeEnvelope2, decodeEnvelope2 } = await import("../src/core/envelope2.ts");
const { encodeCompactEnvelope2, decodeCompactEnvelope2, decodeEnvelopeTransport2, toBase64Url } = await import(
  "../src/core/compact-envelope2.ts"
);
const { bytesToHex, hexToBytes } = await import("../src/core/hex.ts");
const { buildFrame, parseFrame, frameCapacity } = await import("../src/core/frame2.ts");
const { combineSources, partition, authRecordAt, requiredSourceLength } = await import("../src/core/partition2.ts");
const { MemoryVfs } = await import("../src/browser/engine/vfs.ts");
const { handle } = await import("../src/browser/engine/verbs.ts");
const { packContainer } = await import("../src/browser/engine/courier-format.ts");

const dec = new TextDecoder();
const hex = (s) => hexToBytes(s);
const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (seed + i * 31 + ((i * i) % 251)) & 0xff);

let idSeq = 1;
const send = async (vfs, req) => handle(vfs, { ...req, id: idSeq++ });
function ok(res, op) {
  if (!res.ok) throw new Error(`${op} refused: ${res.reason ?? ""} ${res.message}`);
  return res;
}

/* ---- 1. compact transport (TP2) -------------------------------------------- */

const COMPACT_ENCODE_CASES = [
  { name: "typical", pairId: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", direction: "A->B", sequence: 7, startOffset: 4096, ciphertextHex: "404142434445464748494a4b4c4d4e4f", tagHex: "5bb81c1ec47fe75e649f81d8280c64d9" },
  { name: "genesis-empty", pairId: "00112233445566778899aabbccddeeff", direction: "B->A", sequence: 0, startOffset: 0, ciphertextHex: "", tagHex: "00".repeat(16) },
  { name: "multibyte-varints", pairId: "ffeeddccbbaa99887766554433221100", direction: "A->B", sequence: 128, startOffset: 1048575, ciphertextHex: "de".repeat(200), tagHex: "ff".repeat(16) },
  { name: "max-safe-counters", pairId: "0123456789abcdef0123456789abcdef", direction: "B->A", sequence: 9007199254740991, startOffset: 9007199254740991, ciphertextHex: "00", tagHex: "0f".repeat(16) },
  { name: "single-byte-ct", pairId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", direction: "A->B", sequence: 1, startOffset: 1, ciphertextHex: "7f", tagHex: "01".repeat(16) },
];

const compactEncode = COMPACT_ENCODE_CASES.map((c) => {
  const env = {
    pairId: c.pairId,
    direction: c.direction,
    sequence: c.sequence,
    startOffset: c.startOffset,
    ciphertextLength: c.ciphertextHex.length / 2,
    ciphertext: hex(c.ciphertextHex),
    tag: hex(c.tagHex),
  };
  return { name: c.name, input: { ...c, ciphertextLength: env.ciphertextLength }, compact: encodeCompactEnvelope2(env), json: encodeEnvelope2(env) };
});

// A hostile decode corpus. Every expectation below is whatever the RELEASED
// decoder actually returns — never an assumption about what it should return.
const goodCompact = compactEncode[0].compact;
const goodPayload = goodCompact.slice(4);
const rawGood = Uint8Array.from(atob(goodPayload.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (goodPayload.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
const mutate = (fn) => {
  const b = rawGood.slice();
  fn(b);
  return "TP2:" + toBase64Url(b);
};

const COMPACT_DECODE_CORPUS = [
  { name: "valid", text: goodCompact },
  { name: "no-prefix", text: goodPayload },
  { name: "empty-payload", text: "TP2:" },
  { name: "padded-base64", text: "TP2:AQKgoaKjpKWmp6ipqqusra6vAAeAIAQBAgMEAAAAAAAAAAAAAAAAAAAAAA==" },
  { name: "std-base64-alphabet", text: "TP2:AQKgoaKjpKWmp6ipqqusra+vAAeAIAQBAgMEAAAAAAAAAAAAAAAAAAAAAA" },
  { name: "non-canonical-tail", text: "TP2:" + goodPayload.slice(0, -1) + (goodPayload.slice(-1) === "B" ? "C" : "B") },
  { name: "bad-transport-version", text: mutate((b) => (b[0] = 0x02)) },
  { name: "envelope-v1-byte", text: mutate((b) => (b[1] = 0x01)) },
  { name: "bad-format-version", text: mutate((b) => (b[1] = 0x03)) },
  { name: "bad-direction-byte", text: mutate((b) => (b[18] = 0x02)) },
  { name: "truncated-header", text: "TP2:" + toBase64Url(rawGood.slice(0, 1)) },
  { name: "truncated-in-pairid", text: "TP2:" + toBase64Url(rawGood.slice(0, 10)) },
  { name: "truncated-body", text: "TP2:" + toBase64Url(rawGood.slice(0, rawGood.length - 4)) },
  { name: "trailing-bytes", text: "TP2:" + toBase64Url(Uint8Array.from([...rawGood, 0x00])) },
  { name: "whitespace-inside", text: "TP2:" + goodPayload.slice(0, 4) + " " + goodPayload.slice(4) },
  { name: "leading-trailing-space", text: "  " + goodCompact + "  " },
];
// Non-minimal varint: rebuild a header whose `sequence` is spelled `80 00`.
{
  const b = Array.from(rawGood);
  // header = [ver, fmt, 16 pairId, dir] then varints; case 0 has sequence 7 at index 19.
  const head = b.slice(0, 19);
  const tail = b.slice(20); // drop the single-byte sequence 0x07
  COMPACT_DECODE_CORPUS.push({ name: "non-minimal-varint", text: "TP2:" + toBase64Url(Uint8Array.from([...head, 0x80, 0x00, ...tail])) });
}

const compactDecode = COMPACT_DECODE_CORPUS.map((c) => {
  const r = decodeCompactEnvelope2(c.text);
  return { name: c.name, text: c.text, ok: r.ok, reason: r.ok ? null : r.reason };
});

const transportDoor = [
  { name: "json-through-door", text: compactEncode[0].json },
  { name: "compact-through-door", text: compactEncode[0].compact },
  { name: "garbage-through-door", text: "not json at all" },
  { name: "tp2-garbage-never-falls-through", text: "TP2:!!!" },
].map((c) => {
  const r = decodeEnvelopeTransport2(c.text);
  return { name: c.name, text: c.text, ok: r.ok, reason: r.ok ? null : r.reason };
});

/* ---- 2. the hostile §6.2 JSON corpus --------------------------------------- */

const BASE = encodeEnvelope2({
  pairId: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
  direction: "A->B",
  sequence: 0,
  startOffset: 0,
  ciphertextLength: 4,
  ciphertext: hex("deadbeef"),
  tag: hex("00".repeat(16)),
});

const JSON_CORPUS = [
  { name: "valid", text: BASE },
  { name: "not-json", text: "{" },
  { name: "not-object", text: "[1,2,3]" },
  { name: "v1-signature", text: '{"label":"x","ciphertext":"00"}' },
  { name: "missing-key", text: BASE.replace(',"tag":"' + "00".repeat(16) + '"', "") },
  { name: "extra-key", text: BASE.slice(0, -1) + ',"extra":1}' },
  { name: "duplicate-key", text: BASE.slice(0, -1) + ',"tag":"' + "11".repeat(16) + '"}' },
  { name: "escaped-name", text: BASE.replace('"tag"', '"\\u0074ag"') },
  { name: "escaped-value", text: BASE.replace('"A->B"', '"A-\\u003eB"') },
  { name: "formatVersion-2.0", text: BASE.replace('"formatVersion":2', '"formatVersion":2.0') },
  { name: "sequence-leading-zero", text: BASE.replace('"sequence":0', '"sequence":00') },
  { name: "sequence-exponent", text: BASE.replace('"sequence":0', '"sequence":0e0') },
  { name: "sequence-negative", text: BASE.replace('"sequence":0', '"sequence":-1') },
  { name: "uppercase-pairid", text: BASE.replace("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", "A0A1A2A3A4A5A6A7A8A9AAABACADAEAF") },
  { name: "bad-direction", text: BASE.replace('"A->B"', '"A→B"') },
  { name: "odd-hex-ciphertext", text: BASE.replace('"ciphertext":"deadbeef"', '"ciphertext":"deadbee"') },
  { name: "length-disagrees", text: BASE.replace('"ciphertextLength":4', '"ciphertextLength":3') },
  { name: "oversize-ciphertext", text: BASE.replace('"ciphertextLength":4', '"ciphertextLength":1048577') },
  { name: "short-tag", text: BASE.replace('"tag":"' + "00".repeat(16) + '"', '"tag":"' + "00".repeat(15) + '"') },
  { name: "unsafe-sequence", text: BASE.replace('"sequence":0', '"sequence":9007199254740992') },
].map((c) => {
  const r = decodeEnvelope2(c.text);
  return { name: c.name, text: c.text, ok: r.ok, reason: r.ok ? null : r.reason };
});

/* ---- 3. frame (§16) --------------------------------------------------------- */

const frames = [
  { recordBytes: 32, plaintextHex: "" },
  { recordBytes: 32, plaintextHex: "00" },
  { recordBytes: 32, plaintextHex: "48656c6c6f" },
  { recordBytes: 48, plaintextHex: "ff".repeat(44) }, // exactly F-4
  { recordBytes: 64, plaintextHex: bytesToHex(bytes(17, 3)) },
].map((c) => {
  const f = buildFrame(hex(c.plaintextHex), c.recordBytes);
  const back = parseFrame(f);
  return { ...c, capacity: frameCapacity(c.recordBytes), frameHex: bytesToHex(f), parsedHex: back === null ? null : bytesToHex(back) };
});

const frameRejects = [
  { name: "prefix-past-capacity", frameHex: bytesToHex(Uint8Array.from([0xff, 0xff, 0xff, 0x7f, ...new Uint8Array(28)])) },
  { name: "prefix-one-past", frameHex: bytesToHex(Uint8Array.from([29, 0, 0, 0, ...new Uint8Array(28)])) },
  { name: "prefix-exactly-capacity", frameHex: bytesToHex(Uint8Array.from([28, 0, 0, 0, ...new Uint8Array(28)])) },
  { name: "high-bit-u32", frameHex: bytesToHex(Uint8Array.from([0x00, 0x00, 0x00, 0x80, ...new Uint8Array(28)])) },
].map((c) => {
  const back = parseFrame(hex(c.frameHex));
  return { ...c, parsedHex: back === null ? null : bytesToHex(back) };
});

/* ---- 4. partition (§7) ------------------------------------------------------ */

const partitionCases = [
  { capacity: 64, capacityRecords: 3, seeds: [1] },
  { capacity: 32, capacityRecords: 2, seeds: [5, 9, 200] },
  // Two identical sources XOR to all-zero. That is a legitimate draw, and the
  // released partition neither inspects nor refuses it (§7).
  { capacity: 16, capacityRecords: 1, seeds: [0, 0] },
  // A source LONGER than required: the surplus is never read.
  { capacity: 16, capacityRecords: 1, seeds: [42], extra: 37 },
].map((spec) => {
  const need = requiredSourceLength(spec.capacity, spec.capacityRecords);
  const c = {
    capacity: spec.capacity,
    capacityRecords: spec.capacityRecords,
    sourcesHex: spec.seeds.map((seed) => bytesToHex(bytes(need + (spec.extra ?? 0), seed))),
  };
  return c;
}).map((c) => {
  const required = requiredSourceLength(c.capacity, c.capacityRecords);
  const combined = combineSources(c.sourcesHex.map(hex), required);
  const p = partition(combined, c.capacity, c.capacityRecords);
  const records = [];
  for (let s = 0; s < c.capacityRecords; s += 1) {
    const { key, mask } = authRecordAt(p.abAuthentication, s);
    records.push({ sequence: s, keyHex: bytesToHex(key), maskHex: bytesToHex(mask) });
  }
  return {
    ...c,
    requiredSourceLength: required,
    combinedHex: bytesToHex(combined),
    abEncryptionHex: bytesToHex(p.abEncryption),
    abAuthenticationHex: bytesToHex(p.abAuthentication),
    baEncryptionHex: bytesToHex(p.baEncryption),
    baAuthenticationHex: bytesToHex(p.baAuthentication),
    abAuthRecords: records,
  };
});

/* ---- 5. the engine trace: gen -> burn -> export, then import -> open -------- */

async function engineTrace({ recordBytes, label }) {
  pairIdDraws = 0;
  const alice = new MemoryVfs();
  const bob = new MemoryVfs();
  const capacity = 512;
  const capacityRecords = 8;
  const required = requiredSourceLength(capacity, capacityRecords);
  const sources = [
    { name: "die-rolls.bin", declaredOrigin: "physical dice, declared by operator", bytes: bytes(required, 11) },
    { name: "coin-flips.bin", declaredOrigin: "coin flips, declared by operator", bytes: bytes(required, 137) },
  ];

  const gen = ok(
    await send(alice, {
      op: "gen",
      label,
      sources: sources.map((s) => ({ ...s, bytes: s.bytes.slice() })),
      encryptionBytes: capacity,
      authRecords: capacityRecords,
      ...(recordBytes === undefined ? {} : { recordBytes }),
      witnessClass: "browser-local-witness",
    }),
    "gen"
  );
  const pairId = gen.pair.pairId;

  const readAll = (vfs, paths) =>
    Promise.all(paths.map(async (p) => ({ path: p, text: dec.decode(await vfs.readFile(p)) })));

  const headPaths = [`${pairId}/a-to-b/head.json`, `${pairId}/b-to-a/head.json`];
  const journalPaths = [`${pairId}/a-to-b/journal.log`, `${pairId}/b-to-a/journal.log`];
  const genHeads = await readAll(alice, headPaths);
  const genJournals = await readAll(alice, journalPaths);
  const genWitness = dec.decode(await alice.readFile(`witness/${pairId}.log`));
  const genSecretAB = bytesToHex(await alice.readFile(`${pairId}/a-to-b/secret.bin`));
  const genSecretBA = bytesToHex(await alice.readFile(`${pairId}/b-to-a/secret.bin`));

  // Courier the pad to Bob BEFORE any burn, as a real handoff does.
  const exported = ok(await send(alice, { op: "export-pair", pairId }), "export-pair");
  const containerText = dec.decode(exported.container);
  ok(await send(bob, { op: "import-pair", label: "from alice", container: exported.container.slice(), witnessClass: "browser-local-witness" }), "import-pair");

  // Alice burns three messages; Bob opens the 1st and the 3rd (the 2nd is lost,
  // so the 3rd exercises the skip accounting).
  const plaintexts = ["hello", "second message", "the third one, a bit longer"].map((s) => new TextEncoder().encode(s));
  const burns = [];
  for (const pt of plaintexts) {
    const r = ok(await send(alice, { op: "burn", pairId, as: "A", plaintext: pt.slice() }), "burn");
    burns.push({ plaintextUtf8: dec.decode(pt), envelope: r.envelope, consumed: r.consumed });
  }
  const afterBurnHeads = await readAll(alice, headPaths);
  const afterBurnWitness = dec.decode(await alice.readFile(`witness/${pairId}.log`));

  const opens = [];
  // 1. Open the first record cleanly.
  {
    const r = ok(await send(bob, { op: "open", pairId, as: "B", envelope: burns[0].envelope }), "open");
    opens.push({ envelopeIndex: 0, plaintextUtf8: dec.decode(r.plaintext), skipped: r.skipped });
  }
  // 2. A tampered tag on the THIRD record, while it is still live: one durable
  //    attempt is reserved and the failure is persisted, but NO pad material is
  //    consumed and the high-waters do not move.
  const tampered = JSON.parse(burns[2].envelope);
  tampered.tag = tampered.tag.slice(0, -2) + (tampered.tag.endsWith("00") ? "01" : "00");
  const forged = await send(bob, { op: "open", pairId, as: "B", envelope: JSON.stringify(tampered) });
  const afterForgeHeads = await readAll(bob, headPaths);
  const afterForgeWitness = dec.decode(await bob.readFile(`witness/${pairId}.log`));
  // 3. The genuine third record still opens — the second is lost, so this
  //    exercises the skip accounting.
  {
    const r = ok(await send(bob, { op: "open", pairId, as: "B", envelope: burns[2].envelope }), "open");
    opens.push({ envelopeIndex: 2, plaintextUtf8: dec.decode(r.plaintext), skipped: r.skipped });
  }
  // 4. The first envelope again: retired, never re-openable.
  const replay = await send(bob, { op: "open", pairId, as: "B", envelope: burns[0].envelope });
  // 5. The second envelope, whose material this copy skipped and destroyed unused.
  const skippedReplay = await send(bob, { op: "open", pairId, as: "B", envelope: burns[1].envelope });

  const afterOpenHeads = await readAll(bob, headPaths);
  const afterOpenJournals = await readAll(bob, journalPaths);
  const afterOpenWitness = dec.decode(await bob.readFile(`witness/${pairId}.log`));
  const bobPairJson = dec.decode(await bob.readFile(`${pairId}/pair.json`));
  const alicePairJson = dec.decode(await alice.readFile(`${pairId}/pair.json`));

  // Bob imported this pad, so he may never pass it on.
  const bobExport = await send(bob, { op: "export-pair", pairId });

  return {
    label,
    recordBytes: recordBytes ?? null,
    pairId,
    pairIdDraws,
    capacity,
    capacityRecords,
    requiredSourceLength: required,
    sources: sources.map((s) => ({ name: s.name, declaredOrigin: s.declaredOrigin, bytesHex: bytesToHex(s.bytes) })),
    genHeads,
    genJournals,
    genWitness,
    genSecretABHex: genSecretAB,
    genSecretBAHex: genSecretBA,
    alicePairJson,
    bobPairJson,
    containerText,
    burns,
    afterBurnHeads,
    afterBurnWitness,
    opens,
    replayRefusal: replay.ok ? null : replay.reason,
    skippedReplayRefusal: skippedReplay.ok ? null : skippedReplay.reason,
    forgedRefusal: forged.ok ? null : forged.reason,
    forgedEnvelope: JSON.stringify(tampered),
    afterForgeHeads,
    afterForgeWitness,
    afterOpenHeads,
    afterOpenJournals,
    afterOpenWitness,
    bobExportRefusal: bobExport.ok ? null : bobExport.reason,
  };
}

/* ---- 6. courier container --------------------------------------------------- */

const containerVector = (() => {
  const files = [
    { path: "a-to-b/head.json", bytes: new TextEncoder().encode('{"formatVersion":2}') },
    { path: "a-to-b/secret.bin", bytes: bytes(5, 200) },
    { path: "a-to-b/journal.log", bytes: new TextEncoder().encode("{}\n") },
  ];
  return {
    pairId: "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4",
    files: files.map((f) => ({ path: f.path, bytesHex: bytesToHex(f.bytes) })),
    containerText: dec.decode(packContainer("5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4", files)),
  };
})();

/* ---- emit -------------------------------------------------------------------- */

const outDir = argv[2];
if (!outDir) throw new Error("usage: node <worktree>/_gen/generate-vectors.mjs <android/vectors dir>");
mkdirSync(outDir, { recursive: true });

const NOTE = "GENERATED from the released TruePad v2.0.0 (tag v2.0.0, commit 240d7f0) by android/tools/generate-vectors.mjs (run it via android/tools/regenerate-vectors.sh). Every value is the released implementation's own output. The Kotlin port must reproduce these byte-for-byte.";

const emit = (name, doc) => {
  writeFileSync(`${outDir}/${name}`, JSON.stringify({ note: NOTE, ...doc }, null, 2) + "\n");
  console.log(`wrote ${name}`);
};

/* ---- 0. the two fixtures the preserved branch already carried ---------------
 * wc-one-time-v1.json is the VERBATIM stdout of the released
 * `node spec/reference/vectors.mjs` — the §11 frozen vectors, emitted by the
 * authority that defines them. envelope-encode.json is regenerated here in its
 * existing shape. Both are reproduced so `--check` covers every file in
 * android/vectors/ and no fixture sits outside the gate.
 * ------------------------------------------------------------------------- */

const specVectors = execFileSync(process.execPath, ["spec/reference/vectors.mjs"], {
  cwd: new URL("..", import.meta.url).pathname,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
writeFileSync(`${outDir}/wc-one-time-v1.json`, specVectors);
console.log("wrote wc-one-time-v1.json");

writeFileSync(
  `${outDir}/envelope-encode.json`,
  JSON.stringify(
    {
      note: "byte-exact wire output of src/core encodeEnvelope2; the Kotlin encoder must match",
      cases: [
        {
          pairId: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
          direction: "A->B",
          sequence: 7,
          startOffset: 4096,
          ciphertextHex: "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
          tagHex: "5bb81c1ec47fe75e649f81d8280c64d9",
        },
        {
          pairId: "00112233445566778899aabbccddeeff",
          direction: "B->A",
          sequence: 0,
          startOffset: 0,
          ciphertextHex: "",
          tagHex: "00".repeat(16),
        },
      ].map((c) => {
        const input = { ...c, ciphertextLength: c.ciphertextHex.length / 2 };
        const { ciphertextHex, tagHex, ...rest } = input;
        return {
          input: {
            pairId: input.pairId,
            direction: input.direction,
            sequence: input.sequence,
            startOffset: input.startOffset,
            ciphertextLength: input.ciphertextLength,
            ciphertextHex,
            tagHex,
          },
          wire: encodeEnvelope2({
            pairId: input.pairId,
            direction: input.direction,
            sequence: input.sequence,
            startOffset: input.startOffset,
            ciphertextLength: input.ciphertextLength,
            ciphertext: hex(ciphertextHex),
            tag: hex(tagHex),
          }),
        };
      }),
    },
    null,
    2
  ) + "\n"
);
console.log("wrote envelope-encode.json");

emit("compact-envelope-v1.json", { prefix: "TP2:", transportVersion: 1, encode: compactEncode, decode: compactDecode, transportDoor });
emit("envelope-refusals.json", { corpus: JSON_CORPUS });
emit("frame-v2.json", { build: frames, parseRejects: frameRejects });
emit("partition-v2.json", { cases: partitionCases });
emit("courier-container.json", containerVector);
emit("engine-trace.json", {
  variable: await engineTrace({ recordBytes: undefined, label: "variable-record pad" }),
  fixed: await engineTrace({ recordBytes: 64, label: "fixed-record pad" }),
});

/* ---- 7. head.json property ORDER under out-of-order auth failures -----------
 * JavaScript emits integer-like object keys in ascending NUMERIC order, not
 * insertion order. perSequenceAttempts is the one map in head.json whose keys
 * the traffic decides, so a receiver that fails authentication on record 5
 * before record 2 must still write {"2":..,"5":..}. This scenario produces that
 * head from the RELEASED engine so the Kotlin serializer can be held to it.
 * ------------------------------------------------------------------------- */

async function keyOrderTrace() {
  const alice = new MemoryVfs();
  const bob = new MemoryVfs();
  const capacity = 4096;
  const capacityRecords = 24;
  const required = requiredSourceLength(capacity, capacityRecords);
  ok(
    await send(alice, {
      op: "gen",
      label: "key order",
      sources: [{ name: "s.bin", declaredOrigin: "declared", bytes: bytes(required, 77) }],
      encryptionBytes: capacity,
      authRecords: capacityRecords,
      witnessClass: "browser-local-witness",
    }),
    "gen"
  );
  const pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4";
  const exported = ok(await send(alice, { op: "export-pair", pairId }), "export");
  ok(await send(bob, { op: "import-pair", label: "bob", container: exported.container.slice(), witnessClass: "browser-local-witness" }), "import");

  const envelopes = [];
  for (let i = 0; i < 20; i += 1) {
    const r = ok(await send(alice, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode(`m${i}`) }), "burn");
    envelopes.push(r.envelope);
  }
  // Fail authentication on a deliberately unsorted set of live sequences, so
  // insertion order and numeric order disagree in every way that matters:
  // two-digit before one-digit, and descending.
  const order = [12, 5, 19, 3, 11, 2, 10, 1];
  const refusals = [];
  for (const seq of order) {
    const env = JSON.parse(envelopes[seq]);
    env.tag = env.tag.slice(0, -2) + (env.tag.endsWith("00") ? "01" : "00");
    const r = await send(bob, { op: "open", pairId, as: "B", envelope: JSON.stringify(env) });
    refusals.push({ sequence: seq, reason: r.ok ? null : r.reason });
  }
  const headText = dec.decode(await bob.readFile(`${pairId}/a-to-b/head.json`));
  return {
    pairId,
    capacity,
    capacityRecords,
    sourceSeed: 77,
    requiredSourceLength: required,
    plaintexts: envelopes.map((_, i) => `m${i}`),
    failureOrder: order,
    refusals,
    headText,
    perSequenceAttemptsSubstring: headText.slice(headText.indexOf('"perSequenceAttempts"')),
    journalText: dec.decode(await bob.readFile(`${pairId}/a-to-b/journal.log`)),
  };
}

emit("head-key-order.json", await keyOrderTrace());
