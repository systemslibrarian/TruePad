/* ============================================================================
 * TruePad 2 Browser Edition — Disable a pad (destroy)
 * ----------------------------------------------------------------------------
 * The one irreversible action, kept simple but deliberate: a plain statement of
 * what it does, one checkbox to confirm intent, and a destructive button. The
 * engine still requires the pad id as its --confirm; the UI supplies that from
 * the pad the user is looking at, so the user confirms by intent, not by typing
 * a hex string they never see. No undo.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout } from "./components.ts";
import type { Ctx } from "./context.ts";

const LIMITATION = "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

export async function renderDestroy(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Pad" }));

  const status = await ctx.engine.status({ pairId });
  const alreadyGone = !status.ok && status.kind === "refused" && status.reason === "pair-destroyed";
  const label = status.ok ? status.pair.label : "";

  if (alreadyGone) {
    mount(
      root,
      back,
      h("header", { class: "screen-head" }, h("h1", { text: "Already disabled" })),
      callout({ tone: "danger", title: "This pad has been permanently disabled", body: h("div", { class: "stack-sm" }, h("p", { text: "It can no longer send or open messages. There is nothing left to disable." }), h("p", { class: "faint", text: LIMITATION })) })
    );
    return;
  }

  const confirmBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  const result = h("div", { class: "section" });
  const destroyBtn = h("button", { class: "btn danger big", type: "button", disabled: true, on: { click: onDestroy } }, h("span", { text: "Disable this pad" })) as HTMLButtonElement;
  confirmBox.addEventListener("change", () => { destroyBtn.disabled = !confirmBox.checked; });

  async function onDestroy(): Promise<void> {
    destroyBtn.disabled = true;
    const reply = await ctx.engine.destroy({ pairId, confirm: pairId });
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Could not disable this pad", body: reply.message }));
      destroyBtn.disabled = !confirmBox.checked;
      return;
    }
    mount(
      result,
      callout({
        tone: "neutral",
        title: reply.alreadyDestroyed ? "Already disabled" : "Pad disabled",
        body: h("div", { class: "stack-sm" }, h("p", { text: "This pad can no longer send or open messages." }), h("p", { class: "faint", text: reply.limitation }))
      }),
      h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "home" }) } }, h("span", { text: "Back to home" })))
    );
  }

  mount(
    root,
    back,
    h("header", { class: "screen-head" }, h("h1", { text: `Disable "${label || "this pad"}"?` })),
    h(
      "div",
      { class: "card stack" },
      h("p", { text: "This permanently disables this pad. It will no longer send or open any messages, and there is no way to bring it back." }),
      h("p", { class: "faint", text: LIMITATION }),
      h("label", { class: "row confirm-row" }, confirmBox, h("span", { text: "I understand this cannot be undone." })),
      h("div", { class: "btn-row" }, destroyBtn, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Cancel" })))
    ),
    result
  );
}
