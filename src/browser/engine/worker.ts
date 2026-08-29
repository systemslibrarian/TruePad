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
 *
 * This is also the ownership boundary for secret-bearing REQUEST buffers. The
 * UI transfers them, so by the time they arrive the page's copies are already
 * detached and these are the only ones left; the worker zeroes them once the
 * verb has returned, on the success and failure paths alike. That is in-memory
 * hygiene and nothing more — it does not prove a garbage-collected copy is
 * gone, that the browser's internals forgot the bytes, or that physical RAM
 * was erased. It never touches the operator's file on disk: `File.arrayBuffer()`
 * hands out a fresh buffer, not a view of the file.
 * ========================================================================= */

import type { EngineRequest, EngineResponse } from "./protocol.ts";
import { OpfsVfs } from "./opfs-vfs.ts";
import { handle } from "./verbs.ts";

// One store per worker, rooted at the OPFS root.
const vfs = new OpfsVfs();

// The plaintext an open releases and the packed courier container an export
// returns are large buffers we are done with; transfer them so the UI takes
// ownership without a copy (and, for the container, so the worker's copy is
// detached). Nothing else in a response references those buffers afterwards.
function collectTransfers(response: EngineResponse): Transferable[] {
  if (response.ok && response.op === "open") {
    return [response.plaintext.buffer as ArrayBuffer];
  }
  if (response.ok && response.op === "export-pair") {
    return [response.container.buffer as ArrayBuffer];
  }
  return [];
}

// The request buffers that carry secret material: gen's declared sources and
// import-pair's packed courier container. Everything else on a request is
// operational metadata. Zeroing is best-effort — a detached or frozen buffer
// simply throws and is skipped.
function secretRequestBuffers(request: EngineRequest): Uint8Array[] {
  if (request.op === "gen") return request.sources.map((s) => s.bytes);
  if (request.op === "import-pair") return [request.container];
  if (request.op === "burn") return [request.plaintext];
  return [];
}

function wipe(buffers: Uint8Array[]): void {
  for (const buffer of buffers) {
    try {
      buffer.fill(0);
    } catch {
      /* already detached or non-writable — nothing to do */
    }
  }
}

self.onmessage = async (event: MessageEvent<EngineRequest>): Promise<void> => {
  const request = event.data;
  const secrets = secretRequestBuffers(request);
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
  } finally {
    // After handle() has returned or thrown — never before, so nothing is
    // wiped while a verb still needs it.
    wipe(secrets);
  }
  self.postMessage(response, collectTransfers(response));
};
