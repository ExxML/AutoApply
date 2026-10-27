// Résumé variants: the upload for a job is the résumé whose label best names it, decided in code (no AI call).
import { normalize } from "../../shared/normalize";
import type { DocumentMeta, JobContext } from "../../shared/types";

const FILLER = new Set(["resume", "cv", "and", "for", "the", "of", "my", "a", "an", "to", "in"]);

/** "Résumé – ML/Data Engineering" → {ml, data, engineer}: "Engineering" meets "Engineer", "Systems" meets "System". */
const words = (s: string) =>
  new Set(
    normalize(s.replace(/[^\p{L}\p{N}+#]/gu, " "))
      .split(" ")
      .filter((w) => w && !FILLER.has(w))
      .map((w) => (w.length > 4 ? w.replace(/(ing|s)$/, "") : w)),
  );

/**
 * The résumé whose label shares the most words with the job's title, then with its description; the primary one
 * when no label shares a word with the title, so a vague match never swaps out the résumé the user chose.
 */
export function pickResume(docs: DocumentMeta[], job: JobContext | null): string | null {
  const resumes = docs.filter((d) => d.kind === "resume").sort((a, b) => +b.isPrimaryResume - +a.isPrimaryResume);
  let best = resumes[0]?.id ?? null;
  if (resumes.length < 2 || !job) return best;
  const title = words(job.jobTitle);
  const desc = words(job.text || job.header || "");
  let top = [0, 0];
  for (const d of resumes) {
    const label = [...words(d.label)];
    const s = [label.filter((w) => title.has(w)).length, label.filter((w) => desc.has(w)).length];
    if (s[0] > top[0] || (s[0] && s[0] === top[0] && s[1] > top[1])) [best, top] = [d.id, s];
  }
  return best;
}
