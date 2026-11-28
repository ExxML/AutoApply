// Every application's answers and the résumé and cover letter it went with, kept until the user deletes them
// (Applications page). One storage key per application, so the often-rewritten application list stays small.
import { isTailoredDoc } from "../../shared/resumeMode";
import { createStorage, session, type SavedApplication } from "../../shared/storage";
import type { DocumentMeta } from "../../shared/types";
import type { Guess } from "../../shared/yolo";
import { FALLBACK, tailoredDoc } from "../services/tailorResume";
import { serial } from "./applicationStore";

const store = createStorage("background");
const saves = serial();

export const isYoloDoc = (id: string) => id.startsWith("yolo-");
export const yoloDoc = (id: string) => session.get<{ meta: DocumentMeta; base64: string }>(`yolodoc:${id}`);

/** The résumés and cover letters uploaded, by name, and the files AutoApply made for the job as uploaded. */
async function uploaded(ids: string[]) {
  const docs = await store.get("documentsIndex");
  const up = { resume: [] as string[], letter: [] as string[], files: [] as SavedApplication["files"] };
  for (const id of ids) {
    if (isTailoredDoc(id) || isYoloDoc(id)) {
      const d = await (isYoloDoc(id) ? yoloDoc(id) : tailoredDoc(store, id));
      if (d) up.files.push({ name: d.meta.fileName, base64: d.base64 });
      if (isYoloDoc(id)) up.letter.push(`Generated (${d?.meta.fileName ?? "file no longer kept"})`);
      // The untailored PDF made when the .tex was uploaded, or a tailoring a browser restart lost.
      else up.resume.push(d && id !== FALLBACK ? `Tailored (${d.meta.fileName})` : "Untailored LaTeX résumé");
      continue;
    }
    const d = docs.find((x) => x.id === id);
    if (d?.kind === "resume") up.resume.push(d.label);
    else if (d?.kind === "cover_letter") up.letter.push(d.label);
  }
  return up;
}

/**
 * Keeps `key`'s answers and uploads, merged into what an earlier attempt at it kept (a resumed run): answers to the
 * same question are replaced, the documents too when this attempt uploaded any.
 */
export const saveResponses = (key: string, answers: Guess[], uploads: string[]) =>
  saves(async () => {
    const [old, up, index] = await Promise.all([
      store.getSaved(key),
      uploaded([...new Set(uploads)]),
      store.get("savedIndex"),
    ]);
    if (!old && !answers.length && !up.resume.length && !up.letter.length) return;
    const asked = new Set(answers.map((g) => g.q));
    const uploadedAny = up.resume.length + up.letter.length > 0;
    const rec: SavedApplication = {
      at: Date.now(),
      answers: [...(old?.answers.filter((g) => !asked.has(g.q)) ?? []), ...answers],
      resume: uploadedAny || !old ? up.resume : old.resume,
      letter: uploadedAny || !old ? up.letter : old.letter,
      files: uploadedAny || !old ? up.files : old.files,
    };
    await chrome.storage.local.set({
      [`saved:${key}`]: rec,
      savedIndex: { ...index, [key]: JSON.stringify(rec).length },
    });
  });

/** Deletes the saved answers and files of these applications; the applications themselves stay. */
export const deleteSaved = (keys: string[]) =>
  saves(async () => {
    const index = await store.get("savedIndex");
    const gone = keys.filter((k) => k in index);
    if (!gone.length) return;
    for (const k of gone) delete index[k];
    await chrome.storage.local.remove(gone.map((k) => `saved:${k}`));
    await store.set({ savedIndex: index });
  });
