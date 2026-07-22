/* ============================================================================
 * TruePad exhibit UI
 * ----------------------------------------------------------------------------
 * All correctness lives in the pure core modules (pad, cipher-otp, meter,
 * verdict, attack-otp); this file only reads state from them and paints it.
 * Nothing here touches the network: pads, plaintexts and ciphertexts exist
 * only in this tab.
 * ========================================================================= */

import "./style.css";
import { Pad, uniformInt, LETTER_RANGE, type PadMode } from "./pad";
import {
  decryptBytes,
  decryptLetters,
  encryptBytes,
  encryptLetters,
  groupedFive,
  normalizeAZ,
  type OtpRefusal
} from "./cipher-otp";
import { meterState, LEDGER_MOTTO } from "./meter";
import { gradeShannon, type ShannonReport } from "./verdict";
import { compareAttacks, encryptWithKeystream, LEAK_THRESHOLD } from "./attack-otp";
import { diffPositions, forgeLetters, shiftCipherLetter } from "./tamper";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing element #${id}`);
  }
  return node as T;
}

const fmtBits = (bits: number): string =>
  `${bits.toLocaleString("en-US", { maximumFractionDigits: 1 })} bits`;

/* ---- exhibit state ------------------------------------------------------ */

let senderPad: Pad;
// The "courier copy": deserialize(serialize()) at generation time models the
// out-of-band delivery. From then on the two pads only stay in sync because
// both sides burn the same offsets in the same order — exactly like paper.
let receiverPad: Pad;
let lastWireCiphertext = "";

/* ---- station 1: pad ----------------------------------------------------- */

const padModeSelect = el<HTMLSelectElement>("pad-mode");
const padSizeInput = el<HTMLInputElement>("pad-size");
const padGrid = el<HTMLDivElement>("pad-grid");

function symbolText(pad: Pad, offset: number): string {
  const value = pad.valueAt(offset);
  if (value === undefined) {
    // The value is deleted, not flagged: the UI could not show it if it tried.
    return "✕";
  }
  return pad.mode === "letters"
    ? String.fromCharCode(65 + value)
    : value.toString(16).padStart(2, "0").toUpperCase();
}

function renderPadGrid(justBurned?: { start: number; count: number }): void {
  padGrid.replaceChildren();
  for (let offset = 0; offset < senderPad.size; offset += 1) {
    const cell = document.createElement("span");
    const burned = senderPad.valueAt(offset) === undefined;
    cell.className = burned ? "cell burned" : "cell";
    if (
      justBurned &&
      offset >= justBurned.start &&
      offset < justBurned.start + justBurned.count
    ) {
      cell.classList.add("just-burned");
    }
    cell.textContent = symbolText(senderPad, offset);
    cell.title = burned ? `offset ${offset} — burned` : `offset ${offset}`;
    padGrid.append(cell);
  }
}

function renderLedger(): void {
  const snap = senderPad.snapshot();
  el("pad-label").textContent = snap.label;
  el("pad-summary").textContent =
    `${snap.mode} mode · ${snap.size} symbols · ` +
    `${snap.bitsPerSymbol.toFixed(3)} bits/symbol · ${snap.remaining} surviving`;
  el("ledger-generated").textContent = fmtBits(snap.generatedBits);
  el("ledger-spent").textContent = fmtBits(snap.spentBits);
  el("ledger-remaining").textContent = fmtBits(snap.remainingBits);
  el("ledger-motto").textContent = `“${LEDGER_MOTTO}”`;
  el("receiver-label").textContent = receiverPad.label;
  el("receiver-remaining").textContent = String(receiverPad.remaining);
}

function generatePads(): void {
  const mode = padModeSelect.value as PadMode;
  const size = Math.min(512, Math.max(8, Number(padSizeInput.value) || 64));
  padSizeInput.value = String(size);
  senderPad = Pad.generate(size, mode);
  receiverPad = Pad.deserialize(senderPad.serialize());
  lastWireCiphertext = "";
  el("wire").hidden = true;
  el("refusal").hidden = true;
  el("receive-refusal").hidden = true;
  el("recovered").hidden = true;
  renderPadGrid();
  renderAll();
}

/* ---- station 2: encrypt ------------------------------------------------- */

const plaintextInput = el<HTMLTextAreaElement>("plaintext");
const meterBox = el<HTMLDivElement>("meter");

function messageLength(text: string): number {
  return senderPad.mode === "letters"
    ? normalizeAZ(text).length
    : new TextEncoder().encode(text).length;
}

function renderMeter(): void {
  const length = messageLength(plaintextInput.value);
  const state = meterState(senderPad.snapshot(), length);
  const scale = Math.max(state.messageLength, state.remainingSymbols, 1);
  el("meter-message").style.width = `${(state.messageLength / scale) * 100}%`;
  el("meter-pad").style.width = `${(state.remainingSymbols / scale) * 100}%`;
  el("meter-message-count").textContent = String(state.messageLength);
  el("meter-pad-count").textContent = String(state.remainingSymbols);
  meterBox.classList.toggle("low", state.status === "low");
  meterBox.classList.toggle("exhausted", state.status === "exhausted");
  const status = el("meter-status");
  if (state.status === "exhausted") {
    status.textContent = `${state.message} (short by ${state.deficitSymbols} symbols)`;
  } else if (state.status === "low") {
    status.textContent =
      `Low pad: this message would leave only ${state.afterSendRemaining} symbols. ` +
      "Time to think about the next out-of-band delivery.";
  } else if (state.messageLength > 0) {
    status.textContent = `Ready. Sending burns ${state.messageLength} symbols and leaves ${state.afterSendRemaining}.`;
  } else {
    status.textContent = "Type a message to race it against the pad.";
  }
}

function showRefusal(target: HTMLElement, refusal: OtpRefusal): void {
  target.textContent = refusal.message;
  target.hidden = false;
}

function toHexGroups(bytes: Uint8Array): string {
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function fromHex(text: string): Uint8Array | null {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function encrypt(): void {
  el("refusal").hidden = true;
  const result =
    senderPad.mode === "letters"
      ? encryptLetters(plaintextInput.value, senderPad)
      : encryptBytes(new TextEncoder().encode(plaintextInput.value), senderPad);
  if (!result.ok) {
    showRefusal(el("refusal"), result);
    renderAll();
    return;
  }
  lastWireCiphertext = "text" in result ? groupedFive(result.text) : toHexGroups(result.bytes);
  el("wire-label").textContent = result.padLabel;
  el("wire-offsets").textContent =
    result.consumed === 0
      ? "none (empty message)"
      : `${result.startOffset} – ${result.startOffset + result.consumed - 1} (${result.consumed} symbols, gone forever)`;
  el("wire-ciphertext").textContent = lastWireCiphertext || "(empty)";
  el("wire").hidden = false;
  renderPadGrid({ start: result.startOffset, count: result.consumed });
  renderAll();
}

/* ---- station 3: decrypt ------------------------------------------------- */

const ciphertextInput = el<HTMLTextAreaElement>("ciphertext-in");

function decrypt(): void {
  el("receive-refusal").hidden = true;
  el("recovered").hidden = true;
  let recovered: string;
  if (receiverPad.mode === "letters") {
    const result = decryptLetters(ciphertextInput.value, receiverPad);
    if (!result.ok) {
      showRefusal(el("receive-refusal"), result);
      renderAll();
      return;
    }
    recovered = groupedFive(result.text);
  } else {
    const bytes = fromHex(ciphertextInput.value);
    if (bytes === null) {
      const wall = el("receive-refusal");
      wall.textContent = "Byte-mode ciphertext must be hex pairs, e.g. “3F A0 07”.";
      wall.hidden = false;
      return;
    }
    const result = decryptBytes(bytes, receiverPad);
    if (!result.ok) {
      showRefusal(el("receive-refusal"), result);
      renderAll();
      return;
    }
    recovered = new TextDecoder().decode(result.bytes);
  }
  el("recovered-text").textContent = recovered || "(empty)";
  el("recovered").hidden = false;
  renderAll();
}

/* ---- station 4: verdict -------------------------------------------------- */

function renderReport(target: HTMLElement, title: string, report: ShannonReport): void {
  const chipClass = report.isTrueOtp ? "chip safe" : "chip";
  const chipText = report.isTrueOtp ? "true one-time pad ✓" : "not a one-time pad ✗";
  const rows = report.conditions
    .map(
      (c) => `
        <li>
          <span class="badge ${c.pass ? "pass" : "fail"}" aria-label="${c.pass ? "pass" : "fail"}">${c.pass ? "✓" : "✗"}</span>
          <span><strong>${c.title}</strong>${c.detail}</span>
        </li>`
    )
    .join("");
  target.innerHTML = `
    <h3>${title} <span class="${chipClass}">${chipText}</span></h3>
    <p class="verdict-bits">key available ≈ ${report.availableBits.toFixed(1)} bits · message needs ≈ ${report.requiredBits.toFixed(1)} bits</p>
    <ol>${rows}</ol>`;
}

function renderVerdict(): void {
  const length = messageLength(plaintextInput.value);
  el("verdict-length").textContent = String(length);
  renderReport(
    el("verdict-pad"),
    `Your live pad (${senderPad.label})`,
    gradeShannon({ kind: "pad", pad: senderPad, messageLength: length })
  );
  const timesUsed = Number(el<HTMLSelectElement>("deck-uses").value);
  renderReport(
    el("verdict-deck"),
    "A DeckBook shuffled deck",
    gradeShannon({ kind: "deck", messageLength: length, timesUsed })
  );
}

/* ---- station 5: attack --------------------------------------------------- */

// Victim message pairs for the reused-keystream target. Everyday military-
// telegram English so a short crib ("THE", "AND", "ATTACK") has real purchase.
const VICTIM_PAIRS: [string, string][] = [
  ["ATTACK AT DAWN ON THE EASTERN RIDGE", "THE ENEMY KNOWS THE SYSTEM IN USE"],
  ["MEET ME AT THE OLD LIGHTHOUSE TONIGHT", "BRING THE PAPERS AND TELL NO ONE ELSE"],
  ["THE CONVOY LEAVES THE HARBOUR AT NOON", "HOLD THE BRIDGE UNTIL THE RELIEF COMES"],
  ["SEND MORE SUPPLIES TO THE NORTH CAMP", "THE RIVER CROSSING IS UNDER WATCH NOW"]
];

let attackScene: {
  p1: string;
  p2: string;
  otpCiphertext: string;
  reused: [string, string];
};

function buildAttackScene(): void {
  const [p1, p2] = VICTIM_PAIRS[uniformInt(VICTIM_PAIRS.length)];
  const n1 = normalizeAZ(p1);
  const n2 = normalizeAZ(p2);
  // One keystream, used twice — DeckBook's sin, reproduced on purpose.
  const sharedKeystream = Array.from({ length: Math.max(n1.length, n2.length) }, () =>
    uniformInt(LETTER_RANGE)
  );
  // The honest target: a real Pad, burned once, then discarded.
  const otpPad = Pad.generate(n1.length, "letters");
  const otpResult = encryptLetters(n1, otpPad);
  if (!otpResult.ok) {
    throw new Error("unreachable: pad was generated to exact message length");
  }
  attackScene = {
    p1: n1,
    p2: n2,
    otpCiphertext: otpResult.text,
    reused: [encryptWithKeystream(n1, sharedKeystream), encryptWithKeystream(n2, sharedKeystream)]
  };
}

function renderAttack(): void {
  const crib = normalizeAZ(el<HTMLInputElement>("crib").value);
  const comparison = compareAttacks({
    otpCiphertext: attackScene.otpCiphertext,
    reusedCiphertexts: attackScene.reused,
    crib
  });

  el("attack-otp-cipher").textContent = groupedFive(attackScene.otpCiphertext);
  el("attack-reuse-c1").textContent = groupedFive(attackScene.reused[0]);
  el("attack-reuse-c2").textContent = groupedFive(attackScene.reused[1]);
  el("attack-p1").textContent = groupedFive(attackScene.p1);
  el("attack-p2").textContent = groupedFive(attackScene.p2);
  el("attack-otp-explain").textContent = comparison.otp.explanation;
  el("attack-reuse-explain").textContent = comparison.reused.explanation;

  const reuseChip = el("attack-reuse-chip");
  reuseChip.textContent = comparison.reused.leaked ? "plaintext leaked" : "no leak yet — adjust the crib";
  reuseChip.className = comparison.reused.leaked ? "chip" : "chip safe";

  const otpList = el("attack-otp-candidates");
  otpList.replaceChildren();
  for (const cand of comparison.otp.candidates) {
    const row = document.createElement("div");
    row.className = "cand";
    row.innerHTML = `<span>pos ${cand.position}</span><span class="frag"></span><span class="score">tie</span>`;
    (row.querySelector(".frag") as HTMLElement).textContent = cand.fragment;
    otpList.append(row);
  }
  if (comparison.otp.candidates.length === 0) {
    otpList.textContent = crib ? "Crib is longer than the ciphertext." : "Enter a crib above.";
  }

  const reuseList = el("attack-reuse-candidates");
  reuseList.replaceChildren();
  const ranked = [...comparison.reused.candidates].sort((a, b) => b.score - a.score);
  for (const cand of ranked) {
    const row = document.createElement("div");
    row.className = cand.score >= LEAK_THRESHOLD ? "cand leak" : "cand";
    row.innerHTML = `<span>pos ${cand.position}</span><span class="frag"></span><span class="score">${cand.score.toFixed(2)}</span>`;
    (row.querySelector(".frag") as HTMLElement).textContent = cand.fragment;
    reuseList.append(row);
  }
  if (ranked.length === 0) {
    reuseList.textContent = crib ? "Crib is longer than the ciphertexts." : "Enter a crib above.";
  }
}

/* ---- station 6: tamper ---------------------------------------------------- */

// The scenario is fixed so the "forge TEN → SIX" button can name real offsets:
// PAYBOBTENDOLLARSNOW — the amount sits at positions 6..8.
const TAMPER_PLAIN = normalizeAZ("PAY BOB TEN DOLLARS NOW");
const TAMPER_FRAGMENT_AT = 6;

let tamperScene: {
  delivered: string; // serialized receiver pad — each decryption gets a pristine copy
  baseCipher: string;
  tamperedCipher: string;
};

function buildTamperScene(): void {
  const pad = Pad.generate(TAMPER_PLAIN.length, "letters");
  const delivered = pad.serialize();
  const result = encryptLetters(TAMPER_PLAIN, pad);
  if (!result.ok) {
    throw new Error("unreachable: pad was generated to exact message length");
  }
  tamperScene = { delivered, baseCipher: result.text, tamperedCipher: result.text };
}

function renderTamper(): void {
  const { delivered, baseCipher, tamperedCipher } = tamperScene;

  const cipherBox = el("tamper-cipher");
  cipherBox.replaceChildren();
  for (let i = 0; i < tamperedCipher.length; i += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.textContent = tamperedCipher[i];
    if (tamperedCipher[i] !== baseCipher[i]) {
      cell.classList.add("tampered-cell");
    }
    cell.title = `position ${i} — click to add 1 (mod 26)`;
    cell.addEventListener("click", () => {
      tamperScene.tamperedCipher = shiftCipherLetter(tamperScene.tamperedCipher, i, 1);
      renderTamper();
    });
    cipherBox.append(cell);
  }

  const decrypted = decryptLetters(tamperedCipher, Pad.deserialize(delivered));
  if (!decrypted.ok) {
    throw new Error("unreachable: the copy is pristine and exactly long enough");
  }
  const changed = new Set(diffPositions(TAMPER_PLAIN, decrypted.text));
  const output = el("tamper-plain");
  output.replaceChildren();
  for (let i = 0; i < decrypted.text.length; i += 1) {
    if (changed.has(i)) {
      const mark = document.createElement("mark");
      mark.textContent = decrypted.text[i];
      output.append(mark);
    } else {
      output.append(decrypted.text[i]);
    }
  }

  el("tamper-received").classList.toggle("tampered", changed.size > 0);
  el("tamper-verdict").textContent =
    changed.size === 0
      ? "Delivered intact. The receiver decrypts exactly what was sent."
      : `${changed.size} letter${changed.size === 1 ? "" : "s"} rewritten in transit — and the ` +
        "decryption is still perfectly valid. Nothing failed. No alarm was raised.";
}

/* ---- wiring -------------------------------------------------------------- */

function renderAll(): void {
  renderLedger();
  renderMeter();
  renderVerdict();
}

el<HTMLFormElement>("pad-controls").addEventListener("submit", (event) => {
  event.preventDefault();
  generatePads();
});
plaintextInput.addEventListener("input", () => {
  renderMeter();
  renderVerdict();
});
el("encrypt").addEventListener("click", encrypt);
el("take-wire").addEventListener("click", () => {
  ciphertextInput.value = lastWireCiphertext;
});
el("decrypt").addEventListener("click", decrypt);
el<HTMLSelectElement>("deck-uses").addEventListener("change", renderVerdict);
el<HTMLInputElement>("crib").addEventListener("input", renderAttack);
el("attack-rebuild").addEventListener("click", () => {
  buildAttackScene();
  renderAttack();
});
el("tamper-forge").addEventListener("click", () => {
  // Forge from the clean wire so the button is idempotent: the attacker
  // rewrites what the sender transmitted, not their own previous forgery.
  tamperScene.tamperedCipher = forgeLetters(tamperScene.baseCipher, TAMPER_FRAGMENT_AT, "TEN", "SIX");
  renderTamper();
});
el("tamper-reset").addEventListener("click", () => {
  tamperScene.tamperedCipher = tamperScene.baseCipher;
  renderTamper();
});
el("tamper-rebuild").addEventListener("click", () => {
  buildTamperScene();
  renderTamper();
});

generatePads();
buildAttackScene();
renderAttack();
buildTamperScene();
renderTamper();

/* ---- PWA ----------------------------------------------------------------- */

if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
