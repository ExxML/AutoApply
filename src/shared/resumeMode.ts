// How résumé upload fields are answered (Behavior / YOLO → Upload résumés), and whether that can work at all.
import type { DocumentMeta } from "./types";

export type ResumeUpload = "variants" | "tailor" | "flag";

/** Session documents holding a résumé tailored for one job (background/services/tailorResume.ts). */
export const isTailoredDoc = (id: string) => id.startsWith("tailor-");
/** The id the AI is offered, in tailor mode, for a file field it decides wants the résumé. */
export const TAILOR_PLACEHOLDER = "tailored-resume";

/**
 * Why résumé uploads can't be answered in this mode, "" when they can. Fills and YOLO stop on it: an application
 * without the résumé the user chose would go out wrong.
 */
export function resumeProblem(
  mode: ResumeUpload,
  docs: Pick<DocumentMeta, "kind">[],
  tailorReady: boolean,
  who = "Autofill",
): string {
  if (mode === "tailor" && !tailorReady)
    return `AI tailor is selected for ${who}, but no LaTeX résumé is uploaded. Upload one in Documents.`;
  if (mode === "variants" && !docs.some((d) => d.kind === "resume"))
    return `Variant select is selected for ${who}, but no résumé is uploaded. Upload one in Documents.`;
  return "";
}
