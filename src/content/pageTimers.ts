// Runs in the page's own (MAIN) world. In a hidden tab Chrome wakes the page's timers at most once a second, so a
// widget's search debounce or next-page loader would stall a fill the user left running in the background. While a
// fill runs there, short timers are also fired by the content script's unthrottled sleep (fill/events.ts); the
// page's own timer stays as the fallback. Outside a fill, or in a visible tab, nothing changes.
let filling = false;
document.addEventListener("autoapply-fill-start", () => (filling = true));
document.addEventListener("autoapply-fill-end", () => (filling = false));

const pending = new Map<string, () => void>();
const set = window.setTimeout;
const clear = window.clearTimeout;

window.setTimeout = function (handler: TimerHandler, ms = 0, ...args: unknown[]) {
  if (!filling || !document.hidden || typeof handler !== "function" || ms >= 1000) return set(handler, ms, ...args);
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

export {};
