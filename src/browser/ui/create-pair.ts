/* ============================================================================
 * TruePad Browser Edition — Create a pad, and Add a shared pad
 * ----------------------------------------------------------------------------
 * The whole ceremony a normal person needs: a name, a size, Create. Everything
 * else — where the randomness comes from, exact capacity, message packaging,
 * rollback protection — is real, unchanged, and collapsed behind Advanced
 * options, because none of it is required to make a good pad. Generation runs
 * in the worker; the pad is written to this browser's private storage and is
 * never uploaded.
 *
 * Creating succeeds into its own screen rather than appending a card below a
 * still-live form: handing over the pad file is the one step that decides
 * whether any of this works, so it gets the screen to itself.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { backLink, callout, choice, filePicker, panel, screenHead } from "./components.ts";
import { savePadFileButton } from "./courier.ts";
import { fmtInt } from "./format.ts";
import { writeRole } from "./role.ts";
import type { Ctx } from "./context.ts";
import type { BrowserWitnessClass } from "../engine/protocol.ts";

const AUTH_RECORD_BYTES = 32;
const requiredL = (e: number, n: number): number => 2 * (e + AUTH_RECORD_BYTES * n);

type SizeKey = "small" | "medium" | "large";
type Preset = { key: SizeKey; title: string; blurb: string; e: number; n: number };

// e = encryption bytes per direction, n = authentication records per direction.
// n is the hard ceiling on messages sent in one direction, so "up to n
// messages each way" is a true statement of the cap, not a rounded promise.
const PRESETS: Preset[] = [
  { key: "small", title: "Small", blurb: "Occasional messages.", e: 16384, n: 64 },
  { key: "medium", title: "Medium", blurb: "Regular conversation.", e: 262144, n: 512 },
  { key: "large", title: "Large", blurb: "Messages and files.", e: 4194304, n: 4096 }
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
    sizeKey: "medium" as SizeKey,
    custom: false,
    e: 262144,
    n: 512,
    source: "generate" as "generate" | "file",
    record: "variable" as "variable" | "fixed",
    f: 256,
    witness: "browser-local-witness" as BrowserWitnessClass,
    files: [] as { file: File; origin: string }[]
  };

  const nameInput = h("input", { type: "text", placeholder: "e.g. Chat with Sam", value: "" }) as HTMLInputElement;
  const sizeSlot = h("div", { class: "choice-set" });
  const sourceSlot = h("div", { class: "choice-set" });
  const externalFields = h("div", { class: "stack" });
  const customFields = h("div", { class: "field-grid" });
  const errorSlot = h("div", {});
  const validity = h("p", { class: "hint" });
  const createBtn = h("button", { class: "btn primary lg", type: "button", on: { click: onCreate } }, h("span", { text: "Create pad" })) as HTMLButtonElement;

  const eInput = h("input", { type: "number", min: 1, step: 1, value: state.e }) as HTMLInputElement;
  const nInput = h("input", { type: "number", min: 1, step: 1, value: state.n }) as HTMLInputElement;
  const fInput = h("input", { type: "number", min: 32, step: 16, value: state.f }) as HTMLInputElement;
  eInput.addEventListener("input", () => { state.e = Math.floor(Number(eInput.value)) || 0; revalidate(); });
  nInput.addEventListener("input", () => { state.n = Math.floor(Number(nInput.value)) || 0; revalidate(); });
  fInput.addEventListener("input", () => { state.f = Math.floor(Number(fInput.value)) || 0; revalidate(); });

  const fField = h("div", { class: "field" }, h("label", { text: "Fixed size (bytes)" }), fInput);
  fField.hidden = true;

  const customToggle = h("input", {
    type: "checkbox",
    on: { change: (e) => { state.custom = (e.target as HTMLInputElement).checked; applySize(); } }
  }) as HTMLInputElement;

  function paintSizes(): void {
    mount(
      sizeSlot,
      ...PRESETS.map((p) =>
        choice({
          name: "size",
          title: p.title,
          desc: `${p.blurb} Up to ${fmtInt(p.n)} messages each way.`,
          checked: !state.custom && state.sizeKey === p.key,
          onSelect: () => {
            state.sizeKey = p.key;
            state.custom = false;
            customToggle.checked = false;
            applySize();
          }
        })
      )
    );
  }

  function paintSources(): void {
    mount(
      sourceSlot,
      choice({
        name: "source",
        title: "Generate for me",
        desc: "TruePad makes the randomness on your device.",
        checked: state.source === "generate",
        onSelect: () => { state.source = "generate"; paintSources(); paintExternal(); revalidate(); }
      }),
      choice({
        name: "source",
        title: "Use my own random file",
        desc: "Supply your own random bytes instead.",
        checked: state.source === "file",
        onSelect: () => { state.source = "file"; paintSources(); paintExternal(); revalidate(); }
      })
    );
  }

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
        h(
          "div",
          { class: "sr-head" },
          h("span", { class: "sr-name", text: entry.file.name }),
          h("span", { class: short ? "sr-size bad" : "sr-size", text: short ? "too small" : "ok" })
        ),
        h("div", { class: "field" }, h("label", { text: "Where it came from (your note)" }), originInput),
        h(
          "button",
          { class: "btn sm ghost", type: "button", on: { click: () => { state.files.splice(index, 1); paintExternal(); revalidate(); } } },
          h("span", { text: "Remove" })
        )
      );
    });
    const picker = filePicker({
      action: "Choose a random file",
      hint: "Any file of truly random, secret bytes",
      multiple: true,
      onChange: (files) => {
        for (const f of files) state.files.push({ file: f, origin: "" });
        picker.input.value = "";
        picker.setName(null);
        paintExternal();
        revalidate();
      }
    });
    mount(
      externalFields,
      callout({
        tone: "info",
        title: "TruePad uses your bytes exactly as given",
        body: "It does not check where they came from. Provenance is your responsibility; only truly random, secret material makes a secure pad."
      }),
      picker.el,
      state.files.length > 0 ? h("div", { class: "source-list" }, ...rows) : null
    );
  }

  function applySize(): void {
    if (!state.custom) {
      const preset = PRESETS.find((p) => p.key === state.sizeKey)!;
      state.e = preset.e;
      state.n = preset.n;
      eInput.value = String(state.e);
      nInput.value = String(state.n);
    }
    customFields.hidden = !state.custom;
    paintSizes();
    if (state.source === "file") paintExternal();
    revalidate();
  }

  function problem(): string | null {
    if (!Number.isInteger(state.e) || state.e < 1) return "Enter a positive capacity.";
    if (!Number.isInteger(state.n) || state.n < 1) return "Enter a positive number of messages.";
    if (state.record === "fixed" && (!Number.isInteger(state.f) || state.f < 32 || state.f > state.e)) {
      return "Fixed size must be at least 32 and no more than the capacity.";
    }
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
      sources = [{
        name: "device-random",
        declaredOrigin: "Generated by your device's cryptographic random generator (crypto.getRandomValues).",
        bytes: drbgBytes(L)
      }];
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
      mount(errorSlot, callout({ tone: "danger", title: "Could not create the pad", body: reply.message }));
      return;
    }
    // This device created the pad, so it is the first person (role A). The other
    // person's imported copy takes role B — the UI never asks about this.
    const pairId = reply.pair.pairId;
    writeRole(pairId, "A");
    renderCreated(ctx, root, pairId);
  }

  const advanced = panel(
    "Advanced options",
    {},
    h("div", { class: "field" }, h("div", { class: "field-label", text: "Randomness" }), sourceSlot, externalFields),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-label", text: "Capacity" }),
      h("label", { class: "confirm-row" }, customToggle, h("span", { text: "Set the exact capacity myself" })),
      customFields
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-label", text: "Message packaging" }),
      h(
        "div",
        { class: "choice-set" },
        h(
          "label",
          { class: "choice" },
          h("input", { type: "radio", name: "rec", checked: state.record === "variable", on: { change: () => { state.record = "variable"; fField.hidden = true; revalidate(); } } }),
          h("span", { class: "choice-body" }, h("span", { class: "choice-title", text: "Variable length" }), h("span", { class: "choice-desc", text: "Default. The encrypted message is as long as the message." }))
        ),
        h(
          "label",
          { class: "choice" },
          h("input", { type: "radio", name: "rec", checked: state.record === "fixed", on: { change: () => { state.record = "fixed"; fField.hidden = false; revalidate(); } } }),
          h("span", { class: "choice-body" }, h("span", { class: "choice-title", text: "Fixed length" }), h("span", { class: "choice-desc", text: "Pad every message to one size, so its length reveals nothing." }))
        )
      ),
      fField
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-label", text: "Rollback protection" }),
      h(
        "label",
        { class: "confirm-row" },
        h("input", { type: "checkbox", checked: state.witness === "browser-local-witness", on: { change: (e) => { state.witness = (e.target as HTMLInputElement).checked ? "browser-local-witness" : "browser-none"; } } }),
        h("span", { text: "Keep rollback protection on (recommended)" })
      )
    )
  );

  mount(
    customFields,
    h("div", { class: "field" }, h("label", { text: "Capacity (bytes)" }), eInput),
    h("div", { class: "field" }, h("label", { text: "Messages" }), nInput)
  );

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "home" }), "Home"),
      screenHead({
        title: "Create a pad",
        lede: "A pad lets two people message each other privately. You make it here, then share one copy with the other person."
      }),
      h(
        "div",
        { class: "card" },
        h("div", { class: "field" }, h("label", { text: "Name this pad" }), nameInput),
        h(
          "div",
          { class: "field" },
          h("div", { class: "field-label", text: "How much capacity?" }),
          sizeSlot,
          h("p", { class: "hint", text: "Capacity is fixed when the pad is created and cannot be topped up later." })
        ),
        advanced,
        h("div", { class: "btn-row" }, createBtn),
        validity
      ),
      errorSlot
    )
  );
  paintSizes();
  paintSources();
  applySize();
  paintExternal();
  revalidate();
}

/* ---- the courier ceremony ----------------------------------------------- */

function renderCreated(ctx: Ctx, root: HTMLElement, pairId: string): void {
  const startBtn = h(
    "button",
    { class: "btn lg", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } },
    h("span", { text: "Start using TruePad" }),
    icon("chevron")
  ) as HTMLButtonElement;

  const saveBtn = savePadFileButton(ctx, pairId, "Save pad for other person", {
    variant: "primary lg",
    onSaved: () => {
      // Once the pad file exists on disk, the next step is no longer saving it.
      saveBtn.className = "btn lg";
      startBtn.className = "btn primary lg";
    }
  });

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      h("div", { class: "ok-head" }, icon("check"), h("h1", { text: "Pad created" })),
      h("p", { class: "muted", text: "One thing left: give the other person their copy. Until they have it, neither of you can read anything the other sends." }),
      callout({
        tone: "warn",
        title: "The pad file is the secret",
        body: "Anyone who holds it can read and forge this pad's messages. Hand it over in person, or send it on a channel only the two of you control — never email, upload, or sync it."
      }),
      h("div", { class: "btn-row" }, saveBtn),
      h("hr", { class: "divider" }),
      h("div", { class: "btn-row" }, startBtn)
    )
  );
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ---- Add a shared pad (import) ------------------------------------------ */

export async function renderImport(ctx: Ctx, root: HTMLElement): Promise<void> {
  const nameInput = h("input", { type: "text", placeholder: "e.g. Chat with Sam", value: "" }) as HTMLInputElement;
  const errorSlot = h("div", {});
  let bytes: Uint8Array | null = null;

  const picker = filePicker({
    action: "Choose the pad file",
    hint: "The file the other person gave you",
    onChange: async (files) => {
      const f = files[0];
      if (!f) return;
      bytes = new Uint8Array(await f.arrayBuffer());
    }
  });

  const addBtn = h(
    "button",
    { class: "btn primary lg", type: "button", on: { click: onAdd } },
    h("span", { text: "Add pad" })
  ) as HTMLButtonElement;

  async function onAdd(): Promise<void> {
    if (!bytes) {
      mount(errorSlot, callout({ tone: "warn", title: "Choose a pad file first", body: "Select the pad file the other person shared with you." }));
      return;
    }
    addBtn.disabled = true;
    const container = bytes;
    bytes = null;
    const reply = await ctx.engine.importPair({ label: nameInput.value.trim() || "Untitled pad", container });
    addBtn.disabled = false;
    if (!reply.ok) {
      mount(errorSlot, callout({ tone: "danger", title: "Could not add this pad", body: reply.message }));
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
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "home" }), "Home"),
      screenHead({
        title: "Add a shared pad",
        lede: "Add a pad file another person created and gave you. Once it is added, the two of you can message each other."
      }),
      h(
        "div",
        { class: "card" },
        callout({
          tone: "warn",
          title: "Only add a pad file you were given directly",
          body: "The pad file is the shared secret. Add it only if it reached you from the other person over a channel you both control."
        }),
        h("div", { class: "field" }, h("label", { text: "Name this pad" }), nameInput),
        h("div", { class: "field" }, h("div", { class: "field-label", text: "Pad file" }), picker.el),
        h("div", { class: "btn-row" }, addBtn)
      ),
      errorSlot
    )
  );
}
