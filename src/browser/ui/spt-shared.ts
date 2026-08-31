/* ============================================================================
 * TruePad Browser Edition — shared pieces of the online-transfer screens
 * ----------------------------------------------------------------------------
 * Word rendering, refusal wording, and the sealed-file save/share helper.
 *
 * TWO DATA CLASSES, AND THEY ARE NOT THE SAME
 * -------------------------------------------
 *   the pad file (`.pad`)   RAW SECRET. Never the clipboard, never a share
 *                           sheet, wiped after saving, and the screen that
 *                           offers it carries the warning.
 *   the sealed file (`.tps2`) PUBLIC ENCRYPTED TRANSPORT. Saving and sharing it
 *                           is the point of the feature.
 *
 * Nothing here weakens the first because the second is different. `courier.ts`
 * keeps the pad-file path exactly as it was.
 * ========================================================================= */

import { h, icon } from "./dom.ts";
import { wordsFromIndices } from "./wordlist/index.ts";
import type { Ctx } from "./context.ts";

/* ---- comparison words ----------------------------------------------------- */

/** All of them, numbered, in a semantic ordered list.
 *
 *  ALL of them: there is no "first three", no collapsed tail, no short code.
 *  The security credit is for the words actually compared, and an interface
 *  that shows six invites a comparison of six. The numbering is not decoration
 *  either — two people reading aloud need position to notice a transposition,
 *  and a screen reader announces "1, abandon" from the list semantics. */
export function comparisonWords(indices: readonly number[], opts: { label: string }): HTMLElement {
  const words = wordsFromIndices(indices);
  const list = h("ol", { class: "words", aria: { label: opts.label } });
  words.forEach((word, i) => {
    list.appendChild(
      h(
        "li",
        { class: "word" },
        h("span", { class: "word-n", text: String(i + 1), aria: { hidden: "true" } }),
        h("span", { class: "word-w", text: word })
      )
    );
  });
  return list;
}

export function checkAllNote(count: number): HTMLElement {
  return h("p", {
    class: "note",
    text: `Check all ${count}. If even one word is different, or in a different place, stop.`
  });
}

/* ---- refusal wording ------------------------------------------------------ */

/** Calm Level-1 wording for the engine's typed reasons.
 *
 *  The engine's own message is precise and often technical; it belongs under
 *  Details. What the operator needs first is what happened and what to do. A
 *  reason with no entry here falls back to a generic sentence rather than
 *  leaking a storage path or an internal state name into the main flow. */
export function friendlyRefusal(reason: string): string {
  switch (reason) {
    case "spt-request-expired":
      return "This receive code has expired. Create a new one.";
    case "spt-request-cancelled":
      return "This receive code was cancelled. Create a new one.";
    case "spt-request-consumed":
      return "This receive code has already been used.";
    case "spt-request-unavailable":
      return "That receive code isn't valid.";
    case "spt-session-busy":
      return "This transfer is already open in another TruePad tab.";
    case "spt-session-not-found":
      return "This transfer is no longer open. Choose the sealed pad file again.";
    case "spt-review-not-found":
      return "That check is no longer open. Paste the receive code again.";
    case "spt-confirmation-expired":
      return "The receive-code check expired. Compare the words again.";
    case "spt-confirmation-missing":
      return "Compare the twelve words with the other person first.";
    case "spt-package-malformed":
      return "That file isn't a sealed pad.";
    case "spt-package-open-failed":
      return "This sealed pad could not be opened for this receive code.";
    case "spt-package-not-importable":
      return "This pad can't be added. Ask the other person for a new pad.";
    case "spt-receive-loss":
      return "The receive code was used, but the pad did not finish saving. Ask the other person for a new pad and create a new receive code.";
    case "pad-not-at-genesis":
      return "This pad has already been used, so it can no longer be sent to someone new. Create a new pad.";
    case "imported-pair-cannot-export":
      return "This pad came from someone else and cannot be passed on again. Create a new pad for another person.";
    case "pad-provenance-unknown":
      return "TruePad can't tell where this pad came from, so it won't send it onward. Create a new pad to share.";
    case "pad-already-sealed":
      return "This pad was already sent online. Use one delivery method for each pad.";
    case "pad-already-handed-off":
      return "This pad was already given out as a file. Use one delivery method for each pad.";
    case "handoff-state-unreadable":
      return "TruePad can't tell whether this pad was already given out, so it won't make another copy. Create a new pad to share.";
    case "handoff-unrecoverable":
      return "The sealed pad for this transfer is no longer stored, so it can't be sent again. Create a new pad.";
    // Deliberately the SAME wording an ordinary import uses. A removed pad
    // leaves no user-facing trace, so nothing here may name it or hint at it.
    case "pair-destroyed":
    case "pair-exists":
      return "This pad can't be added. Ask the other person for a new pad.";
    default:
      return "That didn't work. Nothing was changed.";
  }
}

/** The engine's exact text, one disclosure down. */
export function refusalDetails(reason: string, message: string): HTMLElement {
  const box = h("details", { class: "panel" }, h("summary", { text: "Details" }));
  box.appendChild(h("p", { class: "mono small", text: `${reason}: ${message}` }));
  return box;
}

/* ---- the sealed file ------------------------------------------------------ */

export const sealedFilename = (pairId: string): string => `truepad-sealed-${pairId.slice(0, 12)}.tps2`;

/** The EXACT package bytes, as a file. No base64, no zip, no JSON wrapper, no
 *  prepended metadata — what the operator saves must equal what the engine
 *  returned, byte for byte, because that is what the recipient will open. */
function sealedFile(bytes: Uint8Array, filename: string): File {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new File([copy], filename, { type: "application/octet-stream" });
}

export function saveSealedFile(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(sealedFile(bytes, filename));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ShareCapable = Navigator & {
  canShare?: (data: { files?: File[] }) => boolean;
  share?: (data: { files?: File[]; title?: string }) => Promise<void>;
};

export function canShareSealed(bytes: Uint8Array, filename: string): boolean {
  const nav = navigator as ShareCapable;
  if (typeof nav.canShare !== "function" || typeof nav.share !== "function") return false;
  try {
    return nav.canShare({ files: [sealedFile(bytes, filename)] });
  } catch {
    return false;
  }
}

/** Hand the exact file to the OS share sheet. User-directed output: TruePad
 *  stores no recipient, contacts no service, and uploads nothing. A cancelled
 *  or failed share changes nothing — the package is already committed and the
 *  same bytes can be saved or shared again. */
export async function shareSealedFile(bytes: Uint8Array, filename: string): Promise<boolean> {
  const nav = navigator as ShareCapable;
  if (typeof nav.share !== "function") return false;
  try {
    await nav.share({ files: [sealedFile(bytes, filename)], title: "Sealed pad" });
    return true;
  } catch {
    return false;
  }
}

/* ---- the claim distinction, in one place ---------------------------------- */

/** The sentence that must accompany online delivery wherever it is offered.
 *  Sealing the key material of an information-theoretic cipher inside a
 *  computational envelope produces a computational deployment; the OTP theorem
 *  is untouched, but the end-to-end claim is only ever as strong as how the pad
 *  travelled. */
export const ONLINE_CLAIM_SHORT =
  "TruePad seals the pad so you can send the sealed file through an ordinary channel such as chat, email, or cloud storage.";

export const ONLINE_CLAIM_DETAIL =
  "Messages still use the one-time pad after the pad is added. Online delivery is protected by computational " +
  "cryptography, so the overall delivery does not have the same information-theoretic claim as a secret physical " +
  "handoff.";

export const HNDL_NOTE =
  "The sealed file is an encrypted copy of the pad. Delete copies you no longer need. If the delivery cryptography " +
  "is broken in the future, an archived sealed file could become readable.";

export function onlineDetailsPanel(): HTMLElement {
  const box = h("details", { class: "panel" }, h("summary", { text: "How the online delivery is protected" }));
  box.appendChild(
    h("p", {
      text: "The sealed file is encrypted for this one receive code. After it is added, normal TruePad messages still use the pad itself."
    })
  );
  box.appendChild(h("p", { text: ONLINE_CLAIM_DETAIL }));
  box.appendChild(
    h("p", {
      class: "faint small",
      text:
        "Technical: X-Wing (draft-10) suite 0x0001 — ML-KEM-768 with X25519 — HKDF-SHA-256 and AES-256-GCM. " +
        "An archived sealed file is exposed to a future break of that delivery cryptography; the pad itself is not " +
        "used to protect it."
    })
  );
  return box;
}

/** The one-delivery-method rule, in the operator's language. */
export const ONE_METHOD_NOTE = "Use one delivery method for each pad.";

export function busyButton(el: HTMLButtonElement, busy: boolean, busyText?: string, idleText?: string): void {
  el.disabled = busy;
  const label = el.querySelector("span");
  if (label && busyText && idleText) label.textContent = busy ? busyText : idleText;
}
