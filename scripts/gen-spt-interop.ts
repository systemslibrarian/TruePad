/* Generate the cross-language SPT interop corpus from the RELEASED TypeScript
 * implementation. Each case is a full derandomized seal — every byte reproducible
 * — plus the request body and decapsulation seed needed to open it. A second
 * implementation (Kotlin/Android) MUST: (a) reproduce `packageHex` byte-for-byte
 * from the same inputs (proves Android-seal == Browser-seal, so a Browser
 * receiver opens an Android package), and (b) open `packageHex` and recover
 * `payloadHex` (proves an Android receiver opens a Browser package).
 * Run: node scripts/gen-spt-interop.ts
 */
import { writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "../src/core/hex.ts";
import { generateKeyPairDerand } from "../src/spt/xwing-v1.ts";
import { encodeRequestBody } from "../src/spt/receive-request.ts";
import { sealPayloadV1, openPayloadV1 } from "../src/spt/crypto-v1.ts";

const enc = new TextEncoder();

type Case = { label: string; seed: string; eseed: string; requestId: string; payload: string };
const rep = (b: string, n: number) => b.repeat(n);
const CASES: Case[] = [
  {
    label: "vector-c",
    seed: "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c",
    eseed:
      "07121d28333e49545f6a75808b96a1acb7c2cdd8e3eef9040f1a25303b46515c" +
      "67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85909ba6b1bc",
    requestId: "031425364758697a8b9cadbecfe0f102",
    payload: "TruePad SPT vector C payload — opaque bytes.\n"
  },
  {
    label: "empty-payload",
    seed: rep("aa", 32),
    eseed: rep("bb", 64),
    requestId: rep("cc", 16),
    payload: ""
  },
  {
    label: "one-kib-payload",
    seed: rep("11", 32),
    eseed: rep("22", 64),
    requestId: rep("33", 16),
    payload: "P".repeat(1024)
  }
];

const out: { note: string; source: string; cases: unknown[] } = {
  note: "Released TypeScript SPT seal output. A second implementation must reproduce packageHex and open it to payloadHex.",
  source: "src/spt/crypto-v1.ts sealPayloadV1 (derandomized)",
  cases: []
};

for (const c of CASES) {
  const keys = generateKeyPairDerand(hexToBytes(c.seed)!);
  const body = encodeRequestBody(hexToBytes(c.requestId)!, keys.encapsulationKey);
  const payload = enc.encode(c.payload);
  const sealed = await sealPayloadV1(body, payload, { eseedForVectorsOnly: hexToBytes(c.eseed)! });
  // Self-check: the released opener must recover the payload from its own package.
  const opened = await openPayloadV1(sealed.packageBytes, body, keys.decapsulationSeed);
  if (!opened.ok) throw new Error(`${c.label}: TS could not open its own package: ${opened.reason}`);
  if (bytesToHex(opened.result.payload) !== bytesToHex(payload)) throw new Error(`${c.label}: TS open payload mismatch`);
  out.cases.push({
    label: c.label,
    // TEST ONLY — derandomization inputs, so a second implementation can
    // reproduce packageHex byte-for-byte. NEVER production material.
    eseedHex: c.eseed,
    requestBodyHex: bytesToHex(body),
    decapSeedHex: bytesToHex(keys.decapsulationSeed),
    payloadHex: bytesToHex(payload),
    packageHex: bytesToHex(sealed.packageBytes),
    confirmValueHex: bytesToHex(sealed.confirmValue),
    confirmationIndices: sealed.confirmationIndices
  });
}

writeFileSync("android/vectors/spt-interop.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote android/vectors/spt-interop.json — ${out.cases.length} cases`);
