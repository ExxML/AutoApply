// §11.7 per-tab job context in chrome.storage.session.
import { session } from "../shared/storage";
import type { JobContext } from "../shared/types";

const MAX_AGE = 2 * 3600 * 1000;
const fresh = (c: JobContext | null): c is JobContext => !!c && Date.now() - c.capturedAt < MAX_AGE;

export async function setJobContext(tabId: number, ctx: JobContext): Promise<void> {
  const prev = await session.getJobContext(tabId);
  // A page without a description (e.g. step 2 of an application) keeps the earlier description.
  if (!ctx.text && fresh(prev) && prev.text) return;
  await session.setJobContext(tabId, ctx);
}

export async function getJobContext(tabId: number): Promise<JobContext | null> {
  const c = await session.getJobContext(tabId);
  return fresh(c) ? c : null;
}
