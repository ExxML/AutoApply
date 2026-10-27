// Résumé variants: the upload for a job is the résumé that best fits it, decided in code (no AI call).
import { normalize } from "../../shared/normalize";
import type { DocumentMeta, JobContext } from "../../shared/types";

// Words every posting or résumé uses: one variant happening to have "using" must not outweigh "React".
const FILLER = new Set(
  (
    "resume cv a an the and or of for to in on at by with from as is are be been was were will would can could " +
    "should may must our we you your us it its this that these those their they he she his her my me i not no " +
    "all any each more most other such than then into over about across within who what when where which how " +
    "also new well work working team role job position experience year month company including etc help " +
    "build built develop developed design designed strong ability skill knowledge understanding plus great"
  ).split(" "),
);

/** "Node.js/React apps" → [node, js, react, app]: "Engineering" meets "Engineer", "Systems" meets "System". */
const terms = (s: string) =>
  normalize(s.replace(/[^\p{L}\p{N}+#]/gu, " "))
    .split(" ")
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !FILLER.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|s)$/, "") : w));

/**
 * The résumé that best fits the job: each word of the job's description (up to 3 uses) and title (3 more) counts
 * for the résumés whose label or text has it, more the fewer of them do. Words all variants share cancel out, so
 * a JavaScript and a Systems résumé are told apart by what differs ("React" vs "kernel"). With no difference
 * found, the primary résumé.
 */
export function pickResume(docs: DocumentMeta[], job: JobContext | null, texts: Record<string, string>): string | null {
  const resumes = docs.filter((d) => d.kind === "resume").sort((a, b) => +b.isPrimaryResume - +a.isPrimaryResume);
  let best = resumes[0]?.id ?? null;
  if (resumes.length < 2 || !job) return best;
  const weight = new Map<string, number>();
  for (const w of terms(job.text || job.header || "")) weight.set(w, Math.min((weight.get(w) ?? 0) + 1, 3));
  for (const w of new Set(terms(job.jobTitle))) weight.set(w, (weight.get(w) ?? 0) + 3);
  const sets = resumes.map((d) => new Set(terms(`${d.label} ${texts[d.id] ?? ""}`)));
  const rarity = new Map(
    [...weight.keys()].map((w) => [w, Math.log(resumes.length / Math.max(1, sets.filter((s) => s.has(w)).length))]),
  );
  let top = 0;
  sets.forEach((set, i) => {
    let score = 0;
    for (const [w, n] of weight) if (set.has(w)) score += n * rarity.get(w)!;
    if (score > top) [best, top] = [resumes[i].id, score];
  });
  return best;
}
