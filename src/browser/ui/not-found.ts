/* ============================================================================
 * TruePad Browser Edition — Pad not found
 * ----------------------------------------------------------------------------
 * What a removed pad's old route renders. It says nothing: no name, no
 * "Disabled", no "permanently disabled", no created date, no pair id. Removing
 * a pad means TruePad stops showing it to you, and a URL is not a loophole —
 * an old bookmark has to look exactly like a route that never existed.
 *
 * The engine's memory is untouched by this screen. It still knows the pair is
 * tombstoned and still refuses it everywhere; it just no longer says so out
 * loud to a user who asked for the pad to go away.
 * ========================================================================= */

import { h, mount } from "./dom.ts";
import { callout } from "./components.ts";
import type { Ctx } from "./context.ts";

export function renderNotFound(ctx: Ctx, root: HTMLElement): void {
  mount(
    root,
    h(
      "div",
      { class: "screen" },
      callout({ tone: "warn", title: "Pad not found.", body: "This pad is not in TruePad." }),
      h(
        "div",
        { class: "btn-row" },
        h(
          "button",
          { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "home" }) } },
          h("span", { text: "Back to home" })
        )
      )
    )
  );
}
