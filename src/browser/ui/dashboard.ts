/* ============================================================================
 * TruePad 2 Browser Edition — Pad screen (the main application)
 * ----------------------------------------------------------------------------
 * One pad, four plain actions: send/open a message, send/open a file. A single
 * "% remaining" and a Ready/Warning word. The frozen internals — both
 * directions, meters, record mode, rollback state, retire — live under "Pad
 * details", and the global claims ledger under "Advanced". Nothing directional
 * is shown up top.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge, callout, meterBar, kv } from "./components.ts";
import {
  authMeter,
  directionLabel,
  directionStatus,
  encryptionMeter,
  fmtInt,
  padHealthPercent,
  padStatusWord,
  recordModeLabel
} from "./format.ts";
import { readRole } from "./role.ts";
import { PARTY_NAME } from "./format.ts";
import { savePadFileButton } from "./courier.ts";
import type { Ctx } from "./context.ts";
import type { DirectionMeters, PairSummary } from "../engine/protocol.ts";
import type { PadDirection } from "../../core/pad.ts";

function directionCard(m: DirectionMeters): HTMLElement {
  return h(
    "article",
    { class: "card stack" },
    h("div", { class: "spread" }, h("h3", { text: directionLabel(m.direction) }), badge(directionStatus(m))),
    meterBar(encryptionMeter(m)),
    meterBar(authMeter(m)),
    kv([
      { term: "Message packaging", value: recordModeLabel(m.record) },
      { term: "Messages left", value: fmtInt(m.maxRemainingSends) },
      { term: "Failed verifications", value: m.verification.frozen ? `${fmtInt(m.verification.failureCount)} — paused` : fmtInt(m.verification.failureCount) }
    ])
  );
}

function frozenBanner(ctx: Ctx, pairId: string, pair: PairSummary): HTMLElement | null {
  const frozen = (["A->B", "B->A"] as PadDirection[]).filter((d) => pair.meters[d].verification.frozen);
  if (frozen.length === 0) return null;
  return callout({
    tone: "warn",
    title: "This pad is paused",
    body: h(
      "div",
      { class: "stack-sm" },
      h("p", { text: "Too many messages failed to verify, so TruePad paused this pad to protect it. You can resume it if you trust the situation." }),
      h("button", { class: "btn small", type: "button", on: { click: () => onClearFreeze(ctx, pairId) } }, h("span", { text: "Resume pad" }))
    )
  });
}

async function onClearFreeze(ctx: Ctx, pairId: string): Promise<void> {
  if (!window.confirm("Resume this pad? Do this only if you trust that the failed messages were harmless.")) return;
  const reply = await ctx.engine.clearFreeze({ pairId });
  if (!reply.ok) { ctx.toast(reply.message, "danger"); return; }
  ctx.toast("Pad resumed.", "ok");
  ctx.navigate({ name: "pair", pairId });
}

function retirePanel(ctx: Ctx, pairId: string): HTMLElement {
  const dir = h("select", { name: "direction" }, h("option", { value: "A->B", text: "Alice → Bob" }), h("option", { value: "B->A", text: "Bob → Alice" })) as HTMLSelectElement;
  const seq = h("input", { type: "number", min: 0, step: 1, placeholder: "e.g. 4" }) as HTMLInputElement;
  const out = h("div", {});
  const submit = h(
    "button",
    { class: "btn", type: "button", on: { click: async () => {
      const throughSequence = Number(seq.value);
      if (!Number.isInteger(throughSequence) || throughSequence < 0) { out.replaceChildren(callout({ tone: "warn", title: "Enter a number", body: "Skip needs the message number to skip through." })); return; }
      submit.setAttribute("disabled", "true");
      const reply = await ctx.engine.retire({ pairId, direction: dir.value as PadDirection, throughSequence });
      submit.removeAttribute("disabled");
      if (!reply.ok) { out.replaceChildren(callout({ tone: "danger", title: "Skip refused", body: reply.message })); return; }
      ctx.toast("Skipped.", "ok");
      ctx.navigate({ name: "pair", pairId });
    } } },
    h("span", { text: "Skip messages" })
  );
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "muted", text: "Skipping permanently discards unused message slots — use it to move past material you will not send. This cannot be undone." }),
    h("div", { class: "field-grid" }, h("div", { class: "field" }, h("label", { text: "Direction" }), dir), h("div", { class: "field" }, h("label", { text: "Skip through message #" }), seq)),
    submit,
    out
  );
}

function renderDestroyed(ctx: Ctx, root: HTMLElement, info: { pairId: string; label: string }): void {
  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "Home" })),
    h("header", { class: "screen-head" }, h("div", { class: "spread" }, h("h1", { text: info.label || "Untitled pad" }), badge({ label: "Disabled", tone: "danger" }))),
    callout({
      tone: "danger",
      title: "This pad has been permanently disabled",
      body: h("div", { class: "stack-sm" }, h("p", { text: "It can no longer send or open messages, and there is no way back." }), h("p", { class: "faint", text: "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes." }))
    })
  );
}

export async function renderDashboard(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  const reply = await ctx.engine.status({ pairId });
  if (!reply.ok) {
    if (reply.kind === "refused" && reply.reason === "pair-destroyed") {
      const list = await ctx.engine.listPairs();
      const summary = list.ok ? list.pairs.find((p) => p.pairId === pairId) : undefined;
      renderDestroyed(ctx, root, { pairId, label: summary?.label ?? "" });
      return;
    }
    mount(root, h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "Home" })), callout({ tone: "danger", title: "Could not open this pad", body: reply.message }));
    return;
  }

  const pair = reply.pair;
  const pct = padHealthPercent(pair);
  const role = readRole(pairId);

  const header = h(
    "header",
    { class: "pad-header" },
    h("div", { class: "spread" }, h("h1", { class: "pad-title", text: pair.label || "Untitled pad" }), badge(padStatusWord(pair))),
    h("p", { class: "pad-remaining", text: `${pct}% remaining` })
  );

  const goSend = (mode: "message" | "file") => ctx.navigate({ name: "send", pairId, mode });
  const goOpen = (mode: "message" | "file") => ctx.navigate({ name: "open", pairId, mode });

  const primary = h(
    "div",
    { class: "pad-actions" },
    h("button", { class: "btn primary big", type: "button", on: { click: () => goSend("message") } }, icon("send"), h("span", { text: "Send message" })),
    h("button", { class: "btn big", type: "button", on: { click: () => goOpen("message") } }, icon("inbox"), h("span", { text: "Open message" })),
    h("button", { class: "btn big", type: "button", on: { click: () => goSend("file") } }, icon("file"), h("span", { text: "Send file" })),
    h("button", { class: "btn big", type: "button", on: { click: () => goOpen("file") } }, icon("file"), h("span", { text: "Open file" }))
  );

  const detailsPanel = h(
    "details",
    { class: "card advanced-block" },
    h("summary", { text: "Pad details" }),
    h(
      "div",
      { class: "stack", style: "margin-top:1rem" },
      h("p", { class: "muted", text: `You are ${PARTY_NAME[role]} on this pad. The other person is ${PARTY_NAME[role === "A" ? "B" : "A"]}.` }),
      pair.createdAt ? h("p", { class: "faint", text: `Created ${new Date(pair.createdAt).toLocaleString()}` }) : null,
      h("div", { class: "save-row" }, savePadFileButton(ctx, pairId, "Save the pad file again"), h("p", { class: "save-note", text: "Keep this file secret. It contains the one-time pad." })),
      h("div", { class: "card-grid" }, directionCard(pair.meters["A->B"]), directionCard(pair.meters["B->A"])),
      h("details", { class: "card" }, h("summary", { text: "Skip messages (rarely needed)" }), h("div", { style: "margin-top:1rem" }, retirePanel(ctx, pairId)))
    )
  );

  const secondary = h(
    "div",
    { class: "pad-secondary" },
    h("a", { class: "row link", href: "#/advanced", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "security" }); } } }, h("span", { text: "Advanced / Security details" })),
    h("a", { class: "row link danger", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "destroy", pairId }); } } }, h("span", { text: "Disable this pad" }))
  );

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "Home" })),
    header,
    frozenBanner(ctx, pairId, pair),
    primary,
    detailsPanel,
    secondary
  );
}
