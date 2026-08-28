/* ============================================================================
 * TruePad 2 Browser Edition — shared UI components
 * ----------------------------------------------------------------------------
 * Small DOM builders reused across screens: status badges, classification
 * chips, meter bars, consequence callouts, key/value grids, and the two
 * operator affordances that move bytes at the operator's request — copy an
 * envelope, save a file. Nothing here reaches the worker or holds secrets.
 * ========================================================================= */

import { h, icon, type Child } from "./dom.ts";
import type { Ctx } from "./context.ts";
import type { MeterView, StatusView, Tone } from "./format.ts";

export function badge(view: StatusView): HTMLElement {
  return h("span", { class: `badge ${view.tone}`, text: view.label });
}

export function chip(kind: "protocol" | "platform" | "operator" | "native", text: string): HTMLElement {
  return h("span", { class: `chip ${kind}`, text });
}

export function meterBar(view: MeterView): HTMLElement {
  const cls = view.level === "exhausted" ? "meter exhausted" : view.level === "low" ? "meter low" : "meter";
  return h(
    "div",
    { class: cls },
    h(
      "div",
      { class: "meter-head" },
      h("span", { class: "m-name", text: view.name }),
      h("span", { class: "m-value", text: view.valueText })
    ),
    h(
      "div",
      { class: "meter-track", role: "meter", aria: { valuenow: String(Math.round(view.fraction * 100)), valuemin: "0", valuemax: "100", label: `${view.name}: ${view.valueText}` } },
      h("div", { class: "meter-fill", style: `width:${(view.fraction * 100).toFixed(1)}%` })
    ),
    h("div", { class: "meter-foot", text: view.footText })
  );
}

export type CalloutOpts = {
  tone: Tone;
  title: string;
  body?: Child;
  consequence?: string;
  reason?: string;
};

export function callout(opts: CalloutOpts): HTMLElement {
  const toneClass = opts.tone === "neutral" ? "" : opts.tone;
  return h(
    "div",
    { class: `callout ${toneClass}`.trim(), role: opts.tone === "danger" ? "alert" : "status" },
    h(
      "div",
      { class: "co-title" },
      opts.tone === "danger" || opts.tone === "warn" ? icon("alert") : opts.tone === "ok" ? icon("check") : null,
      h("span", { text: opts.title })
    ),
    opts.body ? h("div", { class: "co-body" }, opts.body) : null,
    opts.consequence ? h("div", { class: "co-consequence", text: opts.consequence }) : null,
    opts.reason ? h("div", { class: "co-reason", text: `reason: ${opts.reason}` }) : null
  );
}

export type KvItem = { term: string; value: Child; mono?: boolean; title?: string };

export function kv(items: KvItem[]): HTMLElement {
  return h(
    "dl",
    { class: "kv" },
    ...items.map((item) =>
      h(
        "div",
        {},
        h("dt", { text: item.term }),
        h("dd", { class: item.mono ? "mono" : "", title: item.title }, item.value)
      )
    )
  );
}

export function screenHead(opts: { eyebrow?: string; title: string; lede?: Child }): HTMLElement {
  return h(
    "header",
    { class: "screen-head" },
    opts.eyebrow ? h("span", { class: "eyebrow", text: opts.eyebrow }) : null,
    h("h1", { text: opts.title }),
    opts.lede ? h("p", { class: "lede" }, opts.lede) : null
  );
}

export function backLink(ctx: Ctx, onClick: () => void, text: string): HTMLElement {
  return h(
    "a",
    {
      class: "back-link",
      href: "#",
      on: {
        click: (ev) => {
          ev.preventDefault();
          onClick();
        }
      }
    },
    icon("back"),
    h("span", { text })
  );
}

export function copyButton(ctx: Ctx, getText: () => string, label = "Copy"): HTMLElement {
  return h(
    "button",
    {
      class: "btn small ghost",
      type: "button",
      on: {
        click: async () => {
          const text = getText();
          try {
            await navigator.clipboard.writeText(text);
            ctx.toast("Copied to clipboard", "ok");
          } catch {
            ctx.toast("Clipboard unavailable — select and copy manually", "danger");
          }
        }
      }
    },
    icon("copy"),
    h("span", { text: label })
  );
}

// Save bytes to a file the operator names. This is an operator-initiated
// download; when the bytes are pad material (an export bundle) the calling
// screen frames it as the courier step. Uses an object URL on a real page.
export function saveBytesButton(bytes: () => Uint8Array, filename: string, label = "Save"): HTMLElement {
  return h(
    "button",
    {
      class: "btn small ghost",
      type: "button",
      on: {
        click: () => {
          const data = bytes();
          const view = new Uint8Array(data.length);
          view.set(data);
          const blob = new Blob([view], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
    },
    icon("download"),
    h("span", { text: label })
  );
}

export function card(...children: Child[]): HTMLElement {
  return h("div", { class: "card" }, ...children);
}

export function section(title: string, note: Child | undefined, ...children: Child[]): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: title }),
    note ? h("p", { class: "section-note" }, note) : null,
    ...children
  );
}
