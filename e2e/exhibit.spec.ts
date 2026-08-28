import { expect, test, type Page } from "@playwright/test";
import { EXHAUSTED_MESSAGE } from "../src/core/meter.ts";

/* ============================================================================
 * The exhibit, driven for real, against the BUILT bundle (vite preview of
 * dist/, the thing that deploys). Covered here: stations 1–4 and 6 as a
 * visitor would click through them. Not covered here: station 5 (crib drag)
 * and the forged-startOffset burn-forward, which the unit suites pin.
 * Selectors are the element ids that src/exhibit/main.ts reads, so a
 * renamed id fails here before it ships.
 * ========================================================================= */

async function generate(page: Page, mode: "letters" | "bytes", size: number): Promise<void> {
  await page.selectOption("#pad-mode", mode);
  await page.fill("#pad-size", String(size));
  await page.click("#pad-generate");
  await expect(page.locator("#pad-label")).toHaveText(/^PAD-[A-Z]{4}-AB$/);
}

test.beforeEach(async ({ page }) => {
  // The exhibit now lives at /learn (index.html is the Browser Edition).
  await page.goto("/learn.html");
});

test("the full path against the built dist: generate → encrypt → decrypt → verdict shows COMBINER and SOURCE", async ({ page }) => {
  await generate(page, "letters", 64);
  await page.fill("#plaintext", "Meet me at noon");
  await page.click("#encrypt");
  await expect(page.locator("#wire")).toBeVisible();
  await page.click("#take-wire");
  await page.click("#decrypt");
  await expect(page.locator("#recovered-text")).toHaveText("MEETM EATNO ON");
  const card = page.locator("#verdict-pad");
  await expect(card).toContainText("combiner: true one-time pad ✓");
  await expect(card).toContainText("Combiner: unconditional");
  await expect(card).toContainText("Source: computational — bounded by the platform DRBG state");
  // The ledger and the receiver both moved: 12 symbols burned on each side.
  await expect(page.locator("#pad-summary")).toContainText("52 surviving");
  await expect(page.locator("#receiver-remaining")).toHaveText("52");
});

test("generate → encrypt → take from the wire → decrypt, then a replay is refused", async ({ page }) => {
  await generate(page, "letters", 64);

  await page.fill("#plaintext", "Attack at dawn");
  await expect(page.locator("#meter-status")).toContainText("Sending burns 12 symbols");
  await page.click("#encrypt");

  const wire = page.locator("#wire");
  await expect(wire).toBeVisible();
  await expect(page.locator("#wire-offsets")).toContainText("0 – 11 (12 symbols, gone forever)");
  const envelopeText = await page.locator("#wire-envelope").textContent();
  const envelope = JSON.parse(envelopeText ?? "null");
  expect(envelope).toMatchObject({ startOffset: 0, consumed: 12 });
  expect(envelope.label).toMatch(/^PAD-[A-Z]{4}-AB$/);
  expect(envelope.payload).toMatch(/^[A-Z]{12}$/);
  // The pad grid shows the burn: the first twelve cells are struck.
  await expect(page.locator("#pad-grid .cell.burned")).toHaveCount(12);
  await expect(page.locator("#ledger-spent")).toContainText("56.4 bits");

  await page.click("#take-wire");
  await expect(page.locator("#ciphertext-in")).toHaveValue(envelopeText ?? "");
  await page.click("#decrypt");
  await expect(page.locator("#recovered")).toBeVisible();
  await expect(page.locator("#recovered-text")).toHaveText("ATTAC KATDA WN");
  await expect(page.locator("#receiver-remaining")).toHaveText("52");

  // Replay: the same envelope again lands in the existing refusal element.
  await page.click("#decrypt");
  const refusal = page.locator("#receive-refusal");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("Reuse refused");
  await expect(refusal).toContainText("Nothing was burned");
  await expect(page.locator("#receiver-remaining")).toHaveText("52");
});

test("a dropped message is seeked past; the copy burns what it skipped", async ({ page }) => {
  await generate(page, "letters", 64);
  await page.fill("#plaintext", "FIRST");
  await page.click("#encrypt");
  await page.fill("#plaintext", "SECOND");
  await page.click("#encrypt");
  await page.fill("#plaintext", "THIRD");
  await page.click("#encrypt");
  // Only the third envelope reaches the receiver.
  await page.click("#take-wire");
  await page.click("#decrypt");
  await expect(page.locator("#recovered-text")).toHaveText("THIRD");
  // 5 + 6 skipped, 5 opened: 64 - 16.
  await expect(page.locator("#receiver-remaining")).toHaveText("48");
});

test("pasting something that is not an envelope is refused without burning", async ({ page }) => {
  await generate(page, "letters", 32);
  await page.fill("#ciphertext-in", "HELLO WORLD");
  await page.click("#decrypt");
  await expect(page.locator("#receive-refusal")).toContainText("Not a wire envelope");
  await expect(page.locator("#receiver-remaining")).toHaveText("32");
});

test("the verdict card shows the combiner line AND the source line", async ({ page }) => {
  await generate(page, "letters", 64);
  await page.fill("#plaintext", "HELLO");
  const card = page.locator("#verdict-pad");
  await expect(card).toContainText("combiner: true one-time pad ✓");
  await expect(card).toContainText("Combiner: unconditional");
  await expect(card).toContainText("Source: computational — bounded by the platform DRBG state");
  await expect(card).not.toContainText("information-theoretic");
  const deck = page.locator("#verdict-deck");
  await expect(deck).toContainText("combiner: not a one-time pad ✗");
  await expect(deck).toContainText("Source: not graded");
});

test("the meter locks with the exhibit's exact copy when the message exceeds the pad, and encrypt refuses", async ({ page }) => {
  await generate(page, "letters", 16);
  await page.fill("#plaintext", "A".repeat(17));
  await expect(page.locator("#meter-status")).toContainText(EXHAUSTED_MESSAGE);
  await expect(page.locator("#meter-status")).toContainText("short by 1 symbols");
  await page.click("#encrypt");
  await expect(page.locator("#refusal")).toBeVisible();
  await expect(page.locator("#refusal")).toContainText("cannot borrow, wrap, or reuse");
  await expect(page.locator("#pad-grid .cell.burned")).toHaveCount(0);
});

test("byte mode round-trips through the hex wire form", async ({ page }) => {
  await generate(page, "bytes", 32);
  await page.fill("#plaintext", "hi ✓");
  await page.click("#encrypt");
  const envelope = JSON.parse((await page.locator("#wire-envelope").textContent()) ?? "null");
  expect(envelope.consumed).toBe(6); // "hi ✓" is 6 UTF-8 bytes
  expect(envelope.payload).toMatch(/^[0-9A-F]{12}$/);
  await page.click("#take-wire");
  await page.click("#decrypt");
  await expect(page.locator("#recovered-text")).toHaveText("hi ✓");
});

test("station 6: forging TEN → SIX changes exactly three letters and raises no alarm", async ({ page }) => {
  await expect(page.locator("#tamper-plain")).toHaveText("PAYBOBTENDOLLARSNOW");
  await page.click("#tamper-forge");
  await expect(page.locator("#tamper-plain")).toHaveText("PAYBOBSIXDOLLARSNOW");
  await expect(page.locator("#tamper-plain mark")).toHaveCount(3);
  await expect(page.locator("#tamper-verdict")).toContainText("No alarm was raised");
  await page.click("#tamper-reset");
  await expect(page.locator("#tamper-plain")).toHaveText("PAYBOBTENDOLLARSNOW");
});
