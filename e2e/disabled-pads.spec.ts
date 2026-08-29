import { expect, test, type Page } from "@playwright/test";

/* ============================================================================
 * TruePad 2 Browser Edition — disabled pads are out of the way, and stay dead
 * ----------------------------------------------------------------------------
 * A permanently disabled pad used to sit at the top of "Your pads" as a dead
 * entry you could open, be told off by, and do nothing about. These specs pin
 * the fix — and, just as importantly, pin that the fix is PRESENTATION ONLY:
 * the destroyed.json tombstone survives hiding, the pair stays unusable, and
 * the old pad file still cannot be imported back. Starting over means a NEW
 * pad with a NEW pairId, never a resurrected one.
 * ========================================================================= */

async function createPad(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a pad" }).click();
  await expect(page.getByRole("heading", { name: "Create a pad" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill(name);
  await page.getByText("Small", { exact: true }).click(); // keep the test pad tiny
  await page.getByRole("button", { name: "Create pad" }).click();
  await expect(page.getByText("Pad created")).toBeVisible();
}

// The pairId is in the route once the pad screen is open.
function pairIdFromUrl(page: Page): string {
  const m = /#\/pair\/([0-9a-f]{32})/.exec(page.url());
  expect(m, `expected a pair route, got ${page.url()}`).not.toBeNull();
  return m![1];
}

async function disableCurrentPad(page: Page): Promise<void> {
  await page.getByText("Disable this pad").click();
  await expect(page.getByRole("heading", { name: /Disable ".*"\?/ })).toBeVisible();
  await page.getByText("I understand this cannot be undone.").click();
  await page.getByRole("button", { name: "Disable this pad" }).click();
  await expect(page.getByText("Pad disabled")).toBeVisible();
}

// Ask the page — not the test — whether the store still carries the tombstone.
// This reads real OPFS in the real browser profile the app just wrote to.
async function tombstoneExists(page: Page, pairId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    // The spec typechecks under the Node lib (no DOM), so OPFS is reached
    // through a local structural type rather than lib.dom's handles.
    type Dir = { getDirectoryHandle(name: string): Promise<Dir>; getFileHandle(name: string): Promise<unknown> };
    const storage = (globalThis.navigator as unknown as { storage: { getDirectory(): Promise<Dir> } }).storage;
    try {
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle(id);
      await dir.getFileHandle("destroyed.json");
      return true;
    } catch {
      return false;
    }
  }, pairId);
}

test("a disabled pad leaves the working list, offers a fresh start, and hiding never revives it", async ({ page }, testInfo) => {
  // --- 1. create a pad, and keep its pad file for the resurrection attempt ---
  await createPad(page, "Doomed pad");
  const padPath = testInfo.outputPath("doomed.pad");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save pad for other person" }).click()
  ]);
  await download.saveAs(padPath);

  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await expect(page.getByRole("heading", { name: "Doomed pad" })).toBeVisible();
  const deadId = pairIdFromUrl(page);

  // --- 2. disable it -------------------------------------------------------
  await disableCurrentPad(page);
  await page.getByRole("button", { name: "Back to home" }).click();

  // --- 3. home no longer lists it among pads you can use -------------------
  await expect(page.getByRole("heading", { name: "Your pads" })).toHaveCount(0);
  await expect(page.locator(".pad-card")).toHaveCount(0);

  // --- 4. and the fresh-start path is the obvious thing on the screen ------
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a shared pad" })).toBeVisible();

  // The dead pad is still reachable, but only behind a quiet disclosure.
  await expect(page.locator(".pad-list")).toHaveCount(0);
  await page.getByText("Show disabled pads").click();
  const row = page.locator(".disabled-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Doomed pad")).toBeVisible();
  await expect(row.getByText("Disabled")).toBeVisible();
  await row.getByRole("button", { name: "View" }).click();

  // --- 5. the disabled screen: same honest statement, plus a way forward ---
  await expect(page.getByText("This pad has been permanently disabled")).toBeVisible();
  await expect(
    page.getByText("Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a new pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide this disabled pad" })).toBeVisible();
  // Nothing on this screen can be used to send or open anything.
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open message" })).toHaveCount(0);

  // --- 6. the engine still refuses it, however you get at it ---------------
  await page.goto(`/#/pair/${deadId}/send/message`);
  await expect(page.getByText("Cannot send")).toBeVisible();
  await expect(page.getByText(/permanently unusable/)).toBeVisible();

  // --- 7. hide it: gone from home, tombstone untouched ---------------------
  await page.goto(`/#/pair/${deadId}`);
  await page.getByRole("button", { name: "Hide this disabled pad" }).click();
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);
  await expect(page.locator(".pad-card")).toHaveCount(0);

  expect(await tombstoneExists(page, deadId)).toBe(true);
  // Hiding is a display preference in browser-product storage — NOT store state.
  const hidden = await page.evaluate(() => localStorage.getItem("truepad2:hidden-pads"));
  expect(hidden).toContain(deadId);

  // ...and the pair is still refused after hiding.
  await page.goto(`/#/pair/${deadId}/send/message`);
  await expect(page.getByText(/permanently unusable/)).toBeVisible();

  // --- 8. importing the old pad file back is refused: no resurrection ------
  await page.goto("/");
  await page.getByRole("button", { name: "Add a shared pad" }).click();
  await expect(page.getByRole("heading", { name: "Add a shared pad" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill("Back from the dead");
  await page.locator('input[type="file"]').setInputFiles(padPath);
  await page.getByRole("button", { name: "Add pad" }).click();
  await expect(page.getByText("Could not add this pad")).toBeVisible();
  await expect(page.getByText(/permanently unusable/)).toBeVisible();
  expect(await tombstoneExists(page, deadId)).toBe(true);

  // --- 9. starting over means a BRAND-NEW pad: new id, and it works --------
  await createPad(page, "Replacement pad");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await expect(page.getByRole("heading", { name: "Replacement pad" })).toBeVisible();
  const newId = pairIdFromUrl(page);
  expect(newId).not.toBe(deadId);

  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator("textarea").fill("starting over, properly");
  await page.getByRole("button", { name: "Encrypt message" }).click();
  await expect(page.getByText("Encrypted message ready")).toBeVisible();

  // The replacement is the only thing in the working list, and the dead pad
  // stays hidden underneath it.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your pads" })).toBeVisible();
  await expect(page.locator(".pad-card")).toHaveCount(1);
  await expect(page.locator(".pad-card").getByText("Replacement pad")).toBeVisible();
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);
});

test("with a usable pad alongside a disabled one, the list holds only the usable pad", async ({ page }) => {
  await createPad(page, "Keeper");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  const keeperId = pairIdFromUrl(page);

  await createPad(page, "Casualty");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  const deadId = pairIdFromUrl(page);
  await disableCurrentPad(page);
  await page.getByRole("button", { name: "Back to home" }).click();

  await expect(page.getByRole("heading", { name: "Your pads" })).toBeVisible();
  await expect(page.locator(".pad-card")).toHaveCount(1);
  await expect(page.locator(".pad-card").getByText("Keeper")).toBeVisible();
  await expect(page.locator(".pad-card").getByText("Casualty")).toHaveCount(0);

  // The dead one is only under the quiet disclosure, never mixed in above.
  await page.getByText("Show disabled pads").click();
  await expect(page.locator(".disabled-row").getByText("Casualty")).toBeVisible();

  // Hiding the dead pad changes nothing about the usable one.
  await page.goto(`/#/pair/${deadId}`);
  await page.getByRole("button", { name: "Hide this disabled pad" }).click();
  await expect(page.locator(".pad-card")).toHaveCount(1);
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);
  await page.goto(`/#/pair/${keeperId}`);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});
