/* ============================================================================
 * WHAT MAY LEAVE TRUEPAD, AND BY WHICH ROUTE
 * ----------------------------------------------------------------------------
 * The Browser had no classification at all: one `copyButton` and one
 * `saveBytesButton`, handed whatever a screen passed them. So the Open screen
 * offered "Copy" and "Save" on the DECRYPTED MESSAGE — the one thing the pad
 * exists to protect — beside the same controls the Send screen uses for a public
 * encrypted envelope, and nothing in the type system could tell the two apart.
 *
 * The clipboard is the sharper of the two. It is readable by any app with focus,
 * it keeps a history on most platforms, and it syncs across a person's devices.
 * A file is a durable copy outside anything the engine can retire.
 *
 * This is the iOS `EgressPolicy` (TruePadUI/Presentation.swift), ported so all
 * three editions state one rule. It is an APPLICATION EGRESS POLICY and nothing
 * more: it does not stop a screenshot, an accessibility service, a debugger, the
 * operating system reading process memory, or a person copying the words out by
 * hand. It stops TruePad from OFFERING to do it.
 * ========================================================================= */

export type Egress =
  /** A public receive request or encrypted envelope — TPR2, TP2, canonical JSON.
   *  Safe to copy, to draw as a QR, and to save: it is what the operator is
   *  supposed to be able to hand to a channel. */
  | "public-text"
  /** A courier bundle or sealed transfer package. A file, and only a file. */
  | "pad-file"
  /** THE DECRYPTED MESSAGE ITSELF. Displayed, and nothing else.
   *
   *  It is already on screen and readable; a Copy or a Save adds a SECOND,
   *  durable-or-synced copy of it, which is exactly what this forbids. */
  | "plaintext-message"
  /** A decrypted payload the operator asked for AS A FILE — the "Open file" mode.
   *
   *  DISTINCT FROM `plaintext-message`, and the distinction is the whole reason
   *  this case exists. A message is displayed, so saving it makes an EXTRA copy of
   *  something the operator already has. A file was requested as a file: writing
   *  it is the delivery, and refusing would delete the feature rather than close
   *  an egress path. It is still never copied to the clipboard and never a QR.
   *
   *  WHICH ONE APPLIES IS NOT A JUDGEMENT A CALL SITE MAKES — see
   *  `egressForOpenedPayload`. */
  | "received-file";

export const EgressPolicy = {
  /** Only public transport reaches the system clipboard. */
  mayCopyToClipboard: (egress: Egress): boolean => egress === "public-text",
  /** Only public transport is drawn as a QR — a QR is a clipboard you can photograph. */
  mayRenderAsQr: (egress: Egress): boolean => egress === "public-text",
  /** Everything but the decrypted MESSAGE may become a file. The message is on
   *  screen; the operator asked TruePad to reveal it, not to hand it onward. */
  mayShareAsFile: (egress: Egress): boolean => egress !== "plaintext-message"
};

/**
 * THE ONLY PLACE A DECRYPTED PAYLOAD IS CLASSIFIED, and it classifies on the
 * operator's DECLARED MODE.
 *
 * The first version of this repair let the Open screen choose the class from
 * `isProbablyText(plaintext)` — a content sniff on decrypted bytes — and got the
 * policy backwards in both directions. Every plain-text file (.txt, .csv, .json,
 * source, PEM) sniffed as text, landed in the message branch and LOST ITS SAVE,
 * so "Open file" stopped delivering for the commonest kind of file and the pad
 * material was spent for nothing. And a message whose bytes tripped the sniff —
 * pasted terminal output is one escape byte in five — landed in the file branch
 * and was handed a plaintext file export under the label that permits one.
 *
 * A security classification cannot be a function of the material's bytes,
 * because the sender chooses those. It is a function of what the OPERATOR asked
 * for: "Open message" is display-only, "Open file" is a delivery whose whole
 * point is a file on disk.
 *
 * NOT FORGEABLE BY A CALL SITE. `tests/plaintext-egress.test.ts` holds that these
 * two case literals appear nowhere but this file, so a screen cannot label the
 * displayed message `received-file` to get a save: it must ask here, and here
 * only takes the mode.
 */
export function egressForOpenedPayload(mode: "message" | "file"): Egress {
  return mode === "message" ? "plaintext-message" : "received-file";
}

/** Raised when a screen asks for a route this classification forbids.
 *
 *  A PROGRAMMING ERROR, NOT AN OPERATOR ERROR. It fires when someone wires
 *  plaintext into a sink, which is the thing being prevented.
 *
 *  WHEN IT FIRES, PRECISELY: at CONSTRUCTION of the control, during render — not
 *  when the operator clicks. That is deliberate, because it means a wrong wiring
 *  fails in the first test that renders the screen rather than waiting for
 *  someone to press the button. The cost is that a refusal thrown mid-render
 *  would leave a partly-mounted screen; on the Open screen the plaintext is
 *  mounted in the same `mount()` call as the controls, so a throw would cost the
 *  operator a message whose pad material is already spent.
 *
 *  That case is currently unreachable — the message branch constructs no egress
 *  control at all, and the file branch's class is always savable — and it is
 *  named here rather than left implied, because "unreachable" is exactly what was
 *  believed about the content-sniff classification this file now forbids. */
export class EgressRefused extends Error {
  readonly egress: Egress;
  constructor(egress: Egress, route: string) {
    super(`${egress} may not be ${route}: TruePad does not offer that route for this material`);
    this.name = "EgressRefused";
    this.egress = egress;
  }
}

export function requireCopyable(egress: Egress): void {
  if (!EgressPolicy.mayCopyToClipboard(egress)) throw new EgressRefused(egress, "copied to the clipboard");
}

export function requireQrRenderable(egress: Egress): void {
  if (!EgressPolicy.mayRenderAsQr(egress)) throw new EgressRefused(egress, "drawn as a QR code");
}

export function requireSavable(egress: Egress): void {
  if (!EgressPolicy.mayShareAsFile(egress)) throw new EgressRefused(egress, "saved as a file");
}
