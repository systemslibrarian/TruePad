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
 * "Your pads" means pads you can USE, and it is the only list on this screen.
 * A permanently disabled pad can never send or open anything again, so it is
 * not one — and there is no archive, no count and no disclosure holding the
 * dead ones either. With no usable pad this screen is a fresh install: one
 * centred column, and nothing underneath it.
 *
 * All of that is display. The tombstone that enforces a destruction is
 * untouched by anything here, and a removed pad stays permanently unusable.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge, callout, capacityBar } from "./components.ts";
import { padHealthPercent, padStatusWord } from "./format.ts";
import type { Ctx } from "./context.ts";
import { isRemoved } from "./removed.ts";
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

  // The working list is pads you can use. Disabled pads are not shown here at
  // all — not in a list, not behind a disclosure, not as a count — and removed
  // ones are filtered out ahead of everything, so nothing on this screen can
  // name one.
  const active = pairs.filter((p) => !p.destroyed && !isRemoved(p.pairId));

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
        // ONE quiet line, below the two actions and above the disclosure. It
        // exists because the choice a newcomer is about to make — hand the pad
        // over, or send it — is the choice that decides which guarantee they
        // get, and nothing else on this screen hints at that. It stays at
        // hero-alt weight, names no cryptography, and is not a third action.
        h(
          "p",
          { class: "hero-alt faint share-note" },
          h("span", { text: "How you share the pad matters: handing it over and sending it online have different guarantees. " }),
          h("a", { href: "online-delivery.html" }, h("span", { text: "Learn why" }))
        ),
        howItWorks()
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
      h("div", { class: "btn-row list-actions" }, createBtn("primary"), addLink)
    )
  );
}
