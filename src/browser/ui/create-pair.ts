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
import { backLink, callout, choice, filePicker, kv, panel, screenHead } from "./components.ts";
import { savePadFileButton } from "./courier.ts";
import { fmtInt } from "./format.ts";
import { writeRole } from "./role.ts";
import {
  CEREMONY_ALIASING,
  CEREMONY_CANNOT_VERIFY,
  CEREMONY_COMBINER,
  CEREMONY_CONDITIONAL,
  CEREMONY_MESSAGE_INDEPENDENCE,
  CEREMONY_SECRECY,
  CEREMONY_TITLE,
  DELIVERY_CEREMONY,
  DELIVERY_ESSENTIAL,
  DELIVERY_NOT_ITS,
  DEVICE_DETAIL,
  DEVICE_SHORT,
  DEVICE_SOURCE_LABEL,
  EXTERNAL_BEYOND_UNIFORMITY,
  EXTERNAL_CONDITIONAL,
  EXTERNAL_NOT_VERIFIED,
  EXTERNAL_SHORT,
  EXTERNAL_SOURCE_LABEL,
  OPERATOR_DECLARATION,
  ceremonyLengthRule
} from "./source-claims.ts";
import type { Ctx } from "./context.ts";
import type { BrowserWitnessClass, ManifestView } from "../engine/protocol.ts";

// What the created screen says about where the pad material came from. The
// external verdict is carried through verbatim from the ENGINE's gen reply, so
// the UI can never restate the combiner's claim in its own words.
type SourceClaim =
  | { kind: "device" }
  | { kind: "external"; verdict: string; manifest: ManifestView };

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
    files: [] as { file: File; origin: string }[],
    // The operator declaration for the external ceremony. Transient UI state:
    // it gates the button and is never persisted, never sent to the engine,
    // and never written to the store — a checkbox is not a cryptographic fact.
    declared: false
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
        desc: DEVICE_SHORT,
        checked: state.source === "generate",
        onSelect: () => { state.source = "generate"; paintSources(); paintExternal(); revalidate(); }
      }),
      choice({
        name: "source",
        title: "Use external random material",
        desc: EXTERNAL_SHORT,
        checked: state.source === "file",
        onSelect: () => { state.source = "file"; paintSources(); paintExternal(); revalidate(); }
      })
    );
  }

  // The declaration checkbox is built once and kept, so re-painting the file
  // list never silently clears an acknowledgement the operator already gave.
  const declareBox = h("input", {
    type: "checkbox",
    on: { change: (e) => { state.declared = (e.target as HTMLInputElement).checked; revalidate(); } }
  }) as HTMLInputElement;

  // The expert disclosure. It describes the COMBINER exactly (that part is
  // unconditional) and then says, in the plainest sentence in the app, that
  // selecting this path is not an act of randomness generation.
  function ceremonyPanel(required: number): HTMLElement {
    return h(
      "div",
      { class: "stack-sm ceremony" },
      h("div", { class: "field-label", text: CEREMONY_TITLE }),
      h("p", { text: CEREMONY_COMBINER }),
      h("p", { text: CEREMONY_CONDITIONAL }),
      callout({ tone: "warn", title: CEREMONY_CANNOT_VERIFY, body: CEREMONY_SECRECY }),
      h("p", { class: "faint", text: CEREMONY_MESSAGE_INDEPENDENCE }),
      h("p", { class: "faint", text: ceremonyLengthRule(required) }),
      h("p", { class: "faint", text: CEREMONY_ALIASING })
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
      hint: `Each file must hold at least ${fmtInt(L)} bytes`,
      multiple: true,
      onChange: (files) => {
        for (const f of files) {
          // The ONE identity check the browser actually supports: the very same
          // File object handed back twice in one session. It compares object
          // references, never bytes — source CONTENT can never condition
          // acceptance. Two separate picks of one underlying file are
          // indistinguishable here, which is why CEREMONY_ALIASING says so.
          if (state.files.some((e) => e.file === f)) continue;
          state.files.push({ file: f, origin: "" });
        }
        picker.input.value = "";
        picker.setName(null);
        paintExternal();
        revalidate();
      }
    });
    mount(
      externalFields,
      ceremonyPanel(L),
      picker.el,
      state.files.length > 0 ? h("div", { class: "source-list" }, ...rows) : null,
      h("label", { class: "confirm-row declare-row" }, declareBox, h("span", { text: OPERATOR_DECLARATION }))
    );
    declareBox.checked = state.declared;
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
      // The declaration is required to CREATE, and it is the operator's
      // statement about the world — not a result TruePad computed.
      if (!state.declared) return "Confirm the source declaration to continue.";
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
        declaredOrigin:
          "Generated by your device's cryptographic random generator (crypto.getRandomValues) — a computational CSPRNG source, not verified physical randomness.",
        bytes: drbgBytes(L)
      }];
    } else {
      sources = [];
      for (const s of state.files) sources.push({ name: s.file.name, declaredOrigin: s.origin.trim(), bytes: new Uint8Array(await s.file.arrayBuffer()) });
    }
    createBtn.disabled = true;
    validity.textContent = "Creating…";
    let reply;
    try {
      // A successful call TRANSFERS these buffers, detaching them here — the
      // strongest outcome, and the normal one. The finally covers the path
      // where postMessage itself threw and the page's copies are still live.
      // Best-effort in-memory hygiene, no erasure claim; the operator's file
      // on disk is untouched either way (arrayBuffer() hands out a copy).
      reply = await ctx.engine.gen({
        label: nameInput.value.trim() || "Untitled pad",
        sources,
        encryptionBytes: state.e,
        authRecords: state.n,
        recordBytes: state.record === "fixed" ? state.f : undefined,
        witnessClass: state.witness
      });
    } finally {
      for (const s of sources) {
        try {
          s.bytes.fill(0);
        } catch {
          /* already detached by the transfer — nothing left to wipe */
        }
      }
    }
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
    // The verdict and manifest are the ENGINE's, shown back verbatim.
    renderCreated(
      ctx,
      root,
      pairId,
      state.source === "generate" ? { kind: "device" } : { kind: "external", verdict: reply.verdict, manifest: reply.manifest }
    );
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
          h("span", { class: "choice-body" }, h("span", { class: "choice-title", text: "Variable length" }), h("span", { class: "choice-desc", text: "Default. The encrypted message is as long as the message, so its exact length is visible." }))
        ),
        h(
          "label",
          { class: "choice" },
          h("input", { type: "radio", name: "rec", checked: state.record === "fixed", on: { change: () => { state.record = "fixed"; fField.hidden = false; revalidate(); } } }),
          h("span", { class: "choice-body" }, h("span", { class: "choice-title", text: "Fixed length (stronger length privacy)" }), h("span", { class: "choice-desc", text: "Every message uses the same record size, hiding its exact length. The cost: each message spends the full record size of pad, even a short one. Timing and the number of messages are still visible." }))
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

// Level 3, collapsed: which class of source made this pad, and exactly what
// that does and does not license. A layperson who never opened Advanced took
// the device path and sees the same short screen they always did.
function sourceClaimPanel(claim: SourceClaim): HTMLElement {
  if (claim.kind === "device") {
    return panel(
      "Details",
      {},
      kv([{ term: "Randomness source", value: DEVICE_SOURCE_LABEL }]),
      h("p", { class: "faint", text: DEVICE_DETAIL })
    );
  }
  const { manifest } = claim;
  return panel(
    "Details",
    { open: true },
    kv([
      { term: "Randomness source", value: EXTERNAL_SOURCE_LABEL },
      { term: "Sources combined", value: fmtInt(manifest.sources.length) },
      { term: "Bytes each source supplied", value: fmtInt(manifest.requiredSourceLength) }
    ]),
    // Verbatim from the engine — the combiner states its own claim.
    h("p", { class: "verdict-line", text: claim.verdict }),
    h("p", { text: EXTERNAL_NOT_VERIFIED }),
    h("p", { class: "faint", text: EXTERNAL_CONDITIONAL }),
    h("p", { text: EXTERNAL_BEYOND_UNIFORMITY }),
    h(
      "ul",
      { class: "source-manifest" },
      ...manifest.sources.map((src) =>
        h(
          "li",
          {},
          h("span", { class: "sr-name", text: src.name }),
          h("span", { class: "faint", text: `${fmtInt(src.lengthBytes)} bytes supplied, ${fmtInt(src.unusedBytes)} unused — ${src.declaredOrigin}` })
        )
      )
    )
  );
}

function renderCreated(ctx: Ctx, root: HTMLElement, pairId: string, claim: SourceClaim): void {
  const startBtn = h(
    "button",
    { class: "btn lg", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } },
    h("span", { text: "Start using TruePad" }),
    icon("chevron")
  ) as HTMLButtonElement;

  const saveBtn = savePadFileButton(ctx, pairId, "Save pad file", {
    variant: "primary lg",
    onSaved: () => {
      // Once the pad file exists on disk, the next step is no longer saving it.
      saveBtn.className = "btn lg";
      onlineBtn.className = "btn lg";
      startBtn.className = "btn primary lg";
    }
  });

  // Both delivery methods, offered together, neither preselected. The FIRST one
  // that succeeds decides this pad's handoff mode for good — the engine records
  // it and refuses the other afterwards — so the choice belongs here, before
  // either irreversible step, rather than being implied by which button is
  // bigger.
  const onlineBtn = h(
    "button",
    { class: "btn primary lg", type: "button", on: { click: () => ctx.navigate({ name: "send-online", pairId }) } },
    h("span", { text: "Send securely online" })
  ) as HTMLButtonElement;

  // The pad source is only half of an OTP deployment: the pad FILE is secret
  // too. The essential warning is the same on both paths; the ceremony
  // disclosure is the expert half, and it is careful that a computationally
  // secure transfer is a DIFFERENT claim, not a weaker form of this one.
  const delivery =
    claim.kind === "external"
      ? panel(
          "Delivering the pad file",
          { open: true },
          h("p", { text: DELIVERY_CEREMONY }),
          h("p", { class: "faint", text: DELIVERY_NOT_ITS })
        )
      : null;

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      h("div", { class: "ok-head" }, icon("check"), h("h1", { text: "Pad created" })),
      h("p", { class: "muted", text: "One thing left: give the other person their copy. Until they have it, neither of you can read anything the other sends." }),
      callout({ tone: "warn", title: "The pad file is the secret", body: DELIVERY_ESSENTIAL }),
      delivery,
      h("h2", { text: "Give the other person their copy" }),
      h("p", { class: "muted", text: "Choose one way. Use one delivery method for each pad." }),
      h("div", { class: "btn-row" }, onlineBtn, saveBtn),
      claim.kind === "external"
        ? h("p", {
            class: "faint small",
            text:
              "Sending online adds computational encryption assumptions. A secret physical handoff is the route that " +
              "keeps the stronger conditional one-time-pad delivery claim you chose when you supplied your own random material."
          })
        : h("p", {
            class: "faint small",
            text: "Sending online seals the pad so it can travel through ordinary channels; it relies on computational cryptography."
          }),
      sourceClaimPanel(claim),
      h("hr", { class: "divider" }),
      h("div", { class: "btn-row" }, startBtn)
    )
  );
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ---- Add a shared pad (import) ------------------------------------------ */

/** "Add a shared pad" now asks HOW the pad arrived before showing either flow.
 *
 *  Both answers are ordinary sentences about what the other person did, not a
 *  choice between cryptographic transports. The home screen stays as small as
 *  it was: this is the only new fork, and it lives one level down. */
export function renderAddPad(ctx: Ctx, root: HTMLElement): void {
  const fileBtn = h(
    "button",
    { class: "choice", type: "button", on: { click: () => ctx.navigate({ name: "import-file" }) } },
    h("span", { class: "choice-title", text: "I have a pad file" }),
    h("span", { class: "choice-note", text: "The secret pad file they gave me privately." })
  );
  const onlineBtn = h(
    "button",
    { class: "choice", type: "button", on: { click: () => ctx.navigate({ name: "receive-online" }) } },
    h("span", { class: "choice-title", text: "Receive securely online" }),
    h("span", { class: "choice-note", text: "Create a receive code they can use to send the pad securely." })
  );
  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "home" }), "Home"),
      screenHead({ title: "Add a shared pad", lede: "How did the other person send it?" }),
      h("div", { class: "choices" }, fileBtn, onlineBtn)
    )
  );
}

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
      // A pad file whose pair is tombstoned is refused by the engine and always
      // will be — that refusal is the security property and is untouched here.
      // What changes is only what we SAY: naming the tombstone would hand back
      // the history of a pad the user removed, so the wording stays generic.
      const dead = reply.kind === "refused" && reply.reason === "pair-destroyed";
      mount(
        errorSlot,
        dead
          ? callout({
              tone: "danger",
              title: "This pad file can't be added.",
              body: "Nothing was added. Ask the other person for a new pad."
            })
          : callout({ tone: "danger", title: "Could not add this pad", body: reply.message })
      );
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
      backLink(() => ctx.navigate({ name: "import" }), "Add a shared pad"),
      screenHead({
        title: "Add a pad file",
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
