/* ============================================================================
 * TruePad Browser Edition — sending a pad securely online (the sender)
 * ----------------------------------------------------------------------------
 * Paste the receive code → compare twelve words → seal → save or share the
 * sealed file → hear the recipient's eight words → reveal your own → compare.
 *
 * THE MASK IS NOT DECORATION
 * --------------------------
 * §8.2's argument for eight words rests on the recipient committing FIRST: Bob
 * reads the words for the package he actually opened, before Alice says
 * anything, so hearing him hands an attacker a value he must already have
 * matched rather than a target to aim at.
 *
 * So Alice's words are not merely hidden here — before she clicks "I heard
 * their words" they are **not in the DOM at all**. Not behind `display:none`,
 * not in a `data-` attribute, not in a title, not in the URL, not in storage,
 * not in a log. Text rendered and then covered is text that can be read by
 * anyone who looks slightly harder, and the point of the ordering is that it is
 * not available to be read yet.
 *
 * The indices do sit in a JS variable, because the worker returned them at seal
 * time. That is unavoidable and is not the thing being defended: this is a
 * ceremony aid for an honest operator, not a defence against the page itself.
 * A page with worker-RPC authority is endpoint compromise (§15).
 *
 * THE HANDOFF IS ALREADY SPENT WHEN SEALING SUCCEEDS
 * --------------------------------------------------
 * Everything after `spt-seal` returns — the download failing, the share sheet
 * being cancelled, the words not matching — happens to a pad that has already
 * committed its one handoff. The screen never says "nothing happened", and
 * never offers to seal again to someone else.
 *
 * COMING BACK TO THIS SCREEN LATER
 * --------------------------------
 * Entering the route cold shows the paste card again, because the UI cannot ask
 * "is this pad already sealed?" — there are nine SPT RPCs and none of them
 * answers that without a receive code, and mirroring the engine's eligibility
 * rules here would be a second, weaker copy that drifts (the same reasoning
 * `dashboard.ts` gives for offering *Save pad file* unconditionally). So the
 * engine decides, on the code actually pasted:
 *
 *   · the SAME code  → the committed package comes back, byte-identical, under
 *     "This is the same sealed pad as before. Nothing new was created."
 *   · a DIFFERENT code → refused at seal, "This pad was already sent online.
 *     Use one delivery method for each pad." No second package exists.
 *
 * The cost is real and is not hidden: in the second case the operator has
 * already compared twelve words before being told. That is why the rule sits at
 * the top of this screen, above the paste box, rather than only in the refusal.
 * ========================================================================= */

import { backLink, callout, card, panel, screenHead } from "./components.ts";
import { h, icon, mount } from "./dom.ts";
import {
  busyButton,
  canShareSealed,
  checkAllNote,
  comparisonWords,
  friendlyRefusal,
  HNDL_NOTE,
  ONE_METHOD_NOTE,
  ONLINE_CLAIM_SHORT,
  onlineDetailsPanel,
  refusalDetails,
  saveSealedFile,
  sealedFilename,
  shareSealedFile
} from "./spt-shared.ts";
import type { Ctx } from "./context.ts";

type Stage =
  | { at: "paste" }
  | { at: "compare"; reviewId: string; requestHash: string; requestIndices: number[] }
  | { at: "ready"; requestHash: string }
  | { at: "sealed"; requestHash: string; package: Uint8Array; confirmationIndices: number[]; reshared: boolean };

export async function renderSendOnline(ctx: Ctx, root: HTMLElement, pairId: string): Promise<void> {
  let stage: Stage = { at: "paste" };
  const screen = h("div", { class: "screen" });
  const body = h("div");

  const rerender = (): void => {
    body.replaceChildren();
    switch (stage.at) {
      case "paste":
        body.appendChild(pasteCard());
        break;
      case "compare":
        body.appendChild(compareCard(stage.reviewId, stage.requestIndices));
        break;
      case "ready":
        body.appendChild(readyCard(stage.requestHash));
        break;
      case "sealed":
        body.appendChild(sealedCard(stage.package, stage.confirmationIndices, stage.reshared));
        break;
    }
  };

  /* ---- 1. paste the receive code ---------------------------------------- */

  function pasteCard(): HTMLElement {
    const area = h("textarea", {
      class: "code-area",
      id: "paste-code",
      rows: 4,
      spellcheck: false,
      placeholder: "TRUEPAD receive code"
    }) as HTMLTextAreaElement;
    const errorSlot = h("div");
    const go = h("button", { class: "btn primary", type: "button" }, h("span", { text: "Continue" })) as HTMLButtonElement;

    go.addEventListener("click", async () => {
      errorSlot.replaceChildren();
      go.disabled = true;
      const reply = await ctx.engine.sptInspectRequest({ text: area.value });
      go.disabled = false;
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
      // From here the WORKER holds the request it decoded. Editing the textarea
      // afterwards cannot change what gets sealed: confirm carries the review
      // handle, never the text.
      stage = {
        at: "compare",
        reviewId: reply.reviewId,
        requestHash: reply.requestHash,
        requestIndices: reply.requestIndices
      };
      rerender();
    });

    return card(
      h("p", { text: "Ask the other person to create a receive code, then paste it here." }),
      h("label", { class: "field-label", attrs: { for: "paste-code" }, text: "Receive code" }),
      area,
      h("div", { class: "actions" }, go),
      errorSlot
    );
  }

  /* ---- 2. the twelve words ---------------------------------------------- */

  function compareCard(reviewId: string, indices: number[]): HTMLElement {
    const errorSlot = h("div");
    const ok = h("button", { class: "btn primary", type: "button" }, icon("check"), h("span", { text: "The words matched" })) as HTMLButtonElement;
    const back = h("button", { class: "btn", type: "button" }, h("span", { text: "Back" })) as HTMLButtonElement;

    ok.addEventListener("click", async () => {
      errorSlot.replaceChildren();
      ok.disabled = true;
      const reply = await ctx.engine.sptConfirmRequest({ reviewId });
      ok.disabled = false;
      if (!reply.ok) {
        const reason = reply.kind === "refused" ? reply.reason : "";
        // Stay here. The review handle is still good unless the worker lost it,
        // so there is no need to make the operator paste and compare again.
        errorSlot.appendChild(
          callout({
            tone: "danger",
            title: friendlyRefusal(reason),
            body: reply.kind === "refused" ? refusalDetails(reason, reply.message) : h("div")
          })
        );
        return;
      }
      stage = { at: "ready", requestHash: reply.requestHash };
      rerender();
    });
    back.addEventListener("click", () => {
      stage = { at: "paste" };
      rerender();
    });

    return card(
      h("h3", { class: "sub", text: "Read these words to the other person" }),
      h("p", { text: "Check that all 12 match what they see, in the same order." }),
      comparisonWords(indices, { label: "Receive code words, twelve in order" }),
      checkAllNote(12),
      h("div", { class: "actions" }, ok, back),
      errorSlot
    );
  }

  /* ---- 3. seal ----------------------------------------------------------- */

  function readyCard(requestHash: string): HTMLElement {
    const errorSlot = h("div");
    const seal = h("button", { class: "btn primary", type: "button" }, icon("lock"), h("span", { text: "Seal pad" })) as HTMLButtonElement;

    seal.addEventListener("click", async () => {
      errorSlot.replaceChildren();
      busyButton(seal, true, "Sealing the pad…", "Seal pad");
      // The page supplies a request fingerprint and a pad id. Not the request
      // body, not the recipient's key, not one byte of pad material.
      const reply = await ctx.engine.sptSeal({ requestHash, pairId });
      busyButton(seal, false, "Sealing the pad…", "Seal pad");
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
      stage = {
        at: "sealed",
        requestHash,
        package: reply.package,
        confirmationIndices: reply.confirmationIndices,
        reshared: reply.reshared
      };
      rerender();
    });

    return card(
      h("h3", { class: "sub", text: "Ready to send" }),
      h("p", { text: ONLINE_CLAIM_SHORT }),
      h("p", { class: "faint small", text: "TruePad does not send it for you — it makes the file, and you choose how to deliver it." }),
      h("div", { class: "actions" }, seal),
      errorSlot,
      onlineDetailsPanel()
    );
  }

  /* ---- 4. the sealed file, then the mask -------------------------------- */

  function sealedCard(bytes: Uint8Array, indices: number[], reshared: boolean): HTMLElement {
    const filename = sealedFilename(pairId);
    const save = h("button", { class: "btn primary", type: "button" }, icon("download"), h("span", { text: "Save sealed pad" })) as HTMLButtonElement;
    save.addEventListener("click", () => {
      saveSealedFile(bytes, filename);
      ctx.toast("Sealed pad saved. Send it however you like.", "ok");
    });

    const actions = h("div", { class: "actions" }, save);
    if (canShareSealed(bytes, filename)) {
      const share = h("button", { class: "btn", type: "button" }, icon("share"), h("span", { text: "Share sealed pad" })) as HTMLButtonElement;
      share.addEventListener("click", async () => {
        const done = await shareSealedFile(bytes, filename);
        // A cancelled share is not a failure of anything durable: the package
        // is committed and the same bytes are still here.
        if (done) ctx.toast("Sealed pad shared.", "ok");
      });
      actions.appendChild(share);
    }

    // THE MASK. Nothing about the eight words is created until this fires.
    const wordSlot = h("div");
    const heard = h("button", { class: "btn primary", type: "button" }, h("span", { text: "I heard their words" })) as HTMLButtonElement;
    heard.addEventListener("click", () => {
      heard.remove();
      wordSlot.replaceChildren(
        h("h3", { class: "sub", text: "Compare what you heard with these words" }),
        comparisonWords(indices, { label: "Your confirmation words, eight in order" }),
        checkAllNote(8),
        h("p", { text: "If they match, read these words back to the other person." }),
        outcomeButtons()
      );
    });

    function outcomeButtons(): HTMLElement {
      const good = h("button", { class: "btn primary", type: "button" }, icon("check"), h("span", { text: "Their words matched" })) as HTMLButtonElement;
      const bad = h("button", { class: "btn danger", type: "button" }, icon("alert"), h("span", { text: "They did not match" })) as HTMLButtonElement;
      good.addEventListener("click", () => {
        wordSlot.replaceChildren(
          callout({
            tone: "ok",
            title: "Done. The other person can add the pad.",
            body: h("p", { text: HNDL_NOTE })
          }),
          h("div", { class: "actions" }, backToPad())
        );
      });
      bad.addEventListener("click", () => {
        // The handoff is already committed. There is no retry, no other
        // recipient, and nothing here pretends otherwise.
        wordSlot.replaceChildren(
          callout({
            tone: "danger",
            title: "Do not use this transfer",
            body: h(
              "div",
              {},
              h("p", { text: "This pad cannot be sent again to a different receive code." }),
              h("p", { text: "Create a new pad and have the other person create a new receive code." })
            )
          }),
          h("div", { class: "actions" }, newPadButton())
        );
      });
      return h("div", { class: "actions" }, good, bad);
    }

    function backToPad(): HTMLButtonElement {
      const b = h("button", { class: "btn", type: "button" }, h("span", { text: "Back to pad" })) as HTMLButtonElement;
      b.addEventListener("click", () => ctx.navigate({ name: "pair", pairId }));
      return b;
    }
    function newPadButton(): HTMLButtonElement {
      const b = h("button", { class: "btn primary", type: "button" }, h("span", { text: "Create a new pad" })) as HTMLButtonElement;
      b.addEventListener("click", () => ctx.navigate({ name: "create" }));
      return b;
    }

    return card(
      reshared
        ? callout({
            tone: "info",
            title: "This is the same sealed pad as before",
            body: h("p", { text: "Nothing new was created. Save or share the same file." })
          })
        : null,
      h("h3", { class: "sub", text: "Send the sealed pad" }),
      h("p", { text: "Send this file through chat, email, or however you normally share a file." }),
      actions,
      h("p", { class: "faint small", text: "If the download did not start, the pad was still sealed — you can save or share the same sealed file again." }),
      h("hr", { class: "rule" }),
      h("h3", { class: "sub", text: "Confirm with the other person" }),
      h("p", { text: "Ask them to read THEIR confirmation words to you first." }),
      heard,
      wordSlot,
      panel("Keeping the sealed file", {}, h("p", { text: HNDL_NOTE }))
    );
  }

  rerender();
  screen.appendChild(backLink(() => ctx.navigate({ name: "pair", pairId }), "Back to pad"));
  screen.appendChild(
    screenHead({
      title: "Send pad securely online",
      lede: ONE_METHOD_NOTE
    })
  );
  screen.appendChild(body);
  mount(root, screen);
}
