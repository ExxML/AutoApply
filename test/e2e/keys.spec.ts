import { FAILURES } from "../mockGemini";
import { nextMidnightPacific } from "../../src/shared/time";
import type { KeyState } from "../../src/shared/types";
import { BASE, expect, fillPage, seed, storage, test, waitDone } from "./extension";

const MODEL = "gemini-2.5-flash-lite";
const keyState = (sw: import("@playwright/test").Worker) =>
  storage<Record<string, KeyState>>(sw, "keyState").then((s) => s ?? {});

async function openAiSettings(page: import("@playwright/test").Page, sw: import("@playwright/test").Worker) {
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/ai`);
}

test("429 per-minute: the next key is used automatically and the chip shows the cooldown", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { caps: true });
  mock.fail("test-key-1", FAILURES.perMinute);
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#spons")).toHaveValue("I will not require sponsorship");
  const maps = mock.calls.filter((c) => c.kind === "map");
  expect(maps.map((c) => [c.key, c.status])).toEqual([
    ["test-key-1", 429],
    ["test-key-2", 200],
  ]);
  // keyState is persisted at most every 500 ms.
  await expect.poll(async () => (await keyState(sw)).k1?.cooldownUntil ?? 0).toBeGreaterThan(Date.now() + 20_000);
  await openAiSettings(page, sw);
  await expect(page.locator("tr", { hasText: "Key 1" }).locator(".chip")).toHaveText(/^Cooling down until/);
  await expect(page.locator("tr", { hasText: "Key 2" }).locator(".chip")).toHaveText("Healthy");
});

test("429 daily: the key is exhausted for that model until the next Pacific midnight", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  mock.fail("test-key-1", FAILURES.daily);
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect.poll(async () => (await keyState(sw)).k1?.perModel?.[MODEL]?.exhaustedUntil).toBeTruthy();
  const until = (await keyState(sw)).k1.perModel![MODEL].exhaustedUntil!;
  expect(until).toBe(nextMidnightPacific(until - 1));
  expect(Math.abs(until - nextMidnightPacific())).toBeLessThan(60_000);
  await openAiSettings(page, sw);
  await expect(page.locator("tr", { hasText: "Key 1" }).locator(".chip")).toHaveText(
    `Daily quota used for ${MODEL} until 00:00 PT`,
  );
});

test("invalid key and limit:0 rotate; 503 is retried without penalizing keys", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  mock.fail("test-key-1", FAILURES.invalidKey);
  mock.fail("test-key-2", FAILURES.limitZero);
  mock.fail("test-key-3", FAILURES.unavailable);
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#gender")).toHaveValue("I don't wish to answer");
  await expect.poll(async () => !!(await keyState(sw)).k3?.successCount).toBe(true);
  const ks = await keyState(sw);
  expect(ks.k1.invalid).toBeTruthy();
  expect(ks.k2.perModel![MODEL].unavailableUntil).toBeGreaterThan(Date.now());
  expect(ks.k3.invalid).toBeFalsy();
  expect(ks.k3.cooldownUntil).toBeFalsy();
  await openAiSettings(page, sw);
  await expect(page.locator("tr", { hasText: "Key 1" }).locator(".chip")).toHaveText("Invalid key");
  await expect(page.locator("tr", { hasText: "Key 2" }).locator(".chip")).toHaveText("Model unavailable on this key");
});

test("all keys exhausted for the primary model → the fallback model is used", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true, fallbackModel: "gemini-2.5-flash" });
  mock.always = (_k, model) => (model === MODEL ? FAILURES.daily : null);
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#spons")).toHaveValue("I will not require sponsorship");
  const ok = mock.calls_("map");
  expect(ok).toHaveLength(1);
  expect(ok[0].model).toBe("gemini-2.5-flash");
  await expect(page.locator("autoapply-root .panel")).toContainText("Model: gemini-2.5-flash");
});

test("all keys exhausted and no fallback → clear overlay error with the reset time and Retry", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { caps: true });
  mock.always = () => FAILURES.perMinute;
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toContainText(
    /All API keys are rate-limited for gemini-2\.5-flash-lite\. Next retry possible at \d/,
  );
  await expect(page.locator("autoapply-root .panel .error button", { hasText: "Retry" })).toBeVisible();
  await expect(page.locator("autoapply-root .needs")).toContainText("Gender");
});
