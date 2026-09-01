/* ============================================================================
 * TruePad Browser Edition — receiving a pad securely online (the recipient)
 * ----------------------------------------------------------------------------
 * Three screens, in the order the ceremony actually happens:
 *
 *   1. create a receive code, and compare twelve words with the other person;
 *   2. choose the sealed file they send back;
 *   3. read EIGHT words to them FIRST, then decide.
 *
 * RECEIVER-FIRST IS THE WHOLE SHAPE OF SCREEN 3. The recipient sees their eight
 * words immediately, because §8.2's argument depends on Bob committing to the
 * package he opened before Alice speaks. The sender's screen is built the other
 * way round — masked until she has heard his. Neither the worker nor this UI
 * can observe who actually spoke first; the ordering is supported by the
 * interface and remains an OPERATOR assumption.
 *
 * The three buttons map to three different durable outcomes, and the difference
 * matters more than the wording suggests:
 *
 *   The words matched   → commit    the request is consumed, the pad imported
 *   They did not match  → reject    the request is TERMINAL, permanently
 *   Close for now       → abandon   nothing durable changes; reopen any time
 *
 * A misrouted button here would either destroy a good transfer or quietly leave
 * a rejected one reusable, so there is exactly one call site for each.
 * ========================================================================= */

import { backLink, callout, card, panel, screenHead } from "./components.ts";
import { h, icon, mount } from "./dom.ts";
import { showQrCodeControl } from "./qr/show-qr.ts";
import {
  checkAllNote,
  comparisonWords,
  friendlyRefusal,
  HNDL_NOTE,
  onlineDetailsPanel,
  refusalDetails
} from "./spt-shared.ts";
import { writeRole } from "./role.ts";
import type { Ctx } from "./context.ts";

type CreatedRequest = {
  requestId: string;
  requestHash: string;
  tpr2: string;
  requestIndices: number[];
  expiresAt: string;
};

/** The live confirmation session. It holds a cross-tab lock in the worker, so
 *  leaving the screen without deciding must release it — see `ctx.onLeave`. */
type LiveSession = { sessionId: string; requestId: string; confirmationIndices: number[] };

function expiryWords(iso: string): string {
  const days = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 86_400_000));
  if (days <= 0) return "It expires today.";
  if (days === 1) return "It works for about one more day.";
  return `It works for about ${days} more days.`;
}

/* ---- screen 1: create the code ------------------------------------------- */

export async function renderReceiveOnline(ctx: Ctx, root: HTMLElement): Promise<void> {
  const screen = h("div", { class: "screen" });
  const created: { value: CreatedRequest | null } = { value: null };

  const body = h("div");
  const render = (): void => {
    body.replaceChildren();
    if (created.value === null) body.appendChild(startCard());
    else body.appendChild(codeCard(created.value));
  };

  function startCard(): HTMLElement {
    const btn = h(
      "button",
      { class: "btn primary", type: "button" },
      icon("plus"),
      h("span", { text: "Create receive code" })
    ) as HTMLButtonElement;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const reply = await ctx.engine.sptCreateRequest();
      btn.disabled = false;
      if (!reply.ok) {
        body.appendChild(callout({ tone: "danger", title: friendlyRefusal(reply.kind === "refused" ? reply.reason : ""), body: h("div") }));
        return;
      }
      created.value = {
        requestId: reply.requestId,
        requestHash: reply.requestHash,
        tpr2: reply.tpr2,
        requestIndices: reply.requestIndices,
        expiresAt: reply.expiresAt
      };
      render();
    });

    return card(
      h("ol", { class: "steps" },
        h("li", { text: "Create a receive code." }),
        h("li", { text: "Send it to the other person." }),
        h("li", { text: "Compare the words." }),
        h("li", { text: "Open the sealed pad they send back." })
      ),
      h("div", { class: "actions" }, btn)
    );
  }

  function codeCard(req: CreatedRequest): HTMLElement {
    const area = h("textarea", {
      class: "code-area",
      id: "receive-code",
      rows: 4,
      spellcheck: false,
      attrs: { readonly: "readonly" }
    }) as HTMLTextAreaElement;
    // The EXACT text. No label, no fence, no trailing newline: what is copied
    // must decode to the same canonical request the engine published.
    area.value = req.tpr2;

    const copy = h("button", { class: "btn primary", type: "button" }, icon("copy"), h("span", { text: "Copy receive code" })) as HTMLButtonElement;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(req.tpr2);
        // The receive code is PUBLIC. The "never the clipboard" rule belongs to
        // raw pad material, and saying "secret copied" here would teach the
        // wrong instinct about the file that really is one.
        ctx.toast("Receive code copied.", "ok");
      } catch {
        area.select();
        ctx.toast("Select the code and copy it.", "info");
      }
    });

    const cancel = h("button", { class: "linkish danger", type: "button", text: "Cancel this receive code" }) as HTMLButtonElement;
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      const reply = await ctx.engine.sptCancelRequest({ requestId: req.requestId });
      cancel.disabled = false;
      if (!reply.ok) {
        ctx.toast(friendlyRefusal(reply.kind === "refused" ? reply.reason : ""), "danger");
        return;
      }
      if (reply.state === "terminal-unreadable") {
        ctx.toast("TruePad could not read this receive code's record, so it will not be used again.", "danger");
      } else {
        ctx.toast("This receive code can no longer be used.", "ok");
      }
      ctx.navigate({ name: "import" });
    });

    const persistWarning =
      ctx.storagePersistent === false
        ? callout({
            tone: "warn",
            title: "Keep this browser's data until the transfer is finished",
            body: h("p", { text: "If it is cleared, this receive code will stop working." })
          })
        : null;

    return card(
      h("label", { class: "field-label", attrs: { for: "receive-code" }, text: "Your receive code" }),
      area,
      h("div", { class: "actions" }, copy),
      // Optional: the SAME public receive code as a QR the other person can scan.
      // Copy/paste above stays the complete path; this only adds a second way.
      showQrCodeControl(req.tpr2),
      h("p", { class: "faint small", text: `Send this to the other person. ${expiryWords(req.expiresAt)}` }),
      persistWarning,
      h("h2", { class: "sub", text: "Compare these words with the other person before they send the pad" }),
      comparisonWords(req.requestIndices, { label: "Receive code words, twelve in order" }),
      checkAllNote(12),
      h("div", { class: "actions quiet" }, cancel)
    );
  }

  render();
  mount(
    root,
    screen,
    (screen.appendChild(backLink(() => ctx.navigate({ name: "import" }), "Add a shared pad")),
    screen.appendChild(
      screenHead({
        title: "Receive a pad",
        lede: "Create a code the other person can use to send you a pad securely."
      })
    ),
    screen.appendChild(body),
    screen.appendChild(chooseSealedCard(ctx)),
    screen.appendChild(onlineDetailsPanel()),
    screen)
  );
}

/* ---- screen 2: choose the sealed file ------------------------------------ */

/** Always offered, even in a session that did not create the code.
 *
 *  The recipient may create a code, close TruePad, and come back days later
 *  with the sealed file. The durable request is identified from the package
 *  itself, so nothing about receiving depends on transient page state. */
function chooseSealedCard(ctx: Ctx): HTMLElement {
  // sr-only is CLIPPED, not removed: it stays focusable and reachable by a
  // screen reader, so it needs its own name rather than borrowing the
  // button's. An unnamed file input announces as just "file upload button".
  const input = h("input", {
    type: "file",
    class: "sr-only",
    id: "sealed-file",
    aria: { label: "Choose the sealed pad file the other person sent you" },
    attrs: { accept: ".tps2,application/octet-stream" }
  }) as HTMLInputElement;
  const pick = h("button", { class: "btn", type: "button" }, icon("upload"), h("span", { text: "Choose sealed pad" })) as HTMLButtonElement;
  const errorSlot = h("div");
  pick.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    errorSlot.replaceChildren();
    pick.disabled = true;
    // Read the bytes and hand them straight to the worker. The page never
    // parses TPS2, never looks at a KEM field, and never keeps the buffer: the
    // transfer detaches it, and from here the opaque session is the only handle.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const reply = await ctx.engine.sptOpenSealed({ package: bytes });
    pick.disabled = false;
    input.value = "";
    if (!reply.ok) {
      const reason = reply.kind === "refused" ? reply.reason : "";
      errorSlot.appendChild(
        callout({
          tone: "danger",
          title: friendlyRefusal(reason),
          body: reply.kind === "refused" ? refusalDetails(reason, reply.message) : h("div")
        })
      );
      return;
    }
    ctx.navigate({
      name: "receive-confirm",
      session: { sessionId: reply.sessionId, requestId: reply.requestId, confirmationIndices: reply.confirmationIndices }
    });
  });

  return card(
    h("h2", { class: "sub", text: "Already have the sealed pad?" }),
    h("p", { class: "faint small", text: "Choose the file the other person sent you." }),
    h("div", { class: "actions" }, pick, input),
    errorSlot
  );
}

/* ---- screen 3: read eight words, then decide ----------------------------- */

export function renderReceiveConfirm(ctx: Ctx, root: HTMLElement, session: LiveSession): void {
  const screen = h("div", { class: "screen" });
  let settled = false;

  // Leaving this screen any other way — Back, Home, a hash change, the browser's
  // own back button — must release the worker's cross-tab lock. Worker death
  // would release it eventually, but ordinary in-app navigation does not kill
  // the worker, and a stranded lock blocks every other tab from opening the
  // same transfer.
  ctx.onLeave(() => {
    if (settled) return;
    settled = true;
    void ctx.engine.sptAbandon({ sessionId: session.sessionId });
  });

  const errorSlot = h("div");
  const actions = h("div", { class: "actions" });

  const matched = h("button", { class: "btn primary", type: "button" }, icon("check"), h("span", { text: "The words matched" })) as HTMLButtonElement;
  const mismatched = h("button", { class: "btn danger", type: "button" }, icon("alert"), h("span", { text: "They did not match" })) as HTMLButtonElement;
  const later = h("button", { class: "btn", type: "button" }, h("span", { text: "Close for now" })) as HTMLButtonElement;

  const setBusy = (busy: boolean): void => {
    matched.disabled = busy;
    mismatched.disabled = busy;
    later.disabled = busy;
  };

  const fail = (reason: string, message: string): void => {
    errorSlot.replaceChildren(
      callout({ tone: "danger", title: friendlyRefusal(reason), body: refusalDetails(reason, message) })
    );
  };

  matched.addEventListener("click", async () => {
    setBusy(true);
    const reply = await ctx.engine.sptCommitReceive({ sessionId: session.sessionId });
    if (!reply.ok) {
      setBusy(false);
      // A loss is terminal for this request; anything else may be retried.
      if (reply.kind === "refused" && reply.reason !== "spt-request-unavailable") settled = true;
      fail(reply.kind === "refused" ? reply.reason : "", reply.message);
      return;
    }
    settled = true;
    // The recipient is B on the pad they just received.
    writeRole(reply.pair.pairId, "B");
    ctx.toast("Pad added.", "ok");
    ctx.navigate({ name: "pair", pairId: reply.pair.pairId });
  });

  mismatched.addEventListener("click", async () => {
    setBusy(true);
    const reply = await ctx.engine.sptReject({ sessionId: session.sessionId });
    setBusy(false);
    if (!reply.ok) {
      fail(reply.kind === "refused" ? reply.reason : "", reply.message);
      return;
    }
    settled = true;
    mount(root, rejectedScreen(ctx));
    root.focus();
  });

  later.addEventListener("click", async () => {
    setBusy(true);
    settled = true;
    await ctx.engine.sptAbandon({ sessionId: session.sessionId });
    ctx.navigate({ name: "receive-online" });
  });

  actions.append(matched, mismatched, later);

  mount(
    root,
    (screen.appendChild(
      screenHead({
        title: "Check the sender",
        lede: "Read these words to the sender FIRST, then ask whether theirs match."
      })
    ),
    screen.appendChild(
      card(
        comparisonWords(session.confirmationIndices, { label: "Confirmation words, eight in order" }),
        checkAllNote(8),
        h("p", { text: "Ask them whether their words match." }),
        actions,
        errorSlot
      )
    ),
    screen.appendChild(
      panel(
        "What happens next",
        {},
        h("p", { text: "If the words match, the pad is added and this receive code is used up." }),
        h("p", { text: "If they do not match, this receive code is cancelled for good and you will need a new one." }),
        h("p", { text: HNDL_NOTE })
      )
    ),
    screen)
  );
}

function rejectedScreen(ctx: Ctx): HTMLElement {
  const again = h("button", { class: "btn primary", type: "button" }, h("span", { text: "Create a new receive code" })) as HTMLButtonElement;
  again.addEventListener("click", () => ctx.navigate({ name: "receive-online" }));
  return h(
    "div",
    { class: "screen" },
    screenHead({ title: "This transfer was rejected" }),
    card(
      h("p", { text: "This receive code cannot be used again." }),
      h("p", { text: "Ask the sender to create a new pad, then create a new receive code." }),
      h("div", { class: "actions" }, again)
    )
  );
}
