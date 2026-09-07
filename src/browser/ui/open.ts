/* ============================================================================
 * TruePad Browser Edition — Open a message or file
 * ----------------------------------------------------------------------------
 * Paste (or load) the encrypted message, press one button. On success the
 * plaintext is the screen — no cryptographic status wrapped around it. On any
 * failure one plain sentence explains what happened, and the exact typed
 * reason the engine returned sits under Details, unrounded. The role is pinned;
 * there is no A/B choice. Plaintext appears only after the worker has verified
 * the tag and retired the record.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { backLink, callout, filePicker, saveBytesButton, screenHead } from "./components.ts";
import { PLAINTEXT_STAYS_HERE } from "./egress-copy.ts";
import { egressForOpenedPayload } from "./egress.ts";
import { consequenceFor, fmtBytes } from "./format.ts";
import { UNKNOWN_ORIGIN_PROMPT, resolveRole } from "./role.ts";
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

function backRow(ctx: Ctx, pairId: string): HTMLElement {
  return h(
    "div",
    { class: "btn-row" },
    h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Back to pad" }))
  );
}

/**
 * THE CLASSIFICATION FOLLOWS THE OPERATOR'S DECLARED MODE, NOT A CONTENT SNIFF.
 *
 * This branched on `isProbablyText(plaintext)` and `mode` was never passed in at
 * all, which got the policy exactly backwards in both directions:
 *
 *   · Every plain-text FILE — .txt, .csv, .json, .md, source, PEM, a config —
 *     sniffs as text, so it landed in the message branch and lost its Save. The
 *     "Open file" tile silently stopped delivering for the commonest kind of
 *     file, which is the feature deletion the `received-file` class exists to
 *     avoid.
 *   · A decrypted MESSAGE whose bytes happened to trip the sniff landed in the
 *     file branch and was handed a plaintext file export under `received-file` —
 *     the precise egress this repair forbids, wearing the label that permits it.
 *
 * A content heuristic can never carry that distinction: it is about what the
 * OPERATOR asked for. "Open message" is display-only; "Open file" is a delivery
 * whose whole point is a file on disk. The sniff survives for one honest job —
 * deciding whether a received FILE can also be shown on screen — and decides
 * nothing about egress.
 */
function renderAccepted(
  ctx: Ctx,
  root: HTMLElement,
  reply: Extract<EngineOk, { op: "open" }>,
  pairId: string,
  mode: "message" | "file"
): void {
  const { plaintext } = reply;
  // Asked once, from the mode, and passed to whichever branch renders. No screen
  // decides this and no content decides this.
  const egress = egressForOpenedPayload(mode);
  const back = backLink(() => ctx.navigate({ name: "pair", pairId }), "Pad");
  const verified = h(
    "details",
    { class: "quiet-details" },
    h("summary", { text: "Details" }),
    h(
      "div",
      { class: "qd-body" },
      h("p", { text: "The tag verified before any byte was released, and this message's record is now retired — it cannot be opened a second time." })
    )
  );

  if (mode === "message") {
    // A MESSAGE IS DISPLAYED AND NOTHING ELSE. If its bytes are not displayable
    // text the operator sees that plainly, rather than being handed a file export
    // for material this policy classifies as display-only.
    const decoded = isProbablyText(plaintext)
      ? new TextDecoder().decode(plaintext)
      : "(This message is not displayable text. It opened and verified; TruePad "
        + "does not offer a file export for a message.)";
    mount(
      root,
      h(
        "div",
        { class: "screen" },
        back,
        h("h2", { class: "message-head", text: "Message" }),
        h("div", { class: "message-body", attrs: { "aria-label": "Message" }, text: decoded }),
        // NO COPY, AND NO SAVE. The decrypted message is on the screen and stays
        // there. A clipboard copy is readable by any app with focus, is kept in a
        // platform history, and syncs across the operator's devices; a saved file
        // is a durable copy outside anything the engine can retire. Both make a
        // SECOND copy of the one thing the pad exists to protect, and neither is
        // needed to read it. iOS has refused both since its Open screen was
        // written; this is the Browser adopting the same rule. See ui/egress.ts.
        //
        // The claim is deliberately narrow — see PLAINTEXT_STAYS_HERE.
        h("p", { class: "faint small", text: PLAINTEXT_STAYS_HERE }),
        verified,
        h("hr", { class: "divider" }),
        backRow(ctx, pairId)
      )
    );
  } else {
    mount(
      root,
      h(
        "div",
        { class: "screen" },
        back,
        h("div", { class: "ok-head" }, icon("check"), h("h1", { text: "File received" })),
        h("p", { class: "muted", text: `${fmtBytes(plaintext.length)}. Save it to keep it.` }),
        // A RECEIVED FILE IS SAVED, AND THAT IS NOT THE SAME ACT AS SAVING A
        // MESSAGE. A message is displayed, so writing it out adds a second copy of
        // something the operator already has. A file has no on-screen form at all:
        // writing it IS the delivery. Classified separately so the difference is
        // in the type system rather than in a comment, and still never copied to
        // the clipboard and never drawn as a QR.
        h("div", { class: "btn-row" }, saveBytesButton(() => plaintext, `file-${pairId.slice(0, 8)}.bin`, egress, "Save file", "primary")),
        verified,
        h("hr", { class: "divider" }),
        backRow(ctx, pairId)
      )
    );
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

export async function renderOpen(ctx: Ctx, root: HTMLElement, pairId: string, mode: "message" | "file"): Promise<void> {
  const isMessage = mode === "message";
  const back = () => ctx.navigate({ name: "pair", pairId });

  // THE ROLE COMES FROM THE PAD. Opening with the wrong half costs a
  // verification attempt rather than pad material, but the role is one fact per
  // pair and deriving it in one place is what keeps SEND correct too. See role.ts.
  const statusReply = await ctx.engine.status({ pairId });
  if (!statusReply.ok) {
    mount(root, h("div", { class: "screen" }, backLink(back, "Pad"),
      callout({ tone: "danger", title: "Cannot open", body: statusReply.message })));
    return;
  }
  const resolved = resolveRole(pairId, statusReply.pair.origin);
  if (resolved === null) {
    mount(root, h("div", { class: "screen" }, backLink(back, "Pad"),
      callout({ tone: "danger", title: "TruePad does not know which half of this pair is yours", body: UNKNOWN_ORIGIN_PROMPT })));
    return;
  }
  const role: "A" | "B" = resolved;

  const pasteBox = h("textarea", { rows: 5, spellcheck: false, class: "mono", placeholder: "Paste the encrypted message here…" }) as HTMLTextAreaElement;
  const picker = filePicker({
    action: "…or load it from a file",
    hint: "A saved encrypted message",
    onChange: async (files) => {
      const f = files[0];
      if (f) pasteBox.value = (await f.text()).trim();
    }
  });

  const errorSlot = h("div", {});
  const openBtn = h(
    "button",
    { class: "btn primary lg", type: "button", on: { click: onOpen } },
    h("span", { text: isMessage ? "Open message" : "Open file" })
  ) as HTMLButtonElement;

  async function onOpen(): Promise<void> {
    const envelope = pasteBox.value.trim();
    if (envelope.length === 0) {
      mount(errorSlot, callout({ tone: "warn", title: "Nothing to open", body: "Paste the encrypted message first." }));
      return;
    }
    openBtn.disabled = true;
    const reply = await ctx.engine.open({ pairId, as: role, envelope });
    openBtn.disabled = false;
    if (reply.ok) { renderAccepted(ctx, root, reply, pairId, mode); return; }
    if (reply.kind === "error") { mount(errorSlot, callout({ tone: "danger", title: "Could not open", body: reply.message })); return; }

    const c = consequenceFor(reply.reason);
    const tone = refusalTone(reply.reason);
    const glyph = icon("alert");
    glyph.classList.add("co-icon");
    mount(
      errorSlot,
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: `callout ${tone}`, role: "alert" },
          glyph,
          h("div", { class: "co-title", text: friendlyOpenTitle(reply.reason) }),
          h(
            "div",
            { class: "co-body" },
            h("p", { text: friendlyOpenBody(reply.reason) }),
            h(
              "details",
              { class: "quiet-details" },
              h("summary", { text: "Details" }),
              h(
                "div",
                { class: "qd-body" },
                h("p", { text: `${c.title}: ${reply.message}` }),
                h("p", { class: "mono", text: `reason: ${reply.reason}` })
              )
            )
          )
        ),
        backRow(ctx, pairId)
      )
    );
  }

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(back, "Pad"),
      screenHead({ title: isMessage ? "Open message" : "Open file" }),
      h(
        "div",
        { class: "card" },
        h("div", { class: "field" }, h("label", { text: isMessage ? "Encrypted message" : "Encrypted file message" }), pasteBox),
        picker.el,
        h("div", { class: "btn-row" }, openBtn)
      ),
      errorSlot
    )
  );
}

// A refusal the operator can act on (open an earlier message, resume, make a
// new pad) is a warning. A refusal that means this ciphertext will never open
// is red — nothing is softened by calling it amber.
function refusalTone(reason: string): "warn" | "danger" {
  switch (reason) {
    case "sequence-retired":
    case "offset-retired":
    case "sequence-out-of-window":
    case "frozen":
    case "pair-destroyed":
    case "encryption-exhausted":
    case "auth-exhausted":
      return "warn";
    default:
      return "danger";
  }
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
