/* ============================================================================
 * TruePad Browser Edition — the courier container format (worker-side)
 * ----------------------------------------------------------------------------
 * A pair's store IS the pad. The courier step packs the exact FORMAT-V2 store
 * files into ONE self-describing byte container the peer can import, and unpacks
 * one on import. This runs entirely INSIDE the worker (§4): no pad material is
 * ever base64-stringified or assembled into a large JSON object on the UI
 * thread. Export returns the container as one transferred buffer; import
 * receives the operator-selected bytes transferred in, and parses them here.
 *
 * The container is a small JSON envelope with base64 file bodies. base64 is the
 * on-container encoding only; across the RPC the bytes stay raw and transferred.
 * ========================================================================= */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CONTAINER_TAG = "truepad2-pair-bundle";

export type CourierFile = { path: string; bytes: Uint8Array };

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Pack the store files into the container bytes. Called only in the worker.
export function packContainer(pairId: string, files: CourierFile[]): Uint8Array {
  const doc = {
    format: CONTAINER_TAG,
    version: 1,
    pairId,
    files: files.map((f) => ({ path: f.path, bytesB64: bytesToB64(f.bytes) }))
  };
  return enc.encode(JSON.stringify(doc, null, 2));
}

export type UnpackResult =
  | { ok: true; pairId: string; files: CourierFile[] }
  | { ok: false; message: string };

// Parse and structurally validate a container. Called only in the worker, on
// bytes transferred in from the operator-selected file. Deeper validation
// (exact file set, headers, reconciliation, pairId agreement) is the importer's
// transactional job — this just turns bytes into a typed, well-formed shape or a
// clear refusal, and never lets a malformed container reach the store.
export function unpackContainer(bytes: Uint8Array): UnpackResult {
  let doc: unknown;
  try {
    doc = JSON.parse(dec.decode(bytes));
  } catch {
    return { ok: false, message: "This file is not valid JSON — it is not a TruePad pad bundle." };
  }
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, message: "This file is not a TruePad pad bundle." };
  }
  const rec = doc as Record<string, unknown>;
  if (rec.format !== CONTAINER_TAG) {
    return { ok: false, message: "This file is not a TruePad pad bundle (wrong format tag)." };
  }
  if (typeof rec.pairId !== "string") {
    return { ok: false, message: "Bundle is missing its pairId." };
  }
  if (!Array.isArray(rec.files)) {
    return { ok: false, message: "Bundle is missing its files." };
  }
  const files: CourierFile[] = [];
  for (const entry of rec.files) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "Bundle contains a malformed file entry." };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || typeof e.bytesB64 !== "string") {
      return { ok: false, message: "Bundle contains a malformed file entry." };
    }
    let fileBytes: Uint8Array;
    try {
      fileBytes = b64ToBytes(e.bytesB64);
    } catch {
      return { ok: false, message: `Bundle file ${JSON.stringify(e.path)} is not valid base64.` };
    }
    files.push({ path: e.path, bytes: fileBytes });
  }
  return { ok: true, pairId: rec.pairId, files };
}
