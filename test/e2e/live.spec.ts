// §20.3 live smoke test against the real Gemini API (no mock). Skipped unless GEMINI_API_KEY is set.
// GEMINI_MODEL picks the model; by default the first flash-lite model of the sorted live list is used.
import { BASE, expect, seed, test, waitDone } from "./extension";

const KEY = process.env.GEMINI_API_KEY;
test.use({ useMock: false });
test.skip(!KEY, "Set GEMINI_API_KEY to run the live smoke test");
test.describe.configure({ mode: "serial", timeout: 120_000 });

async function setup(page: import("@playwright/test").Page, sw: import("@playwright/test").Worker) {
  await seed(sw, { apiKey: KEY, selectedModel: process.env.GEMINI_MODEL ?? null });
  // Fetch the live model list through the extension (sets the default flash-lite model when none is chosen).
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/ai`);
  const r = await page.evaluate(() => chrome.runtime.sendMessage({ type: "REFRESH_MODELS", force: true }));
  expect(r).toEqual({ ok: true });
  const model = await sw.evaluate(async () => (await chrome.storage.local.get("selectedModel")).selectedModel);
  console.log(`live model: ${model}`);
  expect(model).toBeTruthy();
}

test("live: semantic selections by meaning (§21 item 6)", async ({ page, sw }) => {
  await setup(page, sw);
  await page.goto(BASE + "semantic.html");
  await waitDone(page);
  await expect(page.getByLabel("I am willing to relocate", { exact: true })).toBeChecked();
  await expect(page.locator("#spons")).toHaveValue("I will not require sponsorship");
  await expect(page.locator("#gender")).toHaveValue("I don't wish to answer");
});

test("live: plain form", async ({ page, sw }) => {
  await setup(page, sw);
  await page.goto(BASE + "plain.html");
  await waitDone(page);
  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#prov")).toHaveValue("BC");
  await expect(page.locator("input[name=auth][value=yes]")).toBeChecked();
  await expect(page.locator("#why")).not.toHaveValue("");
  expect((await page.locator("#why").inputValue()).split(/\s+/).length).toBeLessThanOrEqual(120);
  await expect(page.locator("#privacy")).not.toBeChecked();
});
