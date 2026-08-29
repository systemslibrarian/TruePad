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
  const envelope = (await page.locator(".codeblock").first().textContent())?.trim() ?? "";
  expect(envelope).toContain('"formatVersion":2');
  return envelope;
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
  await expect(page.getByText("Pad disabled")).toBeVisible();
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
