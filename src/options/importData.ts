import { z } from "zod";
import { ProfileSchema } from "../shared/profileSchema";
import { SettingsSchema } from "../shared/settings";
import {
  ApiKeyEntrySchema,
  createStorage,
  DocumentMetaSchema,
  LOCAL_SCHEMAS,
  type LocalKey,
  type LocalValues,
} from "../shared/storage";
import { migrateYoloReview } from "../shared/yolo";
import { PROFILE_GROUPS, type FieldSpec } from "./profileFields";

/** Browser-specific connections, passwords, logs and run state are deliberately excluded. */
export const CARRIED = [
  "modelCatalog",
  "modelListFetchedAt",
  "modelCapabilities",
  "yoloQueue",
  "yoloInFlight",
  "yoloSourceCheck",
  "yoloRejected",
  "yoloTabHosts",
  "employerBoards",
] as const satisfies LocalKey[];

export const ExportSchema = z.object({
  app: z.literal("autoapply"),
  version: z.literal(1),
  profile: z.unknown(),
  settings: z.unknown(),
  documents: z.array(z.object({ meta: DocumentMetaSchema, base64: z.string() })).optional(),
  apiKeys: z.array(ApiKeyEntrySchema).optional(),
  selectedModel: z.string().nullable(),
  fallbackModel: z.string().nullable(),
  reviewModel: z.string().nullable().optional(),
  yolo: z.unknown().optional(),
  applications: z.unknown().optional(),
  local: z.record(z.string(), z.unknown()).optional(),
  tailorResume: z
    .object({
      info: LOCAL_SCHEMAS.tailorResume.unwrap(),
      tex: z.string(),
      pdf: z.string(),
      fallbackPdf: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type Export = z.infer<typeof ExportSchema>;
type Storage = ReturnType<typeof createStorage>;
const IMPORT_KEYS = [
  "profile",
  "settings",
  "documentsIndex",
  "apiKeys",
  "selectedModel",
  "fallbackModel",
  "reviewModel",
  "yolo",
  "applications",
  "keyState",
  "yoloState",
  "tailorResume",
  "resumeTexts",
  ...CARRIED,
] as const;
type Values = Pick<LocalValues, (typeof IMPORT_KEYS)[number]>;
type Document = NonNullable<Export["documents"]>[number];

export interface ImportSnapshot {
  values: Values;
  documents: Document[];
  tailorResume: Export["tailorResume"];
}

export interface ImportChange {
  id: string;
  key: LocalKey;
  path: string[];
  page: string;
  section: string;
  label: string;
  before: unknown;
  after: unknown;
  kind: "value" | "item" | "order" | "document" | "tailor";
  collection?: string;
  oldIndex?: number;
  newIndex?: number;
}
interface Collection {
  id: string;
  key: LocalKey;
  path: string[];
  before: unknown[];
  after: unknown[];
  /** Incoming index → existing index; null is a new entry. */
  matches: (number | null)[];
}
export interface ImportPlan {
  changes: ImportChange[];
  collections: Collection[];
  snapshot: ImportSnapshot;
}

export async function readImportSnapshot(store: Storage): Promise<ImportSnapshot> {
  const values = await store.getMany([...IMPORT_KEYS]);
  const documents = await Promise.all(
    values.documentsIndex.map(async (meta) => ({
      meta,
      base64: (await store.getDoc(meta.id)) ?? "",
    })),
  );
  const info = values.tailorResume;
  const tailorResume = info && {
    info,
    tex: (await store.getDoc("tailor-tex")) ?? "",
    pdf: (await store.getDoc("tailor-pdf")) ?? "",
    fallbackPdf: (await store.getDoc("tailor-fallback-pdf")) ?? undefined,
  };
  return { values, documents, tailorResume };
}

export function equalImportValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (k) =>
        Object.hasOwn(b, k) && equalImportValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const valueAt = (v: unknown, path: string[]): unknown =>
  path.reduce<unknown>((part, key) => (object(part) && Object.hasOwn(part, key) ? part[key] : undefined), v);
function put(target: Record<string, unknown>, path: string[], value: unknown) {
  let part = target;
  for (const k of path.slice(0, -1)) {
    if (!Object.hasOwn(part, k) || !object(part[k]))
      Object.defineProperty(part, k, { value: {}, writable: true, enumerable: true, configurable: true });
    part = part[k] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete part[last];
  else
    Object.defineProperty(part, last, {
      value: structuredClone(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
}

export const importLabel = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
const profileFields = new Map<string, { section: string; label: string }>();
for (const group of PROFILE_GROUPS) {
  const add = (field: FieldSpec) => {
    profileFields.set(field.path, { section: group.title, label: field.label });
    if (field.extra) add(field.extra);
  };
  for (const item of group.items) {
    if ("card" in item) profileFields.set(item.path, { section: group.title, label: `${item.title} entries` });
    else add(item);
  }
}

/** Page and subsection names mirror the settings UI, including settings stored on a different storage key. */
const SETTINGS_GROUPS: [string, string, string[]][] = [
  ["Profile", "Essay guidance", ["essayDefaultWords", "coverLetterDefaultWords", "coverLetterOnePage"]],
  ["Documents", "AI tailoring prompt", ["tailorPrompt", "tailorOnePage"]],
  ["AI", "Provider", ["aiProvider", "geminiFill"]],
  ["AI", "Models", ["claude", "reviewTimeoutMs"]],
];
const YOLO_GROUPS: [string, string[]][] = [
  ["Schedule", ["enabled", "intervalMin", "batchSize"]],
  [
    "Search",
    [
      "queries",
      "locations",
      "remoteOk",
      "postedWithinDays",
      "excludeTitleWords",
      "skipCompanies",
      "aiRelevanceCheck",
      "aiRejectDays",
    ],
  ],
  [
    "Sources",
    ["boards", "feeds", "jobright", "careerSites", "queueSort", "queueBySource", "addedPlacement", "sourceOrder"],
  ],
  ["Review before submission", ["submissionReview"]],
  ["Already applied", ["reapplyManual", "warnOnYoloApplied"]],
];
const LABELS: Record<string, string> = {
  "settings.overwritePrefilled": "Overwrite pre-filled fields",
  "settings.autoAcceptAcknowledgements": "Auto-accept required consents",
  "settings.coverLetterPdfs": "Write cover letters",
  "settings.resumeUpload": "Upload résumés",
  "settings.reviewFills": "Review manual fills with AI",
  "settings.learnPrompts": "Offer to save my answers",
  "settings.maxFieldsPerRequest": "Fields per AI request",
  "settings.maxConcurrentRequests": "Parallel AI requests",
  "settings.excludedHosts": "Excluded sites",
  "settings.essayDefaultWords": "Essay length (words)",
  "settings.coverLetterDefaultWords": "Cover letter length (words)",
  "settings.coverLetterOnePage": "Keep generated cover letters to one page",
  "settings.tailorOnePage": "Keep the tailored résumé to one page",
  "yolo.enabled": "Turn YOLO off after import",
  "yolo.intervalMin": "Apply batch every (minutes)",
  "yolo.batchSize": "Applications per batch",
  "yolo.queries": "Search queries",
  "yolo.remoteOk": "Include remote jobs",
  "yolo.excludeTitleWords": "Skip titles with",
  "yolo.aiRelevanceCheck": "Check matches with AI",
  "yolo.aiRejectDays": "Remember AI rejections (days)",
  "yolo.feeds": "GitHub job lists",
  "yolo.careerSites": "Company career sites",
  "yolo.email": "YOLO email",
  "yolo.emailCodes": "Use emailed access codes",
  "yolo.verifyLinks": "Open job verification links",
  "yolo.tabFallback": "Retry in a background tab",
  "yolo.optionalCoverLetters": "Write optional cover letters",
  "yolo.resumeUpload": "Upload résumés",
  "yolo.reviewFills": "Review YOLO fills with AI",
  "yolo.aiNavigation": "Use AI navigation when stuck",
  "yolo.reapplyManual": "Re-apply to jobs I submitted myself",
  "yolo.warnOnYoloApplied": "Warn me on jobs already applied to",
};
function location(key: LocalKey, path: string[]): { page: string; section: string; label: string } {
  const first = path[0] ?? "";
  const label = LABELS[`${key}.${path.join(".")}`] ?? path.map(importLabel).join(" › ");
  if (key === "profile") {
    if (first === "resumeText") return { page: "Documents", section: "Résumé text", label: "Résumé text" };
    if (first === "learnedAnswers") return { page: "Saved Answers", section: "Saved answers", label: "Saved answer" };
    const field = profileFields.get(path.join("."));
    return { page: "Profile", section: field?.section ?? importLabel(first), label: field?.label ?? label };
  }
  if (key === "settings") {
    const group = SETTINGS_GROUPS.find(([, , keys]) => keys.includes(first));
    return { page: group?.[0] ?? "Behavior", section: group?.[1] ?? "Autofill settings", label };
  }
  if (key === "yolo")
    return {
      page: "YOLO Mode",
      section: YOLO_GROUPS.find(([, keys]) => keys.includes(first))?.[0] ?? "Applying",
      label,
    };
  const groups: Partial<Record<LocalKey, [string, string, string]>> = {
    documentsIndex: ["Documents", "Upload", "Document"],
    tailorResume: ["Documents", "Résumé for AI tailoring (.tex)", "AI tailoring résumé and fallback PDF"],
    apiKeys: ["AI", "API keys", "API key"],
    keyState: ["AI", "API key status", "Key status"],
    selectedModel: ["AI", "Model", "Selected model"],
    fallbackModel: ["AI", "Model", "Fallback model"],
    reviewModel: ["AI", "Model", "Review model"],
    modelCatalog: ["AI", "Model caches", "Model catalog"],
    modelListFetchedAt: ["AI", "Model caches", "Model list last fetched"],
    modelCapabilities: ["AI", "Model caches", "Model capabilities"],
    applications: ["Applications", "Application history", "Application"],
    yoloQueue: ["Applications", "Queued jobs", "Queued job"],
    yoloInFlight: ["Applications", "Queued jobs", "Interrupted job (recovered into the queue or history)"],
    yoloState: ["Applications", "Current batch", "Current batch"],
    yoloSourceCheck: ["Applications", "Source check", "Source check"],
    yoloRejected: ["YOLO Mode", "Search history", "AI rejections"],
    yoloTabHosts: ["YOLO Mode", "Applying", "Sites needing a background tab"],
    employerBoards: ["YOLO Mode", "Sources", "Company board lookups"],
  };
  const group = groups[key] ?? ["Data", "Other data", importLabel(key)];
  return { page: group[0], section: group[1], label: path.length ? `${group[2]} › ${label}` : group[2] };
}

function entryIdentity(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const v = object(value.meta) ? value.meta : value;
  if (typeof v.id === "string") return `id:${v.id}`;
  if (typeof v.key === "string") return `key:${v.key}`;
  for (const fields of [
    ["school", "degree"],
    ["company", "title"],
    ["organization", "role"],
    ["name"],
    ["country"],
    ["language"],
    ["url"],
  ]) {
    if (fields.every((f) => typeof v[f] === "string" && v[f])) return JSON.stringify(fields.map((f) => v[f]));
  }
  return undefined;
}
export function importEntryLabel(value: unknown): string {
  if (!object(value)) return String(value ?? "");
  const v = object(value.meta) ? value.meta : value;
  return (
    [
      v.label,
      v.fileName,
      v.question,
      v.school,
      v.name,
      v.language,
      v.country,
      [v.title ?? v.role, v.company ?? v.organization].filter(Boolean).join(" · "),
      v.url,
      v.id,
    ].find((x): x is string => typeof x === "string" && !!x) ?? "Entry"
  );
}

export function buildImportPlan(data: Export, snapshot: ImportSnapshot): ImportPlan {
  const plan: ImportPlan = { changes: [], collections: [], snapshot };
  const add = (key: LocalKey, path: string[], before: unknown, after: unknown, extra: Partial<ImportChange> = {}) => {
    if (equalImportValues(before, after) && extra.kind !== "order") return;
    plan.changes.push({
      id: JSON.stringify([key, path, extra.kind ?? "value", extra.oldIndex, extra.newIndex]),
      key,
      path,
      before,
      after,
      kind: "value",
      ...location(key, path),
      ...extra,
    });
  };
  const collection = (key: LocalKey, path: string[], before: unknown[], after: unknown[], documents = false) => {
    const id = JSON.stringify([key, path]);
    const unused = new Set(before.map((_, i) => i));
    const exact = new Map<string, number[]>();
    const identities = new Map<string, number[]>();
    const indexValue = (map: Map<string, number[]>, key: string, index: number) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(index);
    };
    for (let i = before.length - 1; i >= 0; i--) {
      const signature = JSON.stringify(before[i]);
      indexValue(exact, signature, i);
      const identity = entryIdentity(before[i]);
      if (identity !== undefined) indexValue(identities, identity, i);
    }
    const take = (bucket: number[] | undefined) => {
      while (bucket?.length) {
        const index = bucket.pop()!;
        if (unused.has(index)) return index;
      }
      return undefined;
    };
    const matches = after.map((value) => {
      let index = take(exact.get(JSON.stringify(value)));
      const identity = entryIdentity(value);
      if (index === undefined && identity !== undefined) index = take(identities.get(identity));
      if (index === undefined) return null;
      unused.delete(index);
      return index;
    });
    plan.collections.push({ id, key, path, before, after, matches });
    for (let i = 0; i < after.length; i++) {
      const oldIndex = matches[i] ?? undefined;
      add(key, path, oldIndex === undefined ? undefined : before[oldIndex], after[i], {
        kind: documents ? "document" : "item",
        collection: id,
        oldIndex,
        newIndex: i,
        label: object(after[i])
          ? importEntryLabel(after[i])
          : `${location(key, path).label}: ${importEntryLabel(after[i])}`,
      });
    }
    for (const i of unused)
      add(key, path, before[i], undefined, {
        kind: documents ? "document" : "item",
        collection: id,
        oldIndex: i,
        label: object(before[i])
          ? importEntryLabel(before[i])
          : `${location(key, path).label}: ${importEntryLabel(before[i])}`,
      });
    // Entry selection and order are independent. Keeping an entry never silently deletes it when importing order.
    const natural = [
      ...before.map((_, i) => i).filter((i) => !unused.has(i)),
      ...matches.flatMap((i, j) => (i === null ? [`new:${j}`] : [])),
    ];
    const incoming = matches.map((i, j) => i ?? `new:${j}`);
    if (!equalImportValues(natural, incoming))
      add(key, path, before.map(importEntryLabel), after.map(importEntryLabel), {
        kind: "order",
        collection: id,
        label: `${location(key, path).label}: list order`,
      });
  };
  const walk = (key: LocalKey, before: unknown, after: unknown, path: string[] = []) => {
    if (equalImportValues(before, after)) return;
    if (Array.isArray(after) || Array.isArray(before)) {
      collection(key, path, Array.isArray(before) ? before : [], Array.isArray(after) ? after : []);
    } else if (object(before) && object(after)) {
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
        walk(
          key,
          Object.hasOwn(before, name) ? before[name] : undefined,
          Object.hasOwn(after, name) ? after[name] : undefined,
          [...path, name],
        );
    } else add(key, path, before, after);
  };
  const current = snapshot.values;
  walk("profile", current.profile, ProfileSchema.parse(data.profile));
  const settings = SettingsSchema.parse(data.settings);
  walk("settings", current.settings, settings);
  for (const key of ["selectedModel", "fallbackModel", "reviewModel"] as const)
    if (data[key] !== undefined) walk(key, current[key], data[key]);
  if (data.yolo) walk("yolo", current.yolo, { ...migrateYoloReview(data.yolo, settings.reviewFills), enabled: false });
  if (data.applications)
    walk("applications", current.applications, LOCAL_SCHEMAS.applications.parse(data.applications));
  if (data.apiKeys) walk("apiKeys", current.apiKeys, data.apiKeys);
  for (const key of [...CARRIED, ...(data.apiKeys ? ["keyState" as const] : [])])
    if (data.local && Object.hasOwn(data.local, key)) {
      const next = LOCAL_SCHEMAS[key].parse(data.local[key]);
      // Runtime records are selected together so a partial source check or interrupted job can't be malformed.
      if (key === "yoloSourceCheck" || key === "yoloInFlight") add(key, [], current[key], next);
      else walk(key, current[key], next);
    }
  if (data.local?.yoloState) {
    const { batchAt, queueOnlyBatch } = LOCAL_SCHEMAS.yoloState.parse(data.local.yoloState);
    walk(
      "yoloState",
      { batchAt: current.yoloState.batchAt, queueOnlyBatch: current.yoloState.queueOnlyBatch },
      { batchAt, queueOnlyBatch },
    );
  }
  if (data.documents) collection("documentsIndex", [], snapshot.documents, data.documents, true);
  if (data.tailorResume !== undefined) {
    const incoming = data.tailorResume;
    const after = incoming && {
      ...incoming,
      info: incoming.info && {
        ...incoming.info,
        fallback: incoming.fallbackPdf ? incoming.info.fallback : null,
      },
    };
    add("tailorResume", [], snapshot.tailorResume, after, { kind: "tailor" });
  }
  return plan;
}

/** Importing any YOLO preference also stops YOLO, as the original importer did. Show that coupled change. */
export function importSelection(plan: ImportPlan, selected: ReadonlySet<string>): Set<string> {
  const result = new Set(selected);
  if (plan.changes.some((c) => c.key === "yolo" && result.has(c.id))) {
    const off = plan.changes.find((c) => c.key === "yolo" && c.path[0] === "enabled");
    if (off) result.add(off.id);
  }
  return result;
}

function applyCollection(c: Collection, changes: ImportChange[]): unknown[] {
  const items = new Map<number | string, unknown>(c.before.map((v, i) => [i, structuredClone(v)]));
  for (const change of changes.filter((v) => v.kind !== "order")) {
    const id = change.oldIndex ?? `new:${change.newIndex}`;
    if (change.after === undefined) items.delete(id);
    else items.set(id, structuredClone(change.after));
  }
  const order = changes.some((v) => v.kind === "order")
    ? [...c.matches.map((i, j) => i ?? `new:${j}`), ...items.keys()]
    : [...items.keys()];
  return [...new Set(order)].filter((id) => items.has(id)).map((id) => items.get(id));
}

/** Check affected fields, lists and files. Concurrent edits to unchecked fields are preserved from the latest read. */
export function importSnapshotChanged(
  plan: ImportPlan,
  selected: ReadonlySet<string>,
  latest: ImportSnapshot,
): boolean {
  const choices = importSelection(plan, selected);
  const changes = plan.changes.filter((c) => choices.has(c.id));
  const fields = new Map(changes.map((c) => [JSON.stringify([c.key, c.path]), c]));
  return (
    [...fields.values()].some(
      (c) =>
        !equalImportValues(
          valueAt(plan.snapshot.values[c.key as keyof Values], c.path),
          valueAt(latest.values[c.key as keyof Values], c.path),
        ),
    ) ||
    (changes.some((c) => c.key === "yolo") && plan.snapshot.values.yolo.enabled !== latest.values.yolo.enabled) ||
    (changes.some((c) => c.key === "documentsIndex") &&
      !equalImportValues(plan.snapshot.documents, latest.documents)) ||
    (changes.some((c) => c.kind === "tailor") && !equalImportValues(plan.snapshot.tailorResume, latest.tailorResume))
  );
}

/** All validation and selection happen before the first write. Unselected roots and document blobs are untouched. */
export async function applyImportPlan(
  plan: ImportPlan,
  selected: ReadonlySet<string>,
  store: Storage,
): Promise<Partial<LocalValues>> {
  const choices = importSelection(plan, selected);
  const changes = plan.changes.filter((c) => choices.has(c.id));
  if (!changes.length) return {};
  const latest = await readImportSnapshot(store);
  if (importSnapshotChanged(plan, choices, latest))
    throw new Error("Your data changed while you were reviewing. Reload the file to review the latest values.");
  const next: Record<string, unknown> = {};
  for (const c of changes)
    if (!Object.hasOwn(next, c.key)) next[c.key] = structuredClone(latest.values[c.key as keyof Values]);
  for (const c of changes.filter((v) => !v.collection && v.kind !== "tailor")) {
    if (c.path.length) put(next[c.key] as Record<string, unknown>, c.path, c.after);
    else next[c.key] = structuredClone(c.after);
  }
  let documents: Document[] | undefined;
  for (const c of plan.collections) {
    const picked = changes.filter((v) => v.collection === c.id);
    if (!picked.length) continue;
    const value = applyCollection(c, picked);
    if (c.key === "documentsIndex") {
      documents = value as Document[];
      next.documentsIndex = documents.map((d) => d.meta);
    } else if (c.path.length) put(next[c.key] as Record<string, unknown>, c.path, value);
    else next[c.key] = value;
  }
  if (next.yolo) (next.yolo as LocalValues["yolo"]).enabled = false;
  const tailor = changes.find((c) => c.kind === "tailor");
  const tailorData = tailor?.after as Export["tailorResume"];
  if (tailor) next.tailorResume = tailorData?.info ?? null;
  if (next.keyState) {
    const ids = new Set(((next.apiKeys ?? latest.values.apiKeys) as LocalValues["apiKeys"]).map((k) => k.id));
    if (changes.some((c) => c.key === "keyState" && c.after !== undefined && !ids.has(c.path[0])))
      throw new Error("Select the matching API key before importing its status.");
  }
  if (documents) {
    if (documents.some((d) => ["tailor-tex", "tailor-pdf", "tailor-fallback-pdf"].includes(d.meta.id)))
      throw new Error("A document in this file uses a reserved résumé ID. Choose a different export file.");
    if (documents.filter((d) => d.meta.isPrimaryResume).length > 1)
      throw new Error(
        "This selection keeps more than one primary résumé. Include the replacement or removal of the current primary résumé.",
      );
    if (new Set(documents.map((d) => d.meta.id)).size !== documents.length)
      throw new Error("Documents in this file have duplicate IDs. Choose a file with unique document IDs.");
  }
  // Validate before changing any files. Reuse the existing schemas and migrations.
  for (const key of Object.keys(next) as LocalKey[]) next[key] = LOCAL_SCHEMAS[key].parse(next[key]);
  const writes: Record<string, unknown> = { ...next };
  const remove = new Set<string>();
  if (documents) {
    const texts = Object.fromEntries(
      Object.entries(latest.values.resumeTexts).filter(([id]) => {
        const old = latest.documents.find((d) => d.meta.id === id);
        const next = documents.find((d) => d.meta.id === id);
        return old && next && old.base64 === next.base64 && next.meta.kind === "resume";
      }),
    );
    if (!equalImportValues(texts, latest.values.resumeTexts)) writes.resumeTexts = texts;
    for (const old of latest.documents) if (!documents.some((d) => d.meta.id === old.meta.id)) remove.add(old.meta.id);
    for (const d of documents) {
      const old = latest.documents.find((v) => v.meta.id === d.meta.id);
      if (!old || old.base64 !== d.base64) writes[`doc:${d.meta.id}`] = { base64: d.base64 };
    }
  }
  if (tailor) {
    for (const id of ["tailor-tex", "tailor-pdf", "tailor-fallback-pdf"]) remove.add(id);
    if (tailorData) {
      writes["doc:tailor-tex"] = { base64: tailorData.tex };
      writes["doc:tailor-pdf"] = { base64: tailorData.pdf };
      remove.delete("tailor-tex");
      remove.delete("tailor-pdf");
      if (tailorData.fallbackPdf) {
        writes["doc:tailor-fallback-pdf"] = { base64: tailorData.fallbackPdf };
        remove.delete("tailor-fallback-pdf");
      }
    }
  }
  // Metadata and binary contents commit together; cleanup only removes blobs no longer referenced by the index.
  await store.set(writes as Partial<LocalValues>);
  await Promise.all([...remove].map((id) => store.removeDoc(id).catch(() => undefined)));
  return next as Partial<LocalValues>;
}
