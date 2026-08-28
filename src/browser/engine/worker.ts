/* ============================================================================
 * TruePad Browser Edition — the engine Web Worker entry
 * ----------------------------------------------------------------------------
 * The security boundary. The crypto engine and the entire OPFS store — pad
 * material, Wegman–Carter keys K and masks R, the secret body, the journal,
 * the witness, the tombstone — live ONLY here. The UI thread talks to this
 * worker exclusively through the narrow RPC of protocol.ts. What crosses back
 * is exactly what the frozen protocol lets leave the store: wire-public
 * envelopes, non-secret meters/status, the plaintext a successful open
 * releases, and — only on an explicit export — the pad material the operator
 * chose to courier. Never a stray pad byte, key, mask, or pad-derived value.
 *
 * Every request carries an id; the reply carries the same id. Everything is
 * caught: a typed refusal becomes a structured { ok:false, kind:"refused" },
 * anything else a { ok:false, kind:"error" } with only its message — never a
 * stack that could carry secret context into the UI thread's logs.
 * ========================================================================= */

import type { EngineRequest, EngineResponse } from "./protocol.ts";
import { OpfsVfs } from "./opfs-vfs.ts";
import { handle } from "./verbs.ts";

// One store per worker, rooted at the OPFS root.
const vfs = new OpfsVfs();

// The plaintext an open releases and the pad bytes an export bundles are large
// buffers we are done with; transfer them so the UI takes ownership without a
// copy. Nothing else in a response references those buffers afterwards.
function collectTransfers(response: EngineResponse): Transferable[] {
  if (response.ok && response.op === "open") {
    return [response.plaintext.buffer as ArrayBuffer];
  }
  if (response.ok && response.op === "export-pair") {
    return response.bundle.files.map((file) => file.bytes.buffer as ArrayBuffer);
  }
  return [];
}

self.onmessage = async (event: MessageEvent<EngineRequest>): Promise<void> => {
  const request = event.data;
  let response: EngineResponse;
  try {
    response = await handle(vfs, request);
  } catch (error) {
    // handle() already catches everything, but never let a throw escape the
    // worker: reply with a message-only error carrying the request's id.
    response = {
      id: request.id,
      op: request.op,
      ok: false,
      kind: "error",
      message: (error as Error).message
    };
  }
  self.postMessage(response, collectTransfers(response));
};
