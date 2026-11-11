import { beforeEach, describe, expect, it, vi } from "vitest";
import { yoloHandlers } from "../../src/background/yolo";
import { inQueueOrder } from "../../src/background/yolo/discover";
import { ApplicationSchema, defaultYolo, QueueItemSchema, type QueueItem } from "../../src/shared/yolo";
import { installChromeMock } from "./chromeMock";

type Job = { url: string; company: string; title: string; postedAt?: number };
const add = (jobs: Job[]) => yoloHandlers.YOLO_QUEUE_ADD!({ type: "YOLO_QUEUE_ADD", jobs }, {});
const queue = async () => (await chrome.storage.local.get("yoloQueue")).yoloQueue as QueueItem[];

beforeEach(() => {
  installChromeMock();
  // Employer-board lookups for board links find nothing.
  globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as typeof fetch;
});

describe("queue jobs by hand", () => {
  it("queues posting links as the user's, and says why the rest weren't", async () => {
    await chrome.storage.local.set({
      applications: [
        ApplicationSchema.parse({ key: "lever:done", url: "https://jobs.lever.co/co/done", status: "failed" }),
      ],
      yoloQueue: [QueueItemSchema.parse({ key: "ashby:queued", url: "https://jobs.ashbyhq.com/co/queued" })],
    });
    const r = await add([
      { url: " https://jobs.lever.co/acme/1 ", company: "Acme", title: "Intern", postedAt: 5 },
      // The same job through another link.
      { url: "https://boards.greenhouse.io/acme/jobs/9", company: "acme", title: "Intern" },
      { url: "https://jobs.lever.co/co/done", company: "Co", title: "Engineer" },
      { url: "https://jobs.ashbyhq.com/co/queued", company: "Co", title: "Other" },
      { url: "https://acme.com/", company: "Acme", title: "Intern" },
      { url: "https://jobs.lever.co/acme/2", company: "", title: "Intern" },
      { url: "https://www.linkedin.com/jobs/view/123/", company: "Nowhere", title: "Intern" },
      { url: "https://www.indeed.com/viewjob?jk=abc", company: "Initech", title: "Analyst" },
    ]);
    expect(r).toEqual({
      ok: true,
      added: 2,
      skipped: [
        { url: "https://jobs.lever.co/co/done", reason: "Already in Applications" },
        { url: "https://acme.com/", reason: "Not a link to one job posting" },
        { url: "https://jobs.lever.co/acme/2", reason: "Needs its company and job title" },
        {
          url: "https://www.linkedin.com/jobs/view/123/",
          reason: "LinkedIn doesn't link to the employer's site: add the employer's own posting link",
        },
        { url: "https://boards.greenhouse.io/acme/jobs/9", reason: "Already queued" },
        { url: "https://jobs.ashbyhq.com/co/queued", reason: "Already queued" },
      ],
    });
    const [, mine, board] = await queue();
    expect(mine).toMatchObject({
      key: "lever:1",
      url: "https://jobs.lever.co/acme/1",
      source: "added",
      sourceGroups: ["added"],
      postedAt: 5,
    });
    // A board link without an employer posting found is kept: the run clicks through to the employer.
    expect(board).toMatchObject({ key: "indeed:abc", url: "https://www.indeed.com/viewjob?jk=abc", source: "added" });
    expect(board.postedAt).toBe(board.addedAt);
  });

  it("puts them first, last, or by the apply order, earliest queued first", () => {
    const items = [
      { source: "linkedin", postedAt: 30, addedAt: 1 },
      { source: "added", postedAt: 10, addedAt: 5 },
      { source: "careers", postedAt: 20, addedAt: 2 },
      { source: "added", postedAt: 40, addedAt: 3 },
    ];
    const order = (addedPlacement: "front" | "order" | "end") =>
      inQueueOrder(items, { ...defaultYolo(), addedPlacement }).map((j) => j.postedAt);
    expect(order("front")).toEqual([40, 10, 30, 20]);
    expect(order("end")).toEqual([30, 20, 40, 10]);
    expect(order("order")).toEqual([40, 30, 20, 10]);
    expect(defaultYolo().addedPlacement).toBe("front");
  });
});
