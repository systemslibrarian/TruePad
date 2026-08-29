/* ============================================================================
 * TruePad Browser Edition — Disable a pad (destroy)
 * ----------------------------------------------------------------------------
 * The one irreversible action: a plain statement of what it does, the exact
 * limitation TruePad is allowed to claim, one checkbox to confirm intent, and a
 * destructive button that stays inert until it is ticked. No animation, no
 * softened language, no undo. The engine still requires the pair id as its
 * --confirm; the UI supplies that from the pad on screen, so the operator
 * confirms by intent rather than by transcribing a hex string.
 * ========================================================================= */

import { h, mount } from "./dom.ts";
import { backLink, callout } from "./components.ts";
import type { Ctx } from "./context.ts";

const LIMITATION = "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

export async function renderDestroy(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const back = () => ctx.navigate({ name: "pair", pairId });

  const status = await ctx.engine.status({ pairId });
  const alreadyGone = !status.ok && status.kind === "refused" && status.reason === "pair-destroyed";
  const label = status.ok ? status.pair.label : "";

  if (alreadyGone) {
    mount(
      root,
      h(
        "div",
        { class: "screen" },
        backLink(back, "Pad"),
        h("header", { class: "screen-head" }, h("h1", { text: "Already disabled" })),
        callout({
          tone: "danger",
          title: "This pad has been permanently disabled",
          body: h(
            "div",
            { class: "stack-sm" },
            h("p", { text: "It can no longer send or open messages. There is nothing left to disable." }),
            h("p", { class: "faint", text: LIMITATION })
          )
        })
      )
    );
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
    mount(
      root,
      h(
        "div",
        { class: "screen" },
        h("header", { class: "screen-head" }, h("h1", { text: reply.alreadyDestroyed ? "Already disabled" : "Pad disabled" })),
        h("p", { class: "muted", text: "This pad can no longer send or open messages." }),
        h("p", { class: "faint", text: reply.limitation }),
        h("hr", { class: "divider" }),
        h(
          "div",
          { class: "btn-row" },
          h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "home" }) } }, h("span", { text: "Back to home" }))
        )
      )
    );
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
        h("p", { class: "faint", text: LIMITATION }),
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
