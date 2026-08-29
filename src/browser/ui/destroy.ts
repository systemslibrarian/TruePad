/* ============================================================================
 * TruePad Browser Edition — Disable a pad (destroy)
 * ----------------------------------------------------------------------------
 * The one irreversible action: a plain statement of what it does, the exact
 * limitation TruePad is allowed to claim, one checkbox to confirm intent, and a
 * destructive button that stays inert until it is ticked. No animation, no
 * softened language, no undo. The engine still requires the pair id as its
 * --confirm; the UI supplies that from the pad on screen, so the operator
 * confirms by intent rather than by transcribing a hex string.
 *
 * Succeeding lands on the disabled-pad screen itself rather than on a private
 * receipt, so "what a dead pad looks like" is one screen with one wording,
 * whether you just disabled it or came back to it later — and the way to get
 * it out of TruePad for good is right there.
 * ========================================================================= */

import { h, mount } from "./dom.ts";
import { backLink, callout } from "./components.ts";
import { renderDestroyed } from "./dashboard.ts";
import { DESTRUCTION_LIMITATION } from "./format.ts";
import type { Ctx } from "./context.ts";

export async function renderDestroy(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const back = () => ctx.navigate({ name: "pair", pairId });

  const status = await ctx.engine.status({ pairId });
  const alreadyGone = !status.ok && status.kind === "refused" && status.reason === "pair-destroyed";
  const label = status.ok ? status.pair.label : "";

  if (alreadyGone) {
    const list = await ctx.engine.listPairs();
    const summary = list.ok ? list.pairs.find((p) => p.pairId === pairId) : undefined;
    renderDestroyed(ctx, root, { pairId, label: summary?.label ?? "" });
    return;
  }

  const confirmBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  const destroyBtn = h(
    "button",
    { class: "btn danger", type: "button", disabled: true, on: { click: onDestroy } },
    h("span", { text: "Disable this pad" })
  ) as HTMLButtonElement;
  confirmBox.addEventListener("change", () => { destroyBtn.disabled = !confirmBox.checked; });

  const errorSlot = h("div", {});

  async function onDestroy(): Promise<void> {
    destroyBtn.disabled = true;
    const reply = await ctx.engine.destroy({ pairId, confirm: pairId });
    if (!reply.ok) {
      mount(errorSlot, callout({ tone: "danger", title: "Could not disable this pad", body: reply.message }));
      destroyBtn.disabled = !confirmBox.checked;
      return;
    }
    renderDestroyed(ctx, root, { pairId, label });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(back, "Pad"),
      h("header", { class: "screen-head" }, h("h1", { text: `Disable "${label || "this pad"}"?` })),
      h(
        "div",
        { class: "card" },
        h("p", { text: "This permanently disables this pad. It will no longer send or open any messages, and there is no way to bring it back." }),
        h("p", { class: "faint", text: DESTRUCTION_LIMITATION }),
        h("label", { class: "confirm-row" }, confirmBox, h("span", { text: "I understand this cannot be undone." })),
        h(
          "div",
          { class: "btn-row" },
          destroyBtn,
          h("button", { class: "btn ghost", type: "button", on: { click: back } }, h("span", { text: "Cancel" }))
        )
      ),
      errorSlot
    )
  );
}
