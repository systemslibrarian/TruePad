/* ============================================================================
 * TruePad Browser Edition — Home
 * ----------------------------------------------------------------------------
 * The front door. What TruePad is in one sentence, the two things you can do,
 * and your pads as a real list — a name, a Ready/Warning word, and how much of
 * the pad is left, on a bar rather than as a floating percentage. A first-time
 * visitor also gets the three-step relationship, once, and small. No jargon
 * reaches this screen: A->B, sequence numbers and pair ids live under Advanced.
 * ========================================================================= */

import { brandMark, h, icon, mount } from "./dom.ts";
import { badge, callout, capacityBar } from "./components.ts";
import { padHealthPercent, padStatusWord } from "./format.ts";
import type { Ctx } from "./context.ts";
import type { PairSummary } from "../engine/protocol.ts";

const STEPS: [string, string][] = [
  ["Create a pad", "It is generated on your device and never uploaded."],
  ["Share it once", "Give the pad file to the other person over a channel you both control."],
  ["Message privately", "From then on you can each send and open messages."]
];

function stepList(): HTMLElement {
  return h(
    "ol",
    { class: "steps" },
    ...STEPS.map(([title, body], i) =>
      h(
        "li",
        { class: "step" },
        h("span", { class: "step-num", text: String(i + 1) }),
        h("span", { class: "step-text" }, h("b", { text: title }), h("span", { text: body }))
      )
    )
  );
}

function padCard(ctx: Ctx, pair: PairSummary): HTMLElement {
  const open = () => ctx.navigate({ name: "pair", pairId: pair.pairId });
  const name = pair.label || "Untitled pad";

  const meta = pair.destroyed
    ? h("div", { class: "pad-card-meta" }, badge({ label: "Disabled", tone: "danger" }))
    : h(
        "div",
        { class: "pad-card-meta" },
        badge(padStatusWord(pair)),
        capacityBar(padHealthPercent(pair))
      );

  return h(
    "button",
    { class: "pad-card", type: "button", on: { click: open } },
    h("div", { class: "pad-card-main" }, h("div", { class: "pad-card-name", text: name }), meta),
    h("span", { class: "pad-card-chevron" }, icon("chevron"))
  );
}

export async function renderHome(ctx: Ctx, root: HTMLElement): Promise<void> {
  const reply = await ctx.engine.listPairs();
  const pairs = reply.ok ? reply.pairs : [];

  const hero = h(
    "header",
    { class: "hero" },
    brandMark(),
    h("h1", { class: "hero-title", text: "TruePad" }),
    h("p", { class: "hero-sub", text: "Messages only you and one other person can read." })
  );

  const actions = h(
    "div",
    { class: "home-actions" },
    h(
      "button",
      { class: "btn primary lg", type: "button", on: { click: () => ctx.navigate({ name: "create" }) } },
      icon("plus"),
      h("span", { text: "Create new pad" })
    ),
    h(
      "button",
      { class: "btn lg", type: "button", on: { click: () => ctx.navigate({ name: "import" }) } },
      icon("upload"),
      h("span", { text: "Add a shared pad" })
    )
  );

  const body =
    pairs.length === 0
      ? stepList()
      : h(
          "section",
          {},
          h("div", { class: "pads-head" }, h("h2", { class: "pads-title", text: "Your pads" })),
          h("div", { class: "pad-list" }, ...pairs.map((p) => padCard(ctx, p)))
        );

  const links = h(
    "nav",
    { class: "home-links", aria: { label: "More" } },
    h("a", { class: "home-link", href: "learn.html" }, h("span", { text: "How it works" }), icon("external")),
    h(
      "a",
      {
        class: "home-link",
        href: "#/advanced",
        on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "security" }); } }
      },
      h("span", { text: "Security & limitations" })
    )
  );

  const screen = h(
    "div",
    { class: "screen landing" },
    hero,
    actions,
    !reply.ok ? callout({ tone: "danger", title: "Could not read your pads", body: reply.message }) : body,
    links
  );

  mount(root, screen);
}
