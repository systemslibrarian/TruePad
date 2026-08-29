/* ============================================================================
 * TruePad 2 Browser Edition — Create a pad, and Add a shared pad
 * ----------------------------------------------------------------------------
 * The whole ceremony a normal person needs: a name, a size, and where the
 * randomness comes from — with sensible defaults chosen for them. The frozen
 * knobs (E, N, record mode, rollback witness) live under "Advanced options" and
 * are never required. Generation runs in the worker; the pad is written to this
 * browser's private storage and never uploaded.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout } from "./components.ts";
import { savePadFileButton } from "./courier.ts";
import { writeRole } from "./role.ts";
import type { Ctx } from "./context.ts";
import type { BrowserWitnessClass } from "../engine/protocol.ts";

const AUTH_RECORD_BYTES = 32;
const requiredL = (e: number, n: number): number => 2 * (e + AUTH_RECORD_BYTES * n);

type Preset = { key: "small" | "medium" | "large"; title: string; blurb: string; e: number; n: number };
const PRESETS: Preset[] = [
  { key: "small", title: "Small", blurb: "A few dozen messages.", e: 16384, n: 64 },
  { key: "medium", title: "Medium", blurb: "Hundreds of messages.", e: 262144, n: 512 },
  { key: "large", title: "Large", blurb: "Thousands of messages, room for files.", e: 4194304, n: 4096 }
];

function drbgBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const chunk = 65536;
  for (let i = 0; i < length; i += chunk) crypto.getRandomValues(out.subarray(i, Math.min(i + chunk, length)));
  return out;
}

/* ---- Create ------------------------------------------------------------- */

export async function renderCreate(ctx: Ctx, root: HTMLElement): Promise<void> {
  const state = {
    sizeKey: "medium" as "small" | "medium" | "large" | "custom",
    e: 262144,
    n: 512,
    source: "generate" as "generate" | "file",
    record: "variable" as "variable" | "fixed",
    f: 256,
    witness: "browser-local-witness" as BrowserWitnessClass,
    files: [] as { file: File; origin: string }[]
  };

  const nameInput = h("input", { type: "text", placeholder: "e.g. Chat with Sam", value: "" }) as HTMLInputElement;
  const result = h("div", { class: "section" });
  const customFields = h("div", {});
  const externalFields = h("div", {});
  const createBtn = h("button", { class: "btn primary big", type: "button", on: { click: onCreate } }, icon("plus"), h("span", { text: "Create pad" })) as HTMLButtonElement;
  const validity = h("p", { class: "hint" });

  const eInput = h("input", { type: "number", min: 1, step: 1, value: state.e }) as HTMLInputElement;
  const nInput = h("input", { type: "number", min: 1, step: 1, value: state.n }) as HTMLInputElement;
  const fInput = h("input", { type: "number", min: 32, step: 16, value: state.f }) as HTMLInputElement;
  eInput.addEventListener("input", () => { state.e = Math.floor(Number(eInput.value)) || 0; revalidate(); });
  nInput.addEventListener("input", () => { state.n = Math.floor(Number(nInput.value)) || 0; revalidate(); });
  fInput.addEventListener("input", () => { state.f = Math.floor(Number(fInput.value)) || 0; revalidate(); });

  function sizeCards(): HTMLElement {
    const card = (key: "small" | "medium" | "large" | "custom", title: string, blurb: string) =>
      h(
        "label",
        { class: "choice-card" },
        h("input", { type: "radio", name: "size", checked: state.sizeKey === key, on: { change: () => { state.sizeKey = key; applySize(); } } }),
        h("div", {}, h("div", { class: "choice-title", text: title }), h("div", { class: "choice-desc", text: blurb }))
      );
    return h(
      "div",
      { class: "choice-set" },
      ...PRESETS.map((p) => card(p.key, p.title, p.blurb)),
      card("custom", "Custom", "Choose the exact amounts yourself.")
    );
  }

  function sourceCards(): HTMLElement {
    const card = (key: "generate" | "file", title: string, blurb: string) =>
      h(
        "label",
        { class: "choice-card" },
        h("input", { type: "radio", name: "source", checked: state.source === key, on: { change: () => { state.source = key; paintExternal(); revalidate(); } } }),
        h("div", {}, h("div", { class: "choice-title", text: title }), h("div", { class: "choice-desc", text: blurb }))
      );
    return h(
      "div",
      { class: "choice-set" },
      card("generate", "Generate for me", "TruePad makes the randomness on your device."),
      card("file", "Use my own random file", "Advanced: supply your own random bytes.")
    );
  }

  const fileInput = h("input", { type: "file", attrs: { multiple: "true" } }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    if (fileInput.files) for (const f of Array.from(fileInput.files)) state.files.push({ file: f, origin: "" });
    fileInput.value = "";
    paintExternal();
    revalidate();
  });

  function paintExternal(): void {
    if (state.source !== "file") { mount(externalFields); return; }
    const L = requiredL(state.e, state.n);
    const rows = state.files.map((entry, index) => {
      const short = entry.file.size < L;
      const originInput = h("input", { type: "text", value: entry.origin, placeholder: "Where did these bytes come from?" }) as HTMLInputElement;
      originInput.addEventListener("input", () => { entry.origin = originInput.value; revalidate(); });
      return h(
        "div",
        { class: "source-row" },
        h("div", { class: "sr-head" }, h("span", { class: "sr-name", text: entry.file.name }), h("span", { class: "sr-size", text: short ? "too small" : "ok" })),
        h("div", { class: "field", style: "margin:0" }, h("label", { text: "Where it came from (your note)" }), originInput),
        h("button", { class: "btn small ghost", type: "button", on: { click: () => { state.files.splice(index, 1); paintExternal(); revalidate(); } } }, h("span", { text: "Remove" }))
      );
    });
    mount(
      externalFields,
      callout({ tone: "info", title: "About your own random file", body: "TruePad uses your bytes exactly as given — it does not check where they came from. Provenance is your responsibility; only truly random, secret material makes a secure pad." }),
      h("label", { class: "dropzone", on: { click: () => fileInput.click() } }, h("span", { text: "Choose a random file…" })),
      fileInput,
      state.files.length > 0 ? h("div", { class: "source-list" }, ...rows) : h("p", { class: "hint", text: "No file chosen yet." })
    );
  }

  function advancedPanel(): HTMLElement {
    const recordRow = h(
      "div",
      { class: "choice-set" },
      h("label", { class: "choice-card" }, h("input", { type: "radio", name: "rec", checked: state.record === "variable", on: { change: () => { state.record = "variable"; fField.hidden = true; revalidate(); } } }), h("div", {}, h("div", { class: "choice-title", text: "Variable length" }), h("div", { class: "choice-desc", text: "Default. Ciphertext length equals message length." }))),
      h("label", { class: "choice-card" }, h("input", { type: "radio", name: "rec", checked: state.record === "fixed", on: { change: () => { state.record = "fixed"; fField.hidden = false; revalidate(); } } }), h("div", {}, h("div", { class: "choice-title", text: "Fixed length" }), h("div", { class: "choice-desc", text: "Pad every message to a fixed size to hide its length." })))
    );
    const witnessToggle = h("label", { class: "row" }, h("input", { type: "checkbox", checked: state.witness === "browser-local-witness", on: { change: (e) => { state.witness = (e.target as HTMLInputElement).checked ? "browser-local-witness" : "browser-none"; } } }), h("span", { text: "Keep rollback protection on (recommended)" }));
    return h(
      "details",
      { class: "card advanced-block" },
      h("summary", { text: "Advanced options" }),
      h(
        "div",
        { class: "stack", style: "margin-top:1rem" },
        h("div", { class: "field" }, h("div", { class: "field-label", text: "Message packaging" }), recordRow, fField),
        h("div", { class: "field" }, h("div", { class: "field-label", text: "Rollback protection" }), witnessToggle)
      )
    );
  }

  const fField = h("div", { class: "field" }, h("label", { text: "Fixed size (bytes)" }), fInput);
  fField.hidden = true;

  function applySize(): void {
    if (state.sizeKey !== "custom") {
      const preset = PRESETS.find((p) => p.key === state.sizeKey)!;
      state.e = preset.e;
      state.n = preset.n;
      eInput.value = String(state.e);
      nInput.value = String(state.n);
    }
    customFields.hidden = state.sizeKey !== "custom";
    if (state.source === "file") paintExternal();
    revalidate();
  }

  function problem(): string | null {
    if (!Number.isInteger(state.e) || state.e < 1) return "Enter a positive capacity.";
    if (!Number.isInteger(state.n) || state.n < 1) return "Enter a positive number of messages.";
    if (state.record === "fixed" && (!Number.isInteger(state.f) || state.f < 32 || state.f > state.e)) return "Fixed size must be at least 32 and no more than the capacity.";
    if (state.source === "file") {
      const L = requiredL(state.e, state.n);
      if (state.files.length === 0) return "Add at least one random file.";
      for (const s of state.files) {
        if (s.file.size < L) return `“${s.file.name}” is too small for this size.`;
        if (s.origin.trim().length === 0) return `Add a note about where “${s.file.name}” came from.`;
      }
    }
    return null;
  }

  function revalidate(): void {
    const p = problem();
    createBtn.disabled = p !== null;
    validity.textContent = p ?? "";
  }

  async function onCreate(): Promise<void> {
    const L = requiredL(state.e, state.n);
    let sources: { name: string; declaredOrigin: string; bytes: Uint8Array }[];
    if (state.source === "generate") {
      sources = [{ name: "device-random", declaredOrigin: "Generated by your device's cryptographic random generator (crypto.getRandomValues).", bytes: drbgBytes(L) }];
    } else {
      sources = [];
      for (const s of state.files) sources.push({ name: s.file.name, declaredOrigin: s.origin.trim(), bytes: new Uint8Array(await s.file.arrayBuffer()) });
    }
    createBtn.disabled = true;
    validity.textContent = "Creating…";
    const reply = await ctx.engine.gen({
      label: nameInput.value.trim() || "Untitled pad",
      sources,
      encryptionBytes: state.e,
      authRecords: state.n,
      recordBytes: state.record === "fixed" ? state.f : undefined,
      witnessClass: state.witness
    });
    createBtn.disabled = false;
    validity.textContent = "";
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Could not create the pad", body: reply.message }));
      return;
    }
    // This device created the pad, so it is the first person (role A). The other
    // person's imported copy takes role B — the UI never asks about this.
    const pairId = reply.pair.pairId;
    writeRole(pairId, "A");
    renderCreated(ctx, result, pairId);
    result.scrollIntoView({ behavior: "auto", block: "start" });
  }

  const form = h(
    "div",
    { class: "card stack create-form" },
    h("div", { class: "field" }, h("label", { text: "Name this pad" }), nameInput),
    h("div", { class: "field" }, h("div", { class: "field-label", text: "How much capacity?" }), sizeCards(), customFields),
    h("div", { class: "field" }, h("div", { class: "field-label", text: "Randomness" }), sourceCards(), externalFields),
    advancedPanel(),
    h("div", { class: "btn-row" }, createBtn),
    validity
  );

  mount(customFields, h("div", { class: "field-grid" }, h("div", { class: "field" }, h("label", { text: "Capacity (bytes)" }), eInput), h("div", { class: "field" }, h("label", { text: "Messages" }), nInput)));
  customFields.hidden = true;

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "Home" })),
    h("header", { class: "screen-head" }, h("h1", { text: "Create a pad" }), h("p", { class: "lede", text: "A pad lets two people send secure messages. You'll create it here, then share one copy with the other person." })),
    form,
    result
  );
  applySize();
  paintExternal();
  revalidate();
}

function renderCreated(ctx: Ctx, root: HTMLElement, pairId: string): void {
  mount(
    root,
    h(
      "div",
      { class: "card stack created-card" },
      h("div", { class: "created-head" }, icon("check"), h("h2", { text: "Pad created" })),
      h("p", { text: "To message another person, give them this pad file securely before you start. Hand it over in person, or send it on a channel only the two of you control." }),
      h(
        "div",
        { class: "save-row" },
        savePadFileButton(ctx, pairId, "Save pad for other person"),
        h("p", { class: "save-note", text: "Keep this file secret. It contains the one-time pad." })
      ),
      h("div", { class: "btn-row", style: "margin-top:0.5rem" }, h("button", { class: "btn primary", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Start using TruePad" }), icon("chevron")))
    )
  );
}

/* ---- Add a shared pad (import) ------------------------------------------ */

export async function renderImport(ctx: Ctx, root: HTMLElement): Promise<void> {
  const nameInput = h("input", { type: "text", placeholder: "e.g. Chat with Sam", value: "" }) as HTMLInputElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  const fileNote = h("p", { class: "hint", text: "No pad file chosen." });
  const result = h("div", { class: "section" });
  let bytes: Uint8Array | null = null;

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    if (!f) return;
    bytes = new Uint8Array(await f.arrayBuffer());
    fileNote.textContent = f.name;
  });

  const addBtn = h(
    "button",
    { class: "btn primary big", type: "button", on: { click: onAdd } },
    icon("download"),
    h("span", { text: "Add pad" })
  ) as HTMLButtonElement;

  async function onAdd(): Promise<void> {
    if (!bytes) {
      mount(result, callout({ tone: "warn", title: "Choose a pad file first", body: "Select the pad file the other person shared with you." }));
      return;
    }
    addBtn.disabled = true;
    const container = bytes;
    bytes = null;
    const reply = await ctx.engine.importPair({ label: nameInput.value.trim() || "Untitled pad", container });
    addBtn.disabled = false;
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Could not add this pad", body: reply.message }));
      return;
    }
    // The other person created the pad (first person, role A); this imported
    // copy is the second person, role B. Opposite roles, set automatically.
    writeRole(reply.pair.pairId, "B");
    ctx.toast("Pad added.", "ok");
    ctx.navigate({ name: "pair", pairId: reply.pair.pairId });
  }

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "Home" })),
    h("header", { class: "screen-head" }, h("h1", { text: "Add a shared pad" }), h("p", { class: "lede", text: "Add a pad file that another person created and gave you. Once it's added, the two of you can message each other." })),
    h(
      "div",
      { class: "card stack" },
      callout({ tone: "warn", title: "Only add a pad file you were given directly", body: "The pad file is the shared secret. Add it only if it reached you from the other person over a channel you both control." }),
      h("div", { class: "field" }, h("label", { text: "Name this pad" }), nameInput),
      h("div", { class: "field" }, h("div", { class: "field-label", text: "Pad file" }), fileInput, fileNote),
      h("div", { class: "btn-row" }, addBtn)
    ),
    result
  );
}
