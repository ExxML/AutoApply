// Runs in the page's own (MAIN) world. In a hidden tab Chrome wakes the page's timers at most once a second, so a
// widget's search debounce or next-page loader would stall a fill the user left running in the background. While a
// fill runs there, short timers are also fired by the content script's unthrottled sleep (fill/events.ts); the
// page's own timer stays as the fallback. Outside a fill, or in a visible tab, nothing changes.
// YOLO's hidden host (an offscreen document's frame) throttles timers the same way while reporting itself visible.
const ao = location.ancestorOrigins;
const inHost = !!ao?.length && ao[ao.length - 1].startsWith("chrome-extension://");
let filling = false;
document.addEventListener("autoapply-fill-start", () => (filling = true));
document.addEventListener("autoapply-fill-end", () => (filling = false));

const pending = new Map<string, () => void>();
const set = window.setTimeout;
const clear = window.clearTimeout;

window.setTimeout = function (handler: TimerHandler, ms = 0, ...args: unknown[]) {
  if (!filling || !(document.hidden || inHost) || typeof handler !== "function" || ms >= 1000)
    return set(handler, ms, ...args);
  const run = () => {
    pending.delete(key);
    clear(id); // whichever fires first cancels the other
    (handler as (...a: unknown[]) => void)(...args);
  };
  const id = set(run, ms);
  const key = String(id);
  pending.set(key, run);
  document.dispatchEvent(new CustomEvent("autoapply-timer", { detail: `${key}:${ms}` }));
  return id;
} as typeof window.setTimeout;

window.clearTimeout = ((id?: number) => {
  pending.delete(String(id));
  clear(id);
}) as typeof window.clearTimeout;

document.addEventListener("autoapply-timer-fire", (e) => pending.get((e as CustomEvent<string>).detail)?.());

// In the hidden host, a page's popup (an "Apply" that opens the ATS in a new window) would be a visible tab: it
// loads in the same frame instead. The frame's name (src/offscreen/host.ts) tells it from other extensions' frames.
if (inHost && ao.length === 1 && window.name === "autoapply-yolo")
  window.open = ((url?: string | URL) => {
    if (url) location.href = String(url);
    return window;
  }) as typeof window.open;

export {};
