import { expect, test, type Page } from "@playwright/test";

/* ============================================================================
 * TruePad 2 Browser Edition — the True OTP source ceremony, in the real app
 * ----------------------------------------------------------------------------
 * The unit suite (tests/source-claim.test.ts) pins the combiner and the exact
 * claim strings. These specs pin what a person actually MEETS:
 *
 *   · a beginner who never opens Advanced sees the same short flow as before,
 *     and nothing on it reads as verified physical randomness;
 *   · the expert path exists under Advanced options → Randomness, states the
 *     combiner, and says outright that TruePad cannot determine whether a file
 *     is truly random;
 *   · Create stays disabled until the operator DECLARES — the checkbox is a
 *     declaration, and it gates creation;
 *   · every external source must independently carry the full L bytes;
 *   · the created pad's claim distinguishes the two classes, carries the §7
 *     verdict verbatim on the external path, and stays conditional;
 *   · pad delivery separates physical handoff from a computationally secure
 *     transfer.
 * ========================================================================= */

const VERDICT = "Uniform if at least one declared source was uniform and independent of the others.";
const CANNOT_VERIFY = "TruePad cannot determine whether a file is truly random.";
const DECLARATION =
  "I understand that TruePad cannot verify physical randomness. For an information-theoretic one-time-pad claim, " +
  "at least one selected source must actually be uniformly random, secret, independent of the other combined " +
  "sources, and never previously used.";

// Small on purpose: L = 2*(16384 + 32*64) = 36,864 bytes, so a source file is
// cheap to build in the test and the real length check still runs for real.
const SMALL_L = 2 * (16384 + 32 * 64);

// A deterministic buffer. Content is irrelevant to acceptance by design — that
// is the point being pinned — so a ramp is as valid a source as noise.
function ramp(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed + i * 7) & 0xff;
  return out;
}

async function openCreate(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create a pad" }).click();
  await expect(page.getByRole("heading", { name: "Create a pad" })).toBeVisible();
  await page.getByPlaceholder("e.g. Chat with Sam").fill(name);
  await page.getByText("Small", { exact: true }).click();
}

// A forbidden phrase is only a problem when it is ASSERTED. "TruePad does not
// call this physically proven randomness" is the claim discipline working, so
// the scan is sentence-scoped: a hit must sit in a sentence that also negates.
const NEGATION = /\bnever\b|\bnot\b|\bno\b|\bcannot\b|\bcan't\b|\bwithout\b|\bonly if\b/i;

const OVERCLAIMS = [
  /truly random\b/i,
  /true random(ness)?\b/i,
  /verified true/i,
  /physically proven/i,
  /physical(ly)? random/i,
  /information-theoretically verified/i,
  /perfect secrecy achieved/i,
  /true otp verified/i,
  /information-theoretic security confirmed/i
];

// What the user can actually READ: innerText excludes collapsed <details>.
async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText();
}

function assertedOverclaims(text: string): string[] {
  const offending: string[] = [];
  for (const sentence of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
    if (OVERCLAIMS.some((p) => p.test(sentence)) && !NEGATION.test(sentence)) offending.push(sentence.trim());
  }
  return offending;
}

async function openRandomness(page: Page): Promise<void> {
  await page.getByRole("group").filter({ hasText: "Advanced options" }).locator("summary").first().click();
  await expect(page.getByText("Use external random material")).toBeVisible();
}

/* ---- 21, 22, 2: the beginner never meets any of this --------------------- */

test("a beginner who never opens Advanced sees the simple flow, and no verified-randomness claim", async ({ page }) => {
  await openCreate(page, "Ordinary pad");

  // Level 1 is still Name / Capacity / Create pad. The ceremony is not on it.
  await expect(page.getByText("Name this pad")).toBeVisible();
  await expect(page.getByText("How much capacity?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create pad" })).toBeEnabled();
  await expect(page.getByText(CANNOT_VERIFY)).toHaveCount(0);
  await expect(page.getByText(DECLARATION)).toHaveCount(0);
  await expect(page.getByText("True OTP ceremony")).toHaveCount(0);

  await page.getByRole("button", { name: "Create pad" }).click();
  await expect(page.getByText("Pad created")).toBeVisible();

  // 2 + 16: on the screen as it lands — Details still collapsed — the device
  // path makes no randomness claim of any kind, and the external path's
  // verdict is nowhere near it.
  const landed = await visibleText(page);
  for (const overclaim of OVERCLAIMS) {
    expect(landed, `the created screen must not read as ${overclaim}`).not.toMatch(overclaim);
  }
  expect(landed).not.toContain(VERDICT);

  // The claim itself lives under Details, where it is exact — and where the
  // only mention of a physical claim is TruePad refusing to make one.
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText("Device-generated")).toBeVisible();
  await expect(page.getByText("crypto.getRandomValues")).toBeVisible();
  await expect(page.getByText(/computational and platform assumptions/)).toBeVisible();
  await expect(page.getByText(/does not call this physically proven randomness/)).toBeVisible();
  expect(assertedOverclaims(await visibleText(page)), "Details must not ASSERT a physical claim").toEqual([]);

  // 20: the essential delivery warning is on both paths.
  await expect(page.getByText("The pad file is the secret")).toBeVisible();
  await expect(page.getByText(/never email, upload, or sync it/)).toBeVisible();

  // 22: no jargon leaked onto Home.
  await page.goto("/");
  for (const jargon of ["XOR", "entropy", "CSPRNG", "information-theoretic", "pair", "courier", "Wegman"]) {
    await expect(page.locator("body")).not.toContainText(jargon);
  }
});

/* ---- 3, 4, 5, 18: the expert ceremony and its gates --------------------- */

test("the external ceremony states the combiner, refuses to verify, and gates on the declaration", async ({ page }, testInfo) => {
  await openCreate(page, "Ceremony pad");
  await openRandomness(page);

  // The two source classes, worded as the claim ledger words them.
  await expect(page.getByText("TruePad uses your device's cryptographic random generator.")).toBeVisible();
  await page.getByText("Use external random material").click();

  // 18: the expert disclosure — combiner exact, then the load-bearing sentence.
  await expect(page.getByText("True OTP ceremony")).toBeVisible();
  await expect(page.getByText("TruePad combines every selected source byte-for-byte using XOR.")).toBeVisible();
  await expect(
    page.getByText("If at least one source is actually uniform and independent of the others, the combined material is uniform.")
  ).toBeVisible();
  await expect(page.getByText(CANNOT_VERIFY)).toBeVisible();
  await expect(page.getByText(/must also be secret/)).toBeVisible();
  // The length rule: complete cover per source, never concatenation.
  await expect(page.getByText(/never concatenated and never split between them/)).toBeVisible();
  // The aliasing limitation is stated rather than invented around.
  await expect(page.getByText(/will not inspect your source bytes/)).toBeVisible();

  // 3: at least one source is required before Create is possible.
  const createBtn = page.getByRole("button", { name: "Create pad" });
  await expect(createBtn).toBeDisabled();
  await expect(page.getByText("Add at least one random file.")).toBeVisible();

  // 4: a source shorter than L is refused, and named as too small.
  const shortPath = testInfo.outputPath("short.bin");
  const fullPath = testInfo.outputPath("full.bin");
  const surplusPath = testInfo.outputPath("surplus.bin");
  const fs = await import("node:fs/promises");
  await fs.writeFile(shortPath, ramp(SMALL_L - 1, 3));
  await fs.writeFile(fullPath, ramp(SMALL_L, 11));
  await fs.writeFile(surplusPath, ramp(SMALL_L + 4096, 29));

  await page.locator('input[type="file"]').setInputFiles(shortPath);
  await expect(page.getByText("too small", { exact: true })).toBeVisible();
  await expect(createBtn).toBeDisabled();
  await expect(page.getByText(/“short.bin” is too small for this size/)).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();

  // 7: a source with surplus beyond L is fine — the surplus is simply unused.
  await page.locator('input[type="file"]').setInputFiles([fullPath, surplusPath]);
  await expect(page.locator(".source-row")).toHaveCount(2);
  await expect(page.locator(".sr-size.bad")).toHaveCount(0);

  // Each source needs its operator origin note.
  const origins = page.locator(".source-row input[type='text']");
  await origins.nth(0).fill("dice, hand-rolled, operator asserted");
  await expect(createBtn).toBeDisabled();
  await origins.nth(1).fill("hardware noise source, operator asserted");

  // 5, 19: still disabled — the declaration is required, and it is a
  // DECLARATION, not something TruePad computed.
  await expect(createBtn).toBeDisabled();
  await expect(page.getByText("Confirm the source declaration to continue.")).toBeVisible();
  await expect(page.getByText(DECLARATION)).toBeVisible();
  await page.getByText(DECLARATION).click();
  await expect(createBtn).toBeEnabled();

  // Un-declaring disables it again: the gate is real, not decorative.
  await page.getByText(DECLARATION).click();
  await expect(createBtn).toBeDisabled();
  await page.getByText(DECLARATION).click();
  await expect(createBtn).toBeEnabled();

  await createBtn.click();
  await expect(page.getByText("Pad created")).toBeVisible();

  // 17: the §7 verdict, verbatim, and the claim stays CONDITIONAL.
  await expect(page.getByText("External material — operator declared")).toBeVisible();
  await expect(page.getByText(VERDICT, { exact: true })).toBeVisible();
  await expect(page.getByText("TruePad did not verify that assumption.")).toBeVisible();
  await expect(
    page.getByText(/^If that source assumption is true, the pad material satisfies the information-theoretic/)
  ).toBeVisible();

  // Never the unconditional forms — and nothing on the ceremony's own result
  // screen asserts a physical claim TruePad did not, and could not, establish.
  expect(assertedOverclaims(await visibleText(page)), "the ceremony result must stay conditional").toEqual([]);

  // 7 again, from the product's own manifest: surplus reported, not spent.
  await expect(page.getByText(`${SMALL_L.toLocaleString("en-US")} bytes supplied, 0 unused`, { exact: false })).toBeVisible();
  await expect(page.getByText("4,096 unused", { exact: false })).toBeVisible();

  // 20: the delivery ceremony, and what is a DIFFERENT claim rather than a
  // weaker form of the same one.
  await expect(page.getByText("The pad file is the secret")).toBeVisible();
  await expect(page.getByText(/Physical handoff on removable media is the clearest ceremony/)).toBeVisible();
  await expect(page.getByText(/do not preserve that claim/)).toBeVisible();
  await expect(page.getByText(/different guarantee, not a weaker form of this one/)).toBeVisible();

  // 15: and the pad works — a ceremony pad is an ordinary pad.
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator("textarea").fill("made from declared material");
  await page.getByRole("button", { name: "Encrypt message" }).click();
  await expect(page.getByText("Encrypted message ready")).toBeVisible();
});

/* ---- 6, 8, 9: content never conditions acceptance, end to end ----------- */

test("two byte-identical sources are accepted, and the all-zero pad they make works", async ({ page }, testInfo) => {
  await openCreate(page, "Zero pad");
  await openRandomness(page);
  await page.getByText("Use external random material").click();

  // The same bytes under two names. Their XOR is all zeros — a legitimate draw
  // from the uniform distribution. Refusing it, or refusing them for being
  // equal, would condition the accepted distribution.
  const fs = await import("node:fs/promises");
  const bytes = ramp(SMALL_L, 5);
  const one = testInfo.outputPath("one.bin");
  const two = testInfo.outputPath("two.bin");
  await fs.writeFile(one, bytes);
  await fs.writeFile(two, bytes);

  await page.locator('input[type="file"]').setInputFiles([one, two]);
  await expect(page.locator(".source-row")).toHaveCount(2);
  const origins = page.locator(".source-row input[type='text']");
  await origins.nth(0).fill("operator asserted A");
  await origins.nth(1).fill("operator asserted B");
  await page.getByText(DECLARATION).click();

  await page.getByRole("button", { name: "Create pad" }).click();
  // No refusal, no warning about duplicates, no entropy complaint.
  await expect(page.getByText("Pad created")).toBeVisible();
  await expect(page.getByText(VERDICT, { exact: true })).toBeVisible();

  // And it is a working pad.
  await page.getByRole("button", { name: "Start using TruePad" }).click();
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator("textarea").fill("an all-zero pad is still a pad");
  await page.getByRole("button", { name: "Encrypt message" }).click();
  await expect(page.getByText("Encrypted message ready")).toBeVisible();
});

/* ---- the Security screen keeps the two claims apart --------------------- */

test("Security states both source classes and their independence from the platform claim", async ({ page }) => {
  await page.goto("/#/advanced");
  await page.getByText("Source — declared, not verified").click();

  await expect(page.getByText(/Device-generated material is computational/)).toBeVisible();
  await expect(page.getByText(/External material is eligible, not established/)).toBeVisible();
  await expect(page.getByText(CANNOT_VERIFY)).toBeVisible();
  await expect(page.getByText(/no key derivation, no extractor, no hash conditioner/i)).toBeVisible();
  await expect(page.getByText(/The source claim and the platform claim are independent/)).toBeVisible();
  await expect(page.getByText(/Delivery is the other half/)).toBeVisible();
});
