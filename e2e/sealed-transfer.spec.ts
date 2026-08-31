import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { TPS2_FIXED_OVERHEAD_BYTES, TPS2_MAGIC_BYTES } from "../src/spt/constants.ts";
import { decodeReceiveRequest, parseRequestBody } from "../src/spt/receive-request.ts";

/* ============================================================================
 * Sealed Pad Transfer — the whole human ceremony, in two real browsers
 * ----------------------------------------------------------------------------
 * Alice and Bob get their own browser CONTEXT, which means their own OPFS. They
 * are two people, not two tabs.
 *
 * The assertions that matter are not "the buttons work". They are:
 *
 *   · both sides render the SAME twelve words, and the same eight;
 *   · Alice's eight words are NOT IN THE DOM until she says she heard Bob's —
 *     receiver-first is the premise §8.2's argument rests on, and text that is
 *     merely covered by CSS is text that was already available;
 *   · the file Alice saves is byte-for-byte what the worker returned;
 *   · after the transfer, ordinary TP2 messages flow BOTH ways over the
 *     delivered pad, through the unchanged message path.
 *
 * That last one is the point of the feature: sealed transfer delivers the
 * existing pad. It is not a second cryptosystem living beside it.
 * ========================================================================= */

async function createPad(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a pad" }).click();
  await expect(page.getByRole("heading", { name: "Create a pad" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill(name);
  await page.getByText("Small", { exact: true }).click();
  await page.getByRole("button", { name: "Create pad" }).click();
  await expect(page.getByText("Pad created")).toBeVisible();
}

/** The words a screen is currently showing, in order. */
async function wordsOn(page: Page): Promise<string[]> {
  return page.locator(".words .word-w").allTextContents();
}

/** Bob: create a receive code, and return it with his twelve words. */
async function createReceiveCode(page: Page): Promise<{ code: string; words: string[] }> {
  await page.goto("/#/import");
  await expect(page.getByRole("heading", { name: "Add a shared pad" })).toBeVisible();
  await page.getByText("Receive securely online").click();
  await expect(page.getByRole("heading", { name: "Receive a pad" })).toBeVisible();
  await page.getByRole("button", { name: "Create receive code" }).click();
  await expect(page.locator("#receive-code")).toBeVisible();
  const code = await page.locator("#receive-code").inputValue();
  return { code, words: await wordsOn(page) };
}

test.describe("sealed pad transfer, end to end", () => {
  test("Alice seals to Bob, both compare words, and the pad then carries real messages", async ({ browser }) => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const a = await alice.newPage();
    const b = await bob.newPage();

    // Bob asks for a pad.
    const { code, words: bobRequestWords } = await createReceiveCode(b);
    expect(code).toMatch(/^TPR2:[A-Za-z0-9_-]+$/);
    expect(code).toHaveLength(1652);
    expect(bobRequestWords).toHaveLength(12);

    // Alice makes a pad and chooses to send it online.
    await createPad(a, "Chat with Bob");
    await a.getByRole("button", { name: "Send securely online" }).first().click();
    await expect(a.getByRole("heading", { name: "Send pad securely online" })).toBeVisible();
    await a.locator("#paste-code").fill(code);
    await a.getByRole("button", { name: "Continue" }).click();

    // The twelve words must be identical on both devices.
    await expect(a.locator(".words .word-w").first()).toBeVisible();
    expect(await wordsOn(a)).toEqual(bobRequestWords);

    await a.getByRole("button", { name: "The words matched" }).click();
    await expect(a.getByRole("button", { name: "Seal pad" })).toBeVisible();

    // Capture the EXACT bytes the download will contain.
    const downloadPromise = a.waitForEvent("download");
    await a.getByRole("button", { name: "Seal pad" }).click();
    await expect(a.getByRole("heading", { name: "Send the sealed pad" })).toBeVisible();

    // MASKED. Alice's eight words are not in the document yet — not hidden,
    // ABSENT. Bob has not spoken.
    const maskedText = (await a.locator("body").textContent()) ?? "";
    const maskedHtml = (await a.locator("body").innerHTML()) ?? "";
    // The spec typechecks under the Node lib (no DOM), so the document is
    // reached through a local structural type rather than lib.dom's globals.
    const maskedAttrs = await a.evaluate(() => {
      type El = { attributes: ArrayLike<{ value: string }> };
      const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<El> } }).document;
      return [...doc.querySelectorAll("*")].flatMap((el) => Array.from(el.attributes, (at) => at.value));
    });
    expect(await a.locator(".words .word-w").count()).toBe(0);

    await a.getByRole("button", { name: "Save sealed pad" }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();

    // Bob opens the sealed file.
    await b.getByRole("button", { name: "Choose sealed pad" }).click({ trial: true });
    await b.locator("#sealed-file").setInputFiles(path!);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();
    const bobConfirmWords = await wordsOn(b);
    expect(bobConfirmWords).toHaveLength(8);
    // Alice's screen carried no word LIST before the reveal, and did not carry
    // Bob's eight as a sequence. (Individually they are ordinary English —
    // "save", "come", "basic" — and collide with button copy, so the
    // meaningful checks are the absent list and the absent sequence.)
    expect(maskedText).not.toContain(bobConfirmWords.join(" "));
    expect(maskedText).not.toContain(bobConfirmWords.slice(0, 3).join(" "));

    // ...and not in an ATTRIBUTE either. `textContent` cannot see a `data-`
    // value, a `title`, or an `aria-label`, and "rendered but stashed in a
    // property" is precisely the leak this ordering exists to prevent. The
    // markup is the stronger surface: it carries text and attributes both.
    expect(maskedHtml).not.toContain(bobConfirmWords.join(" "));
    expect(maskedHtml).not.toContain(bobConfirmWords.slice(0, 3).join(" "));
    // No single attribute value may carry a cluster of them. One ordinary word
    // in a class name is a coincidence; three of these eight is the list.
    const clustered = maskedAttrs.filter((value) => {
      const tokens = new Set(value.toLowerCase().split(/[^a-z]+/));
      return bobConfirmWords.filter((w) => tokens.has(w)).length >= 3;
    });
    expect(clustered, `attributes leaked the confirmation words: ${clustered.join(" | ")}`).toEqual([]);

    // NOW Alice reveals hers, and they match.
    await a.getByRole("button", { name: "I heard their words" }).click();
    await expect(a.locator(".words .word-w").first()).toBeVisible();
    expect(await wordsOn(a)).toEqual(bobConfirmWords);
    await a.getByRole("button", { name: "Their words matched" }).click();
    await expect(a.getByText("Done. The other person can add the pad.")).toBeVisible();

    // Bob accepts, and lands on the ordinary pad screen.
    await b.getByRole("button", { name: "The words matched" }).click();
    await expect(b.getByRole("button", { name: "Send message" })).toBeVisible();

    // THE PROOF: ordinary messages, both directions, over the delivered pad.
    await a.goto("/");
    await a.getByText("Chat with Bob").click();
    await a.getByRole("button", { name: "Send message" }).click();
    await a.locator("textarea").fill("delivered by sealed transfer");
    await a.getByRole("button", { name: "Encrypt message" }).click();
    const envelope = ((await a.locator(".codeblock").first().textContent()) ?? "").trim();
    expect(envelope).toMatch(/^TP2:/);

    await b.getByRole("button", { name: "Open message" }).click();
    await b.locator("textarea").fill(envelope);
    await b.getByRole("button", { name: "Open message" }).last().click();
    await expect(b.getByText("delivered by sealed transfer")).toBeVisible();

    // ...and back the other way.
    await b.goto("/");
    await b.getByText("Received pad").click();
    await b.getByRole("button", { name: "Send message" }).click();
    await b.locator("textarea").fill("and the reverse direction");
    await b.getByRole("button", { name: "Encrypt message" }).click();
    const back = ((await b.locator(".codeblock").first().textContent()) ?? "").trim();

    await a.goto("/");
    await a.getByText("Chat with Bob").click();
    await a.getByRole("button", { name: "Open message" }).click();
    await a.locator("textarea").fill(back);
    await a.getByRole("button", { name: "Open message" }).last().click();
    await expect(a.getByText("and the reverse direction")).toBeVisible();

    await alice.close();
    await bob.close();
  });

  test("the recipient rejecting a mismatch is terminal", async ({ browser }) => {
    const { alice, bob, a, b, path } = await sealedUpTo(browser);

    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();
    await b.getByRole("button", { name: "They did not match" }).click();
    await expect(b.getByRole("heading", { name: "This transfer was rejected" })).toBeVisible();
    await expect(b.getByText("This receive code cannot be used again.")).toBeVisible();

    // No pad was added, and the same file cannot be opened again.
    await b.goto("/");
    await expect(b.getByText("Received pad")).toHaveCount(0);
    await b.goto("/#/receive-online");
    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByText("This receive code was cancelled. Create a new one.")).toBeVisible();

    await alice.close();
    await bob.close();
    void a;
  });

  test("closing for now changes nothing, and the file opens again", async ({ browser }) => {
    const { alice, bob, a, b, path } = await sealedUpTo(browser);

    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();
    await b.getByRole("button", { name: "Close for now" }).click();
    await expect(b.getByRole("heading", { name: "Receive a pad" })).toBeVisible();

    // No pad, no rejection — the request is simply still waiting.
    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();

    await alice.close();
    await bob.close();
    void a;
  });

  test("navigating away releases the session lock", async ({ browser }) => {
    const { alice, bob, a, b, path } = await sealedUpTo(browser);

    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();

    // Leave WITHOUT deciding — the case that would otherwise strand the
    // cross-tab lock, since ordinary in-app navigation does not kill the worker.
    await b.goto("/#/");
    await expect(b.getByRole("button", { name: "Create a pad" })).toBeVisible();

    // A SECOND TAB in the same browser can now open the same package. If the
    // lock had leaked, this would refuse as busy.
    const b2 = await bob.newPage();
    await b2.goto("/#/receive-online");
    await b2.locator("#sealed-file").setInputFiles(path);
    await expect(b2.getByRole("heading", { name: "Check the sender" })).toBeVisible();
    await b2.close();

    await alice.close();
    await bob.close();
    void a;
  });

  test("a second tab is refused while the first holds the session", async ({ browser }) => {
    const { alice, bob, a, b, path } = await sealedUpTo(browser);

    await b.locator("#sealed-file").setInputFiles(path);
    await expect(b.getByRole("heading", { name: "Check the sender" })).toBeVisible();

    const b2 = await bob.newPage();
    await b2.goto("/#/receive-online");
    await b2.locator("#sealed-file").setInputFiles(path);
    await expect(b2.getByText("This transfer is already open in another TruePad tab.")).toBeVisible();
    await b2.close();

    await alice.close();
    await bob.close();
    void a;
  });

  test("re-sharing returns the SAME sealed pad, and says so", async ({ browser }) => {
    const { alice, bob, a, pairName, code, path } = await sealedUpTo(browser);
    const first = readFileSync(path);

    // Alice comes back later — the download failed, or she needs to send it
    // again — and walks the same flow with the same receive code.
    await a.goto("/");
    await a.getByText(pairName).click();
    await a.getByText("Pad details").click();
    await a.getByRole("button", { name: "Send securely online" }).click();
    await a.locator("#paste-code").fill(code);
    await a.getByRole("button", { name: "Continue" }).click();
    await a.getByRole("button", { name: "The words matched" }).click();
    const again = a.waitForEvent("download");
    await a.getByRole("button", { name: "Seal pad" }).click();

    // Not "sealed again" — the SAME artifact, and the screen says so rather
    // than implying fresh cryptography happened.
    await expect(a.getByText("This is the same sealed pad as before")).toBeVisible();
    await a.getByRole("button", { name: "Save sealed pad" }).click();
    const second = readFileSync((await (await again).path()) ?? "");
    expect(second.equals(first)).toBe(true);

    await alice.close();
    await bob.close();
  });

  test("a sealed pad refuses a SECOND person's receive code, and makes no second package", async ({ browser }) => {
    const { alice, bob, a, pairName } = await sealedUpTo(browser);

    // A third person asks for a pad, and Alice tries to answer with the pad she
    // already sent to Bob. Coming back to the screen cold shows the paste card
    // again — the UI cannot ask "is this sealed?" without a code — so the
    // refusal has to be the engine's, on the code actually pasted.
    const carol = await browser.newContext();
    const c = await carol.newPage();
    const { code: carolCode } = await createReceiveCode(c);

    await a.goto("/");
    await a.getByText(pairName).click();
    await a.getByText("Pad details").click();
    await a.getByRole("button", { name: "Send securely online" }).click();
    await a.locator("#paste-code").fill(carolCode);
    await a.getByRole("button", { name: "Continue" }).click();
    await a.getByRole("button", { name: "The words matched" }).click();
    await a.getByRole("button", { name: "Seal pad" }).click();

    await expect(a.getByText("This pad was already sent online. Use one delivery method for each pad.")).toBeVisible();
    // No second package: the sealed screen is never reached, and nothing is
    // offered to save.
    await expect(a.getByRole("heading", { name: "Send the sealed pad" })).toHaveCount(0);
    await expect(a.getByRole("button", { name: "Save sealed pad" })).toHaveCount(0);

    // Carol's code was never consumed — it is still hers to use with a real pad.
    await expect(c.getByRole("button", { name: "Choose sealed pad" })).toBeVisible();
    await expect(c.getByText(/expired|cancelled|already been used/i)).toHaveCount(0);

    await carol.close();
    await alice.close();
    await bob.close();
  });

  test("the saved file IS the blob the page made, with nothing added to it", async ({ browser }) => {
    // §59. The download path must be a pipe, not a formatter. So intercept the
    // Blob the page actually constructs and compare it with the bytes that
    // reached disk — a text conversion, a BOM, a trailing newline or a MIME
    // wrapper would all show up as a difference here rather than having to be
    // inferred from "well, the recipient opened it".
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const a = await alice.newPage();
    const b = await bob.newPage();

    // Same reason as above: `URL.createObjectURL` and `Blob` are DOM globals
    // this config does not declare, so the wrapper is written structurally.
    await a.addInitScript(() => {
      type BlobLike = { arrayBuffer(): Promise<ArrayBuffer> };
      const g = globalThis as unknown as {
        __blobs: number[][];
        URL: { createObjectURL(obj: unknown): string };
      };
      g.__blobs = [];
      const real = g.URL.createObjectURL.bind(g.URL);
      g.URL.createObjectURL = (obj: unknown): string => {
        const maybe = obj as Partial<BlobLike>;
        if (typeof maybe?.arrayBuffer === "function") {
          void (obj as BlobLike).arrayBuffer().then((buf) => {
            g.__blobs.push([...new Uint8Array(buf)]);
          });
        }
        return real(obj);
      };
    });

    const { code } = await createReceiveCode(b);
    await createPad(a, "Chat with Bob");
    await a.getByRole("button", { name: "Send securely online" }).first().click();
    await a.locator("#paste-code").fill(code);
    await a.getByRole("button", { name: "Continue" }).click();
    await a.getByRole("button", { name: "The words matched" }).click();
    const downloadPromise = a.waitForEvent("download");
    await a.getByRole("button", { name: "Seal pad" }).click();
    await a.getByRole("button", { name: "Save sealed pad" }).click();
    const path = (await downloadPromise).path();
    const onDisk = readFileSync((await path) ?? "");

    await a.waitForFunction(() => (globalThis as unknown as { __blobs: number[][] }).__blobs.length > 0);
    const blobs = await a.evaluate(() => (globalThis as unknown as { __blobs: number[][] }).__blobs);
    expect(blobs, "the page made exactly one blob for one save").toHaveLength(1);
    const inPage = Buffer.from(blobs[0]);

    expect(onDisk.length).toBe(inPage.length);
    expect(onDisk.equals(inPage), "the saved file differs from the blob the page built").toBe(true);

    // And the bytes are a bare TPS2 package: the magic is the FIRST byte, so
    // nothing was prepended, and the length is the protocol's, so nothing was
    // appended.
    expect([...onDisk.subarray(0, 4)]).toEqual([...TPS2_MAGIC_BYTES]);
    expect(onDisk.length).toBeGreaterThan(TPS2_FIXED_OVERHEAD_BYTES);
    expect(onDisk[0], "no UTF-8 BOM").not.toBe(0xef);
    expect(onDisk[onDisk.length - 1], "no trailing newline").not.toBe(0x0a);
    expect(onDisk.subarray(0, 64).toString("latin1")).not.toMatch(/Content-Type|base64|application\//);

    await alice.close();
    await bob.close();
  });

  test("the copied receive code decodes to the same request the screen shows", async ({ browser }) => {
    // §60. The clipboard is the only place this string is handled by a human,
    // so what the button puts there must be the code and nothing else — no
    // label, no code fence, no stray newline — and must still parse as the
    // canonical request body on the other side.
    const bob = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const b = await bob.newPage();
    const { code } = await createReceiveCode(b);

    await b.getByRole("button", { name: "Copy receive code" }).click();
    const copied = await b.evaluate(() =>
      (globalThis.navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText()
    );

    expect(copied).toBe(code);
    expect(copied).toBe(copied.trim());
    expect(copied).not.toContain("\n");
    expect(copied).not.toContain("`");
    expect(copied).toMatch(/^TPR2:[A-Za-z0-9_-]+$/);
    expect(copied).toHaveLength(1652);

    // The real decoder, not a regex that looks like one.
    const decoded = decodeReceiveRequest(copied);
    expect(decoded.ok, `decodeReceiveRequest refused the copied text: ${JSON.stringify(decoded)}`).toBe(true);
    if (!decoded.ok) throw new Error("unreachable");
    // The canonical 1235-byte body, re-parsed by the single binary authority.
    const parsed = parseRequestBody(decoded.canonicalBody);
    expect(parsed.ok, `parseRequestBody refused the copied body: ${JSON.stringify(parsed)}`).toBe(true);
    expect(decoded.canonicalBody).toHaveLength(1235);

    // Re-decoding what the SCREEN shows gives the identical canonical body, so
    // the clipboard round trip changed nothing the protocol can see.
    const fromScreen = decodeReceiveRequest(code);
    expect(fromScreen.ok).toBe(true);
    if (!fromScreen.ok) throw new Error("unreachable");
    expect(Buffer.from(decoded.canonicalBody).equals(Buffer.from(fromScreen.canonicalBody))).toBe(true);
    expect(Buffer.from(decoded.request.requestId).equals(Buffer.from(fromScreen.request.requestId))).toBe(true);

    await bob.close();
  });

  test("cross-mode: a pad sent online cannot also be saved as a file", async ({ browser }) => {
    const { alice, bob, a, pairName } = await sealedUpTo(browser);
    await a.goto("/");
    await a.getByText(pairName).click();
    await a.getByText("Pad details").click();
    await a.getByRole("button", { name: "Save pad file" }).click();
    await expect(a.getByText(/already sent online|one delivery method/i)).toBeVisible();
    await alice.close();
    await bob.close();
  });
});

/** Everything up to "Alice has saved the sealed file", shared by the specs that
 *  test what happens next. */
async function sealedUpTo(browser: import("@playwright/test").Browser): Promise<{
  alice: BrowserContext;
  bob: BrowserContext;
  a: Page;
  b: Page;
  path: string;
  pairName: string;
  code: string;
}> {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();
  const pairName = "Chat with Bob";

  const { code } = await createReceiveCode(b);

  await createPad(a, pairName);
  await a.getByRole("button", { name: "Send securely online" }).first().click();
  await a.locator("#paste-code").fill(code);
  await a.getByRole("button", { name: "Continue" }).click();
  await a.getByRole("button", { name: "The words matched" }).click();
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "Seal pad" }).click();
  await a.getByRole("button", { name: "Save sealed pad" }).click();
  const download = await downloadPromise;
  const path = (await download.path()) ?? "";
  return { alice, bob, a, b, path, pairName, code };
}
