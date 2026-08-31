import { existsSync, readFileSync } from "node:fs";
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

  it("says ALL of the words are compared, never a prefix", () => {
    // A shortened fingerprint is a weaker fingerprint. The security credit is
    // for the words actually compared, so neither artefact may suggest a
    // first-few check is enough.
    for (const [where, text] of BOTH) {
      // The INSTRUCTION must say all of them. Asserting the phrase merely
      // exists somewhere is not enough — "If all twelve match" is a different
      // sentence and survives gutting the instruction, which is exactly how an
      // injected "compare the first three" slipped past an earlier version.
      const flat = text.replace(/\s+/g, " ");
      expect(flat, `${where} must instruct comparing all twelve`).toMatch(
        /compare[^.]{0,60}all\s*\**\s*twelve|all\s*\**\s*twelve\s*\**[^.]{0,40}(in order|match)/i
      );
      expect(flat, `${where} must instruct checking all eight`).toMatch(/all\s*\**\s*eight|eight words/i);
      expect(flat, `${where} must not offer a prefix shortcut`).not.toMatch(
        /(compare|check|read)[^.]{0,40}first (three|few|couple|\d+)|first (three|few|couple|\d+)[^.]{0,30}(is|are) enough|just the first|only the first/i
      );
    }
  });

  it("gets the one-time lifecycle right, including the case that is NOT terminal", () => {
    // Three things end a request; abandoning is not one of them. `abandonImpl`
    // writes no durable marker — it only drops the in-memory session — so
    // "Close for now" leaves the request pending and reopenable. Omitting that
    // leaves a person mid-ceremony afraid to put the transfer down.
    expect(DOC).toMatch(/Close for now/);
    expect(DOC, "abandoning must be described as non-terminal").toMatch(
      /Close for now[^.]{0,120}(not a cancellation|is not a cancel)/i
    );
    // All FOUR terminal outcomes, including the button the recipient can press
    // on the receive screen. An earlier draft listed three and then asserted
    // nothing else could end the request, which was simply false.
    // Scope to the SECTION, and to the bullet that carries each claim. Asserting
    // a word exists somewhere in a 440-line document is not a test: "spent"
    // appears four times, so a guard looking only for it survives gutting the
    // one bullet that matters.
    const section = DOC.slice(DOC.indexOf("## Why the receive code is one-time"));
    // Strip emphasis markers: these assertions are about what the text SAYS, and
    // "*before* the pad is saved" means the same as "before the pad is saved".
    const bullets = section
      .slice(0, section.indexOf("**What does"))
      .replace(/\s+/g, " ")
      .replace(/\*/g, "");
    expect(bullets, "acceptance bullet must say the request is spent").toMatch(
      /Bob accepts a sealed pad[\s\S]{0,40}spent/i
    );
    expect(bullets, "rejection must be named").toMatch(/did not match/i);
    expect(bullets, "the Cancel button must be named").toMatch(/Cancel this receive code/);
    expect(bullets, "expiry must be named").toMatch(/expires/i);
    // The order that makes a failed save lose the transfer rather than reuse the
    // key. One assertion, no alternation to hide behind.
    expect(bullets, "consume-before-save ordering must be explained").toMatch(
      /before the pad is saved/i
    );
    // ...and creating or pasting the code must not be described as spending it.
    expect(DOC).toMatch(/Creating the code does not/i);
  });

  it("says sealing works from the recorded request, not a re-supplied code", () => {
    // spt-seal carries (requestHash, pairId) only; the worker reads the
    // confirmed body from durable storage. That is what closes the gap between
    // comparing the words and sealing, and it is the whole payoff of the
    // twelve-word ceremony — so both artefacts have to say it.
    for (const [where, text] of BOTH) {
      expect(text, `${where} must say the request is recorded at confirmation`).toMatch(
        /record(s|ed)?\s+that\s+exact\s+receive\s+request/i
      );
      expect(text, `${where} must say the code is not handed over again`).toMatch(
        /does\s+not\s+hand\s+the\s+code\s+over\s+again/i
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

describe("the README's quantum section matches the shipped product", () => {
  // The Phase 1E release audit recorded this as repaired while the file was
  // never touched — two batched edits failed, one traceback was misattributed,
  // and the record outran the tree. A guard is cheaper than remembering.
  const README = readFileSync(join(ROOT, "README.md"), "utf8");
  const QUANTUM = README.slice(README.indexOf("## What about quantum computers?"));
  const SECTION = QUANTUM.slice(0, QUANTUM.indexOf("\n---")).replace(/\s+/g, " ");

  it("does not deny ML-KEM while the product ships it", () => {
    expect(SECTION, "the section must name the sealed delivery path").toMatch(/ML-KEM-768/);
    expect(SECTION, "and say it is a delivery mechanism, not the message cipher").toMatch(
      /deliver(y|s)[^.]{0,80}not the cipher|not the cipher[^.]{0,80}deliver/i
    );
    // Attached to the DELIVERY sentence, not merely present in the section — the
    // word already appears there for other reasons, so a loose match would
    // survive deleting the one place it is load-bearing.
    expect(SECTION, "the delivered-that-way claim must say computational").toMatch(
      /deliver(ed|y)[^.]{0,60}computational|computational[^.]{0,60}(end-to-end|deliver)/i
    );
    // The old blanket denial must be gone: it was true of the cipher and false
    // of the product.
    expect(SECTION).not.toMatch(/TruePad is \*\*not\*\* "post-quantum cryptography"/);
  });

  it("still says the MESSAGE cipher is not a lattice scheme", () => {
    // Correcting the overreach must not flip into the opposite overclaim.
    expect(SECTION).toMatch(/not a lattice scheme/i);
    expect(SECTION).toMatch(/message.{0,20}cipher/i);
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

  it("never says the attacker must break both branches of the hybrid", () => {
    // The normative spec withdraws this exact shorthand as FALSE
    // (SEALED-PAD-TRANSFER.md: "The popular shorthand 'the attacker must break
    // both' is *false* ... stating it would be an overclaim"), and the beginner
    // explainer had it anyway. A quantum adversary breaks X25519 outright, so
    // ML-KEM-768 carries the claim alone; and a break of HKDF or AES opens an
    // archive with no KEM work at all.
    const OVERCLAIM = [
      /(has|have|must|needs?)\s+to\s+break\s+\*{0,2}both/i,
      /break\s+\*{0,2}both\*{0,2}\s+(to|before)/i,
      /survives?\s+a?\s*future\s+break\s+of\s+either/i,
      /no single (primitive|component) break opens/i
    ];
    for (const [where, text] of BOTH) {
      for (const bad of OVERCLAIM) {
        expect(text, `${where} must not use the "break both" shorthand`).not.toMatch(bad);
      }
    }
    // The correct framing must be present, so this cannot be satisfied by
    // deleting the explanation of the hybrid instead of fixing it.
    expect(DOC, "the doc must say the branches cover different adversaries").toMatch(
      /different adversaries|carries the claim by itself|carries the entire claim/i
    );
  });

  it("names BOTH routes back to an archived pad, on every surface that raises it", () => {
    // The 1E audit repaired HNDL_NOTE and stopped; the technical line in the
    // very panel a sender reads before sealing still named one route, and so
    // did the README and the audit's own Boundaries list.
    const surfaces: [string, string][] = [
      ["the doc", DOC],
      ["the page", PAGE],
      ["spt-shared.ts", readFileSync(join(ROOT, "src/browser/ui/spt-shared.ts"), "utf8")],
      ["README.md", readFileSync(join(ROOT, "README.md"), "utf8")],
      ["the release audit", readFileSync(join(ROOT, "docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md"), "utf8")]
    ];
    for (const [where, text] of surfaces) {
      // Scope to the HNDL PASSAGE. Whole-file matching passes on an unrelated
      // "restore" elsewhere in the same file — which is exactly how three
      // surfaces kept a single-route warning while looking guarded. Sentence
      // matching alone over-fires, because a file may mention an archived copy
      // while explaining something else (what the hybrid does and does not buy).
      // So: find each place that says an archive could BECOME READABLE, and
      // require both routes within that passage.
      const flat = text.replace(/\s+/g, " ");
      const claims = [...flat.matchAll(/archived[^.]{0,80}?(sealed file|\.?tps2|copies|package)/gi)];
      for (const m of claims) {
        // Look BOTH ways: a document may list the two routes and then refer back
        // to them ("either would let the archived package be opened").
        const at = m.index ?? 0;
        const window = flat.slice(Math.max(0, at - 420), at + 420);
        if (!/exposed|readable|reveal|expose the pad/i.test(window)) continue; // not an HNDL claim
        expect(window, `${where} raises HNDL but names only the cryptanalysis route`).toMatch(
          /restor(e|ed|ing)|backup|clon(e|ed)/i
        );
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

  it("the link is relative, so it survives the project base path", () => {
    // The site is served from https://…github.io/TruePad/ , and every screen
    // that links to the explainer is a hash route under that same directory. A
    // root-absolute "/online-delivery.html" would resolve to the domain root
    // and 404; the relative form resolves under /TruePad/.
    expect(SHARED).toMatch(/ONLINE_EXPLAINER_HREF = "online-delivery\.html"/);
    expect(SHARED, "no leading slash").not.toMatch(/ONLINE_EXPLAINER_HREF = "\//);
    expect(SHARED, "no absolute origin").not.toMatch(/ONLINE_EXPLAINER_HREF = "https?:/);
    // The page's own links must be relative for the same reason. `/src/...` is
    // excluded: it is a build-time source reference that Vite rewrites into a
    // hashed relative asset, so the thing that must actually be relative is
    // what ships — asserted against dist/ below when a build is present.
    const relOf = (html: string) =>
      [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !/^https?:|^#|^mailto:/.test(h));
    for (const h of relOf(PAGE)) {
      if (h.startsWith("/src/")) continue;
      expect(h, `"${h}" must be relative to survive the /TruePad/ base path`).not.toMatch(/^\//);
    }
    const built = join(ROOT, "dist", "online-delivery.html");
    if (!existsSync(built)) {
      if (process.env.CI) throw new Error("dist/online-delivery.html missing: build before testing");
      return;
    }
    for (const h of relOf(readFileSync(built, "utf8"))) {
      expect(h, `built page: "${h}" would resolve to the domain root, not /TruePad/`).not.toMatch(/^\//);
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
