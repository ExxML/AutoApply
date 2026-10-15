import { BASE, expect, fillPage, seed, test, waitDone } from "./extension";

// §21 item 1: the unpacked extension card in chrome://extensions (developer mode) shows no Errors button
// and no warnings, even after a full fill. Chrome only renders those elements when there is something to show.
test("dist/ loads in chrome://extensions without errors or warnings", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  const id = new URL(sw.url()).host;
  await page.goto("chrome://extensions/");
  await page.locator("#devMode").click();
  const card = page.locator(`extensions-item#${id}`);
  await expect(card.locator("#name")).toHaveText("AutoApply");
  await expect(card.locator("#dev-reload-button")).toBeVisible(); // developer-mode controls rendered
  await expect(card.locator("#errors-button")).toHaveCount(0);
  await expect(card.getByText(/warning|error/i)).toHaveCount(0);
});
