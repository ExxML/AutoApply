// Jobs open in the user's tabs (popup "YOLO apply to job tabs"), each applied to in its own tab. Kept apart from the
// queue: they run whether YOLO is on or not, ahead of it, and a browser restart (new tab ids) drops them.
import { session } from "../../shared/storage";
import type { QueueItem, TabsRead } from "../../shared/yolo";

const KEY = "yoloTabJobs";
let changing: Promise<unknown> = Promise.resolve();

export const tabJobs = async () => (await session.get<QueueItem[]>(KEY)) ?? [];

/** `fn` returns the new list; serialized, so two changes can't drop each other's jobs. */
export function updateTabJobs(fn: (jobs: QueueItem[]) => QueueItem[]): Promise<void> {
  const next = changing.then(async () => session.set(KEY, fn(await tabJobs())));
  changing = next.catch(() => undefined);
  return next;
}

// The popup's tab reads in flight: in memory, so a restarted worker can't leave the popup stuck on "Reading tabs…".
let reading = 0;
const READ = "yoloTabsRead";
export const tabsReading = () => reading > 0;
export const tabsRead = () => session.get<TabsRead>(READ);
export const forgetTabsRead = () => session.remove(READ);

/** Runs a read of the window's tabs, keeping its outcome for the popup, which may close before it ends. */
export async function readTabs<T>(read: () => Promise<T>, outcome: (r: T) => Promise<TabsRead>): Promise<T> {
  reading++;
  await forgetTabsRead();
  let kept: TabsRead = { error: "Couldn't read this window's tabs. Please try again." };
  try {
    const r = await read();
    kept = await outcome(r);
    return r;
  } finally {
    reading--;
    await session.set(READ, kept);
  }
}
