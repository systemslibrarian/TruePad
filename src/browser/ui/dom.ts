/* ============================================================================
 * TruePad 2 Browser Edition — tiny DOM helper
 * ----------------------------------------------------------------------------
 * No framework: plain TS + DOM with a hyperscript-style `h()` and a handful of
 * builders. Text goes in as text nodes (never innerHTML), so nothing the
 * operator types — a pair label, a pasted envelope, a plaintext — is ever
 * interpreted as markup. The only innerHTML in this file is the fixed,
 * source-controlled icon set below.
 * ========================================================================= */

export type Child = Node | string | number | null | undefined | false;

type Props = {
  class?: string;
  id?: string;
  text?: string | number;
  html?: string; // ONLY for trusted, source-literal SVG markup
  href?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  title?: string;
  role?: string;
  disabled?: boolean;
  hidden?: boolean;
  rows?: number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  name?: string;
  checked?: boolean;
  spellcheck?: boolean;
  autocomplete?: string;
  style?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  aria?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class !== undefined) node.className = props.class;
  if (props.id !== undefined) node.id = props.id;
  if (props.title !== undefined) node.title = props.title;
  if (props.role !== undefined) node.setAttribute("role", props.role);
  if (props.href !== undefined) node.setAttribute("href", props.href);
  if (props.type !== undefined) node.setAttribute("type", props.type);
  if (props.name !== undefined) node.setAttribute("name", props.name);
  if (props.placeholder !== undefined) node.setAttribute("placeholder", props.placeholder);
  if (props.rows !== undefined) node.setAttribute("rows", String(props.rows));
  if (props.min !== undefined) node.setAttribute("min", String(props.min));
  if (props.max !== undefined) node.setAttribute("max", String(props.max));
  if (props.step !== undefined) node.setAttribute("step", String(props.step));
  if (props.autocomplete !== undefined) node.setAttribute("autocomplete", props.autocomplete);
  if (props.style !== undefined) node.setAttribute("style", props.style);
  if (props.spellcheck !== undefined) (node as HTMLInputElement).spellcheck = props.spellcheck;
  if (props.disabled !== undefined) (node as HTMLButtonElement).disabled = props.disabled;
  if (props.hidden !== undefined) node.hidden = props.hidden;
  if (props.checked !== undefined) (node as HTMLInputElement).checked = props.checked;
  if (props.value !== undefined) (node as HTMLInputElement).value = String(props.value);
  if (props.text !== undefined) node.textContent = String(props.text);
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.aria) for (const [k, v] of Object.entries(props.aria)) node.setAttribute(`aria-${k}`, v);
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) {
      if (handler) node.addEventListener(name, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function mount(parent: Node, ...children: Child[]): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  append(parent, children);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/* ---- icons ---------------------------------------------------------------
 * A fixed, source-literal set drawn on one 24x24 grid at one stroke weight, so
 * the whole UI reads as a single family. Every icon ships with the `ico` class,
 * which CSS sizes — an icon can never inherit a wild intrinsic size again.
 * ------------------------------------------------------------------------- */

const ICONS: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H17"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  upload: '<path d="M12 20V9m0 0l-4 4m4-4l4 4M5 4h14"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M4.5 7.5l1.8 1M17.7 15.5l1.8 1M4.5 16.5l1.8-1M17.7 8.5l1.8-1M3 12h2.5M18.5 12H21"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  alert: '<path d="M12 4.5L3 20h18L12 4.5z"/><path d="M12 10.5v4M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L19.5 6.5"/>',
  send: '<path d="M20.5 3.5L10.5 13.5M20.5 3.5l-6.4 17-3.6-7-7-3.6 17-6.4z"/>',
  inbox: '<path d="M4 13h4l1.6 2.5h4.8L16 13h4M4 13V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5V13M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13"/>',
  file: '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4h4"/>',
  "file-up": '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4h4"/><path d="M12 17.5v-5m0 0l-2 2m2-2l2 2"/>',
  "file-down": '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4h4"/><path d="M12 12.5v5m0 0l-2-2m2 2l2-2"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6l7-3z"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5l.8 12.2A1.8 1.8 0 0 0 9.1 20.5h5.8a1.8 1.8 0 0 0 1.8-1.8l.8-12.2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.6a5.5 5.5 0 0 1 3 4.9"/>',
  pad: '<rect x="4" y="3.5" width="12" height="15" rx="2"/><path d="M8 8.5h4M8 12h4"/><path d="M8 21.5h9a3 3 0 0 0 3-3v-11"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3.5M15.5 12v2.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>'
};

export function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}

/* ---- the TruePad mark ----------------------------------------------------
 * Two offset sheets: the pad you keep, and the identical copy the other person
 * holds. Filled sheet in the accent, outlined sheet behind it — the whole
 * product in one shape, and simple enough to survive a 16px favicon.
 * ------------------------------------------------------------------------- */

export function brandMark(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "brand-mark");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<rect class="bm-back" x="3.2" y="2.6" width="12.4" height="15.4" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<rect class="bm-front" x="8.4" y="6" width="12.4" height="15.4" rx="3" fill="currentColor"/>' +
    '<path class="bm-rule" d="M11.6 11.3h6M11.6 15.1h3.6" stroke-width="1.6" stroke-linecap="round"/>';
  return svg;
}
