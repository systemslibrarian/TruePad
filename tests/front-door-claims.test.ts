import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ============================================================================
 * The front door
 * ----------------------------------------------------------------------------
 * README, SECURITY.md, CHANGELOG and the Browser home are the first things a
 * newcomer meets, and they are the easiest place for the project to start
 * describing a version of itself that no longer exists.
 *
 * Every assertion here pins a PASSAGE or a relationship, never a bare keyword
 * anywhere in a long file. An earlier round of guards was satisfied by words
 * that happened to appear elsewhere while the sentence carrying the claim had
 * been gutted, which is worse than having no guard: it reports safety.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SECURITY = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const HOME = readFileSync(join(ROOT, "src/browser/ui/home.ts"), "utf8");
/** The first screen: everything above the deep-dive sections. */
const FIRST_SCREEN = README.slice(0, README.indexOf("## The exhibit"));

describe("README describes the TruePad that ships", () => {
  it("no longer opens as an exhibit plus a CLI", () => {
    expect(README.startsWith("# TruePad 2")).toBe(true);
    expect(README).not.toContain("Two things live in this repository");
    expect(README).not.toContain("A true one-time pad exhibit");
  });

  it("leads with the hard problem and the governing rule", () => {
    expect(FIRST_SCREEN).toMatch(/## The XOR is the easy part/);
    expect(FIRST_SCREEN, "the rule must appear on the first screen").toMatch(
      /LOSS IS ACCEPTABLE\.? REUSE IS NOT\./
    );
    // ...and be explained, not just chanted.
    expect(FIRST_SCREEN).toMatch(/loses the material|chooses loss/i);
  });

  it("keeps the three guarantees separate and unmergeable", () => {
    const map = FIRST_SCREEN.slice(FIRST_SCREEN.indexOf("Three guarantees"));
    const table = map.slice(0, map.indexOf("## TruePad 2 — the current system"));
    expect(table, "private handoff row").toMatch(/[Pp]rivate pad handoff/);
    expect(table, "and its conditional IT claim").toMatch(/conditional[\s\S]{0,40}information-theoretic/i);
    expect(table, "sealed delivery row").toMatch(/[Ss]ealed online pad delivery/);
    expect(table, "named as computational").toMatch(/\*\*Computational\.\*\*/);
    expect(table, "and explicitly NOT information-theoretic").toMatch(
      /not\*{0,2}\s*an information-theoretic Internet-delivery claim/i
    );
    expect(table, "messages row").toMatch(/Wegman–Carter/);
    // The reader must not be able to collapse them. Note the wording this
    // checks for deliberately avoids "information-theoretically secure" — that
    // exact phrase is retracted project-wide (tests/claims.test.ts), because
    // getRandomValues is a DRBG, so even a disclaimer may not mint it.
    expect(FIRST_SCREEN).toMatch(
      /messages crossing the Internet\s*\n?inherit the one-time pad's unconditional guarantee\. They do not\./i
    );
  });

  it("does not describe ordinary messages as using the delivery cryptography", () => {
    expect(FIRST_SCREEN, "the short form must be scoped to delivery").toMatch(
      /PQC delivers the pad\. OTP encrypts the messages\./
    );
    expect(FIRST_SCREEN).toMatch(
      /ordinary TruePad 2 messages do\s*\n?not use X-Wing, ML-KEM or AES-GCM/i
    );
  });

  it("puts TruePad 2 first and the v1 CLI in its place", () => {
    const current = README.indexOf("## TruePad 2 — the current system");
    const legacy = README.indexOf("## Earlier teaching CLI");
    expect(current, "the current system must be introduced").toBeGreaterThan(0);
    expect(legacy, "the legacy CLI must be introduced").toBeGreaterThan(0);
    expect(legacy, "legacy must come after the current system").toBeGreaterThan(current);
    // Browser Edition is named as the main experience, before the CLI appears.
    expect(README.slice(current, legacy)).toMatch(/Browser Edition[\s\S]{0,80}main\s*\n?experience/i);
    expect(README.slice(current, legacy)).toMatch(/Learn — the OTP exhibit/);
  });

  it("warns that v1 envelopes are unauthenticated, where v1 is introduced", () => {
    const legacy = README.slice(README.indexOf("## Earlier teaching CLI"));
    const section = legacy.slice(0, legacy.indexOf("\n## ") > 0 ? legacy.indexOf("\n## ") : 2000);
    expect(section, "the warning must sit with the v1 entry").toMatch(
      /v1 envelopes are unauthenticated/i
    );
    expect(section).toMatch(/undetectably|flip chosen bits/i);
    expect(section, "and must point at the authenticated path").toMatch(/Format v2[\s\S]{0,80}authenticated path/i);
  });

  it("links the security policy and the readable explainer from the first screen", () => {
    expect(FIRST_SCREEN).toMatch(/\[Security Policy\]\(SECURITY\.md\)/);
    expect(FIRST_SCREEN).toMatch(/\[How online pad delivery works\]\(docs\/HOW-ONLINE-PAD-DELIVERY-WORKS\.md\)/);
    expect(FIRST_SCREEN).toMatch(/\[Changelog\]\(CHANGELOG\.md\)/);
  });

  it("states release status truthfully and invents no history", () => {
    const status = README.slice(README.indexOf("## Release status"));
    const section = status.slice(0, status.indexOf("\n## "));
    expect(section).toMatch(/audited release candidate/i);
    expect(section).toMatch(/No formal version or tag exists yet/i);
    expect(section, "the planned release must be named").toMatch(/v2\.0\.0/);
    expect(section, "and must say why 2").toMatch(/never a formal TruePad 1\.0|Format v2 \/ Browser\s*\n?generation/i);
    // No fabricated lineage, anywhere.
    expect(README).not.toMatch(/v1\.0\.0/);
  });

  it("every local link resolves to a file that exists", () => {
    const links = [...README.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0]);
    for (const rel of links) {
      if (!rel) continue;
      expect(existsSync(join(ROOT, rel)), `README links ${rel}, which does not exist`).toBe(true);
    }
  });

  it("makes no claim the implementation does not earn", () => {
    // These phrases are not banned outright: the README earns its credibility
    // partly by naming the things it refuses to say ("TruePad is not labelled
    // 'quantum proof'"), and a blanket ban would delete exactly that. What is
    // banned is ASSERTING them. So each hit is judged in its own sentence.
    const NEGATION = /\b(not|never|no|nor|neither|without|refus\w+|avoid\w*|drop\w*|instead of|rather than|does not|cannot)\b/i;
    // Split on sentence ends AND on line boundaries. Markdown headings and list
    // items carry no terminal punctuation, so flattening the file first merges
    // a whole bullet list into one "sentence" — and a stray "no cryptography
    // required" three bullets away then satisfies the negation test for an
    // assertion made further down. That is exactly how an injected
    // "TruePad 2 is quantum-proof." slipped past the first version of this.
    // The right unit is neither the whole file nor the single line. Flattening
    // everything lets a "no" three bullets away excuse an assertion further
    // down; splitting every line breaks a negation that happens to wrap. So:
    // paragraphs, with list/heading/table blocks split per line because each of
    // those really is its own statement, and wrapped prose kept together.
    const sentences = README.split(/\n\s*\n/).flatMap((block) => {
      const structural = /^\s*(?:[-*+]\s|#{1,6}\s|\||>)/;
      const units = structural.test(block) ? block.split(/\n/) : [block];
      return units.flatMap((u) => u.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/));
    }).map((x) => x.trim()).filter(Boolean);
    const FORBIDDEN = [
      /\bunbreakable\b/i,
      /quantum[- ]proof/i,
      /quantum[- ]safe/i,
      /perfectly secure/i,
      /unconditionally secure/i,
      /NIST[- ]standard X-Wing/i,
      /(RFC|IETF)[- ](standard|approved) X-Wing/i
    ];
    for (const bad of FORBIDDEN) {
      for (const sentence of sentences) {
        if (!bad.test(sentence)) continue;
        expect(
          NEGATION.test(sentence),
          `README asserts ${String(bad)} without disclaiming it: "${sentence.slice(0, 200)}"`
        ).toBe(true);
      }
    }
    // These two get the same treatment rather than a blanket ban — the README
    // names the messenger claim precisely in order to refuse it, and deleting
    // that sentence would remove the refusal, not the risk.
    for (const bad of [/information-theoretically secure Internet/i, /safe to email the (raw )?pad/i]) {
      for (const sentence of sentences) {
        if (!bad.test(sentence)) continue;
        expect(
          NEGATION.test(sentence),
          `README asserts ${String(bad)} without disclaiming it: "${sentence.slice(0, 200)}"`
        ).toBe(true);
      }
    }
  });
});

describe("the screenshot is a real, tracked asset", () => {
  const shot = join(ROOT, "docs/assets/truepad-browser.png");
  it("exists, is a PNG, and has sensible dimensions", () => {
    expect(existsSync(shot)).toBe(true);
    const buf = readFileSync(shot);
    expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBeGreaterThan(600);
    expect(height).toBeGreaterThan(300);
    expect(statSync(shot).size).toBeGreaterThan(1000);
  });

  it("is referenced by a relative path with real alt text", () => {
    const img = README.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    expect(img, "README must carry a screenshot").toBeTruthy();
    expect(img![2], "no absolute or local path").toBe("docs/assets/truepad-browser.png");
    expect(img![1].length, "alt text must describe the image").toBeGreaterThan(40);
  });
});

describe("SECURITY.md is truthful about what exists", () => {
  it("exists and does not invent a private channel", () => {
    expect(SECURITY.startsWith("# Security Policy")).toBe(true);
    const report = SECURITY.slice(SECURITY.indexOf("## Reporting a vulnerability"));
    const section = report.slice(0, report.indexOf("\n## "));
    // Either it says PVR is on and points at it, or it says plainly that there
    // is no private channel. What it may never do is invent one.
    expect(section).toMatch(/private vulnerability reporting is currently disabled|Report a vulnerability/i);
    expect(section, "no invented contact address").not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(section, "must warn against public exploit detail").toMatch(/[Dd]o not put working exploit detail/);
  });

  it("scopes reuse and the security-state machinery", () => {
    const scope = SECURITY.slice(SECURITY.indexOf("## In scope"), SECURITY.indexOf("## Known model boundaries"));
    for (const item of [
      "pad reuse",
      "Wegman–Carter",
      "witness and rollback",
      "provenance",
      "worker secret boundary",
      "consume-before-import",
      "claims text"
    ]) {
      expect(scope, `${item} must be in scope`).toMatch(new RegExp(item, "i"));
    }
  });

  it("lists the boundaries, and says a defect inside them is still a bug", () => {
    const b = SECURITY.slice(SECURITY.indexOf("## Known model boundaries"), SECURITY.indexOf("## Supported versions"));
    for (const item of [/physical randomness/i, /physical erasure/i, /restored or cloned browser profile/i,
                        /OPFS write fallback is not truly atomic/i, /human behaviour/i, /harvest-now-decrypt-later/i]) {
      expect(b, `boundary ${String(item)} must be documented`).toMatch(item);
    }
    expect(b, "a violation of a boundary is still a vulnerability").toMatch(
      /still a\s*\n?\*{0,2}vulnerability/i
    );
  });

  it("targets master until the first tag, and claims no v1.x line", () => {
    const v = SECURITY.slice(SECURITY.indexOf("## Supported versions"));
    expect(v).toMatch(/Until \*\*TruePad 2\.0\.0\*\* is formally tagged, security fixes target current\s*\n?`master`/);
    expect(v).toMatch(/no supported v1\.x release/i);
  });
});

describe("CHANGELOG names the plan without inventing a past", () => {
  it("is unreleased and points at v2.0.0", () => {
    expect(CHANGELOG).toMatch(/^# Changelog/);
    expect(CHANGELOG).toMatch(/## Unreleased — planned v2\.0\.0/);
    expect(CHANGELOG).toMatch(/first formally tagged release/i);
  });

  it("invents no version, date, or prior release", () => {
    expect(CHANGELOG).not.toMatch(/v1\.0\.0/);
    expect(CHANGELOG, "no invented release date").not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(CHANGELOG, "no released heading").not.toMatch(/^## \[?v?\d+\.\d+\.\d+/m);
  });
});

describe("the Browser home stays simple", () => {
  it("gains one quiet clarification and no new action", () => {
    expect(HOME).toMatch(/How you share the pad matters/);
    expect(HOME, "it must link to the explainer").toMatch(/href: "online-delivery\.html"/);
    // Secondary weight, not a button, not a tile.
    const line = HOME.slice(HOME.indexOf("How you share the pad matters") - 400, HOME.indexOf("How you share the pad matters") + 200);
    expect(line, "must be a paragraph at hero-alt weight").toMatch(/class: "hero-alt faint share-note"/);
    expect(line, "must not be a primary button").not.toMatch(/class: "btn primary/);
  });

  it("keeps the hero free of cryptography", () => {
    expect(HOME).not.toMatch(/X-Wing|ML-KEM|PQC|post-quantum|information-theoretic|Wegman/i);
    // The two original actions, and no third.
    expect(HOME).toMatch(/Private messages using a pad you share with one other person/);
    expect((HOME.match(/createBtn\("primary lg"\)/g) ?? []).length).toBe(1);
  });
});
