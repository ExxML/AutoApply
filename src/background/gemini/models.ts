// §10.3 model list: filter → track firstSeenAt → sort newest-added first.
import { EXCLUDED_MODEL_PATTERNS } from "../../shared/constants";
import type { CatalogEntry } from "../../shared/types";

export interface ApiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

const DAY = 24 * 3600 * 1000;

export const modelId = (name: string): string => name.replace(/^models\//, "");

export function isTextModel(m: ApiModel): boolean {
  const id = modelId(m.name).toLowerCase();
  return (
    !!m.supportedGenerationMethods?.includes("generateContent") && !EXCLUDED_MODEL_PATTERNS.some((p) => id.includes(p))
  );
}

/** Merge a fresh models.list result into the catalog (only text models are tracked). */
export function updateCatalog(
  catalog: Record<string, CatalogEntry>,
  apiModels: ApiModel[],
  now: number,
): Record<string, CatalogEntry> {
  const next: Record<string, CatalogEntry> = {};
  for (const [id, e] of Object.entries(catalog)) if (now - e.lastSeenAt <= 30 * DAY) next[id] = e;
  apiModels.forEach((m, apiIndex) => {
    if (!isTextModel(m)) return;
    const id = modelId(m.name);
    const prev = next[id];
    next[id] = {
      firstSeenAt: prev?.firstSeenAt ?? now,
      apiIndex: prev?.apiIndex ?? apiIndex,
      displayName: m.displayName ?? id,
      description: m.description ?? "",
      inputTokenLimit: m.inputTokenLimit ?? 0,
      outputTokenLimit: m.outputTokenLimit ?? 0,
      thinking: m.thinking,
      lastSeenAt: now,
    };
  });
  return next;
}

function version(id: string): [number, number] | null {
  const m = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** Trailing date code as a sortable number: MM-YYYY → YYYYMM00, MMDD → (current year)MMDD. */
function dateCode(id: string, year: number): number | null {
  let m = /-(\d{2})-(\d{4})$/.exec(id);
  if (m) return Number(m[2]) * 10000 + Number(m[1]) * 100;
  m = /-(\d{4})$/.exec(id);
  if (m) return year * 10000 + Number(m[1]);
  return null;
}

export function compareModels(a: [string, CatalogEntry], b: [string, CatalogEntry], year: number): number {
  const [ia, ea] = a;
  const [ib, eb] = b;
  if (ea.firstSeenAt !== eb.firstSeenAt) return eb.firstSeenAt - ea.firstSeenAt;
  const va = version(ia);
  const vb = version(ib);
  if (va && !vb) return -1;
  if (!va && vb) return 1;
  if (va && vb) {
    if (va[0] !== vb[0]) return vb[0] - va[0];
    if (va[1] !== vb[1]) return vb[1] - va[1];
  }
  const da = dateCode(ia, year);
  const db = dateCode(ib, year);
  if (da !== null && db === null) return -1;
  if (da === null && db !== null) return 1;
  if (da !== null && db !== null && da !== db) return db - da;
  if (ea.apiIndex !== eb.apiIndex) return eb.apiIndex - ea.apiIndex;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Models present in the latest fetch, sorted newest-added first. */
export function visibleModels(
  catalog: Record<string, CatalogEntry>,
  fetchedAt: number,
  now = Date.now(),
): [string, CatalogEntry][] {
  const year = new Date(now).getFullYear();
  return Object.entries(catalog)
    .filter(([, e]) => e.lastSeenAt >= fetchedAt)
    .sort((a, b) => compareModels(a, b, year));
}

export function modelBadges(id: string, e: CatalogEntry, catalog: Record<string, CatalogEntry>, now = Date.now()) {
  const earliest = Math.min(...Object.values(catalog).map((c) => c.firstSeenAt));
  const badges: string[] = [];
  if (/preview|exp/.test(id)) badges.push("Preview");
  if (id.endsWith("-latest")) badges.push("Alias");
  if (now - e.firstSeenAt < 7 * DAY && e.firstSeenAt > earliest) badges.push("New");
  return badges;
}

/** §10.3.5: first flash-lite, else first flash, else first. */
export function defaultModel(sortedIds: string[]): string | null {
  return (
    sortedIds.find((id) => id.includes("flash-lite")) ??
    sortedIds.find((id) => id.includes("flash")) ??
    sortedIds[0] ??
    null
  );
}
