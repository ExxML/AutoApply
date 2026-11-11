// Jobs open in the user's tabs (popup "YOLO apply to job tabs"), each applied to in its own tab. Kept apart from the
// queue: they run whether YOLO is on or not, ahead of it, and a browser restart (new tab ids) drops them.
import { session } from "../../shared/storage";
import type { QueueItem } from "../../shared/yolo";

const KEY = "yoloTabJobs";
let changing: Promise<unknown> = Promise.resolve();

export const tabJobs = async () => (await session.get<QueueItem[]>(KEY)) ?? [];

/** `fn` returns the new list; serialized, so two changes can't drop each other's jobs. */
export function updateTabJobs(fn: (jobs: QueueItem[]) => QueueItem[]): Promise<void> {
  const next = changing.then(async () => session.set(KEY, fn(await tabJobs())));
  changing = next.catch(() => undefined);
  return next;
}
