import { expect, test, type Page } from "@playwright/test";

/* ============================================================================
 * TruePad 2 Browser Edition — the SIMPLIFIED product, driven for real against
 * the BUILT bundle (vite preview of dist/) in a real Chromium with real OPFS.
 * The frozen v2 engine is unchanged; these specs exercise the redesigned,
 * task-oriented UI from the perspective of someone who just wants to send a
 * message: create a pad, share it, send, open — with plain buttons and no
 * security jargon required to get through.
 * ========================================================================= */

// Create a pad with the simple flow: name it, keep the defaults (small, for a
// fast test), press Create. Returns nothing — the pad screen is next.
async function createPad(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a pad" }).click();
  await expect(page.getByRole("heading", { name: "Create a pad" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill(name);
  await page.getByText("Small", { exact: true }).click(); // keep the test pad tiny
  await page.getByRole("button", { name: "Create pad" }).click();
  await expect(page.getByText("Pad created")).toBeVisible();
}

async function sendMessage(page: Page, message: string): Promise<string> {
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Send message" })).toBeVisible();
  await page.locator("textarea").fill(message);
  await page.getByRole("button", { name: "Encrypt message" }).click();
  await expect(page.getByText("Encrypted message ready")).toBeVisible();
  // What a normal person is handed is the compact spelling — TP2:…, not 200
  // characters of JSON. The canonical JSON is the same envelope and is still
  // there, one disclosure down, for anyone who wants it.
  const envelope = (await page.locator(".codeblock").first().textContent())?.trim() ?? "";
  expect(envelope).toMatch(/^TP2:[A-Za-z0-9_-]+$/);
  expect(envelope).not.toContain('"formatVersion":2');
  return envelope;
}

// The same message in TruePad's technical form, from under Details.
async function canonicalJsonOf(page: Page): Promise<string> {
  await page.getByText("Details", { exact: true }).click();
  await page.locator("summary").filter({ hasText: "Canonical JSON" }).click();
  const json = (await page.locator(".codeblock").nth(1).textContent())?.trim() ?? "";
  expect(json).toContain('"formatVersion":2');
  return json;
}

test("a non-technical happy path: create → save pad → send → import → open", async ({ browser }, testInfo) => {
  // --- Alice: create a pad in her own browser context (its own OPFS) ---
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await createPad(alice, "Chat with Bob");

  // Save the pad file for the other person (a real download).
  const padPath = testInfo.outputPath("shared.pad");
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByRole("button", { name: "Save pad for other person" }).click()
  ]);
  await download.saveAs(padPath);

  // Start using it, and send a message — no role choice, no jargon.
  await alice.getByRole("button", { name: "Start using TruePad" }).click();
  await expect(alice.getByRole("heading", { name: "Chat with Bob" })).toBeVisible();
  const message = "meet me at the cafe at noon";
  const envelope = await sendMessage(alice, message);

  // --- Bob: a second, isolated context adds the shared pad ---
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto("/");
  await bob.getByRole("button", { name: "Add a shared pad" }).click();
  await expect(bob.getByRole("heading", { name: "Add a shared pad" })).toBeVisible();
  await bob.getByPlaceholder("e.g. Chat with Sam").fill("Chat with Alice");
  await bob.locator('input[type="file"]').setInputFiles(padPath);
  await bob.getByRole("button", { name: "Add pad" }).click();

  // Bob lands on the pad screen and opens the message.
  await expect(bob.getByRole("heading", { name: "Chat with Alice" })).toBeVisible();
  await bob.getByRole("button", { name: "Open message" }).click();
  await expect(bob.getByRole("heading", { name: "Open message" })).toBeVisible();
  await bob.locator("textarea").fill(envelope);
  await bob.getByRole("button", { name: "Open message" }).click();
  await expect(bob.getByRole("heading", { name: "Message", exact: true })).toBeVisible();
  await expect(bob.getByText(message)).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

test("a message this pad cannot open is refused in plain language, with detail tucked away", async ({ page }) => {
  await createPad(page, "Solo pad");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  const envelope = await sendMessage(page, "attack at dawn");

  // Trying to open your OWN sent message is refused: it is addressed to the
  // other person, not to you (you are the sender on this pad). The user sees one
  // plain sentence; the typed reason is only under Details, not shouted.
  await page.getByRole("button", { name: "Back to pad" }).click();
  await page.getByRole("button", { name: "Open message" }).click();
  await page.locator("textarea").fill(envelope);
  await page.getByRole("button", { name: "Open message" }).click();
  await expect(page.getByText("This message could not be verified")).toBeVisible();
  await expect(page.locator(".message-body")).toHaveCount(0); // no plaintext shown
  await page.locator("details.quiet-details > summary").click();
  await expect(page.getByText(/wrong-direction/)).toBeVisible();
});

test("disabling a pad is a single clear confirmation, and then it refuses use", async ({ page }) => {
  await createPad(page, "Throwaway");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await page.getByText("Disable this pad").click();
  await expect(page.getByRole("heading", { name: /Disable ".*"\?/ })).toBeVisible();
  await page.getByText("I understand this cannot be undone.").click();
  await page.getByRole("button", { name: "Disable this pad" }).click();
  // Disabling lands on the disabled-pad screen itself: the honest statement,
  // and the two things left to do with a dead pad.
  await expect(page.getByText("This pad has been permanently disabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a new pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove from TruePad" })).toBeVisible();
});

test("the operational UI refuses to run inside a frame (and never starts the worker there)", async ({ page }) => {
  await page.route("**/host-embed.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><iframe title="embedded-truepad" src="/" style="width:900px;height:700px;border:0"></iframe></body></html>`
    })
  );
  await page.goto("/host-embed.html");
  const framed = page.frameLocator('iframe[title="embedded-truepad"]');
  await expect(framed.getByText("TruePad will not run inside a frame")).toBeVisible();
  await expect(framed.getByRole("button", { name: "Create a pad" })).toHaveCount(0);
});

test("compact transport: TP2 is what you copy, canonical JSON is one disclosure down, both open", async ({ browser }, testInfo) => {
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await createPad(alice, "Compact chat");

  const padPath = testInfo.outputPath("compact.pad");
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByRole("button", { name: "Save pad for other person" }).click()
  ]);
  await download.saveAs(padPath);
  await alice.getByRole("button", { name: "Start using TruePad" }).click();

  // Normal UX: the short form, and no JSON in sight.
  const compact = await sendMessage(alice, "compact please");
  expect(compact.length).toBeLessThan(120);

  // Advanced: the SAME envelope in technical form, available but secondary.
  const json = await canonicalJsonOf(alice);
  expect(json).toContain('"direction":"A->B"');
  await expect(alice.getByText(/same encrypted message in TruePad's technical JSON form/)).toBeVisible();
  // ...and the compact form is never framed as the weaker one.
  await expect(alice.locator("body")).not.toContainText("more secure");
  await expect(alice.locator("body")).not.toContainText("compressed");

  // Bob imports the pad and opens the COMPACT message — no mode selector.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto("/");
  await bob.getByRole("button", { name: "Add a shared pad" }).click();
  await bob.getByPlaceholder("e.g. Chat with Sam").fill("Compact chat");
  await bob.locator('input[type="file"]').setInputFiles(padPath);
  await bob.getByRole("button", { name: "Add pad" }).click();
  await expect(bob.getByRole("heading", { name: "Compact chat" })).toBeVisible();

  await bob.getByRole("button", { name: "Open message" }).click();
  await bob.locator("textarea").fill(compact);
  await bob.getByRole("button", { name: "Open message" }).last().click();
  await expect(bob.getByText("compact please")).toBeVisible();

  // A second message, opened from its canonical JSON, on the same pad.
  await alice.getByRole("button", { name: "Back to pad" }).click();
  const compact2 = await sendMessage(alice, "json please");
  const json2 = await canonicalJsonOf(alice);
  expect(compact2.startsWith("TP2:")).toBe(true);
  await bob.getByRole("button", { name: "Back to pad" }).click();
  await bob.getByRole("button", { name: "Open message" }).first().click();
  await bob.locator("textarea").fill(json2);
  await bob.getByRole("button", { name: "Open message" }).last().click();
  await expect(bob.getByText("json please")).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});
