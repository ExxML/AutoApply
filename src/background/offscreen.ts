// The extension's one offscreen document, shared: YOLO's hidden frame (yolo/host.ts) and the LaTeX engine that
// compiles tailored résumés (services/tailorResume.ts). It exists only while one of them uses it.
import { session } from "../shared/storage";

const OFFSCREEN = "src/offscreen/index.html";
const users = new Map<string, number>();
let creating: Promise<void> | null = null;

export async function useOffscreen(user: "yolo" | "latex"): Promise<void> {
  users.set(user, user === "yolo" ? 1 : (users.get(user) ?? 0) + 1);
  if (await chrome.offscreen.hasDocument()) return;
  // Concurrent callers share one creation: a second createDocument would throw.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: ["IFRAME_SCRIPTING", "WORKERS"] as chrome.offscreen.Reason[],
      justification: "Applies to jobs in a hidden frame while YOLO mode is on, and compiles tailored LaTeX résumés.",
    })
    .finally(() => (creating = null));
  await creating;
}

/** Closes the document once nobody uses it: a YOLO run in the hidden frame, or a compile. */
export async function releaseOffscreen(user: "yolo" | "latex"): Promise<void> {
  const n = (users.get(user) ?? 1) - 1;
  if (n > 0 && user === "latex") users.set(user, n);
  else users.delete(user);
  if (users.size) return;
  // In-memory counts don't survive a service-worker restart; a run in the frame still needs it.
  if (user === "latex" && (await session.get<{ host: string }>("yoloRun"))?.host === "frame") return;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

/** Whether a compile is using the document, so YOLO leaves it open when it is done with its frame. */
export const compiling = () => users.has("latex");
