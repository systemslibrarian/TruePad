/* ============================================================================
 * TruePad 2 Browser Edition — the courier step (export / import a pad)
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
import { callout, saveBytesButton } from "./components.ts";
import type { Ctx } from "./context.ts";

function suggestedFilename(pairId: string): string {
  return `truepad2-pair-${pairId.slice(0, 12)}.pad.json`;
}

// Reusable export affordance for the dashboard and the create verdict.
export function exportPanel(ctx: Ctx, pairId: string): HTMLElement {
  const container = h("div", { class: "stack" });
  // The packed container is pad material held transiently on this thread only
  // between export and save. A fresh prepare overwrites the previous buffer.
  let packed: Uint8Array | null = null;

  const output = h("div", { class: "stack" });

  const prepare = h(
    "button",
    { class: "btn", type: "button", on: { click: onPrepare } },
    icon("download"),
    h("span", { text: "Prepare courier bundle" })
  );

  function clearPacked(): void {
    if (packed) {
      // Best-effort hygiene — not a guarantee: a JS engine may keep other copies.
      packed.fill(0);
      packed = null;
    }
  }

  async function onPrepare(): Promise<void> {
    prepare.setAttribute("disabled", "true");
    clearPacked();
    const reply = await ctx.engine.exportPair({ pairId });
    prepare.removeAttribute("disabled");
    if (!reply.ok) {
      output.replaceChildren(
        callout({ tone: "danger", title: "Export refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined })
      );
      return;
    }
    packed = reply.container;
    const sizeKib = (packed.length / 1024).toFixed(1);
    output.replaceChildren(
      callout({
        tone: "danger",
        title: "This file IS the pad — treat it as the secret it is",
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { text: "Anyone who holds this bundle can read and forge this pair's traffic. Deliver it to your peer out of band — hand to hand, or on media you control. Never email it, never upload it, never sync it, never copy it to the clipboard." }),
          h("p", { class: "faint", text: `${reply.fileCount} store files, ${sizeKib} KiB. The peer imports it with “Import couriered pad”.` })
        )
      }),
      h(
        "div",
        { class: "btn-row" },
        saveBytesButton(() => packed ?? new Uint8Array(0), suggestedFilename(pairId), "Save pad bundle")
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
