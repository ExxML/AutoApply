import { z } from "zod";
import { ProfileSchema, type Profile } from "./profileSchema";
import { SettingsSchema } from "./settings";
import { canonicalJson, hash } from "./hash";
import type { CachedDecision, DocumentMeta, JobContext, TabStatus } from "./types";

export const SCHEMA_VERSION = 1;

const ThinkingSchema = z.union([
  z.object({ kind: z.literal("level"), value: z.enum(["minimal", "low"]) }),
  z.object({ kind: z.literal("budget"), value: z.literal(0) }),
  z.object({ kind: z.literal("none") }),
]);

const rec = <T extends z.ZodType>(v: T) =>
  z
    .record(z.string(), z.unknown())
    .catch({})
    .transform((o) => {
      const out: Record<string, z.infer<T>> = {};
      for (const [k, val] of Object.entries(o)) {
        const r = v.safeParse(val);
        if (r.success) out[k] = r.data;
      }
      return out;
    });
const list = <T extends z.ZodType>(v: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((a) =>
      a.flatMap((x) => {
        const r = v.safeParse(x);
        return r.success ? [r.data as z.infer<T>] : [];
      }),
    );

export const DocumentMetaSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["resume", "cover_letter", "transcript", "other"]),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  isPrimaryResume: z.boolean(),
  uploadedAt: z.number(),
}) satisfies z.ZodType<DocumentMeta>;

export const ApiKeyEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  addedAt: z.number(),
});

export const SiteRuleSchema = z.object({ autoFill: z.enum(["on", "off"]) });

export const KeyStateSchema = z.object({
  invalid: z.object({ reason: z.string(), at: z.number() }).optional(),
  cooldownUntil: z.number().optional(),
  perModel: z
    .record(z.string(), z.object({ exhaustedUntil: z.number().optional(), unavailableUntil: z.number().optional() }))
    .optional(),
  lastUsedAt: z.number().optional(),
  lastError: z.object({ status: z.number(), message: z.string(), at: z.number() }).optional(),
  successCount: z.number().catch(0),
  errorCount: z.number().catch(0),
});

export const CatalogEntrySchema = z.object({
  firstSeenAt: z.number(),
  apiIndex: z.number(),
  displayName: z.string().catch(""),
  description: z.string().catch(""),
  inputTokenLimit: z.number().catch(0),
  outputTokenLimit: z.number().catch(0),
  thinking: z.boolean().optional(),
  lastSeenAt: z.number(),
});

export const ModelCapsSchema = z.object({
  thinking: ThinkingSchema,
  schema: z.enum(["responseSchema", "promptOnly"]),
  verifiedAt: z.number(),
  essayThinking: ThinkingSchema.optional(),
});

export const CachedDecisionSchema = z.object({
  action: z.literal("fill"),
  text: z.string().optional(),
  optionTexts: z.array(z.string()).optional(),
  checked: z.boolean().optional(),
  documentId: z.string().optional(),
  source: z.literal("ai"),
  savedAt: z.number(),
  lastUsedAt: z.number().catch(0),
}) satisfies z.ZodType<CachedDecision>;

/** Every chrome.storage.local key and its schema. All reads are validated. */
export const LOCAL_SCHEMAS = {
  schemaVersion: z.number().catch(0),
  settings: SettingsSchema,
  profile: ProfileSchema,
  profileVersion: z.string().catch(""),
  documentsIndex: list(DocumentMetaSchema),
  apiKeys: list(ApiKeyEntrySchema),
  keyState: rec(KeyStateSchema),
  modelCatalog: rec(CatalogEntrySchema),
  modelListFetchedAt: z.number().catch(0),
  selectedModel: z.string().nullable().catch(null),
  fallbackModel: z.string().nullable().catch(null),
  modelCapabilities: rec(ModelCapsSchema),
  decisionCache: rec(CachedDecisionSchema),
  siteRules: rec(SiteRuleSchema),
  overlayPos: rec(z.number()),
};

export type LocalKey = keyof typeof LOCAL_SCHEMAS;
export type LocalValues = { [K in LocalKey]: z.output<(typeof LOCAL_SCHEMAS)[K]> };

/**
 * Per-context allow-list (§18.5). Content scripts have no entry: they never touch
 * chrome.storage and get what they need from the background via messages.
 */
export type StorageContext = "background" | "options" | "popup";
const ALLOW: Record<StorageContext, (key: string) => boolean> = {
  background: () => true,
  options: () => true,
  popup: (k) => ["settings", "siteRules", "selectedModel", "modelCatalog"].includes(k),
};

export function createStorage(ctx: StorageContext) {
  const check = (k: string) => {
    if (!ALLOW[ctx](k)) throw new Error(`storage key "${k}" is not allowed in ${ctx}`);
  };

  async function get<K extends LocalKey>(key: K): Promise<LocalValues[K]> {
    check(key);
    const raw = (await chrome.storage.local.get(key))[key];
    return LOCAL_SCHEMAS[key].parse(raw) as LocalValues[K];
  }

  async function getMany<K extends LocalKey>(keys: K[]): Promise<Pick<LocalValues, K>> {
    keys.forEach(check);
    const raw = await chrome.storage.local.get(keys);
    const out = {} as Pick<LocalValues, K>;
    for (const k of keys) out[k] = LOCAL_SCHEMAS[k].parse(raw[k]) as LocalValues[K];
    return out;
  }

  async function set(values: Partial<LocalValues>): Promise<void> {
    Object.keys(values).forEach(check);
    await chrome.storage.local.set(values);
  }

  /** Saves the profile and its profileVersion together (§6). */
  async function setProfile(profile: Profile): Promise<void> {
    check("profile");
    await chrome.storage.local.set({ profile, profileVersion: profileVersionOf(profile) });
  }

  function onChange(keys: LocalKey[], cb: (changed: Partial<LocalValues>) => void): () => void {
    keys.forEach(check);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      const changed: Partial<LocalValues> = {};
      let any = false;
      for (const k of keys)
        if (k in changes) {
          (changed as Record<string, unknown>)[k] = LOCAL_SCHEMAS[k].parse(changes[k].newValue);
          any = true;
        }
      if (any) cb(changed);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  async function getDoc(id: string): Promise<string | null> {
    check(`doc:${id}`);
    const v = (await chrome.storage.local.get(`doc:${id}`))[`doc:${id}`] as { base64?: unknown } | undefined;
    return typeof v?.base64 === "string" ? v.base64 : null;
  }

  async function setDoc(id: string, base64: string): Promise<void> {
    check(`doc:${id}`);
    await chrome.storage.local.set({ [`doc:${id}`]: { base64 } });
  }

  async function removeDoc(id: string): Promise<void> {
    check(`doc:${id}`);
    await chrome.storage.local.remove(`doc:${id}`);
  }

  return { get, getMany, set, setProfile, onChange, getDoc, setDoc, removeDoc };
}

export function profileVersionOf(p: Profile): string {
  return hash(canonicalJson({ ...p, learnedAnswers: p.learnedAnswers.map(({ lastUsedAt: _, ...rest }) => rest) }));
}

/** Runs once at service-worker start: stamps schemaVersion and rewrites values into validated shape. */
export async function migrate(): Promise<void> {
  const raw = await chrome.storage.local.get(["schemaVersion", "settings", "profile"]);
  if (raw.schemaVersion === SCHEMA_VERSION) return;
  const profile = LOCAL_SCHEMAS.profile.parse(raw.profile);
  await chrome.storage.local.set({
    schemaVersion: SCHEMA_VERSION,
    settings: LOCAL_SCHEMAS.settings.parse(raw.settings),
    profile,
    profileVersion: profileVersionOf(profile),
  });
}

// ---------- chrome.storage.session (background only) ----------
export const session = {
  async getJobContext(tabId: number): Promise<JobContext | null> {
    return ((await chrome.storage.session.get(`jobContext:${tabId}`))[`jobContext:${tabId}`] as JobContext) ?? null;
  },
  setJobContext: (tabId: number, ctx: JobContext) => chrome.storage.session.set({ [`jobContext:${tabId}`]: ctx }),
  async getTabStatus(tabId: number): Promise<TabStatus | null> {
    return ((await chrome.storage.session.get(`tabStatus:${tabId}`))[`tabStatus:${tabId}`] as TabStatus) ?? null;
  },
  setTabStatus: (tabId: number, s: TabStatus) => chrome.storage.session.set({ [`tabStatus:${tabId}`]: s }),
  clearTab: (tabId: number) => chrome.storage.session.remove([`jobContext:${tabId}`, `tabStatus:${tabId}`]),
};
