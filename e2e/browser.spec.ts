import { expect, test, type Page } from "@playwright/test";

/* ============================================================================
 * TruePad 2 Browser Edition, driven for real against the BUILT bundle
 * (vite preview of dist/, the thing that deploys) in a real Chromium with real
 * OPFS. The engine runs in its dedicated Web Worker and its Origin Private File
 * System store, exactly as it ships; nothing here reaches into the worker.
 *
 * Two proofs:
 *   1. A genuine courier round trip across TWO isolated OPFS stores (two
 *      browser contexts = two independent origins-worth of storage): Alice
 *      generates a pair, exports the couriered pad, sends an authenticated
 *      message; Bob imports the couriered pad into his own store and opens the
 *      envelope to the exact plaintext; then Bob destroys the pair and it
 *      refuses reuse.
 *   2. The one-time discipline in a single store: a burned record cannot be
 *      reopened even in the same copy — the same-store courier caveat — with
 *      the exact security-consequence copy asserted visible.
 *
 * OPFS work is asynchronous; every assertion below is a Playwright
 * auto-retrying `expect`, so the specs wait for the worker rather than racing
 * it. Selectors are the operator-visible text and roles src/browser/ui builds,
 * so a renamed action or lost consequence line fails here before it ships.
 * ========================================================================= */

const DESTROY_LIMITATION =
  "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

// Generate a pad from the browser DRBG (no source file needed), with no
// rollback witness (keeps the round trip free of any witness-store dependency),
// then open its dashboard and return the pair id.
async function generateDrbgPair(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create pair" }).first().click();
  await expect(page.getByRole("heading", { name: "Create a pair" })).toBeVisible();

  await page.getByText("Browser DRBG (trial)").click();
  await page.getByText("No witness", { exact: true }).click();

  await page.getByRole("button", { name: "Generate pair" }).click();
  await expect(page.getByText("Pair generated", { exact: true })).toBeVisible();
}

async function openDashboardAfterGen(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Open dashboard" }).click();
  const idText = (await page.locator("p.lede.mono").first().textContent())?.trim() ?? "";
  expect(idText).toMatch(/^[0-9a-f]{32}$/);
  return idText;
}

async function sendMessage(page: Page, message: string): Promise<string> {
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Encrypt & burn" })).toBeVisible();
  await page.getByRole("button", { name: "I am Alice (A)" }).click();
  await page.locator("textarea").fill(message);
  // The exact-cost consequence is shown before the commit.
  await expect(page.getByText("This will permanently consume, on send:")).toBeVisible();
  await page.getByRole("button", { name: "Encrypt & burn" }).click();
  await expect(page.getByText("Burned. Material consumed, envelope ready.")).toBeVisible();
  const envelope = (await page.locator(".codeblock").first().textContent())?.trim() ?? "";
  expect(envelope).toContain('"formatVersion":2');
  return envelope;
}

test("courier round trip across two isolated OPFS stores: create → send → import → open → destroy", async ({ browser }, testInfo) => {
  // --- Alice: her own browser context (its own OPFS store) ---
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await generateDrbgPair(alice);

  // Export the couriered pad BEFORE any traffic, and capture the download.
  await alice.getByRole("button", { name: "Prepare courier bundle" }).click();
  await expect(alice.getByText("This file IS the pad — treat it as the secret it is")).toBeVisible();
  const bundlePath = testInfo.outputPath("pair-bundle.pad.json");
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.getByRole("button", { name: "Save pad bundle" }).click()
  ]);
  await download.saveAs(bundlePath);

  const pairId = await openDashboardAfterGen(alice);

  const message = "attack at dawn — real OPFS round trip";
  const envelope = await sendMessage(alice, message);

  // --- Bob: a second, isolated browser context (a different OPFS store) ---
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto("/");
  await bob.getByRole("button", { name: "Create pair" }).first().click();
  await bob.getByRole("button", { name: "Import couriered pad" }).click();
  await bob.locator('input[type="file"]').setInputFiles(bundlePath);
  await expect(bob.getByText(/pair-bundle\.pad\.json/)).toBeVisible();
  await bob.getByRole("button", { name: "Import pad" }).click();

  // Bob lands on the imported pair's dashboard, same pair id.
  await expect(bob.locator("p.lede.mono").first()).toHaveText(pairId);

  // Bob opens the envelope as B (he receives A->B traffic) → exact plaintext.
  await bob.getByRole("button", { name: "Open received" }).click();
  await expect(bob.getByRole("heading", { name: "Verify & open" })).toBeVisible();
  await bob.getByRole("button", { name: "I am Bob (B)" }).click();
  await bob.locator("textarea").fill(envelope);
  await bob.getByRole("button", { name: "Verify & open" }).click();
  await expect(bob.getByText("Accepted — authenticated, then opened")).toBeVisible();
  await expect(bob.getByText(message)).toBeVisible();

  // Bob destroys the pair; it then refuses reuse.
  await bob.getByRole("button", { name: "Back to dashboard" }).click();
  await bob.getByRole("button", { name: "Destroy pair…" }).click();
  await expect(bob.getByRole("heading", { name: "Destroy this pair" })).toBeVisible();
  // The verbatim limitation is shown before the act.
  await expect(bob.getByText(DESTROY_LIMITATION).first()).toBeVisible();
  await bob.locator('input[type="text"]').first().fill(pairId);
  await bob.getByRole("button", { name: "Destroy this pair permanently" }).click();
  await expect(bob.getByText("Destroyed", { exact: true })).toBeVisible();
  await expect(bob.getByText(DESTROY_LIMITATION).first()).toBeVisible();

  // Reuse is refused: the pair now shows as destroyed and opens to a tombstone.
  await bob.getByRole("button", { name: "Back to all pairs" }).click();
  await bob.getByRole("button", { name: "View tombstone" }).click();
  await expect(bob.getByText("This pair has crossed the destruction boundary")).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

test("the operational UI refuses to run inside a frame (and never starts the worker there)", async ({ page }) => {
  // Serve a same-origin host page with NO CSP of its own that embeds the app at
  // "/". The app sets no HTTP frame-ancestors / X-Frame-Options header (GitHub
  // Pages cannot) and frame-ancestors is not enforceable from its meta CSP, so
  // the embed is not blocked at the transport layer — the runtime gate is what
  // must stop it. (This runs on a fresh context before any service worker is
  // registered, so the fulfilled host page is not intercepted.)
  await page.route("**/host-embed.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><iframe title="embedded-truepad" src="/" style="width:900px;height:700px;border:0"></iframe></body></html>`
    })
  );
  await page.goto("/host-embed.html");
  const framed = page.frameLocator('iframe[title="embedded-truepad"]');
  // The framed context shows the refusal instead of the operational UI…
  await expect(framed.getByText("TruePad will not run inside a frame")).toBeVisible();
  // …and the operational surface (the create action) never appears in the frame.
  await expect(framed.getByRole("button", { name: "Create pair" })).toHaveCount(0);
});

test("the same-store courier caveat: a burned record cannot be reopened in the same copy", async ({ page }) => {
  await generateDrbgPair(page);
  await openDashboardAfterGen(page);

  const envelope = await sendMessage(page, "attack at dawn");

  // Opening the just-burned A->B envelope in the SAME store (as B) is refused:
  // the burn self-retired sequence 0 here, so its material is gone.
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await page.getByRole("button", { name: "Open received" }).click();
  await page.getByRole("button", { name: "I am Bob (B)" }).click();
  await page.locator("textarea").fill(envelope);
  await page.getByRole("button", { name: "Verify & open" }).click();

  // The exact security-consequence copy is visible; no plaintext is shown.
  await expect(page.getByText("Sequence already retired")).toBeVisible();
  await expect(page.getByText("Loss is acceptable; reuse is not.")).toBeVisible();
});
