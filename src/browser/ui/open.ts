/* ============================================================================
 * TruePad 2 Browser Edition — Open (verify & decrypt)
 * ----------------------------------------------------------------------------
 * Every outcome is rendered as itself, with its exact consequence: a
 * structural refusal, a replay, a contested record, an out-of-window sequence,
 * a failed tag, a frozen direction, a regressed store — or an accept. Plaintext
 * is shown ONLY on accept, and only after the worker has verified and retired
 * the material. The mapping from typed reason to consequence lives in
 * format.ts; here we choose the right frame and never leak a plaintext on a
 * refusal.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { callout, copyButton, saveBytesButton } from "./components.ts";
import { consequenceFor, directionLabel, fmtInt, localRoleLabel } from "./format.ts";
import { readRole, writeRole, receiveDirection } from "./role.ts";
import type { Ctx } from "./context.ts";
import type { EngineOk } from "../engine/protocol.ts";

function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i];
    if (b === 0) return false;
    // control chars other than tab/newline/carriage-return
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / Math.max(1, n) < 0.02;
}

function renderAccepted(ctx: Ctx, result: HTMLElement, reply: Extract<EngineOk, { op: "open" }>, pairId: string): void {
  const { plaintext, skipped } = reply;
  const text = isProbablyText(plaintext);
  const decoded = text ? new TextDecoder().decode(plaintext) : "";
  const skippedNote =
    skipped.authRecords > 0
      ? `${fmtInt(skipped.authRecords)} earlier record${skipped.authRecords === 1 ? " was" : "s were"} skipped and retired to reach this one — lost, never reusable.`
      : "No records were skipped.";

  mount(
    result,
    callout({
      tone: "ok",
      title: "Accepted — authenticated, then opened",
      body: h(
        "div",
        { class: "stack-sm" },
        h("p", { text: "The tag verified before any plaintext was released, and the material was retired in both namespaces. This record can never open again." }),
        h("p", { class: "faint", text: skippedNote })
      )
    }),
    text
      ? h(
          "div",
          { class: "stack-sm" },
          h("div", { class: "field-label", text: "Recovered plaintext" }),
          h("div", { class: "codeblock", attrs: { "aria-label": "Recovered plaintext" }, text: decoded }),
          h("div", { class: "btn-row" }, copyButton(ctx, () => decoded, "Copy text"), saveBytesButton(() => plaintext, `opened-${pairId.slice(0, 8)}.bin`, "Save as file"))
        )
      : h(
          "div",
          { class: "stack-sm" },
          callout({ tone: "info", title: `Binary content — ${fmtInt(plaintext.length)} bytes`, body: "The recovered bytes are not printable text. Save them to a file to keep them." }),
          h("div", { class: "btn-row" }, saveBytesButton(() => plaintext, `opened-${pairId.slice(0, 8)}.bin`, "Save as file"))
        ),
    h("div", { class: "btn-row", style: "margin-top:1rem" }, h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, h("span", { text: "Back to dashboard" })))
  );
}

export async function renderOpen(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const back = h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "pair", pairId }); } } }, icon("back"), h("span", { text: "Dashboard" }));

  let role: "A" | "B" = readRole(pairId);
  const envelopeInput = h("textarea", { rows: 4, spellcheck: false, placeholder: "Paste the envelope from your peer…" }) as HTMLTextAreaElement;
  const fileInput = h("input", { type: "file" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    if (f) envelopeInput.value = (await f.text()).trim();
  });

  const roleRow = h("div", { class: "btn-row" });
  function paintRole(): void {
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
              paintRole();
              paintHint();
            }
          }
        },
        h("span", { text: `I am ${localRoleLabel(r)}` })
      );
    mount(roleRow, mk("A"), mk("B"));
  }
  const hint = h("span", { class: "hint" });
  function paintHint(): void {
    hint.textContent = `Opening on ${directionLabel(receiveDirection(role))} — the traffic your peer sent to you.`;
  }
  paintRole();
  paintHint();

  const result = h("div", { class: "section" });
  const openBtn = h(
    "button",
    {
      class: "btn primary",
      type: "button",
      on: { click: onOpen }
    },
    icon("inbox"),
    h("span", { text: "Verify & open" })
  ) as HTMLButtonElement;

  async function onOpen(): Promise<void> {
    const envelope = envelopeInput.value.trim();
    if (envelope.length === 0) {
      mount(result, callout({ tone: "warn", title: "Paste an envelope first", body: "Nothing to open yet." }));
      return;
    }
    openBtn.disabled = true;
    const reply = await ctx.engine.open({ pairId, as: role, envelope });
    openBtn.disabled = false;

    if (reply.ok) {
      renderAccepted(ctx, result, reply, pairId);
      return;
    }

    if (reply.kind === "error") {
      mount(result, callout({ tone: "danger", title: "Open failed", body: reply.message }));
      return;
    }

    const c = consequenceFor(reply.reason);
    mount(
      result,
      callout({
        tone: c.tone,
        title: c.title,
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { text: reply.message }),
          h("p", { class: "faint", text: "No plaintext is shown: an open reveals nothing until the tag verifies." })
        ),
        consequence: c.consequence,
        reason: reply.reason
      })
    );
  }

  mount(
    root,
    back,
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: "Open received" }),
      h("h1", { text: "Verify & open" }),
      h("p", { class: "lede", text: "Paste an envelope your peer sent you. It is verified in the worker before a single plaintext byte is released; whatever the outcome, its consequence is shown in full." })
    ),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "field" }, h("div", { class: "field-label", text: "Your role" }), roleRow, hint),
      h("div", { class: "field" }, h("label", { text: "Envelope" }), envelopeInput),
      h("div", { class: "field" }, h("div", { class: "field-label", text: "…or load from a file" }), fileInput),
      h("div", { class: "btn-row" }, openBtn)
    ),
    result
  );
}
