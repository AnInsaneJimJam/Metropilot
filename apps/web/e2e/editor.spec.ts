import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// G2 browser check, keyboard only: no clicks, no pointer. Every control is reached by Tab (or Shift+Tab).

const MAX_TABS = 300;

/** Tabs forward until the target has focus, proving it is reachable by keyboard. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < MAX_TABS; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Not reachable by Tab: ${target.toString()}`);
}

async function replaceText(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("native threshold preset: edit, fix errors and explain unavailable playback", async ({
  page,
}) => {
  await page.goto("/");
  const status = page
    .getByRole("region", { name: "Strategy checks" })
    .getByRole("status");
  const hash = page.locator("code.hash");

  // The reviewed threshold pattern is the first draft. Open diagnostic disclosures by keyboard.
  await tabTo(page, page.getByText("Compiler details", { exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByText("Browse all rules", { exact: true }));
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Ready");
  const original = (await hash.textContent())!;
  expect(original).toMatch(/^0x[0-9a-f]{64}$/);

  const outline = page.locator("ul.outline");
  await tabTo(
    page,
    outline.getByRole("button", { name: /^when price crosses below/ }),
  );
  await page.keyboard.press("Enter");

  // Rapid edit + revert must revalidate rather than leave the editor stuck in Checking.
  const initialThreshold = page.getByRole("textbox", {
    name: "when price crosses below",
    exact: true,
  });
  await tabTo(page, initialThreshold);
  await replaceText(page, "0.024");
  await replaceText(page, "0.025");
  await expect(status).toContainText("Ready");
  await expect(hash).toHaveText(original);

  // Change the threshold through the outline form. 0 is refused with its reason and the last valid price is kept.
  await tabTo(
    page,
    outline.getByRole("button", { name: /^when price crosses below/ }),
  );
  await page.keyboard.press("Enter");
  const threshold = page.getByRole("textbox", {
    name: "when price crosses below",
  });
  await tabTo(page, threshold);
  await replaceText(page, "0");
  await expect(page.getByRole("alert")).toContainText(
    "Price must be positive.",
  );
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await expect(hash).toHaveText(original);

  // A valid threshold changes the strategy, so the hash updates.
  await replaceText(page, "0.024");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(hash).not.toHaveText(original);
  await expect(hash).toHaveText(/^0x[0-9a-f]{64}$/);

  // Slippage over the rookie limit compiles but is listed as a problem.
  await tabTo(page, outline.getByRole("button", { name: /^swap/ }));
  await page.keyboard.press("Enter");
  const slippage = page.getByRole("textbox", { name: "max slippage" });
  await tabTo(page, slippage);
  await replaceText(page, "80");
  await expect(status).toContainText("1 problem");
  const problem = page.locator(".problems").getByRole("button", { name: /50/ });
  await expect(problem).toBeVisible();

  // The problem link is focusable and moves focus into the offending block's form; fix it there.
  await tabTo(page, problem);
  await page.keyboard.press("Enter");
  await expect(slippage).toBeFocused();
  await replaceText(page, "50");
  await expect(status).toContainText("Ready");

  // Back to 0.025: the same blocks give the same hash as the preset.
  await tabTo(
    page,
    outline.getByRole("button", { name: /^when price crosses below/ }),
  );
  await page.keyboard.press("Enter");
  await tabTo(page, threshold);
  await replaceText(page, "0.025");
  await expect(hash).toHaveText(original);

  // Native oracle methods have no synthetic scenario playback; the view explains the limitation.
  await tabTo(page,page.getByRole("button",{name:"02 Rehearse",exact:true}));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading",{name:"Native market observations."})).toBeVisible();
  await expect(page.getByText(/Scenario playback for these oracle methods is not available yet/)).toBeVisible();
  await expect(page.getByText(/Uniswap’s 30-second geometric TWAP, Curve’s native EMA, and Aave’s native USD prices/)).toBeVisible();
  await expect(page.getByLabel("Scenario")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Skip to end"})).toHaveCount(0);
  await expect(page.getByLabel("Synthetic feed")).toHaveCount(0);
});
