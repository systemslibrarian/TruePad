/* ============================================================================
 * TruePad 2 Browser Edition — Home / pair list
 * ----------------------------------------------------------------------------
 * Every pair the origin holds, as a card: operator label, Alice ↔ Bob, the two
 * directions' encryption and authentication meters, a Ready / Frozen /
 * Destroyed badge, and the way in. This is the only screen that lists pairs;
 * everything a pair can do lives on its dashboard.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge, meterBar, screenHead } from "./components.ts";
import { abbreviatePairId, authMeter, encryptionMeter, directionLabel, pairStatus } from "./format.ts";
import type { Ctx } from "./context.ts";
import type { DirectionMeters, PairSummary } from "../engine/protocol.ts";
import type { PadDirection } from "../../core/pad.ts";

function directionBlock(direction: PadDirection, m: DirectionMeters): HTMLElement {
  return h(
    "div",
    { class: "stack-sm" },
    h("div", { class: "pc-role" }, h("span", { text: directionLabel(direction) })),
    meterBar(encryptionMeter(m)),
    meterBar(authMeter(m))
  );
}

function pairCard(ctx: Ctx, pair: PairSummary): HTMLElement {
  const status = pairStatus(pair);
  const open = () => ctx.navigate({ name: "pair", pairId: pair.pairId });

  const actions = pair.destroyed
    ? [h("button", { class: "btn small ghost", type: "button", on: { click: open } }, h("span", { text: "View tombstone" }))]
    : [
        h("button", { class: "btn small primary", type: "button", on: { click: open } }, h("span", { text: "Open" }), icon("chevron"))
      ];

  return h(
    "article",
    { class: "card pair-card" },
    h(
      "div",
      { class: "pc-head" },
      h(
        "div",
        {},
        h("div", { class: "pc-label", text: pair.label || "(unlabelled pair)" }),
        h("div", { class: "pc-id mono", text: abbreviatePairId(pair.pairId), title: pair.pairId })
      ),
      badge(status)
    ),
    pair.destroyed
      ? h("p", { class: "muted", text: "This pair crossed the destruction boundary. Its material is gone and it refuses every operation." })
      : h(
          "div",
          { class: "stack" },
          directionBlock("A->B", pair.meters["A->B"]),
          directionBlock("B->A", pair.meters["B->A"])
        ),
    h("div", { class: "pc-actions" }, ...actions)
  );
}

export async function renderHome(ctx: Ctx, root: HTMLElement): Promise<void> {
  const reply = await ctx.engine.listPairs();

  const head = screenHead({
    eyebrow: "Pairs on this device",
    title: "Your pads",
    lede: "Each pair is two one-time pads — one per direction — held in this browser's private storage. The pad never leaves the worker; only envelopes and non-secret meters reach this screen."
  });

  const createBtn = h(
    "button",
    { class: "btn primary", type: "button", on: { click: () => ctx.navigate({ name: "create" }) } },
    icon("plus"),
    h("span", { text: "Create pair" })
  );

  if (!reply.ok) {
    mount(root, head, h("div", { class: "callout danger", role: "alert" }, h("div", { class: "co-title" }, h("span", { text: "Could not read the store" })), h("div", { class: "co-body", text: reply.message })));
    return;
  }

  const pairs = reply.pairs;
  const toolbar = h("div", { class: "spread", style: "margin-bottom:1.25rem" }, h("div", { class: "muted", text: `${pairs.length} pair${pairs.length === 1 ? "" : "s"}` }), createBtn);

  if (pairs.length === 0) {
    mount(
      root,
      head,
      h(
        "div",
        { class: "empty" },
        h("h2", { text: "No pairs yet" }),
        h("p", { class: "muted", text: "Generate a pair from your own source material, or from the browser DRBG for a trial. Both directions are created at once; you courier one copy to your peer, out of band." }),
        createBtn
      )
    );
    return;
  }

  mount(root, head, toolbar, h("div", { class: "card-grid" }, ...pairs.map((p) => pairCard(ctx, p))));
}
