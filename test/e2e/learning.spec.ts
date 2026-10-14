import { BASE, badge, expect, seed, storage, test, waitDone } from "./extension";

const Q = "What is your favourite programming language?";

test("learning: a manually answered flagged field is saved and reused without an AI call", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw);
  await page.goto(BASE + "semantic.html");
  await waitDone(page);
  await expect(badge(page, Q)).toHaveAttribute("data-color", "yellow");

  await page.locator("#lang").fill("TypeScript");
  await page.locator("#lang").press("Tab");
  const card = page.locator("autoapply-root .learn");
  await expect(card).toContainText("Save this answer for future applications?");
  await expect(card).toContainText(`"${Q}" → "TypeScript"`);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toHaveCount(0);
  await expect(badge(page, Q)).toHaveAttribute("data-color", "green");

  const profile = await storage<{ learnedAnswers: { question: string; answer: string; host: string }[] }>(
    sw,
    "profile",
  );
  expect(profile.learnedAnswers).toEqual([
    expect.objectContaining({ question: Q, answer: "TypeScript", host: "localhost" }),
  ]);

  const before = mock.calls_("map").length;
  await page.reload();
  await waitDone(page);
  await expect(page.locator("#lang")).toHaveValue("TypeScript");
  await expect(badge(page, Q)).toHaveAttribute("data-color", "green");
  await expect(badge(page, Q)).toHaveAttribute("aria-label", /Saved answer/);
  // Any new mapping call must not have included the learned question.
  for (const c of mock.calls_("map").slice(before))
    expect((c.payload!.fields as { label: string }[]).map((f) => f.label)).not.toContain(Q);
});
