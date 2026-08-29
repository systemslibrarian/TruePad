/* ============================================================================
 * TruePad 2 Browser Edition — Home (simple)
 * ----------------------------------------------------------------------------
 * The front door for a non-technical person: what TruePad is in one line, the
 * two things you can do (make a pad, or add one someone shared), and your pads
 * as plain cards — a name, one "% remaining" number, a Ready/Warning word, and
 * an Open button. No directional meters, no jargon; the depth lives behind
 * "How it works" and "Advanced".
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge } from "./components.ts";
import { padHealthPercent, padStatusWord } from "./format.ts";
import type { Ctx } from "./context.ts";
import type { PairSummary } from "../engine/protocol.ts";

function padCard(ctx: Ctx, pair: PairSummary): HTMLElement {
  const open = () => ctx.navigate({ name: "pair", pairId: pair.pairId });
  if (pair.destroyed) {
    return h(
      "article",
      { class: "card pad-card" },
      h("div", { class: "pad-card-main" }, h("div", { class: "pad-card-name", text: pair.label || "Untitled pad" }), badge({ label: "Disabled", tone: "danger" })),
      h("button", { class: "btn ghost", type: "button", on: { click: open } }, h("span", { text: "View" }))
    );
  }
  const pct = padHealthPercent(pair);
  const status = padStatusWord(pair);
  return h(
    "article",
    { class: "card pad-card" },
    h(
      "div",
      { class: "pad-card-main" },
      h("div", { class: "pad-card-name", text: pair.label || "Untitled pad" }),
      h(
        "div",
        { class: "pad-card-meta" },
        badge(status),
        h("span", { class: "pad-card-remaining", text: `${pct}% remaining` })
      )
    ),
    h("button", { class: "btn primary", type: "button", on: { click: open } }, h("span", { text: "Open" }), icon("chevron"))
  );
}

export async function renderHome(ctx: Ctx, root: HTMLElement): Promise<void> {
  const reply = await ctx.engine.listPairs();
  const pairs = reply.ok ? reply.pairs : [];

  const hero = h(
    "header",
    { class: "home-hero" },
    h("h1", { class: "home-title", text: "TruePad" }),
    h("p", { class: "home-tagline", text: "Secure one-time-pad messaging" })
  );

  const primary = h(
    "div",
    { class: "home-actions" },
    h("button", { class: "btn primary big", type: "button", on: { click: () => ctx.navigate({ name: "create" }) } }, icon("plus"), h("span", { text: "Create new pad" })),
    h("button", { class: "btn big", type: "button", on: { click: () => ctx.navigate({ name: "import" }) } }, icon("download"), h("span", { text: "Add a shared pad" }))
  );

  const list = pairs.length === 0
    ? h("p", { class: "home-empty muted", text: "No pads yet. Create one to send to someone, or add a pad they shared with you." })
    : h(
        "section",
        { class: "home-pads" },
        h("h2", { class: "home-pads-title", text: "Your pads" }),
        h("div", { class: "pad-list" }, ...pairs.map((p) => padCard(ctx, p)))
      );

  const footer = h(
    "nav",
    { class: "home-links", aria: { label: "More" } },
    h("a", { class: "home-link", href: "learn.html" }, h("span", { text: "How it works" }), icon("external")),
    h("a", { class: "home-link", href: "#/advanced", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "security" }); } } }, h("span", { text: "Advanced / Security details" }))
  );

  if (!reply.ok) {
    mount(root, hero, primary, h("div", { class: "callout danger", role: "alert" }, h("div", { class: "co-title" }, h("span", { text: "Could not read your pads" })), h("div", { class: "co-body", text: reply.message })), footer);
    return;
  }

  mount(root, hero, primary, list, footer);
}
