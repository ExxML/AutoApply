import { describe, expect, it, vi } from "vitest";

// Each fresh module copy stands in for one content-script instance (isolated world) on the same DOM.
const instance = async () => {
  vi.resetModules();
  return import("../../src/content/ui/root");
};

describe("claimFrame", () => {
  it("evicts the orphaned instance so only the newest UI layer remains", async () => {
    const stale = document.createElement("autoapply-root"); // orphan from a build without the handshake
    document.documentElement.append(stale);

    const old = await instance();
    const oldEvicted = vi.fn();
    old.claimFrame(oldEvicted);
    expect(stale.isConnected).toBe(false);
    old.uiLayer().append(document.createElement("div"));

    const fresh = await instance();
    const freshEvicted = vi.fn();
    fresh.claimFrame(freshEvicted);
    fresh.uiLayer();

    expect(oldEvicted).toHaveBeenCalledOnce();
    expect(freshEvicted).not.toHaveBeenCalled();
    expect(document.querySelectorAll("autoapply-root")).toHaveLength(1);
    old.uiLayer(); // in-flight work in the orphan must not resurrect its layer
    expect(document.querySelectorAll("autoapply-root")).toHaveLength(1);
  });
});
