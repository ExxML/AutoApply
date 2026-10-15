import { BASE, badge, expect, fillPage, forbidden, seed, storage, test, waitDone } from "./extension";

test("plain form: deterministic, AI, essay, file and consent fields are filled, verified and badged", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);

  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#ln")).toHaveValue("Lovelace");
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  await expect(page.locator("#ph")).toHaveValue("+1 6045551234");
  await expect(page.locator("#prov")).toHaveValue("BC");
  await expect(page.locator("input[name=auth][value=yes]")).toBeChecked();
  await expect(page.locator("#why")).not.toHaveValue("");
  expect(await page.locator("#cv").evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).toBe("ada-resume.pdf");
  await expect(page.locator("#privacy")).not.toBeChecked();

  await expect(badge(page, "First name")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "Email")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "Province")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Are you legally authorized to work in Canada?")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Why do you want to work at Acme Robotics? (max 120 words)")).toHaveAttribute(
    "data-color",
    "purple",
  );
  await expect(badge(page, "Resume/CV")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "I agree to the privacy policy")).toHaveAttribute("data-color", "yellow");

  // 9 fields: 8 filled (5 profile + 2 AI + 1 essay), consent needs you.
  await expect(page.locator("autoapply-root .panel .status")).toHaveText("Done · 8 filled · 1 AI draft · 1 need you");
  const words = (await page.locator("#why").inputValue()).split(/\s+/).length;
  expect(words).toBeLessThanOrEqual(120);

  expect(await forbidden(page)).toEqual([]);
  expect(mock.calls_("map")).toHaveLength(1);
  await expect
    .poll(async () => Object.keys((await storage<Record<string, unknown>>(sw, "decisionCache")) ?? {}).length)
    .toBeGreaterThanOrEqual(2);
});
