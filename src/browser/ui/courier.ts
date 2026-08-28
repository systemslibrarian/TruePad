/* ============================================================================
 * TruePad 2 Browser Edition — the courier step (export / import a pad)
 * ----------------------------------------------------------------------------
 * A pair's store IS the pad. Exporting it hands the operator the secret
 * material to carry to the peer OUT OF BAND — the one place secrets leave the
 * worker deliberately, at the operator's request, never an automatic upload.
 * These helpers package a PairBundle into a single file the peer can import,
 * and this file frames that consequence in the strongest terms the brief asks
 * for. The bytes stay raw across the RPC; base64 is only the on-file container.
 * ========================================================================= */

import { h, icon } from "./dom.ts";
import { callout, saveBytesButton, copyButton } from "./components.ts";
import type { Ctx } from "./context.ts";
import type { PairBundle } from "../engine/protocol.ts";

const BUNDLE_TAG = "truepad2-pair-bundle";

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
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function packBundle(bundle: PairBundle): Uint8Array {
  const doc = {
    format: BUNDLE_TAG,
    version: 1,
    pairId: bundle.pairId,
    files: bundle.files.map((f) => ({ path: f.path, bytesB64: bytesToB64(f.bytes) }))
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

export function unpackBundle(bytes: Uint8Array): PairBundle {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This file is not valid JSON — it is not a TruePad pad bundle.");
  }
  if (typeof doc !== "object" || doc === null) throw new Error("This file is not a TruePad pad bundle.");
  const rec = doc as Record<string, unknown>;
  if (rec.format !== BUNDLE_TAG) throw new Error("This file is not a TruePad pad bundle (wrong format tag).");
  if (typeof rec.pairId !== "string") throw new Error("Bundle is missing its pairId.");
  if (!Array.isArray(rec.files)) throw new Error("Bundle is missing its files.");
  const files = rec.files.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || typeof e.bytesB64 !== "string") {
      throw new Error("Bundle contains a malformed file entry.");
    }
    return { path: e.path, bytes: b64ToBytes(e.bytesB64) };
  });
  return { pairId: rec.pairId, files };
}

function suggestedFilename(pairId: string): string {
  return `truepad2-pair-${pairId.slice(0, 12)}.pad.json`;
}

// Reusable export affordance for the dashboard and the create verdict.
export function exportPanel(ctx: Ctx, pairId: string): HTMLElement {
  const container = h("div", { class: "stack" });
  let packed: Uint8Array | null = null;

  const output = h("div", { class: "stack" });

  const prepare = h(
    "button",
    { class: "btn", type: "button", on: { click: onPrepare } },
    icon("download"),
    h("span", { text: "Prepare courier bundle" })
  );

  async function onPrepare(): Promise<void> {
    prepare.setAttribute("disabled", "true");
    const reply = await ctx.engine.exportPair({ pairId });
    prepare.removeAttribute("disabled");
    if (!reply.ok) {
      output.replaceChildren(callout({ tone: "danger", title: "Export refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
      return;
    }
    packed = packBundle(reply.bundle);
    const sizeKib = (packed.length / 1024).toFixed(1);
    output.replaceChildren(
      callout({
        tone: "danger",
        title: "This file IS the pad — treat it as the secret it is",
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { text: "Anyone who holds this bundle can read and forge this pair's traffic. Deliver it to your peer out of band — hand to hand, or on media you control. Never email it, never upload it, never sync it." }),
          h("p", { class: "faint", text: `${reply.bundle.files.length} store files, ${sizeKib} KiB. The peer imports it with “Import couriered pad”.` })
        )
      }),
      h(
        "div",
        { class: "btn-row" },
        saveBytesButton(() => packed ?? new Uint8Array(0), suggestedFilename(pairId), "Save pad bundle"),
        copyButton(ctx, () => new TextDecoder().decode(packed ?? new Uint8Array(0)), "Copy bundle text")
      )
    );
  }

  container.append(
    h("p", { class: "muted", text: "Generation created both directions. Courier one copy to your peer so both sides hold the same pad. This is the out-of-band delivery a one-time pad depends on; TruePad never does it for you." }),
    prepare,
    output
  );
  return container;
}
