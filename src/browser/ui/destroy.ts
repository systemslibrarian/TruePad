/* ============================================================================
 * TruePad 2 Browser Edition — Destroy
 * ----------------------------------------------------------------------------
 * The irreversible boundary. The operator must type the pair id (the same
 * --confirm the engine requires), the verbatim limitation sentence is shown
 * before and after, and there is no undo and no animation on the act itself.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout } from "./components.ts";
import type { Ctx } from "./context.ts";

const LIMITATION = "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

export async function renderDestroy(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Dashboard" }));

  // Confirm status first so an already-destroyed pair is honest about it.
  const status = await ctx.engine.status({ pairId });
  const alreadyGone = !status.ok && status.kind === "refused" && status.reason === "pair-destroyed";

  const confirmInput = h("input", { type: "text", spellcheck: false, autocomplete: "off", placeholder: "Type the pair id to confirm" }) as HTMLInputElement;
  const reasonInput = h("input", { type: "text", placeholder: "operator destroy" }) as HTMLInputElement;
  const result = h("div", { class: "section" });
  const destroyBtn = h("button", { class: "btn danger", type: "button", disabled: true, on: { click: onDestroy } }, h("span", { text: "Destroy this pair permanently" })) as HTMLButtonElement;

  confirmInput.addEventListener("input", () => {
    destroyBtn.disabled = confirmInput.value.trim() !== pairId;
  });

  async function onDestroy(): Promise<void> {
    destroyBtn.disabled = true;
    const reply = await ctx.engine.destroy({ pairId, confirm: confirmInput.value.trim(), reason: reasonInput.value.trim() || undefined });
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Destruction refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
      destroyBtn.disabled = confirmInput.value.trim() !== pairId;
      return;
    }
    mount(
      result,
      callout({
        tone: "neutral",
        title: reply.alreadyDestroyed ? "Already destroyed" : "Destroyed",
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { text: reply.alreadyDestroyed ? "This pair had already crossed the boundary. The tombstone is preserved." : "The tombstone is durable. This pair now refuses every operation, before any secret is read." }),
          h("p", { class: "faint", text: reply.limitation })
        )
      }),
      h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "home" }) } }, h("span", { text: "Back to all pairs" })))
    );
  }

  if (alreadyGone) {
    mount(
      root,
      back,
      h("header", { class: "screen-head" }, h("span", { class: "eyebrow", text: "Destroy" }), h("h1", { text: "Already destroyed" })),
      callout({ tone: "danger", title: "This pair has already crossed the destruction boundary", body: h("div", { class: "stack-sm" }, h("p", { text: "It refuses every operation. There is nothing left to destroy." }), h("p", { class: "faint", text: LIMITATION })) })
    );
    return;
  }

  mount(
    root,
    back,
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: "Destroy" }),
      h("h1", { text: "Destroy this pair" }),
      h("p", { class: "lede", text: "This is irreversible. There is no undo and no recovery." })
    ),
    callout({
      tone: "danger",
      title: "What destruction does — and does not — guarantee",
      body: h(
        "ul",
        { class: "stack-sm", style: "margin:0;padding-left:1.1rem" },
        h("li", { text: "Writes a durable tombstone; the pair refuses every operation afterwards, before any secret is read." }),
        h("li", { text: "Best-effort zero-overwrites the secret and removes the store files." }),
        h("li", { text: "Restartable and idempotent — a resumed destroy preserves the original tombstone." })
      ),
      consequence: LIMITATION
    }),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "field" }, h("div", { class: "field-label", text: "To confirm, type this pair id exactly" }), h("div", { class: "codeblock", text: pairId }), confirmInput),
      h("div", { class: "field" }, h("label", { text: "Reason (optional, recorded)" }), reasonInput),
      h("div", { class: "btn-row" }, destroyBtn, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Cancel" })))
    ),
    result
  );
}
