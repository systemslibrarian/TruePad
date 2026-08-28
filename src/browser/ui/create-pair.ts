/* ============================================================================
 * TruePad 2 Browser Edition — Create pair (gen) & Import couriered pad
 * ----------------------------------------------------------------------------
 * Generation is the frozen path: operator source files (or, labelled honestly,
 * the browser DRBG), the exact L = 2·(E + 32·N) required length, no KDF. The
 * wizard states the required length, takes per-source origin declarations as
 * OPERATOR assertions (never auto-claimed), names the witness class with its
 * honest caveat verbatim, prints the verdict verbatim on success, and offers
 * the courier export framed as the pad it is. The second tab imports a pad a
 * peer couriered to this device.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout, kv } from "./components.ts";
import { exportPanel, unpackBundle } from "./courier.ts";
import { fmtBytes, fmtInt } from "./format.ts";
import type { Ctx } from "./context.ts";
import type { BrowserWitnessClass, ManifestView, PairSummary } from "../engine/protocol.ts";

const AUTH_RECORD_BYTES = 32;
const requiredL = (e: number, n: number): number => 2 * (e + AUTH_RECORD_BYTES * n);

// Verbatim §4 caveat for the browser-independent-store class.
const INDEPENDENT_CAVEAT =
  "Rollback protection: browser-local only. This does not provide the same independent rollback witness guarantee as Operational TruePad.";

function drbgBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const chunk = 65536;
  for (let i = 0; i < length; i += chunk) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + chunk, length)));
  }
  return out;
}

type SourceEntry = { file: File; origin: string };

function renderManifest(manifest: ManifestView): HTMLElement {
  return h(
    "div",
    { class: "stack" },
    kv([
      { term: "Pair id", value: manifest.pairId, mono: true },
      { term: "Created", value: manifest.createdAt },
      { term: "Encryption / direction", value: fmtBytes(manifest.encryptionBytesPerDirection) },
      { term: "Auth records / direction", value: fmtInt(manifest.authRecordsPerDirection) },
      { term: "Required source length", value: fmtBytes(manifest.requiredSourceLength) }
    ]),
    h(
      "div",
      { class: "source-list" },
      ...manifest.sources.map((s) =>
        h(
          "div",
          { class: "source-row" },
          h("div", { class: "sr-head" }, h("span", { class: "sr-name", text: s.name }), h("span", { class: "sr-size", text: `${fmtInt(s.lengthBytes)} B · ${fmtInt(s.unusedBytes)} unused` })),
          h("div", { class: "faint", text: `Declared origin: ${s.declaredOrigin}` })
        )
      )
    )
  );
}

/* ---- Generate tab ------------------------------------------------------- */

function generateForm(ctx: Ctx): HTMLElement {
  const state = {
    e: 4096,
    n: 16,
    record: "variable" as "variable" | "fixed",
    f: 256,
    sourceMode: "files" as "files" | "drbg",
    witness: "browser-independent-store" as BrowserWitnessClass,
    sources: [] as SourceEntry[]
  };

  const lDisplay = h("strong", { class: "mono" });
  const filesSection = h("div", {});
  const generateBtn = h("button", { class: "btn primary", type: "button", on: { click: onGenerate } }, icon("plus"), h("span", { text: "Generate pair" })) as HTMLButtonElement;
  const validity = h("p", { class: "hint" });
  const result = h("div", { class: "section" });

  const eInput = h("input", { type: "number", min: 1, step: 1, value: state.e }) as HTMLInputElement;
  const nInput = h("input", { type: "number", min: 1, step: 1, value: state.n }) as HTMLInputElement;
  const fInput = h("input", { type: "number", min: 1, step: 1, value: state.f }) as HTMLInputElement;
  const fField = h("div", { class: "field" }, h("label", { text: "Fixed record size F (bytes)" }), fInput, h("span", { class: "hint", text: "Every record is padded to exactly F bytes, so ciphertext length leaks nothing about message length." }));

  eInput.addEventListener("input", () => { state.e = Math.floor(Number(eInput.value)) || 0; if (state.sourceMode === "files") paintSources(); revalidate(); });
  nInput.addEventListener("input", () => { state.n = Math.floor(Number(nInput.value)) || 0; if (state.sourceMode === "files") paintSources(); revalidate(); });
  fInput.addEventListener("input", () => { state.f = Math.floor(Number(fInput.value)) || 0; revalidate(); });

  function recordRadios(): HTMLElement {
    const mk = (val: "variable" | "fixed", title: string, desc: string) =>
      h(
        "label",
        { class: "radio-card" },
        h("input", { type: "radio", name: "record", checked: state.record === val, on: { change: () => { state.record = val; fField.hidden = val !== "fixed"; revalidate(); } } }),
        h("div", {}, h("div", { class: "rc-title", text: title }), h("div", { class: "rc-desc", text: desc }))
      );
    return h("div", { class: "radio-set" }, mk("variable", "Variable length", "Ciphertext length equals message length — the standard one-time-pad trade-off."), mk("fixed", "Fixed length (F)", "Pad every record to F bytes; hides message length at the cost of spending F bytes per send."));
  }

  function sourceModeRadios(): HTMLElement {
    const mk = (val: "files" | "drbg", title: string, desc: string) =>
      h(
        "label",
        { class: "radio-card" },
        h("input", { type: "radio", name: "smode", checked: state.sourceMode === val, on: { change: () => { state.sourceMode = val; paintSources(); revalidate(); } } }),
        h("div", {}, h("div", { class: "rc-title", text: title }), h("div", { class: "rc-desc", text: desc }))
      );
    return h("div", { class: "radio-set" }, mk("files", "Your own source files", "Serious use. One file is one source; several are XORed. Provenance is your assertion, not verified here — the browser cannot even see that two files alias one underlying file."), mk("drbg", "Browser DRBG (trial)", "Computational random material from the platform DRBG (crypto.getRandomValues) — not information-theoretic entropy. Good for trying the tool; not for material you must protect."));
  }

  function witnessRadios(): HTMLElement {
    const mk = (val: BrowserWitnessClass, title: string, desc: HTMLElement) =>
      h(
        "label",
        { class: "radio-card" },
        h("input", { type: "radio", name: "witness", checked: state.witness === val, on: { change: () => { state.witness = val; } } }),
        h("div", {}, h("div", { class: "rc-title", text: title }), h("div", { class: "rc-desc" }, desc))
      );
    return h(
      "div",
      { class: "radio-set" },
      mk("browser-independent-store", "Independent store (browser-local)", h("span", {}, h("span", { text: `${INDEPENDENT_CAVEAT} ` }), h("span", { class: "faint", text: "It is only as independent as the two stores' clearing and backup are — both live under this origin, and “clear site data” removes both." }))),
      mk("browser-none", "No witness", h("span", { text: "No rollback witness. Restoring a backup of this store would reset the per-record attempt budget; the residual is stated, not hidden." }))
    );
  }

  const fileInput = h("input", { type: "file", attrs: { multiple: "true" } }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) state.sources.push({ file: f, origin: "" });
    }
    fileInput.value = "";
    paintSources();
    revalidate();
  });

  function paintSources(): void {
    if (state.sourceMode === "drbg") {
      mount(
        filesSection,
        callout({ tone: "info", title: "Browser DRBG source", body: `One source of exactly ${fmtBytes(requiredL(state.e, state.n))} will be drawn from crypto.getRandomValues() and labelled as computational material — not information-theoretic entropy.` })
      );
      return;
    }
    const rows = state.sources.map((entry, index) => {
      const L = requiredL(state.e, state.n);
      const short = entry.file.size < L;
      const originInput = h("input", { type: "text", value: entry.origin, placeholder: "e.g. Hardware RNG dump, 2025-08, device #3" }) as HTMLInputElement;
      originInput.addEventListener("input", () => { entry.origin = originInput.value; revalidate(); });
      return h(
        "div",
        { class: "source-row" },
        h(
          "div",
          { class: "sr-head" },
          h("span", { class: "sr-name", text: entry.file.name }),
          h("span", { class: "sr-size", text: short ? `${fmtInt(entry.file.size)} B — too short` : `${fmtInt(entry.file.size)} B · ${fmtInt(entry.file.size - L)} unused` })
        ),
        short ? h("div", { class: "co-reason", style: "color:var(--danger)", text: `needs at least ${fmtInt(L)} bytes` }) : null,
        h("div", { class: "field", style: "margin:0" }, h("label", { text: "Declared origin (your assertion)" }), originInput),
        h("div", {}, h("button", { class: "btn small ghost", type: "button", on: { click: () => { state.sources.splice(index, 1); paintSources(); revalidate(); } } }, h("span", { text: "Remove" })))
      );
    });
    mount(
      filesSection,
      h("label", { class: "dropzone", on: { click: () => fileInput.click() } }, h("span", { text: "Choose source files… (each must be at least the required length)" })),
      fileInput,
      state.sources.length > 0 ? h("div", { class: "source-list" }, ...rows) : h("p", { class: "hint", text: "No source files selected yet." })
    );
  }

  function currentValidity(): string | null {
    if (!Number.isInteger(state.e) || state.e < 1) return "Encryption budget must be a positive whole number of bytes.";
    if (!Number.isInteger(state.n) || state.n < 1) return "Auth-record budget must be a positive whole number.";
    if (state.record === "fixed") {
      if (!Number.isInteger(state.f) || state.f < 1) return "Fixed record size F must be a positive whole number.";
      if (state.f > state.e) return "Fixed record size F cannot exceed the encryption budget.";
    }
    const L = requiredL(state.e, state.n);
    if (state.sourceMode === "files") {
      if (state.sources.length === 0) return "Add at least one source file.";
      for (const s of state.sources) {
        if (s.file.size < L) return `“${s.file.name}” is shorter than the required ${fmtInt(L)} bytes.`;
        if (s.origin.trim().length === 0) return `Declare an origin for “${s.file.name}”.`;
      }
    }
    return null;
  }

  function revalidate(): void {
    const L = requiredL(state.e, state.n);
    lDisplay.textContent = `${fmtBytes(L)}`;
    const problem = currentValidity();
    generateBtn.disabled = problem !== null;
    validity.textContent = problem ?? "Ready to generate. Both directions are created at once.";
  }

  async function onGenerate(): Promise<void> {
    const L = requiredL(state.e, state.n);
    let sources: { name: string; declaredOrigin: string; bytes: Uint8Array }[];
    if (state.sourceMode === "drbg") {
      sources = [{ name: "browser-drbg", declaredOrigin: "Computational random material from the browser/platform DRBG (crypto.getRandomValues) — not information-theoretic entropy.", bytes: drbgBytes(L) }];
    } else {
      sources = [];
      for (const s of state.sources) {
        sources.push({ name: s.file.name, declaredOrigin: s.origin.trim(), bytes: new Uint8Array(await s.file.arrayBuffer()) });
      }
    }
    generateBtn.disabled = true;
    const reply = await ctx.engine.gen({
      label: labelInput.value.trim(),
      sources,
      encryptionBytes: state.e,
      authRecords: state.n,
      recordBytes: state.record === "fixed" ? state.f : undefined,
      witnessClass: state.witness
    });
    generateBtn.disabled = false;
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Generation refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
      return;
    }
    const pair: PairSummary = reply.pair;
    ctx.toast("Pair generated. Courier a copy to your peer.", "ok");
    mount(
      result,
      callout({ tone: "ok", title: "Pair generated", body: h("div", { class: "stack-sm" }, h("p", { text: "Both directions were created and written to this browser's private storage." }), h("p", { class: "mono", text: pair.pairId })) }),
      h("div", { class: "card stack" }, h("h3", { text: "Manifest" }), renderManifest(reply.manifest)),
      h("div", { class: "card stack" }, h("h3", { text: "Uniformity verdict" }), callout({ tone: "info", title: "The combiner's verdict (verbatim)", body: reply.verdict })),
      h("div", { class: "card stack" }, h("h3", { text: "Courier this pad to your peer" }), exportPanel(ctx, pair.pairId)),
      h("div", { class: "btn-row", style: "margin-top:0.5rem" }, h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId: pair.pairId }) } }, h("span", { text: "Open dashboard" })))
    );
    result.scrollIntoView({ behavior: "auto", block: "start" });
  }

  const labelInput = h("input", { type: "text", placeholder: "e.g. Bridge channel — Alice & Bob", value: "" }) as HTMLInputElement;

  const form = h(
    "div",
    { class: "card stack" },
    h("div", { class: "field" }, h("label", { text: "Label (non-secret, for you)" }), labelInput),
    h(
      "div",
      { class: "field-grid" },
      h("div", { class: "field" }, h("label", { text: "Encryption budget E (bytes / direction)" }), eInput),
      h("div", { class: "field" }, h("label", { text: "Auth-record budget N (records / direction)" }), nInput)
    ),
    h("div", { class: "field" }, h("div", { class: "field-label", text: "Record mode" }), recordRadios(), fField),
    h("p", { class: "muted" }, h("span", { text: "Required source length: " }), lDisplay, h("span", { text: " per source — that is L = 2·(E + 32·N)." })),
    h("div", { class: "field" }, h("div", { class: "field-label", text: "Source material" }), sourceModeRadios(), filesSection),
    h("div", { class: "field" }, h("div", { class: "field-label", text: "Rollback witness" }), witnessRadios()),
    h("div", { class: "btn-row" }, generateBtn),
    validity
  );

  fField.hidden = true;
  paintSources();
  revalidate();

  return h("div", { class: "stack" }, form, result);
}

/* ---- Import tab --------------------------------------------------------- */

function importForm(ctx: Ctx): HTMLElement {
  const labelInput = h("input", { type: "text", placeholder: "A label for this imported pad" }) as HTMLInputElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  const result = h("div", { class: "section" });
  let bytes: Uint8Array | null = null;
  const fileNote = h("p", { class: "hint", text: "No bundle chosen." });

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    if (!f) return;
    bytes = new Uint8Array(await f.arrayBuffer());
    fileNote.textContent = `${f.name} · ${fmtBytes(f.size)}`;
  });

  const importBtn = h(
    "button",
    {
      class: "btn primary",
      type: "button",
      on: {
        click: async () => {
          if (!bytes) {
            mount(result, callout({ tone: "warn", title: "Choose a bundle file first", body: "Select the .pad.json your peer couriered to you." }));
            return;
          }
          let bundle;
          try {
            bundle = unpackBundle(bytes);
          } catch (err) {
            mount(result, callout({ tone: "danger", title: "Not a pad bundle", body: err instanceof Error ? err.message : String(err) }));
            return;
          }
          importBtn.setAttribute("disabled", "true");
          const reply = await ctx.engine.importPair({ label: labelInput.value.trim(), bundle });
          importBtn.removeAttribute("disabled");
          if (!reply.ok) {
            mount(result, callout({ tone: "danger", title: "Import refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
            return;
          }
          ctx.toast("Pad imported.", "ok");
          ctx.navigate({ name: "pair", pairId: reply.pair.pairId });
        }
      }
    },
    icon("download"),
    h("span", { text: "Import pad" })
  );

  return h(
    "div",
    { class: "stack" },
    callout({ tone: "warn", title: "You are importing pad material", body: "This installs a couriered pad into this browser's private storage. Only import a bundle a peer delivered to you out of band; the file is the shared secret." }),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "field" }, h("label", { text: "Label" }), labelInput),
      h("div", { class: "field" }, h("div", { class: "field-label", text: "Pad bundle file" }), fileInput, fileNote),
      h("div", { class: "btn-row" }, importBtn)
    ),
    result
  );
}

export async function renderCreate(ctx: Ctx, root: HTMLElement): Promise<void> {
  let tab: "generate" | "import" = "generate";
  const body = h("div", {});

  function paintTabs(): HTMLElement {
    const mk = (val: "generate" | "import", label: string) =>
      h("button", { class: val === tab ? "btn small primary" : "btn small ghost", type: "button", aria: { pressed: String(val === tab) }, on: { click: () => { tab = val; paint(); } } }, h("span", { text: label }));
    return h("div", { class: "btn-row" }, mk("generate", "Generate new"), mk("import", "Import couriered pad"));
  }

  function paint(): void {
    mount(body, tab === "generate" ? generateForm(ctx) : importForm(ctx));
    mount(tabs, paintTabs());
  }

  const tabs = h("div", { style: "margin-bottom:1.25rem" });

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "All pairs" })),
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: "New pair" }),
      h("h1", { text: "Create a pair" }),
      h("p", { class: "lede", text: "Generation builds both one-time pads at once from your source material. It runs entirely in the worker; the pad is written to this browser's private storage and never uploaded." })
    ),
    tabs,
    body
  );
  paint();
}
