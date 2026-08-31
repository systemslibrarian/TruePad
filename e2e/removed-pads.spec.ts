import { expect, test, type Page } from "@playwright/test";

/* ============================================================================
 * TruePad 2 Browser Edition — Remove means gone, and gone means still dead
 * ----------------------------------------------------------------------------
 * "Remove from TruePad" is the product forgetting a pad: no list, no archive,
 * no "Show disabled pads", no count, no View, no old name anywhere, and an old
 * URL that resolves to a generic "Pad not found." These specs pin that — and,
 * just as importantly, pin that it is PRESENTATION ONLY. The destroyed.json
 * tombstone survives removal, the pair stays permanently unusable at the
 * engine level, and the old pad file is still refused on import. Starting over
 * means a NEW pad with a NEW pairId, never a resurrected one.
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
  await expect(page.getByText("This pad has been permanently disabled")).toBeVisible();
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

// The removed set is a UI preference, so a test may lift it to prove that what
// is behind it is still refused BY THE ENGINE and not merely hidden by the UI.
async function unsuppressForTest(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("truepad2:hidden-pads"));
}

test("removing a disabled pad erases it from the product and never revives it", async ({ page }, testInfo) => {
  // --- 1-2. create a pad and keep its pad file for the resurrection attempt -
  await createPad(page, "Doomed pad");
  const padPath = testInfo.outputPath("doomed.pad");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save pad file" }).click()
  ]);
  await download.saveAs(padPath);

  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await expect(page.getByRole("heading", { name: "Doomed pad" })).toBeVisible();
  const deadId = pairIdFromUrl(page);

  // --- 3. disable it: the disabled-pad screen, with the honest limitation ---
  await disableCurrentPad(page);
  await expect(
    page.getByText("Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a new pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove from TruePad" })).toBeVisible();
  // Nothing on this screen can be used to send or open anything.
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open message" })).toHaveCount(0);

  // --- 4. remove it --------------------------------------------------------
  await page.getByRole("button", { name: "Remove from TruePad" }).click();

  // --- 5-8. home is a pristine fresh install -------------------------------
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a pad" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a shared pad" })).toBeVisible();
  await expect(page.getByText("How does this work?")).toBeVisible();

  // 6. the old name appears nowhere on the page at all.
  await expect(page.getByText("Doomed pad")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Doomed pad");
  // 7-8. no archive, no disclosure, no count, no View, no dead rows.
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);
  await expect(page.getByText("Disabled")).toHaveCount(0);
  await expect(page.locator(".disabled-row")).toHaveCount(0);
  await expect(page.locator(".disabled-pads")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View" })).toHaveCount(0);
  await expect(page.locator(".pad-card")).toHaveCount(0);
  await expect(page.locator(".pad-list")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your pads" })).toHaveCount(0);

  // --- 9-10. the old route is generic: no name, no status, no history ------
  for (const route of [`/#/pair/${deadId}`, `/#/pair/${deadId}/send/message`, `/#/pair/${deadId}/destroy`]) {
    await page.goto(route);
    await expect(page.getByText("Pad not found.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to home" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Doomed pad");
    await expect(page.locator("body")).not.toContainText("Disabled");
    await expect(page.locator("body")).not.toContainText("permanently disabled");
    await expect(page.locator("body")).not.toContainText(deadId);
  }
  await page.getByRole("button", { name: "Back to home" }).click();
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();

  // --- 11. the old pad file is still refused: no resurrection --------------
  await page.getByRole("button", { name: "Add a shared pad" }).click();
  await expect(page.getByRole("heading", { name: "Add a shared pad" })).toBeVisible();
  await page.getByText("I have a pad file").click();
  await expect(page.getByRole("heading", { name: "Add a pad file" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill("Back from the dead");
  await page.locator('input[type="file"]').setInputFiles(padPath);
  await page.getByRole("button", { name: "Add pad" }).click();
  await expect(page.getByText("This pad file can't be added.")).toBeVisible();
  // The refusal is generic: it does not hand back the removed pad's history.
  await expect(page.locator("body")).not.toContainText("Doomed pad");
  // ...and no pad entry was recreated.
  await page.goto("/");
  await expect(page.locator(".pad-card")).toHaveCount(0);
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();

  // --- 12. the internal tombstone survived removal -------------------------
  expect(await tombstoneExists(page, deadId)).toBe(true);
  // Removal is a browser-product display preference — NOT store state.
  const removed = await page.evaluate(() => localStorage.getItem("truepad2:hidden-pads"));
  expect(removed).toContain(deadId);

  // --- 13. and underneath the UI, the engine still refuses the pair --------
  // Lifting the UI suppression proves the refusal is the ENGINE's, not the
  // "Pad not found" screen's: the pair is still dead on its own terms.
  await unsuppressForTest(page);
  await page.goto(`/#/pair/${deadId}/send/message`);
  await expect(page.getByText(/permanently unusable/)).toBeVisible();
  await page.goto(`/#/pair/${deadId}`);
  await expect(page.getByText("This pad has been permanently disabled")).toBeVisible();
  expect(await tombstoneExists(page, deadId)).toBe(true);
  // Put it back where the user left it: removed.
  await page.getByRole("button", { name: "Remove from TruePad" }).click();
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);

  // --- 14-15. starting over means a BRAND-NEW pad, and it works ------------
  await createPad(page, "Replacement pad");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await expect(page.getByRole("heading", { name: "Replacement pad" })).toBeVisible();
  const newId = pairIdFromUrl(page);
  expect(newId).not.toBe(deadId);

  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator("textarea").fill("starting over, properly");
  await page.getByRole("button", { name: "Encrypt message" }).click();
  await expect(page.getByText("Encrypted message ready")).toBeVisible();

  // The replacement is the only thing in the working list, and the removed pad
  // is nowhere underneath it.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your pads" })).toBeVisible();
  await expect(page.locator(".pad-card")).toHaveCount(1);
  await expect(page.locator(".pad-card").getByText("Replacement pad")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Doomed pad");
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);
});

test("with a usable pad alongside a removed one, the list holds only the usable pad", async ({ page }) => {
  await createPad(page, "Keeper");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  const keeperId = pairIdFromUrl(page);

  await createPad(page, "Casualty");
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  const deadId = pairIdFromUrl(page);
  await disableCurrentPad(page);
  await page.getByRole("button", { name: "Remove from TruePad" }).click();

  await expect(page.getByRole("heading", { name: "Your pads" })).toBeVisible();
  await expect(page.locator(".pad-card")).toHaveCount(1);
  await expect(page.locator(".pad-card").getByText("Keeper")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Casualty");
  await expect(page.getByText("Show disabled pads")).toHaveCount(0);

  // The removed one's route is generic; the kept one is untouched.
  await page.goto(`/#/pair/${deadId}`);
  await expect(page.getByText("Pad not found.")).toBeVisible();
  await page.goto(`/#/pair/${keeperId}`);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

/* ---- 16-18: the empty home is one centred column ------------------------- */

// Every landing element's horizontal midpoint must sit on the column's
// midpoint. Prose is measured by its rendered ink (a Range over the element's
// contents), because a full-width block that is merely text-align:center would
// pass a box-centre check while its text sat anywhere; real boxes — the button
// and the disclosure summary — are measured as boxes. A stray left-aligned
// block, which is what the old "Show disabled pads" disclosure was, fails this
// by a wide margin, so the tolerance can stay tight.
type Span = { x: number; width: number } | null;

async function inkSpans(page: Page, selectors: string[]): Promise<Span[]> {
  return page.evaluate((sels) => {
    // The spec typechecks under the Node lib (no DOM), so the document is
    // reached through a local structural type rather than lib.dom's globals.
    type Rect = { x: number; width: number };
    type El = { tagName: string; getBoundingClientRect(): Rect };
    const doc = (globalThis as unknown as {
      document: { querySelector(s: string): El | null; createRange(): { selectNodeContents(n: El): void; getBoundingClientRect(): Rect } };
    }).document;
    return sels.map((sel) => {
      const el = doc.querySelector(sel);
      if (!el) return null;
      // Buttons and the disclosure summary are boxes in their own right —
      // padding and the summary's chevron are part of what must be centred.
      if (el.tagName === "BUTTON" || el.tagName === "SUMMARY") {
        const b = el.getBoundingClientRect();
        return { x: b.x, width: b.width };
      }
      const range = doc.createRange();
      range.selectNodeContents(el);
      const b = range.getBoundingClientRect();
      return { x: b.x, width: b.width };
    });
  }, selectors);
}

// Wordmark, subtitle, Create a pad, the add-a-pad line, How does this work? —
// the whole of the empty home, in order.
const LANDING_PARTS = [
  ".screen.landing .wordmark",
  ".screen.landing .hero-sub",
  ".screen.landing .hero-cta .btn",
  ".screen.landing .hero-alt",
  ".screen.landing .quiet-details.how > summary"
];

async function expectCenteredLanding(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Private messages using a pad you share with one other person.")).toBeVisible();

  const screen = await page.locator(".screen.landing").boundingBox();
  expect(screen, "expected a landing screen").not.toBeNull();
  const axis = screen!.x + screen!.width / 2;

  const spans = await inkSpans(page, LANDING_PARTS);
  spans.forEach((span, i) => {
    expect(span, `expected ${LANDING_PARTS[i]} on the empty home`).not.toBeNull();
    expect(Math.abs(span!.x + span!.width / 2 - axis), `${LANDING_PARTS[i]} is off the centre line`).toBeLessThanOrEqual(2);
    // ...and nothing hangs outside the column it is supposed to sit inside.
    expect(span!.x, `${LANDING_PARTS[i]} overflows left`).toBeGreaterThanOrEqual(screen!.x - 1);
    expect(span!.x + span!.width, `${LANDING_PARTS[i]} overflows right`).toBeLessThanOrEqual(screen!.x + screen!.width + 1);
  });

  // The empty home carries nothing else: the landing screen holds exactly the
  // five things above, so nothing can be floating underneath them.
  await expect(page.locator(".screen.landing > *")).toHaveCount(4); // hero, cta, alt, how

  // The page itself must not scroll sideways at any of these widths.
  // The spec typechecks under the Node lib (no DOM), so the document is read
  // through a local structural type rather than lib.dom's globals.
  const overflows = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document;
    return doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1;
  });
  expect(overflows).toBe(false);
}

for (const [name, width, height] of [
  ["desktop", 1280, 900],
  ["430px", 430, 932],
  ["375px", 375, 812]
] as [string, number, number][]) {
  test(`the empty home is one centred column at ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await expectCenteredLanding(page);
  });
}
