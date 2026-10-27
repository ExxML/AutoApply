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

describe("anchorable", () => {
  const sized = (e: Element, width: number, height: number) =>
    (e.getBoundingClientRect = () => ({ width, height }) as DOMRect);

  it("lifts a control in nested page shadow trees to its document-tree host only when the host is the control", async () => {
    const { anchorable } = await instance();
    const picker = document.createElement("div"); // ui5-date-picker: input + calendar icon
    document.body.append(picker);
    const field = document.createElement("div");
    picker.attachShadow({ mode: "open" }).append(field);
    const input = document.createElement("input");
    field.attachShadow({ mode: "open" }).append(input);
    sized(input, 173, 35);
    sized(picker, 210, 36);
    expect(anchorable(input)).toBe(picker);
    expect(anchorable(picker)).toBe(picker);

    sized(picker, 600, 400); // a whole form in one shadow root
    expect(anchorable(input)).toBeNull();
  });
});
