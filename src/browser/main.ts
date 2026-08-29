/* ============================================================================
 * TruePad 2 Browser Edition — application entry
 * ----------------------------------------------------------------------------
 * Spawns the crypto engine in a dedicated module Web Worker and talks to it
 * over an id-keyed RPC: every request carries an `id`, the worker replies with
 * the same `id`, and a Map of pending {resolve,reject} matches replies to
 * callers. This module is the security boundary's UI side — it sends requests
 * and renders replies, but never reads a pad byte, key, mask, or journal: those
 * live only in the worker and its OPFS store. Uint8Array payloads bound for the
 * worker are transferred (detaching the UI's copy), so plaintext and source
 * bytes do not linger on this thread.
 *
 * The rest is a tiny hash router, a theme controller, and a toast tray. No
 * framework — plain TS + DOM.
 * ========================================================================= */

import "./style.css";
import { brandMark, h, icon, mount } from "./ui/dom.ts";
import type { Ctx, Engine, Reply, Route, ToastTone } from "./ui/context.ts";
import type { EngineRequest, EngineResponse } from "./engine/protocol.ts";
import { renderHome } from "./ui/home.ts";
import { renderDashboard } from "./ui/dashboard.ts";
import { renderCreate, renderImport } from "./ui/create-pair.ts";
import { renderSend } from "./ui/send.ts";
import { renderOpen } from "./ui/open.ts";
import { renderDestroy } from "./ui/destroy.ts";
import { renderSecurity } from "./ui/security-status.ts";

/* ---- worker RPC client -------------------------------------------------- */

type Pending = { resolve: (r: EngineResponse) => void; reject: (e: unknown) => void };

function collectTransfers(value: unknown, acc: Set<ArrayBuffer>): void {
  if (value === null || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) {
    acc.add((value as ArrayBufferView).buffer as ArrayBuffer);
    return;
  }
  if (value instanceof ArrayBuffer) {
    acc.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTransfers(v, acc);
    return;
  }
  for (const v of Object.values(value)) collectTransfers(v, acc);
}

class WorkerEngine implements Engine {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor() {
    this.#worker = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as EngineResponse;
      const pending = this.#pending.get(data.id);
      if (!pending) return;
      this.#pending.delete(data.id);
      pending.resolve(data);
    });
    this.#worker.addEventListener("error", (ev) => this.#failAll(ev.message || "worker error"));
    this.#worker.addEventListener("messageerror", () => this.#failAll("worker message error"));
  }

  #failAll(message: string): void {
    for (const [, pending] of this.#pending) pending.reject(new Error(message));
    this.#pending.clear();
  }

  #call(payload: Omit<EngineRequest, "id">): Promise<EngineResponse> {
    const id = this.#nextId++;
    const request = { ...payload, id } as EngineRequest;
    const transfers = new Set<ArrayBuffer>();
    collectTransfers(request, transfers);
    return new Promise<EngineResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage(request, [...transfers]);
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  listPairs(): Promise<Reply<"list-pairs">> {
    return this.#call({ op: "list-pairs" }) as Promise<Reply<"list-pairs">>;
  }
  status(args: { pairId: string }): Promise<Reply<"status">> {
    return this.#call({ op: "status", ...args }) as Promise<Reply<"status">>;
  }
  gen(args: Parameters<Engine["gen"]>[0]): Promise<Reply<"gen">> {
    return this.#call({ op: "gen", ...args }) as Promise<Reply<"gen">>;
  }
  burn(args: Parameters<Engine["burn"]>[0]): Promise<Reply<"burn">> {
    return this.#call({ op: "burn", ...args }) as Promise<Reply<"burn">>;
  }
  open(args: Parameters<Engine["open"]>[0]): Promise<Reply<"open">> {
    return this.#call({ op: "open", ...args }) as Promise<Reply<"open">>;
  }
  retire(args: Parameters<Engine["retire"]>[0]): Promise<Reply<"retire">> {
    return this.#call({ op: "retire", ...args }) as Promise<Reply<"retire">>;
  }
  clearFreeze(args: { pairId: string }): Promise<Reply<"clear-freeze">> {
    return this.#call({ op: "clear-freeze", ...args }) as Promise<Reply<"clear-freeze">>;
  }
  destroy(args: Parameters<Engine["destroy"]>[0]): Promise<Reply<"destroy">> {
    return this.#call({ op: "destroy", ...args }) as Promise<Reply<"destroy">>;
  }
  exportPair(args: { pairId: string }): Promise<Reply<"export-pair">> {
    return this.#call({ op: "export-pair", ...args }) as Promise<Reply<"export-pair">>;
  }
  importPair(args: Parameters<Engine["importPair"]>[0]): Promise<Reply<"import-pair">> {
    return this.#call({ op: "import-pair", ...args }) as Promise<Reply<"import-pair">>;
  }
}

/* ---- theme -------------------------------------------------------------- */

const THEME_KEY = "truepad2:theme";
const root = document.documentElement;

function storedTheme(): "light" | "dark" | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

const systemDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;
const effectiveDark = (): boolean => {
  const s = storedTheme();
  return s ? s === "dark" : systemDark();
};

function applyTheme(themeBtn?: HTMLElement): void {
  const s = storedTheme();
  if (s) root.setAttribute("data-theme", s);
  else root.removeAttribute("data-theme");
  const dark = effectiveDark();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0c0d10" : "#f7f8fa");
  if (themeBtn) {
    mount(themeBtn, icon(dark ? "sun" : "moon"));
    themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    themeBtn.setAttribute("title", dark ? "Light theme" : "Dark theme");
  }
}

function toggleTheme(themeBtn: HTMLElement): void {
  const next = effectiveDark() ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* the toggle still applies for this session via the attribute below */
    root.setAttribute("data-theme", next);
  }
  applyTheme(themeBtn);
}

/* ---- storage persistence probe ----------------------------------------- */

async function probePersistent(): Promise<boolean | null> {
  if (!navigator.storage || !navigator.storage.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

async function requestPersistent(): Promise<boolean> {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/* ---- shell -------------------------------------------------------------- */

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

const mainEl = h("main", { class: "main", id: "app-main", attrs: { tabindex: "-1" } });
const bannerSlot = h("div", {});
const toastTray = h("div", { class: "toast-tray", aria: { live: "polite" }, attrs: { role: "status" } });

let themeBtn!: HTMLElement;

function buildShell(navigate: (r: Route) => void): void {
  themeBtn = h("button", { class: "icon-btn", type: "button", on: { click: () => toggleTheme(themeBtn) } });
  // Three audiences, kept apart: Use (the brand -> home), Learn (the exhibit),
  // and Advanced (security details & expert config). No security jargon up top.
  const navHow = h("a", { href: "learn.html" }, h("span", { text: "Learn" }));
  const navAdvanced = h("a", {
    href: "#/advanced",
    on: { click: (e) => { e.preventDefault(); navigate({ name: "security" }); } }
  }, h("span", { text: "Security" }));

  const brand = h(
    "a",
    { class: "brand", href: "#/", aria: { label: "TruePad home" }, on: { click: (e) => { e.preventDefault(); navigate({ name: "home" }); } } },
    brandMark(),
    h("span", { class: "brand-word", text: "TruePad" })
  );

  const topbar = h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "topbar-inner" },
      brand,
      h("div", { class: "topbar-spacer" }),
      h("nav", { class: "topnav", aria: { label: "Primary" } }, navHow, navAdvanced),
      themeBtn
    )
  );

  const footer = h(
    "footer",
    { class: "footer" },
    h(
      "div",
      { class: "footer-inner" },
      h("span", { text: "Runs entirely on your device. No account, nothing uploaded." }),
      h("span", { class: "topbar-spacer" }),
      h("a", { href: "learn.html" }, h("span", { text: "Learn" })),
      h("a", { href: "https://github.com/systemslibrarian/TruePad", attrs: { target: "_blank", rel: "noreferrer noopener" } }, h("span", { text: "Source" }))
    )
  );

  const skip = h("a", { class: "skip-link", href: "#app-main" }, h("span", { text: "Skip to content" }));

  mount(app!, skip, h("div", { class: "app" }, topbar, bannerSlot, mainEl, footer), toastTray);
  applyTheme(themeBtn);
}

/* ---- toasts ------------------------------------------------------------- */

function toast(message: string, tone: ToastTone = "info"): void {
  const node = h("div", { class: `toast ${tone}`, text: message });
  toastTray.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

/* ---- router ------------------------------------------------------------- */

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "create") return { name: "create" };
  if (parts[0] === "import") return { name: "import" };
  if (parts[0] === "security" || parts[0] === "advanced") return { name: "security" };
  if (parts[0] === "pair" && parts[1]) {
    const pairId = decodeURIComponent(parts[1]);
    const mode: "message" | "file" = parts[3] === "file" ? "file" : "message";
    if (parts[2] === "send") return { name: "send", pairId, mode };
    if (parts[2] === "open") return { name: "open", pairId, mode };
    if (parts[2] === "destroy") return { name: "destroy", pairId };
    return { name: "pair", pairId };
  }
  return { name: "home" };
}

function formatHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "create":
      return "#/create";
    case "import":
      return "#/import";
    case "security":
      return "#/advanced";
    case "pair":
      return `#/pair/${encodeURIComponent(route.pairId)}`;
    case "send":
      return `#/pair/${encodeURIComponent(route.pairId)}/send/${route.mode}`;
    case "open":
      return `#/pair/${encodeURIComponent(route.pairId)}/open/${route.mode}`;
    case "destroy":
      return `#/pair/${encodeURIComponent(route.pairId)}/destroy`;
  }
}

/* ---- framed-context gate ------------------------------------------------ */

// The operational UI refuses to run inside a frame. A cross-origin embedder is
// a clickjacking surface, and — unlike the CLI's host — a static GitHub Pages
// deployment cannot send an HTTP `frame-ancestors` / `X-Frame-Options` header,
// and `frame-ancestors` is NOT enforceable from a <meta> CSP. So this runtime
// check is the actual enforcement point: if we are not the top-level document,
// we never start the worker and never render the operational UI.
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on the comparison — which itself means we are
    // embedded. Treat the exception as "framed".
    return true;
  }
}

function renderFramedRefusal(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const glyph = icon("alert");
  glyph.classList.add("co-icon");
  mount(
    root,
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "screen" },
        h(
          "div",
          { class: "callout danger", role: "alert" },
          glyph,
          h("div", { class: "co-title", text: "TruePad will not run inside a frame" }),
          h(
            "div",
            { class: "co-body" },
            h("p", { text: "This page is embedded in another document. The operational TruePad UI refuses to start in a frame: a framed context is a clickjacking surface, and it will not touch pad material there." }),
            h("p", { text: "Open TruePad directly in a top-level browser tab. Enforcing this from the server would take an HTTP frame-ancestors or X-Frame-Options header, which the default GitHub Pages deployment cannot send and a meta CSP cannot supply — so this check does it at runtime instead." })
          )
        )
      )
    )
  );
}

async function bootstrap(): Promise<void> {
  if (isFramed()) {
    renderFramedRefusal();
    return;
  }
  const engine = new WorkerEngine();

  const navigate = (route: Route): void => {
    const next = formatHash(route);
    if (location.hash === next) void render();
    else location.hash = next;
  };

  buildShell(navigate);

  // Storage persistence is surfaced under Advanced (Security & limitations), not
  // as a home-screen warning banner — the simple UI is not warning-heavy.
  const persistent = await probePersistent();

  const ctx: Ctx = {
    engine,
    navigate,
    toast,
    storagePersistent: persistent,
    requestPersistent
  };

  async function render(): Promise<void> {
    const route = parseHash();
    mount(mainEl, h("div", { class: "screen" }, h("p", { class: "faint", text: "Loading…" })));
    try {
      switch (route.name) {
        case "home":
          await renderHome(ctx, mainEl);
          break;
        case "create":
          await renderCreate(ctx, mainEl);
          break;
        case "import":
          await renderImport(ctx, mainEl);
          break;
        case "pair":
          await renderDashboard(ctx, mainEl, route.pairId);
          break;
        case "send":
          await renderSend(ctx, mainEl, route.pairId, route.mode);
          break;
        case "open":
          await renderOpen(ctx, mainEl, route.pairId, route.mode);
          break;
        case "destroy":
          await renderDestroy(ctx, mainEl, route.pairId);
          break;
        case "security":
          await renderSecurity(ctx, mainEl);
          break;
      }
    } catch (err) {
      const glyph = icon("alert");
      glyph.classList.add("co-icon");
      mount(
        mainEl,
        h(
          "div",
          { class: "screen" },
          h(
            "div",
            { class: "callout danger", role: "alert" },
            glyph,
            h("div", { class: "co-title", text: "Something went wrong" }),
            h("div", { class: "co-body", text: err instanceof Error ? err.message : String(err) })
          )
        )
      );
    }
    mainEl.focus();
  }

  window.addEventListener("hashchange", () => void render());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themeBtn));
  await render();
}

void bootstrap();
