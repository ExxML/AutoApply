import { BASE, expect, fillPage, seed, test, waitDone } from "./extension";

// §19 budgets with the mock at 0 ms latency, read from the overlay's stage timing log.
test("performance budgets and timing log", async ({ page, sw }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  const log = (await page.locator("autoapply-root pre.timings").textContent()) ?? "";
  const t = Object.fromEntries([...log.matchAll(/(\w+)\s+(\d+) ms/g)].map((m) => [m[1], Number(m[2])]));
  console.log("stage timings (ms):", JSON.stringify(t));
  expect(Object.keys(t)).toEqual(expect.arrayContaining(["scan", "phaseA", "map", "done"]));
  expect(t.scan).toBeLessThanOrEqual(100);
  expect(t.phaseA).toBeLessThanOrEqual(400);
  expect(t.done).toBeLessThanOrEqual(8000);
});
