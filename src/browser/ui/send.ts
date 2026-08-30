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
import { decodeEnvelope2, type EnvelopeV2 } from "../../core/envelope2.ts";
import { bytesToHex } from "../../core/hex.ts";
import { encodeCompactEnvelope2 } from "../../core/compact-envelope2.ts";
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

// §29 — what is actually inside the thing the user just copied.
//
// Every value here is read from the SAME EnvelopeV2 the compact string decodes
// to. Nothing is reconstructed for display, and nothing is re-derived: the
// compact form, this breakdown, and the canonical JSON below are three views of
// one envelope, and if they could ever disagree the codec would be broken.
//
// Read-only, and no pad byte appears. Ciphertext and tag are the message's own
// public bytes — they travel on the wire — and the secret material that
// produced them is never on this screen.
function insideBlock(compact: string, env: EnvelopeV2): HTMLElement {
  const field = (name: string, value: string, what: string, mono = false): HTMLElement =>
    h(
      "div",
      { class: "field-explained" },
      h("div", { class: "fe-head" }, h("code", { class: "fe-name", text: name }), h("span", { class: mono ? "fe-value mono" : "fe-value", text: value })),
      h("span", { class: "fe-what", text: what })
    );

  const ciphertextHex = bytesToHex(env.ciphertext);
  const shownCiphertext = ciphertextHex.length > 96 ? `${ciphertextHex.slice(0, 96)}… (${env.ciphertextLength} bytes)` : ciphertextHex;

  return h(
    "details",
    { class: "quiet-details" },
    h("summary", { text: "What's inside this encrypted message?" }),
    h(
      "div",
      { class: "qd-body" },
      h(
        "p",
        {
          text:
            "Most of the compact message is not ciphertext. It carries the information TruePad needs to identify " +
            "the pad material and authentication record that belong to this message. Those fields are authenticated " +
            "along with the ciphertext."
        }
      ),
      h(
        "div",
        { class: "field-list" },
        field("pairId", env.pairId, "Which pad this message belongs to.", true),
        field("direction", env.direction, "Which side of the shared pad sent it."),
        field("sequence", fmtInt(env.sequence), "Which one-time authentication record was spent."),
        field("startOffset", fmtInt(env.startOffset), "Where the one-time-pad bytes used for this ciphertext begin."),
        field("ciphertextLength", fmtInt(env.ciphertextLength), "How many ciphertext bytes this record carries."),
        field("ciphertext", shownCiphertext, "The actual OTP-encrypted payload.", true),
        field("tag", bytesToHex(env.tag), "The 128-bit one-time Wegman–Carter authentication tag.", true)
      ),
      h("p", { class: "faint", text: `The whole message is ${fmtInt(compact.length)} characters.` })
    )
  );
}

// §30 — what the machine actually did, in three sentences a person can hold.
// Explanatory copy, never a stronger claim than the product's own: the deep
// machinery is named as existing and pointed at, not recited here.
function whatTruePadDid(ctx: Ctx): HTMLElement {
  return h(
    "details",
    { class: "quiet-details" },
    h("summary", { text: "What TruePad did" }),
    h(
      "div",
      { class: "qd-body" },
      h(
        "div",
        { class: "field-list" },
        h(
          "div",
          { class: "field-explained" },
          h("div", { class: "fe-head" }, h("code", { class: "fe-name", text: "Encryption" }), h("span", { class: "fe-value mono", text: "C = P XOR K" })),
          h("span", { class: "fe-what", text: "A one-time pad: your message combined with unused secret material from this pad, one byte for one byte." })
        ),
        h(
          "div",
          { class: "field-explained" },
          h("div", { class: "fe-head" }, h("code", { class: "fe-name", text: "Authentication" }), h("span", { class: "fe-value", text: "128-bit tag" })),
          h("span", { class: "fe-what", text: "A one-time Wegman–Carter tag, so a changed message cannot pass as genuine." })
        ),
        h(
          "div",
          { class: "field-explained" },
          h("div", { class: "fe-head" }, h("code", { class: "fe-name", text: "Used once" }), h("span", { class: "fe-value", text: "recorded before sending" })),
          h("span", { class: "fe-what", text: "TruePad records which pad bytes and which authentication record this message spent, before releasing it, so ordinary use cannot spend them twice." })
        )
      ),
      h("p", { class: "faint", text: "The XOR is the simple part. Most of TruePad exists to keep the word \u201cone-time\u201d true outside the equation." }),
      h(
        "p",
        { class: "faint" },
        h("span", { text: "The details of that machinery, and exactly what it does and does not promise, are under " }),
        h(
          "button",
          { class: "linklike", type: "button", on: { click: () => ctx.navigate({ name: "security" }) } },
          h("span", { text: "Security" })
        ),
        h("span", { text: "." })
      )
    )
  );
}

function renderReady(ctx: Ctx, root: HTMLElement, pairId: string, envelope: string, usedBytes: number): void {
  // The worker's result stays canonical §6.2 JSON — the engine protocol is not
  // reshaped to make a screen shorter. What changes is only what a person is
  // handed: the same envelope, spelled TP2. If the compact spelling cannot be
  // produced for any reason, the JSON is shown rather than nothing; both are
  // the same message and either can be opened.
  const decoded = decodeEnvelope2(envelope);
  let compact: string | null = null;
  if (decoded.ok) {
    try {
      compact = encodeCompactEnvelope2(decoded.envelope);
    } catch {
      compact = null;
    }
  }
  const shown = compact ?? envelope;

  const shareBtn = "share" in navigator
    ? h(
        "button",
        { class: "btn", type: "button", on: { click: () => void navigator.share({ text: shown }).catch(() => {}) } },
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
      payloadBlock({ label: "Encrypted message", text: shown, meta: fmtBytes(shown.length) }),
      h(
        "div",
        { class: "btn-row" },
        copyButton(ctx, () => shown, "Copy"),
        saveBytesButton(() => new TextEncoder().encode(shown), `message-${pairId.slice(0, 8)}.txt`, "Save"),
        shareBtn
      ),
      h(
        "details",
        { class: "quiet-details" },
        h("summary", { text: "Details" }),
        h(
          "div",
          { class: "qd-body" },
          h("p", { text: `This used ${fmtInt(usedBytes)} byte${usedBytes === 1 ? "" : "s"} of your pad and one message slot. It cannot be undone.` }),
          // The educational half of Details. Compact transport must not hide
          // what TruePad is: the breakdown decodes the very string the user
          // just copied, so what is explained is what was sent.
          compact === null || !decoded.ok ? null : insideBlock(compact, decoded.envelope),
          whatTruePadDid(ctx),
          // Level 3. The same message in TruePad's technical form, for
          // interoperability and debugging. Deliberately not framed as the
          // stronger or more real one: the two are the same envelope, and the
          // authentication tag is computed over neither spelling.
          compact === null
            ? null
            : h(
                "details",
                { class: "quiet-details" },
                h("summary", { text: "Canonical JSON" }),
                h(
                  "div",
                  { class: "qd-body" },
                  h("p", { text: "This is the same encrypted message in TruePad's technical JSON form. Either one opens." }),
                  payloadBlock({ label: "Canonical JSON", text: envelope, meta: fmtBytes(envelope.length) }),
                  h("div", { class: "btn-row" }, copyButton(ctx, () => envelope, "Copy JSON"))
                )
              )
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
