/* ============================================================================
 * TruePad Browser Edition — Home
 * ----------------------------------------------------------------------------
 * Level 1. Someone who uses Signal and knows nothing about cryptography has to
 * know what to click within five seconds, so there is almost nothing to read:
 * what it is in one line, and one obvious button. How it works is a link, not a
 * lecture. Once pads exist the marketing gets out of the way and the list is
 * the screen, the way a messaging app behaves.
 *
 * No word on this screen names an internal concept. "Pad", not pair. "Pad
 * file", not courier bundle. "The other person", not peer. Directions, records,
 * witnesses and storage internals are Level 3 and live under Security.
 *
 * "Your pads" means pads you can USE. A permanently disabled pad is not one:
 * it can never send or open anything again, so it is kept out of the working
 * list and reachable only through a quiet disclosure at the bottom — and, once
 * hidden, not from here at all. That is display only. The tombstone that
 * enforces the destruction is untouched by anything on this screen.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge, callout, capacityBar } from "./components.ts";
import { padHealthPercent, padStatusWord } from "./format.ts";
import type { Ctx } from "./context.ts";
import { isHidden } from "./hidden.ts";
import type { PairSummary } from "../engine/protocol.ts";

const STEPS: [string, string][] = [
  ["Create a pad", "It is made on your device and never uploaded."],
  ["Give a copy to one person", "Give them the pad file privately."],
  ["Message each other", "From then on you can both send and open messages."]
];

// Collapsed by default: it costs nothing when closed and answers the only
// question a first-time visitor actually has.
function howItWorks(): HTMLElement {
  return h(
    "details",
    { class: "quiet-details how" },
    h("summary", { text: "How does this work?" }),
    h(
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
    )
  );
}

// The wordmark is the logo: True in ink, Pad in phosphor gold.
function wordmark(): HTMLElement {
  return h(
    "h1",
    { class: "hero-title wordmark" },
    h("span", { text: "True" }),
    h("span", { class: "accent", text: "Pad" })
  );
}

// A pad you can use. Disabled pads never render as one of these.
function padRow(ctx: Ctx, pair: PairSummary): HTMLElement {
  const open = () => ctx.navigate({ name: "pair", pairId: pair.pairId });
  const name = pair.label || "Untitled pad";
  const meta = h("div", { class: "pad-card-meta" }, badge(padStatusWord(pair)), capacityBar(padHealthPercent(pair)));

  return h(
    "button",
    { class: "pad-card", type: "button", on: { click: open } },
    h("div", { class: "pad-card-main" }, h("div", { class: "pad-card-name", text: name }), meta),
    h("span", { class: "pad-card-chevron" }, icon("chevron"))
  );
}

// One dead pad: its name, the word Disabled, and a way in. Deliberately not a
// pad card — nothing here should read as something you can use.
function disabledRow(ctx: Ctx, pair: PairSummary): HTMLElement {
  return h(
    "div",
    { class: "disabled-row" },
    h("span", { class: "disabled-row-name", text: pair.label || "Untitled pad" }),
    badge({ label: "Disabled", tone: "danger" }),
    h(
      "button",
      {
        class: "linklike",
        type: "button",
        on: { click: () => ctx.navigate({ name: "pair", pairId: pair.pairId }) }
      },
      h("span", { text: "View" })
    )
  );
}

// Quiet, collapsed, and last on the screen — and absent entirely when there is
// nothing disabled left to show.
function disabledSection(ctx: Ctx, disabled: PairSummary[]): HTMLElement | null {
  if (disabled.length === 0) return null;
  return h(
    "details",
    { class: "quiet-details disabled-pads" },
    h("summary", { text: "Show disabled pads" }),
    h("div", { class: "qd-body" }, ...disabled.map((p) => disabledRow(ctx, p)))
  );
}

export async function renderHome(ctx: Ctx, root: HTMLElement): Promise<void> {
  const reply = await ctx.engine.listPairs();
  const pairs = reply.ok ? reply.pairs : [];

  const createBtn = (variant: string) =>
    h(
      "button",
      { class: `btn ${variant}`, type: "button", on: { click: () => ctx.navigate({ name: "create" }) } },
      icon("plus"),
      h("span", { text: "Create a pad" })
    );

  const addLink = h(
    "button",
    { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "import" }) } },
    h("span", { text: "Add a shared pad" })
  );

  if (!reply.ok) {
    mount(
      root,
      h(
        "div",
        { class: "screen landing" },
        h("header", { class: "hero" }, wordmark()),
        callout({ tone: "danger", title: "Could not read your pads", body: reply.message })
      )
    );
    return;
  }

  // The working list is pads you can use; the dead ones are separated out here
  // and never mixed back in. Hiding only removes a dead pad from this screen.
  const active = pairs.filter((p) => !p.destroyed);
  const disabled = pairs.filter((p) => p.destroyed && !isHidden(p.pairId));

  // --- no usable pad: the fresh-start screen, even if dead pads exist -----
  if (active.length === 0) {
    mount(
      root,
      h(
        "div",
        { class: "screen landing" },
        h(
          "header",
          { class: "hero" },
          wordmark(),
          h("p", { class: "hero-sub", text: "Private messages using a pad you share with one other person." })
        ),
        h("div", { class: "hero-cta" }, createBtn("primary lg")),
        h(
          "p",
          { class: "hero-alt" },
          h("span", { text: "Already have a pad file? " }),
          h(
            "button",
            { class: "linklike", type: "button", on: { click: () => ctx.navigate({ name: "import" }) } },
            h("span", { text: "Add a shared pad" })
          )
        ),
        howItWorks(),
        disabledSection(ctx, disabled)
      )
    );
    return;
  }

  // --- usable pads exist: the list is the screen -------------------------
  mount(
    root,
    h(
      "div",
      { class: "screen" },
      h("h1", { class: "list-title", text: "Your pads" }),
      h("div", { class: "pad-list" }, ...active.map((p) => padRow(ctx, p))),
      h("div", { class: "btn-row list-actions" }, createBtn("primary"), addLink),
      disabledSection(ctx, disabled)
    )
  );
}
