import { ProfileSchema } from "../../src/shared/profileSchema";
import { SettingsSchema } from "../../src/shared/settings";
import { defaultYolo } from "../../src/shared/yolo";
import { expect, seed, test } from "./extension";

test("import preview groups settings, compares all values, and only imports checked fields", async ({
  sw,
  page,
}, testInfo) => {
  await seed(sw);
  const current = await sw.evaluate(() => chrome.storage.local.get());
  const profile = ProfileSchema.parse(current.profile);
  profile.personal.firstName = "Grace";
  profile.personal.email = "grace@example.com";
  profile.essayGuidance.aboutMe = '<img src="x" onerror="window.importExecuted=true">';
  const incoming = {
    app: "autoapply",
    version: 1,
    profile,
    settings: { ...SettingsSchema.parse(current.settings), essayDefaultWords: 225 },
    selectedModel: "gemini-2.5-pro",
    fallbackModel: null,
    apiKeys: [{ id: "new", label: "Imported key", key: "secret-value-1234", addedAt: 1 }],
    yolo: { ...defaultYolo(), intervalMin: 50 },
    documents: [],
  };
  const options = `chrome-extension://${new URL(sw.url()).host}/src/options/index.html`;
  await page.goto(`${options}#/data`);
  await page.getByLabel("Import JSON file").setInputFiles({
    name: "selective.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await expect(page.getByRole("heading", { name: "Review import" })).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "Profile", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "YOLO Mode", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Personal", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Essay guidance", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Schedule", exact: true })).toBeVisible();
  const firstName = page.locator(".import-change", {
    has: page.getByRole("checkbox", { name: "Replace First name", exact: true }),
  });
  await expect(firstName).toContainText("Ada");
  await expect(firstName).toContainText("Grace");
  await expect(page.locator(".import-change", { hasText: "Imported key" })).not.toContainText("secret-value-1234");
  await page.getByRole("button", { name: "Show sensitive values", exact: true }).first().click();
  await expect(page.locator(".import-change", { hasText: "Imported key" })).toContainText("secret-value-1234");
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).importExecuted)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath("import-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Select none", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import 0 selected changes", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Replace First name", exact: true }).check();
  expect(
    await page
      .getByRole("checkbox", { name: "Profile", exact: true })
      .evaluate((el: HTMLInputElement) => el.indeterminate),
  ).toBe(true);
  await page.getByLabel("Search changes", { exact: true }).fill("first name");
  await expect(page.locator(".import-change")).toHaveCount(1);
  await page.getByLabel("Search changes", { exact: true }).fill("");
  await page.getByRole("combobox", { name: "Change type", exact: true }).selectOption("Remove");
  await expect(page.getByRole("checkbox", { name: "Remove Résumé", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Change type", exact: true }).selectOption("all");
  await page.setViewportSize({ width: 720, height: 900 });
  expect(
    await firstName
      .locator(".import-comparison")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length),
  ).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("import-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "Import 1 selected change", exact: true }).click();
  await expect(page.getByText("Selected changes imported.", { exact: true })).toBeVisible();
  const after = await sw.evaluate(() => chrome.storage.local.get());
  expect(ProfileSchema.parse(after.profile)).toEqual({
    ...ProfileSchema.parse(current.profile),
    personal: { ...ProfileSchema.parse(current.profile).personal, firstName: "Grace" },
  });
  for (const key of ["settings", "apiKeys", "documentsIndex", "doc:resume", "selectedModel", "yoloInFlight"])
    expect(after[key]).toEqual(current[key]);
});

test("cancel, invalid files, and stale previews do not import data", async ({ sw, page }) => {
  await seed(sw);
  const current = await sw.evaluate(() => chrome.storage.local.get());
  const profile = ProfileSchema.parse(current.profile);
  profile.personal.firstName = "Incoming";
  const incoming = {
    app: "autoapply",
    version: 1,
    profile,
    settings: SettingsSchema.parse(current.settings),
    selectedModel: current.selectedModel,
    fallbackModel: null,
  };
  const file = { name: "valid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)) };
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/data`);
  const input = page.getByLabel("Import JSON file");
  await input.setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    ProfileSchema.parse((await sw.evaluate(() => chrome.storage.local.get("profile"))).profile).personal.firstName,
  ).toBe("Ada");
  await input.setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible();
  await input.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{") });
  await expect(page.getByRole("alert")).toContainText("Could not read");
  await expect(page.getByRole("heading", { name: "Review import" })).toHaveCount(0);
  await input.setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Review import" })).toBeVisible();
  await sw.evaluate(async () => {
    const profile = (await chrome.storage.local.get("profile")).profile as { personal: { firstName: string } };
    profile.personal.firstName = "Edited meanwhile";
    await chrome.storage.local.set({ profile });
  });
  await page.getByRole("button", { name: "Import 1 selected change", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your data changed");
  expect(
    ProfileSchema.parse((await sw.evaluate(() => chrome.storage.local.get("profile"))).profile).personal.firstName,
  ).toBe("Edited meanwhile");
});

test("imported documents can be inspected and refresh résumé facts without changing profile text", async ({
  sw,
  page,
}) => {
  await seed(sw);
  const current = await sw.evaluate(() => chrome.storage.local.get());
  const text = "New résumé facts from the selected file.";
  const tex = "\\begin{document}\nRésumé source\n\\end{document}";
  const info = { fileName: "resume.tex", size: 50, uploadedAt: 2, pages: 1, fallback: null };
  const documents = [
    {
      meta: {
        id: "resume",
        label: "Updated résumé",
        kind: "resume",
        fileName: "resume.txt",
        mimeType: "text/plain",
        size: text.length,
        isPrimaryResume: true,
        uploadedAt: 2,
      },
      base64: Buffer.from(text).toString("base64"),
    },
  ];
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/data`);
  await page.getByLabel("Import JSON file").setInputFiles({
    name: "documents.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        app: "autoapply",
        version: 1,
        profile: ProfileSchema.parse(current.profile),
        settings: SettingsSchema.parse(current.settings),
        selectedModel: current.selectedModel,
        fallbackModel: current.fallbackModel,
        documents,
        tailorResume: {
          info,
          tex: Buffer.from(tex).toString("base64"),
          pdf: Buffer.from("PDF contents").toString("base64"),
        },
      }),
    ),
  });
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await page.getByText("LaTeX source", { exact: true }).click();
  await expect(page.locator("pre.import-text")).toHaveText(tex);
  const document = page.locator(".import-change", {
    has: page.getByRole("checkbox", { name: "Replace Updated résumé", exact: true }),
  });
  const downloadEvent = page.waitForEvent("download");
  await document.getByRole("button", { name: "Download file to inspect", exact: true }).last().click();
  expect((await downloadEvent).suggestedFilename()).toBe("resume.txt");
  await page.getByRole("button", { name: "Import 2 selected changes", exact: true }).click();
  await expect(page.getByText("Selected changes imported.", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("resumeTexts"))).resumeTexts)
    .toEqual({ resume: text });
  const after = await sw.evaluate(() => chrome.storage.local.get());
  expect(after.profile).toEqual(current.profile);
  expect(after.tailorResume).toEqual(info);
  expect(after["doc:resume"]).toEqual({ base64: documents[0].base64 });
  expect(after["doc:tailor-tex"]).toEqual({ base64: Buffer.from(tex).toString("base64") });
});
