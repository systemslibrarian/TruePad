/* ============================================================================
 * TruePad Browser Edition — Pad screen (the main application)
 * ----------------------------------------------------------------------------
 * One pad, four plain actions: send/open a message, send/open a file. A status
 * word and one capacity bar say how the pad is doing.
 *
 * Three levels, kept apart. Level 1 is the four actions. Level 2 is "Pad
 * details": who the other person is, how many messages are left, and how to
 * save the pad file again — nothing an ordinary person needs a glossary for.
 * Level 3 is "Advanced": directions, budgets, record policy, skip. Nothing
 * from Level 3 is allowed to surface above it, and the one irreversible action
 * is the quietest thing on the screen.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { actionTile, backLink, badge, callout, capacityBar, kv, meterBar, notice, panel, rowLink } from "./components.ts";
import {
  authMeter,
  DESTRUCTION_LIMITATION,
  directionLabel,
  directionStatus,
  encryptionMeter,
  fmtInt,
  padHealthPercent,
  padStatusWord,
  recordModeLabel
} from "./format.ts";
import { readRole, sendDirection } from "./role.ts";
import { removePair } from "./removed.ts";
import { PARTY_NAME } from "./format.ts";
import { savePadFileButton } from "./courier.ts";
import type { Ctx } from "./context.ts";
import type { DeploymentView, DirectionMeters, PairSummary } from "../engine/protocol.ts";
import type { PadDirection } from "../../core/pad.ts";
import { DELIVERY_LABEL, SOURCE_LABEL } from "../../claims/shannon-deployment.ts";

/* A factual source/delivery classification for this pad, derived by the engine.
 * It is never a security score, and never a green "eligible" badge that could be
 * screenshot without its qualifier: the Browser Edition generates from a
 * software CSPRNG and delivers online by computational cryptography, so a
 * browser pad is always "Not eligible" or "Insufficient evidence" for the
 * physical-uniform-source, information-theoretic deployment path — which is the
 * honest thing to say, not a defect. */
function deploymentBlock(d: DeploymentView): HTMLElement {
  const assessmentText =
    d.assessment === "not-eligible"
      ? "Not eligible"
      : d.assessment === "insufficient-evidence"
        ? "Insufficient evidence"
        : "Conditionally eligible";
  const reason = d.knownReason ? d.knownReason.charAt(0).toUpperCase() + d.knownReason.slice(1) : null;
  return h(
    "div",
    { class: "deployment" },
    h("h3", { class: "sub", text: "Pad source and delivery" }),
    kv([
      { term: "Pad source", value: SOURCE_LABEL[d.source] },
      { term: "Delivery", value: DELIVERY_LABEL[d.delivery] },
      { term: "Shannon deployment", value: assessmentText }
    ]),
    reason ? h("p", { class: "save-note", text: `Why? ${reason}.` }) : null,
    h("p", {
      class: "faint small",
      text: "A factual classification, not a security score. TruePad has not proved physical randomness, private delivery, or that no copy exists."
    })
  );
}

function directionCard(m: DirectionMeters): HTMLElement {
  return h(
    "article",
    { class: "card" },
    h("div", { class: "spread" }, h("h3", { text: directionLabel(m.direction) }), badge(directionStatus(m))),
    h("div", {}, meterBar(encryptionMeter(m)), meterBar(authMeter(m))),
    kv([
      { term: "Message packaging", value: recordModeLabel(m.record) },
      { term: "Messages left", value: fmtInt(m.maxRemainingSends) },
      {
        term: "Failed verifications",
        value: m.verification.frozen ? `${fmtInt(m.verification.failureCount)} — paused` : fmtInt(m.verification.failureCount)
      }
    ])
  );
}

function frozenBanner(ctx: Ctx, pairId: string, pair: PairSummary): HTMLElement | null {
  const frozen = (["A->B", "B->A"] as PadDirection[]).filter((d) => pair.meters[d].verification.frozen);
  if (frozen.length === 0) return null;

  const actions = h("div", { class: "btn-row" });
  const askConfirm = (): void => {
    mount(
      actions,
      h(
        "button",
        { class: "btn sm primary", type: "button", on: { click: () => void onClearFreeze(ctx, pairId) } },
        h("span", { text: "Yes, resume this pad" })
      ),
      h("button", { class: "btn sm ghost", type: "button", on: { click: paintIdle } }, h("span", { text: "Cancel" }))
    );
  };
  function paintIdle(): void {
    mount(actions, h("button", { class: "btn sm", type: "button", on: { click: askConfirm } }, h("span", { text: "Resume pad" })));
  }
  paintIdle();

  return callout({
    tone: "warn",
    title: "This pad is paused",
    body: h(
      "div",
      { class: "stack-sm" },
      h("p", { text: "Too many messages failed to verify, so TruePad paused this pad. Resume it only if you trust that those failures were harmless." }),
      actions
    )
  });
}

async function onClearFreeze(ctx: Ctx, pairId: string): Promise<void> {
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
    {
      class: "btn",
      type: "button",
      on: {
        click: async () => {
          const throughSequence = Number(seq.value);
          if (!Number.isInteger(throughSequence) || throughSequence < 0) {
            mount(out, callout({ tone: "warn", title: "Enter a number", body: "Skip needs the message number to skip through." }));
            return;
          }
          submit.setAttribute("disabled", "true");
          const reply = await ctx.engine.retire({ pairId, direction: dir.value as PadDirection, throughSequence });
          submit.removeAttribute("disabled");
          if (!reply.ok) { mount(out, callout({ tone: "danger", title: "Skip refused", body: reply.message })); return; }
          ctx.toast("Skipped.", "ok");
          ctx.navigate({ name: "pair", pairId });
        }
      }
    },
    h("span", { text: "Skip messages" })
  );
  return h(
    "div",
    { class: "stack" },
    h("p", { class: "faint", text: "Skipping permanently discards unused message slots — use it to move past material you will not send. This cannot be undone." }),
    h("div", { class: "field-grid" }, h("div", { class: "field" }, h("label", { text: "Direction" }), dir), h("div", { class: "field" }, h("label", { text: "Skip through message #" }), seq)),
    h("div", { class: "btn-row" }, submit),
    out
  );
}

// A dead pad. The statement stays exactly as honest as it was — nothing here
// resets, restores or reuses anything. "Create a new pad" is the ordinary
// create flow producing a NEW pad with a new id and new material. "Remove from
// TruePad" is the product forgetting the pad: it drops out of the UI for good,
// its old route stops resolving, and its name is never shown again. It does
// NOT touch the store or the tombstone — the pair stays permanently unusable
// and this pad file can never be added back.
export function renderDestroyed(ctx: Ctx, root: HTMLElement, info: { pairId: string; label: string }): void {
  const onRemove = (): void => {
    removePair(info.pairId);
    ctx.toast("Removed from TruePad.", "info");
    ctx.navigate({ name: "home" });
  };

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "home" }), "Home"),
      h(
        "header",
        { class: "pad-head" },
        h(
          "div",
          { class: "pad-head-top" },
          h("h1", { class: "pad-title", text: info.label || "Untitled pad" }),
          badge({ label: "Disabled", tone: "danger" })
        )
      ),
      callout({
        tone: "danger",
        title: "This pad has been permanently disabled",
        body: h(
          "div",
          { class: "stack-sm" },
          h("p", { text: "It can no longer send or open messages, and there is no way back." }),
          h("p", { class: "faint", text: DESTRUCTION_LIMITATION })
        )
      }),
      h(
        "div",
        { class: "stack-sm" },
        h("p", { text: "To keep messaging this person, make a new pad and give them a copy of it." }),
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            { class: "btn primary", type: "button", on: { click: () => ctx.navigate({ name: "create" }) } },
            icon("plus"),
            h("span", { text: "Create a new pad" })
          ),
          h(
            "button",
            { class: "btn ghost", type: "button", on: { click: onRemove } },
            h("span", { text: "Remove from TruePad" })
          )
        ),
        h("p", { class: "faint", text: "Removing takes this pad out of TruePad for good. It stays permanently disabled, and this pad file can never be added back." })
      )
    )
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
      h(
        "div",
        { class: "screen" },
        backLink(() => ctx.navigate({ name: "home" }), "Home"),
        callout({ tone: "danger", title: "Could not open this pad", body: reply.message })
      )
    );
    return;
  }

  const pair = reply.pair;
  const role = readRole(pairId);
  const unusable = pair.destroyed;

  const header = h(
    "header",
    { class: "pad-head" },
    h(
      "div",
      { class: "pad-head-top" },
      h("h1", { class: "pad-title", text: pair.label || "Untitled pad" }),
      badge(padStatusWord(pair))
    ),
    capacityBar(padHealthPercent(pair))
  );

  const goSend = (mode: "message" | "file") => ctx.navigate({ name: "send", pairId, mode });
  const goOpen = (mode: "message" | "file") => ctx.navigate({ name: "open", pairId, mode });

  const actions = h(
    "div",
    { class: "actions-grid" },
    actionTile({ label: "Send message", icon: "send", accent: true, disabled: unusable, onClick: () => goSend("message") }),
    actionTile({ label: "Open message", icon: "inbox", disabled: unusable, onClick: () => goOpen("message") }),
    actionTile({ label: "Send file", icon: "file-up", disabled: unusable, onClick: () => goSend("file") }),
    actionTile({ label: "Open file", icon: "file-down", disabled: unusable, onClick: () => goOpen("file") })
  );

  // Level 2: plain facts, no glossary required.
  const sendable = pair.meters[sendDirection(role)].maxRemainingSends;
  const details = panel(
    "Pad details",
    {},
    kv([
      { term: "Messages you can still send", value: fmtInt(sendable) },
      { term: "Created", value: pair.createdAt ? new Date(pair.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—" }
    ]),
    deploymentBlock(reply.deployment),
    // Sharing lives HERE, in details — not as a fifth tile beside the four
    // things this screen is actually for. Handing a pad over is provisioning,
    // and it happens once.
    h(
      "div",
      { class: "save-row" },
      h("h3", { class: "sub", text: "Share this pad" }),
      h("p", { class: "save-note", text: "Choose one way to give the other person their copy." }),
      h(
        "div",
        { class: "btn-row" },
        h(
          "button",
          { class: "btn", type: "button", on: { click: () => ctx.navigate({ name: "send-online", pairId }) } },
          h("span", { text: "Send securely online" })
        ),
        savePadFileButton(ctx, pairId, "Save pad file")
      ),
      // The engine decides eligibility — provenance, genesis, and which handoff
      // this pad already committed. Reproducing those rules here would be a
      // second, weaker copy that drifts.
      h("p", { class: "save-note", text: "Keep the pad file secret — anyone who has it can read these messages." })
    ),
    // Level 3 begins here and nowhere above it.
    panel(
      "Advanced",
      {},
      h("p", { class: "faint", text: "Implementation detail. You never need this to use TruePad." }),
      kv([{ term: "You are", value: PARTY_NAME[role] }, { term: "The other person", value: PARTY_NAME[role === "A" ? "B" : "A"] }]),
      h("div", { class: "card-grid" }, directionCard(pair.meters["A->B"]), directionCard(pair.meters["B->A"])),
      panel("Skip messages (rarely needed)", {}, retirePanel(ctx, pairId))
    )
  );

  const secondary = h(
    "nav",
    { class: "stack-sm", aria: { label: "Pad settings" } },
    rowLink({ text: "Security", icon: "shield", onClick: () => ctx.navigate({ name: "security" }) }),
    h("hr", { class: "divider" }),
    rowLink({ text: "Disable this pad", icon: "trash", danger: true, onClick: () => ctx.navigate({ name: "destroy", pairId }) })
  );

  mount(
    root,
    h(
      "div",
      { class: "screen" },
      backLink(() => ctx.navigate({ name: "home" }), "Home"),
      header,
      frozenBanner(ctx, pairId, pair),
      actions,
      ctx.storagePersistent === false
        ? notice({
            text: "Keep a backup of your pad file. This browser may clear its storage.",
            onLink: () => ctx.navigate({ name: "security" })
          })
        : null,
      details,
      secondary
    )
  );
}
