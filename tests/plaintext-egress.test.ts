import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EgressPolicy,
  EgressRefused,
  egressForOpenedPayload,
  requireCopyable,
  requireQrRenderable,
  requireSavable,
  type Egress
} from "../src/browser/ui/egress";

/* ============================================================================
 * ONE PLAINTEXT-EGRESS POLICY, THREE EDITIONS
 * ----------------------------------------------------------------------------
 * DECRYPTED PLAINTEXT MAY BE DISPLAYED. TRUEPAD MUST NOT OFFER A SYSTEM-CLIPBOARD
 * COPY OR A PLAINTEXT FILE EXPORT.
 *
 * iOS stated and enforced this from the start; the Browser and Android did not,
 * and the product enforced opposite rules for the same bytes. The Browser's Open
 * screen offered "Copy" and "Save" on the decrypted message, and Android offered
 * "Copy" beside its own warning conceding that the sensitive-clip mark "does not
 * stop another app from reading the clipboard".
 *
 * The clipboard is readable by any app with focus, is kept in a platform history
 * and syncs across a person's devices. A saved file is a durable copy outside
 * anything the engine can retire. Neither is needed to READ a message that is
 * already on screen.
 *
 * WHAT IS NOT FORBIDDEN, and must not become so: TP2 envelopes, TPR2 receive
 * codes, canonical JSON and sealed packages are PUBLIC TRANSPORT. Copying and
 * sharing them is the workflow. A guard that closed plaintext egress by breaking
 * those would have traded one defect for a worse one, so every assertion below
 * has its positive twin.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("the Browser policy refuses plaintext structurally", () => {
  it("permits public transport by every route and the decrypted message by none", () => {
    expect(EgressPolicy.mayCopyToClipboard("public-text")).toBe(true);
    expect(EgressPolicy.mayRenderAsQr("public-text")).toBe(true);
    expect(EgressPolicy.mayShareAsFile("public-text")).toBe(true);

    expect(EgressPolicy.mayCopyToClipboard("plaintext-message")).toBe(false);
    expect(EgressPolicy.mayRenderAsQr("plaintext-message")).toBe(false);
    expect(EgressPolicy.mayShareAsFile("plaintext-message")).toBe(false);

    // A pad file is a file and only a file.
    expect(EgressPolicy.mayCopyToClipboard("pad-file")).toBe(false);
    expect(EgressPolicy.mayShareAsFile("pad-file")).toBe(true);

    // A received FILE has no on-screen form: writing it is the delivery, not a
    // second copy. It is still never clipboard material.
    expect(EgressPolicy.mayShareAsFile("received-file")).toBe(true);
    expect(EgressPolicy.mayCopyToClipboard("received-file")).toBe(false);
    expect(EgressPolicy.mayRenderAsQr("received-file")).toBe(false);
  });

  it("refuses at the boundary rather than relying on nobody asking", () => {
    expect(() => requireCopyable("plaintext-message")).toThrow(EgressRefused);
    expect(() => requireCopyable("received-file")).toThrow(EgressRefused);
    expect(() => requireCopyable("pad-file")).toThrow(EgressRefused);
    expect(() => requireSavable("plaintext-message")).toThrow(EgressRefused);
    expect(() => requireQrRenderable("plaintext-message")).toThrow(EgressRefused);
    expect(() => requireQrRenderable("received-file")).toThrow(EgressRefused);
    expect(() => requireQrRenderable("pad-file")).toThrow(EgressRefused);
    // And does not refuse what the workflow needs.
    expect(() => requireCopyable("public-text")).not.toThrow();
    expect(() => requireSavable("public-text")).not.toThrow();
    expect(() => requireQrRenderable("public-text")).not.toThrow();
    expect(() => requireSavable("received-file")).not.toThrow();
    expect(() => requireSavable("pad-file")).not.toThrow();
  });

  it("is consulted by every egress sink, not only two of them", () => {
    // "Classified at the boundary" was a larger claim than the code supported:
    // the pad-file save and the QR control asked nothing, which is why those two
    // cases and mayRenderAsQr were dead. The biggest secret the app can write —
    // the whole pad — was the egress that consulted no policy.
    expect(read("src/browser/ui/courier.ts"), "the pad-file save consults no policy")
      .toContain('requireSavable("pad-file")');
    expect(read("src/browser/ui/qr/show-qr.ts"), "the QR control consults no policy")
      .toContain('requireQrRenderable("public-text")');
  });

  it("covers every case of the type, so a new one cannot arrive unclassified", () => {
    // DERIVED FROM THE TYPE, NOT RESTATED BESIDE IT. A hand-written list cannot
    // fail when a case is added — which is the one thing this test is for. The
    // union members are read out of the source and compared to the expected set,
    // so a fifth case is a red test until someone decides what it may do.
    const src = read("src/browser/ui/egress.ts");
    const union = src.slice(src.indexOf("export type Egress ="), src.indexOf("export const EgressPolicy"));
    const cases = [...union.matchAll(/^\s*\|\s*"([a-z-]+)"/gm)].map((m) => m[1]);
    expect(cases.sort()).toEqual(["pad-file", "plaintext-message", "public-text", "received-file"]);

    const every = cases as Egress[];
    // Exactly one case may reach the clipboard, and exactly one may reach a QR.
    expect(every.filter((e) => EgressPolicy.mayCopyToClipboard(e))).toEqual(["public-text"]);
    expect(every.filter((e) => EgressPolicy.mayRenderAsQr(e))).toEqual(["public-text"]);
    // And exactly one may NOT become a file.
    expect(every.filter((e) => !EgressPolicy.mayShareAsFile(e))).toEqual(["plaintext-message"]);
  });

  it("classifies an opened payload from the operator's mode, never from its bytes", () => {
    // THE DEFECT THE FIRST VERSION SHIPPED. The class was chosen by
    // `isProbablyText(plaintext)`, a content sniff, so every plain-text file lost
    // its Save and a message with control bytes gained one. A classification a
    // SENDER can influence by choosing bytes is not a classification.
    expect(egressForOpenedPayload("message")).toBe("plaintext-message");
    expect(egressForOpenedPayload("file")).toBe("received-file");

    const open = read("src/browser/ui/open.ts");
    expect(open, "the Open screen does not ask for the classification")
      .toContain("egressForOpenedPayload(mode)");
    expect(open, "the egress branch is chosen by a content sniff again")
      .not.toMatch(/isProbablyText[^\n]*\n[^\n]*(received-file|plaintext-message)/);
  });

  it("makes the two payload classes unforgeable by a call site", () => {
    // The class must be OBTAINED, not declared. If a screen could write
    // `"received-file"` itself it could label the displayed message that way and
    // get a save, which is the disguise this taxonomy must not permit.
    const files = [
      "src/browser/ui/open.ts", "src/browser/ui/send.ts", "src/browser/ui/components.ts",
      "src/browser/ui/courier.ts", "src/browser/ui/dashboard.ts", "src/browser/ui/qr/show-qr.ts"
    ];
    for (const f of files) {
      for (const lit of ['"received-file"', '"plaintext-message"']) {
        expect(read(f), `${f} names ${lit} directly instead of asking egressForOpenedPayload`)
          .not.toContain(lit);
      }
    }
    // And the one place that may name them is the classifier itself.
    expect(read("src/browser/ui/egress.ts")).toContain('mode === "message" ? "plaintext-message" : "received-file"');
  });
});

describe("the Browser Open screen offers no route out for the decrypted message", () => {
  const open = read("src/browser/ui/open.ts");
  const send = read("src/browser/ui/send.ts");
  const components = read("src/browser/ui/components.ts");

  it("read the screens it thinks it read", () => {
    // POSITIVE CONTROL. Every absence assertion below passes over an empty file.
    expect(open.length).toBeGreaterThan(2000);
    expect(send.length).toBeGreaterThan(2000);
    expect(open).toContain("renderAccepted");
    expect(open).toContain("message-body");
  });

  it("has no Copy control on the decrypted message", () => {
    expect(open, "the Open screen imports the clipboard control again")
      .not.toContain("copyButton");
  });

  it("has no Save control on the decrypted message", () => {
    // The plaintext text file is gone; the received FILE is a different class and
    // is asserted separately below.
    expect(open, "the decrypted message can be written to a text file again")
      .not.toContain("`message-${pairId.slice(0, 8)}.txt`");
  });

  it("still delivers a received file, which has no other form", () => {
    // The Save exists, and carries the class the CLASSIFIER produced — not a
    // literal the screen chose.
    expect(open).toContain('`file-${pairId.slice(0, 8)}.bin`, egress');
    expect(open).toContain('h("h1", { text: "File received" })');
  });

  it("cannot use the received-file class to save the displayed message", () => {
    // THE LOOPHOLE THIS CLASS COULD BE, closed at the type level rather than by
    // where the code happens to sit. The screen cannot name `received-file` at
    // all (asserted above); it receives whatever `egressForOpenedPayload(mode)`
    // returns, and that is `plaintext-message` for the message branch.
    //
    // Belt and braces on the branch itself: the message branch offers no save.
    const messageBranch = open.slice(open.indexOf('if (mode === "message")'),
                                     open.indexOf("} else {"));
    expect(messageBranch.length).toBeGreaterThan(200);
    expect(messageBranch, "the displayed message can be saved at all")
      .not.toContain("saveBytesButton");
    expect(messageBranch, "the displayed message can be copied at all")
      .not.toContain("copyButton");
    // And the branch is chosen by the mode, not by the bytes.
    expect(open).toContain('if (mode === "message")');
  });

  it("says why there is no copy, without overclaiming", () => {
    // THE SENTENCE, NOT THE FILE. The doc comment above it lists the things the
    // policy does NOT prove — screenshots, accessibility services, process
    // memory — so scanning the whole file finds every word it is warning against.
    // That is the prose-quotes-its-own-anti-patterns trap this repo has hit
    // before; the guard reads the exported literal.
    const file = read("src/browser/ui/egress-copy.ts");
    const m = /PLAINTEXT_STAYS_HERE\s*=\s*\n?\s*"([^"]+)"/.exec(file);
    expect(m, "the sentence is no longer a single string literal this can read").toBeTruthy();
    const sentence = (m as RegExpExecArray)[1];
    expect(open).toContain("PLAINTEXT_STAYS_HERE");
    expect(sentence).toContain("stays in TruePad");
    expect(sentence.length).toBeGreaterThan(30);
    for (const overclaim of [
      "screenshot", "cannot be captured", "cannot be read", "erased", "no trace",
      "impossible", "guaranteed", "secure", "protected"
    ]) {
      expect(sentence.toLowerCase(), `the sentence claims "${overclaim}"`)
        .not.toContain(overclaim);
    }
  });

  it("does not leave the platform's own copy gesture open on the message", () => {
    // REMOVING THE BUTTON IS NOT THE POLICY IF A DRAG AND CTRL-C REACHES THE SAME
    // CLIPBOARD. The sentence beside it says "there is no copy for it", and that
    // is only true if the platform gesture is declined too — which is the reason
    // iOS refuses `.textSelection(.enabled)` on plaintext. Screen readers are
    // unaffected either way.
    const css = read("src/browser/style.css");
    const rule = css.slice(css.indexOf(".message-body {"), css.indexOf(".ok-head {"));
    expect(rule.length, "the message-body rule moved; this guard is reading nothing")
      .toBeGreaterThan(100);
    expect(rule).toContain("user-select: none");
    // BOTH SPELLINGS, because the unprefixed one alone leaves WebKit selectable
    // and the prefixed one alone leaves everything else selectable.
    expect(rule).toContain("-webkit-user-select: none");
    expect((rule.match(/user-select: none/g) ?? []).length).toBe(2);

    // And the ENVELOPE block is untouched — it is public transport, and copying
    // it is the workflow. The message rule is the positive twin: it proves this
    // stylesheet DOES carry the property somewhere, so the absence below is a
    // real absence and not a file that never had it.
    const payloadAt = css.indexOf(".payload {");
    expect(payloadAt, "the envelope block moved; this guard reads nothing").toBeGreaterThan(-1);
    const payload = css.slice(payloadAt, css.indexOf(".payload-label"));
    expect(payload.length).toBeGreaterThan(40);
    expect(payload, "public transport lost its selection, which is the workflow")
      .not.toContain("user-select: none");
  });

  it("keeps the encrypted envelope copyable and savable, which is the workflow", () => {
    expect(send).toContain('copyButton(ctx, () => shown, "public-text", "Copy")');
    expect(send).toContain('copyButton(ctx, () => envelope, "public-text", "Copy JSON")');
    expect(send).toContain('"public-text", "Save"');
  });

  it("makes the classification impossible to omit", () => {
    // No default: a new call site that forgets it does not compile, which is why
    // the compiler could name all six when the parameter was introduced.
    expect(components).toMatch(/egress: Egress,\s*\n\s*label = "Copy"/);
    expect(components).toMatch(/egress: Egress,\s*\n\s*label = "Save"/);
    expect(components).toContain("requireCopyable(egress)");
    expect(components).toContain("requireSavable(egress)");
  });
});

describe("Android says the same thing, and enforces it the same way", () => {
  const A = "android/app/src/main/kotlin/dev/systemslibrarian/truepad/app";
  const screens = read(`${A}/ui/Screens.kt`);
  const main = read(`${A}/MainActivity.kt`);
  const egress = read(`${A}/Egress.kt`);
  const claims = read(`${A}/Claims.kt`);

  it("read the sources it thinks it read", () => {
    expect(screens.length).toBeGreaterThan(5000);
    expect(egress).toContain("enum class Egress");
    expect(main).toContain("fun Context.copySensitiveText(");
  });

  it("has no Copy control on the decrypted message", () => {
    expect(screens, "the Open screen can copy the decrypted message again")
      .not.toContain("btn-copy-plaintext");
    expect(screens).not.toContain('copySensitiveText("TruePad message"');
  });

  it("does not leave the platform's own copy gesture open on the message", () => {
    // The plaintext Body must NOT sit inside a SelectionContainer; long-press →
    // Copy is the same clipboard the removed button used. The envelope on the
    // Send screen keeps its SelectionContainer, and that is asserted too so this
    // cannot pass by the app having lost selection everywhere.
    // COMMENTS STRIPPED FIRST. The comment beside this code explains why there is
    // no SelectionContainer, and a raw search finds the word in that explanation —
    // the prose-quotes-its-own-anti-pattern trap this repo has hit before.
    const code = screens.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const block = code.slice(code.indexOf('SectionTitle("Message")'));
    const upToButtons = block.slice(0, block.indexOf("FullWidth {"));
    expect(upToButtons.length).toBeGreaterThan(50);
    expect(upToButtons).toContain('testTag("plaintext-output")');
    expect(upToButtons, "the decrypted message is selectable again, so the platform can copy it")
      .not.toContain("SelectionContainer");
    expect(code, "public transport lost its selection, which is the workflow")
      .toContain("SelectionContainer");
  });

  it("has no Share control on the decrypted message", () => {
    // Direct form: no sink is handed `result.plaintext`.
    for (const sink of ["copySensitiveText", "shareEncryptedMessage", "shareReceiveCode"]) {
      expect(screens, `${sink} is handed the decrypted message`)
        .not.toMatch(new RegExp(`${sink}\\([^)]*result\\.plaintext`));
    }
    // INDIRECT FORM. One intermediate local defeats the regex above — `val m =
    // result.plaintext` and then `copySensitiveText(..., m, ...)`. Within the
    // Open screen's own block, the decrypted message may be READ for display and
    // for nothing else, so no local may be bound to it at all.
    // SEARCHED FORWARD FROM THE SCREEN'S OWN START. A bare indexOf found the
    // `OutlinedTextField` IMPORT at the top of the file, which is before the
    // screen — so the slice was empty and every assertion in it was vacuous.
    const openStart = screens.indexOf('ScreenTitle("Open message"');
    expect(openStart, "the Open screen moved; this guard reads nothing").toBeGreaterThan(-1);
    const openBlock = screens.slice(openStart, screens.indexOf("OutlinedTextField", openStart));
    expect(openBlock.length).toBeGreaterThan(200);
    const uses = [...openBlock.matchAll(/result\.plaintext/g)];
    expect(uses.length, "the Open screen no longer reads the decrypted message")
      .toBeGreaterThan(0);
    expect(openBlock, "the decrypted message is copied into a local, which can then be handed anywhere")
      .not.toMatch(/va[lr]\s+\w+\s*=\s*result\.plaintext/);
    // The only use is the Body that displays it.
    expect(openBlock).toContain("Body(result.plaintext");
    expect(uses.length).toBe(1);
  });

  it("refuses plaintext at the helper, not by remembering not to ask", () => {
    expect(main).toContain("if (!EgressPolicy.mayCopyToClipboard(egress)) throw EgressRefused");
    expect(main).toContain("if (!EgressPolicy.mayShareAsText(egress)) throw EgressRefused");
    // Required parameters: a call site cannot omit the classification.
    expect(main).toContain("fun Context.copySensitiveText(label: String, text: String, egress: Egress)");
    expect(main).toContain("fun Context.shareEncryptedMessage(text: String, egress: Egress)");
    expect(main).toContain("fun Context.shareReceiveCode(text: String, egress: Egress)");
  });

  it("keeps the encrypted envelope and the receive code portable", () => {
    expect(screens).toContain('copySensitiveText("TruePad encrypted message", shown, Egress.PUBLIC_TEXT)');
    expect(screens).toContain("shareEncryptedMessage(shown, Egress.PUBLIC_TEXT)");
    const spt = read(`${A}/ui/SptScreens.kt`);
    expect(spt).toContain("Egress.PUBLIC_TEXT");
    expect(spt).toContain("shareReceiveCode(request.tpr2Text, Egress.PUBLIC_TEXT)");
  });

  it("states the policy in the same words as the other editions", () => {
    expect(claims).toContain("PLAINTEXT_STAYS_HERE");
    expect(screens).toContain("Claims.PLAINTEXT_STAYS_HERE");
  });
});

describe("all three editions agree", () => {
  it("forbids plaintext egress everywhere and permits public transport everywhere", () => {
    const browser = read("src/browser/ui/egress.ts");
    const android = read("android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/Egress.kt");
    const ios = read("ios/TruePadKit/Sources/TruePadUI/Presentation.swift");

    // The same rule, spelled in three languages.
    expect(browser).toContain('mayCopyToClipboard: (egress: Egress): boolean => egress === "public-text"');
    expect(android).toContain("fun mayCopyToClipboard(egress: Egress): Boolean = egress == Egress.PUBLIC_TEXT");
    expect(ios).toContain("mayCopyToClipboard(_ egress: Egress) -> Bool { egress == .publicText }");

    expect(browser).toContain('mayShareAsFile: (egress: Egress): boolean => egress !== "plaintext-message"');
    expect(ios).toContain("mayShareAsFile(_ egress: Egress) -> Bool { egress != .plaintext }");
    expect(android).toContain("fun mayShareAsText(egress: Egress): Boolean = egress == Egress.PUBLIC_TEXT");
    // AND ANDROID ANSWERS THE FILE QUESTION AT ALL. It had only a share-as-text
    // predicate, so a test claiming the three editions "state one rule" was
    // comparing two different rules and calling them identical.
    expect(android, "Android has no file-egress predicate to compare")
      .toContain("fun mayShareAsFile(egress: Egress): Boolean = egress != Egress.PLAINTEXT_MESSAGE");

    // THE RULE, EVALUATED — not three strings that happen to look alike. Each
    // edition's predicate is re-implemented here from its own source text and the
    // three are required to agree on every shared class.
    const shared = ["public-text", "pad-file", "plaintext-message"] as const;
    const expected = {
      clipboard: { "public-text": true, "pad-file": false, "plaintext-message": false },
      file: { "public-text": true, "pad-file": true, "plaintext-message": false },
      qr: { "public-text": true, "pad-file": false, "plaintext-message": false }
    };
    for (const c of shared) {
      expect(EgressPolicy.mayCopyToClipboard(c)).toBe(expected.clipboard[c]);
      expect(EgressPolicy.mayShareAsFile(c)).toBe(expected.file[c]);
      expect(EgressPolicy.mayRenderAsQr(c)).toBe(expected.qr[c]);
    }
    // The other two editions declare the same three answers in their own syntax.
    expect(android).toContain("PUBLIC_TEXT");
    expect(android).toContain("PAD_FILE");
    expect(android).toContain("PLAINTEXT_MESSAGE");
    expect(ios).toContain("case fileOnly");
    expect(ios).toContain("case publicText");
    expect(ios).toContain("case plaintext");
  });

  it("says the same sentence to the operator on all three", () => {
    const sentence = "This message stays in TruePad";
    expect(read("src/browser/ui/egress-copy.ts")).toContain(sentence);
    expect(read("android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/Claims.kt")).toContain(sentence);
    expect(read("ios/TruePadKit/Sources/TruePadUI/Presentation.swift")).toContain(sentence);
  });

  it("keeps the iOS enforcement that was already correct", () => {
    const views = read("ios/TruePadKit/Sources/TruePadUI/MessageViews.swift");
    // The plaintext block still refuses selection, which is the iOS route to the
    // pasteboard, and still carries no pasteboard call.
    expect(views).toContain("NO `.textSelection(.enabled)` HERE, deliberately");
    expect(views).toContain("VerbatimText.plaintextStaysHere");
  });
});
