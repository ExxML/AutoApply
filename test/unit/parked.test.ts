import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { MAX_PARKED, park, parkedKeys, takeParked } from "../../src/background/yolo/parked";
import type { Run } from "../../src/background/yolo/runner";

let open: Set<number>;
const run = (tabId: number) => ({ id: `r${tabId}`, tabId }) as Run;

beforeEach(() => {
  installChromeMock();
  open = new Set([1, 2, 3, 4]);
  Object.assign(chrome, {
    tabs: {
      get: vi.fn(async (id: number) => (open.has(id) ? { id } : Promise.reject(new Error("No tab")))),
      update: vi.fn(async () => undefined),
    },
  });
});

describe("parked CAPTCHA tabs", () => {
  it("holds up to the limit, counting only tabs still open", async () => {
    for (let i = 1; i <= MAX_PARKED; i++) expect(await park(`job${i}`, run(i))).toBe(true);
    expect(await park("job4", run(4))).toBe(false);
    open.delete(1); // the user closed one
    expect(await park("job4", run(4))).toBe(true);
    expect((await parkedKeys()).sort()).toEqual(["job2", "job3", "job4"]);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { autoDiscardable: false });
  });

  it("hands a parked run back once, and lets Chrome discard its tab again", async () => {
    await park("job", run(2));
    expect(await takeParked("job")).toMatchObject({ tabId: 2 });
    expect(await takeParked("job")).toBeNull();
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(2, { autoDiscardable: true });
  });
});
