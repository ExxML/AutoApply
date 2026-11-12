import { readFileSync } from "node:fs";
import type { BrowserContext, Worker } from "@playwright/test";
import type { Application } from "../../src/shared/yolo";
import { FAILURES, type CallKind } from "../mockGemini";
import { BASE, expect, fillPage, PROFILE, seed, storage, test } from "./extension";

const stages = ["map", "audit", "essay", "review", "choose", "tailor"] as const;
type Stage = (typeof stages)[number] | "navigate" | "guess";
const tex = readFileSync("test/fixtures/latex/jake.tex", "utf8");
const url = (stage: Stage) => `${BASE}usage-limit.html?stage=${stage}`;

async function setup(sw: Worker, context: BrowserContext, stage: Stage) {
  await seed(sw, {
    caps: true,
    settings: { reviewFills: stage === "review", resumeUpload: stage === "tailor" ? "tailor" : "variants" },
    profile: {
      ...PROFILE,
      learnedAnswers:
        stage === "choose"
          ? [
              {
                id: "saved",
                question: "Research area",
                normalizedQuestion: "research area",
                kind: "select",
                answer: "Computing",
              },
            ]
          : [],
    },
  });
  if (stage === "tailor")
    await sw.evaluate(async (tex) => {
      const pdf = (await chrome.storage.local.get("doc:resume"))["doc:resume"];
      await chrome.storage.local.set({
        tailorResume: { fileName: "resume.tex", size: tex.length, uploadedAt: 1, pages: 1 },
        "doc:tailor-tex": { base64: tex },
        "doc:tailor-pdf": pdf,
      });
    }, Buffer.from(tex).toString("base64"));
  let submissions = 0;
  await context.route("**/usage-limit-submit", async (route) => {
    submissions++;
    await route.fulfill({ contentType: "text/html", body: "<h1>Application submitted</h1>" });
  });
  return () => submissions;
}

for (const stage of stages) {
  test(`manual: a ${stage} limit stops filling and shows the usage warning`, async ({ sw, page, context, mock }) => {
    const submissions = await setup(sw, context, stage);
    mock.always = (_key, _model, kind) => (kind === stage ? FAILURES.daily : null);
    await page.goto(url(stage));
    await fillPage(page, sw);
    await expect(page.locator("autoapply-root .panel .error")).toContainText("All API keys are rate-limited");
    await expect(page.locator("autoapply-root .panel .status")).not.toContainText(/Filling|Reviewing/);
    expect(mock.calls.some((c) => c.kind === stage && c.status === 429)).toBe(true);
    expect(submissions()).toBe(0);
    await expect(page.locator('[name="botTrap"]')).toHaveValue("");
  });
}

test("Claude with Gemini autofill: a Claude review limit stops after Gemini filled the answers", async ({
  sw,
  page,
  context,
  mock,
}) => {
  const submissions = await setup(sw, context, "review");
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...(settings as object), aiProvider: "claude", geminiFill: true },
      claudeReady: true,
    });
    // Exercise the real Claude response parser without launching Claude or consuming plan usage.
    chrome.runtime.connectNative = () => {
      let receive: ((reply: unknown) => void) | undefined;
      return {
        onMessage: {
          addListener: (listener: typeof receive) => {
            receive = listener;
          },
        },
        onDisconnect: { addListener: () => undefined },
        disconnect: () => undefined,
        postMessage: () =>
          queueMicrotask(() =>
            receive?.({
              code: 0,
              err: "",
              out: btoa(
                [
                  {
                    type: "rate_limit_event",
                    rate_limit_info: { status: "rejected", resetsAt: Date.now() / 1000 + 18000 },
                  },
                  { type: "result", subtype: "error_during_execution", is_error: true, result: "Usage limit reached" },
                ]
                  .map((line) => JSON.stringify(line))
                  .join("\n"),
              ),
            }),
          ),
      } as unknown as chrome.runtime.Port;
    };
  });
  await page.goto(url("review"));
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toContainText("Claude usage limit reached");
  expect(mock.calls_("map").length).toBeGreaterThan(0);
  expect(mock.calls_("review")).toHaveLength(0);
  expect(submissions()).toBe(0);
});

test("a limit in a child frame stops the tab and displays the warning in the top frame", async ({
  sw,
  page,
  context,
  mock,
}) => {
  const submissions = await setup(sw, context, "review");
  await context.route("**/usage-limit-parent.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<h1>Application</h1><iframe style="width:800px;height:800px" src="usage-limit.html?stage=review"></iframe>',
    }),
  );
  mock.always = (_key, _model, kind) => (kind === "review" ? FAILURES.daily : null);
  await page.goto(`${BASE}usage-limit-parent.html`);
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toContainText("All API keys are rate-limited");
  await expect(page.locator("autoapply-root .panel .status")).not.toContainText(/Filling|Reviewing/);
  await expect(page.frameLocator("iframe").locator('[name="botTrap"]')).toHaveValue("");
  expect(submissions()).toBe(0);
});

for (const mode of ["YOLO", "job tabs"] as const) {
  for (const stage of [...stages, "navigate", "guess"] as const) {
    test(`${mode}: a ${stage} limit pauses before submission and retains the queued job`, async ({
      sw,
      page,
      context,
      mock,
    }) => {
      const submissions = await setup(sw, context, stage);
      mock.always = (_key, _model, kind: CallKind) => (kind === stage ? FAILURES.daily : null);
      await sw.evaluate(
        async (stage) =>
          chrome.storage.local.set({
            yolo: {
              enabled: false,
              queries: ["Software Engineer Intern"],
              boards: [],
              feeds: [],
              aiRelevanceCheck: false,
              reviewFills: stage === "review",
              aiNavigation: stage === "navigate",
              resumeUpload: stage === "tailor" ? "tailor" : "variants",
            },
          }),
        stage,
      );
      if (mode === "job tabs") {
        await page.goto(url(stage));
        // Run the public popup action from an extension page, as a user would.
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${new URL(sw.url()).host}/src/popup/index.html`);
        const r = await popup.evaluate(async () => {
          const window = await chrome.windows.getCurrent();
          return chrome.runtime.sendMessage({ type: "YOLO_APPLY_TABS", windowId: window.id });
        });
        expect(r).toMatchObject({ ok: true, added: 1 });
      } else {
        await sw.evaluate(async (url) => {
          const { yolo } = await chrome.storage.local.get("yolo");
          await chrome.storage.local.set({
            yolo: { ...(yolo as object), enabled: true },
            yoloQueue: [
              {
                key: url,
                url,
                company: "Acme",
                title: "Software Engineer Intern",
                location: "Vancouver",
                source: "test",
                postedAt: 1,
                addedAt: 1,
              },
            ],
          });
        }, url(stage));
      }
      await expect
        .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState"))?.pauseReason, { timeout: 45_000 })
        .toBe("AI usage limit reached")
        .catch(async (error) => {
          await test.info().attach("workflow-state", {
            contentType: "application/json",
            body: JSON.stringify({
              local: await sw.evaluate(() =>
                chrome.storage.local.get(["yolo", "yoloState", "yoloQueue", "applications"]),
              ),
              session: await sw.evaluate(() => chrome.storage.session.get("yoloRun")),
              calls: mock.calls,
            }),
          });
          throw error;
        });
      expect((await storage<Application[] | undefined>(sw, "applications")) ?? []).toEqual([]);
      const queued =
        mode === "job tabs"
          ? await sw.evaluate(async () => (await chrome.storage.session.get("yoloTabJobs")).yoloTabJobs)
          : await storage<unknown[]>(sw, "yoloQueue");
      expect(queued).toHaveLength(1);
      expect(submissions()).toBe(0);
      expect(mock.calls.some((c) => c.kind === stage && c.status === 429)).toBe(true);
      if (mode === "job tabs") {
        await expect(page.locator("autoapply-root .panel .error")).toContainText("All API keys are rate-limited");
        await expect(page.locator('[name="botTrap"]')).toHaveValue("");
      }
    });
  }
}
