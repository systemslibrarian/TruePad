import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";

/* ============================================================================
 * QR transport, in a real browser
 * ----------------------------------------------------------------------------
 * QR is convenience for the PUBLIC receive code. The assertions that matter:
 *
 *   · the receiver's "Show QR code" renders a symbol that decodes to EXACTLY
 *     the receive code text, and the twelve words stay on screen;
 *   · a scanned code (driven here through the image-file fallback, which needs
 *     no camera) enters the SAME flow as paste — twelve words, and NO
 *     auto-confirm: sealing still waits for "The words matched";
 *   · paste still works, and the sealed pad is still a FILE, never a QR;
 *   · the sender's eight words remain absent from the DOM until the reveal —
 *     QR changes none of that.
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

async function createReceiveCode(page: Page): Promise<{ code: string; words: string[] }> {
  await page.goto("/#/import");
  await page.getByText("Receive securely online").click();
  await page.getByRole("button", { name: "Create receive code" }).click();
  await expect(page.locator("#receive-code")).toBeVisible();
  const code = await page.locator("#receive-code").inputValue();
  return { code, words: await page.locator(".words .word-w").allTextContents() };
}

/** Rasterise a receive code to a QR GIF file, the way a received screenshot
 *  would look. Written to a temp path for setInputFiles. */
function writeQrImage(code: string): string {
  const qr = qrcode(0, "M");
  qr.addData(code, "Byte");
  qr.make();
  const dataUrl = qr.createDataURL(6, 4); // GIF data URL, 6px modules, quiet zone 4
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const dir = mkdtempSync(join(tmpdir(), "truepad-qr-"));
  const path = join(dir, "receive-code.gif");
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

test.describe("QR transport", () => {
  test("receiver Show QR renders the same receive code, and the twelve words stay", async ({ browser }) => {
    const bob = await browser.newContext();
    const b = await bob.newPage();
    const { code } = await createReceiveCode(b);
    expect(code).toHaveLength(1652);

    // The text path is unchanged and still primary.
    await expect(b.getByRole("button", { name: "Copy receive code" })).toBeVisible();

    await b.getByRole("button", { name: "Show QR code" }).click();
    await expect(b.locator(".qr-svg")).toBeVisible();

    // Rasterise the rendered SVG in the page, then decode the pixels here. The
    // DOM is reached through `globalThis` so the spec typechecks under the Node
    // lib (no DOM globals), matching the existing sealed-transfer spec.
    const px = await b.evaluate(async () => {
      const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown> & { document: any };
      const svg = g.document.querySelector(".qr-svg");
      const modules = Number(svg.getAttribute("width")); // 1 unit per module + quiet zone
      const scale = 5;
      const side = modules * scale;
      const xml = new (g.XMLSerializer as unknown as { new (): { serializeToString(n: unknown): string } })().serializeToString(svg);
      const url = "data:image/svg+xml;base64," + (g.btoa as (s: string) => string)(unescape(encodeURIComponent(xml)));
      const img = new (g.Image as unknown as { new (): any })();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      const canvas = g.document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, side, side);
      ctx.drawImage(img, 0, 0, side, side);
      const data = ctx.getImageData(0, 0, side, side);
      return { data: Array.from(data.data) as number[], width: data.width as number, height: data.height as number };
    });
    const decoded = jsQR(Uint8ClampedArray.from(px.data), px.width, px.height);
    expect(decoded?.data).toBe(code);

    // The twelve comparison words are still present — QR did not replace them.
    expect(await b.locator(".words .word-w").count()).toBe(12);
    await bob.close();
  });

  test("a scanned (image) code enters the same flow as paste, with no auto-confirm", async ({ browser }) => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const a = await alice.newPage();
    const b = await bob.newPage();

    const { code, words: bobWords } = await createReceiveCode(b);
    const imagePath = writeQrImage(code);

    await createPad(a, "Chat with Bob");
    await a.getByRole("button", { name: "Send securely online" }).first().click();
    await expect(a.getByRole("heading", { name: "Send pad securely online" })).toBeVisible();

    // Paste stays available; scanning is an alternative.
    await expect(a.locator("#paste-code")).toBeVisible();
    await expect(a.getByRole("button", { name: "Scan QR code" })).toBeVisible();

    // Feed the QR image through the "Choose QR image" fallback (no camera).
    await a.locator(".qr-scan input[type=file]").setInputFiles(imagePath);

    // It converged on the SAME twelve-word screen the paste path reaches.
    await expect(a.locator(".words .word-w").first()).toBeVisible();
    expect(await a.locator(".words .word-w").allTextContents()).toEqual(bobWords);

    // NO auto-confirm: sealing is not offered until the operator confirms.
    await expect(a.getByRole("button", { name: "Seal pad" })).toHaveCount(0);
    await a.getByRole("button", { name: "The words matched" }).click();
    await expect(a.getByRole("button", { name: "Seal pad" })).toBeVisible();

    await alice.close();
    await bob.close();
  });

  test("the sealed pad is still a file, and the sender's eight words stay masked", async ({ browser }) => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const a = await alice.newPage();
    const b = await bob.newPage();

    const { code } = await createReceiveCode(b);

    await createPad(a, "Chat with Bob");
    await a.getByRole("button", { name: "Send securely online" }).first().click();
    await a.locator("#paste-code").fill(code);
    await a.getByRole("button", { name: "Continue" }).click();
    await a.getByRole("button", { name: "The words matched" }).click();

    const downloadPromise = a.waitForEvent("download");
    await a.getByRole("button", { name: "Seal pad" }).click();
    await expect(a.getByRole("heading", { name: "Send the sealed pad" })).toBeVisible();

    // The sealed package is offered as a FILE. There is no QR of it anywhere.
    await expect(a.getByRole("button", { name: "Save sealed pad" })).toBeVisible();
    expect(await a.locator(".qr-svg").count()).toBe(0);
    // Sender's eight words are ABSENT from the DOM before the reveal.
    expect(await a.locator(".words .word-w").count()).toBe(0);

    await a.getByRole("button", { name: "Save sealed pad" }).click();
    const download = await downloadPromise;
    expect(await download.path()).toBeTruthy();

    await alice.close();
    await bob.close();
  });
});
