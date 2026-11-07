import type { Page, Worker } from "@playwright/test";
import { ApplicationSchema, QueueItemSchema, type QueueItem } from "../../src/shared/yolo";
import { expect, seed, storage, test } from "./extension";

async function applicationsPage(sw: Worker, page: Page, count = 90, queued = 45) {
  await seed(sw);
  const applications = Array.from({ length: count }, (_, i) =>
    ApplicationSchema.parse({
      key: `history-${i}`,
      url: `https://example.com/history/${i}`,
      company: `History company ${i}`,
      title: "Engineer",
      source: "Lever",
      status: i % 2 ? "failed" : "submitted",
      at: Date.now() - i * 60_000,
    }),
  );
  const yoloQueue = Array.from({ length: queued }, (_, i) =>
    QueueItemSchema.parse({
      key: `queued-${i}`,
      url: `https://example.com/queued/${i}`,
      company: `Queue company ${i}`,
      title: `Queue role ${i}`,
      source: i % 2 ? "Greenhouse" : "Lever",
      location: i === 1 ? "Montréal" : "Remote",
    }),
  );
  await sw.evaluate(async (values) => chrome.storage.local.set(values), { applications, yoloQueue });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/applications`);
  await expect(page.getByRole("button", { name: `Queued jobs ${queued}`, exact: true })).toBeVisible();
  return yoloQueue;
}

test("application totals separate outcomes, ignore filters, and refresh at local midnight", async ({ sw, page }) => {
  const day = new Date(2026, 10, 7).getTime();
  const tomorrow = new Date(2026, 10, 8).getTime();
  await page.clock.install({ time: new Date(day + 12 * 60 * 60_000) });
  await applicationsPage(sw, page, 0, 0);
  const applications = [
    { key: "submitted", status: "submitted", at: day },
    { key: "manual", status: "submitted", at: day + 1, mode: "manual" },
    { key: "failed", status: "failed", at: day + 2 },
    { key: "review", status: "review", at: day + 3 },
    { key: "needs", status: "needs", at: day + 4 },
    { key: "skipped", status: "skipped", at: day + 5 },
    { key: "yesterday-submitted", status: "submitted", at: day - 1 },
    { key: "yesterday-failed", status: "failed", at: day - 2 },
    { key: "yesterday-skipped", status: "skipped", at: day - 3 },
  ].map((app) => ApplicationSchema.parse({ ...app, url: `https://example.com/${app.key}`, company: app.key }));
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), applications);
  const summary = page.getByRole("definition").locator("..");
  const today = summary.filter({ has: page.getByText("Today", { exact: true }) }).first();
  const allTime = summary.filter({ has: page.getByText("All time", { exact: true }) }).first();
  await expect(today).toContainText("2 submitted / 5 attempted");
  await expect(today).toContainText("1 failed · 2 pending");
  await expect(allTime).toContainText("3 submitted / 7 attempted");
  await expect(allTime).toContainText("2 failed · 2 pending");

  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("no match");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  await expect(page.getByText("No matches.", { exact: true })).toBeVisible();
  await expect(today).toContainText("2 submitted / 5 attempted");
  await expect(allTime).toContainText("3 submitted / 7 attempted");

  await page.clock.fastForward(tomorrow - (day + 12 * 60 * 60_000));
  await expect(today).toContainText("0 submitted / 0 attempted");
  await expect(today).toContainText("0 failed");
  await expect(today).not.toContainText("pending");
  await expect(allTime).toContainText("3 submitted / 7 attempted");

  const updated = applications.map((app) =>
    app.key === "review" ? { ...app, status: "submitted" as const, at: tomorrow } : app,
  );
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), updated);
  await expect(today).toContainText("1 submitted / 1 attempted");
  await expect(allTime).toContainText("4 submitted / 7 attempted");
  await expect(allTime).toContainText("2 failed · 1 pending");

  await sw.evaluate(() => chrome.storage.local.set({ applications: [] }));
  await expect(today).toContainText("0 submitted / 0 attempted");
  await expect(allTime).toContainText("0 submitted / 0 attempted");
  await expect(allTime).toContainText("0 failed");
});

test("queue access stays visible through a long history and preserves the user's place", async ({ sw, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await applicationsPage(sw, page);
  const trigger = page.getByRole("button", { name: "Queued jobs 45", exact: true });
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".queued-jobs li")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("History company");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  await expect(page.locator(".table tbody tr")).toHaveCount(45);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(500);
  await expect(trigger).toBeInViewport();
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("searchbox", { name: "Search queued jobs" })).toBeFocused();
  await expect(panel.getByRole("listitem")).toHaveCount(45);
  await panel.locator(".queue-panel-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(panel.getByRole("heading", { name: "Queued jobs" })).toBeInViewport();
  const clear = panel.getByRole("button", { name: "Clear queue", exact: true });
  await expect(clear).toBeInViewport();
  const search = panel.getByRole("searchbox", { name: "Search queued jobs" });
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const close = panel.getByRole("button", { name: "Close queued jobs" });
  await expect(close).toBeFocused();
  // The modal makes the underlying application controls inert, even to programmatic focus.
  await page.locator("input.search").evaluate((el) => (el as HTMLInputElement).focus());
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
  await expect(page.getByRole("searchbox", { name: "Search applications", exact: true })).toHaveValue(
    "History company",
  );
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("submitted");
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(16, 40);
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".queued-jobs li")).toHaveCount(0);
});

test("queue search and removal preserve other jobs; Clear queue also clears search-hidden jobs", async ({
  sw,
  page,
}) => {
  await applicationsPage(sw, page, 2, 3);
  await page.getByRole("button", { name: "Queued jobs 3", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  const search = panel.getByRole("searchbox", { name: "Search queued jobs" });
  await search.fill("gREenhouse");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await search.fill("montreal");
  await expect(panel.getByRole("status")).toHaveText("Showing 1 of 3 queued jobs");
  const link = panel.getByRole("link", { name: "Queue company 1 – Queue role 1", exact: true });
  await expect(link).toHaveAttribute("href", "https://example.com/queued/1");
  await expect(link).toHaveAttribute("target", "_blank");
  await panel
    .getByRole("button", { name: "Remove Queue company 1 – Queue role 1 from the queue", exact: true })
    .click();
  await expect(panel.getByText("No queued jobs match your search.", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  expect((await storage<QueueItem[]>(sw, "yoloQueue")).map((i) => i.key)).toEqual(["queued-0", "queued-2"]);
  await panel.getByRole("button", { name: "Clear queue", exact: true }).click();
  await expect(panel.getByText("No queued jobs. Jobs will appear here when YOLO finds new matches.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeDisabled();
  expect(await storage(sw, "yoloQueue")).toEqual([]);
  expect(await storage<unknown[]>(sw, "applications")).toHaveLength(2);
  await panel.getByRole("button", { name: "Close queued jobs" }).click();
  await expect(page.getByRole("button", { name: "Queued jobs 0", exact: true })).toBeFocused();
});

test("an empty queue stays accessible and storage updates never open the panel", async ({ sw, page }) => {
  const [job] = await applicationsPage(sw, page, 0, 1);
  await sw.evaluate(() => chrome.storage.local.set({ yoloQueue: [] }));
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await page.getByRole("button", { name: "Queued jobs 0", exact: true }).click();
  await expect(panel.getByText("No queued jobs. Jobs will appear here when YOLO finds new matches.")).toBeVisible();
  await page.keyboard.press("Escape");
  await sw.evaluate((item) => chrome.storage.local.set({ yoloQueue: [item] }), job);
  const trigger = page.getByRole("button", { name: "Queued jobs 1", exact: true });
  await expect(trigger).toBeVisible();
  await expect(panel).not.toBeVisible();
  await trigger.click();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await sw.evaluate(() => chrome.storage.local.set({ yoloQueue: [] }));
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No queued jobs. Jobs will appear here when YOLO finds new matches.")).toBeVisible();
  // Browser navigation can unmount an open modal; its scroll lock must be released.
  await page.evaluate(() => (location.hash = "/behavior"));
  await expect(page.getByRole("heading", { name: "Behavior", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden");
});

test("the queue fits a narrow dark viewport and keeps its controls reachable", async ({ sw, page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  await applicationsPage(sw, page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const trigger = page.getByRole("button", { name: "Queued jobs 45", exact: true });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  expect(box.height).toBe(740);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("queued-jobs-mobile.png") });
  await panel.getByRole("button", { name: "Close queued jobs" }).click();
  await expect(panel).not.toBeVisible();
});

test("a failed queue update keeps the jobs and allows retrying", async ({ sw, page }) => {
  await applicationsPage(sw, page, 0, 1);
  await page.getByRole("button", { name: "Queued jobs 1", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await page.evaluate(() => {
    chrome.storage.local.set = async () => {
      throw new Error("Storage unavailable");
    };
  });
  await panel
    .getByRole("button", { name: "Remove Queue company 0 – Queue role 0 from the queue", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't update the queue. Please try again.");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeEnabled();
  expect(await storage<QueueItem[]>(sw, "yoloQueue")).toHaveLength(1);
});
