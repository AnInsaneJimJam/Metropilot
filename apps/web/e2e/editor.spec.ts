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

test("threshold preset: edit, see an error, fix it, rehearse one crossing", async ({
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

  // Rapid edit + revert must revalidate rather than leave the editor stuck in Checking.
  const initialThreshold = page.getByRole("textbox", {
    name: "when price crosses above",
    exact: true,
  });
  await tabTo(page, initialThreshold);
  await replaceText(page, "2400");
  await replaceText(page, "2500");
  await expect(status).toContainText("Ready");
  await expect(hash).toHaveText(original);

  // Change the threshold through the outline form. 0 is refused with its reason and 2500 is kept.
  const outline = page.locator("ul.outline");
  await tabTo(
    page,
    outline.getByRole("button", { name: /^when price crosses above/ }),
  );
  await page.keyboard.press("Enter");
  const threshold = page.getByRole("textbox", {
    name: "when price crosses above",
  });
  await tabTo(page, threshold);
  await replaceText(page, "0");
  await expect(page.getByRole("alert")).toContainText(
    "Price must be positive.",
  );
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await expect(hash).toHaveText(original);

  // A valid threshold changes the strategy, so the hash updates.
  await replaceText(page, "2400");
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

  // Back to 2500: the same blocks give the same hash as the preset.
  await tabTo(
    page,
    outline.getByRole("button", { name: /^when price crosses above/ }),
  );
  await page.keyboard.press("Enter");
  await tabTo(page, threshold);
  await replaceText(page, "2500");
  await expect(hash).toHaveText(original);

  // Rehearse "crosses once": 2499 → 2501 → 2502 fires exactly once.
  await tabTo(
    page,
    page.getByRole("button", { name: "02 Rehearse", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Scenario")).toHaveValue("crossesOnce");
  await tabTo(page, page.getByRole("button", { name: "Skip to end" }));
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    page.locator("summary").filter({ hasText: "Inspect the execution trace" }),
  );
  await page.keyboard.press("Enter");
  const log = page.getByRole("list", { name: "Rehearsal log" });
  await expect(log).toContainText("TWAP 2499 recorded as the baseline");
  await expect(log.locator("li.event-fire")).toHaveCount(1);
  await expect(log.locator("li.event-fire")).toContainText("crossed 2500");
  await expect(log).toContainText("Run completed: 1 trade");
  await expect(page.getByLabel("Synthetic feed")).toContainText("2502");
  await expect(
    page.getByText("Synthetic rehearsal — not a paper or live fill"),
  ).toBeVisible();
});
