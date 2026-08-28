/* ============================================================================
 * TruePad 2 Browser Edition — Send (burn)
 * ----------------------------------------------------------------------------
 * A send permanently consumes material. Before the operator commits, the exact
 * cost is stated — "This will permanently consume: Encryption N bytes,
 * Authentication 1 record. This cannot be undone." — and the envelope is shown
 * ONLY after the burn returns from the worker. The plaintext bytes are read at
 * submit time and handed to the worker; the UI never parks them in state.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout, copyButton, saveBytesButton } from "./components.ts";
import { directionLabel, fmtInt, localRoleLabel, recordModeLabel } from "./format.ts";
import { readRole, writeRole, sendDirection } from "./role.ts";
import type { Ctx } from "./context.ts";
import type { DirectionMeters, PairSummary } from "../engine/protocol.ts";

type SendMode = "message" | "file";
let pendingMode: SendMode = "message";
export function setPendingSendMode(mode: SendMode): void {
  pendingMode = mode;
}

export async function renderSend(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const reply = await ctx.engine.status({ pairId });
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Dashboard" }));

  if (!reply.ok) {
    mount(root, back, callout({ tone: "danger", title: "Cannot send", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
    return;
  }
  const pair: PairSummary = reply.pair;

  let role: "A" | "B" = readRole(pairId);
  let mode: SendMode = pendingMode;
  let file: File | null = null;

  const textarea = h("textarea", { rows: 5, spellcheck: false, placeholder: "Type the message to encrypt…" }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    updatePreview();
  });
  textarea.addEventListener("input", updatePreview);

  const inputHolder = h("div", {});
  const preview = h("div", {});
  const result = h("div", { class: "section" });
  const burnBtn = h("button", { class: "btn primary", type: "button", on: { click: onBurn } }, icon("send"), h("span", { text: "Encrypt & burn" })) as HTMLButtonElement;

  function meters(): DirectionMeters {
    return pair.meters[sendDirection(role)];
  }

  function payloadBytes(): number {
    if (mode === "file") return file ? file.size : 0;
    return new TextEncoder().encode(textarea.value).length;
  }

  function encryptionToConsume(m: DirectionMeters): number {
    return m.record.kind === "fixed" ? m.record.bytes : payloadBytes();
  }

  function hasInput(): boolean {
    return mode === "file" ? file !== null : textarea.value.length > 0;
  }

  function roleSelector(): HTMLElement {
    const mk = (r: "A" | "B") =>
      h(
        "button",
        {
          class: r === role ? "btn small primary" : "btn small ghost",
          type: "button",
          aria: { pressed: String(r === role) },
          on: {
            click: () => {
              role = r;
              writeRole(pairId, r);
              rebuild();
            }
          }
        },
        h("span", { text: `I am ${localRoleLabel(r)}` })
      );
    return h("div", { class: "btn-row" }, mk("A"), mk("B"));
  }

  function modeSelector(): HTMLElement {
    const mk = (mMode: SendMode, label: string, ic: string) =>
      h(
        "button",
        {
          class: mMode === mode ? "btn small primary" : "btn small ghost",
          type: "button",
          aria: { pressed: String(mMode === mode) },
          on: {
            click: () => {
              mode = mMode;
              rebuild();
            }
          }
        },
        icon(ic),
        h("span", { text: label })
      );
    return h("div", { class: "btn-row" }, mk("message", "Message", "send"), mk("file", "File", "file"));
  }

  function updatePreview(): void {
    const m = meters();
    const dir = directionLabel(m.direction);
    const encBytes = encryptionToConsume(m);
    const enoughEnc = m.encryption.remainingBytes >= encBytes && encBytes >= 0;
    const enoughAuth = m.authentication.remainingRecords >= 1;
    const frozen = m.verification.frozen;
    const canBurn = hasInput() && enoughEnc && enoughAuth && !frozen && !pair.destroyed && encBytes > 0;
    burnBtn.disabled = !canBurn;

    const blockers: string[] = [];
    if (frozen) blockers.push("This direction is frozen — clear the freeze first.");
    if (!enoughAuth) blockers.push("No authentication records remain in this direction.");
    if (!enoughEnc && hasInput()) blockers.push(`Not enough encryption budget: ${fmtInt(encBytes)} needed, ${fmtInt(m.encryption.remainingBytes)} remain. A one-time pad cannot borrow or wrap.`);

    mount(
      preview,
      callout({
        tone: blockers.length > 0 ? "danger" : "warn",
        title: "This will permanently consume, on send:",
        body: h(
          "ul",
          { class: "stack-sm", style: "margin:0;padding-left:1.1rem" },
          h("li", { text: `Encryption ${fmtInt(encBytes)} byte${encBytes === 1 ? "" : "s"} on ${dir}${m.record.kind === "fixed" ? " (fixed record)" : ""}` }),
          h("li", { text: "Authentication 1 record" })
        ),
        consequence: "This cannot be undone. The material is spent whether or not the peer ever opens the envelope."
      }),
      blockers.length > 0 ? callout({ tone: "danger", title: "Cannot send yet", body: h("ul", { style: "margin:0;padding-left:1.1rem" }, ...blockers.map((b) => h("li", { text: b }))) }) : null
    );
  }

  async function onBurn(): Promise<void> {
    const m = meters();
    let plaintext: Uint8Array;
    if (mode === "file") {
      if (!file) return;
      plaintext = new Uint8Array(await file.arrayBuffer());
    } else {
      plaintext = new TextEncoder().encode(textarea.value);
    }
    burnBtn.disabled = true;
    const reply = await ctx.engine.burn({ pairId, as: role, plaintext });
    if (!reply.ok) {
      mount(result, callout({ tone: "danger", title: "Send refused — nothing was consumed", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
      updatePreview();
      return;
    }

    const envelope = reply.envelope;
    const shareBtn = "share" in navigator
      ? h("button", { class: "btn small ghost", type: "button", on: { click: () => navigator.share({ text: envelope }).catch(() => ctx.toast("Share cancelled", "info")) } }, icon("external"), h("span", { text: "Share" }))
      : null;

    mount(
      result,
      callout({
        tone: "ok",
        title: "Burned. Material consumed, envelope ready.",
        body: `Consumed ${fmtInt(reply.consumed.encryptionBytes)} encryption byte${reply.consumed.encryptionBytes === 1 ? "" : "s"} and 1 authentication record. Send the envelope over any channel — it is wire-public.`
      }),
      h("div", { class: "codeblock", attrs: { "aria-label": "Envelope" }, text: envelope }),
      h("div", { class: "btn-row" }, copyButton(ctx, () => envelope, "Copy envelope"), saveBytesButton(() => new TextEncoder().encode(envelope), `envelope-${pairId.slice(0, 8)}.txt`, "Save envelope"), shareBtn),
      h("p", { class: "pill-note" }, icon("check"), h("span", { text: "The pad never left the worker. What you see here is the envelope only — no key, mask, or pad byte." })),
      h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Back to dashboard" })))
    );
    // Refresh meters for a subsequent send.
    const refreshed = await ctx.engine.status({ pairId });
    if (refreshed.ok) {
      pair.meters["A->B"] = refreshed.pair.meters["A->B"];
      pair.meters["B->A"] = refreshed.pair.meters["B->A"];
    }
    updatePreview();
  }

  function rebuild(): void {
    const m = meters();
    mount(inputHolder, mode === "file" ? h("div", { class: "field" }, h("label", { text: "File to encrypt" }), fileInput, h("span", { class: "hint", text: "The whole file is encrypted as one message; its length is the encryption cost (variable mode) or must fit the fixed record." })) : h("div", { class: "field" }, h("label", { text: "Message" }), textarea));
    mount(
      controls,
      h("div", { class: "field" }, h("div", { class: "field-label", text: "Your role" }), roleSelector(), h("span", { class: "hint", text: `Sending on ${directionLabel(m.direction)} · ${recordModeLabel(m.record)}` })),
      h("div", { class: "field" }, h("div", { class: "field-label", text: "What to send" }), modeSelector())
    );
    updatePreview();
  }

  const controls = h("div", { class: "stack" });

  mount(
    root,
    back,
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: `Send · ${pair.label || abbreviate(pairId)}` }),
      h("h1", { text: "Encrypt & burn" }),
      h("p", { class: "lede", text: "Each send spends real pad material for good. Choose your role, review the exact cost, then commit." })
    ),
    h("div", { class: "card stack" }, controls, inputHolder, preview, h("div", { class: "btn-row" }, burnBtn)),
    result
  );
  rebuild();
}

function abbreviate(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…`;
}
