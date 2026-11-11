// Tabs held at a CAPTCHA for the user: the filled form waits there, the queue goes on, and opening the application
// later drives the same page on from the challenge (index.ts adopt) instead of starting over.
import { session } from "../../shared/storage";
import type { Run } from "./runner";

const KEY = "yoloParked";
/** Each holds a live application page in memory. */
export const MAX_PARKED = 3;
type Parked = Record<string, Run>;
let changing: Promise<unknown> = Promise.resolve();

function change<T>(fn: (p: Parked) => Promise<T>): Promise<T> {
  const next = changing.then(async () => fn((await session.get<Parked>(KEY)) ?? {}));
  changing = next.catch(() => undefined);
  return next;
}

const release = (tabId?: number) =>
  tabId === undefined ? undefined : chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => undefined);

export const parkedKeys = async () => Object.keys((await session.get<Parked>(KEY)) ?? {});

/** Holds the run's tab for the user; false at the limit (tabs closed since don't count). */
export const park = (key: string, run: Run) =>
  change(async (p) => {
    for (const [k, r] of Object.entries(p))
      if (r.tabId === undefined || !(await chrome.tabs.get(r.tabId).catch(() => null))) delete p[k];
    if (run.tabId === undefined || (!p[key] && Object.keys(p).length >= MAX_PARKED)) {
      await session.set(KEY, p);
      return false;
    }
    p[key] = run;
    await session.set(KEY, p);
    // Chrome's memory saver would reload it, losing the form.
    await chrome.tabs.update(run.tabId, { autoDiscardable: false }).catch(() => undefined);
    return true;
  });

/** The parked run for this application, no longer held. */
export const takeParked = (key: string) =>
  change(async (p) => {
    const run = p[key];
    if (!run) return null;
    delete p[key];
    await session.set(KEY, p);
    await release(run.tabId);
    return run;
  });

export const dropParked = (key: string) => takeParked(key).then(() => undefined);
