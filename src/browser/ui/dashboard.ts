/* ============================================================================
 * TruePad 2 Browser Edition — Pair dashboard
 * ----------------------------------------------------------------------------
 * One pair, both directions, every action. Meters, record mode, freeze and
 * witness state are shown per direction; the actions map one-to-one onto the
 * frozen verbs (burn, open, retire, clear-freeze, export, destroy). A frozen
 * or destroyed pair says so at the top, with the consequence, before any
 * action is offered.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { badge, callout, meterBar, kv } from "./components.ts";
import { exportPanel } from "./courier.ts";
import { setPendingSendMode } from "./send.ts";
import {
  abbreviatePairId,
  authMeter,
  directionLabel,
  directionStatus,
  encryptionMeter,
  fmtInt,
  recordModeLabel,
  witnessClassLabel,
  witnessStateView
} from "./format.ts";
import type { Ctx } from "./context.ts";
import type { DirectionMeters, PairSummary } from "../engine/protocol.ts";
import type { PadDirection } from "../../core/pad.ts";

function directionCard(m: DirectionMeters): HTMLElement {
  const status = directionStatus(m);
  const witness = witnessStateView(m.witness.state);
  return h(
    "article",
    { class: "card stack" },
    h(
      "div",
      { class: "spread" },
      h("h3", { text: directionLabel(m.direction) }),
      badge(status)
    ),
    meterBar(encryptionMeter(m)),
    meterBar(authMeter(m)),
    kv([
      { term: "Record mode", value: recordModeLabel(m.record) },
      { term: "Remaining sends", value: `${fmtInt(m.maxRemainingSends)} (limited by ${m.limitedBy.toLowerCase()})` },
      { term: "Auth failures", value: m.verification.frozen ? `${fmtInt(m.verification.failureCount)} — FROZEN` : fmtInt(m.verification.failureCount) },
      { term: "Rollback witness", value: `${witnessClassLabel(m.witness.class)} · ${witness.label}` }
    ])
  );
}

function frozenBanner(ctx: Ctx, pairId: string, pair: PairSummary): HTMLElement | null {
  const frozen = (["A->B", "B->A"] as PadDirection[]).filter((d) => pair.meters[d].verification.frozen);
  if (frozen.length === 0) return null;
  const which = frozen.map(directionLabel).join(" and ");
  const clearBtn = h(
    "button",
    { class: "btn small", type: "button", on: { click: () => onClearFreeze(ctx, pairId) } },
    h("span", { text: "Clear freeze" })
  );
  return callout({
    tone: "danger",
    title: `Frozen: ${which}`,
    body: h(
      "div",
      { class: "stack-sm" },
      h("p", { text: "Repeated authentication failures froze this direction. No open will proceed until the freeze is cleared." }),
      h("p", { class: "faint", text: "Clearing is an explicit, recorded operator decision. It does not restore records already contested." }),
      clearBtn
    )
  });
}

async function onClearFreeze(ctx: Ctx, pairId: string): Promise<void> {
  const confirmed = window.confirm("Clear the freeze on this pair? This is an operator decision and is recorded. It does not restore contested records.");
  if (!confirmed) return;
  const reply = await ctx.engine.clearFreeze({ pairId });
  if (!reply.ok) {
    ctx.toast(reply.message, "danger");
    return;
  }
  ctx.toast(`Freeze cleared (${fmtInt(reply.cleared)} cleared).`, "ok");
  ctx.navigate({ name: "pair", pairId });
}

function retirePanel(ctx: Ctx, pairId: string): HTMLElement {
  const dir = h("select", { name: "direction" }, h("option", { value: "A->B", text: "Alice → Bob" }), h("option", { value: "B->A", text: "Bob → Alice" })) as HTMLSelectElement;
  const seq = h("input", { type: "number", min: 0, step: 1, name: "seq", placeholder: "e.g. 4" }) as HTMLInputElement;
  const off = h("input", { type: "number", min: 0, step: 1, name: "off", placeholder: "optional" }) as HTMLInputElement;
  const reason = h("input", { type: "text", name: "reason", placeholder: "operator retire" }) as HTMLInputElement;
  const out = h("div", {});

  const submit = h(
    "button",
    {
      class: "btn",
      type: "button",
      on: {
        click: async () => {
          const throughSequence = Number(seq.value);
          if (!Number.isInteger(throughSequence) || throughSequence < 0) {
            out.replaceChildren(callout({ tone: "warn", title: "Enter a through-sequence", body: "Retire needs the sequence to skip through." }));
            return;
          }
          const throughOffset = off.value.trim() === "" ? undefined : Number(off.value);
          submit.setAttribute("disabled", "true");
          const reply = await ctx.engine.retire({
            pairId,
            direction: dir.value as PadDirection,
            throughSequence,
            throughOffset,
            reason: reason.value.trim() || undefined
          });
          submit.removeAttribute("disabled");
          if (!reply.ok) {
            out.replaceChildren(callout({ tone: "danger", title: "Retire refused", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined }));
            return;
          }
          ctx.toast("Records retired unread.", "ok");
          ctx.navigate({ name: "pair", pairId });
        }
      }
    },
    h("span", { text: "Retire records" })
  );

  return h(
    "div",
    { class: "stack" },
    callout({
      tone: "warn",
      title: "Retiring destroys material unread",
      body: "Records and offsets you retire are burned as surely as spent ones — destroyed, never sent, never recoverable. Use it to skip past material you will not send."
    }),
    h(
      "div",
      { class: "field-grid" },
      h("div", { class: "field" }, h("label", { text: "Direction" }), dir),
      h("div", { class: "field" }, h("label", { text: "Through sequence" }), seq),
      h("div", { class: "field" }, h("label", { text: "Through offset (optional)" }), off),
      h("div", { class: "field" }, h("label", { text: "Reason" }), reason)
    ),
    submit,
    out
  );
}

function renderDestroyed(ctx: Ctx, root: HTMLElement, info: { pairId: string; label: string }): void {
  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "All pairs" })),
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: "Destroyed pair" }),
      h("div", { class: "spread" }, h("h1", { text: info.label || "(unlabelled pair)" }), badge({ label: "Destroyed", tone: "danger" })),
      h("p", { class: "lede mono", text: info.pairId })
    ),
    callout({
      tone: "danger",
      title: "This pair has crossed the destruction boundary",
      body: h(
        "div",
        { class: "stack-sm" },
        h("p", { text: "Every operation refuses it before any secret is read, and no path returns it to active use. The tombstone is durable." }),
        h("p", { class: "faint", text: "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes." })
      )
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
    mount(
      root,
      h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "All pairs" })),
      callout({ tone: "danger", title: "Could not read this pair", body: reply.message, reason: reply.kind === "refused" ? reply.reason : undefined })
    );
    return;
  }

  const pair = reply.pair;

  const goSend = (mode: "message" | "file") => {
    setPendingSendMode(mode);
    ctx.navigate({ name: "send", pairId });
  };

  const header = h(
    "header",
    { class: "screen-head" },
    h("span", { class: "eyebrow", text: "Pair dashboard" }),
    h(
      "div",
      { class: "spread" },
      h("h1", { text: pair.label || "(unlabelled pair)" }),
      badge({ label: pair.destroyed ? "Destroyed" : "Active", tone: pair.destroyed ? "danger" : "ok" })
    ),
    h("p", { class: "lede mono", text: pair.pairId, title: pair.pairId }),
    pair.createdAt ? h("p", { class: "faint", text: `Created ${pair.createdAt}` }) : null
  );

  const actions = h(
    "div",
    { class: "btn-row", style: "margin:0.5rem 0 0.5rem" },
    h("button", { class: "btn primary", type: "button", on: { click: () => goSend("message") } }, icon("send"), h("span", { text: "Send message" })),
    h("button", { class: "btn", type: "button", on: { click: () => goSend("file") } }, icon("file"), h("span", { text: "Send file" })),
    h("button", { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "open", pairId }) } }, icon("inbox"), h("span", { text: "Open received" })),
    h("button", { class: "btn ghost", type: "button", on: { click: () => ctx.navigate({ name: "pair", pairId }) } }, icon("refresh"), h("span", { text: "Refresh" }))
  );

  const details = h("details", { class: "card" }, h("summary", { text: "Advanced: retire records" }), h("div", { style: "margin-top:1rem" }, retirePanel(ctx, pairId)));

  const exportSection = h(
    "section",
    { class: "section" },
    h("h2", { text: "Courier this pad" }),
    h("div", { class: "card" }, exportPanel(ctx, pairId))
  );

  const dangerZone = h(
    "section",
    { class: "section" },
    h("h2", { text: "Destroy" }),
    h(
      "div",
      { class: "card stack" },
      h("p", { class: "muted", text: "Destruction is irreversible: it writes a durable tombstone, refuses the pair everywhere after, and best-effort overwrites the secret. It cannot prove the medium forgot the bytes." }),
      h("div", {}, h("button", { class: "btn danger", type: "button", on: { click: () => ctx.navigate({ name: "destroy", pairId }) } }, h("span", { text: "Destroy pair…" })))
    )
  );

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "All pairs" })),
    header,
    frozenBanner(ctx, pairId, pair),
    actions,
    h("div", { class: "card-grid", style: "margin-top:1rem" }, directionCard(pair.meters["A->B"]), directionCard(pair.meters["B->A"])),
    h(
      "section",
      { class: "section" },
      h("div", { class: "spread" }, h("h2", { text: "Records & sources" }), h("a", { href: "#", class: "row", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "security" }); } } }, h("span", { text: "Security status" }), icon("chevron"))),
      h("p", { class: "section-note", text: "Source declarations are operator assertions captured at generation — origins the operator stated, not provenance this tool verified. Retiring is below; the full claims ledger is on Security status." }),
      details
    ),
    exportSection,
    dangerZone
  );
}
