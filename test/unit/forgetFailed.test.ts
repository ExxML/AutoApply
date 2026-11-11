import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordApplication } from "../../src/background/yolo/applicationStore";
import { discover } from "../../src/background/yolo/discover";
import { yoloHandlers } from "../../src/background/yolo";
import { initReviewTabs, retainReview, reviewList } from "../../src/background/yolo/reviewTabs";
import { ApplicationSchema, defaultYolo, QueueItemSchema, type Application } from "../../src/shared/yolo";
import { installChromeMock } from "./chromeMock";

const application = (key: string, status: Application["status"], review = false) =>
  ApplicationSchema.parse({
    key: `lever:${key}`,
    url: `https://jobs.lever.co/co/${key}`,
    company: `Co ${key}`,
    title: "Software Engineer Intern",
    status,
    ...(review && { review: { reasons: ["Review requested"], preparedAt: 1 } }),
    at: 1,
  });

const forgetAll = (status: "failed" | "needs" | "skipped") =>
  yoloHandlers.YOLO_FORGET_ALL!({ type: "YOLO_FORGET_ALL", status }, {});
const forgetFailed = () => forgetAll("failed");

beforeEach(async () => {
  installChromeMock();
  const events = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  Object.assign(chrome, {
    tabs: {
      onRemoved: events(),
      onUpdated: events(),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, active: false })),
      update: vi.fn(async () => undefined),
      ungroup: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      sendMessage: vi.fn(async () => ({ ready: true })),
    },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => undefined) },
  });
  await initReviewTabs(() => undefined);
});

describe("forget all failed applications", () => {
  it("preserves other statuses and the queue, and releases only forgotten review tabs", async () => {
    const failed = [application("failed", "failed"), application("failed-review", "failed", true)];
    const remaining = [
      application("submitted", "submitted"),
      { ...application("manual", "submitted"), mode: "manual" },
      application("review", "review", true),
      application("needs", "needs"),
      application("skipped", "skipped"),
    ];
    const yoloQueue = [QueueItemSchema.parse({ key: "queued", url: "https://example.com/queued" })];
    await chrome.storage.local.set({ applications: [...failed, ...remaining], yoloQueue });
    await retainReview("lever:failed-review", 7);
    await retainReview("lever:review", 8);

    expect(await forgetFailed()).toEqual({ ok: true, forgotten: 2 });
    expect((await chrome.storage.local.get("applications")).applications).toEqual(remaining);
    expect((await chrome.storage.local.get("yoloQueue")).yoloQueue).toEqual(yoloQueue);
    expect((await reviewList()).live).toEqual(["lever:review"]);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(7);
    expect(chrome.tabs.ungroup).not.toHaveBeenCalledWith(8);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(await forgetFailed()).toEqual({ ok: true, forgotten: 0 });
  });

  it("forgets Needs you and Skipped applications the same way, and never submissions", async () => {
    const needs = [application("needs", "needs"), application("needs-review", "needs", true)];
    const skipped = application("skipped", "skipped");
    const others = [
      application("submitted", "submitted"),
      application("failed", "failed"),
      application("review", "review"),
    ];
    await chrome.storage.local.set({ applications: [...needs, skipped, ...others] });
    await retainReview("lever:needs-review", 7);

    expect(await forgetAll("needs")).toEqual({ ok: true, forgotten: 2 });
    expect((await reviewList()).live).toEqual([]);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(7);
    expect(await forgetAll("skipped")).toEqual({ ok: true, forgotten: 1 });
    expect((await chrome.storage.local.get("applications")).applications).toEqual(others);
    const send = yoloHandlers.YOLO_FORGET_ALL! as (m: unknown, s: unknown) => Promise<unknown>;
    expect(await send({ type: "YOLO_FORGET_ALL", status: "submitted" }, {})).toHaveProperty("error");
    expect((await chrome.storage.local.get("applications")).applications).toEqual(others);
  });

  it("preserves submissions recorded concurrently with forgetting", async () => {
    await recordApplication(application("changed", "failed"));
    await recordApplication(application("failed", "failed"));
    const submitted = application("changed", "submitted");
    const another = application("another", "submitted");
    const [, result] = await Promise.all([recordApplication(submitted), forgetFailed(), recordApplication(another)]);
    expect(result).toEqual({ ok: true, forgotten: 1 });
    expect((await chrome.storage.local.get("applications")).applications).toEqual([submitted, another]);
  });

  it("requeues forgotten jobs from unchanged feeds at the next check", async () => {
    const failed = application("failed", "failed");
    const submitted = application("submitted", "submitted");
    await chrome.storage.local.set({ applications: [failed, submitted] });
    const rows = [failed, submitted].map((a) => ({
      company_name: a.company,
      title: a.title,
      url: a.url,
      locations: ["Remote"],
      active: true,
    }));
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).has("if-none-match")
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(rows), { headers: { etag: '"unchanged"' } }),
    );
    const yolo = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      feeds: ["https://example.com/feed.json"],
      boards: [],
    };
    expect(await discover({ yolo, fetch })).toBe(0);
    expect((await chrome.storage.local.get("feedCache")).feedCache).toEqual({
      "https://example.com/feed.json": { etag: '"unchanged"', modified: "" },
    });
    await forgetFailed();
    expect(await discover({ yolo, fetch })).toBe(1);
    expect((await chrome.storage.local.get("yoloQueue")).yoloQueue).toEqual([
      expect.objectContaining({ key: failed.key }),
    ]);
    expect((await chrome.storage.local.get("applications")).applications).toEqual([submitted]);
  });
});
