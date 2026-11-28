import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { deleteSaved, saveResponses } from "../../src/background/yolo/savedStore";
import { yoloHandlers } from "../../src/background/yolo";
import { ApplicationSchema } from "../../src/shared/yolo";

const letter = { meta: { fileName: "Ann_Cover_Letter.pdf" }, base64: "JVBERi0=" };
const local = (k: string) => chrome.storage.local.get(k).then((r) => r[k]);

beforeEach(async () => {
  installChromeMock();
  await chrome.storage.session.set({ "yolodoc:yolo-1": letter });
  await chrome.storage.local.set({
    documentsIndex: [
      {
        id: "r1",
        label: "My résumé",
        kind: "resume",
        fileName: "r.pdf",
        mimeType: "application/pdf",
        size: 1,
        isPrimaryResume: true,
        uploadedAt: 1,
      },
    ],
  });
});

describe("saved application responses", () => {
  it("keeps answers, the user's résumé by name and the generated letter's PDF, and indexes its size", async () => {
    await saveResponses("lever:a", [{ q: "Why us?", a: "Because [ai]" }], ["r1", "yolo-1", "r1"]);
    const saved = await local("saved:lever:a");
    expect(saved).toMatchObject({
      answers: [{ q: "Why us?", a: "Because [ai]" }],
      resume: ["My résumé"],
      letter: ["Generated (Ann_Cover_Letter.pdf)"],
      files: [{ name: "Ann_Cover_Letter.pdf", base64: "JVBERi0=" }],
    });
    expect(await local("savedIndex")).toEqual({ "lever:a": JSON.stringify(saved).length });
  });

  it("merges a later attempt: same question replaced, documents kept when none were uploaded", async () => {
    await saveResponses(
      "lever:a",
      [
        { q: "Q1", a: "old" },
        { q: "Q2", a: "two" },
      ],
      ["yolo-1"],
    );
    await saveResponses("lever:a", [{ q: "Q1", a: "new" }], []);
    const saved = (await local("saved:lever:a")) as { answers: unknown[]; files: unknown[] };
    expect(saved.answers).toEqual([
      { q: "Q2", a: "two" },
      { q: "Q1", a: "new" },
    ]);
    expect(saved.files).toHaveLength(1);
  });

  it("saves nothing for an attempt with no answers or documents", async () => {
    await saveResponses("lever:a", [], []);
    expect(await local("saved:lever:a")).toBeUndefined();
  });

  it("deletes only the chosen records and their index entries", async () => {
    await saveResponses("lever:a", [{ q: "Q", a: "A" }], []);
    await saveResponses("lever:b", [{ q: "Q", a: "B" }], []);
    await deleteSaved(["lever:a", "lever:missing"]);
    expect(await local("saved:lever:a")).toBeUndefined();
    expect(await local("saved:lever:b")).toBeDefined();
    expect(Object.keys((await local("savedIndex")) as object)).toEqual(["lever:b"]);
  });

  it("forgetting an application deletes its saved data", async () => {
    Object.assign(chrome, { tabs: { get: vi.fn(async () => null), onRemoved: { addListener: vi.fn() } } });
    const a = ApplicationSchema.parse({ key: "lever:a", url: "https://jobs.lever.co/co/a", status: "failed" });
    await chrome.storage.local.set({ applications: [a] });
    await saveResponses("lever:a", [{ q: "Q", a: "A" }], []);
    await yoloHandlers.YOLO_FORGET!({ type: "YOLO_FORGET", key: "lever:a" }, {});
    expect(await local("saved:lever:a")).toBeUndefined();
    expect(await local("savedIndex")).toEqual({});
  });
});

describe("manual fill answers", () => {
  it("are kept per tab across frames and saved with the submission", async () => {
    Object.assign(chrome, {
      scripting: { executeScript: vi.fn(async () => []) },
      tabs: { get: vi.fn(async () => null), onRemoved: { addListener: vi.fn() } },
    });
    const tab = { id: 4, url: "https://jobs.lever.co/co/abc/apply" } as chrome.tabs.Tab;
    await yoloHandlers.FILL_ANSWERS!(
      { type: "FILL_ANSWERS", answers: { "1|a": { q: "Name", a: "Ann" } }, uploads: ["r1"] },
      { tab },
    );
    await yoloHandlers.FILL_ANSWERS!(
      { type: "FILL_ANSWERS", answers: { "2|b": { q: "Letter", a: "x" } }, uploads: ["yolo-1"] },
      { tab, frameId: 3 },
    );
    await yoloHandlers.APPLY_ATTEMPT!(
      {
        type: "APPLY_ATTEMPT",
        job: { url: tab.url!, company: "Co", title: "Intern" },
        doneUrl: "https://jobs.lever.co/co/abc/thanks",
        answers: { "1|a": { q: "Name", a: "Ann Lee" } },
        uploads: [],
      },
      { tab },
    );
    expect(await local("saved:lever:abc")).toMatchObject({
      answers: [
        { q: "Name", a: "Ann Lee" },
        { q: "Letter", a: "x" },
      ],
      resume: ["My résumé"],
      letter: ["Generated (Ann_Cover_Letter.pdf)"],
    });
  });

  it("start afresh for another job in the same tab", async () => {
    const at = (url: string) => ({ tab: { id: 4, url } as chrome.tabs.Tab });
    await yoloHandlers.FILL_ANSWERS!(
      { type: "FILL_ANSWERS", answers: { "1|a": { q: "Old", a: "1" } }, uploads: [] },
      at("https://jobs.lever.co/co/one"),
    );
    await yoloHandlers.FILL_ANSWERS!(
      { type: "FILL_ANSWERS", answers: { "2|a": { q: "New", a: "2" } }, uploads: [] },
      at("https://jobs.lever.co/co/two"),
    );
    const kept = (await chrome.storage.session.get("fillAnswers:4"))["fillAnswers:4"] as { answers: object };
    expect(Object.values(kept.answers)).toEqual([{ q: "New", a: "2" }]);
  });
});
