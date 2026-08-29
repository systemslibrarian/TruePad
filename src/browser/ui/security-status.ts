/* ============================================================================
 * TruePad 2 Browser Edition — Security status
 * ----------------------------------------------------------------------------
 * The in-app claims ledger. Every guarantee carries its classification —
 * PROTOCOL (frozen, identical on every edition), PLATFORM-OP (this edition's
 * browser primitives), OPERATOR (only you can discharge it), NATIVE-ONLY (a CLI
 * guarantee the browser does NOT make) — and the browser's scope is stated as
 * itself, never a borrowed one. The cross-edition matrix fills the Browser
 * column truthfully and marks the other editions forthcoming. Copy here tracks
 * docs/BROWSER-SECURITY.md; nothing is rounded up.
 * ========================================================================= */

import { h, icon, mount } from "./dom.ts";
import { chip, callout } from "./components.ts";
import type { Ctx } from "./context.ts";

type Klass = "protocol" | "platform" | "operator" | "native";

const KLABEL: Record<Klass, string> = {
  protocol: "PROTOCOL",
  platform: "PLATFORM-OP",
  operator: "OPERATOR",
  native: "NATIVE-ONLY"
};

function ledgerItem(k: Klass, title: string, body: string): HTMLElement {
  return h(
    "li",
    {},
    chip(k, KLABEL[k]),
    h("div", { class: "ll-body" }, h("strong", { text: title }), h("span", { text: body }))
  );
}

function guaranteesSection(): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Protocol guarantees" }),
    h("p", { class: "section-note", text: "These come from the frozen Store Format v2 / wc-one-time-v1 construction. The src/core modules are reused byte-for-byte, so they hold identically here and on every other edition." }),
    h(
      "ul",
      { class: "ledger-list" },
      ledgerItem("protocol", "Authenticated one-time pad", "Exact XOR over uniform pad material, with a Wegman–Carter one-time tag (POLYVAL / wc-one-time-v1). The §11 vectors reproduce in this build."),
      ledgerItem("protocol", "Used exactly once", "Advancing the durable counters is what retires material. A replay or a late record is refused before verification — loss is acceptable, reuse is not."),
      ledgerItem("protocol", "No downgrade, no v1", "There is no --legacy, --no-auth, or --force in this engine, and no v1 path. A v1 store is refused, never silently opened."),
      ledgerItem("protocol", "Authentication decides before plaintext", "An open verifies the tag before releasing a single byte. A failed tag releases nothing and costs a durable attempt reservation; enough failures freeze the direction."),
      ledgerItem("platform", "Commit before emit", "A send stages in memory, durably commits head then journal, advances the witness, and only then emits the envelope. A crash loses the record's material, never reuses it."),
      ledgerItem("platform", "One mutator per pair", "Exactly one operation mutates a pair at a time, enforced with the Web Locks API — real mutual exclusion in the worker, not a UI busy flag. Its scope is this origin in this browser.")
    )
  );
}

function sourceSection(): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Source — declared, not verified" }),
    h(
      "ul",
      { class: "ledger-list" },
      ledgerItem("operator", "Provenance is your assertion", "One file is one source; several are XORed. You declare each source's origin; this tool cannot test physical provenance and never claims to."),
      ledgerItem("operator", "Aliasing cannot be detected", "The browser File API exposes no filesystem identity, so the edition cannot tell that two selected files alias one underlying file — a limit the CLI does not have. It states this rather than inventing identity from a pad-derived hash."),
      ledgerItem("protocol", "The verdict is scoped", "Generation prints the combiner's verdict verbatim: uniform IF at least one declared source was uniform and independent. Browser DRBG material is labelled computational — not information-theoretic entropy.")
    )
  );
}

function durabilitySection(persistent: boolean | null): HTMLElement {
  const rows: [string, string][] = [
    ["Page reload / browser restart", "Survived. Everything written to OPFS and flushed persists across normal reloads and restarts."],
    ["What flush() means", "The bytes were handed to the browser's storage layer — the analogue of the CLI's fsync, and weaker: browsers do not document power-loss semantics for OPFS."],
    ["Tab / worker crash after flush()", "Survived — the flushed bytes are in OPFS, and commit-before-emit makes a crash lose material, never reuse it."],
    ["Power loss mid-write", "Not claimed. The browser makes no power-loss durability claim anywhere."],
    ["“Clear site data”", "Destroys the OPFS store — every pad for this origin is gone. This is deletion you perform, not a protocol event."],
    ["Profile backup / restore", "Restoring a backed-up profile regresses the store exactly like the CLI's whole-directory restore; the rollback residual applies."],
    ["Private / Incognito window", "OPFS is typically ephemeral there — the store vanishes when the session ends."],
    ["Two profiles / two devices", "Each is an independent copy of whatever was couriered to it. TruePad never syncs them."]
  ];
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Platform — what “durable” means here" }),
    h("p", { class: "section-note" }, h("span", { text: "The store is the Origin Private File System (OPFS), written with worker sync access handles and flushed. It is " }), h("strong", { text: "weaker than the CLI's Linux-ext4 durability" }), h("span", { text: ", and this table says exactly how." })),
    persistent === false
      ? callout({ tone: "warn", title: "This context may not retain storage", body: "The browser reports this origin's storage as best-effort, which can mean a private window or an evictable store. Request persistence below, and keep a couriered copy." })
      : persistent === true
        ? callout({ tone: "ok", title: "Storage is marked persistent", body: "This origin has been granted persistent storage; the browser will not evict it under storage pressure. It is still not power-loss durable." })
        : null,
    h(
      "div",
      { class: "matrix-wrap" },
      h(
        "table",
        { class: "matrix" },
        h("thead", {}, h("tr", {}, h("th", { text: "Question" }), h("th", { text: "Browser answer" }))),
        h("tbody", {}, ...rows.map(([q, a]) => h("tr", {}, h("td", { text: q }), h("td", { text: a }))))
      )
    )
  );
}

function rollbackSection(): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Rollback witness" }),
    h(
      "ul",
      { class: "ledger-list" },
      ledgerItem("platform", "Browser-local witness", "An append-only journal of the three monotone counters in a second, separately-cleared OPFS store the pair's export never includes — a partial failure-domain distinction that catches a restore of the pair store while the witness is untouched. It is crash-safe: a torn append leaves the previous record authoritative, and a provisioned witness that goes missing fails closed, never reads as fresh."),
      ledgerItem("operator", "Only as independent as the two stores' clearing", "Both live under this origin; “clear site data” removes both, so a witness cleared alongside the pair knows nothing. Weaker than the CLI's cross-medium witness."),
      ledgerItem("native", "Not an external witness", "The CLI's separate-state-file assumes an independent host failure domain a browser page cannot reach. This edition does not offer it and does not relabel browser-local state as its equal — it is browser-LOCAL, and named so.")
    ),
    callout({
      tone: "info",
      title: "The caveat, verbatim",
      body: "Rollback protection: browser-local only. This does not provide the same independent rollback witness guarantee as Operational TruePad."
    })
  );
}

function destructionSection(): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Destruction" }),
    h(
      "ul",
      { class: "ledger-list" },
      ledgerItem("platform", "An irreversible boundary", "destroy writes a durable tombstone; every operation refuses the pair afterwards, before any secret is read. It is restartable and idempotent, and preserves the original tombstone on resume."),
      ledgerItem("native", "Not physical erasure", "The engine best-effort zero-overwrites the secret, but OPFS gives no control over the medium — copy-on-write, wear leveling, and the OS page cache may keep pre-overwrite blocks.")
    ),
    callout({
      tone: "warn",
      title: "The modest claim, verbatim",
      body: "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."
    })
  );
}

function legend(): HTMLElement {
  const item = (k: Klass, desc: string) => h("div", { class: "row" }, chip(k, KLABEL[k]), h("span", { class: "faint", text: desc }));
  return h(
    "div",
    { class: "card stack-sm" },
    item("protocol", "Frozen construction; identical on every edition."),
    item("platform", "This edition's browser primitives (OPFS, sync handles, Web Locks) — weaker than the native equivalent."),
    item("operator", "An assumption only you can discharge."),
    item("native", "A CLI guarantee the browser does not make; stated as absent, never faked.")
  );
}

type Cell = { text: string; tone: "yes" | "no" | "soon" | "op"; note?: string };
type Row = { guarantee: string; klass: Klass; browser: Cell };

const MATRIX: Row[] = [
  { guarantee: "Frozen v2 crypto (POLYVAL, wc-one-time-v1, partition, frame, envelope)", klass: "protocol", browser: { text: "Yes", tone: "yes", note: "src/core reused byte-for-byte" } },
  { guarantee: "Commit before emit — loss, not reuse", klass: "platform", browser: { text: "Yes", tone: "yes", note: "OPFS flush + the §12 order in the worker" } },
  { guarantee: "One mutator per pair", klass: "platform", browser: { text: "Yes", tone: "yes", note: "Web Locks, not a UI flag" } },
  { guarantee: "Three-counter rollback witness; witness-regressed", klass: "protocol", browser: { text: "Yes", tone: "yes", note: "browser-local classes only" } },
  { guarantee: "Irreversible destroy tombstone; restartable", klass: "protocol", browser: { text: "Yes", tone: "yes", note: "tombstone in OPFS" } },
  { guarantee: "No downgrade; v1 refused", klass: "protocol", browser: { text: "Yes", tone: "yes" } },
  { guarantee: "Power-loss durability", klass: "native", browser: { text: "Not claimed", tone: "no" } },
  { guarantee: "External independent rollback witness", klass: "native", browser: { text: "Not offered", tone: "no" } },
  { guarantee: "Physical erasure on destroy", klass: "native", browser: { text: "Not claimed", tone: "no" } },
  { guarantee: "Physical source provenance / alias detection", klass: "operator", browser: { text: "Declared, not verified", tone: "op" } }
];

function cell(c: Cell): HTMLElement {
  const cls = c.tone === "yes" ? "cell-yes" : c.tone === "no" ? "cell-no" : c.tone === "op" ? "" : "cell-soon";
  return h("td", {}, h("span", { class: cls, text: c.text }), c.note ? h("small", { text: c.note }) : null);
}

function matrixSection(): HTMLElement {
  return h(
    "section",
    { class: "section" },
    h("h2", { text: "Cross-edition claims matrix" }),
    h("p", { class: "section-note", text: "The Browser column is populated from this edition's claims ledger. Android and Desktop editions run the same frozen protocol on a different operational substrate; their columns are forthcoming and will be filled from their own ledgers, not this one." }),
    legend(),
    h(
      "div",
      { class: "matrix-wrap", style: "margin-top:1rem" },
      h(
        "table",
        { class: "matrix" },
        h("thead", {}, h("tr", {}, h("th", { text: "Guarantee" }), h("th", { text: "Class" }), h("th", { text: "Browser" }), h("th", { text: "Android" }), h("th", { text: "Desktop" }))),
        h(
          "tbody",
          {},
          ...MATRIX.map((row) =>
            h(
              "tr",
              {},
              h("td", { text: row.guarantee }),
              h("td", {}, chip(row.klass, KLABEL[row.klass])),
              cell(row.browser),
              h("td", {}, h("span", { class: "cell-soon", text: "forthcoming" })),
              h("td", {}, h("span", { class: "cell-soon", text: "forthcoming" }))
            )
          )
        )
      )
    )
  );
}

export async function renderSecurity(ctx: Ctx, root: HTMLElement): Promise<void> {
  const persistBtn =
    ctx.storagePersistent === false
      ? h(
          "button",
          {
            class: "btn small",
            type: "button",
            on: {
              click: async () => {
                const granted = await ctx.requestPersistent();
                ctx.toast(granted ? "Persistent storage granted." : "The browser declined persistent storage.", granted ? "ok" : "danger");
                if (granted) ctx.navigate({ name: "security" });
              }
            }
          },
          h("span", { text: "Request persistent storage" })
        )
      : null;

  mount(
    root,
    h("a", { class: "back-link", href: "#", on: { click: (e) => { e.preventDefault(); ctx.navigate({ name: "home" }); } } }, icon("back"), h("span", { text: "All pairs" })),
    h(
      "header",
      { class: "screen-head" },
      h("span", { class: "eyebrow", text: "Security status" }),
      h("h1", { text: "What this edition guarantees — and does not" }),
      h("p", { class: "lede", text: "The same frozen protocol as the CLI, on a browser substrate that is honestly weaker in named places. Nothing here is rounded up to a stronger claim than it deserves." })
    ),
    guaranteesSection(),
    sourceSection(),
    durabilitySection(ctx.storagePersistent),
    persistBtn ? h("div", { class: "btn-row", style: "margin-top:0.75rem" }, persistBtn) : null,
    rollbackSection(),
    destructionSection(),
    matrixSection(),
    h(
      "section",
      { class: "section" },
      h("h2", { text: "Learn & source" }),
      h(
        "div",
        { class: "btn-row" },
        h("a", { class: "btn ghost", href: "learn.html" }, icon("external"), h("span", { text: "Open the teaching Lab (/learn)" })),
        h("a", { class: "btn ghost", href: "https://github.com/systemslibrarian/TruePad", attrs: { target: "_blank", rel: "noreferrer noopener" } }, icon("external"), h("span", { text: "Source & docs on GitHub" }))
      )
    )
  );
}
