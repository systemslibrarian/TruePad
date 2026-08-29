/* ============================================================================
 * TruePad 2 Browser Edition — Send a message or file (simple)
 * ----------------------------------------------------------------------------
 * Type (or pick a file), press one button, get an encrypted message you can
 * copy, save, or share. The pad material spent is not shown unless the user
 * expands Details. The role is pinned (set when the pad was created/added), so
 * there is no A/B choice here. The plaintext is read at submit time and handed
 * to the worker; the UI never parks it in state.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout, copyButton, saveBytesButton } from "./components.ts";
import { fmtInt } from "./format.ts";
import { readRole, sendDirection } from "./role.ts";
import type { Ctx } from "./context.ts";

export async function renderSend(ctx: Ctx, root: HTMLElement, pairId: string, mode: "message" | "file"): Promise<void> {
  const reply = await ctx.engine.status({ pairId });
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Pad" }));
  if (!reply.ok) {
    mount(root, back, callout({ tone: "danger", title: "Cannot send", body: reply.message }));
    return;
  }
  const pair = reply.pair;
  const role = readRole(pairId);
  const m = pair.meters[sendDirection(role)];

  const isMessage = mode === "message";
  const textarea = h("textarea", { rows: 6, spellcheck: false, placeholder: "Type your message…" }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  let file: File | null = null;
  const result = h("div", { class: "section" });
  const encryptBtn = h("button", { class: "btn primary big", type: "button", on: { click: onEncrypt } }, icon("send"), h("span", { text: isMessage ? "Encrypt message" : "Encrypt file" })) as HTMLButtonElement;

  function hasInput(): boolean { return isMessage ? textarea.value.length > 0 : file !== null; }
  function refresh(): void { encryptBtn.disabled = !hasInput() || pair.destroyed || m.verification.frozen; }
  textarea.addEventListener("input", refresh);
  fileInput.addEventListener("change", () => { file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null; refresh(); });

  async function onEncrypt(): Promise<void> {
    const plaintext = isMessage
      ? new TextEncoder().encode(textarea.value)
      : (file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0));
    if (plaintext.length === 0) return;
    encryptBtn.disabled = true;
    const rep = await ctx.engine.burn({ pairId, as: role, plaintext });
    encryptBtn.disabled = false;
    if (!rep.ok) {
      mount(result, callout({ tone: "danger", title: "Could not encrypt", body: friendlySendError(rep.kind === "refused" ? rep.reason : "", rep.message) }));
      return;
    }
    const envelope = rep.envelope;
    const shareBtn = "share" in navigator
      ? h("button", { class: "btn ghost", type: "button", on: { click: () => navigator.share({ text: envelope }).catch(() => {}) } }, icon("external"), h("span", { text: "Share" }))
      : null;
    mount(
      result,
      h("div", { class: "ok-head" }, icon("check"), h("h2", { text: "Encrypted message ready" })),
      h("p", { class: "muted", text: "Send this to the other person over any channel — it is safe to copy, save, or share." }),
      h("div", { class: "codeblock", attrs: { "aria-label": "Encrypted message" }, text: envelope }),
      h("div", { class: "btn-row" }, copyButton(ctx, () => envelope, "Copy encrypted message"), saveBytesButton(() => new TextEncoder().encode(envelope), `message-${pairId.slice(0, 8)}.txt`, "Save"), shareBtn),
      h("details", { class: "quiet-details" }, h("summary", { text: "Details" }), h("p", { class: "faint", text: `This used ${fmtInt(rep.consumed.encryptionBytes)} byte${rep.consumed.encryptionBytes === 1 ? "" : "s"} of your pad and one message slot. It cannot be undone.` })),
      h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Back to pad" })))
    );
  }

  const input = isMessage
    ? h("div", { class: "field" }, h("label", { text: "Message" }), textarea)
    : h("div", { class: "field" }, h("label", { text: "File to send" }), fileInput);

  const paused = m.verification.frozen
    ? callout({ tone: "warn", title: "This pad is paused", body: "Resume it from the pad screen before sending." })
    : null;

  mount(
    root,
    back,
    h("header", { class: "screen-head" }, h("h1", { text: isMessage ? "Send message" : "Send file" })),
    h(
      "div",
      { class: "card stack" },
      paused,
      input,
      h("p", { class: "muted send-note", text: "This will use a small amount of your one-time pad." }),
      h("div", { class: "btn-row" }, encryptBtn)
    ),
    result
  );
  refresh();
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
