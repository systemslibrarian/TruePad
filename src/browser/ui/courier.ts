/* ============================================================================
 * TruePad Browser Edition — the courier step (export a pad)
 * ----------------------------------------------------------------------------
 * A pair's store IS the pad. Exporting it hands the operator the secret material
 * to carry to the peer OUT OF BAND — the one place pad material leaves the
 * worker deliberately, at the operator's request, never an automatic upload.
 *
 * The container is packed INSIDE the worker (src/browser/engine/courier-
 * format.ts); this UI never base64-encodes pad bytes or assembles a large
 * JSON of pad material on the UI thread. Export returns ONE transferred byte
 * buffer, which the operator saves to a file they choose. There is deliberately
 * NO "copy to clipboard": a one-time pad must never land on the clipboard.
 * ========================================================================= */

import { h, icon } from "./dom.ts";
import { friendlyRefusal } from "./spt-shared.ts";
import type { Ctx } from "./context.ts";

function suggestedFilename(pairId: string): string {
  return `truepad-${pairId.slice(0, 12)}.pad`;
}

// Save operator-supplied bytes to a file the operator names, revoking the
// object URL promptly. Used for the pad file (secret) — the calling screen
// frames the secrecy warning; this just moves the bytes at the user's request.
function triggerDownload(bytes: Uint8Array, filename: string): void {
  const view = new Uint8Array(bytes.length);
  view.set(bytes);
  const url = URL.createObjectURL(new Blob([view], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  view.fill(0);
}

// A single button that exports the pad in the worker and saves it to a file in
// one click. The pad file is the secret; the caller shows the short warning.
export function savePadFileButton(
  ctx: Ctx,
  pairId: string,
  label = "Save pad file",
  opts: { variant?: string; onSaved?: () => void } = {}
): HTMLButtonElement {
  const btn = h("button", { class: `btn ${opts.variant ?? ""}`.trim(), type: "button" }, icon("download"), h("span", { text: label })) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const reply = await ctx.engine.exportPair({ pairId });
    btn.disabled = false;
    if (!reply.ok) {
      // A pad that already left by the OTHER route refuses here, and the
      // operator gets the plain reason rather than the engine's sentence. The
      // engine is the authority on eligibility; this only translates it.
      ctx.toast(reply.kind === "refused" ? friendlyRefusal(reply.reason) : reply.message, "danger");
      return;
    }
    triggerDownload(reply.container, suggestedFilename(pairId));
    ctx.toast("Pad file saved. Give it to the other person securely.", "ok");
    opts.onSaved?.();
  });
  return btn;
}
