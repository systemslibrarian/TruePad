/* ============================================================================
 * TruePad Browser Edition — Send a message or file
 * ----------------------------------------------------------------------------
 * Type (or pick a file), press one button, get an encrypted message you can
 * copy, save, or share. Success replaces the compose screen rather than piling
 * up beneath it: the material is already spent, so there is nothing left to do
 * here but carry the result away. What the send cost is true, recorded, and one
 * disclosure away. The role is pinned when the pad is created or added, so
 * there is no A/B choice; the plaintext is read at submit time and handed
 * straight to the worker, never parked in UI state.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { backLink, callout, copyButton, filePicker, payloadBlock, saveBytesButton, screenHead } from "./components.ts";
import { fmtBytes, fmtInt } from "./format.ts";
import { readRole, sendDirection } from "./role.ts";
import type { Ctx } from "./context.ts";

export async function renderSend(ctx: Ctx, root: HTMLElement, pairId: string, mode: "message" | "file"): Promise<void> {
  const reply = await ctx.engine.status({ pairId });
  const back = () => ctx.navigate({ name: "pair", pairId });
  if (!reply.ok) {
    mount(root, h("div", { class: "screen" }, backLink(back, "Pad"), callout({ tone: "danger", title: "Cannot send", body: reply.message })));
    return;
  }
  const pair = reply.pair;
  const role = readRole(pairId);
  const m = pair.meters[sendDirection(role)];
  const isMessage = mode === "message";

  const textarea = h("textarea", { rows: 6, placeholder: "Type your message…" }) as HTMLTextAreaElement;
  let file: File | null = null;
  const picker = filePicker({
    action: "Choose a file to send",
    hint: "Any file on this device",
    onChange: (files) => { file = files[0] ?? null; refresh(); }
  });

  const encryptBtn = h(
    "button",
    { class: "btn primary lg", type: "button", on: { click: onEncrypt } },
    h("span", { text: isMessage ? "Encrypt message" : "Encrypt file" })
  ) as HTMLButtonElement;

  const errorSlot = h("div", {});

  function hasInput(): boolean { return isMessage ? textarea.value.length > 0 : file !== null; }
  function refresh(): void { encryptBtn.disabled = !hasInput() || pair.destroyed || m.verification.frozen; }
  textarea.addEventListener("input", refresh);

  async function onEncrypt(): Promise<void> {
    const plaintext = isMessage
      ? new TextEncoder().encode(textarea.value)
      : (file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0));
    if (plaintext.length === 0) return;
    encryptBtn.disabled = true;
    const rep = await ctx.engine.burn({ pairId, as: role, plaintext });
    encryptBtn.disabled = false;
    if (!rep.ok) {
      mount(errorSlot, callout({ tone: "danger", title: "Could not encrypt", body: friendlySendError(rep.kind === "refused" ? rep.reason : "", rep.message) }));
      return;
    }
    renderReady(ctx, root, pairId, rep.envelope, rep.consumed.encryptionBytes);
  }

  const input = isMessage
    ? h("div", { class: "field" }, h("label", { text: "Message" }), textarea)
    : h("div", { class: "field" }, h("div", { class: "field-label", text: "File to send" }), picker.el);

  const paused = m.verification.frozen
    ? callout({ tone: "warn", title: "This pad is paused", body: "Resume it from the pad screen before sending." })
    : null;

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(back, "Pad"),
      screenHead({ title: isMessage ? "Send message" : "Send file" }),
      h(
        "div",
        { class: "card" },
        paused,
        input,
        h("p", { class: "hint", text: "Sending permanently uses part of this pad." }),
        h("div", { class: "btn-row" }, encryptBtn)
      ),
      errorSlot
    )
  );
  refresh();
}

function renderReady(ctx: Ctx, root: HTMLElement, pairId: string, envelope: string, usedBytes: number): void {
  const shareBtn = "share" in navigator
    ? h(
        "button",
        { class: "btn", type: "button", on: { click: () => void navigator.share({ text: envelope }).catch(() => {}) } },
        icon("share"),
        h("span", { text: "Share" })
      )
    : null;

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "pair", pairId }), "Pad"),
      h("div", { class: "ok-head" }, icon("check"), h("h1", { text: "Encrypted message ready" })),
      h("p", { class: "muted", text: "Send this to the other person over any channel. Only they can open it." }),
      payloadBlock({ label: "Encrypted message", text: envelope, meta: fmtBytes(envelope.length) }),
      h(
        "div",
        { class: "btn-row" },
        copyButton(ctx, () => envelope, "Copy"),
        saveBytesButton(() => new TextEncoder().encode(envelope), `message-${pairId.slice(0, 8)}.txt`, "Save"),
        shareBtn
      ),
      h(
        "details",
        { class: "quiet-details" },
        h("summary", { text: "Details" }),
        h(
          "div",
          { class: "qd-body" },
          h("p", { text: `This used ${fmtInt(usedBytes)} byte${usedBytes === 1 ? "" : "s"} of your pad and one message slot. It cannot be undone.` })
        )
      ),
      h("hr", { class: "divider" }),
      h(
        "div",
        { class: "btn-row" },
        h(
          "button",
          { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } },
          h("span", { text: "Back to pad" })
        )
      )
    )
  );
  window.scrollTo({ top: 0, behavior: "auto" });
}

function friendlySendError(reason: string, message: string): string {
  switch (reason) {
    case "encryption-exhausted":
    case "auth-exhausted":
      return "This pad is out of space for new messages. Create a new pad to keep sending.";
    case "record-size-mismatch":
      return "This message is too long for this pad's fixed message size.";
    case "frozen":
      return "This pad is paused. Resume it from the pad screen first.";
    case "pair-destroyed":
      return "This pad has been disabled and can no longer send.";
    default:
      return message;
  }
}
