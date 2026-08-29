/* ============================================================================
 * TruePad 2 Browser Edition — Open a message or file (simple)
 * ----------------------------------------------------------------------------
 * Paste (or load) the encrypted message, press one button. On success the
 * plaintext is shown (text) or offered as a file (binary), with no security
 * notices around it. On any failure a single plain sentence explains it, with
 * the exact typed reason tucked under Details. The role is pinned; there is no
 * A/B choice. Plaintext is shown only after the worker verifies and retires.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout, copyButton, saveBytesButton } from "./components.ts";
import { consequenceFor, fmtInt } from "./format.ts";
import { readRole } from "./role.ts";
import type { Ctx } from "./context.ts";
import type { EngineOk } from "../engine/protocol.ts";

function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / Math.max(1, n) < 0.02;
}

function renderAccepted(ctx: Ctx, result: HTMLElement, reply: Extract<EngineOk, { op: "open" }>, pairId: string): void {
  const { plaintext } = reply;
  if (isProbablyText(plaintext)) {
    const decoded = new TextDecoder().decode(plaintext);
    mount(
      result,
      h("h2", { class: "message-head", text: "Message" }),
      h("div", { class: "message-body", attrs: { "aria-label": "Message" }, text: decoded }),
      h("div", { class: "btn-row" }, copyButton(ctx, () => decoded, "Copy"), saveBytesButton(() => plaintext, `message-${pairId.slice(0, 8)}.txt`, "Save")),
      backRow(ctx, pairId)
    );
  } else {
    mount(
      result,
      h("div", { class: "ok-head" }, icon("check"), h("h2", { text: "File received" })),
      h("p", { class: "muted", text: `${fmtInt(plaintext.length)} bytes. Save it to keep it.` }),
      h("div", { class: "btn-row" }, saveBytesButton(() => plaintext, `file-${pairId.slice(0, 8)}.bin`, "Save file")),
      backRow(ctx, pairId)
    );
  }
}

function backRow(ctx: Ctx, pairId: string): HTMLElement {
  return h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Back to pad" })));
}

export async function renderOpen(ctx: Ctx, root: HTMLElement, pairId: string, mode: "message" | "file"): Promise<void> {
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Pad" }));
  const role = readRole(pairId);
  const isMessage = mode === "message";

  const pasteBox = h("textarea", { rows: 5, spellcheck: false, placeholder: "Paste the encrypted message here…" }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    if (f) pasteBox.value = (await f.text()).trim();
  });

  const result = h("div", { class: "section" });
  const openBtn = h("button", { class: "btn primary big", type: "button", on: { click: onOpen } }, icon("inbox"), h("span", { text: isMessage ? "Open message" : "Open file" })) as HTMLButtonElement;

  async function onOpen(): Promise<void> {
    const envelope = pasteBox.value.trim();
    if (envelope.length === 0) {
      mount(result, callout({ tone: "warn", title: "Nothing to open", body: "Paste the encrypted message first." }));
      return;
    }
    openBtn.disabled = true;
    const reply = await ctx.engine.open({ pairId, as: role, envelope });
    openBtn.disabled = false;
    if (reply.ok) { renderAccepted(ctx, result, reply, pairId); return; }
    if (reply.kind === "error") { mount(result, callout({ tone: "danger", title: "Could not open", body: reply.message })); return; }

    const c = consequenceFor(reply.reason);
    mount(
      result,
      h(
        "div",
        { class: "callout warn", role: "alert" },
        h("div", { class: "co-title" }, icon("alert"), h("span", { text: friendlyOpenTitle(reply.reason) })),
        h("div", { class: "co-body", text: friendlyOpenBody(reply.reason) }),
        h("details", { class: "quiet-details" }, h("summary", { text: "Details" }), h("p", { class: "faint", text: `${c.title}: ${reply.message}` }), h("p", { class: "faint mono", text: `reason: ${reply.reason}` }))
      ),
      backRow(ctx, pairId)
    );
  }

  mount(
    root,
    back,
    h("header", { class: "screen-head" }, h("h1", { text: isMessage ? "Open message" : "Open file" })),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "field" }, h("label", { text: isMessage ? "Encrypted message" : "Encrypted file message" }), pasteBox),
      h("div", { class: "field" }, h("div", { class: "field-label", text: "…or load from a file" }), fileInput),
      h("div", { class: "btn-row" }, openBtn)
    ),
    result
  );
}

function friendlyOpenTitle(reason: string): string {
  switch (reason) {
    case "sequence-retired":
    case "offset-retired":
      return "Already opened";
    case "frozen":
      return "This pad is paused";
    case "pair-destroyed":
      return "This pad is disabled";
    case "encryption-exhausted":
    case "auth-exhausted":
      return "This pad is out of space";
    default:
      return "This message could not be verified";
  }
}

function friendlyOpenBody(reason: string): string {
  switch (reason) {
    case "sequence-retired":
    case "offset-retired":
      return "You've already opened this message, or a later one from the same pad.";
    case "sequence-contested":
      return "This message can no longer be opened — too many failed attempts used it up.";
    case "sequence-out-of-window":
      return "This message is too far ahead of where this pad is. Open earlier messages first.";
    case "frozen":
      return "Too many messages failed to verify, so this pad is paused. Resume it from the pad screen.";
    case "pair-destroyed":
      return "This pad has been disabled and can no longer open messages.";
    case "encryption-exhausted":
    case "auth-exhausted":
      return "This pad has no material left. Create a new pad to keep messaging.";
    case "witness-regressed":
    case "witness-inconsistent":
      return "Something looks wrong with this pad's history — it may have been restored from a backup. It was refused to keep you safe.";
    default:
      return "It may have been altered, may belong to another pad, or may be invalid.";
  }
}
