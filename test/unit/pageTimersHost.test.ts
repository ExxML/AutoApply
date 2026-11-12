import { expect, test } from "vitest";

test("Greenhouse's embed script reads the host frame's own address, not the extension's top page", async () => {
  Object.defineProperty(location, "ancestorOrigins", { value: ["chrome-extension://x"], configurable: true });
  await import("../../src/content/pageTimers");
  const w = window as unknown as { Grnhse: { UriHelper: { currentLocation: () => Location } } };
  // As boards.greenhouse.io/embed/job_board/js does it: `var Grnhse = Grnhse || {}`, then its helpers.
  w.Grnhse = w.Grnhse || ({} as typeof w.Grnhse);
  w.Grnhse.UriHelper = {
    currentLocation: () => {
      throw new DOMException("Blocked a frame from accessing a cross-origin frame", "SecurityError");
    },
  };
  expect(w.Grnhse.UriHelper.currentLocation()).toBe(location);
});

test("anti-clickjacking's hidden body shows in the host frame", () => {
  document.head.insertAdjacentHTML("beforeend", `<style id="antiClickjack">body{display:none !important;}</style>`);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(document.getElementById("antiClickjack")).toBeNull();
});

test("the host page's short timers are relayed to the extension only around one that ran late", async () => {
  const asked: string[] = [];
  document.addEventListener("autoapply-timer", (e) => asked.push((e as CustomEvent<string>).detail));
  document.dispatchEvent(new Event("autoapply-fill-start"));
  await new Promise((r) => setTimeout(r, 20));
  expect(asked).toEqual([]); // on time: each would be a round trip through the extension for nothing
  // Held up past 250 ms, as Chrome's throttling would.
  const late = new Promise((r) => setTimeout(r, 10));
  for (const until = performance.now() + 300; performance.now() < until;);
  await late;
  const ran: number[] = [];
  const id = setTimeout(() => ran.push(1), 50);
  expect(asked).toEqual([`${id}:50`]);
  document.dispatchEvent(new CustomEvent("autoapply-timer-fire", { detail: String(id) }));
  await new Promise((r) => setTimeout(r, 80));
  expect(ran).toEqual([1]); // relayed and the page's own timer: it runs once
  document.dispatchEvent(new Event("autoapply-fill-end"));
});

test("a hidden run's page never asks to confirm leaving, and the driver still hears it leave", () => {
  const ran: string[] = [];
  addEventListener("beforeunload", (e) => {
    ran.push("page");
    e.preventDefault(); // "Leave site? Changes you made may not be saved."
  });
  document.addEventListener("autoapply-leaving", () => ran.push("driver"));
  const e = new Event("beforeunload", { cancelable: true });
  dispatchEvent(e);
  expect(ran).toEqual(["driver"]);
  expect(e.defaultPrevented).toBe(false);
});
