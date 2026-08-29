/* ============================================================================
 * TruePad Browser Edition — shared UI components
 * ----------------------------------------------------------------------------
 * The vocabulary every screen is built from: status badges, capacity bars,
 * action tiles, choice rows, disclosure panels, payload containers, the file
 * picker, and the two affordances that move bytes at the operator's request —
 * copy an envelope, save a file. Nothing here reaches the worker or holds a
 * secret; these are presentation primitives only.
 * ========================================================================= */

import { h, icon, mount, type Child } from "./dom.ts";
import type { Ctx } from "./context.ts";
import type { MeterView, StatusView, Tone } from "./format.ts";

/* ---- status ------------------------------------------------------------- */

export function badge(view: StatusView): HTMLElement {
  return h("span", { class: `badge ${view.tone}`, text: view.label });
}

export function chip(kind: "protocol" | "platform" | "operator" | "native", text: string): HTMLElement {
  return h("span", { class: `chip ${kind}`, text });
}

/* A pad's remaining capacity as one honest bar plus one plain number. Colour
   is state (green / amber / red), never the brand accent. */
export function capacityBar(percent: number, label?: string): HTMLElement {
  const level = percent <= 0 ? "empty" : percent < 15 ? "low" : "ok";
  const cls = level === "ok" ? "capacity" : `capacity ${level}`;
  const text = label ?? `${percent}% remaining`;
  return h(
    "div",
    { class: cls },
    h(
      "div",
      {
        class: "capacity-track",
        role: "progressbar",
        aria: { valuenow: String(percent), valuemin: "0", valuemax: "100", label: text }
      },
      h("div", { class: "capacity-fill", style: `width:${Math.max(percent, percent > 0 ? 2 : 0)}%` })
    ),
    h("span", { class: "capacity-label", text })
  );
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
      {
        class: "meter-track",
        role: "progressbar",
        aria: {
          valuenow: String(Math.round(view.fraction * 100)),
          valuemin: "0",
          valuemax: "100",
          label: `${view.name}: ${view.valueText}`
        }
      },
      h("div", { class: "meter-fill", style: `width:${(view.fraction * 100).toFixed(1)}%` })
    ),
    h("div", { class: "meter-foot", text: view.footText })
  );
}

/* ---- callouts ----------------------------------------------------------- */

export type CalloutOpts = {
  tone: Tone;
  title: string;
  body?: Child;
  consequence?: string;
  reason?: string;
};

const CALLOUT_ICON: Record<Tone, string> = {
  danger: "alert",
  warn: "alert",
  ok: "check",
  info: "info",
  neutral: "info"
};

export function callout(opts: CalloutOpts): HTMLElement {
  const toneClass = opts.tone === "neutral" ? "" : opts.tone;
  const glyph = icon(CALLOUT_ICON[opts.tone]);
  glyph.classList.add("co-icon");
  return h(
    "div",
    { class: `callout ${toneClass}`.trim(), role: opts.tone === "danger" ? "alert" : "status" },
    glyph,
    h("div", { class: "co-title", text: opts.title }),
    opts.body ? h("div", { class: "co-body" }, opts.body) : null,
    opts.consequence ? h("div", { class: "co-consequence", text: opts.consequence }) : null,
    opts.reason ? h("div", { class: "co-reason", text: `reason: ${opts.reason}` }) : null
  );
}

/* A one-line status the user can act on, with the technical reason one click
   away. Never a page-top banner: a wall of caveats above the whole app teaches
   people to scroll past warnings. */
export function notice(opts: { text: string; linkText?: string; onLink?: () => void }): HTMLElement {
  return h(
    "p",
    { class: "notice" },
    icon("info"),
    h("span", { text: opts.text }),
    opts.onLink
      ? h(
          "a",
          { href: "#", on: { click: (ev) => { ev.preventDefault(); opts.onLink?.(); } } },
          h("span", { text: opts.linkText ?? "Details" })
        )
      : null
  );
}

/* ---- layout ------------------------------------------------------------- */

export type KvItem = { term: string; value: Child; mono?: boolean; title?: string };

export function kv(items: KvItem[]): HTMLElement {
  return h(
    "dl",
    { class: "kv" },
    ...items.map((item) =>
      h("div", {}, h("dt", { text: item.term }), h("dd", { class: item.mono ? "mono" : "", title: item.title }, item.value))
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

export function backLink(onClick: () => void, text: string): HTMLElement {
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

export function card(...children: Child[]): HTMLElement {
  return h("div", { class: "card stack" }, ...children);
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

/* A collapsed disclosure. The expert material lives behind these, so a
   beginner never meets it and an expert is one click away. */
export function panel(summary: string, opts: { open?: boolean } = {}, ...children: Child[]): HTMLElement {
  const el = h("details", { class: "panel" }, h("summary", { text: summary }), h("div", { class: "panel-body" }, ...children));
  if (opts.open) el.setAttribute("open", "");
  return el;
}

/* A quiet secondary row — Advanced, Disable, and friends. Never the same
   weight as the actions above it. */
export function rowLink(opts: { text: string; icon?: string; danger?: boolean; onClick: () => void }): HTMLElement {
  return h(
    "a",
    {
      class: `rowlink${opts.danger ? " danger" : ""}`,
      href: "#",
      on: {
        click: (ev) => {
          ev.preventDefault();
          opts.onClick();
        }
      }
    },
    opts.icon ? icon(opts.icon) : null,
    h("span", { text: opts.text }),
    h("span", { class: "rowlink-spacer" }),
    icon("chevron")
  );
}

/* ---- action tiles ------------------------------------------------------- */

export function actionTile(opts: {
  label: string;
  icon: string;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  return h(
    "button",
    {
      class: `action-tile${opts.accent ? " accent" : ""}`,
      type: "button",
      disabled: opts.disabled,
      on: { click: opts.onClick }
    },
    h("span", { class: "tile-icon" }, icon(opts.icon)),
    h("span", { class: "tile-label", text: opts.label })
  ) as HTMLButtonElement;
}

/* ---- choices ------------------------------------------------------------ */

export function choice(opts: {
  name: string;
  title: string;
  desc?: string;
  note?: string;
  checked: boolean;
  onSelect: () => void;
}): HTMLElement {
  return h(
    "label",
    { class: "choice" },
    h("input", { type: "radio", name: opts.name, checked: opts.checked, on: { change: opts.onSelect } }),
    h(
      "span",
      { class: "choice-body" },
      h("span", { class: "choice-title", text: opts.title }),
      opts.desc ? h("span", { class: "choice-desc", text: opts.desc }) : null,
      opts.note ? h("span", { class: "choice-note", text: opts.note }) : null
    )
  );
}

/* ---- file picker -------------------------------------------------------- */

/* The native input stays real (focusable, labelled, e2e-drivable) and is laid
   transparently over a designed target. Returns both so callers can read files. */
export function filePicker(opts: {
  action: string;
  hint: string;
  multiple?: boolean;
  onChange: (files: File[]) => void;
}): { el: HTMLElement; input: HTMLInputElement; setName: (name: string | null) => void } {
  const input = h("input", { type: "file" }) as HTMLInputElement;
  if (opts.multiple) input.setAttribute("multiple", "true");
  const name = h("span", { class: "fp-name", text: opts.hint });
  const el = h(
    "label",
    { class: "filepicker" },
    icon("upload"),
    h("span", { class: "fp-text" }, h("span", { class: "fp-action", text: opts.action }), name),
    input
  );
  const setName = (value: string | null): void => {
    name.textContent = value ?? opts.hint;
    el.classList.toggle("chosen", value !== null);
  };
  input.addEventListener("change", () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0) setName(files.length === 1 ? files[0].name : `${files.length} files selected`);
    opts.onChange(files);
  });
  return { el, input, setName };
}

/* ---- payload containers ------------------------------------------------- */

/* Ciphertext contained, not spilled: a labelled well that scrolls inside
   itself so a long envelope can never blow out the layout. */
export function payloadBlock(opts: { label: string; text: string; meta?: string; actions?: Child[] }): HTMLElement {
  return h(
    "div",
    { class: "payload" },
    h(
      "div",
      { class: "payload-head" },
      h("span", { class: "payload-label", text: opts.label }),
      opts.meta ? h("span", { class: "faint", text: opts.meta }) : null
    ),
    h("div", { class: "codeblock", attrs: { "aria-label": opts.label }, text: opts.text }),
    ...(opts.actions ?? [])
  );
}

/* ---- operator affordances ----------------------------------------------- */

export function copyButton(ctx: Ctx, getText: () => string, label = "Copy", variant = "primary"): HTMLElement {
  const glyph = icon("copy");
  const text = h("span", { text: label });
  let timer: number | undefined;
  const btn = h(
    "button",
    {
      class: `btn ${variant}`,
      type: "button",
      on: {
        click: async () => {
          try {
            await navigator.clipboard.writeText(getText());
          } catch {
            ctx.toast("Clipboard unavailable — select the text and copy it manually", "danger");
            return;
          }
          mount(btn, icon("check"), h("span", { text: "Copied" }));
          window.clearTimeout(timer);
          timer = window.setTimeout(() => mount(btn, glyph, text), 1600);
        }
      }
    },
    glyph,
    text
  );
  return btn;
}

/* Save bytes to a file the operator names — an operator-initiated download,
   never an automatic upload. When the bytes are pad material the calling
   screen frames it as the courier step. */
export function saveBytesButton(bytes: () => Uint8Array, filename: string, label = "Save", variant = "secondary"): HTMLElement {
  return h(
    "button",
    {
      class: `btn ${variant === "secondary" ? "" : variant}`.trim(),
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
