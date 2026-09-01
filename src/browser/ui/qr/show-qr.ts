/* ============================================================================
 * "Show QR code" — the receiver's optional convenience
 * ----------------------------------------------------------------------------
 * A quiet secondary control next to "Copy receive code". It carries EXACTLY the
 * receive code shown above — the same public TPR2 the clipboard carries — and
 * says so plainly, along with the one thing a beginner must not misread: a scan
 * is not a verification. The twelve words still do that.
 *
 * The copy/paste path is never removed or demoted; this only adds a second way
 * to move the same text.
 * ========================================================================= */

import { h, icon } from "../dom.ts";
import { encodeReceiveCodeToMatrix } from "./encode.ts";
import { renderQrMatrixToSvg } from "./svg.ts";

const SAME_CODE_NOTE = "This QR code contains the same receive code shown above.";
const NOT_VERIFY_NOTE = "Scanning the code does not verify who created it. Compare the twelve words before continuing.";

/**
 * Build a "Show QR code" control for a canonical TPR2 receive `code`. Returns a
 * container element the caller drops into the receive-code card. The symbol is
 * rendered lazily on first reveal.
 */
export function showQrCodeControl(code: string): HTMLElement {
  const container = h("div", { class: "qr-show" });
  const figureSlot = h("div", { class: "qr-figure-slot", hidden: true });

  let built = false;
  const toggle = h(
    "button",
    { class: "btn", type: "button", aria: { expanded: "false", controls: "qr-figure" } },
    icon("qr"),
    h("span", { text: "Show QR code" })
  ) as HTMLButtonElement;

  const setShown = (shown: boolean): void => {
    figureSlot.hidden = !shown;
    toggle.setAttribute("aria-expanded", shown ? "true" : "false");
    toggle.replaceChildren(icon("qr"), h("span", { text: shown ? "Hide QR code" : "Show QR code" }));
  };

  toggle.addEventListener("click", () => {
    if (!built) {
      built = true;
      figureSlot.replaceChildren(buildFigure(code));
    }
    setShown(figureSlot.hidden);
  });

  container.append(toggle, figureSlot);
  figureSlot.id = "qr-figure";
  return container;
}

function buildFigure(code: string): HTMLElement {
  let svg: SVGSVGElement;
  try {
    const matrix = encodeReceiveCodeToMatrix(code);
    svg = renderQrMatrixToSvg(matrix, { label: "QR code of the receive code" });
  } catch {
    // A valid receive code always encodes; if it somehow does not, keep the
    // page calm and point back at the text that always works.
    return h("p", { class: "faint small", text: "The QR code could not be shown. Copy the receive code above instead." });
  }

  const frame = h("div", { class: "qr-frame" }, svg);
  const enlarge = h(
    "button",
    { class: "linkish", type: "button", text: "Enlarge" }
  ) as HTMLButtonElement;
  enlarge.addEventListener("click", () => openEnlarged(code));

  return h(
    "figure",
    { class: "qr-figure" },
    frame,
    h(
      "figcaption",
      { class: "qr-caption" },
      h("p", { class: "small", text: SAME_CODE_NOTE }),
      h("p", { class: "faint small", text: NOT_VERIFY_NOTE }),
      h("div", { class: "actions quiet" }, enlarge)
    )
  );
}

/** A focused, full-screen presentation for reliable scanning on a small screen.
 *  Closes on Escape, on the Close button, or on a click outside the symbol. */
function openEnlarged(code: string): void {
  let svg: SVGSVGElement;
  try {
    const matrix = encodeReceiveCodeToMatrix(code);
    svg = renderQrMatrixToSvg(matrix, { label: "Enlarged QR code of the receive code" });
  } catch {
    return;
  }

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };

  const closeBtn = h("button", { class: "btn", type: "button", text: "Close" }) as HTMLButtonElement;
  closeBtn.addEventListener("click", close);

  const panel = h(
    "div",
    { class: "qr-enlarged-panel", role: "dialog", aria: { modal: "true", label: "Enlarged QR code" } },
    h("div", { class: "qr-frame large" }, svg),
    h("p", { class: "small", text: SAME_CODE_NOTE }),
    h("div", { class: "actions" }, closeBtn)
  );
  const overlay = h("div", { class: "qr-enlarged" }, panel);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  closeBtn.focus();
}
