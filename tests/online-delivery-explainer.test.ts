import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * The online-delivery explainer
 * ----------------------------------------------------------------------------
 * A page and a document that explain the same feature will drift apart unless
 * something holds them together. These guards pin the claims that must appear
 * in BOTH, and the claims that must appear in NEITHER — the second list matters
 * more, because an explainer is exactly where a security feature gets oversold.
 *
 * The assertions are deliberately phrase-level and case-insensitive rather than
 * sentence-exact: prose should be free to improve, and a guard that fires on a
 * comma teaches people to edit the guard.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const DOC = readFileSync(join(ROOT, "docs", "HOW-ONLINE-PAD-DELIVERY-WORKS.md"), "utf8");
const PAGE = readFileSync(join(ROOT, "online-delivery.html"), "utf8");
const BOTH = [
  ["the repository document", DOC],
  ["the in-product page", PAGE]
] as const;

const ui = (f: string) => readFileSync(join(ROOT, "src", "browser", "ui", f), "utf8");
const SHARED = ui("spt-shared.ts");
const SECURITY = ui("security-status.ts");
const HOME = ui("home.ts");

describe("both explanations make the same claims", () => {
  it("says the receive code is public and the private key stays local", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must say the code is not secret`).toMatch(/is\s*\**\s*not\s*\**\s*secret/i);
      expect(text, `${where} must say the private half stays put`).toMatch(
        /private (half|key)[^.]{0,120}(stays|never leaves|does not appear)/i
      );
    }
  });

  it("says the 12 words bind the receive request and the 8 bind the package", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must explain the twelve`).toMatch(/twelve words/i);
      expect(text, `${where} must explain the eight`).toMatch(/eight words/i);
      expect(text, `${where} must say what the twelve check`).toMatch(
        /twelve[^.]{0,160}receive (request|code)|receive (request|code)[^.]{0,160}twelve/i
      );
      expect(text, `${where} must say the recipient speaks first`).toMatch(
        /(reads|read)[^.]{0,80}(his )?eight words first|eight words first/i
      );
    }
  });

  it("says matching words are not an identity check", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must refuse the identity reading`).toMatch(
        /not\s*\**\s*proof of[^.]{0,60}identity|not prove (who|anyone)|not[^.]{0,80}identity/i
      );
    }
  });

  it("says the delivery cryptography delivers the pad and the OTP protects the messages", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must name the delivery stack`).toMatch(/X-Wing/);
      expect(text, `${where} must name ML-KEM-768`).toMatch(/ML-KEM-768/);
      expect(text, `${where} must name AES-256-GCM`).toMatch(/AES-256-GCM/);
      expect(text, `${where} must say messages return to the pad`).toMatch(/one-time pad/i);
      expect(text, `${where} must name Wegman-Carter`).toMatch(/Wegman[–-]Carter/);
      // The boundary itself: the delivery crypto is NOT used per message.
      expect(text, `${where} must say X-Wing is not used per message`).toMatch(
        /not\s*\**\s*used for messages|does not[^.]{0,40}each (TruePad )?message|delivers the pad/i
      );
    }
  });

  it("distinguishes the raw .pad from the sealed .tps2", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must name the raw pad`).toMatch(/\.pad/);
      expect(text, `${where} must name the sealed package`).toMatch(/\.tps2/);
      expect(text, `${where} must warn against sending the raw pad casually`).toMatch(
        /raw pad (is|\*\*is\*\*) the secret|the secret pad itself|the raw pad \*?is\*? the secret/i
      );
    }
  });

  it("keeps the standards status honest and states the HNDL exposure", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must say X-Wing is a draft`).toMatch(/X-Wing is[^.]{0,30}draft|draft-10|draft-connolly/i);
      expect(text, `${where} must say ML-KEM is standardised`).toMatch(/ML-KEM is[^.]{0,30}standardi[sz]ed/i);
      expect(text, `${where} must say delivery is computational`).toMatch(/computational/i);
      // BOTH routes back to the pad, not only future cryptanalysis.
      expect(text, `${where} must name the restored-backup case`).toMatch(/restored[^.]{0,60}backup|cloned/i);
      expect(text, `${where} must say deleting locally is not erasure`).toMatch(
        /does not erase|cannot (reach|prove)[^.]{0,60}(erase|copies)/i
      );
    }
  });

  it("says TruePad does not send the file itself", () => {
    for (const [where, text] of BOTH) {
      expect(text, `${where} must disclaim uploading`).toMatch(
        /TruePad does not (send|upload)|Nothing is uploaded|no backend/i
      );
    }
  });
});

describe("the explainer does not oversell", () => {
  const FORBIDDEN = [
    /quantum[- ]proof/i,
    /unbreakable/i,
    /perfect secrecy/i,
    /perfectly secure/i,
    /identity verified/i,
    /NIST[- ]standard X-Wing/i,
    /RFC[- ]standard X-Wing/i,
    /IETF[- ](approved|endorsed) X-Wing/i,
    /safe to email the (raw )?pad/i,
    /guaranteed[^.]{0,30}eras/i
  ];

  it("makes none of the claims a release audit exists to catch", () => {
    for (const [where, text] of BOTH) {
      for (const bad of FORBIDDEN) {
        expect(text, `${where} must not claim ${String(bad)}`).not.toMatch(bad);
      }
    }
  });

  it("never calls the ONLINE delivery information-theoretic", () => {
    // The phrase is legitimate here — it is exactly what the PHYSICAL route can
    // claim, and a section explaining the difference has to use the word. So
    // this does not ban co-occurrence, which would fire on the heading "Why
    // online delivery is a different security claim". It bans the ASSERTION:
    // a sentence that predicates "information-theoretic" OF the online path.
    const OVERCLAIM = [
      /\b(online|sealed)\b[^.!?]{0,80}\b(is|are|remains?|provides?|gives?|offers?)\b[^.!?]{0,60}information[- ]theoretic/i,
      /information[- ]theoretic[^.!?]{0,60}\b(online|sealed) (delivery|transfer|pad)\b/i
    ];
    for (const [where, text] of BOTH) {
      // Block-level markup ends a thought as surely as a full stop does.
      const flat = text.replace(/<[^>]+>/g, " . ").replace(/\s+/g, " ");
      for (const bad of OVERCLAIM) {
        expect(flat, `${where} must not predicate information-theoretic of the online path`).not.toMatch(bad);
      }
      // ...and the correct statement must be present, so the section cannot be
      // fixed by deleting the distinction instead of stating it.
      expect(text, `${where} must call the online delivery computational`).toMatch(
        /\b(online |sealed )?deliver(y|ing)?[^.!?]{0,80}computational|computational[^.!?]{0,60}deliver/i
      );
    }
  });
});

describe("the explainer is reachable, and only from the right places", () => {
  it("both online transfer screens link to it, through one shared panel", () => {
    expect(SHARED).toMatch(/ONLINE_EXPLAINER_HREF = "online-delivery\.html"/);
    expect(SHARED).toMatch(/function explainerLink/);
    // The link is rendered by the panel BOTH screens use, so it cannot appear
    // on one and not the other.
    expect(SHARED).toMatch(/box\.appendChild\(explainerLink\(\)\)/);
    for (const f of ["send-online.ts", "receive-online.ts"]) {
      expect(ui(f), `${f} must render the shared online Details panel`).toMatch(/onlineDetailsPanel\(\)/);
    }
  });

  it("the Security page points at it rather than repeating it", () => {
    expect(SECURITY).toMatch(/ONLINE_EXPLAINER_HREF/);
    expect(SECURITY).toMatch(/Learn how the receive code and sealed file work/);
    // Pointing, not duplicating: Security states claims, it does not teach.
    expect(SECURITY).not.toMatch(/locked mailbox|Common questions/i);
  });

  it("the home screen gains nothing", () => {
    // Discoverability belongs inside the transfer screens. The hero stays as it
    // is: two actions and one question.
    expect(HOME).not.toMatch(/online-delivery|How online delivery works/);
    expect(HOME).not.toMatch(/X-Wing|ML-KEM|PQC|post-quantum/i);
  });

  it("ships as a static page with no script and its own CSP", () => {
    expect(PAGE).toMatch(/http-equiv="Content-Security-Policy"/);
    expect(PAGE).toMatch(/script-src 'self'/);
    // A document needs no engine. No inline script, no module entry.
    expect(PAGE).not.toMatch(/<script/i);
    const vite = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    expect(vite, "the page must be part of the static build").toMatch(/online-delivery\.html/);
  });
});
