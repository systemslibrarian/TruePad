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

/* ---- icons: fixed, neutral, source-literal SVG. No locks or shields. ----- */

const ICONS: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M4.5 7.5l1.8 1M17.7 15.5l1.8 1M4.5 16.5l1.8-1M17.7 8.5l1.8-1M3 12h2.5M18.5 12H21"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  alert: '<path d="M12 3L2 20h20L12 3z"/><path d="M12 10v5M12 18h.01"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  send: '<path d="M4 12l16-8-6 16-3-6-7-2z"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'
};

export function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}
